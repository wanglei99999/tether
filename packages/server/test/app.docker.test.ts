import { type ChildProcess, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import type { AgentVersionSpec } from "@tether/core";
import { type ScriptStep, sampleSpec } from "@tether/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSandboxImage } from "../src/adapters/sandbox-docker/index.ts";
import { createTether, type Tether } from "../src/app.ts";
import { type Config, loadConfig } from "../src/config.ts";
import { FAUX_MODEL, fauxModels } from "./fixtures/faux.ts";

const run = promisify(execFile);
const IMAGE = "tether-sandbox:dev";
const RUN_TETHER = fileURLToPath(new URL("./fixtures/run-tether.ts", import.meta.url));
const dirs: string[] = [];
const opened: Tether[] = [];

function newConfig(): Config {
	const dataDir = mkdtempSync(join(tmpdir(), "tether-app-"));
	dirs.push(dataDir);
	return loadConfig({ TETHER_DATA_DIR: dataDir, TETHER_PORT: "0", TETHER_SANDBOX_IMAGE: IMAGE });
}

function bashSpec(): AgentVersionSpec {
	return { ...sampleSpec(), model: FAUX_MODEL, tools: ["bash"] };
}

async function open(config: Config, script: ScriptStep[]): Promise<Tether> {
	const tether = await createTether(config, { models: fauxModels(script) });
	opened.push(tether);
	return tether;
}

/** 关闭并删除这个实例建的容器；工作区文件属于当前用户，afterAll 里随数据目录一起删。 */
async function shutdown(tether: Tether): Promise<void> {
	opened.splice(opened.indexOf(tether), 1);
	const bindings = await tether.services.store.listBindings();
	await tether.close();
	const ids = bindings.map((binding) => binding.sandboxId);
	if (ids.length > 0) await run("docker", ["rm", "--force", ...ids]).catch(() => {});
}

beforeAll(async () => {
	await buildSandboxImage(IMAGE);
});

afterAll(async () => {
	for (const tether of [...opened]) await shutdown(tether);
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("createTether on docker", () => {
	it("runs a tool in the session's own container end to end", async () => {
		const config = newConfig();
		const tether = await open(config, [
			{ toolCall: { name: "bash", args: { command: "echo hi > a.txt" } } },
			{ text: "done" },
		]);
		const { agents, sessions, sandboxes, engine } = tether.services;
		const { agent } = await agents.create({ name: "e2e", spec: bashSpec() });
		const session = await sessions.create({ agentId: agent.id });

		const { submissionId } = await sessions.sendMessage(session.id, { content: "write it", requestId: "r1" });
		const settled = await engine.waitSubmission(submissionId);

		expect(settled).toMatchObject({ status: "done", answer: { text: "done" } });
		const binding = await sandboxes.status(session.id);
		expect(binding).toMatchObject({ state: "running", sandboxId: `tether-${session.id}` });
		expect(readFileSync(join(config.workspaceRoot, session.id, "a.txt"), "utf8")).toBe("hi\n");
		const { items } = await sessions.transcript(session.id, { limit: 20 });
		expect(items.find((e) => e.kind === "tether.sandbox")).toMatchObject({ data: { state: "running", reason: "created" } });
		await shutdown(tether);
	});

	it("gives two sessions two containers", async () => {
		const config = newConfig();
		const write = (text: string): ScriptStep => ({ toolCall: { name: "bash", args: { command: `echo ${text} > who.txt` } } });
		const tether = await open(config, [write("first"), { text: "ok" }, write("second"), { text: "ok" }]);
		const { agents, sessions, sandboxes, engine } = tether.services;
		const { agent } = await agents.create({ name: "e2e", spec: bashSpec() });
		const a = await sessions.create({ agentId: agent.id });
		const b = await sessions.create({ agentId: agent.id });

		await engine.waitSubmission((await sessions.sendMessage(a.id, { content: "go", requestId: "r" })).submissionId);
		await engine.waitSubmission((await sessions.sendMessage(b.id, { content: "go", requestId: "r" })).submissionId);

		const [bindingA, bindingB] = [await sandboxes.status(a.id), await sandboxes.status(b.id)];
		expect(bindingA?.sandboxId).not.toBe(bindingB?.sandboxId);
		expect(readFileSync(join(config.workspaceRoot, a.id, "who.txt"), "utf8")).toBe("first\n");
		expect(readFileSync(join(config.workspaceRoot, b.id, "who.txt"), "utf8")).toBe("second\n");
		await shutdown(tether);
	});

	it("resumes an unfinished run after the process is killed", async () => {
		const config = newConfig();
		const setup = await open(config, []);
		const { agent } = await setup.services.agents.create({ name: "crash", spec: bashSpec() });
		const session = await setup.services.sessions.create({ agentId: agent.id });
		opened.splice(opened.indexOf(setup), 1);
		await setup.close();

		const command = "echo started > started.txt; sleep 3; echo finished > finished.txt";
		const child = spawn(process.execPath, [RUN_TETHER], {
			cwd: resolve(fileURLToPath(new URL("../../..", import.meta.url))),
			env: {
				...process.env,
				TETHER_DATA_DIR: config.dataDir,
				TETHER_PORT: "0",
				TETHER_SANDBOX_IMAGE: IMAGE,
				TETHER_FAUX_SCRIPT: JSON.stringify([{ toolCall: { name: "bash", args: { command } } }]),
				TETHER_FIXTURE_SEND: JSON.stringify({ sessionId: session.id, content: "run it", requestId: "crash-1" }),
			},
			stdio: ["ignore", "pipe", "inherit"],
		});
		const submissionId = await killWhenStarted(child, join(config.workspaceRoot, session.id, "started.txt"));

		const recovered = await open(config, [{ text: "Recovered." }]);
		const settled = await recovered.services.engine.waitSubmission(submissionId);

		expect(settled).toMatchObject({ status: "done", answer: { text: "Recovered." } });
		const { items } = await recovered.services.sessions.transcript(session.id, { limit: 50 });
		const result = items.find((e) => e.role === "tool");
		expect(result?.toolResult).toMatchObject({ isError: true });
		expect(result?.toolResult?.text).toMatch(/interrupt/i);
		await shutdown(recovered);
	});
});

/** 等子进程提交了消息、bash 已经在容器里开始执行，然后 SIGKILL。返回提交 ID。 */
async function killWhenStarted(child: ChildProcess, marker: string): Promise<string> {
	let output = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	const exited = new Promise<void>((done) => child.once("exit", () => done()));
	try {
		const deadline = Date.now() + 90_000;
		while (Date.now() < deadline) {
			if (/submitted \S+/.test(output) && existsSync(marker)) break;
			if (child.exitCode !== null) throw new Error(`run-tether exited early (${child.exitCode}): ${output}`);
			await sleep(100);
		}
		const match = /submitted (\S+)/.exec(output);
		if (!match || !existsSync(marker)) throw new Error(`bash did not start in time; child output: ${output}`);
		return match[1]!;
	} finally {
		child.kill("SIGKILL");
		await exited;
	}
}

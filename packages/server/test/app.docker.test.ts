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

function newConfig(env: Record<string, string> = {}): Config {
	const dataDir = mkdtempSync(join(tmpdir(), "tether-app-"));
	dirs.push(dataDir);
	return loadConfig({ TETHER_DATA_DIR: dataDir, TETHER_PORT: "0", TETHER_SANDBOX_IMAGE: IMAGE, ...env });
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

	it("returns the sandbox limit as the second session's tool result and records tether.admission", async () => {
		const config = newConfig({ TETHER_MAX_RUNNING_SANDBOXES: "1" });
		const bash: ScriptStep = { toolCall: { name: "bash", args: { command: "echo hi" } } };
		const tether = await open(config, [bash, { text: "ok" }, bash, { text: "no room" }]);
		const { agents, sessions, sandboxes, engine } = tether.services;
		const { agent } = await agents.create({ name: "limit", spec: bashSpec() });
		const a = await sessions.create({ agentId: agent.id });
		const b = await sessions.create({ agentId: agent.id });

		await engine.waitSubmission((await sessions.sendMessage(a.id, { content: "go", requestId: "r" })).submissionId);
		await engine.waitSubmission((await sessions.sendMessage(b.id, { content: "go", requestId: "r" })).submissionId);

		expect(await sandboxes.status(a.id)).toMatchObject({ state: "running" });
		expect(await sandboxes.status(b.id)).toBeUndefined();
		const { items } = await sessions.transcript(b.id, { limit: 20 });
		const result = items.find((e) => e.role === "tool");
		expect(result?.toolResult).toMatchObject({ isError: true });
		expect(result?.toolResult?.text).toMatch(/sandbox limit reached: 1 of 1 sandboxes are running/);
		expect(items.find((e) => e.kind === "tether.admission")).toMatchObject({ data: { limit: 1, running: 1 } });
		await shutdown(tether);
	});

	it("stops an idle sandbox, and the next tool call starts it again with the note in the transcript", async () => {
		const config = newConfig({ TETHER_STOP_AFTER_SECONDS: "1", TETHER_SWEEP_INTERVAL_SECONDS: "0.2" });
		const requests: string[][] = [];
		const script: ScriptStep[] = [
			{ toolCall: { name: "bash", args: { command: "echo kept > kept.txt" } } },
			{ text: "written" },
			{ toolCall: { name: "bash", args: { command: "cat kept.txt" } } },
			{ text: "read" },
		];
		const tether = await createTether(config, { models: fauxModels(script, requests) });
		opened.push(tether);
		const { agents, sessions, sandboxes, engine, store } = tether.services;
		const { agent } = await agents.create({ name: "idle", spec: bashSpec() });
		const session = await sessions.create({ agentId: agent.id });

		await engine.waitSubmission((await sessions.sendMessage(session.id, { content: "a", requestId: "r1" })).submissionId);
		const stopped = await waitFor(async () => (await sandboxes.status(session.id))?.state === "stopped", 20_000);
		expect(stopped).toBe(true);
		const binding = await sandboxes.status(session.id);
		const { stdout } = await run("docker", ["inspect", "--format", "{{.State.Status}}", binding!.sandboxId]);
		expect(stdout.trim()).toBe("exited");
		expect((await store.getSession(session.id))?.status).toBe("idle");

		await engine.waitSubmission((await sessions.sendMessage(session.id, { content: "b", requestId: "r2" })).submissionId);

		expect((await store.getSession(session.id))?.status).toBe("active");
		const { items } = await sessions.transcript(session.id, { limit: 50 });
		expect(items.find((e) => e.kind === "tether.sandbox" && (e.data as { reason?: string }).reason === "idle")).toBeDefined();
		const read = items.find((e) => e.role === "tool");
		expect(read?.toolResult).toMatchObject({ isError: false, text: expect.stringContaining("kept") });
		expect(requests.at(-2)?.join("\n")).toMatch(/The sandbox was stopped after \d+ minutes without activity/);
		await shutdown(tether);
	});

	it("rebuilds after the container is removed by hand; the old file is gone and the reset note is in the transcript", async () => {
		const config = newConfig({ TETHER_SWEEP_INTERVAL_SECONDS: "0.2" });
		const requests: string[][] = [];
		const script: ScriptStep[] = [
			{ toolCall: { name: "bash", args: { command: "echo old > old.txt" } } },
			{ text: "written" },
			{ toolCall: { name: "bash", args: { command: "test -e old.txt && echo present || echo absent" } } },
			{ text: "checked" },
			{ text: "understood" },
		];
		const tether = await createTether(config, { models: fauxModels(script, requests) });
		opened.push(tether);
		const { agents, sessions, sandboxes, engine } = tether.services;
		const { agent } = await agents.create({ name: "lost", spec: bashSpec() });
		const session = await sessions.create({ agentId: agent.id });
		await engine.waitSubmission((await sessions.sendMessage(session.id, { content: "a", requestId: "r1" })).submissionId);
		const before = await sandboxes.status(session.id);

		await run("docker", ["rm", "--force", before!.sandboxId]);
		expect(await waitFor(async () => (await sandboxes.status(session.id))?.state === "lost", 20_000)).toBe(true);
		await engine.waitSubmission((await sessions.sendMessage(session.id, { content: "b", requestId: "r2" })).submissionId);

		expect(await sandboxes.status(session.id)).toMatchObject({ state: "running", epoch: expect.any(Number) });
		const { items } = await sessions.transcript(session.id, { limit: 50 });
		const check = items.find((e) => e.role === "tool");
		expect(check?.toolResult).toMatchObject({ isError: false, text: expect.stringContaining("absent") });
		expect(
			items.find((e) => e.kind === "tether.sandbox" && (e.data as { reason?: string }).reason === "recovered"),
		).toBeDefined();
		// 说明是在这一轮的工具调用里写下的，pi 把它排到这一轮结束后，模型下一轮看到
		await engine.waitSubmission((await sessions.sendMessage(session.id, { content: "c", requestId: "r3" })).submissionId);
		expect(requests.at(-1)?.join("\n")).toContain("The previous sandbox was lost (missing).");
		await shutdown(tether);
	});

	it("creates no sandbox for a run without tool calls", async () => {
		const config = newConfig();
		const tether = await open(config, [{ text: "just chatting" }]);
		const { agents, sessions, sandboxes, engine } = tether.services;
		// 配了 bash，但这一轮模型没有调用它（spec §4：第一次工具调用时才创建）
		const { agent } = await agents.create({ name: "chat", spec: bashSpec() });
		const session = await sessions.create({ agentId: agent.id });

		const { submissionId } = await sessions.sendMessage(session.id, { content: "hello", requestId: "r1" });
		expect(await engine.waitSubmission(submissionId)).toMatchObject({ status: "done" });

		expect(await sandboxes.status(session.id)).toBeUndefined();
		const { stdout } = await run("docker", ["ps", "-aq", "--filter", `label=tether.session=${session.id}`]);
		expect(stdout.trim()).toBe("");
		await shutdown(tether);
	});

	it("reports a failing setup command in the tool result", async () => {
		const config = newConfig();
		const tether = await open(config, [
			{ toolCall: { name: "bash", args: { command: "echo hi" } } },
			{ text: "gave up" },
		]);
		const { agents, sessions, sandboxes, engine } = tether.services;
		const base = bashSpec();
		const spec = { ...base, sandbox: { ...base.sandbox, setup: ["echo setup-broke >&2; exit 3"] } };
		const { agent } = await agents.create({ name: "broken", spec });
		const session = await sessions.create({ agentId: agent.id });

		const { submissionId } = await sessions.sendMessage(session.id, { content: "go", requestId: "r1" });
		await engine.waitSubmission(submissionId);

		const { items } = await sessions.transcript(session.id, { limit: 20 });
		const result = items.find((e) => e.role === "tool");
		expect(result?.toolResult).toMatchObject({ isError: true });
		expect(result?.toolResult?.text).toMatch(/setup-broke/);
		expect(await sandboxes.status(session.id)).toBeUndefined();
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

/** 每 100 毫秒检查一次，条件成立返回 true，超时返回 false。 */
async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return true;
		await sleep(100);
	}
	return false;
}

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

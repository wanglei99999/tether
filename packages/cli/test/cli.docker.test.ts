import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sampleSpec } from "@tether/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSandboxImage } from "../../server/src/adapters/sandbox-docker/index.ts";
import { FAUX_MODEL } from "../../server/test/fixtures/faux.ts";

const run = promisify(execFile);
const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const BIN = join(ROOT, "packages/cli/bin/tether");
const RUN_TETHER = join(ROOT, "packages/server/test/fixtures/run-tether.ts");
const IMAGE = "tether-sandbox:dev";
const TOKEN = "cli-secret";

const dataDir = mkdtempSync(join(tmpdir(), "tether-cli-"));
let server: ChildProcess | undefined;
let url = "";

/** 模型先调用 bash 读 setup 写的文件，再回答。 */
const SCRIPT = [{ toolCall: { name: "bash", args: { command: "cat who.txt" } } }, { text: "Read it." }];

beforeAll(async () => {
	await buildSandboxImage(IMAGE);
	server = spawn(process.execPath, [RUN_TETHER], {
		cwd: ROOT,
		env: {
			...process.env,
			TETHER_DATA_DIR: dataDir,
			TETHER_PORT: "0",
			TETHER_TOKEN: TOKEN,
			TETHER_SANDBOX_IMAGE: IMAGE,
			TETHER_FAUX_SCRIPT: JSON.stringify(SCRIPT),
		},
		stdio: ["ignore", "pipe", "inherit"],
	});
	const port = await new Promise<string>((done, fail) => {
		let output = "";
		server?.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
			const match = /listening (\d+)/.exec(output);
			if (match?.[1]) done(match[1]);
		});
		server?.once("exit", (code) => fail(new Error(`run-tether exited (${code}): ${output}`)));
	});
	url = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
	if (server && server.exitCode === null) {
		const exited = new Promise((done) => server?.once("exit", done));
		server.kill("SIGTERM");
		await exited;
	}
	const { stdout } = await run("docker", ["ps", "-aq", "--filter", "label=tether.managed=1"]);
	const ids = stdout.split("\n").filter(Boolean);
	// 只删这个测试的数据目录建的容器：工作区挂载点在 dataDir 下
	for (const id of ids) {
		const { stdout: mounts } = await run("docker", ["inspect", "--format", "{{range .Mounts}}{{.Source}}{{end}}", id]);
		if (mounts.startsWith(dataDir)) await run("docker", ["rm", "--force", id]);
	}
	rmSync(dataDir, { recursive: true, force: true });
});

interface CliResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

function cli(...args: string[]): Promise<CliResult> {
	return new Promise((done) => {
		const child = spawn(process.execPath, [BIN, ...args], {
			cwd: ROOT,
			env: { ...process.env, TETHER_URL: url, TETHER_TOKEN: TOKEN, NO_COLOR: "1" },
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("exit", (code) => done({ code, stdout, stderr }));
	});
}

describe("tether CLI", () => {
	it("creates an agent from a file, opens a session with a variable, and follows a run", async () => {
		const base = sampleSpec();
		const agentFile = join(dataDir, "agent.json");
		writeFileSync(
			agentFile,
			JSON.stringify({
				name: "cli-e2e",
				spec: {
					...base,
					model: FAUX_MODEL,
					tools: ["bash"],
					// 会话变量只以环境变量传给 setup（spec §5.1），由 setup 写进工作区
					sandbox: { ...base.sandbox, setup: ["touch ready", 'printf %s "$NAME" > who.txt'], variables: ["NAME"] },
				},
			}),
		);

		const created = await cli("agent", "create", "--file", agentFile);
		expect(created).toMatchObject({ code: 0 });
		const agentId = /(agt_\S+)/.exec(created.stdout)?.[1];
		expect(agentId).toBeDefined();
		expect(created.stdout).toMatch(/version 1/);

		const listed = await cli("agent", "list", "--json");
		expect(JSON.parse(listed.stdout).items.map((a: { id: string }) => a.id)).toContain(agentId);

		const opened = await cli("session", "create", agentId as string, "--var", "NAME=tether");
		expect(opened.code).toBe(0);
		const sessionId = /(ses_\S+)/.exec(opened.stdout)?.[1] as string;
		expect(sessionId).toBeDefined();

		const sent = await cli("send", sessionId, "who is it?", "--follow");
		expect(sent.stderr).toBe("");
		expect(sent.code).toBe(0);
		expect(sent.stdout).toMatch(/bash/);
		expect(sent.stdout).toMatch(/tether/); // bash 的输出
		expect(sent.stdout).toMatch(/Read it\./);

		const sandbox = await cli("sandbox", sessionId);
		expect(sandbox.stdout).toMatch(/running/);
		const container = `tether-${sessionId}`;
		const who = await run("docker", ["exec", container, "cat", "/workspace/who.txt"]);
		expect(who.stdout).toBe("tether");
		await run("docker", ["exec", container, "test", "-f", "/workspace/ready"]);
	});

	it("prints the API error code and exits 1 for an unknown session", async () => {
		for (const args of [["sandbox", "ses_missing"], ["send", "ses_missing", "hi"]]) {
			const result = await cli(...args);
			expect(result.code, args.join(" ")).toBe(1);
			expect(result.stderr).toMatch(/not_found/);
		}
	});

	it("exits 2 with usage for an unknown command", async () => {
		const result = await cli("frobnicate");
		expect(result.code).toBe(2);
		expect(result.stderr).toMatch(/usage/i);
	});
});

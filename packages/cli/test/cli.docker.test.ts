import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type ScriptStep, sampleSpec } from "@tether/testkit";
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
const dirs = [dataDir];
const servers: Server[] = [];
let url = "";
/** 第一个用例建的会话，归档用例接着用（这个服务的 faux 剧本只够一次运行）。 */
let firstSessionId = "";

/** 模型先调用 bash 读 setup 写的文件，再回答。 */
const SCRIPT: ScriptStep[] = [{ toolCall: { name: "bash", args: { command: "cat who.txt" } } }, { text: "Read it." }];

interface Server {
	port: string;
	kill(signal: NodeJS.Signals): Promise<void>;
}

/**
 * 子进程跑 run-tether（faux 模型）。注意启动对账会删掉不在自己库里的 Tether 容器，
 * 所以另起一个实例的用例要放在用到容器的用例之后（vitest 按顺序执行同一文件的用例）。
 */
async function startServer(dir: string, script: ScriptStep[], port = "0"): Promise<Server> {
	const child = spawn(process.execPath, [RUN_TETHER], {
		cwd: ROOT,
		env: {
			...process.env,
			TETHER_DATA_DIR: dir,
			TETHER_PORT: port,
			TETHER_TOKEN: TOKEN,
			TETHER_SANDBOX_IMAGE: IMAGE,
			TETHER_FAUX_SCRIPT: JSON.stringify(script),
		},
		stdio: ["ignore", "pipe", "inherit"],
	});
	const exited = new Promise<void>((done) => child.once("exit", () => done()));
	const listening = await new Promise<string>((done, fail) => {
		let output = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
			const match = /listening (\d+)/.exec(output);
			if (match?.[1]) done(match[1]);
		});
		child.once("exit", (code) => fail(new Error(`run-tether exited (${code}): ${output}`)));
	});
	const server: Server = {
		port: listening,
		kill: async (signal) => {
			if (child.exitCode === null && child.signalCode === null) child.kill(signal);
			await exited;
		},
	};
	servers.push(server);
	return server;
}

beforeAll(async () => {
	await buildSandboxImage(IMAGE);
	url = `http://127.0.0.1:${(await startServer(dataDir, SCRIPT)).port}`;
});

afterAll(async () => {
	for (const server of servers) await server.kill("SIGTERM");
	const { stdout } = await run("docker", ["ps", "-aq", "--filter", "label=tether.managed=1"]);
	// 只删这个文件的数据目录建的容器：工作区挂载点在这些目录下
	for (const id of stdout.split("\n").filter(Boolean)) {
		const { stdout: mounts } = await run("docker", ["inspect", "--format", "{{range .Mounts}}{{.Source}}{{end}}", id]);
		if (dirs.some((dir) => mounts.startsWith(dir))) await run("docker", ["rm", "--force", id]);
	}
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface CliResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

interface CliProcess {
	until(pattern: RegExp): Promise<void>;
	done: Promise<CliResult>;
	kill(): void;
}

function cliProcess(target: string, ...args: string[]): CliProcess {
	const child = spawn(process.execPath, [BIN, ...args], {
		cwd: ROOT,
		env: { ...process.env, TETHER_URL: target, TETHER_TOKEN: TOKEN, NO_COLOR: "1" },
	});
	let stdout = "";
	let stderr = "";
	const waiters = new Set<() => void>();
	child.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
		for (const check of waiters) check();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const done = new Promise<CliResult>((finish) => child.on("exit", (code) => finish({ code, stdout, stderr })));
	return {
		done,
		kill: () => {
			if (child.exitCode === null && child.signalCode === null) child.kill();
		},
		until: (pattern) =>
			new Promise((resolveUntil, reject) => {
				const timer = setTimeout(() => reject(new Error(`${pattern} not printed; got: ${stdout}`)), 30_000);
				const check = () => {
					if (!pattern.test(stdout)) return;
					clearTimeout(timer);
					waiters.delete(check);
					resolveUntil();
				};
				waiters.add(check);
				check();
			}),
	};
}

const cliAt = (target: string, ...args: string[]) => cliProcess(target, ...args).done;
const cli = (...args: string[]) => cliAt(url, ...args);

/** 会话记录里是否已经有 "after restart" 这个回答。 */
async function answered(target: string, sessionId: string): Promise<boolean> {
	const response = await fetch(`${target}/v1/sessions/${sessionId}/transcript?limit=50`, {
		headers: { authorization: `Bearer ${TOKEN}` },
	});
	const body = (await response.json()) as { data?: { items: { text?: string }[] } };
	return body.data?.items.some((entry) => entry.text === "after restart") ?? false;
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
		firstSessionId = sessionId;
	});

	it("lists the workspace and prints a file from the command line", async () => {
		const listed = await cli("files", firstSessionId);
		expect(listed).toMatchObject({ code: 0, stderr: "" });
		expect(listed.stdout).toMatch(/^file\s+6\s+who\.txt$/m);
		expect(listed.stdout).toMatch(/^file\s+0\s+ready$/m);

		const printed = await cli("cat", firstSessionId, "who.txt");
		expect(printed).toMatchObject({ code: 0, stdout: "tether", stderr: "" });

		const outside = await cli("cat", firstSessionId, "../../etc/passwd");
		expect(outside.code).toBe(1);
		expect(outside.stderr).toMatch(/invalid_request: path is outside \/workspace/);
	});

	it("archives a session from the command line", async () => {
		const archived = await cli("session", "archive", firstSessionId);
		expect(archived).toMatchObject({ code: 0, stderr: "" });
		expect(archived.stdout).toMatch(new RegExp(`${firstSessionId} archived`));

		const sandbox = await cli("sandbox", firstSessionId);
		expect(sandbox.stdout).toMatch(/destroyed/);
		const { stdout } = await run("docker", ["ps", "-aq", "--filter", `name=tether-${firstSessionId}`]);
		expect(stdout.trim()).toBe("");
		const sent = await cli("send", firstSessionId, "anyone there?");
		expect(sent.code).toBe(1);
		expect(sent.stderr).toMatch(/conflict/);
	});

	it("finishes send --follow when the server restarts mid-run", async () => {
		const ownDir = mkdtempSync(join(tmpdir(), "tether-cli-restart-"));
		dirs.push(ownDir);
		const first = await startServer(ownDir, [{ toolCall: { name: "bash", args: { command: "sleep 2" } } }, { text: "x" }]);
		const target = `http://127.0.0.1:${first.port}`;
		const agentFile = join(ownDir, "agent.json");
		writeFileSync(agentFile, JSON.stringify({ name: "restart", spec: { ...sampleSpec(), model: FAUX_MODEL, tools: ["bash"] } }));
		const agentId = /(agt_\S+)/.exec((await cliAt(target, "agent", "create", "--file", agentFile)).stdout)?.[1];
		const sessionId = /(ses_\S+)/.exec((await cliAt(target, "session", "create", agentId as string)).stdout)?.[1];

		const following = cliProcess(target, "send", sessionId as string, "go", "--follow");
		await following.until(/\[bash\]/);
		await first.kill("SIGKILL");

		// 续跑在 CLI 连不上的时候就结束：先在别的端口起一个实例跑完，停掉，再在原端口起。
		// CLI 重连后只拿到一个 running: false 的快照，不会再有这次运行的 run_end。
		const elsewhere = await startServer(ownDir, [{ text: "after restart" }]);
		await expect.poll(() => answered(`http://127.0.0.1:${elsewhere.port}`, sessionId as string), { timeout: 20_000 }).toBe(true);
		await elsewhere.kill("SIGTERM");
		await startServer(ownDir, [], first.port);

		const result = await Promise.race([following.done, sleep(20_000).then(() => "still waiting" as const)]);
		following.kill();
		expect(result).toMatchObject({ code: 0 });
		expect((result as CliResult).stdout).toMatch(/\[bash\]/);
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

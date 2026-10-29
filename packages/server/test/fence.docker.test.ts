import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type SandboxNote, SandboxService } from "@tether/core";
import { MemoryAppStore, sampleAgent, sampleSession, sampleSpec } from "@tether/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPiEnvExecChannel } from "../src/adapters/exec-pienv/index.ts";
import { buildSandboxImage, createDockerSandboxProvider } from "../src/adapters/sandbox-docker/index.ts";
import { runtimeOption } from "./fixtures/runtime.ts";

const run = promisify(execFile);
const IMAGE = "tether-sandbox:dev";
const USER = `${process.getuid?.()}:${process.getgid?.()}`;
const HOLDER = fileURLToPath(new URL("./fixtures/holder.ts", import.meta.url));
const PID_HOST = `tether-pidhost-${process.pid}`;
const workspaceRoot = mkdtempSync(join(tmpdir(), "tether-ws-"));
const provider = createDockerSandboxProvider({ workspaceRoot, user: USER, defaultImage: IMAGE, storage: "directory", defaultDiskMb: 512, checkpointRoot: join(workspaceRoot, ".checkpoints"), ...runtimeOption() });
let counter = 0;

async function dockerExec(sandboxId: string, script: string): Promise<{ code: number; stdout: string }> {
	try {
		const { stdout } = await run("docker", ["exec", sandboxId, "sh", "-c", script]);
		return { code: 0, stdout };
	} catch (error) {
		return { code: (error as { code: number }).code, stdout: (error as { stdout: string }).stdout };
	}
}

beforeAll(async () => {
	await buildSandboxImage(IMAGE);
});

afterAll(async () => {
	for (const { sandboxId, sessionId } of await provider.listManaged()) {
		if (sessionId.startsWith(`ses_f${process.pid}_`)) await provider.destroy(sandboxId);
	}
	await run("docker", ["rm", "--force", PID_HOST]).catch(() => {});
	rmSync(workspaceRoot, { recursive: true, force: true });
});

/** 真实的 Docker、pi-env 和 SandboxService，存储用内存实现。 */
async function runningSession() {
	const store = new MemoryAppStore();
	const { agent } = sampleAgent();
	await store.createAgent(agent, { agentId: agent.id, version: 1, spec: sampleSpec(), createdAt: agent.createdAt });
	const sessionId = `ses_f${process.pid}_${counter++}`;
	await store.createSession(sampleSession(sessionId));
	const notes: SandboxNote[] = [];
	/** 一条独立的通道，相当于一次独立的连接。和 app.ts 一样，回调只在运行时用到 sandboxes。 */
	const channel = () => createPiEnvExecChannel({ connect: (b) => sandboxes.connect(b.sessionId) });
	const sandboxes: SandboxService = new SandboxService({
		store,
		provider,
		exec: channel(),
		engine: { isRunning: async () => false, transcript: async () => ({ items: [] }) },
		clock: { now: () => new Date().toISOString() },
		record: async (_sessionId, note) => {
			notes.push(note);
		},
		log: { warn: () => {} },
	});
	const binding = await sandboxes.ensureSandbox(sessionId);
	return { store, sandboxes, sessionId, binding, notes, channel };
}

const lateWritten = async (sandboxId: string) => (await dockerExec(sandboxId, "test -e /workspace/late.txt")).code === 0;
const daemonRecords = async (sandboxId: string) => (await dockerExec(sandboxId, "ls /run/tether/daemons")).stdout;

describe("epoch fencing on docker", () => {
	it("kills the old epoch's background command when a new connection starts", async () => {
		const { store, sessionId, binding, notes, channel } = await runningSession();
		const a = channel();
		const b = channel();
		try {
			const started = await a
				.env(binding, { cwd: "/workspace" })
				.exec("nohup sh -c 'sleep 3; echo late > late.txt' >/dev/null 2>&1 &");
			expect(started.exitCode).toBe(0);

			const fresh = await b.env(binding, { cwd: "/workspace" }).exec("true");
			expect(fresh.exitCode).toBe(0);

			await sleep(4_000);
			expect(await lateWritten(binding.sandboxId)).toBe(false);
			expect(await daemonRecords(binding.sandboxId)).toMatch(/^2\.\d+\n$/);
			expect((await store.getBinding(sessionId))?.epoch).toBe(2);
			expect(notes.at(-1)).toMatchObject({ data: { reason: "reconnected", epoch: 2 } });
		} finally {
			a.closeAll();
			b.closeAll();
		}
	});

	it("kills the old command while the old connection is stuck (SIGSTOP)", async () => {
		const { store, sandboxes, sessionId, binding, channel } = await runningSession();
		const oldCommand = await sandboxes.connect(sessionId);
		const holder: ChildProcess = spawn(
			process.execPath,
			[HOLDER, JSON.stringify(oldCommand), "touch holder.started; sleep 3; echo late > late.txt"],
			{ stdio: ["ignore", "inherit", "inherit"] },
		);
		const exited = new Promise<void>((done) => holder.once("exit", () => done()));
		const b = channel();
		try {
			const deadline = Date.now() + 30_000;
			while ((await dockerExec(binding.sandboxId, "test -e /workspace/holder.started")).code !== 0) {
				if (Date.now() > deadline) throw new Error("holder did not start its command");
				await sleep(100);
			}
			// 挂起而不是杀死：管道还开着，旧 daemon 不会因为 EOF 自己退出
			holder.kill("SIGSTOP");

			const fresh = await b.env(binding, { cwd: "/workspace" }).exec("true");
			expect(fresh.exitCode).toBe(0);

			await sleep(4_000);
			expect(await lateWritten(binding.sandboxId)).toBe(false);
			expect(await daemonRecords(binding.sandboxId)).toMatch(/^2\.\d+\n$/);
			expect((await store.getBinding(sessionId))?.epoch).toBe(2);
		} finally {
			b.closeAll();
			holder.kill("SIGKILL");
			await exited;
		}
	});

	it("refuses to fence a container that shares the host PID namespace", async () => {
		// 以非 root 身份运行：即使两道检查都有 bug，kill -1 也碰不到 root 的进程
		await run("docker", ["rm", "--force", PID_HOST]).catch(() => {});
		await run("docker", [
			"run",
			"--detach",
			"--name",
			PID_HOST,
			"--label",
			"tether.managed=1",
			"--pid",
			"host",
			"--user",
			USER,
			IMAGE,
			"sleep",
			"infinity",
		]);
		const witness = spawn("sleep", ["300"], { stdio: "ignore" });
		try {
			await expect(provider.fence(PID_HOST, 1)).rejects.toMatchObject({ code: "sandbox_failed" });
			expect(witness.exitCode).toBeNull();
			expect(() => process.kill(witness.pid ?? -1, 0)).not.toThrow();
		} finally {
			witness.kill("SIGKILL");
		}
	});
});

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SandboxService } from "@tether/core";
import { MemoryAppStore, sampleAgent, sampleCheckpoint, sampleSession, sampleSpec } from "@tether/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPiEnvExecChannel } from "../src/adapters/exec-pienv/index.ts";
import { buildSandboxImage, createDockerSandboxProvider } from "../src/adapters/sandbox-docker/index.ts";
import { runtimeOption } from "./fixtures/runtime.ts";

const run = promisify(execFile);
const IMAGE = "tether-sandbox:dev";
const workspaceRoot = mkdtempSync(join(tmpdir(), "tether-ws-"));
const provider = createDockerSandboxProvider({
	workspaceRoot,
	user: `${process.getuid?.()}:${process.getgid?.()}`,
	defaultImage: IMAGE,
	// 这里读宿主上的工作区文件，用目录模式；镜像模式在 sandbox-docker.docker.test.ts
	storage: "directory",
	defaultDiskMb: 512,
	checkpointRoot: join(workspaceRoot, ".checkpoints"),
	...runtimeOption(),
});
/** 测试里每个会话一个 SandboxService，按会话 ID 找到对应的服务来连接。 */
const services = new Map<string, SandboxService>();
const exec = createPiEnvExecChannel({
	connect: (binding) => {
		const service = services.get(binding.sessionId);
		if (!service) throw new Error(`no service for ${binding.sessionId}`);
		return service.connect(binding.sessionId);
	},
});
let counter = 0;

beforeAll(async () => {
	await buildSandboxImage(IMAGE);
});

afterAll(async () => {
	exec.closeAll();
	for (const { sandboxId, sessionId } of await provider.listManaged()) {
		if (sessionId.startsWith(`ses_s${process.pid}_`)) await provider.destroy(sandboxId);
	}
	rmSync(workspaceRoot, { recursive: true, force: true });
});

/** 真实的 Docker 与 pi-env，只有存储用内存实现。 */
async function sessionWith(setup: string[], variables: Record<string, string>, setupTimeoutMs?: number) {
	const store = new MemoryAppStore();
	const spec = sampleSpec();
	spec.sandbox = { ...spec.sandbox, setup, variables: Object.keys(variables) };
	const { agent } = sampleAgent();
	await store.createAgent(agent, { agentId: agent.id, version: 1, spec, createdAt: agent.createdAt });
	const sessionId = `ses_s${process.pid}_${counter++}`;
	await store.createSession(sampleSession(sessionId, { variables }));
	const sandboxes = new SandboxService({
		store,
		provider,
		exec,
		engine: { isRunning: async () => false, transcript: async () => ({ items: [] }) },
		clock: { now: () => new Date().toISOString() },
		record: async () => {},
		log: { warn: () => {} },
		...(setupTimeoutMs !== undefined && { setupTimeoutMs }),
	});
	services.set(sessionId, sandboxes);
	return { store, sandboxes, sessionId, workspace: join(workspaceRoot, sessionId) };
}

describe("SandboxService on docker", () => {
	it("passes variables to setup as env without interpolation", async () => {
		const name = "x; touch /workspace/pwned";
		const { sandboxes, sessionId, workspace } = await sessionWith(['printf %s "$NAME" > name.txt'], { NAME: name });

		const binding = await sandboxes.ensureSandbox(sessionId);

		expect(binding.state).toBe("running");
		expect(readFileSync(join(workspace, "name.txt"), "utf8")).toBe(name);
		expect(existsSync(join(workspace, "pwned"))).toBe(false);
	});

	it("reports the failing setup command and its output", async () => {
		const { store, sandboxes, sessionId, workspace } = await sessionWith(["echo boom >&2; exit 3"], {});

		const error = await sandboxes.ensureSandbox(sessionId).catch((e: unknown) => e);

		expect(error).toMatchObject({ code: "sandbox_failed" });
		expect((error as Error).message).toContain("echo boom >&2; exit 3");
		expect((error as Error).message).toContain("exit code 3");
		expect((error as Error).message).toContain("boom");
		expect(await store.getBinding(sessionId)).toBeUndefined();
		expect(existsSync(workspace)).toBe(false);
		const { stdout } = await run("docker", ["ps", "-aq", "--filter", `name=tether-${sessionId}`]);
		expect(stdout.trim()).toBe("");
	});

	it("fails a setup command that never exits once the timeout passes", async () => {
		const { store, sandboxes, sessionId } = await sessionWith(["echo cloning; sleep 300"], {}, 1_500);
		const started = Date.now();

		const error = await sandboxes.ensureSandbox(sessionId).catch((e: unknown) => e);

		expect(Date.now() - started).toBeLessThan(30_000);
		expect(error).toMatchObject({ code: "sandbox_failed" });
		expect((error as Error).message).toContain("echo cloning; sleep 300");
		expect(await store.getBinding(sessionId)).toBeUndefined();
		const { stdout } = await run("docker", ["ps", "-aq", "--filter", `name=tether-${sessionId}`]);
		expect(stdout.trim()).toBe("");
	});

	it("restores files from the checkpoint after the container is removed outside Tether", async () => {
		const { store, sandboxes, sessionId, workspace } = await sessionWith(["echo ran >> setup-runs.txt"], {});
		const first = await sandboxes.ensureSandbox(sessionId);
		writeFileSync(join(workspace, "kept.txt"), "before the checkpoint");
		const snapshot = await sandboxes.snapshot(sessionId);
		if (!("snapshotId" in snapshot)) throw new Error(`no snapshot: ${JSON.stringify(snapshot)}`);
		await store.addCheckpoint(sampleCheckpoint("cp_1", { sessionId, snapshotId: snapshot.snapshotId }));
		writeFileSync(join(workspace, "later.txt"), "after the checkpoint");

		await run("docker", ["rm", "--force", first.sandboxId]);
		await sandboxes.sweep();
		expect((await store.getBinding(sessionId))?.state).toBe("lost");
		const rebuilt = await sandboxes.ensureSandbox(sessionId);

		expect(rebuilt.state).toBe("running");
		expect(readFileSync(join(workspace, "kept.txt"), "utf8")).toBe("before the checkpoint");
		expect(existsSync(join(workspace, "later.txt"))).toBe(false);
		// 从存档建，setup 没有再跑
		expect(readFileSync(join(workspace, "setup-runs.txt"), "utf8")).toBe("ran\n");
	});
});

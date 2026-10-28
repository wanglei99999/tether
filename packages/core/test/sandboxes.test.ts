import { MemoryAppStore, sampleAgent, sampleCheckpoint, sampleSession, sampleSpec } from "@tether/testkit";
import { describe, expect, it } from "vitest";
import {
	type BindingPatch,
	type ExpectedState,
	NOTES,
	type SandboxBinding,
	type SandboxNote,
	SandboxService,
	type SandboxServiceDeps,
} from "../src/index.ts";
import { FakeClock, FakeEngine, FakeExecChannel, FakeProvider, ManualClock } from "./fakes.ts";

type Recorded = { sessionId: string; kind: SandboxNote["kind"]; state: SandboxBinding["state"]; reason?: string };

/** 记下每次 updateBinding 带没带期望状态。 */
class SpyStore extends MemoryAppStore {
	readonly updates: { patch: BindingPatch; expected?: ExpectedState }[] = [];

	override async updateBinding(
		sessionId: string,
		patch: BindingPatch,
		expected?: ExpectedState,
	): Promise<SandboxBinding> {
		this.updates.push({ patch, ...(expected !== undefined && { expected }) });
		return super.updateBinding(sessionId, patch, expected);
	}
}

interface SetUpOptions {
	setupTimeoutMs?: number;
	maxRunning?: number;
	stopAfterMs?: number;
	destroyAfterMs?: number;
	finalCheckpoint?: SandboxServiceDeps["finalCheckpoint"];
}

async function setUp(setup: string[] = [], variables: Record<string, string> = {}, options: SetUpOptions = {}) {
	const { setupTimeoutMs, maxRunning, stopAfterMs, destroyAfterMs, finalCheckpoint } = options;
	const store = new SpyStore();
	const spec = sampleSpec();
	spec.sandbox.setup = setup;
	const { agent } = sampleAgent();
	await store.createAgent(agent, { agentId: agent.id, version: 1, spec, createdAt: agent.createdAt });
	await store.createSession(sampleSession("ses_1", { engineSessionId: "eng_1", variables }));
	const provider = new FakeProvider();
	const exec = new FakeExecChannel();
	const engine = new FakeEngine();
	await engine.createSession({ model: spec.model, instructions: "", tools: [], cwd: "/workspace" });
	const clock = new ManualClock();
	const recorded: Recorded[] = [];
	const notes: SandboxNote[] = [];
	const warnings: string[] = [];
	const sandboxes = new SandboxService({
		store,
		provider,
		exec,
		engine,
		clock,
		record: async (sessionId, note) => {
			notes.push(note);
			recorded.push({ sessionId, kind: note.kind, ...(note.data as { state: SandboxBinding["state"]; reason?: string }) });
		},
		log: { warn: (message) => warnings.push(message) },
		...(setupTimeoutMs !== undefined && { setupTimeoutMs }),
		...(maxRunning !== undefined && { maxRunning }),
		...(stopAfterMs !== undefined && { stopAfterMs }),
		...(destroyAfterMs !== undefined && { destroyAfterMs }),
		...(finalCheckpoint !== undefined && { finalCheckpoint }),
	});
	return { store, provider, exec, engine, clock, recorded, notes, warnings, sandboxes };
}

/** ses_1 到 ses_<count> 共用一个 SandboxService；每个会话都有引擎会话 eng_<i>。 */
async function setUpSessions(count: number, options: SetUpOptions = {}) {
	const made = await setUp([], {}, options);
	for (let i = 2; i <= count; i++) {
		await made.engine.createSession({ model: sampleSpec().model, instructions: "", tools: [], cwd: "/workspace" });
		await made.store.createSession(sampleSession(`ses_${i}`, { engineSessionId: `eng_${i}` }));
	}
	return made;
}

describe("SandboxService.ensureSandbox", () => {
	it("creates the sandbox, runs every setup command in /workspace with variables as env, and stores a running binding", async () => {
		const variables = { REPO_URL: "https://example.com/r.git" };
		const { store, provider, exec, sandboxes } = await setUp(['git clone "$REPO_URL" .', "npm ci"], variables);

		const binding = await sandboxes.ensureSandbox("ses_1");

		expect(binding).toMatchObject({ sessionId: "ses_1", provider: "docker", epoch: 0, state: "running", template: "" });
		expect(provider.calls).toEqual(["create"]);
		expect(exec.calls).toEqual([
			{ sandboxId: binding.sandboxId, cwd: "/workspace", command: 'git clone "$REPO_URL" .', env: variables, timeoutMs: 600_000 },
			{ sandboxId: binding.sandboxId, cwd: "/workspace", command: "npm ci", env: variables, timeoutMs: 600_000 },
		]);
		expect(await store.getBinding("ses_1")).toEqual(binding);
		expect(await sandboxes.status("ses_1")).toEqual(binding);
	});

	it("bounds every setup command with the configured timeout", async () => {
		const { exec, sandboxes } = await setUp(["a", "b"], {}, { setupTimeoutMs: 1_500 });
		await sandboxes.ensureSandbox("ses_1");
		expect(exec.calls.map((call) => call.timeoutMs)).toEqual([1_500, 1_500]);
	});

	it("names the setup command when running it fails, and cleans up as for a non-zero exit", async () => {
		const { store, provider, exec, sandboxes } = await setUp(["git clone https://dead.example/r.git ."]);
		exec.failures.set("git clone https://dead.example/r.git .", new Error("exec failed (timeout): timed out after 600 s"));

		const error = await sandboxes.ensureSandbox("ses_1").catch((e: unknown) => e);

		expect(error).toMatchObject({ code: "sandbox_failed" });
		expect((error as Error).message).toContain("`git clone https://dead.example/r.git .`");
		expect((error as Error).message).toContain("timed out");
		expect(provider.calls).toEqual(["create", "destroy"]);
		expect(await store.getBinding("ses_1")).toBeUndefined();
	});

	it("serializes concurrent ensureSandbox calls for one session into one create", async () => {
		const { provider, exec, sandboxes } = await setUp(["true"]);
		provider.createDelayMs = 20;

		const bindings = await Promise.all(Array.from({ length: 10 }, () => sandboxes.ensureSandbox("ses_1")));

		expect(provider.calls.filter((call) => call === "create")).toHaveLength(1);
		expect(exec.calls).toHaveLength(1);
		expect(new Set(bindings.map((b) => b.sandboxId)).size).toBe(1);
	});

	it("reuses a running binding without calling the provider", async () => {
		const { provider, sandboxes } = await setUp();
		const first = await sandboxes.ensureSandbox("ses_1");
		provider.calls.length = 0;

		const again = await sandboxes.ensureSandbox("ses_1");

		expect(again.sandboxId).toBe(first.sandboxId);
		expect(provider.calls).toEqual([]);
	});

	it("starts a stopped sandbox", async () => {
		const { store, provider, exec, sandboxes } = await setUp(["true"]);
		const first = await sandboxes.ensureSandbox("ses_1");
		await provider.stop(first.sandboxId);
		await store.updateBinding(first.sessionId, { state: "stopped" });
		provider.calls.length = 0;

		const started = await sandboxes.ensureSandbox("ses_1");

		expect(provider.calls).toEqual(["status", "start"]);
		expect(started).toMatchObject({ sandboxId: first.sandboxId, state: "running" });
		expect(exec.calls).toHaveLength(1); // setup 只在创建时跑
	});

	it("on setup failure destroys the sandbox, deletes the binding and throws sandbox_failed with the command and its output", async () => {
		const { store, provider, exec, sandboxes } = await setUp(["true", "make build", "never runs"]);
		exec.results.set("make build", { exitCode: 2, stdout: "compiling\n", stderr: "error: missing header\n" });

		const error = await sandboxes.ensureSandbox("ses_1").catch((e: unknown) => e);

		expect(error).toMatchObject({ name: "TetherError", code: "sandbox_failed" });
		const message = (error as Error).message;
		expect(message).toContain("make build");
		expect(message).toContain("exit code 2");
		expect(message).toContain("error: missing header");
		expect(message).toContain("compiling");
		expect(exec.calls.map((c) => c.command)).toEqual(["true", "make build"]);
		expect(provider.calls).toEqual(["create", "destroy"]);
		expect(provider.containers.size).toBe(0);
		expect(exec.closed).toHaveLength(1);
		expect(await store.getBinding("ses_1")).toBeUndefined();
	});

	it("keeps the setup error when cleanup also fails and marks the binding lost", async () => {
		const { store, provider, exec, recorded, warnings, sandboxes } = await setUp(["make build"]);
		exec.results.set("make build", { exitCode: 2, stdout: "", stderr: "error: missing header\n" });
		provider.failDestroy = true;

		const error = await sandboxes.ensureSandbox("ses_1").catch((e: unknown) => e);

		expect(error).toMatchObject({ code: "sandbox_failed" });
		expect((error as Error).message).toContain("make build");
		expect((await store.getBinding("ses_1"))?.state).toBe("lost");
		expect(recorded.at(-1)).toMatchObject({ kind: "tether.sandbox", state: "lost", reason: "cleanup failed" });
		expect(warnings.some((w) => w.includes("destroy"))).toBe(true);
	});

	it("writes every state change with the expected current state", async () => {
		const { store, provider, sandboxes } = await setUp(["true"]);
		const first = await sandboxes.ensureSandbox("ses_1");
		await provider.stop(first.sandboxId);
		await store.updateBinding("ses_1", { state: "stopped" }, { state: "running" });
		await sandboxes.ensureSandbox("ses_1");
		provider.containers.clear();
		await store.updateBinding("ses_1", { state: "stopped" }, { state: "running" });
		await sandboxes.ensureSandbox("ses_1").catch(() => {});

		expect(store.updates.length).toBeGreaterThanOrEqual(5);
		expect(store.updates.filter((u) => u.expected === undefined)).toEqual([]);
	});

	it("keeps only the last 4 KB of long setup output", async () => {
		const { exec, sandboxes } = await setUp(["noisy"]);
		exec.results.set("noisy", { exitCode: 1, stdout: `${"a".repeat(10_000)}TAIL`, stderr: "" });

		const message = ((await sandboxes.ensureSandbox("ses_1").catch((e: unknown) => e)) as Error).message;

		expect(message).toContain("TAIL");
		expect(message.length).toBeLessThan(5_000);
	});

	it("creates again on the next call after a setup failure", async () => {
		const { store, provider, exec, sandboxes } = await setUp(["flaky"]);
		exec.results.set("flaky", { exitCode: 1, stdout: "", stderr: "net down" });
		await expect(sandboxes.ensureSandbox("ses_1")).rejects.toMatchObject({ code: "sandbox_failed" });
		exec.results.delete("flaky");

		const binding = await sandboxes.ensureSandbox("ses_1");

		expect(binding.state).toBe("running");
		expect(provider.calls.filter((call) => call === "create")).toHaveLength(2);
		expect(await store.getBinding("ses_1")).toEqual(binding);
	});

	it("records a tether.sandbox entry on create, start, loss, failed rebuild and rebuild", async () => {
		const { store, provider, exec, recorded, sandboxes } = await setUp(["step"]);
		const first = await sandboxes.ensureSandbox("ses_1");
		await provider.stop(first.sandboxId);
		await store.updateBinding(first.sessionId, { state: "stopped" });
		await sandboxes.ensureSandbox("ses_1");
		await provider.stop(first.sandboxId);
		await store.updateBinding(first.sessionId, { state: "stopped" });
		provider.containers.clear();
		exec.results.set("step", { exitCode: 1, stdout: "", stderr: "" });
		await sandboxes.ensureSandbox("ses_1").catch(() => {});
		exec.results.delete("step");
		await sandboxes.ensureSandbox("ses_1");

		expect(recorded.map(({ sessionId, state, reason }) => [sessionId, state, reason])).toEqual([
			["ses_1", "running", "created"],
			["ses_1", "running", "started"],
			["ses_1", "lost", "missing"],
			["ses_1", "lost", "setup failed"],
			["ses_1", "running", "recovered"],
		]);
	});

	it("returns not_found for an unknown session", async () => {
		const { sandboxes } = await setUp();
		await expect(sandboxes.ensureSandbox("ses_missing")).rejects.toMatchObject({ code: "not_found" });
	});
});

describe("SandboxService admission", () => {
	it("refuses a new sandbox at the limit with sandbox_limit and records tether.admission", async () => {
		const { store, provider, notes, sandboxes } = await setUpSessions(2, { maxRunning: 1 });
		await sandboxes.ensureSandbox("ses_1");
		notes.length = 0;

		const error = await sandboxes.ensureSandbox("ses_2").catch((e: unknown) => e);

		expect(error).toMatchObject({ name: "TetherError", code: "sandbox_limit" });
		expect((error as Error).message).toBe(
			"sandbox limit reached: 1 of 1 sandboxes are running; try again after another session goes idle",
		);
		expect(notes).toEqual([{ kind: "tether.admission", data: { limit: 1, running: 1 } }]);
		expect(provider.calls.filter((call) => call === "create")).toHaveLength(1);
		expect(await store.getBinding("ses_2")).toBeUndefined();
	});

	it("admits again after another sandbox stops", async () => {
		const { store, provider, sandboxes } = await setUpSessions(2, { maxRunning: 1 });
		const first = await sandboxes.ensureSandbox("ses_1");
		await expect(sandboxes.ensureSandbox("ses_2")).rejects.toMatchObject({ code: "sandbox_limit" });
		await provider.stop(first.sandboxId);
		await store.updateBinding("ses_1", { state: "stopped" }, { state: "running" });

		const second = await sandboxes.ensureSandbox("ses_2");

		expect(second.state).toBe("running");
	});

	it("admits exactly the limit when first tool calls in more sessions arrive at once", async () => {
		const { provider, notes, sandboxes } = await setUpSessions(5, { maxRunning: 4 });
		provider.createDelayMs = 20;

		const results = await Promise.allSettled(
			["ses_1", "ses_2", "ses_3", "ses_4", "ses_5"].map((id) => sandboxes.ensureSandbox(id)),
		);

		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(4);
		const refused = results.filter((r) => r.status === "rejected");
		expect(refused).toHaveLength(1);
		expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({ code: "sandbox_limit" });
		expect(provider.calls.filter((call) => call === "create")).toHaveLength(4);
		expect(notes.filter((note) => note.kind === "tether.admission")).toEqual([
			{ kind: "tether.admission", data: { limit: 4, running: 4 } },
		]);
	});

	it("never refuses tool calls on a sandbox that is already running", async () => {
		const { store, provider, sandboxes } = await setUpSessions(2, { maxRunning: 1 });
		const first = await sandboxes.ensureSandbox("ses_1");
		// 上限调低之前留下的第二个运行中的沙箱：现在已经超过上限
		await store.createBinding({ ...first, sessionId: "ses_2", sandboxId: "sbx_other" });
		provider.calls.length = 0;

		await expect(sandboxes.ensureSandbox("ses_1")).resolves.toMatchObject({ state: "running" });
		await expect(sandboxes.ensureSandbox("ses_2")).resolves.toMatchObject({ state: "running" });
		expect(provider.calls).toEqual([]);
	});

	it("applies the limit to starting a stopped sandbox", async () => {
		const { store, provider, sandboxes } = await setUpSessions(2, { maxRunning: 1 });
		const first = await sandboxes.ensureSandbox("ses_1");
		await provider.stop(first.sandboxId);
		await store.updateBinding("ses_1", { state: "stopped" }, { state: "running" });
		await sandboxes.ensureSandbox("ses_2");
		provider.calls.length = 0;

		await expect(sandboxes.ensureSandbox("ses_1")).rejects.toMatchObject({ code: "sandbox_limit" });

		// 准入之前会先查一次容器还在不在（不在就要重建），但不会启动
		expect(provider.calls).toEqual(["status"]);
		expect((await store.getBinding("ses_1"))?.state).toBe("stopped");
	});

	it("defaults to 4 running sandboxes", async () => {
		const { sandboxes } = await setUpSessions(5);
		for (const id of ["ses_1", "ses_2", "ses_3", "ses_4"]) await sandboxes.ensureSandbox(id);

		await expect(sandboxes.ensureSandbox("ses_5")).rejects.toMatchObject({ code: "sandbox_limit" });
	});
});

describe("SandboxService rebuild", () => {
	it("rebuilds a lost sandbox from the template, reruns setup and writes the reset note", async () => {
		const { store, provider, exec, notes, sandboxes } = await setUp(["prep"]);
		const first = await sandboxes.ensureSandbox("ses_1");
		await sandboxes.connect("ses_1");
		provider.containers.clear();
		await sandboxes.sweep();
		expect((await store.getBinding("ses_1"))?.state).toBe("lost");
		provider.calls.length = 0;
		exec.calls.length = 0;

		const rebuilt = await sandboxes.ensureSandbox("ses_1");

		expect(rebuilt).toMatchObject({ state: "running", epoch: 0 });
		expect(rebuilt.sandboxId).not.toBe(first.sandboxId);
		expect(provider.calls).toEqual(["destroy", "create"]);
		expect(exec.closed).toContain(first.sandboxId);
		expect(exec.calls.map((c) => c.command)).toEqual(["prep"]);
		expect(notes.at(-1)).toEqual({
			kind: "tether.sandbox",
			data: { state: "running", reason: "recovered" },
			modelText: NOTES.reset("missing"),
		});
	});

	/** ses_1 有沙箱，存档 cp_1 对齐到条目 1（快照 snap_1）；之后写了 a.txt、执行了 make、读了一个文件；然后容器丢了。 */
	async function lostAfterCheckpoint(setup: string[] = ["prep"]) {
		const made = await setUp(setup);
		const { store, provider, engine, sandboxes } = made;
		await sandboxes.ensureSandbox("ses_1");
		const entryId = engine.push("eng_1", { kind: "pi.user", role: "user", text: "go" });
		await store.addCheckpoint(sampleCheckpoint("cp_1", { entryId, snapshotId: "snap_1" }));
		provider.snapshots.set("snap_1", { sandboxId: "sbx_1", partial: false });
		engine.ran("eng_1", "write", { path: "a.txt" });
		engine.ran("eng_1", "bash", { command: "make" });
		engine.ran("eng_1", "read", { path: "a.txt" });
		provider.containers.clear();
		await sandboxes.sweep();
		made.provider.calls.length = 0;
		made.exec.calls.length = 0;
		return made;
	}

	it("rebuilds a lost sandbox from the latest checkpoint and lists the calls after it", async () => {
		const { store, provider, exec, notes, sandboxes } = await lostAfterCheckpoint();

		const rebuilt = await sandboxes.ensureSandbox("ses_1");

		expect(rebuilt).toMatchObject({ state: "running", epoch: 0 });
		expect(provider.calls).toEqual(["destroy", "create-from"]);
		expect(provider.containers.get(rebuilt.sandboxId)?.from).toBe("snap_1");
		// 存档里已经有 setup 的结果
		expect(exec.calls).toEqual([]);
		expect(notes.at(-1)).toEqual({
			kind: "tether.sandbox",
			data: { state: "running", reason: "recovered", checkpointId: "cp_1" },
			modelText: NOTES.restored("missing", ["write: a.txt", "bash: make"]),
		});
		expect((await store.getBinding("ses_1"))?.reason).toBeUndefined();
	});

	it("rebuilds from the template when the latest checkpoint is a template one", async () => {
		const { store, provider, exec, notes, sandboxes } = await setUp(["prep"]);
		await sandboxes.ensureSandbox("ses_1");
		await store.addCheckpoint(sampleCheckpoint("cp_1", { snapshotId: null }));
		provider.containers.clear();
		await sandboxes.sweep();
		provider.calls.length = 0;
		exec.calls.length = 0;

		await sandboxes.ensureSandbox("ses_1");

		expect(provider.calls).toEqual(["destroy", "create"]);
		expect(exec.calls.map((c) => c.command)).toEqual(["prep"]);
		expect(notes.at(-1)).toMatchObject({ modelText: NOTES.reset("missing") });
	});

	it("rebuilds a lost forked session from its fork's checkpoint when it has none of its own", async () => {
		const { store, provider, engine, notes, sandboxes } = await setUp();
		await store.addCheckpoint(sampleCheckpoint("cp_src", { snapshotId: "snap_src" }));
		provider.snapshots.set("snap_src", { sandboxId: "sbx_old", partial: false });
		await engine.createSession({ model: sampleSpec().model, instructions: "", tools: [], cwd: "/workspace" });
		await store.createSession(
			sampleSession("ses_2", { engineSessionId: "eng_2", forkedFrom: { sessionId: "ses_1", entryId: "1", checkpointId: "cp_src" } }),
		);
		await sandboxes.ensureSandbox("ses_2");
		provider.containers.clear();
		await sandboxes.sweep();
		provider.calls.length = 0;

		const rebuilt = await sandboxes.ensureSandbox("ses_2");

		expect(provider.calls).toEqual(["destroy", "create-from"]);
		expect(provider.containers.get(rebuilt.sandboxId)?.from).toBe("snap_src");
		expect(notes.at(-1)).toMatchObject({ data: { checkpointId: "cp_src" }, modelText: NOTES.restored("missing", []) });
	});

	it("leaves the binding lost when creating from the checkpoint fails", async () => {
		const { store, provider, notes, sandboxes } = await lostAfterCheckpoint();
		provider.snapshots.delete("snap_1");

		await expect(sandboxes.ensureSandbox("ses_1")).rejects.toMatchObject({ code: "sandbox_failed" });

		expect(await store.getBinding("ses_1")).toMatchObject({ state: "lost", reason: "missing" });
		provider.snapshots.set("snap_1", { sandboxId: "sbx_1", partial: false });
		await sandboxes.ensureSandbox("ses_1");
		expect(notes.at(-1)).toMatchObject({ data: { reason: "recovered" }, modelText: NOTES.restored("missing", ["write: a.txt", "bash: make"]) });
	});

	it("keeps the lost reason across a restart of the service", async () => {
		const { store, provider, exec, engine, clock, sandboxes } = await setUp(["make"]);
		exec.results.set("make", { exitCode: 2, stdout: "", stderr: "" });
		provider.failDestroy = true;
		await sandboxes.ensureSandbox("ses_1").catch(() => {});
		exec.results.delete("make");
		provider.failDestroy = false;
		expect(await store.getBinding("ses_1")).toMatchObject({ state: "lost", reason: "cleanup failed" });

		// 新的服务实例：内存里什么都没有，原因只能从绑定里读
		const notes: SandboxNote[] = [];
		const restarted = new SandboxService({
			store,
			provider,
			exec,
			engine,
			clock,
			record: async (_sessionId, note) => {
				notes.push(note);
			},
			log: { warn: () => {} },
		});
		await restarted.ensureSandbox("ses_1");

		expect(notes.at(-1)).toMatchObject({ modelText: NOTES.reset("cleanup failed") });
	});

	it("rebuilds a stopped sandbox whose container is gone on the next tool call", async () => {
		const { store, provider, notes, sandboxes } = await setUp();
		const first = await sandboxes.ensureSandbox("ses_1");
		await provider.stop(first.sandboxId);
		await store.updateBinding("ses_1", { state: "stopped" }, { state: "running" });
		provider.containers.clear();

		const rebuilt = await sandboxes.ensureSandbox("ses_1");

		expect(rebuilt.state).toBe("running");
		expect(provider.containers.has(rebuilt.sandboxId)).toBe(true);
		expect(notes.at(-1)).toMatchObject({ data: { reason: "recovered" }, modelText: NOTES.reset("missing") });
	});

	it("names a failed cleanup as the reason in the reset note", async () => {
		const { exec, provider, notes, sandboxes } = await setUp(["make"]);
		exec.results.set("make", { exitCode: 2, stdout: "", stderr: "" });
		provider.failDestroy = true;
		await sandboxes.ensureSandbox("ses_1").catch(() => {});
		exec.results.delete("make");
		provider.failDestroy = false;

		await sandboxes.ensureSandbox("ses_1");

		expect(notes.at(-1)).toMatchObject({ modelText: NOTES.reset("cleanup failed") });
	});

	it("applies the sandbox limit to a rebuild", async () => {
		const { store, provider, sandboxes } = await setUpSessions(2, { maxRunning: 1 });
		const first = await sandboxes.ensureSandbox("ses_1");
		provider.containers.delete(first.sandboxId);
		await sandboxes.sweep();
		await sandboxes.ensureSandbox("ses_2");
		provider.calls.length = 0;

		await expect(sandboxes.ensureSandbox("ses_1")).rejects.toMatchObject({ code: "sandbox_limit" });

		// 残留在准入之前就删了（删除可以重复），没有新建；绑定还是 lost，下次照样按重建处理
		expect(provider.calls).toEqual(["destroy"]);
		expect((await store.getBinding("ses_1"))?.state).toBe("lost");
	});

	it("keeps the binding lost when creating the replacement fails, so the next call still writes the reset note", async () => {
		const { store, provider, notes, sandboxes } = await setUp();
		await sandboxes.ensureSandbox("ses_1");
		provider.containers.clear();
		await sandboxes.sweep();
		provider.failCreate = true;

		await expect(sandboxes.ensureSandbox("ses_1")).rejects.toMatchObject({ code: "sandbox_failed" });

		expect((await store.getBinding("ses_1"))?.state).toBe("lost");
		provider.failCreate = false;
		await sandboxes.ensureSandbox("ses_1");
		expect(notes.at(-1)).toMatchObject({ data: { reason: "recovered" }, modelText: NOTES.reset("missing") });
	});

	it("removes the lost sandbox's leftovers outside the global admission lock", async () => {
		const { provider, sandboxes } = await setUpSessions(3, { maxRunning: 2 });
		const first = await sandboxes.ensureSandbox("ses_1");
		await sandboxes.ensureSandbox("ses_2");
		provider.containers.delete(first.sandboxId);
		await sandboxes.sweep();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const destroy = provider.destroy.bind(provider);
		provider.destroy = async (id) => {
			await gate;
			await destroy(id);
		};

		// ses_1 的重建卡在删除残留上（宿主上删工作区可能很慢）；另一个会话的第一次工具调用照常过准入
		const rebuild = sandboxes.ensureSandbox("ses_1").catch((e: unknown) => e);
		const third = sandboxes.ensureSandbox("ses_3");
		const raced = await Promise.race([third.then(() => "admitted"), sleep(200).then(() => "blocked")]);
		release();

		expect(raced).toBe("admitted");
		expect(await rebuild).toMatchObject({ code: "sandbox_limit" });
	});

	it("leaves the binding lost when the rebuild's setup fails", async () => {
		const { store, provider, exec, notes, sandboxes } = await setUp(["prep"]);
		await sandboxes.ensureSandbox("ses_1");
		provider.containers.clear();
		await sandboxes.sweep();
		exec.results.set("prep", { exitCode: 1, stdout: "", stderr: "no network" });

		await expect(sandboxes.ensureSandbox("ses_1")).rejects.toMatchObject({ code: "sandbox_failed" });

		expect((await store.getBinding("ses_1"))?.state).toBe("lost");
		expect(provider.containers.size).toBe(0);
		exec.results.delete("prep");
		await sandboxes.ensureSandbox("ses_1");
		// 还是重建：模型照样被告知原来的文件没了
		expect(notes.at(-1)).toMatchObject({ data: { reason: "recovered" }, modelText: NOTES.reset("missing") });
	});
});

describe("SandboxService.destroy", () => {
	it("destroys the sandbox and keeps the binding as destroyed", async () => {
		const { store, provider, exec, notes, sandboxes } = await setUp();
		const { sandboxId } = await sandboxes.ensureSandbox("ses_1");

		await sandboxes.destroy("ses_1", "archived");

		expect(provider.containers.size).toBe(0);
		expect(exec.closed).toContain(sandboxId);
		expect(await store.getBinding("ses_1")).toMatchObject({ sandboxId, state: "destroyed" });
		expect(notes.at(-1)).toEqual({ kind: "tether.sandbox", data: { state: "destroyed", reason: "archived" } });
		expect(await sandboxes.sweep()).toEqual(NOTHING);
	});

	it("does nothing for destroy without a binding or of a destroyed one", async () => {
		const { provider, notes, sandboxes } = await setUp();
		await sandboxes.destroy("ses_1", "archived");
		expect(provider.calls).toEqual([]);

		await sandboxes.ensureSandbox("ses_1");
		await sandboxes.destroy("ses_1", "archived");
		provider.calls.length = 0;
		notes.length = 0;
		await sandboxes.destroy("ses_1", "archived");

		expect(provider.calls).toEqual([]);
		expect(notes).toEqual([]);
	});

	it("destroys a lost sandbox's leftovers", async () => {
		const { store, provider, sandboxes } = await setUp();
		await sandboxes.ensureSandbox("ses_1");
		provider.containers.clear();
		await sandboxes.sweep();
		provider.calls.length = 0;

		await sandboxes.destroy("ses_1", "archived");

		expect(provider.calls).toEqual(["destroy"]);
		expect((await store.getBinding("ses_1"))?.state).toBe("destroyed");
	});

	it("keeps the binding when the provider fails to destroy, so it can be retried", async () => {
		const { store, provider, sandboxes } = await setUp();
		await sandboxes.ensureSandbox("ses_1");
		provider.failDestroy = true;

		await expect(sandboxes.destroy("ses_1", "archived")).rejects.toMatchObject({ code: "sandbox_failed" });

		expect((await store.getBinding("ses_1"))?.state).toBe("running");
	});

	it("refuses ensureSandbox for a destroyed sandbox with conflict", async () => {
		const { provider, sandboxes } = await setUp();
		await sandboxes.ensureSandbox("ses_1");
		await sandboxes.destroy("ses_1", "archived");
		provider.calls.length = 0;

		await expect(sandboxes.ensureSandbox("ses_1")).rejects.toMatchObject({ code: "conflict" });
		expect(provider.calls).toEqual([]);
	});
});

const bytes = (text: string) => new TextEncoder().encode(text);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("SandboxService files", () => {
	it("lists /workspace when the path is empty", async () => {
		const { exec, sandboxes } = await setUp();
		await sandboxes.ensureSandbox("ses_1");
		exec.files.set("/workspace/a.txt", bytes("hi"));
		exec.files.set("/workspace/src", "dir");
		exec.files.set("/workspace/src/main.ts", bytes("x"));

		expect(await sandboxes.listFiles("ses_1", "")).toEqual([
			{ name: "a.txt", kind: "file", size: 2 },
			{ name: "src", kind: "dir", size: 0 },
		]);
		expect(await sandboxes.listFiles("ses_1", "src")).toEqual([{ name: "main.ts", kind: "file", size: 1 }]);
	});

	it("reads a file with its name", async () => {
		const { exec, sandboxes } = await setUp();
		await sandboxes.ensureSandbox("ses_1");
		exec.files.set("/workspace/out", "dir");
		exec.files.set("/workspace/out/report.bin", new Uint8Array([0, 255, 1]));

		expect(await sandboxes.readFile("ses_1", "out/report.bin")).toEqual({
			name: "report.bin",
			content: new Uint8Array([0, 255, 1]),
		});
	});

	it("rejects a path that resolves outside /workspace with invalid_request", async () => {
		const { exec, sandboxes } = await setUp();
		await sandboxes.ensureSandbox("ses_1");
		exec.files.set("/etc", "dir");
		exec.files.set("/etc/passwd", bytes("root:x:0:0"));
		// 工作区里的符号链接，以及名字以 /workspace 开头的兄弟目录
		exec.realPaths.set("/workspace/config", "/etc");
		exec.realPaths.set("/workspace/sneaky", "/workspace2/secret");

		for (const read of [
			() => sandboxes.readFile("ses_1", "../../etc/passwd"),
			() => sandboxes.readFile("ses_1", "/etc/passwd"),
			() => sandboxes.listFiles("ses_1", "config"),
			() => sandboxes.listFiles("ses_1", "sneaky"),
		]) {
			const error = await read().catch((e: unknown) => e);
			expect(error).toMatchObject({ code: "invalid_request", message: "path is outside /workspace" });
		}
	});

	it("reports not_found for a session without a sandbox and creates none", async () => {
		const { provider, sandboxes } = await setUp();

		await expect(sandboxes.listFiles("ses_1", "")).rejects.toMatchObject({
			code: "not_found",
			message: "session ses_1 has no sandbox yet",
		});
		await expect(sandboxes.listFiles("ses_missing", "")).rejects.toMatchObject({ code: "not_found" });
		expect(provider.calls).toEqual([]);
	});

	it("starts a stopped sandbox before reading", async () => {
		const { store, provider, exec, sandboxes } = await setUp();
		const { sandboxId } = await sandboxes.ensureSandbox("ses_1");
		await provider.stop(sandboxId);
		await store.updateBinding("ses_1", { state: "stopped" }, { state: "running" });
		exec.files.set("/workspace/a.txt", bytes("kept"));

		const file = await sandboxes.readFile("ses_1", "a.txt");

		expect(file.content).toEqual(bytes("kept"));
		expect(provider.containers.get(sandboxId)?.state).toBe("running");
		expect((await store.getBinding("ses_1"))?.state).toBe("running");
	});

	it("rejects a file larger than 10 MiB and a directory", async () => {
		const { exec, sandboxes } = await setUp();
		await sandboxes.ensureSandbox("ses_1");
		exec.files.set("/workspace/big.bin", new Uint8Array(10 * 1024 * 1024 + 1));
		exec.files.set("/workspace/dir", "dir");

		await expect(sandboxes.readFile("ses_1", "big.bin")).rejects.toMatchObject({
			code: "invalid_request",
			message: "file is larger than 10 MiB",
		});
		await expect(sandboxes.readFile("ses_1", "dir")).rejects.toMatchObject({ code: "invalid_request" });
		await expect(sandboxes.listFiles("ses_1", "big.bin")).rejects.toMatchObject({ code: "invalid_request" });
	});

	it("does not refresh lastUsedAt", async () => {
		const { store, exec, clock, sandboxes } = await setUp();
		const { lastUsedAt } = await sandboxes.ensureSandbox("ses_1");
		exec.files.set("/workspace/a.txt", bytes("hi"));
		clock.advance(60_000);

		await sandboxes.listFiles("ses_1", "");
		await sandboxes.readFile("ses_1", "a.txt");

		expect((await store.getBinding("ses_1"))?.lastUsedAt).toBe(lastUsedAt);
	});

	it("refuses browsing a destroyed sandbox with conflict", async () => {
		const { sandboxes } = await setUp();
		await sandboxes.ensureSandbox("ses_1");
		await sandboxes.destroy("ses_1", "archived");

		await expect(sandboxes.listFiles("ses_1", "")).rejects.toMatchObject({ code: "conflict" });
	});
});

const HOUR = 3_600_000;
const NOTHING = { stoppedIdle: 0, stoppedOutside: 0, lost: 0, destroyedIdle: 0 };

describe("SandboxService.sweep", () => {
	it("stops a sandbox idle for stopAfter, writes the model-visible note and marks the session idle", async () => {
		const { store, provider, exec, clock, notes, sandboxes } = await setUp();
		const { sandboxId } = await sandboxes.ensureSandbox("ses_1");
		clock.advance(HOUR);

		const result = await sandboxes.sweep();

		expect(result).toEqual({ ...NOTHING, stoppedIdle: 1 });
		expect(provider.containers.get(sandboxId)?.state).toBe("stopped");
		expect((await store.getBinding("ses_1"))?.state).toBe("stopped");
		expect(exec.closed).toEqual([sandboxId]);
		expect(notes.at(-1)).toEqual({
			kind: "tether.sandbox",
			data: { state: "stopped", reason: "idle" },
			modelText: NOTES.stoppedIdle(60),
		});
		expect((await store.getSession("ses_1"))?.status).toBe("idle");
	});

	it("does not stop a sandbox whose session is running, and refreshes lastUsedAt", async () => {
		const { store, engine, clock, sandboxes } = await setUp();
		await sandboxes.ensureSandbox("ses_1");
		engine.running.add("eng_1");
		clock.advance(2 * HOUR);

		const result = await sandboxes.sweep();

		expect(result).toEqual(NOTHING);
		expect(await store.getBinding("ses_1")).toMatchObject({ state: "running", lastUsedAt: clock.now() });
	});

	it("does not stop a sandbox used within stopAfter", async () => {
		const { store, clock, sandboxes } = await setUp();
		await sandboxes.ensureSandbox("ses_1");
		clock.advance(HOUR - 60_000);
		// 每次工具调用都刷新最后使用时间
		await sandboxes.ensureSandbox("ses_1");
		clock.advance(HOUR - 60_000);

		expect(await sandboxes.sweep()).toEqual(NOTHING);
		expect((await store.getBinding("ses_1"))?.state).toBe("running");
	});

	it("uses the configured stopAfter", async () => {
		const { clock, sandboxes } = await setUp([], {}, { stopAfterMs: 1_000 });
		await sandboxes.ensureSandbox("ses_1");
		clock.advance(1_000);

		expect(await sandboxes.sweep()).toEqual({ ...NOTHING, stoppedIdle: 1 });
	});

	it("restarts the stopped sandbox on the next tool call", async () => {
		const { provider, clock, recorded, sandboxes } = await setUp();
		const first = await sandboxes.ensureSandbox("ses_1");
		clock.advance(HOUR);
		await sandboxes.sweep();

		const again = await sandboxes.ensureSandbox("ses_1");

		expect(again).toMatchObject({ sandboxId: first.sandboxId, state: "running" });
		expect(provider.containers.get(first.sandboxId)?.state).toBe("running");
		expect(recorded.at(-1)).toMatchObject({ state: "running", reason: "started" });
	});

	it("runs a tool call that arrives during a sweep's stop after the stop, restarting the sandbox", async () => {
		const { store, provider, clock, recorded, sandboxes } = await setUp();
		const { sandboxId } = await sandboxes.ensureSandbox("ses_1");
		clock.advance(HOUR);
		let stopping!: () => void;
		const stopStarted = new Promise<void>((resolve) => {
			stopping = resolve;
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const stop = provider.stop.bind(provider);
		provider.stop = async (id) => {
			stopping();
			await gate;
			await stop(id);
		};

		const sweep = sandboxes.sweep();
		await stopStarted;
		const toolCall = sandboxes.ensureSandbox("ses_1");
		release();
		const [result, binding] = await Promise.all([sweep, toolCall]);

		expect(result).toEqual({ ...NOTHING, stoppedIdle: 1 });
		expect(binding).toMatchObject({ sandboxId, state: "running" });
		expect(provider.containers.get(sandboxId)?.state).toBe("running");
		expect((await store.getBinding("ses_1"))?.state).toBe("running");
		expect(recorded.slice(-2).map((r) => [r.state, r.reason])).toEqual([
			["stopped", "idle"],
			["running", "started"],
		]);
	});

	it("marks a running binding stopped with the outside-stop note when the container is stopped", async () => {
		const { store, provider, notes, sandboxes } = await setUp();
		const { sandboxId } = await sandboxes.ensureSandbox("ses_1");
		await provider.stop(sandboxId);

		const result = await sandboxes.sweep();

		expect(result).toEqual({ ...NOTHING, stoppedOutside: 1 });
		expect((await store.getBinding("ses_1"))?.state).toBe("stopped");
		expect(notes.at(-1)).toEqual({
			kind: "tether.sandbox",
			data: { state: "stopped", reason: "stopped outside Tether" },
			modelText: NOTES.stoppedOutside,
		});
		expect((await store.getSession("ses_1"))?.status).toBe("idle");
	});

	it("marks a binding lost when its container is gone", async () => {
		const { store, provider, notes, sandboxes } = await setUp();
		await sandboxes.ensureSandbox("ses_1");
		provider.containers.clear();

		const result = await sandboxes.sweep();

		expect(result).toEqual({ ...NOTHING, lost: 1 });
		expect(await store.getBinding("ses_1")).toMatchObject({ state: "lost", reason: "missing" });
		expect(notes.at(-1)).toEqual({ kind: "tether.sandbox", data: { state: "lost", reason: "missing" } });
	});

	it("keeps sweeping other sessions when one fails", async () => {
		const { store, provider, clock, warnings, sandboxes } = await setUpSessions(2);
		const broken = await sandboxes.ensureSandbox("ses_1");
		await sandboxes.ensureSandbox("ses_2");
		clock.advance(HOUR);
		const stop = provider.stop.bind(provider);
		provider.stop = async (id) => {
			if (id === broken.sandboxId) throw new Error("docker stop hung up");
			await stop(id);
		};

		const result = await sandboxes.sweep();

		expect(result).toEqual({ ...NOTHING, stoppedIdle: 1 });
		expect((await store.getBinding("ses_1"))?.state).toBe("running");
		expect((await store.getBinding("ses_2"))?.state).toBe("stopped");
		expect(warnings.some((w) => w.includes("ses_1"))).toBe(true);
	});
});

describe("SandboxService.connect", () => {
	it("takes a new epoch and fences before returning the daemon command", async () => {
		const { store, provider, sandboxes } = await setUp();
		const { sandboxId } = await sandboxes.ensureSandbox("ses_1");
		provider.calls.length = 0;

		const command = await sandboxes.connect("ses_1");

		expect(provider.calls).toEqual(["fence"]);
		expect(provider.fenced).toEqual([{ sandboxId, epoch: 1 }]);
		expect(command).toEqual(["fake-daemon", sandboxId, "1"]);
		expect((await store.getBinding("ses_1"))?.epoch).toBe(1);
	});

	it("does not write a reconnect note for the first connection after create", async () => {
		const { recorded, sandboxes } = await setUp();
		await sandboxes.ensureSandbox("ses_1");
		recorded.length = 0;

		await sandboxes.connect("ses_1");

		expect(recorded).toEqual([]);
	});

	it("writes a model-visible reconnect note for a second connection", async () => {
		const { notes, sandboxes } = await setUp();
		await sandboxes.ensureSandbox("ses_1");
		await sandboxes.connect("ses_1");
		notes.length = 0;

		await sandboxes.connect("ses_1");

		expect(notes).toEqual([
			{
				kind: "tether.sandbox",
				data: { state: "running", reason: "reconnected", epoch: 2, killed: 0 },
				modelText: NOTES.reconnected,
			},
		]);
	});

	it("does not write a reconnect note for the first connection after a start", async () => {
		const { store, provider, notes, sandboxes } = await setUp();
		const first = await sandboxes.ensureSandbox("ses_1");
		await sandboxes.connect("ses_1");
		await provider.stop(first.sandboxId);
		await store.updateBinding("ses_1", { state: "stopped" }, { state: "running" });
		await sandboxes.ensureSandbox("ses_1");
		notes.length = 0;

		await sandboxes.connect("ses_1");

		expect(notes).toEqual([]);
	});

	it("writes a reconnect note for the first connection after the service restarts", async () => {
		const { store, provider, exec, sandboxes } = await setUp();
		await sandboxes.ensureSandbox("ses_1");
		const notes: SandboxNote[] = [];
		const restarted = new SandboxService({
			store,
			provider,
			exec,
			engine: new FakeEngine(),
			clock: new FakeClock(),
			record: async (_sessionId, note) => {
				notes.push(note);
			},
			log: { warn: () => {} },
		});

		await restarted.connect("ses_1");

		expect(notes).toMatchObject([{ data: { reason: "reconnected", epoch: 1 }, modelText: NOTES.reconnected }]);
	});

	it("fails the connection when fencing fails, without returning a command", async () => {
		const { provider, notes, sandboxes } = await setUp();
		await sandboxes.ensureSandbox("ses_1");
		await sandboxes.connect("ses_1");
		notes.length = 0;
		provider.failFence = true;

		await expect(sandboxes.connect("ses_1")).rejects.toMatchObject({ code: "sandbox_failed" });
		expect(notes).toEqual([]);
	});

	it("refuses to connect a stopped or lost sandbox with conflict", async () => {
		const { store, provider, sandboxes } = await setUp();
		await sandboxes.ensureSandbox("ses_1");
		await store.updateBinding("ses_1", { state: "stopped" }, { state: "running" });
		await expect(sandboxes.connect("ses_1")).rejects.toMatchObject({ code: "conflict" });

		await store.updateBinding("ses_1", { state: "lost" }, { state: "stopped" });
		await expect(sandboxes.connect("ses_1")).rejects.toMatchObject({ code: "conflict" });
		expect(provider.fenced).toEqual([]);
	});
});

describe("SandboxService for a forked session", () => {
	/** ses_2 从 ses_1 的条目 3 分叉，选中存档 checkpointId；snapshotId 给了就让后端里有这张快照。 */
	async function forked(checkpointId: string | null, snapshotId?: string | null) {
		const made = await setUp(["git clone \"$REPO_URL\" ."], { REPO_URL: "r" });
		await made.engine.createSession({ model: sampleSpec().model, instructions: "", tools: [], cwd: "/workspace" });
		await made.store.createSession(
			sampleSession("ses_2", {
				engineSessionId: "eng_2",
				variables: { REPO_URL: "r" },
				forkedFrom: { sessionId: "ses_1", entryId: "3", checkpointId },
			}),
		);
		if (checkpointId !== null && snapshotId !== undefined) {
			await made.store.addCheckpoint(sampleCheckpoint(checkpointId, { snapshotId }));
			if (snapshotId !== null) made.provider.snapshots.set(snapshotId, { sandboxId: "sbx_old", partial: false });
		}
		return made;
	}

	it("creates a forked session's sandbox from its checkpoint without running setup", async () => {
		const { provider, exec, store, sandboxes, recorded, notes } = await forked("cp_1", "ses_1/aaaa");

		const binding = await sandboxes.ensureSandbox("ses_2");

		expect(binding.state).toBe("running");
		expect(provider.calls.filter((call) => call.startsWith("create"))).toEqual(["create-from"]);
		expect(provider.containers.get(binding.sandboxId)?.from).toBe("ses_1/aaaa");
		expect(exec.calls).toEqual([]);
		expect(recorded).toEqual([{ sessionId: "ses_2", kind: "tether.sandbox", state: "running", reason: "restored" }]);
		// 分叉时已经告诉过模型，这里不再写
		expect(notes.filter((note) => note.modelText !== undefined)).toEqual([]);
		expect((await store.getBinding("ses_2"))?.state).toBe("running");
	});

	it("falls back to the template and tells the model when the fork's checkpoint is gone", async () => {
		const { provider, exec, sandboxes, notes } = await forked("cp_gone");

		await sandboxes.ensureSandbox("ses_2");

		expect(provider.calls.filter((call) => call.startsWith("create"))).toEqual(["create"]);
		expect(exec.calls.map((call) => call.command)).toEqual(['git clone "$REPO_URL" .']);
		expect(notes.filter((note) => note.modelText !== undefined).map((note) => note.modelText)).toEqual([NOTES.forkFresh]);
	});

	it("creates from the template and runs setup for a template checkpoint, without a note", async () => {
		// 存档是模板（这一轮开始时还没有沙箱）：按模板新建就是精确的
		const { provider, exec, sandboxes, notes } = await forked("cp_1", null);

		await sandboxes.ensureSandbox("ses_2");

		expect(provider.calls.filter((call) => call.startsWith("create"))).toEqual(["create"]);
		expect(exec.calls).toHaveLength(1);
		expect(notes.filter((note) => note.modelText !== undefined)).toEqual([]);
	});
});

describe("SandboxService idle removal", () => {
	const DAY = 24 * HOUR;
	const REMOVED = "removed after 7 days without activity";

	/** 最终存档由 finalCheckpoint 存：这里调用 take 拿到快照，记一条存档；fail 为 true 时不存、返回 false。 */
	async function idle(fail = false) {
		const finals: { sessionId: string; snapshotId: string }[] = [];
		let store: MemoryAppStore | undefined;
		const made = await setUp([], {}, {
			finalCheckpoint: async (binding, take) => {
				if (fail) return false;
				const snapshotId = await take();
				finals.push({ sessionId: binding.sessionId, snapshotId });
				await store!.addCheckpoint(sampleCheckpoint("cp_final", { entryId: "9", snapshotId, submissionId: "final" }));
				return true;
			},
		});
		store = made.store;
		const first = await made.sandboxes.ensureSandbox("ses_1");
		made.clock.advance(HOUR);
		await made.sandboxes.sweep();
		expect((await made.store.getBinding("ses_1"))?.state).toBe("stopped");
		made.provider.calls.length = 0;
		return { ...made, finals, first };
	}

	it("takes a final checkpoint and removes a sandbox stopped longer than destroyAfter", async () => {
		const { store, provider, clock, notes, sandboxes, finals, first } = await idle();
		clock.advance(7 * DAY);

		const result = await sandboxes.sweep();

		expect(result).toEqual({ ...NOTHING, destroyedIdle: 1 });
		expect(finals).toEqual([{ sessionId: "ses_1", snapshotId: expect.any(String) }]);
		expect(provider.calls.filter((call) => call !== "status")).toEqual(["snapshot", "destroy"]);
		expect(provider.containers.has(first.sandboxId)).toBe(false);
		expect(await store.getBinding("ses_1")).toMatchObject({ state: "lost", reason: REMOVED });
		// 只给客户端看；模型在下次恢复时从 NOTES.restored 得知
		expect(notes.at(-1)).toEqual({ kind: "tether.sandbox", data: { state: "lost", reason: REMOVED } });
	});

	it("restores the removed sandbox from the final checkpoint on the next tool call", async () => {
		const { provider, clock, notes, sandboxes, finals } = await idle();
		clock.advance(7 * DAY);
		await sandboxes.sweep();

		const rebuilt = await sandboxes.ensureSandbox("ses_1");

		expect(provider.containers.get(rebuilt.sandboxId)?.from).toBe(finals[0]!.snapshotId);
		expect(notes.at(-1)).toMatchObject({ data: { checkpointId: "cp_final" }, modelText: NOTES.restored(REMOVED, []) });
	});

	it("removes the sandbox even when the final checkpoint fails, and the rebuild uses an earlier one", async () => {
		const { store, provider, clock, sandboxes, first } = await idle(true);
		await store.addCheckpoint(sampleCheckpoint("cp_old", { snapshotId: "snap_old" }));
		provider.snapshots.set("snap_old", { sandboxId: first.sandboxId, partial: false });
		clock.advance(7 * DAY);

		expect(await sandboxes.sweep()).toEqual({ ...NOTHING, destroyedIdle: 1 });
		expect(provider.containers.has(first.sandboxId)).toBe(false);

		const rebuilt = await sandboxes.ensureSandbox("ses_1");
		expect(provider.containers.get(rebuilt.sandboxId)?.from).toBe("snap_old");
	});

	it("does not remove a stopped sandbox younger than destroyAfter", async () => {
		const { store, provider, clock, sandboxes, finals } = await idle();
		clock.advance(7 * DAY - 2 * HOUR);

		expect(await sandboxes.sweep()).toEqual(NOTHING);
		expect(finals).toEqual([]);
		expect(provider.calls).not.toContain("destroy");
		expect((await store.getBinding("ses_1"))?.state).toBe("stopped");
	});

	it("does not mark a running session idle when its sandbox stops", async () => {
		// 一轮正在跑（比如模型还在思考）时容器在 Tether 之外被停掉：会话仍在运行，不能改成 idle
		const { store, provider, engine, sandboxes } = await setUp();
		const { sandboxId } = await sandboxes.ensureSandbox("ses_1");
		await provider.stop(sandboxId);
		engine.running.add("eng_1");

		expect(await sandboxes.sweep()).toEqual({ ...NOTHING, stoppedOutside: 1 });
		expect((await store.getSession("ses_1"))?.status).toBe("active");
	});
});

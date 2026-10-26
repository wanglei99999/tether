import { MemoryAppStore, sampleAgent, sampleSession, sampleSpec } from "@tether/testkit";
import { describe, expect, it } from "vitest";
import {
	type BindingPatch,
	type ExpectedState,
	NOTES,
	type SandboxBinding,
	type SandboxNote,
	SandboxService,
} from "../src/index.ts";
import { FakeClock, FakeExecChannel, FakeProvider } from "./fakes.ts";

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

async function setUp(
	setup: string[] = [],
	variables: Record<string, string> = {},
	setupTimeoutMs?: number,
	maxRunning?: number,
) {
	const store = new SpyStore();
	const spec = sampleSpec();
	spec.sandbox.setup = setup;
	const { agent } = sampleAgent();
	await store.createAgent(agent, { agentId: agent.id, version: 1, spec, createdAt: agent.createdAt });
	await store.createSession(sampleSession("ses_1", { engineSessionId: "eng_1", variables }));
	const provider = new FakeProvider();
	const exec = new FakeExecChannel();
	const recorded: Recorded[] = [];
	const notes: SandboxNote[] = [];
	const warnings: string[] = [];
	const sandboxes = new SandboxService({
		store,
		provider,
		exec,
		clock: new FakeClock(),
		record: async (sessionId, note) => {
			notes.push(note);
			recorded.push({ sessionId, kind: note.kind, ...(note.data as { state: SandboxBinding["state"]; reason?: string }) });
		},
		log: { warn: (message) => warnings.push(message) },
		...(setupTimeoutMs !== undefined && { setupTimeoutMs }),
		...(maxRunning !== undefined && { maxRunning }),
	});
	return { store, provider, exec, recorded, notes, warnings, sandboxes };
}

/** ses_1 到 ses_<count> 共用一个 SandboxService，上限为 maxRunning。 */
async function setUpSessions(count: number, maxRunning?: number) {
	const made = await setUp([], {}, undefined, maxRunning);
	for (let i = 2; i <= count; i++) {
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
		const { exec, sandboxes } = await setUp(["a", "b"], {}, 1_500);
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

	it("marks the binding lost and throws sandbox_failed when the provider reports it missing", async () => {
		const { store, provider, sandboxes } = await setUp();
		const first = await sandboxes.ensureSandbox("ses_1");
		await store.updateBinding(first.sessionId, { state: "stopped" });
		provider.containers.clear();

		await expect(sandboxes.ensureSandbox("ses_1")).rejects.toMatchObject({ code: "sandbox_failed" });

		expect((await store.getBinding("ses_1"))?.state).toBe("lost");
	});

	it("records a tether.sandbox entry on create, start, setup failure and loss", async () => {
		const { store, provider, exec, recorded, sandboxes } = await setUp(["step"]);
		const first = await sandboxes.ensureSandbox("ses_1");
		await provider.stop(first.sandboxId);
		await store.updateBinding(first.sessionId, { state: "stopped" });
		await sandboxes.ensureSandbox("ses_1");
		provider.containers.clear();
		await store.updateBinding(first.sessionId, { state: "stopped" });
		await sandboxes.ensureSandbox("ses_1").catch(() => {});
		exec.results.set("step", { exitCode: 1, stdout: "", stderr: "" });
		await sandboxes.ensureSandbox("ses_1").catch(() => {});

		expect(recorded.map(({ sessionId, state, reason }) => [sessionId, state, reason])).toEqual([
			["ses_1", "running", "created"],
			["ses_1", "running", "started"],
			["ses_1", "lost", "missing"],
			["ses_1", "destroyed", "setup failed"],
		]);
	});

	it("returns not_found for an unknown session", async () => {
		const { sandboxes } = await setUp();
		await expect(sandboxes.ensureSandbox("ses_missing")).rejects.toMatchObject({ code: "not_found" });
	});
});

describe("SandboxService admission", () => {
	it("refuses a new sandbox at the limit with sandbox_limit and records tether.admission", async () => {
		const { store, provider, notes, sandboxes } = await setUpSessions(2, 1);
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
		const { store, provider, sandboxes } = await setUpSessions(2, 1);
		const first = await sandboxes.ensureSandbox("ses_1");
		await expect(sandboxes.ensureSandbox("ses_2")).rejects.toMatchObject({ code: "sandbox_limit" });
		await provider.stop(first.sandboxId);
		await store.updateBinding("ses_1", { state: "stopped" }, { state: "running" });

		const second = await sandboxes.ensureSandbox("ses_2");

		expect(second.state).toBe("running");
	});

	it("admits exactly the limit when first tool calls in more sessions arrive at once", async () => {
		const { provider, notes, sandboxes } = await setUpSessions(5, 4);
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
		const { store, provider, sandboxes } = await setUpSessions(2, 1);
		const first = await sandboxes.ensureSandbox("ses_1");
		// 上限调低之前留下的第二个运行中的沙箱：现在已经超过上限
		await store.createBinding({ ...first, sessionId: "ses_2", sandboxId: "sbx_other" });
		provider.calls.length = 0;

		await expect(sandboxes.ensureSandbox("ses_1")).resolves.toMatchObject({ state: "running" });
		await expect(sandboxes.ensureSandbox("ses_2")).resolves.toMatchObject({ state: "running" });
		expect(provider.calls).toEqual([]);
	});

	it("applies the limit to starting a stopped sandbox", async () => {
		const { store, provider, sandboxes } = await setUpSessions(2, 1);
		const first = await sandboxes.ensureSandbox("ses_1");
		await provider.stop(first.sandboxId);
		await store.updateBinding("ses_1", { state: "stopped" }, { state: "running" });
		await sandboxes.ensureSandbox("ses_2");
		provider.calls.length = 0;

		await expect(sandboxes.ensureSandbox("ses_1")).rejects.toMatchObject({ code: "sandbox_limit" });

		expect(provider.calls).toEqual([]);
		expect((await store.getBinding("ses_1"))?.state).toBe("stopped");
	});

	it("defaults to 4 running sandboxes", async () => {
		const { sandboxes } = await setUpSessions(5);
		for (const id of ["ses_1", "ses_2", "ses_3", "ses_4"]) await sandboxes.ensureSandbox(id);

		await expect(sandboxes.ensureSandbox("ses_5")).rejects.toMatchObject({ code: "sandbox_limit" });
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

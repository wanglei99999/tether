import { MemoryAppStore, sampleAgent, sampleSession, sampleSpec } from "@tether/testkit";
import { describe, expect, it } from "vitest";
import { type SandboxBinding, SandboxService } from "../src/index.ts";
import { FakeClock, FakeExecChannel, FakeProvider } from "./fakes.ts";

type Recorded = { sessionId: string; state: SandboxBinding["state"]; reason?: string };

async function setUp(setup: string[] = [], variables: Record<string, string> = {}) {
	const store = new MemoryAppStore();
	const spec = sampleSpec();
	spec.sandbox.setup = setup;
	const { agent } = sampleAgent();
	await store.createAgent(agent, { agentId: agent.id, version: 1, spec, createdAt: agent.createdAt });
	await store.createSession(sampleSession("ses_1", { engineSessionId: "eng_1", variables }));
	const provider = new FakeProvider();
	const exec = new FakeExecChannel();
	const recorded: Recorded[] = [];
	const sandboxes = new SandboxService({
		store,
		provider,
		exec,
		clock: new FakeClock(),
		record: async (sessionId, data) => {
			recorded.push({ sessionId, ...data });
		},
	});
	return { store, provider, exec, recorded, sandboxes };
}

describe("SandboxService.ensureSandbox", () => {
	it("creates the sandbox, runs every setup command in /workspace with variables as env, and stores a running binding", async () => {
		const variables = { REPO_URL: "https://example.com/r.git" };
		const { store, provider, exec, sandboxes } = await setUp(['git clone "$REPO_URL" .', "npm ci"], variables);

		const binding = await sandboxes.ensureSandbox("ses_1");

		expect(binding).toMatchObject({ sessionId: "ses_1", provider: "docker", epoch: 1, state: "running", template: "" });
		expect(provider.calls).toEqual(["create"]);
		expect(exec.calls).toEqual([
			{ sandboxId: binding.sandboxId, cwd: "/workspace", command: 'git clone "$REPO_URL" .', env: variables },
			{ sandboxId: binding.sandboxId, cwd: "/workspace", command: "npm ci", env: variables },
		]);
		expect(await store.getBinding("ses_1")).toEqual(binding);
		expect(await sandboxes.status("ses_1")).toEqual(binding);
	});

	it("creates only one sandbox for concurrent ensureSandbox calls on a new session", async () => {
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
		await store.putBinding({ ...first, state: "stopped" });
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
		await store.putBinding({ ...first, state: "stopped" });
		provider.containers.clear();

		await expect(sandboxes.ensureSandbox("ses_1")).rejects.toMatchObject({ code: "sandbox_failed" });

		expect((await store.getBinding("ses_1"))?.state).toBe("lost");
	});

	it("records a tether.sandbox entry on create, start, setup failure and loss", async () => {
		const { store, provider, exec, recorded, sandboxes } = await setUp(["step"]);
		const first = await sandboxes.ensureSandbox("ses_1");
		await provider.stop(first.sandboxId);
		await store.putBinding({ ...first, state: "stopped" });
		await sandboxes.ensureSandbox("ses_1");
		provider.containers.clear();
		await store.putBinding({ ...first, state: "stopped" });
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

import { MemoryAppStore, sampleAgent, sampleSession, sampleSpec } from "@tether/testkit";
import { describe, expect, it } from "vitest";
import { type AgentVersionSpec, CheckpointService, type SandboxNote, SandboxService } from "../src/index.ts";
import { FakeEngine, FakeExecChannel, FakeIds, FakeProvider, ManualClock } from "./fakes.ts";

async function setUp(policy: AgentVersionSpec["checkpointPolicy"] = "perRun") {
	const store = new MemoryAppStore();
	const spec = { ...sampleSpec(), checkpointPolicy: policy };
	const { agent } = sampleAgent();
	await store.createAgent(agent, { agentId: agent.id, version: 1, spec, createdAt: agent.createdAt });
	await store.createSession(sampleSession("ses_1", { engineSessionId: "eng_1" }));
	const provider = new FakeProvider();
	const engine = new FakeEngine();
	await engine.createSession({ model: spec.model, instructions: "", tools: [], cwd: "/workspace" });
	const clock = new ManualClock();
	const notes: { sessionId: string; note: SandboxNote }[] = [];
	const warnings: string[] = [];
	const record = async (sessionId: string, note: SandboxNote) => {
		notes.push({ sessionId, note });
	};
	const log = { warn: (message: string) => warnings.push(message) };
	const sandboxes = new SandboxService({ store, provider, exec: new FakeExecChannel(), engine, clock, record, log });
	const checkpoints = new CheckpointService({ store, sandboxes, provider, engine, clock, ids: new FakeIds(), record, log });
	/** 发一条消息，返回提交 ID 和它放进对话的用户条目。 */
	const submit = async (content: string) => {
		const { submissionId } = await engine.submit("eng_1", { content, requestId: content });
		return { submissionId, entryId: (await engine.submissionEntry(submissionId))! };
	};
	const checkpointNotes = () => notes.filter(({ note }) => note.kind === "tether.checkpoint").map(({ note }) => note.data);
	return { store, provider, engine, sandboxes, checkpoints, submit, notes, checkpointNotes, warnings };
}

describe("CheckpointService.onRunStart", () => {
	it("takes one checkpoint per submission and aligns it to the submission's user entry", async () => {
		const { store, provider, sandboxes, checkpoints, submit, checkpointNotes } = await setUp();
		await sandboxes.ensureSandbox("ses_1");
		const { submissionId, entryId } = await submit("go");

		await checkpoints.onRunStart("ses_1", submissionId);

		const [checkpoint] = await store.listCheckpoints("ses_1");
		expect(checkpoint).toMatchObject({ sessionId: "ses_1", submissionId, entryId, kind: "filesystem" });
		expect(provider.snapshots.has(checkpoint!.snapshotId!)).toBe(true);
		expect(checkpointNotes()).toEqual([{ checkpointId: checkpoint!.id, entryId, durationMs: expect.any(Number) }]);
	});

	it("does nothing on a later call for the same submission", async () => {
		// 钩子在一轮的每次模型请求前都会调用，崩溃恢复后也会再调用
		const { store, provider, sandboxes, checkpoints, submit } = await setUp();
		await sandboxes.ensureSandbox("ses_1");
		const { submissionId } = await submit("go");

		await checkpoints.onRunStart("ses_1", submissionId);
		await checkpoints.onRunStart("ses_1", submissionId);

		expect(await store.listCheckpoints("ses_1")).toHaveLength(1);
		expect(provider.calls.filter((call) => call === "snapshot")).toHaveLength(1);
	});

	it("records a template checkpoint when the round starts before the sandbox exists, and no snapshot later in that round", async () => {
		// 第一轮开始时还没有沙箱；这一轮的工具调用建出沙箱后，下一次请求前的钩子不能在半轮的状态上存档
		const { store, provider, sandboxes, checkpoints, submit, checkpointNotes } = await setUp();
		const { submissionId, entryId } = await submit("first");

		await checkpoints.onRunStart("ses_1", submissionId);
		await sandboxes.ensureSandbox("ses_1");
		await checkpoints.onRunStart("ses_1", submissionId);

		const checkpoints1 = await store.listCheckpoints("ses_1");
		expect(checkpoints1).toEqual([expect.objectContaining({ submissionId, entryId, snapshotId: null })]);
		expect(provider.calls).not.toContain("snapshot");
		expect(checkpointNotes()).toEqual([{ checkpointId: checkpoints1[0]!.id, entryId, durationMs: 0, template: true }]);
	});

	it("points the round at the latest snapshot when the round starts with the sandbox lost", async () => {
		// 丢失的沙箱在下一次工具调用时从最近的存档重建：这一轮开始时的工作区就是那张存档
		const { store, provider, sandboxes, checkpoints, submit } = await setUp();
		const binding = await sandboxes.ensureSandbox("ses_1");
		const first = await submit("first");
		await checkpoints.onRunStart("ses_1", first.submissionId);
		provider.containers.delete(binding.sandboxId);
		await sandboxes.sweep();
		expect((await store.getBinding("ses_1"))?.state).toBe("lost");
		const second = await submit("second");

		await checkpoints.onRunStart("ses_1", second.submissionId);

		const [a, b] = await store.listCheckpoints("ses_1");
		expect(b).toMatchObject({ submissionId: second.submissionId, entryId: second.entryId, snapshotId: a!.snapshotId });
		expect(provider.calls.filter((call) => call === "snapshot")).toHaveLength(1);
	});

	it("does nothing for a version with checkpointPolicy none", async () => {
		const { store, provider, sandboxes, checkpoints, submit, notes } = await setUp("none");
		await sandboxes.ensureSandbox("ses_1");
		const { submissionId } = await submit("go");

		await checkpoints.onRunStart("ses_1", submissionId);

		expect(await store.listCheckpoints("ses_1")).toEqual([]);
		expect(provider.calls).not.toContain("snapshot");
		expect(notes.filter(({ note }) => note.kind === "tether.checkpoint")).toEqual([]);
	});

	it("deletes its own snapshot when a concurrent call already recorded the round", async () => {
		const { store, provider, sandboxes, checkpoints, submit } = await setUp();
		await sandboxes.ensureSandbox("ses_1");
		const { submissionId } = await submit("go");

		await Promise.all([checkpoints.onRunStart("ses_1", submissionId), checkpoints.onRunStart("ses_1", submissionId)]);

		const recorded = await store.listCheckpoints("ses_1");
		expect(recorded).toHaveLength(1);
		expect([...provider.snapshots.keys()]).toEqual([recorded[0]!.snapshotId]);
	});

	it("records a client-only entry and does not throw when the snapshot fails", async () => {
		const { store, provider, sandboxes, checkpoints, submit, checkpointNotes, warnings } = await setUp();
		await sandboxes.ensureSandbox("ses_1");
		const { submissionId } = await submit("go");
		provider.failSnapshot = true;

		await expect(checkpoints.onRunStart("ses_1", submissionId)).resolves.toBeUndefined();

		expect(await store.listCheckpoints("ses_1")).toEqual([]);
		expect(checkpointNotes()).toEqual([{ submissionId, error: expect.stringContaining("cannot snapshot") }]);
		expect(warnings.some((w) => w.includes(submissionId))).toBe(true);
	});
});

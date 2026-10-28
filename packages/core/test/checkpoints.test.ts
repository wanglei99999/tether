import { MemoryAppStore, sampleAgent, sampleCheckpoint, sampleSession, sampleSpec } from "@tether/testkit";
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

	it("points a fork's first round at the fork's checkpoint, not the template", async () => {
		// 分叉出来的会话还没有沙箱，但第一次工具调用会从分叉选中的存档建沙箱：这一轮开始时的工作区就是那张
		const { store, engine, checkpoints, checkpointNotes } = await setUp();
		await store.addCheckpoint(sampleCheckpoint("cp_src", { snapshotId: "ses_1/src" }));
		const engineSessionId = await engine.fork("eng_1", engine.push("eng_1", { kind: "pi.user", role: "user", text: "x" }));
		await store.createSession(
			sampleSession("ses_2", { engineSessionId, forkedFrom: { sessionId: "ses_1", entryId: "1", checkpointId: "cp_src" } }),
		);
		const { submissionId } = await engine.submit(engineSessionId, { content: "go on", requestId: "f1" });

		await checkpoints.onRunStart("ses_2", submissionId);

		const [checkpoint] = await store.listCheckpoints("ses_2");
		expect(checkpoint).toMatchObject({ submissionId, snapshotId: "ses_1/src" });
		expect(checkpointNotes()).toEqual([{ checkpointId: checkpoint!.id, entryId: checkpoint!.entryId, durationMs: 0 }]);
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

describe("CheckpointService.final", () => {
	/** 沙箱已停止、会话记录里有几条；take 存一张快照。 */
	async function stopped(policy: AgentVersionSpec["checkpointPolicy"] = "perRun") {
		const made = await setUp(policy);
		const binding = await made.sandboxes.ensureSandbox("ses_1");
		await made.submit("go");
		const latest = made.engine.ran("eng_1", "write", { path: "a.txt" });
		let taken = 0;
		const take = async () => {
			taken++;
			return (await made.provider.snapshot(binding.sandboxId)).snapshotId;
		};
		return { ...made, binding, latest, take, taken: () => taken };
	}

	it("records a final checkpoint aligned to the latest entry, once per sandbox", async () => {
		const { store, checkpoints, binding, latest, take, taken, checkpointNotes } = await stopped();

		expect(await checkpoints.final(binding, take)).toBe(true);
		expect(await checkpoints.final(binding, take)).toBe(true);

		const [checkpoint] = await store.listCheckpoints("ses_1");
		expect(checkpoint).toMatchObject({ submissionId: `final:ses_1:${binding.createdAt}`, entryId: latest });
		expect(checkpoint!.snapshotId).not.toBeNull();
		expect(taken()).toBe(1);
		expect(checkpointNotes()).toEqual([
			{ checkpointId: checkpoint!.id, entryId: latest, durationMs: expect.any(Number), final: true },
		]);
	});

	it("does not take a final checkpoint for checkpointPolicy none", async () => {
		const { store, checkpoints, binding, take, taken } = await stopped("none");

		expect(await checkpoints.final(binding, take)).toBe(false);
		expect(taken()).toBe(0);
		expect(await store.listCheckpoints("ses_1")).toEqual([]);
	});

	it("returns false and logs when the snapshot fails", async () => {
		const { store, provider, checkpoints, binding, take, warnings } = await stopped();
		provider.failSnapshot = true;

		expect(await checkpoints.final(binding, take)).toBe(false);
		expect(await store.listCheckpoints("ses_1")).toEqual([]);
		expect(warnings.some((w) => w.includes("final checkpoint"))).toBe(true);
	});
});

describe("CheckpointService cleanup", () => {
	/**
	 * 只有存储、后端和存档服务。checkpoints 是 [记录 ID, 会话, 条目, 快照]，快照不为 null 时后端里有它。
	 * 后端删了 deletions 张以后空闲空间才回到下限以上（minFreeRatio 0.1：空闲 5% 不够，50% 够）。
	 */
	async function cleanup(
		sessions: { id: string; lastActiveAt?: string; forkedFrom?: { sessionId: string; checkpointId: string } }[],
		checkpoints: [string, string, string, string | null][],
		deletions = Number.POSITIVE_INFINITY,
	) {
		const store = new MemoryAppStore();
		const { agent, first } = sampleAgent();
		await store.createAgent(agent, first);
		for (const { id, lastActiveAt, forkedFrom } of sessions) {
			await store.createSession(
				sampleSession(id, {
					...(lastActiveAt !== undefined && { lastActiveAt }),
					forkedFrom: forkedFrom ? { ...forkedFrom, entryId: "1" } : null,
				}),
			);
		}
		const provider = new FakeProvider();
		for (const [id, sessionId, entryId, snapshotId] of checkpoints) {
			await store.addCheckpoint(sampleCheckpoint(id, { sessionId, entryId, snapshotId }));
			if (snapshotId !== null) provider.snapshots.set(snapshotId, { sandboxId: `sbx_${sessionId}`, partial: false });
		}
		const deleted: string[] = [];
		const deleteSnapshot = provider.deleteSnapshot.bind(provider);
		provider.deleteSnapshot = async (snapshotId: string) => {
			deleted.push(snapshotId);
			await deleteSnapshot(snapshotId);
		};
		provider.storage = async () => ({ freeBytes: deleted.length >= deletions ? 50 : 5, totalBytes: 100 });
		const warnings: string[] = [];
		const service = new CheckpointService({
			store,
			sandboxes: { snapshot: async () => ({ state: "absent" as const }) },
			provider,
			engine: new FakeEngine(),
			clock: new ManualClock(),
			ids: new FakeIds(),
			record: async () => {},
			log: { warn: (message) => warnings.push(message) },
			minFreeRatio: 0.1,
		});
		const archive = (id: string) => store.updateSession(id, { status: "archived" });
		const remaining = async () => (await store.listAllCheckpoints()).map((c) => c.id).sort();
		return { store, provider, service, deleted, warnings, archive, remaining };
	}

	it("deletes an archived session's checkpoints except the ones a live fork references", async () => {
		const { service, provider, archive, remaining } = await cleanup(
			[{ id: "ses_1" }, { id: "ses_2", forkedFrom: { sessionId: "ses_1", checkpointId: "cp_b" } }],
			[["cp_a", "ses_1", "1", "s/a"], ["cp_b", "ses_1", "5", "s/b"], ["cp_t", "ses_1", "9", null]],
		);
		await archive("ses_1");

		expect(await service.collect("ses_1")).toBe(2);

		expect(await remaining()).toEqual(["cp_b"]);
		expect([...provider.snapshots.keys()]).toEqual(["s/b"]);
	});

	it("deletes the referenced checkpoint once the last referencing fork is archived", async () => {
		const { service, provider, archive, remaining } = await cleanup(
			[
				{ id: "ses_1" },
				{ id: "ses_2", forkedFrom: { sessionId: "ses_1", checkpointId: "cp_b" } },
				{ id: "ses_3", forkedFrom: { sessionId: "ses_1", checkpointId: "cp_b" } },
			],
			[["cp_a", "ses_1", "1", "s/a"], ["cp_b", "ses_1", "5", "s/b"]],
		);
		await archive("ses_1");
		await service.collect("ses_1");
		await archive("ses_2");
		await service.collect("ses_2");
		expect(await remaining()).toEqual(["cp_b"]);

		await archive("ses_3");
		await service.collect("ses_3");

		expect(await remaining()).toEqual([]);
		expect(provider.snapshots.size).toBe(0);
	});

	it("keeps a snapshot file while another record still points to it", async () => {
		// 沙箱丢失时那一轮沿用上一张快照：两条记录共用 s/x
		const { service, provider, deleted, archive, remaining } = await cleanup(
			[{ id: "ses_1" }, { id: "ses_2", forkedFrom: { sessionId: "ses_1", checkpointId: "cp_b" } }],
			[["cp_a", "ses_1", "1", "s/x"], ["cp_b", "ses_1", "5", "s/x"]],
		);
		await archive("ses_1");

		await service.collect("ses_1");

		expect(await remaining()).toEqual(["cp_b"]);
		expect(deleted).toEqual([]);
		expect(provider.snapshots.has("s/x")).toBe(true);
	});

	it("does not collect a session that is not archived", async () => {
		const { service, remaining } = await cleanup([{ id: "ses_1" }], [["cp_a", "ses_1", "1", "s/a"]]);

		expect(await service.collect("ses_1")).toBe(0);
		expect(await remaining()).toEqual(["cp_a"]);
	});

	/** ses_old 13 张（序号 0..12），ses_new 6 张；ses_old 更久没用。 */
	function many(): [string, string, string, string | null][] {
		const old = Array.from({ length: 13 }, (_, i) => [`cp_o${i}`, "ses_old", String(i + 1), `old/${i}`] as [string, string, string, string]);
		const recent = Array.from({ length: 6 }, (_, i) => [`cp_n${i}`, "ses_new", String(100 + i), `new/${i}`] as [string, string, string, string]);
		return [...old, ...recent];
	}
	const twoSessions = [
		{ id: "ses_new", lastActiveAt: "2026-10-27T00:00:00.000Z" },
		{ id: "ses_old", lastActiveAt: "2026-10-01T00:00:00.000Z" },
	];

	it("thins oldest sessions first, keeping each session's newest five and every tenth", async () => {
		const { service, deleted, warnings } = await cleanup(twoSessions, many());

		expect(await service.thin()).toBe(9);

		// 旧会话：最新 5 张（8..12）不动，先删不是 10 的倍数的 1..7，再删 0；新会话只有最旧的一张可删
		expect(deleted).toEqual([1, 2, 3, 4, 5, 6, 7].map((i) => `old/${i}`).concat(["old/0", "new/0"]));
		expect(warnings).toHaveLength(9);
	});

	it("stops thinning as soon as free space is above the floor", async () => {
		const { service, deleted, remaining } = await cleanup(twoSessions, many(), 7);

		expect(await service.thin()).toBe(7);

		expect(deleted).toEqual([1, 2, 3, 4, 5, 6, 7].map((i) => `old/${i}`));
		expect(await remaining()).toContain("cp_o0");
		expect(await remaining()).toContain("cp_n0");
	});

	it("does nothing while free space is above the floor", async () => {
		const { service, deleted } = await cleanup(twoSessions, many(), 0);

		expect(await service.thin()).toBe(0);
		expect(deleted).toEqual([]);
	});

	it("never thins a referenced checkpoint or a template one", async () => {
		const checkpoints = Array.from({ length: 8 }, (_, i) => [`cp_${i}`, "ses_1", String(i + 1), i === 2 ? null : `s/${i}`] as [string, string, string, string | null]);
		const { service, deleted } = await cleanup(
			[{ id: "ses_1" }, { id: "ses_2", forkedFrom: { sessionId: "ses_1", checkpointId: "cp_1" } }],
			checkpoints,
		);

		await service.thin();

		// 可删的是最新 5 张之外的 0、1、2：1 被分叉引用，2 是模板（删了不省空间，还丢了对齐信息）
		expect(deleted).toEqual(["s/0"]);
	});
});

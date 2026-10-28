import { MemoryAppStore, sampleCheckpoint, sampleSession } from "@tether/testkit";
import { describe, expect, it } from "vitest";
import { alignedEntry, findCheckpoint, missedCalls, type ReadEntries, type TranscriptEntry } from "../src/index.ts";

/** 一次执行完的工具调用：带调用的助手条目 + 结果条目，ID 分别是 at 和 at + 1。 */
function ran(at: number, name: string, args: unknown): TranscriptEntry[] {
	const callId = `call_${at}`;
	return [
		{ id: String(at), kind: "pi.assistant", role: "assistant", toolCalls: [{ id: callId, name, args }] },
		{ id: String(at + 1), kind: "pi.tool-result", role: "tool", toolResult: { callId, isError: false, text: "" } },
	];
}

/** 按会话给出记录，读 (after, upto] 区间的条目。 */
function reader(logs: Record<string, TranscriptEntry[]>): ReadEntries {
	return async (sessionId) => logs[sessionId] ?? [];
}

async function storeWith(sessions: { id: string; forkedFrom?: { sessionId: string; entryId: string } }[], checkpoints: [string, string, string][]) {
	const store = new MemoryAppStore();
	for (const { id, forkedFrom } of sessions) {
		await store.createSession(sampleSession(id, { forkedFrom: forkedFrom ? { ...forkedFrom, checkpointId: null } : null }));
	}
	for (const [id, sessionId, entryId] of checkpoints) {
		await store.addCheckpoint(sampleCheckpoint(id, { sessionId, entryId, snapshotId: `${sessionId}/${id}` }));
	}
	return store;
}

describe("findCheckpoint", () => {
	it("finds the latest checkpoint at or before the entry", async () => {
		const store = await storeWith([{ id: "ses_1" }], [["cp_a", "ses_1", "1"], ["cp_b", "ses_1", "4"], ["cp_c", "ses_1", "8"]]);
		// 6 和 8 之间改过工作区，8 那张含有分叉点之后的改动
		const read = reader({ ses_1: ran(6, "bash", { command: "rm -rf build" }) });

		expect((await findCheckpoint(store, "ses_1", "6", read))?.id).toBe("cp_b");
		expect((await findCheckpoint(store, "ses_1", "4", read))?.id).toBe("cp_b");
		expect(await findCheckpoint(store, "ses_1", "0", reader({ ses_1: ran(0, "write", { path: "x" }) }))).toBeUndefined();
	});

	it("prefers the first checkpoint after the entry when nothing changed the workspace in between", async () => {
		const store = await storeWith([{ id: "ses_1" }], [["cp_a", "ses_1", "1"], ["cp_b", "ses_1", "4"], ["cp_c", "ses_1", "8"]]);
		// read 没有副作用；5..7 只有它
		const read = reader({ ses_1: [...ran(5, "read", { path: "README.md" }), { id: "7", kind: "pi.assistant", role: "assistant", text: "done" }] });

		const found = await findCheckpoint(store, "ses_1", "7", read);

		expect(found?.id).toBe("cp_c");
		expect(await alignedEntry(store, "ses_1", "7", found!)).toBe("7");
	});

	it("returns the latest checkpoint when no entry is given", async () => {
		const store = await storeWith([{ id: "ses_1" }], [["cp_a", "ses_1", "1"], ["cp_b", "ses_1", "4"]]);

		expect((await findCheckpoint(store, "ses_1", undefined, reader({})))?.id).toBe("cp_b");
	});

	it("compares entry ids as numbers", async () => {
		const store = await storeWith([{ id: "ses_1" }], [["cp_9", "ses_1", "9"], ["cp_10", "ses_1", "10"], ["cp_100", "ses_1", "100"]]);
		const read = reader({ ses_1: [...ran(10, "bash", { command: "make" }), ...ran(20, "bash", { command: "make" })] });

		// 按字符串比较，"100" ≤ "11"、"10" > "9" 都会选错
		expect((await findCheckpoint(store, "ses_1", "11", read))?.id).toBe("cp_10");
		expect((await findCheckpoint(store, "ses_1", "9", read))?.id).toBe("cp_10");
		expect((await findCheckpoint(store, "ses_1", "99", read))?.id).toBe("cp_100");
		expect((await findCheckpoint(store, "ses_1", "100", read))?.id).toBe("cp_100");
	});

	it("walks up to the parent with the fork point as the bound", async () => {
		const store = await storeWith(
			[{ id: "ses_1" }, { id: "ses_2", forkedFrom: { sessionId: "ses_1", entryId: "6" } }],
			[["cp_a", "ses_1", "1"], ["cp_b", "ses_1", "4"], ["cp_c", "ses_1", "8"]],
		);
		const read = reader({ ses_1: ran(6, "write", { path: "f2" }) });

		// ses_2 自己没有存档；到 ses_1 里找 ≤ 6 的
		const found = await findCheckpoint(store, "ses_2", "20", read);

		expect(found?.id).toBe("cp_b");
		expect(await alignedEntry(store, "ses_2", "20", found!)).toBe("4");
	});

	it("aligns to the fork point when the parent's next checkpoint is clean", async () => {
		const store = await storeWith(
			[{ id: "ses_1" }, { id: "ses_2", forkedFrom: { sessionId: "ses_1", entryId: "6" } }],
			[["cp_b", "ses_1", "4"], ["cp_c", "ses_1", "8"]],
		);

		const found = await findCheckpoint(store, "ses_2", "20", reader({}));

		// cp_c 等于 ses_1 在 6 的状态；ses_2 在 6 之后自己的调用都算没发生
		expect(found?.id).toBe("cp_c");
		expect(await alignedEntry(store, "ses_2", "20", found!)).toBe("6");
	});

	it("finds the grandparent's checkpoint for a fork at an inherited entry", async () => {
		// Review Focus 4：ses_3 ← ses_2（在 10 分叉）← ses_1；在 ses_3 继承来的条目 5 再分叉
		const store = await storeWith(
			[
				{ id: "ses_1" },
				{ id: "ses_2", forkedFrom: { sessionId: "ses_1", entryId: "10" } },
				{ id: "ses_3", forkedFrom: { sessionId: "ses_2", entryId: "20" } },
			],
			[["cp_a", "ses_1", "1"], ["cp_b", "ses_1", "4"], ["cp_c", "ses_1", "8"], ["cp_d", "ses_2", "15"], ["cp_e", "ses_3", "25"]],
		);
		const sideEffect = ran(6, "edit", { path: "src/a.ts" });
		const read = reader({ ses_1: sideEffect, ses_2: sideEffect, ses_3: sideEffect });

		const found = await findCheckpoint(store, "ses_3", "5", read);

		expect(found?.id).toBe("cp_b");
		expect(await alignedEntry(store, "ses_3", "5", found!)).toBe("4");
	});

	it("returns undefined when no session on the chain has a checkpoint", async () => {
		const store = await storeWith([{ id: "ses_1" }, { id: "ses_2", forkedFrom: { sessionId: "ses_1", entryId: "6" } }], []);

		expect(await findCheckpoint(store, "ses_2", "9", reader({}))).toBeUndefined();
	});
});

describe("missedCalls", () => {
	it("lists only side-effecting calls after the checkpoint, truncated, with a remainder count", () => {
		const long = "x".repeat(300);
		const entries = [
			...ran(1, "bash", { command: "before the checkpoint" }),
			...ran(3, "read", { path: "README.md" }),
			...ran(5, "bash", { command: long }),
			...ran(7, "write", { path: "src/new.ts" }),
			...ran(9, "edit", { path: "src/old.ts" }),
			...Array.from({ length: 20 }, (_, i) => ran(11 + 2 * i, "bash", { command: `step ${i}` })).flat(),
			...ran(51, "bash", { command: "after the fork point" }),
		];

		const missed = missedCalls(entries, "2", "50");

		expect(missed).toHaveLength(21);
		expect(missed[0]).toBe(`bash: ${"x".repeat(193)}…`);
		expect(missed[0]).toHaveLength(200);
		expect(missed.slice(1, 3)).toEqual(["write: src/new.ts", "edit: src/old.ts"]);
		expect(missed[19]).toBe("bash: step 16");
		expect(missed[20]).toBe("and 3 more");
	});

	it("counts a call when its result is in range, even if the call entry is not", () => {
		const entries = ran(3, "write", { path: "a" });

		expect(missedCalls(entries, "3", "4")).toEqual(["write: a"]);
		expect(missedCalls(entries, "4", "9")).toEqual([]);
		expect(missedCalls(entries, "1", "3")).toEqual([]);
	});
});

import type { TranscriptEntry } from "@tether/core";
import { describe, expect, it } from "vitest";
import { checkRound, type ForkHistory, type RoundHistory, type SessionHistory } from "../src/index.ts";

const T0 = "s0-m0-t0";
const T1 = "s0-m0-t1";
const T2 = "s0-m0-t2";

/** 一轮消息：用户 1，写文件 2-3，长命令 4-5，写文件 6-7，回答 8。 */
function transcript(): TranscriptEntry[] {
	const call = (id: string, token: string): TranscriptEntry => ({
		id,
		kind: "pi.assistant",
		role: "assistant",
		toolCalls: [{ id: token, name: "bash", args: {} }],
	});
	const result = (id: string, token: string): TranscriptEntry => ({
		id,
		kind: "pi.tool-result",
		role: "tool",
		toolResult: { callId: token, isError: false, text: "" },
	});
	return [
		{ id: "1", kind: "pi.user", role: "user", text: "chaos:0:0" },
		call("2", T0),
		result("3", T0),
		call("4", T1),
		result("5", T1),
		call("6", T2),
		result("7", T2),
		{ id: "8", kind: "pi.assistant", role: "assistant", text: "done" },
	];
}

function session(overrides: Partial<SessionHistory> = {}): SessionHistory {
	const entries = transcript();
	return {
		label: "s0",
		sends: [{ requestId: "r0", content: "chaos:0:0", status: "done" }],
		transcript: entries,
		streamEntryIds: entries.map((e) => e.id),
		execLog: [`${T0} start`, `${T0} end`, `${T1} start`, `${T1} tick`, `${T1} end`, `${T2} start`, `${T2} end`],
		files: [`f-${T0}.txt`, `f-${T2}.txt`],
		notes: [],
		removed: false,
		...overrides,
	};
}

function fork(overrides: Partial<ForkHistory> = {}): ForkHistory {
	return {
		label: "f0",
		atEntryId: "8",
		sends: [{ requestId: "i0", content: "inspect:0:0", status: "done" }],
		files: [`f-${T0}.txt`, `f-${T2}.txt`],
		notes: [],
		...overrides,
	};
}

function check(one: SessionHistory, leftovers: string[] = []) {
	const history: RoundHistory = { sessions: [one], leftovers };
	return checkRound(history);
}

function ids(one: SessionHistory, leftovers: string[] = []) {
	return [...new Set(check(one, leftovers).map((v) => v.invariant))];
}

describe("checkRound", () => {
	it("a clean round has no violations", () => {
		expect(check(session({ fork: fork() }))).toEqual([]);
	});

	it("I0: a submission that never finished or went unanswered", () => {
		for (const status of ["pending", "unanswered"] as const) {
			expect(ids(session({ sends: [{ requestId: "r0", content: "chaos:0:0", status }] }))).toEqual(["I0"]);
		}
		const stuckFork = fork({ sends: [{ requestId: "i0", content: "inspect:0:0", status: "pending" }] });
		expect(ids(session({ fork: stuckFork }))).toEqual(["I0"]);
	});

	it("I1: a request that shows up twice", () => {
		const entries = transcript();
		const doubled = [...entries, { ...entries[0]!, id: "9" }];
		expect(ids(session({ transcript: doubled, streamEntryIds: doubled.map((e) => e.id) }))).toEqual(["I1"]);
	});

	it("I2: a token started twice", () => {
		expect(ids(session({ execLog: [`${T0} start`, `${T0} start`] }))).toEqual(["I2"]);
	});

	it("I2: a restored session only has the log after the restore, and that is not a violation", () => {
		expect(check(session({ execLog: [`${T2} start`, `${T2} end`] }))).toEqual([]);
	});

	it("I3: a tick of an older token after a newer start", () => {
		expect(ids(session({ execLog: [`${T1} start`, `${T2} start`, `${T1} tick`] }))).toEqual(["I3"]);
	});

	it("I3: a tick before the newer start is fine", () => {
		expect(check(session({ execLog: [`${T1} start`, `${T1} tick`, `${T2} start`] }))).toEqual([]);
	});

	it("a line cut off by a kill is skipped", () => {
		expect(check(session({ execLog: [`${T1} start`, `${T1} ti`, "s0-"] }))).toEqual([]);
	});

	it("I4: a removed container without an entry or without a note", () => {
		const recovered: TranscriptEntry = { id: "9", kind: "tether.sandbox", data: { reason: "recovered" } };
		const note = "The previous sandbox was lost (missing).";
		const entries = [...transcript(), recovered];
		const streamed = entries.map((e) => e.id);
		expect(ids(session({ removed: true, notes: [note] }))).toEqual(["I4"]);
		expect(ids(session({ removed: true, transcript: entries, streamEntryIds: streamed }))).toEqual(["I4"]);
		expect(check(session({ removed: true, transcript: entries, streamEntryIds: streamed, notes: [note] }))).toEqual([]);
	});

	it("I5: an entry the stream never showed", () => {
		expect(ids(session({ streamEntryIds: ["1", "2"] }))).toEqual(["I5"]);
	});

	it("I6: a fork with a file written after the fork point", () => {
		expect(ids(session({ fork: fork({ atEntryId: "3", files: [`f-${T0}.txt`, `f-${T2}.txt`] }) }))).toEqual(["I6"]);
	});

	it("I6: a missing file listed in the note is fine", () => {
		const explained = fork({ files: [`f-${T0}.txt`], notes: [`did not happen:\n- bash: ${T2}`] });
		expect(check(session({ fork: explained }))).toEqual([]);
	});

	it("I6: a truncated list of missed operations is not reported", () => {
		const explained = fork({ files: [`f-${T0}.txt`], notes: ["- x\n- and 4 more"] });
		expect(check(session({ fork: explained }))).toEqual([]);
	});

	it("I6: a missing file no note mentions", () => {
		expect(ids(session({ fork: fork({ files: [`f-${T0}.txt`] }) }))).toEqual(["I6"]);
	});

	it("I6: files written before a template rebuild of the source are allowed to be missing", () => {
		// 3 的结果之后容器丢了（lost 在 4.5），从模板重建（recovered 没有 checkpointId，在 7.5）
		const entries = [
			...transcript(),
			{ id: "4.5", kind: "tether.sandbox", data: { state: "lost", reason: "missing" } },
			{ id: "7.5", kind: "tether.sandbox", data: { state: "running", reason: "recovered" } },
		].sort((a, b) => Number(a.id) - Number(b.id));
		const streamed = entries.map((e) => e.id);
		const rebuilt = session({ transcript: entries, streamEntryIds: streamed, fork: fork({ files: [`f-${T2}.txt`] }) });
		expect(check(rebuilt)).toEqual([]);
		// 重建之后写的文件仍然必须在
		expect(ids(session({ transcript: entries, streamEntryIds: streamed, fork: fork({ files: [] }) }))).toEqual(["I6"]);
	});

	it("I6: a rebuild after the fork point does not excuse anything", () => {
		const entries = [
			...transcript(),
			{ id: "9", kind: "tether.sandbox", data: { state: "lost", reason: "missing" } },
			{ id: "10", kind: "tether.sandbox", data: { state: "running", reason: "recovered" } },
		];
		const streamed = entries.map((e) => e.id);
		expect(ids(session({ transcript: entries, streamEntryIds: streamed, fork: fork({ files: [] }) }))).toEqual(["I6"]);
	});

	it("I6: a restore from a checkpoint is not a rebuild; its note has to list the operations", () => {
		const entries = [
			...transcript(),
			{ id: "4.5", kind: "tether.sandbox", data: { state: "lost", reason: "missing" } },
			{ id: "7.5", kind: "tether.sandbox", data: { state: "running", reason: "recovered", checkpointId: "cp_1" } },
		].sort((a, b) => Number(a.id) - Number(b.id));
		const streamed = entries.map((e) => e.id);
		const restored = session({ transcript: entries, streamEntryIds: streamed, fork: fork({ files: [`f-${T2}.txt`] }) });
		expect(ids(restored)).toEqual(["I6"]);
	});

	it("I7: anything left after archiving", () => {
		expect(ids(session(), ["volume tether-ses_x"])).toEqual(["I7"]);
	});
});

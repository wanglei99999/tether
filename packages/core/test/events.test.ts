import { describe, expect, it } from "vitest";
import { applyEvent, type SessionView, type TranscriptEntry } from "../src/index.ts";

function emptyView(): SessionView {
	return { running: false, entries: [], tools: [], queued: 0 };
}

function deepFreeze<T>(value: T): T {
	if (typeof value === "object" && value !== null) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

describe("applyEvent", () => {
	it("replaces the whole view on snapshot", () => {
		const before: SessionView = {
			running: true,
			entries: [{ id: "1", kind: "message", role: "user", text: "old" }],
			streaming: { text: "partial" },
			tools: [{ callId: "c1", name: "bash", output: "x" }],
			queued: 2,
		};
		const snapshot: SessionView = {
			running: false,
			entries: [{ id: "9", kind: "message", role: "assistant", text: "new" }],
			tools: [],
			queued: 0,
		};

		const after = applyEvent(before, { type: "snapshot", view: snapshot });

		expect(after).toEqual(snapshot);
		expect(after).not.toBe(snapshot);
	});

	it("accumulates message deltas and clears streaming on message_end", () => {
		let view = applyEvent(emptyView(), { type: "message_start", messageId: "m1" });
		view = applyEvent(view, { type: "message_delta", messageId: "m1", text: "Hel" });
		view = applyEvent(view, { type: "message_delta", messageId: "m1", text: "lo" });
		expect(view.streaming).toEqual({ text: "Hello" });

		const entry: TranscriptEntry = { id: "m1", kind: "message", role: "assistant", text: "Hello" };
		view = applyEvent(view, { type: "message_end", messageId: "m1", entry });

		expect(view.streaming).toBeUndefined();
		expect(view.entries.at(-1)).toEqual(entry);
		expect(view.entries).toHaveLength(1);
	});

	it("appends tool output by callId and drops the tool on tool_end", () => {
		let view = applyEvent(emptyView(), { type: "tool_start", callId: "a", name: "bash", args: { command: "ls" } });
		view = applyEvent(view, { type: "tool_start", callId: "b", name: "read", args: { path: "x" } });
		view = applyEvent(view, { type: "tool_output", callId: "a", text: "one\n" });
		view = applyEvent(view, { type: "tool_output", callId: "a", text: "two\n" });

		expect(view.tools).toEqual([
			{ callId: "a", name: "bash", output: "one\ntwo\n" },
			{ callId: "b", name: "read", output: "" },
		]);

		const entry: TranscriptEntry = {
			id: "r1",
			kind: "message",
			role: "tool",
			toolResult: { callId: "a", isError: false, text: "one\ntwo\n" },
		};
		view = applyEvent(view, { type: "tool_end", callId: "a", entry });

		expect(view.tools).toEqual([{ callId: "b", name: "read", output: "" }]);
		expect(view.entries.at(-1)).toEqual(entry);
	});

	it("returns a new object and never mutates the input view", () => {
		const frozen = deepFreeze<SessionView>({
			running: false,
			entries: [{ id: "1", kind: "message", role: "user", text: "hi" }],
			streaming: { text: "x" },
			tools: [{ callId: "a", name: "bash", output: "" }],
			queued: 0,
		});
		const entry: TranscriptEntry = { id: "2", kind: "tether.sandbox", data: { state: "running" } };

		const results = [
			applyEvent(frozen, { type: "message_delta", messageId: "m", text: "y" }),
			applyEvent(frozen, { type: "tool_output", callId: "a", text: "z" }),
			applyEvent(frozen, { type: "tool_end", callId: "a", entry }),
			applyEvent(frozen, { type: "entry", entry }),
			applyEvent(frozen, { type: "run_end", submissionId: "s", status: "done" }),
		];

		for (const result of results) expect(result).not.toBe(frozen);
		expect(frozen.entries).toHaveLength(1);
		expect(frozen.streaming).toEqual({ text: "x" });
	});
});

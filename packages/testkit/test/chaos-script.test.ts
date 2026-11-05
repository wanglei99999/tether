import { describe, expect, it } from "vitest";
import {
	type ChaosStep,
	chaosMessage,
	inspectMessage,
	longCommand,
	type ModelMessage,
	modelNotes,
	nextStep,
	ticksFor,
	turnLabel,
} from "../src/index.ts";

const user = (text: string): ModelMessage => ({ role: "user", text });
const tool = (text = "ok"): ModelMessage => ({ role: "tool", text });
const assistant = (text = ""): ModelMessage => ({ role: "assistant", text });

function tokenOf(step: ChaosStep): string | undefined {
	return "token" in step ? step.token : undefined;
}

describe("nextStep", () => {
	it("the step depends only on the conversation", () => {
		const messages = [user(chaosMessage(0, 1)), assistant(), tool()];
		expect(nextStep(messages)).toEqual(nextStep([...messages]));
	});

	it("an interrupted call counts, so the retry gets a new token", () => {
		const first = nextStep([user(chaosMessage(0, 1))]);
		const afterInterrupt = nextStep([user(chaosMessage(0, 1)), assistant(), tool("interrupted")]);
		expect(tokenOf(first)).toBe("s0-m1-t0");
		expect(tokenOf(afterInterrupt)).toBe("s0-m1-t1");
	});

	it("three tool steps then text", () => {
		const messages: ModelMessage[] = [user(chaosMessage(1, 2))];
		for (const expected of ["s1-m2-t0", "s1-m2-t1", "s1-m2-t2"]) {
			expect(tokenOf(nextStep(messages))).toBe(expected);
			messages.push(assistant(), tool());
		}
		expect(nextStep(messages)).toEqual({ text: "done" });
	});

	it("a Tether note is neither a turn nor a tool result", () => {
		const messages = [user(chaosMessage(0, 1)), assistant(), tool(), user("The previous sandbox was lost (missing).")];
		expect(tokenOf(nextStep(messages))).toBe("s0-m1-t1");
	});

	it("a conversation without a chaos message gets a plain answer", () => {
		expect(nextStep([user("hello")])).toEqual({ text: "nothing to do" });
	});

	it("an inspect turn runs one command and starts over from the inherited messages", () => {
		const inherited = [user(chaosMessage(0, 1)), assistant(), tool()];
		const messages = [...inherited, user(inspectMessage(3, 1))];
		expect(tokenOf(nextStep(messages))).toBe("i3-m1-t0");
		expect(nextStep([...messages, assistant(), tool()])).toEqual({ text: "inspected" });
	});
});

describe("commands", () => {
	it("a long command writes 3 to 8 seconds of ticks", () => {
		for (const token of ["s0-m0-t1", "s1-m3-t1", "s0-m7-t1"]) {
			expect(ticksFor(token)).toBeGreaterThanOrEqual(15);
			expect(ticksFor(token)).toBeLessThanOrEqual(40);
			expect(longCommand(token)).toContain(token);
		}
	});
});

describe("modelNotes and turnLabel", () => {
	it("finds the notes among the messages", () => {
		const messages = [user(chaosMessage(0, 0)), user("a note"), assistant("not this"), tool("nor this")];
		expect(modelNotes(messages)).toEqual(["a note"]);
	});

	it("labels by the last turn, so a fork that inherited chaos messages is the fork", () => {
		expect(turnLabel([user(chaosMessage(1, 0))])).toBe("s1");
		expect(turnLabel([user(chaosMessage(1, 0)), user(inspectMessage(4, 0))])).toBe("f4");
		expect(turnLabel([user("hello")])).toBeUndefined();
	});
});

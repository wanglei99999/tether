import { describe, expect, it } from "vitest";
import { nextState, type SandboxEvent, type SandboxState } from "../src/index.ts";

type From = SandboxState | undefined;

const STATES: From[] = [undefined, "creating", "running", "stopped", "lost", "destroyed"];
const EVENTS: SandboxEvent[] = ["create", "setup_done", "setup_failed", "abandon", "stop", "start", "vanish", "destroy"];

/** 计划 Task 2 的转换表，逐条抄写；不在这里的组合都必须被拒绝。 */
const ALLOWED: [From, SandboxEvent, From][] = [
	[undefined, "create", "creating"],
	["lost", "create", "creating"],
	["creating", "setup_done", "running"],
	["creating", "setup_failed", undefined],
	["creating", "abandon", "lost"],
	["running", "stop", "stopped"],
	["stopped", "start", "running"],
	["running", "vanish", "lost"],
	["stopped", "vanish", "lost"],
	["creating", "destroy", "destroyed"],
	["running", "destroy", "destroyed"],
	["stopped", "destroy", "destroyed"],
	["lost", "destroy", "destroyed"],
	["destroyed", "destroy", "destroyed"],
];

describe("nextState", () => {
	it("allows exactly the transitions in the table", () => {
		for (const from of STATES) {
			for (const event of EVENTS) {
				const allowed = ALLOWED.find(([f, e]) => f === from && e === event);
				if (allowed) {
					expect(nextState(from, event), `${from ?? "absent"} --${event}-->`).toBe(allowed[2]);
				} else {
					expect(() => nextState(from, event), `${from ?? "absent"} --${event}-->`).toThrow(
						expect.objectContaining({
							code: "conflict",
							message: `cannot ${event} a sandbox that is ${from ?? "absent"}`,
						}),
					);
				}
			}
		}
	});

	it("treats destroy of a destroyed sandbox as a no-op transition", () => {
		expect(nextState("destroyed", "destroy")).toBe("destroyed");
	});
});

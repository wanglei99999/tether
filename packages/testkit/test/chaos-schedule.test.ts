import { describe, expect, it } from "vitest";
import { planRound } from "../src/index.ts";

const OPTIONS = { sessions: 2, messages: 4, gapMs: 20_000, faults: 3 };

describe("planRound", () => {
	it("same seed and round give the same plan", () => {
		expect(planRound(7, 3, OPTIONS)).toEqual(planRound(7, 3, OPTIONS));
	});

	it("different rounds give different plans", () => {
		expect(planRound(7, 3, OPTIONS)).not.toEqual(planRound(7, 4, OPTIONS));
	});

	it("at least a quarter of the faults fall 0-500 ms after a message", () => {
		let near = 0;
		let total = 0;
		for (let round = 0; round < 200; round += 1) {
			const { faults, messageAt } = planRound(11, round, OPTIONS);
			for (const fault of faults) {
				total += 1;
				if (messageAt[fault.session]!.some((at) => fault.at >= at && fault.at <= at + 500)) near += 1;
			}
		}
		expect(near / total).toBeGreaterThanOrEqual(0.25);
	});

	it("every kind appears over 200 rounds", () => {
		const kinds = new Set<string>();
		for (let round = 0; round < 200; round += 1) {
			for (const fault of planRound(11, round, OPTIONS).faults) kinds.add(fault.kind);
		}
		expect([...kinds].sort()).toEqual(["kill9", "removeContainer", "stall", "stallThenKill"]);
	});

	it("faults are sorted by time and carry the durations of their kind", () => {
		for (let round = 0; round < 50; round += 1) {
			const { faults } = planRound(5, round, OPTIONS);
			expect(faults.map((f) => f.at)).toEqual(faults.map((f) => f.at).sort((a, b) => a - b));
			for (const fault of faults) {
				if (fault.kind === "stall") {
					expect(fault.holdMs).toBeGreaterThanOrEqual(2_000);
					expect(fault.holdMs).toBeLessThanOrEqual(40_000);
				}
				if (fault.kind === "kill9" || fault.kind === "stallThenKill") {
					expect(fault.downMs).toBeGreaterThanOrEqual(0);
					expect(fault.downMs).toBeLessThanOrEqual(5_000);
				}
			}
		}
	});
});

import { describe, expect, it } from "vitest";
import { startSweeper } from "../src/index.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const quiet = { warn: () => {} };

describe("startSweeper", () => {
	it("never runs two sweeps at once", async () => {
		let active = 0;
		let most = 0;
		let runs = 0;
		const sweeper = startSweeper(
			async () => {
				active++;
				runs++;
				most = Math.max(most, active);
				await sleep(40);
				active--;
			},
			5,
			quiet,
		);

		await sleep(150);
		await sweeper.stop();

		expect(runs).toBeGreaterThanOrEqual(2);
		expect(most).toBe(1);
	});

	it("waits for the running sweep on stop", async () => {
		let release!: () => void;
		let started!: () => void;
		const running = new Promise<void>((resolve) => {
			started = resolve;
		});
		let finished = false;
		const sweeper = startSweeper(
			async () => {
				started();
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				finished = true;
			},
			5,
			quiet,
		);
		await running;

		let stopped = false;
		const stopping = sweeper.stop().then(() => {
			stopped = true;
		});
		await sleep(20);
		expect(stopped).toBe(false);

		release();
		await stopping;
		expect(finished).toBe(true);
	});

	it("logs a failed sweep and keeps going", async () => {
		const warnings: string[] = [];
		let runs = 0;
		const sweeper = startSweeper(
			async () => {
				runs++;
				throw new Error("docker is down");
			},
			5,
			{ warn: (message) => warnings.push(message) },
		);

		await sleep(60);
		await sweeper.stop();

		expect(runs).toBeGreaterThanOrEqual(2);
		expect(warnings.length).toBe(runs);
	});
});

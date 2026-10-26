import { describe, expect, it } from "vitest";
import { KeyedLock } from "../src/index.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("KeyedLock", () => {
	it("runs work for the same key one at a time in call order", async () => {
		const lock = new KeyedLock();
		const events: string[] = [];
		const work = (name: string, ms: number) => async () => {
			events.push(`${name} start`);
			await delay(ms);
			events.push(`${name} end`);
			return name;
		};

		const results = await Promise.all([lock.run("a", work("1", 20)), lock.run("a", work("2", 5)), lock.run("a", work("3", 0))]);

		expect(results).toEqual(["1", "2", "3"]);
		expect(events).toEqual(["1 start", "1 end", "2 start", "2 end", "3 start", "3 end"]);
	});

	it("runs work for different keys concurrently", async () => {
		const lock = new KeyedLock();
		const events: string[] = [];
		const work = (name: string) => async () => {
			events.push(`${name} start`);
			await delay(10);
			events.push(`${name} end`);
		};

		await Promise.all([lock.run("a", work("a")), lock.run("b", work("b"))]);

		expect(events.slice(0, 2)).toEqual(["a start", "b start"]);
	});

	it("keeps running queued work after one throws", async () => {
		const lock = new KeyedLock();

		const failed = lock.run("a", async () => {
			throw new Error("boom");
		});
		const next = lock.run("a", async () => "ran");

		await expect(failed).rejects.toThrow("boom");
		await expect(next).resolves.toBe("ran");
	});
});

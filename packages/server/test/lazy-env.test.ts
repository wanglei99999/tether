import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { afterAll, describe, expect, it } from "vitest";
import { lazyEnv } from "../src/adapters/exec-pienv/index.ts";

const dir = mkdtempSync(join(tmpdir(), "tether-lazy-"));
const context = BACKGROUND_CONTEXT;

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

function counted(fail = 0): { resolve: () => Promise<ExecutionEnv>; calls: () => number } {
	let calls = 0;
	return {
		calls: () => calls,
		resolve: async () => {
			calls += 1;
			if (calls <= fail) throw new Error("setup failed: exit 3");
			return new NodeExecutionEnv({ cwd: dir });
		},
	};
}

describe("lazyEnv", () => {
	it("does not resolve the real environment until a method is called", async () => {
		const source = counted();
		const env = lazyEnv({ id: "tether:ses_1", cwd: dir, resolve: source.resolve });

		// pi 拿到环境时会 await 它、读 id 和 cwd：这些都不应该建沙箱
		expect(await Promise.resolve(env)).toBe(env);
		expect(env.id).toBe("tether:ses_1");
		expect(env.cwd).toBe(dir);
		await env.cleanup(context);
		expect(source.calls()).toBe(0);

		const written = await env.writeFile("a.txt", "hi", context);
		expect(written.ok).toBe(true);
		const read = await env.readTextFile("a.txt", context);
		expect(read).toMatchObject({ ok: true, value: "hi" });
		expect(source.calls()).toBe(1);
	});

	it("rejects a call when resolving fails, and resolves again on the next call", async () => {
		const source = counted(1);
		const env = lazyEnv({ id: "tether:ses_2", cwd: dir, resolve: source.resolve });

		await expect(env.exists("a.txt", context)).rejects.toThrow(/setup failed: exit 3/);
		expect((await env.exists(".", context)).ok).toBe(true);
		expect(source.calls()).toBe(2);
	});
});

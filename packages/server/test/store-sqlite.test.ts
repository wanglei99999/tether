import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAppStoreConformance, sampleAgent, sampleSession } from "@tether/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSqliteAppStore } from "../src/adapters/store-sqlite/index.ts";

registerAppStoreConformance({ describe, it, expect, beforeEach }, "sqlite", () => openSqliteAppStore(":memory:"));

describe("store-sqlite on disk", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "tether-store-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("keeps data across close and reopen", async () => {
		const path = join(dir, "tether.sqlite");
		const first = await openSqliteAppStore(path);
		const { agent, first: v1 } = sampleAgent();
		await first.store.createAgent(agent, v1);
		await first.store.createSession(sampleSession("ses_1"));
		await first.close();

		const second = await openSqliteAppStore(path);
		expect(await second.store.getAgent(agent.id)).toEqual(agent);
		expect(await second.store.getSession("ses_1")).toEqual(sampleSession("ses_1"));
		await second.close();
	});
});

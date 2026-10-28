import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	registerAppStoreConformance,
	sampleAgent,
	sampleBinding,
	sampleCheckpoint,
	sampleSession,
} from "@tether/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSqliteAppStore } from "../src/adapters/store-sqlite/index.ts";
import { SCHEMA_V1 } from "../src/adapters/store-sqlite/schema.ts";

const T0 = "2026-10-25T00:00:00.000Z";

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

	it("migrates a version 1 database to version 2 keeping its rows", async () => {
		const path = join(dir, "tether.sqlite");
		// M2 发布时的库：照第 1 版的表结构建，写一个会话和一个绑定
		const old = new DatabaseSync(path);
		old.exec(SCHEMA_V1);
		old.exec("PRAGMA user_version = 1");
		old.prepare(
			`INSERT INTO sessions (id, owner_id, agent_id, agent_version, engine_session_id, parent_session_id,
			   forked_from, variables, status, title, created_at, last_active_at)
			 VALUES ('ses_1', 'local', 'agt_1', 1, NULL, NULL, NULL, '{}', 'active', NULL, ?, ?)`,
		).run(T0, T0);
		old.prepare(
			`INSERT INTO sandbox_bindings (session_id, provider, sandbox_id, epoch, state, template, created_at, last_used_at)
			 VALUES ('ses_1', 'docker', 'sbx_ses_1', 3, 'stopped', '', ?, ?)`,
		).run(T0, T0);
		old.close();

		const opened = await openSqliteAppStore(path);
		try {
			expect(await opened.store.getSession("ses_1")).toEqual(sampleSession("ses_1"));
			expect(await opened.store.getBinding("ses_1")).toEqual(sampleBinding("ses_1", { epoch: 3, state: "stopped" }));
			await opened.store.addCheckpoint(sampleCheckpoint("cp_1"));
			expect(await opened.store.getCheckpoint("cp_1")).toEqual(sampleCheckpoint("cp_1"));
		} finally {
			await opened.close();
		}
		// 再打开一次：已经是第 2 版，不重复迁移
		const again = await openSqliteAppStore(path);
		expect(await again.store.getCheckpoint("cp_1")).toEqual(sampleCheckpoint("cp_1"));
		await again.close();
	});
});

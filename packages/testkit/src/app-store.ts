import type {
	AgentRecord,
	AgentVersionRecord,
	AgentVersionSpec,
	AppStore,
	SandboxBinding,
	SessionRecord,
} from "@tether/core";
import type { beforeEach, describe, expect, it } from "vitest";

export interface ConformanceRunner {
	describe: typeof describe;
	it: typeof it;
	expect: typeof expect;
	beforeEach: typeof beforeEach;
}

export interface OpenedStore {
	store: AppStore;
	close(): Promise<void>;
}

const T0 = "2026-10-25T00:00:00.000Z";

export function sampleSpec(instructions = "You are a careful engineer."): AgentVersionSpec {
	return {
		model: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
		instructions,
		tools: ["read", "bash"],
		sandbox: {
			template: "",
			resources: { cpu: 1, memoryMb: 512 },
			network: "none",
			setup: [],
			variables: ["REPO_URL"],
		},
		checkpointPolicy: "none",
		permissions: { denyTools: [], requireApproval: [] },
	};
}

export function sampleAgent(id = "agt_1"): { agent: AgentRecord; first: AgentVersionRecord } {
	return {
		agent: { id, ownerId: "local", name: `agent ${id}`, description: "", createdAt: T0 },
		first: { agentId: id, version: 1, spec: sampleSpec(), createdAt: T0 },
	};
}

export function sampleSession(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
	return {
		id,
		ownerId: "local",
		agentId: "agt_1",
		agentVersion: 1,
		engineSessionId: null,
		parentSessionId: null,
		forkedFrom: null,
		variables: {},
		status: "active",
		createdAt: T0,
		lastActiveAt: T0,
		...overrides,
	};
}

export function sampleBinding(sessionId: string, overrides: Partial<SandboxBinding> = {}): SandboxBinding {
	return {
		sessionId,
		provider: "docker",
		sandboxId: `sbx_${sessionId}`,
		epoch: 1,
		state: "running",
		template: "",
		createdAt: T0,
		lastUsedAt: T0,
		...overrides,
	};
}

/** 任何 AppStore 实现都要通过的用例。内存实现和 SQLite 实现各跑一遍。 */
export function registerAppStoreConformance(
	runner: ConformanceRunner,
	name: string,
	open: () => Promise<OpenedStore>,
): void {
	const { describe, it, expect, beforeEach } = runner;

	describe(`AppStore conformance: ${name}`, () => {
		let store: AppStore;

		beforeEach(async () => {
			const opened = await open();
			store = opened.store;
			return () => opened.close();
		});

		it("creates an agent with version 1 atomically", async () => {
			const { agent, first } = sampleAgent();
			await store.createAgent(agent, first);

			expect(await store.getAgent(agent.id)).toEqual(agent);
			expect(await store.getVersion(agent.id, 1)).toEqual(first);
			expect(await store.listAgents()).toEqual([agent]);
		});

		it("numbers versions 1, 2, 3 and returns the latest when version is omitted", async () => {
			const { agent, first } = sampleAgent();
			await store.createAgent(agent, first);

			const second = await store.addVersion(agent.id, sampleSpec("v2"), "2026-10-25T01:00:00.000Z");
			const third = await store.addVersion(agent.id, sampleSpec("v3"), "2026-10-25T02:00:00.000Z");

			expect(second.version).toBe(2);
			expect(third).toEqual({
				agentId: agent.id,
				version: 3,
				spec: sampleSpec("v3"),
				createdAt: "2026-10-25T02:00:00.000Z",
			});
			expect(await store.getVersion(agent.id)).toEqual(third);
			expect((await store.getVersion(agent.id, 2))?.spec.instructions).toBe("v2");
		});

		it("assigns distinct versions to concurrent addVersion calls", async () => {
			const { agent, first } = sampleAgent();
			await store.createAgent(agent, first);

			const results = await Promise.all([
				store.addVersion(agent.id, sampleSpec("a"), T0),
				store.addVersion(agent.id, sampleSpec("b"), T0),
			]);

			expect(new Set(results.map((r) => r.version))).toEqual(new Set([2, 3]));
		});

		it("returns undefined for a missing agent, version, session and binding", async () => {
			const { agent, first } = sampleAgent();
			await store.createAgent(agent, first);

			expect(await store.getAgent("agt_missing")).toBeUndefined();
			expect(await store.getVersion("agt_missing")).toBeUndefined();
			expect(await store.getVersion(agent.id, 9)).toBeUndefined();
			expect(await store.getSession("ses_missing")).toBeUndefined();
			expect(await store.getSessionByEngineId("eng_missing")).toBeUndefined();
			expect(await store.getBinding("ses_missing")).toBeUndefined();
		});

		it("rejects changes to a missing agent or session with not_found", async () => {
			await expect(store.addVersion("agt_missing", sampleSpec(), T0)).rejects.toMatchObject({ code: "not_found" });
			await expect(store.archiveAgent("agt_missing", T0)).rejects.toMatchObject({ code: "not_found" });
			await expect(store.setEngineSessionId("ses_missing", "eng")).rejects.toMatchObject({ code: "not_found" });
			await expect(store.updateSession("ses_missing", { status: "idle" })).rejects.toMatchObject({
				code: "not_found",
			});
		});

		it("archives an agent", async () => {
			const { agent, first } = sampleAgent();
			await store.createAgent(agent, first);
			await store.archiveAgent(agent.id, "2026-10-26T00:00:00.000Z");

			expect((await store.getAgent(agent.id))?.archivedAt).toBe("2026-10-26T00:00:00.000Z");
		});

		it("finds a session by its engine session id after setEngineSessionId", async () => {
			await store.createSession(sampleSession("ses_1"));
			expect(await store.getSessionByEngineId("eng_1")).toBeUndefined();

			await store.setEngineSessionId("ses_1", "eng_1");

			expect(await store.getSessionByEngineId("eng_1")).toEqual(sampleSession("ses_1", { engineSessionId: "eng_1" }));
		});

		it("lists sessions without an engine id", async () => {
			await store.createSession(sampleSession("ses_1"));
			await store.createSession(sampleSession("ses_2"));
			await store.setEngineSessionId("ses_2", "eng_2");

			expect((await store.sessionsWithoutEngine()).map((s) => s.id)).toEqual(["ses_1"]);
		});

		it("filters sessions by agent and status and pages with after", async () => {
			await store.createSession(sampleSession("ses_1"));
			await store.createSession(sampleSession("ses_2"));
			await store.createSession(sampleSession("ses_3"));
			await store.createSession(sampleSession("ses_4", { agentId: "agt_other" }));
			await store.createSession(sampleSession("ses_5", { status: "archived" }));

			const query = { agentId: "agt_1", status: "active" as const, limit: 2 };
			const page1 = await store.listSessions(query);
			expect(page1.items.map((s) => s.id)).toEqual(["ses_3", "ses_2"]);
			expect(page1.next).toBeDefined();

			const page2 = await store.listSessions({ ...query, after: page1.next });
			expect(page2.items.map((s) => s.id)).toEqual(["ses_1"]);
			expect(page2.next).toBeUndefined();
		});

		it("updates status, title and lastActiveAt only", async () => {
			await store.createSession(sampleSession("ses_1"));
			await store.updateSession("ses_1", { status: "idle", title: "fix tests", lastActiveAt: "2026-10-25T05:00:00.000Z" });

			expect(await store.getSession("ses_1")).toEqual(
				sampleSession("ses_1", { status: "idle", title: "fix tests", lastActiveAt: "2026-10-25T05:00:00.000Z" }),
			);
		});

		it("replaces a binding on put and removes it on delete", async () => {
			await store.putBinding(sampleBinding("ses_1"));
			await store.putBinding(sampleBinding("ses_2"));
			const replaced = sampleBinding("ses_1", { state: "stopped", lastUsedAt: "2026-10-25T06:00:00.000Z" });
			await store.putBinding(replaced);

			expect(await store.getBinding("ses_1")).toEqual(replaced);
			expect(await store.listBindings()).toHaveLength(2);

			await store.deleteBinding("ses_1");
			await store.deleteBinding("ses_missing");

			expect(await store.getBinding("ses_1")).toBeUndefined();
			expect((await store.listBindings()).map((b) => b.sessionId)).toEqual(["ses_2"]);
		});

		it("round-trips variables with shell metacharacters", async () => {
			const variables = { REPO_URL: `x"; rm -rf / #'$(id)\`\n\u0000é` };
			await store.createSession(sampleSession("ses_1", { variables }));

			expect((await store.getSession("ses_1"))?.variables).toEqual(variables);
		});

		it("returns copies that callers cannot use to change stored data", async () => {
			await store.createSession(sampleSession("ses_1", { variables: { REPO_URL: "a" } }));
			const read = await store.getSession("ses_1");
			if (read) read.variables.REPO_URL = "changed";

			expect((await store.getSession("ses_1"))?.variables.REPO_URL).toBe("a");
		});
	});
}

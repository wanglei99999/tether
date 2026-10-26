import { MemoryAppStore, sampleSpec } from "@tether/testkit";
import { describe, expect, it } from "vitest";
import { AgentService, BUILTIN_TOOLS, SessionService } from "../src/index.ts";
import { FakeClock, FakeEngine, FakeIds } from "./fakes.ts";

async function setUp() {
	const store = new MemoryAppStore();
	const clock = new FakeClock();
	const ids = new FakeIds();
	const engine = new FakeEngine();
	const agents = new AgentService({ store, clock, ids, catalog: BUILTIN_TOOLS });
	const sessions = new SessionService({ store, engine, agents, clock, ids });
	const { agent } = await agents.create({ name: "fixer", spec: sampleSpec("v1") });
	return { store, engine, agents, sessions, agentId: agent.id };
}

describe("SessionService", () => {
	it("writes the session before creating the engine session and backfills the engine id", async () => {
		const { store, engine, sessions, agentId } = await setUp();
		let seenDuringCreate: unknown;
		engine.onCreate = async () => {
			seenDuringCreate = (await store.listSessions({ limit: 10 })).items;
		};

		const session = await sessions.create({ agentId, variables: { REPO_URL: "x" } });

		expect(seenDuringCreate).toEqual([{ ...session, engineSessionId: null }]);
		expect(session).toMatchObject({ agentId, agentVersion: 1, engineSessionId: "eng_1", status: "active" });
		expect(await store.getSession(session.id)).toEqual(session);
	});

	it("leaves engineSessionId null when the engine fails, and rethrows engine_failed", async () => {
		const { store, engine, sessions, agentId } = await setUp();
		engine.failCreate = true;

		await expect(sessions.create({ agentId })).rejects.toMatchObject({ code: "engine_failed" });

		const [left] = await store.sessionsWithoutEngine();
		expect(left).toMatchObject({ agentId, engineSessionId: null });
	});

	it("pins the session to the latest version when agentVersion is omitted", async () => {
		const { agents, sessions, agentId } = await setUp();
		await agents.addVersion(agentId, sampleSpec("v2"));

		expect((await sessions.create({ agentId })).agentVersion).toBe(2);
		expect((await sessions.create({ agentId, agentVersion: 1 })).agentVersion).toBe(1);
		await expect(sessions.create({ agentId, agentVersion: 9 })).rejects.toMatchObject({ code: "not_found" });
	});

	it("validates variables against the pinned version", async () => {
		const { sessions, agentId } = await setUp();

		await expect(sessions.create({ agentId, variables: { OTHER: "x" } })).rejects.toMatchObject({
			code: "invalid_request",
		});
		await expect(sessions.create({ agentId, variables: { REPO_URL: 3 } })).rejects.toMatchObject({
			code: "invalid_request",
		});
		const session = await sessions.create({ agentId, variables: { REPO_URL: "x; touch pwned" } });
		expect(session.variables).toEqual({ REPO_URL: "x; touch pwned" });
	});

	it("passes model, instructions, tools and cwd /workspace to the engine", async () => {
		const { engine, sessions, agentId } = await setUp();

		await sessions.create({ agentId });

		const spec = sampleSpec("v1");
		expect(engine.created).toEqual([
			{ model: spec.model, instructions: "v1", tools: spec.tools, cwd: "/workspace" },
		]);
	});

	it("rejects sessions for an archived agent with conflict", async () => {
		const { agents, sessions, agentId } = await setUp();
		await agents.archive(agentId);

		await expect(sessions.create({ agentId })).rejects.toMatchObject({ code: "conflict" });
	});

	it("sends messages to the engine session and updates lastActiveAt", async () => {
		const { store, engine, sessions, agentId } = await setUp();
		const session = await sessions.create({ agentId });

		const { submissionId } = await sessions.sendMessage(session.id, { content: "hi", requestId: "r1" });

		expect(submissionId).toBe("sub_1");
		expect(engine.submitted).toEqual([{ engineSessionId: "eng_1", content: "hi", requestId: "r1" }]);
		const updated = await store.getSession(session.id);
		expect(updated && updated.lastActiveAt > session.lastActiveAt).toBe(true);
	});

	it("turns an idle session active again when a message is sent", async () => {
		const { store, sessions, agentId } = await setUp();
		const session = await sessions.create({ agentId });
		await store.updateSession(session.id, { status: "idle" });

		await sessions.sendMessage(session.id, { content: "back", requestId: "r1" });

		expect((await store.getSession(session.id))?.status).toBe("active");
	});

	it("rejects messages to a session whose engine session was never created", async () => {
		const { engine, sessions, agentId } = await setUp();
		engine.failCreate = true;
		await sessions.create({ agentId }).catch(() => {});
		const [{ id }] = (await sessions.list({ limit: 1 })).items;

		await expect(sessions.sendMessage(id, { content: "hi", requestId: "r" })).rejects.toMatchObject({
			code: "conflict",
		});
	});

	it("returns not_found for messages to an unknown session", async () => {
		const { sessions } = await setUp();

		await expect(sessions.sendMessage("ses_missing", { content: "hi", requestId: "r" })).rejects.toMatchObject({
			code: "not_found",
		});
		await expect(sessions.get("ses_missing")).rejects.toMatchObject({ code: "not_found" });
		await expect(sessions.transcript("ses_missing", { limit: 10 })).rejects.toMatchObject({ code: "not_found" });
	});
});

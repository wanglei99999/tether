import { MemoryAppStore, sampleCheckpoint, sampleSpec } from "@tether/testkit";
import { describe, expect, it } from "vitest";
import { AgentService, BUILTIN_TOOLS, NOTES, SessionService } from "../src/index.ts";
import { FakeClock, FakeEngine, FakeIds, FakeSandboxes } from "./fakes.ts";

async function setUp() {
	const store = new MemoryAppStore();
	const clock = new FakeClock();
	const ids = new FakeIds();
	const engine = new FakeEngine();
	const sandboxes = new FakeSandboxes();
	const agents = new AgentService({ store, clock, ids, catalog: BUILTIN_TOOLS });
	const sessions = new SessionService({ store, engine, agents, sandboxes, clock, ids });
	const { agent } = await agents.create({ name: "fixer", spec: sampleSpec("v1") });
	return { store, engine, sandboxes, agents, sessions, agentId: agent.id };
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

	it("archives a session: status archived, run aborted, sandbox destroyed", async () => {
		const { store, engine, sandboxes, sessions, agentId } = await setUp();
		const session = await sessions.create({ agentId });
		let statusAtDestroy: string | undefined;
		sandboxes.onDestroy = async (id) => {
			statusAtDestroy = (await store.getSession(id))?.status;
		};

		const archived = await sessions.archive(session.id);

		expect(archived).toMatchObject({ id: session.id, status: "archived" });
		expect(await store.getSession(session.id)).toMatchObject({ status: "archived" });
		expect(engine.aborted).toEqual(["eng_1"]);
		expect(sandboxes.destroyed).toEqual([{ sessionId: session.id, reason: "archived" }]);
		// 先改状态再销毁：销毁期间到达的消息已经会被拒绝
		expect(statusAtDestroy).toBe("archived");
	});

	it("rejects messages to an archived session with conflict", async () => {
		const { sessions, agentId } = await setUp();
		const session = await sessions.create({ agentId });
		await sessions.archive(session.id);

		await expect(sessions.sendMessage(session.id, { content: "hi", requestId: "r" })).rejects.toMatchObject({
			code: "conflict",
		});
	});

	it("retries the sandbox destroy when archive is called again after a failure", async () => {
		const { store, sandboxes, sessions, agentId } = await setUp();
		const session = await sessions.create({ agentId });
		sandboxes.fail = true;
		await expect(sessions.archive(session.id)).rejects.toMatchObject({ code: "sandbox_failed" });
		expect((await store.getSession(session.id))?.status).toBe("archived");
		sandboxes.fail = false;

		await sessions.archive(session.id);

		expect(sandboxes.destroyed).toEqual([{ sessionId: session.id, reason: "archived" }]);
	});

	it("archives a session whose engine session was never created without aborting", async () => {
		const { engine, sandboxes, sessions, agentId } = await setUp();
		engine.failCreate = true;
		await sessions.create({ agentId }).catch(() => {});
		const [{ id }] = (await sessions.list({ limit: 1 })).items;

		await expect(sessions.archive(id)).resolves.toMatchObject({ status: "archived" });
		expect(engine.aborted).toEqual([]);
		expect(sandboxes.destroyed).toHaveLength(1);
	});

	it("returns not_found when archiving an unknown session", async () => {
		const { sessions } = await setUp();
		await expect(sessions.archive("ses_missing")).rejects.toMatchObject({ code: "not_found" });
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

describe("SessionService.fork", () => {
	/**
	 * 两轮：第一轮写 f1，第二轮写 f2。条目 1 用户，2-3 write f1，4 回答，5 用户，6-7 write f2，8 回答。
	 * 第二轮的存档对齐到 5，内容是 {f1}。
	 */
	async function twoRounds() {
		const made = await setUp();
		const { engine, sessions, store, agentId } = made;
		const source = await sessions.create({ agentId, variables: { REPO_URL: "r" } });
		await sessions.sendMessage(source.id, { content: "make f1", requestId: "r1" });
		engine.ran("eng_1", "write", { path: "f1" });
		engine.push("eng_1", { kind: "pi.assistant", role: "assistant", text: "done" });
		await sessions.sendMessage(source.id, { content: "make f2", requestId: "r2" });
		engine.ran("eng_1", "write", { path: "f2" });
		engine.push("eng_1", { kind: "pi.assistant", role: "assistant", text: "done" });
		const addCheckpoint = (id: string, entryId: string) =>
			store.addCheckpoint(sampleCheckpoint(id, { sessionId: source.id, entryId, snapshotId: `${source.id}/${id}` }));
		return { ...made, source, addCheckpoint };
	}

	it("forks at an entry with an aligned checkpoint and tells the model nothing was missed", async () => {
		const { engine, sessions, store, source, addCheckpoint } = await twoRounds();
		await addCheckpoint("cp_r2", "5");

		// 在第二条消息之前分叉：4 和 5 之间没有改过工作区，第二轮的存档就是 4 那一刻
		const fork = await sessions.fork(source.id, "4");

		expect(fork).toMatchObject({
			agentId: source.agentId,
			agentVersion: source.agentVersion,
			variables: { REPO_URL: "r" },
			status: "active",
			forkedFrom: { sessionId: source.id, entryId: "4", checkpointId: "cp_r2" },
			engineSessionId: "eng_2",
		});
		expect(fork.id).not.toBe(source.id);
		expect(await store.getSession(fork.id)).toEqual(fork);
		expect(engine.forks).toEqual([{ engineSessionId: "eng_1", entryId: "4" }]);
		expect(engine.appended).toEqual([
			{
				engineSessionId: "eng_2",
				kind: "tether.fork",
				data: { sessionId: source.id, entryId: "4", checkpointId: "cp_r2", missed: 0 },
				modelText: NOTES.forked([]),
			},
		]);
		expect(engine.created).toHaveLength(1);
	});

	it("forks at an entry after the checkpoint and lists the calls that did not happen", async () => {
		const { engine, sessions, source, addCheckpoint } = await twoRounds();
		await addCheckpoint("cp_r1", "1");
		await addCheckpoint("cp_r2", "5");

		// 在 write f2 之后分叉：第二轮的存档里没有 f2，下一张又不存在
		const fork = await sessions.fork(source.id, "8");

		expect(fork.forkedFrom).toEqual({ sessionId: source.id, entryId: "8", checkpointId: "cp_r2" });
		expect(engine.appended[0]).toMatchObject({ data: { missed: 1 }, modelText: NOTES.forked(["write: f2"]) });
	});

	it("forks without any checkpoint and tells the model the workspace is fresh", async () => {
		const { engine, sessions, source } = await twoRounds();

		const fork = await sessions.fork(source.id, "8");

		expect(fork.forkedFrom).toEqual({ sessionId: source.id, entryId: "8", checkpointId: null });
		expect(engine.appended[0]).toMatchObject({ kind: "tether.fork", modelText: NOTES.forkFresh });
	});

	it("rejects forking an archived session with conflict", async () => {
		const { sessions, source } = await twoRounds();
		await sessions.archive(source.id);

		await expect(sessions.fork(source.id, "4")).rejects.toMatchObject({ code: "conflict" });
	});

	it("rejects an entry that is not in the session without writing a session", async () => {
		const { sessions, source } = await twoRounds();

		for (const entryId of ["99", "abc", ""]) {
			await expect(sessions.fork(source.id, entryId), entryId).rejects.toMatchObject({ code: "invalid_request" });
		}
		expect((await sessions.list({ limit: 10 })).items).toHaveLength(1);
	});

	it("lists a session's checkpoints oldest first", async () => {
		const { sessions, source, addCheckpoint } = await twoRounds();
		await addCheckpoint("cp_r2", "5");
		await addCheckpoint("cp_r1", "1");

		expect((await sessions.checkpoints(source.id)).map((c) => c.id)).toEqual(["cp_r1", "cp_r2"]);
		await expect(sessions.checkpoints("ses_missing")).rejects.toMatchObject({ code: "not_found" });
	});
});

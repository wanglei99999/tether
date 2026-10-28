import { MemoryAppStore, sampleBinding, sampleSession, sampleSpec } from "@tether/testkit";
import { describe, expect, it } from "vitest";
import { AgentService, BUILTIN_TOOLS, NOTES, recover, SessionService } from "../src/index.ts";
import { FakeClock, FakeEngine, FakeIds, FakeProvider, FakeSandboxes } from "./fakes.ts";

/** 按调用顺序记下引擎和 Docker 被调用了什么。 */
async function setUp() {
	const order: string[] = [];
	const store = new MemoryAppStore();
	const clock = new FakeClock();
	const ids = new FakeIds();
	const engine = new FakeEngine();
	const resume = engine.resume.bind(engine);
	engine.resume = () => {
		order.push("engine.resume");
		resume();
	};
	engine.onCreate = async () => {
		order.push("engine.createSession");
	};
	for (const method of ["submit", "appendEntry", "isRunning", "abort", "subscribe", "transcript"] as const) {
		const original = engine[method].bind(engine) as (...args: unknown[]) => Promise<unknown>;
		(engine as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
			order.push(`engine.${method}`);
			return original(...args);
		};
	}
	const provider = new FakeProvider();
	const listManaged = provider.listManaged.bind(provider);
	provider.listManaged = async () => {
		order.push("provider.listManaged");
		return listManaged();
	};
	const agents = new AgentService({ store, clock, ids, catalog: BUILTIN_TOOLS });
	const sessions = new SessionService({ store, engine, agents, sandboxes: new FakeSandboxes(), clock, ids });
	const warnings: string[] = [];
	const log = { warn: (message: string) => warnings.push(message) };
	const { agent } = await agents.create({ name: "fixer", spec: sampleSpec() });

	/** 模拟崩溃前写下的半成品：应用表有记录，引擎会话没建成。 */
	async function halfCreatedSession(): Promise<string> {
		engine.failCreate = true;
		await sessions.create({ agentId: agent.id }).catch(() => {});
		engine.failCreate = false;
		const [latest] = (await store.listSessions({ limit: 1 })).items;
		return latest!.id;
	}

	/** 有引擎会话、绑定写着 running、容器却在 Tether 停机期间被停掉的会话。 */
	async function stoppedWhileDown(): Promise<string> {
		const session = await sessions.create({ agentId: agent.id });
		const { sandboxId } = await provider.create({ sessionId: session.id, spec: sampleSpec().sandbox });
		await provider.stop(sandboxId);
		await store.createBinding(sampleBinding(session.id, { sandboxId, state: "running" }));
		return session.id;
	}

	/** 分叉做到一半：新会话的记录写了，引擎还没分叉。源会话有两条记录（用户、回答），在回答处分叉。 */
	async function halfCreatedFork(): Promise<{ source: string; fork: string }> {
		const source = await sessions.create({ agentId: agent.id });
		await sessions.sendMessage(source.id, { content: "hi", requestId: "r" });
		const entryId = engine.push(source.engineSessionId!, { kind: "pi.assistant", role: "assistant", text: "hello" });
		const fork = sampleSession("ses_fork", {
			agentId: agent.id,
			forkedFrom: { sessionId: source.id, entryId, checkpointId: null },
		});
		await store.createSession(fork);
		return { source: source.id, fork: fork.id };
	}

	order.length = 0;
	const run = () => recover({ store, engine, provider, sessions, log });
	return { order, store, engine, provider, warnings, halfCreatedSession, halfCreatedFork, stoppedWhileDown, run };
}

describe("recover", () => {
	it("repairs sessions without an engine id before resuming the engine", async () => {
		const { order, store, halfCreatedSession, run } = await setUp();
		const first = await halfCreatedSession();
		const second = await halfCreatedSession();
		order.length = 0;

		const result = await run();

		expect(result.repairedSessions).toBe(2);
		expect((await store.getSession(first))?.engineSessionId).not.toBeNull();
		expect((await store.getSession(second))?.engineSessionId).not.toBeNull();
		expect(await store.sessionsWithoutEngine()).toEqual([]);
		expect(order.filter((call) => call.startsWith("engine."))).toEqual([
			"engine.createSession",
			"engine.createSession",
			"engine.resume",
		]);
	});

	it("repairs a half-created fork by forking the engine session, not creating a new one", async () => {
		const { store, engine, halfCreatedFork, run } = await setUp();
		const { source, fork } = await halfCreatedFork();
		const sourceEngine = (await store.getSession(source))!.engineSessionId!;
		engine.created.length = 0;

		const result = await run();

		expect(result.repairedSessions).toBe(1);
		expect(engine.created).toEqual([]);
		expect(engine.forks).toEqual([{ engineSessionId: sourceEngine, entryId: "2" }]);
		const repaired = await store.getSession(fork);
		expect(repaired?.engineSessionId).toBe(`eng_${engine.forks.length + 1}`);
		// 说明不在 recover 里写（resume 之前写引擎会提前续跑），交给组装层
		expect(engine.appended).toEqual([]);
		expect(result.notes).toEqual([
			{
				sessionId: fork,
				note: {
					kind: "tether.fork",
					data: { sessionId: source, entryId: "2", checkpointId: null, missed: 0 },
					modelText: NOTES.forkFresh,
				},
			},
		]);
	});

	it("marks a session failed when its engine session cannot be created", async () => {
		const { store, engine, warnings, halfCreatedSession, run } = await setUp();
		const id = await halfCreatedSession();
		engine.failCreate = true;

		const result = await run();

		expect(result.repairedSessions).toBe(0);
		expect(await store.getSession(id)).toMatchObject({ status: "failed", engineSessionId: null });
		expect(warnings.join("\n")).toContain(id);
	});

	it("does not retry sessions already marked failed", async () => {
		const { store, engine, halfCreatedSession, run } = await setUp();
		const id = await halfCreatedSession();
		engine.failCreate = true;
		await run();
		engine.failCreate = false;
		engine.created.length = 0;

		await run();

		expect(engine.created).toEqual([]);
		expect((await store.getSession(id))?.status).toBe("failed");
	});

	it("marks bindings lost whose sandbox is missing", async () => {
		const { store, provider, run } = await setUp();
		const { sandboxId } = await provider.create({ sessionId: "ses_kept", spec: sampleSpec().sandbox });
		await provider.stop(sandboxId);
		await store.createBinding(sampleBinding("ses_kept", { sandboxId, state: "running" }));
		await store.createBinding(sampleBinding("ses_gone", { sandboxId: "sbx_gone", state: "running" }));

		const result = await run();

		expect(result.lostBindings).toBe(1);
		expect((await store.getBinding("ses_gone"))?.state).toBe("lost");
		// 状态也按 Docker 的实际情况修正
		expect((await store.getBinding("ses_kept"))?.state).toBe("stopped");
	});

	it("removes managed sandboxes that have no binding", async () => {
		const { store, provider, run } = await setUp();
		const bound = await provider.create({ sessionId: "ses_bound", spec: sampleSpec().sandbox });
		const orphan = await provider.create({ sessionId: "ses_orphan", spec: sampleSpec().sandbox });
		await store.createBinding(sampleBinding("ses_bound", { sandboxId: bound.sandboxId }));

		const result = await run();

		expect(result.removedOrphans).toBe(1);
		expect([...provider.containers.keys()]).toEqual([bound.sandboxId]);
		expect(provider.containers.has(orphan.sandboxId)).toBe(false);
	});

	it("destroys sandboxes left in creating and drops their bindings", async () => {
		const { store, provider, run } = await setUp();
		const { sandboxId } = await provider.create({ sessionId: "ses_half", spec: sampleSpec().sandbox });
		await store.createBinding(sampleBinding("ses_half", { sandboxId, state: "creating" }));

		await run();

		expect(provider.containers.has(sandboxId)).toBe(false);
		expect(await store.getBinding("ses_half")).toBeUndefined();
	});

	it("calls no engine method other than resume while reconciling", async () => {
		const { order, stoppedWhileDown, run } = await setUp();
		await stoppedWhileDown();
		order.length = 0;

		await run();

		expect(order.filter((call) => call.startsWith("engine."))).toEqual(["engine.resume"]);
	});

	it("returns an outside-stop note for a binding whose container was stopped while Tether was down", async () => {
		const { store, stoppedWhileDown, run } = await setUp();
		const sessionId = await stoppedWhileDown();

		const result = await run();

		expect(result.notes).toEqual([
			{
				sessionId,
				note: {
					kind: "tether.sandbox",
					data: { state: "stopped", reason: "stopped outside Tether" },
					modelText: NOTES.stoppedOutside,
				},
			},
		]);
		expect((await store.getBinding(sessionId))?.state).toBe("stopped");
		expect((await store.getSession(sessionId))?.status).toBe("idle");
	});

	it("reconciles sandboxes before resuming the engine", async () => {
		const { order, run } = await setUp();

		await run();

		expect(order.indexOf("provider.listManaged")).toBeGreaterThanOrEqual(0);
		expect(order.indexOf("provider.listManaged")).toBeLessThan(order.indexOf("engine.resume"));
	});
});

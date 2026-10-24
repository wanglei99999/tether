import { MemoryAppStore, sampleBinding, sampleSpec } from "@tether/testkit";
import { describe, expect, it } from "vitest";
import { AgentService, BUILTIN_TOOLS, recover, SessionService } from "../src/index.ts";
import { FakeClock, FakeEngine, FakeIds, FakeProvider } from "./fakes.ts";

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
	const provider = new FakeProvider();
	const listManaged = provider.listManaged.bind(provider);
	provider.listManaged = async () => {
		order.push("provider.listManaged");
		return listManaged();
	};
	const agents = new AgentService({ store, clock, ids, catalog: BUILTIN_TOOLS });
	const sessions = new SessionService({ store, engine, agents, clock, ids });
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

	order.length = 0;
	const run = () => recover({ store, engine, provider, sessions, log });
	return { order, store, engine, provider, warnings, halfCreatedSession, run };
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
		await store.putBinding(sampleBinding("ses_kept", { sandboxId, state: "running" }));
		await store.putBinding(sampleBinding("ses_gone", { sandboxId: "sbx_gone", state: "running" }));

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
		await store.putBinding(sampleBinding("ses_bound", { sandboxId: bound.sandboxId }));

		const result = await run();

		expect(result.removedOrphans).toBe(1);
		expect([...provider.containers.keys()]).toEqual([bound.sandboxId]);
		expect(provider.containers.has(orphan.sandboxId)).toBe(false);
	});

	it("destroys sandboxes left in creating and drops their bindings", async () => {
		const { store, provider, run } = await setUp();
		const { sandboxId } = await provider.create({ sessionId: "ses_half", spec: sampleSpec().sandbox });
		await store.putBinding(sampleBinding("ses_half", { sandboxId, state: "creating" }));

		await run();

		expect(provider.containers.has(sandboxId)).toBe(false);
		expect(await store.getBinding("ses_half")).toBeUndefined();
	});

	it("reconciles sandboxes before resuming the engine", async () => {
		const { order, run } = await setUp();

		await run();

		expect(order.indexOf("provider.listManaged")).toBeGreaterThanOrEqual(0);
		expect(order.indexOf("provider.listManaged")).toBeLessThan(order.indexOf("engine.resume"));
	});
});

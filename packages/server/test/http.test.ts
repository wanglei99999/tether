import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
	type AgentEngine,
	AgentService,
	type AppStore,
	BUILTIN_TOOLS,
	type Log,
	SessionService,
	type TetherEvent,
} from "@tether/core";
import { MemoryAppStore, type ScriptStep, sampleSpec } from "@tether/testkit";
import type { Hono } from "hono";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { openPiEngine } from "../src/adapters/engine-pi/index.ts";
import { createHttpApp } from "../src/http/routes.ts";
import { createIds, systemClock } from "../src/ids.ts";
import { FAUX_MODEL, fauxModels } from "./fixtures/faux.ts";

const root = mkdtempSync(join(tmpdir(), "tether-http-"));
const workdir = mkdtempSync(join(root, "work-"));
const engines: AgentEngine[] = [];
let databases = 0;

afterEach(async () => {
	for (const engine of engines.splice(0)) await engine.close();
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

interface Api {
	app: Hono;
	sessions: SessionService;
	warnings: unknown[];
}

/** 真实的 pi 引擎 + faux 模型；bash 在本机临时目录里执行，不需要 Docker。 */
async function makeApi(script: ScriptStep[], options: { token?: string; store?: AppStore } = {}): Promise<Api> {
	const store = options.store ?? new MemoryAppStore();
	const engine = await openPiEngine({
		database: join(root, `engine-${databases++}.sqlite`),
		models: fauxModels(script),
		envFor: async () => new NodeExecutionEnv({ cwd: workdir }),
	});
	engines.push(engine);
	const ids = createIds();
	const agents = new AgentService({ store, clock: systemClock, ids, catalog: BUILTIN_TOOLS });
	const sessions = new SessionService({ store, engine, agents, clock: systemClock, ids });
	const warnings: unknown[] = [];
	const log: Log = { warn: (message, detail) => warnings.push({ message, detail }) };
	const app = createHttpApp({
		agents,
		sessions,
		sandboxes: { status: (id) => store.getBinding(id) },
		log,
		...(options.token !== undefined && { token: options.token }),
	});
	return { app, sessions, warnings };
}

function spec(tools: string[] = []) {
	return { ...sampleSpec(), model: FAUX_MODEL, tools };
}

async function call(app: Hono, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
	const init: RequestInit = { method, headers: { ...headers } };
	if (body !== undefined) {
		init.body = JSON.stringify(body);
		(init.headers as Record<string, string>)["content-type"] = "application/json";
	}
	const response = await app.request(path, init);
	return { status: response.status, body: (await response.json()) as { ok: boolean; data?: any; error?: any } };
}

async function newSession(app: Hono, tools: string[] = []): Promise<string> {
	const created = await call(app, "POST", "/v1/agents", { name: "a", spec: spec(tools) });
	const session = await call(app, "POST", "/v1/sessions", { agentId: created.body.data.agent.id });
	return session.body.data.session.id;
}

function waitFor(sessions: SessionService, id: string, match: (e: TetherEvent) => boolean) {
	return new Promise<{ stop(): Promise<void> }>((resolve) => {
		let found = false;
		const subscription = sessions.subscribe(id, (events) => {
			if (!found && events.some(match)) {
				found = true;
				void subscription.then(resolve);
			}
		});
	});
}

describe("HTTP API", () => {
	it("creates an agent, adds a version and reads both back", async () => {
		const { app } = await makeApi([]);

		const created = await call(app, "POST", "/v1/agents", { name: "reviewer", description: "d", spec: spec() });
		expect(created.status).toBe(200);
		expect(created.body).toMatchObject({ ok: true, data: { agent: { name: "reviewer" }, version: { version: 1 } } });
		const id = created.body.data.agent.id;

		const added = await call(app, "POST", `/v1/agents/${id}/versions`, { spec: spec(["read"]) });
		expect(added.body).toMatchObject({ ok: true, data: { version: { version: 2, spec: { tools: ["read"] } } } });

		const got = await call(app, "GET", `/v1/agents/${id}`);
		expect(got.body.data).toMatchObject({ agent: { id }, latestVersion: { version: 2 } });
		const first = await call(app, "GET", `/v1/agents/${id}/versions/1`);
		expect(first.body.data.version).toMatchObject({ version: 1, spec: { tools: [] } });
		const list = await call(app, "GET", "/v1/agents");
		expect(list.body.data.items.map((a: { id: string }) => a.id)).toEqual([id]);

		const archived = await call(app, "POST", `/v1/agents/${id}/archive`);
		expect(archived.body.data.agent.archivedAt).toEqual(expect.any(String));
	});

	it("rejects an unknown tool with 400 invalid_request", async () => {
		const { app } = await makeApi([]);
		const response = await call(app, "POST", "/v1/agents", { name: "a", spec: spec(["teleport"]) });
		expect(response.status).toBe(400);
		expect(response.body).toEqual({ ok: false, error: { code: "invalid_request", message: expect.stringMatching(/teleport/) } });
	});

	it("rejects a body that is not JSON with 400 invalid_request", async () => {
		const { app } = await makeApi([]);
		const response = await app.request("/v1/agents", { method: "POST", body: "{nope" });
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ ok: false, error: { code: "invalid_request" } });
	});

	it("returns 404 not_found with the envelope for an unknown session", async () => {
		const { app } = await makeApi([]);
		for (const path of ["/v1/sessions/ses_missing", "/v1/sessions/ses_missing/transcript", "/v1/nowhere"]) {
			const response = await call(app, "GET", path);
			expect(response.status).toBe(404);
			expect(response.body).toEqual({ ok: false, error: { code: "not_found", message: expect.any(String) } });
		}
	});

	it("reads a session and its empty sandbox binding", async () => {
		const { app } = await makeApi([]);
		const id = await newSession(app);
		const got = await call(app, "GET", `/v1/sessions/${id}`);
		expect(got.body).toEqual({ ok: true, data: { session: expect.objectContaining({ id, status: "active" }) } });
		const sandbox = await call(app, "GET", `/v1/sessions/${id}/sandbox`);
		expect(sandbox.body).toEqual({ ok: true, data: { binding: null } });
	});

	it("requires requestId on messages", async () => {
		const { app } = await makeApi([]);
		const id = await newSession(app);
		const response = await call(app, "POST", `/v1/sessions/${id}/messages`, { content: "hi" });
		expect(response.status).toBe(400);
		expect(response.body.error).toMatchObject({ code: "invalid_request", message: expect.stringMatching(/requestId/) });
	});

	it("returns the same submissionId for a repeated requestId with different content", async () => {
		const { app } = await makeApi([{ text: "one" }]);
		const id = await newSession(app);

		const first = await call(app, "POST", `/v1/sessions/${id}/messages`, { content: "a", requestId: "r1" });
		expect(first.status).toBe(202);
		const again = await call(app, "POST", `/v1/sessions/${id}/messages`, { content: "b", requestId: "r1" });
		expect(again.status).toBe(202);
		expect(again.body.data.submissionId).toBe(first.body.data.submissionId);

		const transcript = await call(app, "GET", `/v1/sessions/${id}/transcript?limit=50`);
		const users = transcript.body.data.items.filter((e: { role?: string }) => e.role === "user");
		expect(users.map((e: { text: string }) => e.text)).toEqual(["a"]);
	});

	it("returns 409 busy for whenBusy reject while a run is in progress", async () => {
		const { app, sessions } = await makeApi([{ toolCall: { name: "bash", args: { command: "sleep 1" } } }, { text: "done" }]);
		const id = await newSession(app, ["bash"]);
		const started = waitFor(sessions, id, (e) => e.type === "tool_start");

		const first = await call(app, "POST", `/v1/sessions/${id}/messages`, { content: "go", requestId: "a" });
		expect(first.status).toBe(202);
		const subscription = await started;
		try {
			const busy = await call(app, "POST", `/v1/sessions/${id}/messages`, {
				content: "again",
				requestId: "b",
				whenBusy: "reject",
			});
			expect(busy.status).toBe(409);
			expect(busy.body.error.code).toBe("busy");

			const aborted = await call(app, "POST", `/v1/sessions/${id}/abort`);
			expect(aborted.body).toEqual({ ok: true, data: {} });
		} finally {
			await subscription.stop();
		}
	});

	it("pages sessions with limit and after", async () => {
		const { app } = await makeApi([]);
		const ids = [await newSession(app), await newSession(app), await newSession(app)];

		const page1 = await call(app, "GET", "/v1/sessions?limit=2");
		expect(page1.body.data.items.map((s: { id: string }) => s.id)).toEqual([ids[2], ids[1]]);
		expect(page1.body.data.next).toEqual(expect.any(String));
		const page2 = await call(app, "GET", `/v1/sessions?limit=2&after=${page1.body.data.next}`);
		expect(page2.body.data.items.map((s: { id: string }) => s.id)).toEqual([ids[0]]);
		expect(page2.body.data.next).toBeUndefined();

		for (const bad of ["limit=0", "limit=101", "limit=two", "status=sleeping"]) {
			const response = await call(app, "GET", `/v1/sessions?${bad}`);
			expect(response.status, bad).toBe(400);
		}
	});

	it("requires the bearer token when configured, except on health", async () => {
		const { app } = await makeApi([], { token: "secret" });

		expect((await call(app, "GET", "/v1/health")).body).toEqual({ ok: true, data: { status: "ok" } });
		const rejected: Record<string, string>[] = [{}, { authorization: "Bearer wrong" }, { authorization: "secret" }];
		for (const headers of rejected) {
			const response = await call(app, "GET", "/v1/agents", undefined, headers);
			expect(response.status).toBe(401);
			expect(response.body.error.code).toBe("unauthorized");
		}
		const allowed = await call(app, "GET", "/v1/agents", undefined, { authorization: "Bearer secret" });
		expect(allowed.status).toBe(200);
	});

	it("does not leak internal error messages", async () => {
		class BrokenStore extends MemoryAppStore {
			override async listAgents(): Promise<never> {
				throw new Error("SQLITE_IOERR: disk I/O error at /srv/tether/tether.sqlite");
			}
		}
		const { app, warnings } = await makeApi([], { store: new BrokenStore() });

		const response = await call(app, "GET", "/v1/agents");
		expect(response.status).toBe(500);
		expect(response.body).toEqual({ ok: false, error: { code: "internal", message: "internal error" } });
		expect(warnings).toEqual([{ message: expect.any(String), detail: expect.objectContaining({ message: expect.stringMatching(/SQLITE_IOERR/) }) }]);
	});
});

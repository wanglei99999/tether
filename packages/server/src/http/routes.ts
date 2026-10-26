import {
	type AgentService,
	checkSchema,
	type Log,
	type SandboxService,
	type SessionService,
	type SessionStatus,
	TetherError,
} from "@tether/core";
import { createNodeWebSocket, type NodeWebSocket } from "@hono/node-ws";
import { type Context, Hono } from "hono";
import { type TSchema, Type } from "typebox";
import { bearerAuth } from "./auth.ts";
import { fail, failFromError, ok } from "./envelope.ts";
import { eventStream } from "./events.ts";

export interface HttpDeps {
	agents: AgentService;
	sessions: SessionService;
	sandboxes: Pick<SandboxService, "status">;
	log: Log;
	/** 设置后除 /v1/health 外都要 `Authorization: Bearer <token>`。 */
	token?: string;
}

// spec 和 variables 的内容由服务校验（要对照工具目录、版本声明的变量），这里只管外形
const CreateAgentBody = Type.Object({
	name: Type.String(),
	description: Type.Optional(Type.String()),
	spec: Type.Unknown(),
});
const AddVersionBody = Type.Object({ spec: Type.Unknown() });
const CreateSessionBody = Type.Object({
	agentId: Type.String({ minLength: 1 }),
	agentVersion: Type.Optional(Type.Integer({ minimum: 1 })),
	variables: Type.Optional(Type.Unknown()),
});
const SendMessageBody = Type.Object({
	content: Type.String(),
	requestId: Type.String({ minLength: 1 }),
	whenBusy: Type.Optional(Type.Union([Type.Literal("followUp"), Type.Literal("steer"), Type.Literal("reject")])),
});

const SESSION_STATUSES: readonly SessionStatus[] = ["active", "idle", "archived", "failed"];
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

async function body<S extends TSchema>(c: Context, schema: S): Promise<Type.Static<S>> {
	let value: unknown;
	try {
		value = await c.req.json();
	} catch {
		throw new TetherError("invalid_request", "request body must be JSON");
	}
	checkSchema(schema, value, "request body");
	return value as Type.Static<S>;
}

function limitParam(raw: string | undefined): number {
	if (raw === undefined) return DEFAULT_LIMIT;
	const limit = Number(raw);
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
		throw new TetherError("invalid_request", `limit must be an integer from 1 to ${MAX_LIMIT}`);
	}
	return limit;
}

function versionParam(raw: string): number {
	const version = Number(raw);
	if (!Number.isInteger(version) || version < 1) {
		throw new TetherError("invalid_request", "version must be a positive integer");
	}
	return version;
}

function statusParam(raw: string | undefined): SessionStatus | undefined {
	if (raw === undefined) return undefined;
	const status = SESSION_STATUSES.find((s) => s === raw);
	if (!status) throw new TetherError("invalid_request", `status must be one of ${SESSION_STATUSES.join(", ")}`);
	return status;
}

/** 可选字段没有值时整个键都不出现，下游不会收到 `key: undefined`。 */
function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
	return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function agentRoutes(agents: AgentService): Hono {
	const r = new Hono();
	r.post("/", async (c) => ok(c, await agents.create(await body(c, CreateAgentBody))));
	r.get("/", async (c) => ok(c, { items: await agents.list() }));
	r.get("/:id", async (c) => {
		const id = c.req.param("id");
		const agent = await agents.get(id);
		return ok(c, { agent, latestVersion: await agents.getVersion(id) });
	});
	r.post("/:id/versions", async (c) => {
		const { spec } = await body(c, AddVersionBody);
		return ok(c, { version: await agents.addVersion(c.req.param("id"), spec) });
	});
	r.get("/:id/versions/:v", async (c) => {
		const version = await agents.getVersion(c.req.param("id"), versionParam(c.req.param("v")));
		return ok(c, { version });
	});
	r.post("/:id/archive", async (c) => {
		const id = c.req.param("id");
		await agents.archive(id);
		return ok(c, { agent: await agents.get(id) });
	});
	return r;
}

function sessionRoutes(sessions: SessionService, sandboxes: HttpDeps["sandboxes"]): Hono {
	const r = new Hono();
	r.post("/", async (c) => ok(c, { session: await sessions.create(await body(c, CreateSessionBody)) }));
	r.get("/", async (c) => {
		const query = {
			limit: limitParam(c.req.query("limit")),
			...optional("agentId", c.req.query("agentId")),
			...optional("status", statusParam(c.req.query("status"))),
			...optional("after", c.req.query("after")),
		};
		return ok(c, await sessions.list(query));
	});
	r.get("/:id", async (c) => {
		const session = await sessions.get(c.req.param("id"));
		return ok(c, { session, ...optional("sandbox", await sandboxes.status(session.id)) });
	});
	r.post("/:id/messages", async (c) => {
		const input = await body(c, SendMessageBody);
		return ok(c, await sessions.sendMessage(c.req.param("id"), input), 202);
	});
	// 等这次提交结束才返回（已经结束的立即返回）：事件流断线期间结束的运行靠它补上结果
	r.get("/:id/submissions/:submissionId", async (c) =>
		ok(c, await sessions.waitSubmission(c.req.param("id"), c.req.param("submissionId"))),
	);
	r.post("/:id/abort", async (c) => {
		await sessions.abort(c.req.param("id"));
		return ok(c, {});
	});
	r.post("/:id/archive", async (c) => ok(c, { session: await sessions.archive(c.req.param("id")) }));
	r.get("/:id/transcript", async (c) => {
		const page = { limit: limitParam(c.req.query("limit")), ...optional("before", c.req.query("before")) };
		return ok(c, await sessions.transcript(c.req.param("id"), page));
	});
	r.get("/:id/sandbox", async (c) => {
		const session = await sessions.get(c.req.param("id"));
		return ok(c, { binding: (await sandboxes.status(session.id)) ?? null });
	});
	return r;
}

export interface HttpApp {
	app: Hono;
	/** 监听之后调用一次，把 WebSocket 升级挂到 Node 的 HTTP 服务器上。 */
	injectWebSocket: NodeWebSocket["injectWebSocket"];
	/**
	 * 以 1001（服务端下线）关闭所有事件流。升级后的连接不归 HTTP 服务器管，
	 * 不关掉的话 `server.close()` 会一直等下去；客户端收到 1001 会自动重连。
	 */
	closeEventStreams(): void;
}

/** `/v1` 下的全部路由，响应统一用 `{ ok, data }` / `{ ok, error }` 信封；事件流走 WebSocket。 */
export function createHttpApp(deps: HttpDeps): HttpApp {
	const app = new Hono();
	const { upgradeWebSocket, injectWebSocket, wss } = createNodeWebSocket({ app });
	if (deps.token !== undefined) app.use("*", bearerAuth(deps.token));

	app.get("/v1/health", (c) => ok(c, { status: "ok" }));
	app.get("/v1/sessions/:id/events", eventStream(deps, upgradeWebSocket));
	app.route("/v1/agents", agentRoutes(deps.agents));
	app.route("/v1/sessions", sessionRoutes(deps.sessions, deps.sandboxes));

	app.notFound((c) => fail(c, "not_found", `no route for ${c.req.method} ${c.req.path}`));
	app.onError((error, c) => failFromError(c, error, deps.log));
	const closeEventStreams = () => {
		for (const client of wss.clients) client.close(1001, "server shutting down");
	};
	return { app, injectWebSocket, closeEventStreams };
}

import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { type AgentEngine, AgentService, type AppStore, BUILTIN_TOOLS, type Log, SessionService } from "@tether/core";
import { MemoryAppStore, type ScriptStep, sampleSpec } from "@tether/testkit";
import type { Hono } from "hono";
import { openPiEngine } from "../../src/adapters/engine-pi/index.ts";
import { createHttpApp, type HttpApp } from "../../src/http/routes.ts";
import { createIds, systemClock } from "../../src/ids.ts";
import { FAUX_MODEL, fauxModels } from "./faux.ts";

export interface TestApi extends HttpApp {
	sessions: SessionService;
	warnings: unknown[];
	close(): Promise<void>;
}

export interface TestApiOptions {
	token?: string;
	store?: AppStore;
	/** 包一层引擎，比如数订阅被停了几次。 */
	wrapEngine?: (engine: AgentEngine) => AgentEngine;
}

/** HTTP 层测试用：内存存储 + 真实的 pi 引擎 + faux 模型；bash 在本机临时目录里执行，不需要 Docker。 */
export async function makeApi(script: ScriptStep[], options: TestApiOptions = {}): Promise<TestApi> {
	const root = mkdtempSync(join(tmpdir(), "tether-api-"));
	const store = options.store ?? new MemoryAppStore();
	const opened = await openPiEngine({
		database: join(root, "engine.sqlite"),
		models: fauxModels(script),
		envFor: async () => new NodeExecutionEnv({ cwd: root }),
	});
	const engine = options.wrapEngine ? options.wrapEngine(opened) : opened;
	const ids = createIds();
	const agents = new AgentService({ store, clock: systemClock, ids, catalog: BUILTIN_TOOLS });
	// 这里没有沙箱：归档只把绑定（如果测试放了一条）标成 destroyed
	const sandboxes = {
		destroy: async (id: string) => {
			if ((await store.getBinding(id)) !== undefined) await store.updateBinding(id, { state: "destroyed" });
		},
	};
	const sessions = new SessionService({ store, engine, agents, sandboxes, clock: systemClock, ids });
	const warnings: unknown[] = [];
	const log: Log = { warn: (message, detail) => warnings.push({ message, detail }) };
	const http = createHttpApp({
		agents,
		sessions,
		sandboxes: { status: (id) => store.getBinding(id) },
		log,
		...(options.token !== undefined && { token: options.token }),
	});
	return {
		...http,
		sessions,
		warnings,
		close: async () => {
			await opened.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** 真实监听一个随机端口，返回 `ws://` 地址的前缀。 */
export async function listen(api: HttpApp): Promise<{ base: string; close(): Promise<void> }> {
	return new Promise((resolve) => {
		const server = serve({ fetch: api.app.fetch, hostname: "127.0.0.1", port: 0 }, (info: AddressInfo) => {
			resolve({
				base: `ws://127.0.0.1:${info.port}`,
				close: () =>
					new Promise<void>((done) => {
						server.close(() => done());
						// 还连着的 WebSocket 不会自己断，不关掉 close 回调永远不来
						if ("closeAllConnections" in server) server.closeAllConnections();
					}),
			});
		});
		api.injectWebSocket(server);
	});
}

export function agentSpec(tools: string[] = []) {
	return { ...sampleSpec(), model: FAUX_MODEL, tools };
}

export interface CallResult {
	status: number;
	/** 测试里按路由逐个断言响应的形状，所以不细分类型。 */
	body: { ok: boolean; data?: any; error?: any };
}

/** 不开端口，直接把请求交给 Hono。 */
export async function call(
	app: Hono,
	method: string,
	path: string,
	body?: unknown,
	headers: Record<string, string> = {},
): Promise<CallResult> {
	const all = { ...headers, ...(body !== undefined && { "content-type": "application/json" }) };
	const init: RequestInit = { method, headers: all, ...(body !== undefined && { body: JSON.stringify(body) }) };
	const response = await app.request(path, init);
	return { status: response.status, body: (await response.json()) as CallResult["body"] };
}

export async function newSession(
	app: Hono,
	tools: string[] = [],
	headers: Record<string, string> = {},
): Promise<string> {
	const created = await call(app, "POST", "/v1/agents", { name: "a", spec: agentSpec(tools) }, headers);
	const session = await call(app, "POST", "/v1/sessions", { agentId: created.body.data.agent.id }, headers);
	return session.body.data.session.id;
}

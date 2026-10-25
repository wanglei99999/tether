import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Models } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
	type AgentEngine,
	AgentService,
	type AppStore,
	BUILTIN_TOOLS,
	type Log,
	recover,
	SandboxService,
	SessionService,
	WORKSPACE,
} from "@tether/core";
import { openPiEngine } from "./adapters/engine-pi/index.ts";
import { createPiEnvExecChannel } from "./adapters/exec-pienv/index.ts";
import { createDockerSandboxProvider } from "./adapters/sandbox-docker/index.ts";
import { openSqliteAppStore } from "./adapters/store-sqlite/index.ts";
import type { Config } from "./config.ts";
import { createHttpApp, type HttpApp } from "./http/routes.ts";
import { createIds, systemClock } from "./ids.ts";

export interface TetherServices {
	store: AppStore;
	engine: AgentEngine;
	agents: AgentService;
	sessions: SessionService;
	sandboxes: SandboxService;
}

export interface Tether extends HttpApp {
	services: TetherServices;
	close(): Promise<void>;
}

export interface TetherOverrides {
	models?: Models;
	log?: Log;
}

/** 凭据从环境变量读（ANTHROPIC_API_KEY、OPENAI_API_KEY）。 */
function defaultModels(): Models {
	const models = createModels();
	models.setProvider(anthropicProvider());
	models.setProvider(openaiProvider());
	return models;
}

const stderrLog: Log = {
	warn(message, detail) {
		const extra = detail instanceof Error ? detail.message : detail;
		process.stderr.write(`${JSON.stringify({ level: "warn", message, ...(extra === undefined ? {} : { detail: extra }) })}\n`);
	},
};

function hostUser(): string {
	const uid = process.getuid?.();
	const gid = process.getgid?.();
	if (uid === undefined || gid === undefined) throw new Error("Tether runs sandboxes on a POSIX host only");
	return `${uid}:${gid}`;
}

/**
 * 组装根：打开存储、适配器和服务，按设计文档 §4.5 的顺序恢复，最后返回。HTTP 由调用方监听。
 * 引擎和沙箱服务互相需要对方（工具调用要沙箱，沙箱状态要写进引擎日志），用闭包延后取引用。
 */
export async function createTether(config: Config, overrides: TetherOverrides = {}): Promise<Tether> {
	const log = overrides.log ?? stderrLog;
	await mkdir(config.workspaceRoot, { recursive: true });

	const { store, close: closeStore } = await openSqliteAppStore(join(config.dataDir, "tether.sqlite"));
	const provider = createDockerSandboxProvider({
		workspaceRoot: config.workspaceRoot,
		user: hostUser(),
		defaultImage: config.sandboxImage,
	});
	const exec = createPiEnvExecChannel({ daemonCommand: (id, epoch) => provider.daemonCommand(id, epoch) });

	let engine: AgentEngine | undefined;
	const sandboxes = new SandboxService({
		store,
		provider,
		exec,
		clock: systemClock,
		record: async (sessionId, data) => {
			const session = await store.getSession(sessionId);
			if (engine && session?.engineSessionId) {
				await engine.appendEntry(session.engineSessionId, { kind: "tether.sandbox", data });
			}
		},
	});

	const opened = await openPiEngine({
		database: join(config.dataDir, "engine.sqlite"),
		models: overrides.models ?? defaultModels(),
		// 工具调用时才建容器：按引擎会话找到 Tether 会话，确保沙箱，再给 pi 的工具一个执行环境
		envFor: async (engineSessionId) => {
			const session = await store.getSessionByEngineId(engineSessionId);
			if (!session) return undefined;
			const binding = await sandboxes.ensureSandbox(session.id);
			return exec.piEnv(binding, WORKSPACE);
		},
		onError: (error) => log.warn("engine reported an error", error),
	});
	engine = opened;

	const ids = createIds();
	const agents = new AgentService({ store, clock: systemClock, ids, catalog: BUILTIN_TOOLS });
	const sessions = new SessionService({ store, engine: opened, agents, clock: systemClock, ids });

	try {
		await recover({ store, engine: opened, provider, sessions, log });
	} catch (error) {
		await opened.close();
		exec.closeAll();
		await closeStore();
		throw error;
	}

	const http = createHttpApp({
		agents,
		sessions,
		sandboxes,
		log,
		...(config.token !== undefined && { token: config.token }),
	});
	return {
		...http,
		services: { store, engine: opened, agents, sessions, sandboxes },
		close: async () => {
			http.closeEventStreams();
			await opened.close();
			exec.closeAll();
			await closeStore();
		},
	};
}

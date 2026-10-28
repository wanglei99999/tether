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
	CheckpointService,
	type Log,
	recover,
	type SandboxRecord,
	SandboxService,
	SessionService,
	startSweeper,
	TetherError,
	UNSUPPORTED_IN_M3,
	WORKSPACE,
} from "@tether/core";
import { openPiEngine } from "./adapters/engine-pi/index.ts";
import { createPiEnvExecChannel, lazyEnv } from "./adapters/exec-pienv/index.ts";
import { createDockerSandboxProvider, MIN_DISK_MB, probeWorkspaceStorage } from "./adapters/sandbox-docker/index.ts";
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

/**
 * 工作区的存法（ADR-011）：auto 时能 reflink 就用镜像，否则退回目录并告警；
 * 显式要 image 却不支持 reflink 时不启动，免得悄悄用上没有磁盘上限、存档又慢的目录模式。
 */
async function chooseStorage(config: Config, log: Log): Promise<"image" | "directory"> {
	if (config.workspaceStorage === "directory") return "directory";
	const probed = await probeWorkspaceStorage(config.workspaceRoot, config.checkpointRoot);
	if (probed === "image") return "image";
	if (config.workspaceStorage === "image") {
		throw new TetherError(
			"invalid_request",
			`TETHER_WORKSPACE_STORAGE=image needs ${config.workspaceRoot} and ${config.checkpointRoot} on one filesystem with reflink (for example XFS with reflink=1)`,
		);
	}
	log.warn(
		`${config.workspaceRoot} does not support reflink; using directory workspaces (no disk limit, slow checkpoints). Put the data directory on XFS with reflink=1 to use workspace images.`,
	);
	return "directory";
}

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
	await mkdir(config.checkpointRoot, { recursive: true });

	const storage = await chooseStorage(config, log);
	const { store, close: closeStore } = await openSqliteAppStore(join(config.dataDir, "tether.sqlite"));
	const provider = createDockerSandboxProvider({
		workspaceRoot: config.workspaceRoot,
		user: hostUser(),
		defaultImage: config.sandboxImage,
		storage,
		defaultDiskMb: config.defaultDiskMb,
		checkpointRoot: config.checkpointRoot,
		...(config.sandboxRuntime !== undefined && { runtime: config.sandboxRuntime }),
	});
	// 每次启动 daemon 前先隔离旧的（ADR-007）。sandboxes 在下面才建好，回调只在运行时调用。
	const exec = createPiEnvExecChannel({ connect: (binding) => sandboxes.connect(binding.sessionId) });

	let engine: AgentEngine | undefined;
	const record: SandboxRecord = async (sessionId, { kind, data, modelText }) => {
		const session = await store.getSession(sessionId);
		if (engine && session?.engineSessionId) {
			await engine.appendEntry(session.engineSessionId, {
				kind,
				data,
				...(modelText !== undefined && { modelText }),
			});
		}
	};
	const sandboxes: SandboxService = new SandboxService({
		store,
		provider,
		exec,
		engine: {
			isRunning: (engineSessionId) => {
				if (!engine) throw new TetherError("internal", "the engine is not open yet");
				return engine.isRunning(engineSessionId);
			},
		},
		clock: systemClock,
		setupTimeoutMs: config.setupTimeoutMs,
		maxRunning: config.maxRunningSandboxes,
		stopAfterMs: config.stopAfterMs,
		log,
		record,
	});
	const ids = createIds();
	const checkpoints = new CheckpointService({
		store,
		sandboxes,
		provider,
		engine: {
			submissionEntry: (submissionId) => {
				if (!engine) throw new TetherError("internal", "the engine is not open yet");
				return engine.submissionEntry(submissionId);
			},
		},
		clock: systemClock,
		ids,
		record,
		log,
	});

	const opened = await openPiEngine({
		database: join(config.dataDir, "engine.sqlite"),
		models: overrides.models ?? defaultModels(),
		// pi 每一轮都会要环境，但只有工具真正用到它时才建容器（spec §4 懒创建）：
		// 按引擎会话找到 Tether 会话，返回懒环境；第一次调用方法时确保沙箱，再接到 daemon 上
		envFor: async (engineSessionId) => {
			const session = await store.getSessionByEngineId(engineSessionId);
			if (!session) return undefined;
			return lazyEnv({
				id: `tether:${session.id}`,
				cwd: WORKSPACE,
				resolve: async () => exec.piEnv(await sandboxes.ensureSandbox(session.id), WORKSPACE),
			});
		},
		// 每轮第一次请求模型之前存档（spec §8.3）；存档失败只记日志，这一轮照常
		onRunStart: async (engineSessionId, submissionId) => {
			const session = await store.getSessionByEngineId(engineSessionId);
			if (session) await checkpoints.onRunStart(session.id, submissionId);
		},
		onError: (error) => log.warn("engine reported an error", error),
	});
	engine = opened;

	// 目录模式限制不了磁盘，填了 diskMb 就拒绝，不悄悄忽略
	const unsupported = { ...UNSUPPORTED_IN_M3, diskMb: storage === "directory", minDiskMb: MIN_DISK_MB };
	const agents = new AgentService({ store, clock: systemClock, ids, catalog: BUILTIN_TOOLS, unsupported });
	const sessions = new SessionService({ store, engine: opened, agents, sandboxes, clock: systemClock, ids });

	let recovered: Awaited<ReturnType<typeof recover>>;
	try {
		recovered = await recover({ store, engine: opened, provider, sessions, log });
	} catch (error) {
		await opened.close();
		exec.closeAll();
		await closeStore();
		throw error;
	}
	// resume 之后才写：在 resume 之前写引擎条目会让 pi 提前续跑。写不进去只少一条说明，不影响启动
	for (const { sessionId, note } of recovered.notes) {
		await record(sessionId, note).catch((error: unknown) =>
			log.warn(`recording the startup note for session ${sessionId} failed`, error),
		);
	}
	const sweeper = startSweeper(() => sandboxes.sweep(), config.sweepIntervalMs, log);

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
			// 先停巡检并等进行中的那次结束，它会用到下面要关的引擎、通道和存储
			await sweeper.stop();
			http.closeEventStreams();
			await opened.close();
			exec.closeAll();
			await closeStore();
		},
	};
}

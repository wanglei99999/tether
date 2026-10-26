import { TetherError } from "../errors.ts";
import type { TetherEvent, TranscriptEntry } from "../events.ts";
import type { SessionRecord } from "../model.ts";
import type { AgentEngine, AppStore, Clock, Ids } from "../ports.ts";
import { validateSessionVariables } from "../validate.ts";
import { type AgentService, LOCAL_OWNER } from "./agents.ts";
import { WORKSPACE } from "./sandboxes.ts";

export interface SessionServiceDeps {
	store: AppStore;
	engine: AgentEngine;
	agents: AgentService;
	clock: Clock;
	ids: Ids;
}

export class SessionService {
	readonly #deps: SessionServiceDeps;

	constructor(deps: SessionServiceDeps) {
		this.#deps = deps;
	}

	/**
	 * 先写应用表，再建引擎会话，最后回填引擎 ID（设计文档 §5）。
	 * 引擎失败时记录留着、engineSessionId 为 null，启动修复会找到它。
	 */
	async create(input: { agentId: string; agentVersion?: number; variables?: unknown }): Promise<SessionRecord> {
		const { store, agents, clock, ids } = this.#deps;
		const agent = await agents.get(input.agentId);
		if (agent.archivedAt !== undefined) throw new TetherError("conflict", `agent ${agent.id} is archived`);
		const version = await agents.getVersion(agent.id, input.agentVersion);
		const variables = validateSessionVariables(input.variables, version.spec.sandbox.variables);

		const at = clock.now();
		const session: SessionRecord = {
			id: ids.next("ses"),
			ownerId: LOCAL_OWNER,
			agentId: agent.id,
			agentVersion: version.version,
			engineSessionId: null,
			parentSessionId: null,
			forkedFrom: null,
			variables,
			status: "active",
			createdAt: at,
			lastActiveAt: at,
		};
		await store.createSession(session);
		return { ...session, engineSessionId: await this.attachEngine(session) };
	}

	/** 按会话固定的版本建引擎会话并回填 ID。create 和启动修复共用。 */
	async attachEngine(session: SessionRecord): Promise<string> {
		const { store, engine, agents } = this.#deps;
		const version = await agents.getVersion(session.agentId, session.agentVersion);
		let engineSessionId: string;
		try {
			const { model, instructions, tools } = version.spec;
			engineSessionId = await engine.createSession({ model, instructions, tools, cwd: WORKSPACE });
		} catch (error) {
			throw new TetherError("engine_failed", `cannot create the engine session for ${session.id}`, {
				cause: error instanceof Error ? error.message : String(error),
			});
		}
		await store.setEngineSessionId(session.id, engineSessionId);
		return engineSessionId;
	}

	async get(id: string): Promise<SessionRecord> {
		const session = await this.#deps.store.getSession(id);
		if (!session) throw new TetherError("not_found", `session ${id} not found`);
		return session;
	}

	list(query: Parameters<AppStore["listSessions"]>[0]): ReturnType<AppStore["listSessions"]> {
		return this.#deps.store.listSessions(query);
	}

	async sendMessage(
		id: string,
		input: { content: string; requestId: string; whenBusy?: "followUp" | "steer" | "reject" },
	): Promise<{ submissionId: string }> {
		const session = await this.get(id);
		if (session.status === "archived") throw new TetherError("conflict", `session ${id} is archived`);
		// 沙箱闲置停止后会话是 idle；有新消息就回到 active，沙箱等下次工具调用再启动
		if (session.status === "idle") await this.#deps.store.updateSession(id, { status: "active" });
		const result = await this.#deps.engine.submit(this.#engineId(session), input);
		await this.#deps.store.updateSession(id, { lastActiveAt: this.#deps.clock.now() });
		return result;
	}

	/** 等一次提交结束；已经结束的立即返回。客户端断线重连后用它确认错过的运行结果。 */
	async waitSubmission(id: string, submissionId: string): ReturnType<AgentEngine["waitSubmission"]> {
		await this.get(id);
		return this.#deps.engine.waitSubmission(submissionId);
	}

	async abort(id: string): Promise<void> {
		await this.#deps.engine.abort(this.#engineId(await this.get(id)));
	}

	async transcript(
		id: string,
		page: { limit: number; before?: string },
	): Promise<{ items: TranscriptEntry[]; next?: string }> {
		return this.#deps.engine.transcript(this.#engineId(await this.get(id)), page);
	}

	async subscribe(id: string, listener: (events: TetherEvent[]) => void): Promise<{ stop(): Promise<void> }> {
		return this.#deps.engine.subscribe(this.#engineId(await this.get(id)), listener);
	}

	#engineId(session: SessionRecord): string {
		if (session.engineSessionId === null) {
			throw new TetherError("conflict", `session ${session.id} has no engine session yet`);
		}
		return session.engineSessionId;
	}
}

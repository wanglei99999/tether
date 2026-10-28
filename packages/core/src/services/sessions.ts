import {
	alignedEntry,
	findCheckpoint,
	missedCalls,
	type ReadEntries,
	readEntries,
	sideEffectCalls,
} from "../checkpoints.ts";
import { TetherError } from "../errors.ts";
import type { TetherEvent, TranscriptEntry } from "../events.ts";
import type { CheckpointRecord, SessionRecord } from "../model.ts";
import { NOTES, type SandboxNote } from "../notes.ts";
import type { AgentEngine, AppStore, Clock, Ids } from "../ports.ts";
import { validateSessionVariables } from "../validate.ts";
import { type AgentService, LOCAL_OWNER } from "./agents.ts";
import type { CheckpointService } from "./checkpoints.ts";
import { type SandboxService, WORKSPACE } from "./sandboxes.ts";

export interface SessionServiceDeps {
	store: AppStore;
	engine: AgentEngine;
	agents: AgentService;
	/** 归档时销毁会话的沙箱。 */
	sandboxes: Pick<SandboxService, "destroy">;
	/** 归档时清理会话的存档；不给就不清理（只有组装层需要）。 */
	checkpoints?: Pick<CheckpointService, "collect">;
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
		const { store, agents } = this.#deps;
		const agent = await agents.get(input.agentId);
		if (agent.archivedAt !== undefined) throw new TetherError("conflict", `agent ${agent.id} is archived`);
		const version = await agents.getVersion(agent.id, input.agentVersion);
		const variables = validateSessionVariables(input.variables, version.spec.sandbox.variables);

		const session = this.#newSession(agent.id, version.version, variables, null);
		await store.createSession(session);
		return { ...session, engineSessionId: await this.attachEngine(session) };
	}

	/**
	 * 在源会话的条目处分叉（spec §8.3）：同一个版本、同样的变量，对话到这一条为止；工作区取自选中的存档，
	 * 沙箱等第一次工具调用时再从存档建。和 create 一样先写应用表再分叉引擎，半成品由启动修复补上。
	 */
	async fork(id: string, entryId: string): Promise<SessionRecord> {
		const { store, engine } = this.#deps;
		const source = await this.get(id);
		if (source.status === "archived") throw new TetherError("conflict", `session ${id} is archived`);
		await this.#requireEntry(source, entryId);

		const checkpoint = await findCheckpoint(store, id, entryId, this.#reader());
		const session = this.#newSession(source.agentId, source.agentVersion, source.variables, {
			sessionId: id,
			entryId,
			checkpointId: checkpoint?.id ?? null,
		});
		await store.createSession(session);
		const forked = { ...session, engineSessionId: await this.attachEngine(session) };
		const { kind, data, modelText } = await this.forkNote(forked);
		await engine.appendEntry(forked.engineSessionId, { kind, data, ...(modelText !== undefined && { modelText }) });
		return forked;
	}

	/**
	 * 分叉会话写给模型的说明：存档对得上就说工作区已还原；存档早于分叉点，再列出中间没有发生的操作；
	 * 没有存档（或已经被清理）就说工作区是模板。fork 和启动修复共用，会话要已经有引擎会话。
	 */
	async forkNote(session: SessionRecord): Promise<SandboxNote> {
		const { store, engine } = this.#deps;
		const origin = session.forkedFrom;
		if (origin === null || session.engineSessionId === null) {
			throw new TetherError("internal", `session ${session.id} is not a fork with an engine session`);
		}
		const checkpoint = origin.checkpointId === null ? undefined : await store.getCheckpoint(origin.checkpointId);
		const data = { sessionId: origin.sessionId, entryId: origin.entryId, checkpointId: origin.checkpointId };
		if (checkpoint === undefined) return { kind: "tether.fork", data: { ...data, missed: 0 }, modelText: NOTES.forkFresh };

		// 分叉会话的记录到分叉点为止和源会话一样，从它读
		const from = await alignedEntry(store, origin.sessionId, origin.entryId, checkpoint);
		const entries = await readEntries(engine, session.engineSessionId, from, origin.entryId);
		return {
			kind: "tether.fork",
			data: { ...data, missed: sideEffectCalls(entries, from, origin.entryId).length },
			modelText: NOTES.forked(missedCalls(entries, from, origin.entryId)),
		};
	}

	/** 会话的存档，从旧到新。 */
	async checkpoints(id: string): Promise<CheckpointRecord[]> {
		await this.get(id);
		return this.#deps.store.listCheckpoints(id);
	}

	/**
	 * 给会话建引擎会话并回填 ID：普通会话按固定的版本新建，分叉会话在来源会话的条目处分叉。
	 * create、fork 和启动修复共用。
	 */
	async attachEngine(session: SessionRecord): Promise<string> {
		const { store, engine, agents } = this.#deps;
		const version = await agents.getVersion(session.agentId, session.agentVersion);
		let engineSessionId: string;
		try {
			if (session.forkedFrom === null) {
				const { model, instructions, tools } = version.spec;
				engineSessionId = await engine.createSession({ model, instructions, tools, cwd: WORKSPACE });
			} else {
				const source = await store.getSession(session.forkedFrom.sessionId);
				if (!source?.engineSessionId) throw new Error(`source session ${session.forkedFrom.sessionId} has no engine session`);
				engineSessionId = await engine.fork(source.engineSessionId, session.forkedFrom.entryId);
			}
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

	/**
	 * 归档：先改状态（之后的消息被拒绝），再中止正在跑的一轮，然后销毁沙箱，最后清理没被分叉引用的存档。
	 * 对已归档的会话再调用一次也会执行销毁和清理，上次失败可以这样重试。
	 */
	async archive(id: string): Promise<SessionRecord> {
		const { store, engine, sandboxes } = this.#deps;
		const session = await this.get(id);
		if (session.status !== "archived") await store.updateSession(id, { status: "archived" });
		if (session.engineSessionId !== null) await engine.abort(session.engineSessionId);
		await sandboxes.destroy(id, "archived");
		await this.#deps.checkpoints?.collect(id);
		return this.get(id);
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

	#newSession(
		agentId: string,
		agentVersion: number,
		variables: Record<string, string>,
		forkedFrom: SessionRecord["forkedFrom"],
	): SessionRecord {
		const at = this.#deps.clock.now();
		return {
			id: this.#deps.ids.next("ses"),
			ownerId: LOCAL_OWNER,
			agentId,
			agentVersion,
			engineSessionId: null,
			parentSessionId: null,
			forkedFrom,
			variables: { ...variables },
			status: "active",
			createdAt: at,
			lastActiveAt: at,
		};
	}

	/** 分叉点必须是源会话记录里的一条：先查，免得写下一条引擎分叉不了的会话记录。 */
	async #requireEntry(source: SessionRecord, entryId: string): Promise<void> {
		const invalid = new TetherError("invalid_request", `entry ${entryId} is not in session ${source.id}`);
		if (!/^[1-9][0-9]*$/.test(entryId)) throw invalid;
		const { items } = await this.#deps.engine.transcript(this.#engineId(source), {
			limit: 1,
			before: String(Number(entryId) + 1),
		});
		if (items[0]?.id !== entryId) throw invalid;
	}

	/** 按会话读引擎记录，findCheckpoint 沿分叉链判断两张存档之间有没有改过工作区。 */
	#reader(): ReadEntries {
		return async (sessionId, after, upto) => {
			const session = await this.get(sessionId);
			return readEntries(this.#deps.engine, this.#engineId(session), after, upto);
		};
	}

	#engineId(session: SessionRecord): string {
		if (session.engineSessionId === null) {
			throw new TetherError("conflict", `session ${session.id} has no engine session yet`);
		}
		return session.engineSessionId;
	}
}

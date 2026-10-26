import type { TetherEnv } from "./env.ts";
import type { TetherEvent, TranscriptEntry } from "./events.ts";
import type {
	AgentRecord,
	AgentVersionRecord,
	AgentVersionSpec,
	BindingPatch,
	ExpectedState,
	ModelRef,
	SandboxBinding,
	SandboxSpec,
	SessionRecord,
} from "./model.ts";

/** Tether 自己的表：agent、版本、会话、沙箱绑定。对话内容不在这里，在引擎那边。 */
export interface AppStore {
	createAgent(agent: AgentRecord, first: AgentVersionRecord): Promise<void>;
	getAgent(id: string): Promise<AgentRecord | undefined>;
	listAgents(): Promise<AgentRecord[]>;
	archiveAgent(id: string, at: string): Promise<void>;
	/** 版本号 = 当前最大 + 1，在事务内完成。 */
	addVersion(agentId: string, spec: AgentVersionSpec, at: string): Promise<AgentVersionRecord>;
	/** 省略 version 时取最新版本。 */
	getVersion(agentId: string, version?: number): Promise<AgentVersionRecord | undefined>;

	createSession(session: SessionRecord): Promise<void>;
	setEngineSessionId(sessionId: string, engineSessionId: string): Promise<void>;
	getSession(id: string): Promise<SessionRecord | undefined>;
	getSessionByEngineId(engineSessionId: string): Promise<SessionRecord | undefined>;
	listSessions(query: {
		agentId?: string;
		status?: SessionRecord["status"];
		limit: number;
		after?: string;
	}): Promise<{ items: SessionRecord[]; next?: string }>;
	/** 启动修复用：应用表写了、引擎会话还没回填的会话。 */
	sessionsWithoutEngine(): Promise<SessionRecord[]>;
	updateSession(id: string, patch: Partial<Pick<SessionRecord, "status" | "title" | "lastActiveAt">>): Promise<void>;

	getBinding(sessionId: string): Promise<SandboxBinding | undefined>;
	/** 已存在时报 conflict。 */
	createBinding(binding: SandboxBinding): Promise<void>;
	/**
	 * 只改状态和最后使用时间；epoch 只能经 nextEpoch 改变。
	 * 给了 expected 时，当前状态不在其中就报 conflict，不写入。返回写入后的绑定。
	 */
	updateBinding(
		sessionId: string,
		patch: BindingPatch,
		expected?: ExpectedState,
	): Promise<SandboxBinding>;
	/** epoch 原子地加一，返回新值。 */
	nextEpoch(sessionId: string): Promise<number>;
	deleteBinding(sessionId: string): Promise<void>;
	listBindings(): Promise<SandboxBinding[]>;
}

/** 创建引擎会话时交给引擎的配置，由 agent 版本翻译而来。 */
export interface EngineAgentConfig {
	model: ModelRef;
	instructions: string;
	tools: string[];
	cwd: string;
}

export interface AgentEngine {
	/** 返回引擎会话 ID。 */
	createSession(config: EngineAgentConfig): Promise<string>;
	hasSession(engineSessionId: string): Promise<boolean>;
	submit(
		engineSessionId: string,
		input: { content: string; requestId: string; whenBusy?: "followUp" | "steer" | "reject" },
	): Promise<{ submissionId: string }>;
	waitSubmission(submissionId: string): Promise<{ status: "done" | "unanswered"; answer?: TranscriptEntry }>;
	abort(engineSessionId: string): Promise<void>;
	/** 是否有一轮正在运行，与 SessionView.running 同一来源。未知会话报 not_found。 */
	isRunning(engineSessionId: string): Promise<boolean>;
	/** 新的在前。 */
	transcript(
		engineSessionId: string,
		page: { limit: number; before?: string },
	): Promise<{ items: TranscriptEntry[]; next?: string }>;
	/** 写一条 Tether 自己的条目进引擎日志（ADR-005）；带 modelText 时模型也看得到。 */
	appendEntry(
		engineSessionId: string,
		entry: { kind: `tether.${string}`; data: unknown; modelText?: string },
	): Promise<void>;
	/** 第一批事件是 snapshot。 */
	subscribe(engineSessionId: string, listener: (events: TetherEvent[]) => void): Promise<{ stop(): Promise<void> }>;
	/** 启动修复完成后调用，继续跑崩溃前未完成的提交。 */
	resume(): void;
	close(): Promise<void>;
}

export interface SandboxCreate {
	sessionId: string;
	spec: SandboxSpec;
}

/** 只管沙箱的生命周期；文件和命令走 ExecChannel。 */
export interface SandboxProvider {
	readonly name: "docker";
	readonly capabilities: { snapshot: boolean; fork: boolean; rollback: boolean; preservesMemoryOnStop: boolean };
	create(input: SandboxCreate): Promise<{ sandboxId: string }>;
	status(sandboxId: string): Promise<"running" | "stopped" | "missing">;
	start(sandboxId: string): Promise<void>;
	stop(sandboxId: string): Promise<void>;
	/** 同时删除工作区目录；沙箱不存在不报错。 */
	destroy(sandboxId: string): Promise<void>;
	/** Tether 管理的全部沙箱及其状态，一次后端调用（巡检每轮用它和绑定核对）。 */
	listManaged(): Promise<{ sandboxId: string; sessionId: string; status: "running" | "stopped" }[]>;
	/**
	 * 杀掉沙箱里除 init 以外的全部进程（旧 daemon 和它启动的命令），删除 epoch 更小的 daemon 记录（ADR-007）。
	 * 沙箱没有自己的 PID 命名空间、init 不对或执行失败时抛 sandbox_failed。
	 */
	fence(sandboxId: string, epoch: number): Promise<{ killed: number }>;
	/** 在沙箱里启动 daemon 的命令，ExecChannel 用它建立连接。 */
	daemonCommand(sandboxId: string, epoch: number): string[];
}

export interface ExecChannel {
	env(binding: SandboxBinding, options: { cwd: string; shellEnv?: Record<string, string> }): TetherEnv;
	close(sandboxId: string): void;
}

export interface Clock {
	/** ISO 8601。 */
	now(): string;
}

export interface Ids {
	/** 形如 agt_<ULID 或 UUIDv7>，按时间可排序。 */
	next(prefix: "agt" | "ses"): string;
}

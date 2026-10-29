import Type from "typebox";
import { TetherError } from "./errors.ts";

/** 会话变量以环境变量形式交给 setup，名字必须是合法的 shell 标识符。 */
export const VARIABLE_NAME = "^[A-Z_][A-Z0-9_]*$";
/**
 * 镜像引用（`仓库/名字:标签@摘要`）或空字符串。沙箱后端把它放在镜像参数的位置，
 * 以 `-` 开头会被 docker 当成参数（`--privileged`），所以第一个字符必须是字母或数字。
 */
export const IMAGE_REFERENCE = "^$|^[A-Za-z0-9][A-Za-z0-9._/:@-]*$";

export const ModelRef = Type.Object(
	{
		provider: Type.String({ minLength: 1 }),
		modelId: Type.String({ minLength: 1 }),
		thinkingLevel: Type.Optional(
			Type.Union([Type.Literal("off"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
		),
	},
	{ additionalProperties: false },
);
export type ModelRef = Type.Static<typeof ModelRef>;

export const SandboxSpec = Type.Object(
	{
		/** 空字符串表示用服务端配置的默认镜像。 */
		template: Type.String({ pattern: IMAGE_REFERENCE }),
		resources: Type.Object(
			{
				cpu: Type.Number({ exclusiveMinimum: 0 }),
				memoryMb: Type.Integer({ minimum: 64 }),
				diskMb: Type.Optional(Type.Integer({ minimum: 1 })),
			},
			{ additionalProperties: false },
		),
		network: Type.Union([Type.Literal("none"), Type.Literal("egress")]),
		setup: Type.Array(Type.String()),
		variables: Type.Array(Type.String({ pattern: VARIABLE_NAME })),
	},
	{ additionalProperties: false },
);
export type SandboxSpec = Type.Static<typeof SandboxSpec>;

export const AgentVersionSpec = Type.Object(
	{
		model: ModelRef,
		instructions: Type.String(),
		tools: Type.Array(Type.String()),
		sandbox: SandboxSpec,
		checkpointPolicy: Type.Union([Type.Literal("none"), Type.Literal("perRun")]),
		permissions: Type.Object(
			{
				denyTools: Type.Array(Type.String()),
				requireApproval: Type.Array(Type.String()),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
export type AgentVersionSpec = Type.Static<typeof AgentVersionSpec>;

/** 记录里的时间一律是 ISO 8601 字符串。 */
export interface AgentRecord {
	id: string;
	ownerId: string;
	name: string;
	description: string;
	createdAt: string;
	archivedAt?: string;
}

/** 版本不可变：改配置就是新增一个版本。 */
export interface AgentVersionRecord {
	agentId: string;
	version: number;
	spec: AgentVersionSpec;
	createdAt: string;
}

export type SessionStatus = "active" | "idle" | "archived" | "failed";

/** 分叉出来的会话从哪里来。checkpointId 是分叉时选定的存档，没有可用存档时为 null（按模板新建）。 */
export interface ForkOrigin {
	sessionId: string;
	entryId: string;
	checkpointId: string | null;
}

export interface SessionRecord {
	id: string;
	ownerId: string;
	agentId: string;
	agentVersion: number;
	/** 应用表先写、引擎会话后建，所以在回填之前是 null。 */
	engineSessionId: string | null;
	parentSessionId: null;
	forkedFrom: ForkOrigin | null;
	variables: Record<string, string>;
	status: SessionStatus;
	title?: string;
	createdAt: string;
	lastActiveAt: string;
}

export type SandboxState = "creating" | "running" | "stopped" | "lost" | "destroyed";

export interface SandboxBinding {
	sessionId: string;
	provider: "docker";
	sandboxId: string;
	/** 新绑定为 0，每次连接 daemon 前加一（ADR-007）。 */
	epoch: number;
	state: SandboxState;
	template: string;
	createdAt: string;
	lastUsedAt: string;
	/** 为什么变成 lost（例如闲置太久被删除），恢复时写进说明；重建成功后清除。 */
	reason?: string;
}

/** 绑定建好后能改的字段。reason 给 null 表示清除，不给表示不动。 */
export type BindingPatch = Partial<Pick<SandboxBinding, "state" | "lastUsedAt">> & { reason?: string | null };

/** 一张工作区存档（spec §5.3），对齐到触发这一轮的用户条目：内容是这一轮开始之前的工作区。 */
export interface CheckpointRecord {
	id: string;
	sessionId: string;
	/** 触发这一轮的提交；同一个提交至多一张存档。 */
	submissionId: string;
	/** 这一轮的用户条目；引擎条目 ID 是全局递增的整数，比较要按数值。 */
	entryId: string;
	/**
	 * 后端给的快照 ID。null 表示这一轮开始时会话还没有沙箱，工作区就是模板（按模板新建、执行 setup 就能还原）。
	 * 几条记录可以指向同一张快照：沙箱丢失时开始的一轮，指向重建要用的那张。
	 */
	snapshotId: string | null;
	/**
	 * 这条记录沿用了哪条存档的快照（沙箱丢失时开始的一轮、分叉会话的第一轮）：内容是那条存档那一刻的，
	 * 不是这一轮用户条目那一刻的。这种记录只用来挡住同一轮的重复存档，查找存档时跳过，用它指向的那条。
	 */
	basisCheckpointId: string | null;
	/** 这一轮的存档失败了：只用来挡住同一轮后面的调用（免得在半轮的状态上再存），查找存档时跳过。 */
	failed: boolean;
	kind: "filesystem";
	createdAt: string;
}

export interface ExpectedState {
	state: SandboxState | readonly SandboxState[];
}

/** AppStore.updateBinding 的前置检查，各实现共用：当前状态不是期望值时报 conflict。 */
export function assertBindingState(binding: SandboxBinding, expected: ExpectedState | undefined): void {
	if (expected === undefined) return;
	const allowed: readonly SandboxState[] = typeof expected.state === "string" ? [expected.state] : expected.state;
	if (!allowed.includes(binding.state)) {
		throw new TetherError(
			"conflict",
			`sandbox for ${binding.sessionId} is ${binding.state}, expected ${allowed.join(" or ")}`,
		);
	}
}

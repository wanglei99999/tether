import Type from "typebox";

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

export interface SessionRecord {
	id: string;
	ownerId: string;
	agentId: string;
	agentVersion: number;
	/** 应用表先写、引擎会话后建，所以在回填之前是 null。 */
	engineSessionId: string | null;
	parentSessionId: null;
	forkedFrom: null;
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
	/** M1 固定为 1；M2 的隔离每次重连加一。 */
	epoch: number;
	state: SandboxState;
	template: string;
	createdAt: string;
	lastUsedAt: string;
}

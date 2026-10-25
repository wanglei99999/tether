import type { TSchema } from "typebox";
import type { TetherEnv } from "./env.ts";

/** 工具目录里的一项。agent 版本只存工具名，创建版本时按目录校验。 */
export interface ToolDescriptor {
	name: string;
	description: string;
	/** 崩溃续跑时能否重新执行：只读的工具可以，有副作用的不行。 */
	replay: "safe" | "unsafe";
	sideEffects: "none" | "sandbox" | "external";
}

/** Tether 自己的工具接口，第二阶段的自研引擎直接消费它。M1 只定义，不接入。 */
export interface TetherTool extends ToolDescriptor {
	parameters: TSchema;
	execute(args: unknown, env: TetherEnv, signal?: AbortSignal): Promise<{ output: string; isError?: boolean }>;
}

/** M1 只提供这四个内置工具，实现直接用 pi 的版本。 */
export const BUILTIN_TOOLS: readonly ToolDescriptor[] = Object.freeze([
	{ name: "read", description: "Read a file in the workspace.", replay: "safe", sideEffects: "none" },
	{ name: "write", description: "Create or overwrite a file in the workspace.", replay: "unsafe", sideEffects: "sandbox" },
	{ name: "edit", description: "Replace text in a file in the workspace.", replay: "unsafe", sideEffects: "sandbox" },
	{ name: "bash", description: "Run a shell command in the sandbox.", replay: "unsafe", sideEffects: "sandbox" },
]);

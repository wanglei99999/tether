import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { TetherError } from "./errors.ts";
import { AgentVersionSpec } from "./model.ts";
import type { ToolDescriptor } from "./tools.ts";

/** 按 schema 校验，失败时把第一个出错的路径写进消息。 */
export function checkSchema(schema: TSchema, value: unknown, what: string): void {
	if (Value.Check(schema, value)) return;
	const [first] = Value.Errors(schema, value);
	const path = first?.instancePath || "/";
	throw new TetherError("invalid_request", `${what} is invalid at ${path}: ${first?.message ?? "unknown error"}`);
}

/** spec 里已经定义、但还没有实现的配置；为 true 时填了就拒绝，不悄悄忽略。 */
export interface Unsupported {
	/** sandbox.resources.diskMb：只有工作区是镜像文件时才有上限（ADR-011），由组装层按存储模式决定。 */
	diskMb: boolean;
	/** permissions.requireApproval：审批在 M3 之后单独一份计划。 */
	approval: boolean;
	/** checkpointPolicy "perRun"：每轮存档接好之前拒绝。 */
	checkpoints: boolean;
	/** diskMb 的下限：工作区镜像是 XFS，mkfs.xfs 不接受小于 300 MB 的文件系统。 */
	minDiskMb?: number;
}

/** 默认最保守：diskMb 是否支持取决于存储模式，组装层知道后再放开。 */
export const UNSUPPORTED_IN_M3: Unsupported = { diskMb: true, approval: true, checkpoints: true };

export function validateVersionSpec(
	spec: unknown,
	catalog: readonly ToolDescriptor[],
	unsupported: Unsupported = UNSUPPORTED_IN_M3,
): AgentVersionSpec {
	checkSchema(AgentVersionSpec, spec, "agent version spec");
	const typed = spec as AgentVersionSpec;

	const notYet = (field: string) => new TetherError("invalid_request", `${field} is not supported yet`);
	const { diskMb } = typed.sandbox.resources;
	if (unsupported.diskMb && diskMb !== undefined) throw notYet("sandbox.resources.diskMb");
	if (unsupported.minDiskMb !== undefined && diskMb !== undefined && diskMb < unsupported.minDiskMb) {
		throw new TetherError("invalid_request", `sandbox.resources.diskMb must be at least ${unsupported.minDiskMb}`);
	}
	if (unsupported.approval && typed.permissions.requireApproval.length > 0) throw notYet("permissions.requireApproval");
	if (unsupported.checkpoints && typed.checkpointPolicy === "perRun") throw notYet("checkpointPolicy perRun");

	const known = new Set(catalog.map((tool) => tool.name));
	const unknown = typed.tools.filter((name) => !known.has(name));
	if (unknown.length > 0) {
		throw new TetherError("invalid_request", `unknown tools: ${unknown.join(", ")}`);
	}

	const denied = new Set(typed.permissions.denyTools);
	const conflicting = typed.tools.filter((name) => denied.has(name));
	if (conflicting.length > 0) {
		throw new TetherError("invalid_request", `tools both allowed and denied: ${conflicting.join(", ")}`);
	}

	return structuredClone(typed);
}

/** 值原样保留：变量以环境变量传给 setup，不拼进命令，所以不需要也不应该转义。 */
export function validateSessionVariables(values: unknown, declared: readonly string[]): Record<string, string> {
	if (values === undefined) return {};
	if (typeof values !== "object" || values === null || Array.isArray(values)) {
		throw new TetherError("invalid_request", "variables must be an object of strings");
	}

	const allowed = new Set(declared);
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(values)) {
		if (!allowed.has(name)) {
			throw new TetherError("invalid_request", `variable ${name} is not declared by the agent version`);
		}
		if (typeof value !== "string") {
			throw new TetherError("invalid_request", `variable ${name} must be a string`);
		}
		result[name] = value;
	}
	return result;
}

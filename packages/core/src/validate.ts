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

export function validateVersionSpec(spec: unknown, catalog: readonly ToolDescriptor[]): AgentVersionSpec {
	checkSchema(AgentVersionSpec, spec, "agent version spec");
	const typed = spec as AgentVersionSpec;

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

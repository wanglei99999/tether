import { describe, expect, it } from "vitest";
import {
	BUILTIN_TOOLS,
	TetherError,
	validateSessionVariables,
	validateVersionSpec,
	type AgentVersionSpec,
} from "../src/index.ts";

function completeSpec(): AgentVersionSpec {
	return {
		model: { provider: "anthropic", modelId: "claude-sonnet-5-5", thinkingLevel: "low" },
		instructions: "You are a careful engineer.",
		tools: ["read", "bash"],
		sandbox: {
			template: "",
			resources: { cpu: 1, memoryMb: 512 },
			network: "none",
			setup: ['git clone "$REPO_URL" .'],
			variables: ["REPO_URL", "_REF2"],
		},
		checkpointPolicy: "none",
		permissions: { denyTools: [], requireApproval: [] },
	};
}

function rejection(run: () => unknown): TetherError {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(TetherError);
		return error as TetherError;
	}
	throw new Error("expected a TetherError");
}

describe("validateVersionSpec", () => {
	it("accepts a complete spec and returns it typed", () => {
		const spec = completeSpec();
		expect(validateVersionSpec(spec, BUILTIN_TOOLS)).toEqual(spec);
	});

	it("rejects a tool that is not in the catalog", () => {
		const error = rejection(() => validateVersionSpec({ ...completeSpec(), tools: ["read", "teleport"] }, BUILTIN_TOOLS));
		expect(error.code).toBe("invalid_request");
		expect(error.message).toContain("teleport");
	});

	it("rejects a tool listed in both tools and denyTools", () => {
		const spec = { ...completeSpec(), permissions: { denyTools: ["bash"], requireApproval: [] } };
		const error = rejection(() => validateVersionSpec(spec, BUILTIN_TOOLS));
		expect(error.code).toBe("invalid_request");
		expect(error.message).toContain("bash");
	});

	it("rejects variable names that are not shell identifiers", () => {
		for (const name of ["repo_url", "1ABC", "A-B", "A B", ""]) {
			const base = completeSpec();
			const spec = { ...base, sandbox: { ...base.sandbox, variables: [name] } };
			const error = rejection(() => validateVersionSpec(spec, BUILTIN_TOOLS));
			expect(error.code).toBe("invalid_request");
			expect(error.message).toContain("/sandbox/variables/0");
		}
	});

	it("rejects cpu <= 0 and memoryMb < 64", () => {
		const base = completeSpec();
		for (const resources of [
			{ cpu: 0, memoryMb: 512 },
			{ cpu: -1, memoryMb: 512 },
			{ cpu: 1, memoryMb: 63 },
		]) {
			const spec = { ...base, sandbox: { ...base.sandbox, resources } };
			const error = rejection(() => validateVersionSpec(spec, BUILTIN_TOOLS));
			expect(error.code).toBe("invalid_request");
			expect(error.message).toContain("/sandbox/resources");
		}
	});
});

describe("validateSessionVariables", () => {
	it("rejects session variables not declared by the version", () => {
		const error = rejection(() => validateSessionVariables({ REPO_URL: "x", SECRET: "y" }, ["REPO_URL"]));
		expect(error.code).toBe("invalid_request");
		expect(error.message).toContain("SECRET");
	});

	it("rejects non-string variable values", () => {
		for (const value of [1, true, null, { nested: "x" }]) {
			const error = rejection(() => validateSessionVariables({ REPO_URL: value }, ["REPO_URL"]));
			expect(error.code).toBe("invalid_request");
			expect(error.message).toContain("REPO_URL");
		}
	});

	it("keeps variable values verbatim, including shell metacharacters", () => {
		const values = { REPO_URL: "x; touch /workspace/pwned", REF: "$(id) `id` 'q' \"dq\"\n" };
		expect(validateSessionVariables(values, ["REPO_URL", "REF"])).toEqual(values);
	});
});

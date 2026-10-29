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

describe("validateVersionSpec unsupported fields", () => {
	const variants: [string, AgentVersionSpec][] = [
		["sandbox.resources.diskMb", { ...completeSpec(), sandbox: { ...completeSpec().sandbox, resources: { cpu: 1, memoryMb: 512, diskMb: 1024 } } }],
		["permissions.requireApproval", { ...completeSpec(), permissions: { denyTools: [], requireApproval: ["bash"] } }],
		["checkpointPolicy perRun", { ...completeSpec(), checkpointPolicy: "perRun" }],
	];

	it("rejects diskMb, requireApproval and perRun while they are unsupported", () => {
		const unsupported = { diskMb: true, approval: true, checkpoints: true };
		for (const [field, spec] of variants) {
			const error = rejection(() => validateVersionSpec(spec, BUILTIN_TOOLS, unsupported));
			expect(error, field).toMatchObject({ code: "invalid_request", message: `${field} is not supported yet` });
		}
	});

	it("accepts perRun and still rejects diskMb and requireApproval by default", () => {
		const [disk, approval, perRun] = variants;
		expect(validateVersionSpec(perRun![1], BUILTIN_TOOLS)).toEqual(perRun![1]);
		expect(rejection(() => validateVersionSpec(disk![1], BUILTIN_TOOLS)).code).toBe("invalid_request");
		expect(rejection(() => validateVersionSpec(approval![1], BUILTIN_TOOLS)).code).toBe("invalid_request");
	});

	it("rejects a diskMb below the minimum the storage can make", () => {
		const limits = { diskMb: false, approval: false, checkpoints: false, minDiskMb: 300 };
		const small = { ...completeSpec(), sandbox: { ...completeSpec().sandbox, resources: { cpu: 1, memoryMb: 512, diskMb: 299 } } };
		const enough = { ...completeSpec(), sandbox: { ...completeSpec().sandbox, resources: { cpu: 1, memoryMb: 512, diskMb: 300 } } };

		expect(rejection(() => validateVersionSpec(small, BUILTIN_TOOLS, limits))).toMatchObject({
			code: "invalid_request",
			message: "sandbox.resources.diskMb must be at least 300",
		});
		expect(validateVersionSpec(enough, BUILTIN_TOOLS, limits)).toEqual(enough);
	});

	it("accepts them when supported", () => {
		const supported = { diskMb: false, approval: false, checkpoints: false };
		for (const [field, spec] of variants) {
			expect(validateVersionSpec(spec, BUILTIN_TOOLS, supported), field).toEqual(spec);
		}
	});
});

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

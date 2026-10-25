import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TetherError } from "@tether/core";

const execFileAsync = promisify(execFile);

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

interface ExecFileError {
	code: number;
	stdout: string;
	stderr: string;
}

function isExitError(error: unknown): error is ExecFileError {
	return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "number";
}

/** 运行 docker CLI；非零退出码作为结果返回。docker 本身找不到时抛 sandbox_failed。 */
export async function docker(args: readonly string[]): Promise<CommandResult> {
	try {
		const { stdout, stderr } = await execFileAsync("docker", args, { maxBuffer: 64 * 1024 * 1024 });
		return { code: 0, stdout, stderr };
	} catch (error: unknown) {
		if (isExitError(error)) return { code: error.code, stdout: error.stdout, stderr: error.stderr };
		throw new TetherError("sandbox_failed", "cannot run docker", { cause: String(error) });
	}
}

export async function dockerOrThrow(args: readonly string[]): Promise<string> {
	const result = await docker(args);
	if (result.code !== 0) {
		throw new TetherError("sandbox_failed", `docker ${args[0]} failed (${result.code}): ${result.stderr.trim()}`);
	}
	return result.stdout;
}

export function isNoSuchContainer(result: CommandResult): boolean {
	return result.code !== 0 && /no such (container|object)/i.test(result.stderr);
}

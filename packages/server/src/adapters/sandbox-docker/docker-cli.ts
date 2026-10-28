import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TetherError } from "@tether/core";

const execFileAsync = promisify(execFile);

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** docker 调用的默认上限：守护进程卡住时工具调用不会一直等下去。 */
export const DOCKER_TIMEOUT_MS = 120_000;

export interface DockerOptions {
	/** 超过就杀掉子进程并抛 sandbox_failed；0 表示不限（只给 docker build 这种一次性的命令行操作用）。 */
	timeoutMs?: number;
	/** 代替 docker 的可执行文件，只给测试用。 */
	bin?: string;
}

interface ExecFileError {
	code: number | string | null;
	killed?: boolean;
	stdout: string;
	stderr: string;
}

function isExecError(error: unknown): error is ExecFileError {
	return typeof error === "object" && error !== null && "stdout" in error;
}

/**
 * 运行 docker CLI；非零退出码作为结果返回。超时（默认 DOCKER_TIMEOUT_MS）、docker 本身找不到时抛 sandbox_failed。
 * 超时的消息只写子命令名：完整参数里可能有 spec 标签（含 setup 命令）。
 */
export async function docker(args: readonly string[], options: DockerOptions = {}): Promise<CommandResult> {
	const timeoutMs = options.timeoutMs ?? DOCKER_TIMEOUT_MS;
	try {
		const { stdout, stderr } = await execFileAsync(options.bin ?? "docker", args, {
			maxBuffer: 64 * 1024 * 1024,
			timeout: timeoutMs,
			killSignal: "SIGKILL",
		});
		return { code: 0, stdout, stderr };
	} catch (error: unknown) {
		if (isExecError(error) && error.killed) {
			throw new TetherError("sandbox_failed", `docker ${args[0] ?? ""} timed out after ${timeoutMs / 1000} s`);
		}
		if (isExecError(error) && typeof error.code === "number") {
			return { code: error.code, stdout: error.stdout, stderr: error.stderr };
		}
		throw new TetherError("sandbox_failed", "cannot run docker", { cause: String(error) });
	}
}

export async function dockerOrThrow(args: readonly string[], options: DockerOptions = {}): Promise<string> {
	const result = await docker(args, options);
	if (result.code !== 0) {
		throw new TetherError("sandbox_failed", `docker ${args[0]} failed (${result.code}): ${result.stderr.trim()}`);
	}
	return result.stdout;
}

export function isNoSuchContainer(result: CommandResult): boolean {
	return result.code !== 0 && /no such (container|object)/i.test(result.stderr);
}

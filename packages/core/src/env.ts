export interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface DirEntry {
	name: string;
	kind: "file" | "dir" | "symlink" | "other";
	size: number;
}

export interface ExecOptions {
	/** 以环境变量传入，不拼进命令。 */
	env?: Record<string, string>;
	timeoutMs?: number;
	signal?: AbortSignal;
}

/**
 * 沙箱里的文件与命令操作，只取 Tether 自己用得到的最小子集（ADR-009）。
 * 路径相对 cwd 解析。文件不存在抛 TetherError("not_found")，沙箱或连接出错抛 TetherError("sandbox_failed")。
 */
export interface TetherEnv {
	readonly cwd: string;
	readText(path: string): Promise<string>;
	writeFile(path: string, content: string | Uint8Array): Promise<void>;
	exists(path: string): Promise<boolean>;
	list(path: string): Promise<DirEntry[]>;
	readBytes(path: string): Promise<Uint8Array>;
	/** 不跟随最后一级的符号链接（lstat）。 */
	info(path: string): Promise<DirEntry>;
	/** 解析成绝对路径，沿途的符号链接都跟到底（realpath）。 */
	realPath(path: string): Promise<string>;
	exec(command: string, options?: ExecOptions): Promise<ExecResult>;
}

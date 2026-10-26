import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ExecutionEnv, FileInfo, Result } from "@earendil-works/pi-durable/env";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import {
	TetherError,
	type DirEntry,
	type ExecChannel,
	type ExecOptions,
	type ExecResult,
	type SandboxBinding,
	type TetherEnv,
} from "@tether/core";

export { type LazyEnvOptions, lazyEnv } from "./lazy.ts";

export interface PiEnvExecChannelOptions {
	/**
	 * 每次（重新）启动 daemon 前调用，返回启动命令；Connection 会在末尾追加 serve --token <hex>。
	 * 组装层接到 SandboxService.connect：取新 epoch 并隔离旧 daemon（ADR-007）。它失败时这次启动失败，下一次请求重试。
	 */
	connect: (binding: SandboxBinding) => Promise<readonly string[]>;
}

export interface PiEnvExecChannel extends ExecChannel {
	/** 给 pi 的内置工具用的环境，与 env() 共用同一条连接（ADR-009）。 */
	piEnv(binding: SandboxBinding, cwd: string): ExecutionEnv;
	closeAll(): void;
}

function contextFor(signal: AbortSignal | undefined): Context {
	return signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
}

/** pi 的失败分两种：Result 里的预期错误和连接断开等抛出的异常，都转成 TetherError。 */
async function call<T>(what: string, operation: () => Promise<Result<T, Error & { code: string }>>): Promise<T> {
	let result: Result<T, Error & { code: string }>;
	try {
		result = await operation();
	} catch (error) {
		throw new TetherError("sandbox_failed", `${what} failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (result.ok) return result.value;
	const { code, message } = result.error;
	if (code === "not_found") throw new TetherError("not_found", `${what}: ${message}`);
	throw new TetherError("sandbox_failed", `${what} failed (${code}): ${message}`, { code });
}

function toDirEntry(info: FileInfo): DirEntry {
	const kind = info.kind === "directory" ? "dir" : info.kind === "file" || info.kind === "symlink" ? info.kind : "other";
	return { name: info.name, kind, size: info.size };
}

function wrap(remote: RemoteExecutionEnv, cwd: string): TetherEnv {
	const context = BACKGROUND_CONTEXT;
	return {
		cwd,
		readText: (path) => call(`read ${path}`, () => remote.readTextFile(path, context)),
		async writeFile(path, content) {
			const parent = posix.dirname(path);
			if (parent !== "." && parent !== "/") {
				await call(`mkdir ${parent}`, () => remote.createDir(parent, { recursive: true }, context));
			}
			await call(`write ${path}`, () => remote.writeFile(path, content, context));
		},
		exists: (path) => call(`stat ${path}`, () => remote.exists(path, context)),
		async list(path) {
			const infos = await call(`list ${path}`, () => remote.listDir(path, context));
			return infos.map(toDirEntry).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		},
		async readBytes(path) {
			const bytes = await call(`read ${path}`, () => remote.readBinaryFile(path, context));
			// pi 给的是 Node 的 Buffer；换成同一块内存上的普通 Uint8Array，core 只认端口里的类型
			return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		},
		info: async (path) => toDirEntry(await call(`stat ${path}`, () => remote.fileInfo(path, context))),
		realPath: (path) => call(`realpath ${path}`, () => remote.canonicalPath(path, context)),
		async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
			const output = { stdout: "", stderr: "" };
			const { exitCode } = await call(`exec`, () =>
				remote.exec(
					command,
					{
						// 与构造时的 shellEnv 合并；值经环境变量传给 shell，不拼进命令
						...(options.env && { env: options.env }),
						...(options.timeoutMs !== undefined && { timeout: options.timeoutMs / 1000 }),
						onOutput: (text, _context, info) => {
							output[info.stream] += text;
						},
					},
					contextFor(options.signal),
				),
			);
			return { exitCode, ...output };
		},
	};
}

/**
 * 经 pi-env daemon 访问沙箱。每个沙箱一条 Connection，一个容器同一时刻只有一个 daemon 在服务。
 * Connection 在 daemon 退出后（例如容器重启）的下一次请求时重新启动它，每次启动前都经 options.connect 取命令。
 */
export function createPiEnvExecChannel(options: PiEnvExecChannelOptions): PiEnvExecChannel {
	const open = new Map<string, Connection>();

	function connectionFor(binding: SandboxBinding): Connection {
		const existing = open.get(binding.sandboxId);
		if (existing) return existing;
		const connection = new Connection({ command: () => options.connect(binding) });
		open.set(binding.sandboxId, connection);
		return connection;
	}

	function remoteEnv(binding: SandboxBinding, cwd: string, shellEnv?: Record<string, string>): RemoteExecutionEnv {
		return new RemoteExecutionEnv({
			connection: connectionFor(binding),
			id: `docker:${binding.sandboxId}`,
			cwd,
			...(shellEnv && { shellEnv }),
		});
	}

	return {
		env: (binding, { cwd, shellEnv }) => wrap(remoteEnv(binding, cwd, shellEnv), cwd),
		piEnv: (binding, cwd) => remoteEnv(binding, cwd),
		close(sandboxId) {
			open.get(sandboxId)?.close();
			open.delete(sandboxId);
		},
		closeAll() {
			for (const connection of open.values()) connection.close();
			open.clear();
		},
	};
}

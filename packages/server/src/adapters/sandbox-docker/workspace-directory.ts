import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { TetherError } from "@tether/core";
import { docker } from "./docker-cli.ts";
import type { WorkspaceStorage } from "./workspace.ts";

const execFileAsync = promisify(execFile);

async function run(command: string, args: string[]): Promise<void> {
	try {
		await execFileAsync(command, args, { maxBuffer: 16 * 1024 * 1024 });
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr?.trim();
		throw new TetherError("sandbox_failed", `${command} failed: ${stderr || String(error)}`);
	}
}

export interface DirectoryStorageOptions {
	workspaceRoot: string;
	/** 删工作区用的一次性 root 容器的镜像。 */
	helperImage: string;
}

/** 目录模式（M2 的做法）：宿主上的 <workspaceRoot>/<sessionId> 直接挂成 /workspace。宿主盘不支持 reflink 时用它。 */
export function createDirectoryStorage(options: DirectoryStorageOptions): WorkspaceStorage {
	const workspaceOf = (sessionId: string) => join(options.workspaceRoot, sessionId);

	return {
		mode: "directory",
		snapshotSuffix: "",

		async prepare(sessionId, _diskMb, from) {
			const workspace = workspaceOf(sessionId);
			await mkdir(workspace, { recursive: true });
			// 恢复要真正复制：快照里的文件和其他快照共享 inode（硬链接），直接链接的话改工作区就改了存档
			if (from !== undefined) await run("cp", ["-a", `${from}/.`, `${workspace}/`]);
			return ["--volume", `${workspace}:/workspace`];
		},

		/** 没变的文件和上一张快照硬链接共享（rsync --link-dest），变了的完整复制一份（ADR-006 的退路）。 */
		async copyOut(sessionId, target, previous) {
			await run("rsync", [
				"-a",
				"--delete",
				...(previous === undefined ? [] : [`--link-dest=${previous}`]),
				`${workspaceOf(sessionId)}/`,
				`${target}/`,
			]);
		},

		async beforeStart() {
			return true;
		},

		/** 工作区里可能有容器以其他身份写下的文件，借一个一次性 root 容器来删（沿用 M0 的做法）。 */
		async remove(sessionId) {
			const target = workspaceOf(sessionId);
			const result = await docker([
				"run",
				"--rm",
				"--network",
				"none",
				"--user",
				"0:0",
				"--volume",
				`${dirname(target)}:/parent`,
				options.helperImage,
				"rm",
				"-rf",
				`/parent/${basename(target)}`,
			]);
			if (result.code !== 0) {
				throw new TetherError("sandbox_failed", `cannot remove workspace ${target}: ${result.stderr.trim()}`);
			}
		},

		/** 目录直接绑定挂载，没有卷和 loop 设备要释放。 */
		async release() {
			return 0;
		},
	};
}

import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { TetherError } from "@tether/core";
import { docker } from "./docker-cli.ts";
import type { WorkspaceStorage } from "./workspace.ts";

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

		async prepare(sessionId) {
			const workspace = workspaceOf(sessionId);
			await mkdir(workspace, { recursive: true });
			return ["--volume", `${workspace}:/workspace`];
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
	};
}

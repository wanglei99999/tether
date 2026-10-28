import { randomBytes } from "node:crypto";
import { mkdir, readdir, rename, rm, rmdir, stat, statfs } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { TetherError } from "@tether/core";

/** 快照 ID 是 <会话>/<16 位十六进制>，会拼进路径，只认这种形式。 */
const SNAPSHOT_ID = /^[A-Za-z0-9_-]+\/[0-9a-f]{16}$/;
const NAME = /^[0-9a-f]{16}$/;
const PARTIAL = ".tmp";

export interface SnapshotFiles {
	/** 快照在宿主上的路径；ID 不合法时抛 invalid_request。 */
	pathOf(snapshotId: string): string;
	/**
	 * 新建一张快照：copy 往一个临时路径里写（previous 是这个会话最近一张已完成的快照），写完改名成正式的名字。
	 * 中途失败删掉临时文件；进程崩溃留下的 .tmp 由 list() 报成 partial，启动对账删除。
	 */
	take(sessionId: string, copy: (target: string, previous?: string) => Promise<void>): Promise<string>;
	remove(snapshotId: string): Promise<void>;
	list(): Promise<{ snapshotId: string; partial: boolean }[]>;
	space(): Promise<{ freeBytes: number; totalBytes: number }>;
}

/** 快照放在 <checkpointRoot>/<会话>/<id><suffix>：镜像模式是 .img 文件，目录模式是目录。 */
export function createSnapshotFiles(checkpointRoot: string, suffix: string): SnapshotFiles {
	const root = resolve(checkpointRoot);

	function pathOf(snapshotId: string): string {
		if (!SNAPSHOT_ID.test(snapshotId)) {
			throw new TetherError("invalid_request", `snapshot id ${JSON.stringify(snapshotId)} is not of the form <session>/<16 hex digits>`);
		}
		return join(root, `${snapshotId}${suffix}`);
	}

	/** 一个会话已完成的快照，按修改时间从旧到新。 */
	async function completed(sessionId: string): Promise<string[]> {
		const dir = join(root, sessionId);
		const names = (await readdir(dir).catch(() => [] as string[])).filter(
			(name) => name.endsWith(suffix) && NAME.test(name.slice(0, name.length - suffix.length)),
		);
		const timed = await Promise.all(names.map(async (name) => ({ name, at: (await stat(join(dir, name))).mtimeMs })));
		return timed.sort((a, b) => a.at - b.at).map(({ name }) => join(dir, name));
	}

	return {
		pathOf,

		async take(sessionId, copy) {
			const snapshotId = `${sessionId}/${randomBytes(8).toString("hex")}`;
			const target = pathOf(snapshotId);
			const partial = `${target}${PARTIAL}`;
			await mkdir(join(root, sessionId), { recursive: true });
			const previous = (await completed(sessionId)).at(-1);
			try {
				await copy(partial, previous);
				await rename(partial, target);
			} catch (error) {
				await rm(partial, { recursive: true, force: true });
				throw error;
			}
			return snapshotId;
		},

		async remove(snapshotId) {
			const target = pathOf(snapshotId);
			await rm(target, { recursive: true, force: true });
			await rm(`${target}${PARTIAL}`, { recursive: true, force: true });
			// 会话的最后一张删掉了就删目录；还有别的快照时 rmdir 报 ENOTEMPTY，不管它
			await rmdir(dirname(target)).catch(() => {});
		},

		async list() {
			const sessions = await readdir(root, { withFileTypes: true }).catch(() => []);
			const found: { snapshotId: string; partial: boolean }[] = [];
			for (const session of sessions.filter((entry) => entry.isDirectory())) {
				for (const name of await readdir(join(root, session.name))) {
					const partial = name.endsWith(`${suffix}${PARTIAL}`);
					const base = partial ? name.slice(0, -(suffix.length + PARTIAL.length)) : name.slice(0, name.length - suffix.length);
					if ((partial || name.endsWith(suffix)) && NAME.test(base)) {
						found.push({ snapshotId: `${session.name}/${base}`, partial });
					}
				}
			}
			return found;
		},

		async space() {
			await mkdir(root, { recursive: true });
			const stats = await statfs(root);
			return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
		},
	};
}

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 镜像模式要求工作区在支持 reflink 的文件系统上。测试机的 XFS 盘挂在 /data/tether-xfs；
 * 别的机器用 TETHER_TEST_XFS_ROOT 指过去。目录模式用系统临时目录（测试机上是 ext4）。
 */
export const XFS_ROOT = process.env.TETHER_TEST_XFS_ROOT || "/data/tether-xfs/test";

export type StorageMode = "image" | "directory";

/** 一个新的、属于本次测试的根目录。 */
export function freshRoot(mode: StorageMode, prefix = "tether-ws-"): string {
	const base = mode === "image" ? XFS_ROOT : tmpdir();
	mkdirSync(base, { recursive: true });
	return mkdtempSync(join(base, prefix));
}

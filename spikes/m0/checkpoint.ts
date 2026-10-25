import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { docker, IMAGE, LABEL } from "./docker.ts";

const execFileAsync = promisify(execFile);

/** 系统盘（ext4）和 Step 0 建的 XFS 测试盘上存放工作区与快照的目录。 */
export const EXT4_ROOT = resolve(".tmp/m0-workspaces");
export const XFS_ROOT = "/data/tether-xfs/m0-workspaces";

export type DirMode = "reflink" | "rsync";

/** 运行一条宿主命令，返回 stdout；失败时带上 stderr 抛错。 */
export async function run(file: string, args: readonly string[]): Promise<string> {
	try {
		const { stdout } = await execFileAsync(file, args, { maxBuffer: 16 * 1024 * 1024 });
		return stdout;
	} catch (error: unknown) {
		const stderr = (error as { stderr?: unknown }).stderr;
		const detail = typeof stderr === "string" && stderr.trim() ? stderr.trim() : String(error);
		throw new Error(`${file} ${args.join(" ")} failed: ${detail}`);
	}
}

/** mount / umount 需要 root；Step 0 的 sudoers 只放行这两个命令。 */
function sudo(args: readonly string[]): Promise<string> {
	return run("sudo", ["-n", ...args]);
}

export async function supportsReflink(dir: string): Promise<boolean> {
	await mkdir(dir, { recursive: true });
	const probe = join(dir, ".reflink-probe");
	await writeFile(probe, "probe");
	try {
		await run("cp", ["--reflink=always", probe, `${probe}.copy`]);
		return true;
	} catch {
		// cp --reflink=always 在不支持的文件系统上失败，这正是要探测的结果
		return false;
	} finally {
		await rm(probe, { force: true });
		await rm(`${probe}.copy`, { force: true });
	}
}

export async function usedBytes(path: string): Promise<number> {
	await run("sync", ["-f", path]);
	return Number((await run("df", ["--output=used", "-B1", path])).split("\n")[1]);
}

export async function availableBytes(path: string): Promise<number> {
	return Number((await run("df", ["--output=avail", "-B1", path])).split("\n")[1]);
}

/**
 * 删除一棵目录树。overlay 的 workdir 里有内核以 root 身份建的目录，测试用户删不掉，
 * 所以借一个一次性容器（以 root 运行）来删。
 */
export async function removeTree(path: string): Promise<void> {
	const target = resolve(path);
	const result = await docker([
		"run",
		"--rm",
		"--label",
		LABEL,
		"--volume",
		`${dirname(target)}:/parent`,
		IMAGE,
		"rm",
		"-rf",
		`/parent/${basename(target)}`,
	]);
	if (result.code !== 0) throw new Error(`cannot remove ${target}: ${result.stderr.trim()}`);
}

/** 延迟卸载 dir 之下的所有挂载，深的先卸。用于测试失败后的清理。 */
export async function unmountUnder(dir: string): Promise<void> {
	const prefix = `${resolve(dir)}/`;
	const mountinfo = await readFile("/proc/self/mountinfo", "utf8");
	const points = mountinfo
		.split("\n")
		.map((line) => line.split(" ")[4] ?? "")
		.filter((point) => point.startsWith(prefix))
		.sort((a, b) => b.length - a.length);
	for (const point of points) {
		await sudo(["umount", "--lazy", point]).catch(() => undefined);
	}
}

// ---- 目录式快照：reflink 与 rsync ----

export async function snapshotDir(workspace: string, dest: string, previous: string | undefined, mode: DirMode): Promise<void> {
	await mkdir(dest, { recursive: true });
	if (mode === "reflink") {
		await run("cp", ["-a", "--reflink=always", `${workspace}/.`, dest]);
		return;
	}
	const linkDest = previous ? [`--link-dest=${resolve(previous)}`] : [];
	await run("rsync", ["-a", "--delete", ...linkDest, `${workspace}/`, `${dest}/`]);
}

/** rsync 模式恢复用不带 --link-dest 的 cp -a：恢复出的工作区不能和快照共享 inode，否则改它就是改快照。 */
export async function restoreDir(snapshot: string, dest: string, mode: DirMode): Promise<void> {
	await mkdir(dest, { recursive: true });
	const reflink = mode === "reflink" ? ["--reflink=always"] : [];
	await run("cp", ["-a", ...reflink, `${snapshot}/.`, dest]);
}

// ---- overlay 分层 ----

/**
 * 一个 overlay 工作区。目录布局：
 *   <base>/root      自身 bind 挂载并设为 shared，整个挂进容器（rslave），宿主上的重新挂载才能传播进去
 *   <base>/root/w    overlay 挂载点，即工作区
 *   <base>/layers/N  冻结的只读层
 *   <base>/upper     当前可写层
 *   <base>/work-N    overlay 的 workdir，每代一个新的（旧的里有 root 所有的目录）
 */
export interface Overlay {
	readonly base: string;
	/** 只读层，新的在前。 */
	readonly lowers: readonly string[];
	readonly generation: number;
}

export interface OverlaySnapshot {
	readonly overlay: Overlay;
	/** 快照就是那一刻的只读层列表，新的在前；恢复时把它们原样作为 lowerdir。 */
	readonly snapshot: readonly string[];
}

export function overlayMountpoint(base: string): string {
	return join(base, "root", "w");
}

async function mountOverlay(base: string, lowers: readonly string[], generation: number): Promise<void> {
	const work = join(base, `work-${generation}`);
	await mkdir(work, { recursive: true });
	const options = `lowerdir=${lowers.join(":")},upperdir=${join(base, "upper")},workdir=${work}`;
	await sudo(["mount", "-t", "overlay", "overlay", "-o", options, overlayMountpoint(base)]);
}

async function prepareOverlayRoot(base: string): Promise<void> {
	const root = join(base, "root");
	await mkdir(join(base, "upper"), { recursive: true });
	await mkdir(root, { recursive: true });
	await sudo(["mount", "--bind", root, root]);
	await sudo(["mount", "--make-shared", root]);
	await mkdir(overlayMountpoint(base), { recursive: true });
}

export async function overlayCreate(base: string): Promise<Overlay> {
	const empty = join(base, "layers", "0");
	await mkdir(empty, { recursive: true });
	await prepareOverlayRoot(base);
	await mountOverlay(base, [empty], 0);
	return { base, lowers: [empty], generation: 0 };
}

/**
 * 冻结当前可写层：卸载 overlay，把 upper 改名为新的只读层，换一个空的 upper 重新挂载。
 * lazy 为 false 时，有进程占用工作区就会因 busy 失败；为 true 时用延迟卸载，占用者继续持有旧挂载。
 */
export async function overlaySnapshot(overlay: Overlay, options: { lazy: boolean }): Promise<OverlaySnapshot> {
	const { base } = overlay;
	await sudo(["umount", ...(options.lazy ? ["--lazy"] : []), overlayMountpoint(base)]);
	const generation = overlay.generation + 1;
	const frozen = join(base, "layers", String(generation));
	await rename(join(base, "upper"), frozen);
	await mkdir(join(base, "upper"));
	const lowers = [frozen, ...overlay.lowers];
	await mountOverlay(base, lowers, generation);
	return { overlay: { base, lowers, generation }, snapshot: lowers };
}

/** 用快照的只读层加一个新的空可写层挂载出新工作区，不复制数据。 */
export async function overlayRestore(snapshot: readonly string[], base: string): Promise<Overlay> {
	await prepareOverlayRoot(base);
	await mountOverlay(base, snapshot, 0);
	return { base, lowers: snapshot, generation: 0 };
}

export async function overlayDestroy(overlay: Overlay): Promise<void> {
	await unmountUnder(overlay.base);
	await removeTree(overlay.base);
}

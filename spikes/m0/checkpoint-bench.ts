import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
	type DirMode,
	EXT4_ROOT,
	type Overlay,
	overlayCreate,
	overlayDestroy,
	overlayMountpoint,
	overlayRestore,
	overlaySnapshot,
	removeTree,
	restoreDir,
	run,
	snapshotDir,
	usedBytes,
	XFS_ROOT,
} from "./checkpoint.ts";
import { type ContainerOptions, docker, dockerExec, LABEL, removeContainer, startContainer } from "./docker.ts";

export type Mode = DirMode | "overlay";
/** 两次快照之间的改动：新写一个 2 MiB 文件，或在大文件中间原地改写 2 MiB。 */
export type Change = "new-file" | "in-place";

export interface Workspace {
	/** 宿主上可以直接读写工作区的路径。 */
	readonly hostDir: string;
	/** 容器里看到的工作区路径。 */
	readonly containerDir: string;
	/** 把工作区挂进容器所需的选项。 */
	readonly mount: ContainerOptions;
	/** 销毁时要删除的目录。 */
	readonly path: string;
	readonly overlay?: Overlay;
}

export interface Approach {
	readonly mode: Mode;
	/** 这种做法的工作区和快照所在的目录，也是测量空间的位置。 */
	readonly root: string;
	create(name: string): Promise<Workspace>;
	/** 返回打完快照后的工作区（overlay 会换代）和快照本身。 */
	snapshot(
		workspace: Workspace,
		index: number,
		previous: readonly string[] | undefined,
	): Promise<{ workspace: Workspace; snapshot: readonly string[] }>;
	restore(snapshot: readonly string[], name: string): Promise<Workspace>;
	/** 删除快照占的空间；overlay 的快照是工作区内部的层，随工作区一起删除。 */
	discard(snapshot: readonly string[]): Promise<void>;
	destroy(workspace: Workspace): Promise<void>;
}

function dirApproach(mode: DirMode): Approach {
	const root = mode === "reflink" ? XFS_ROOT : EXT4_ROOT;
	const workspaceAt = (path: string): Workspace => ({
		hostDir: path,
		containerDir: "/workspace",
		mount: { workspace: path },
		path,
	});
	return {
		mode,
		root,
		create: async (name) => {
			const path = join(root, name);
			await mkdir(path, { recursive: true });
			return workspaceAt(path);
		},
		snapshot: async (workspace, index, previous) => {
			const dest = `${workspace.path}.snap-${index}`;
			await snapshotDir(workspace.hostDir, dest, previous?.[0], mode);
			return { workspace, snapshot: [dest] };
		},
		restore: async (snapshot, name) => {
			const path = join(root, name);
			await restoreDir(snapshot[0]!, path, mode);
			return workspaceAt(path);
		},
		discard: (snapshot) => removeTree(snapshot[0]!),
		destroy: (workspace) => removeTree(workspace.path),
	};
}

function overlayApproach(): Approach {
	const workspaceOf = (overlay: Overlay): Workspace => ({
		hostDir: overlayMountpoint(overlay.base),
		containerDir: "/mnt/ws/w",
		mount: { workspace: join(overlay.base, "root"), target: "/mnt/ws", propagation: "rslave" },
		path: overlay.base,
		overlay,
	});
	return {
		mode: "overlay",
		root: EXT4_ROOT,
		create: async (name) => workspaceOf(await overlayCreate(join(EXT4_ROOT, name))),
		snapshot: async (workspace) => {
			const { overlay, snapshot } = await overlaySnapshot(workspace.overlay!, { lazy: false });
			return { workspace: workspaceOf(overlay), snapshot };
		},
		restore: async (snapshot, name) => workspaceOf(await overlayRestore(snapshot, join(EXT4_ROOT, name))),
		discard: async () => undefined,
		destroy: (workspace) => overlayDestroy(workspace.overlay!),
	};
}

export function approach(mode: Mode): Approach {
	return mode === "overlay" ? overlayApproach() : dirApproach(mode);
}

// ---- 测量 ----

export interface Measurement {
	approach: Mode | "docker-commit";
	sizeMiB: number;
	change: Change;
	/** 三次快照各自的耗时；第 2、3 次之前各做一次改动。 */
	snapshotsMs: number[];
	restoreMs: number;
	/** 写入初始数据后增加的已用空间。 */
	dataBytes: number;
	/** 从写完初始数据到打完三次快照增加的已用空间，含两次改动本身（各 2 MiB）。 */
	historyBytes: number;
}

/** dd 的参数：初始大文件、一次新文件改动或一次原地改动。 */
function ddArgs(dir: string, sizeMiB: number, change: Change | "initial", index: number): string[] {
	if (change === "initial") return ["if=/dev/urandom", `of=${dir}/big.bin`, "bs=1M", `count=${sizeMiB}`, "status=none"];
	if (change === "new-file") return ["if=/dev/urandom", `of=${dir}/change-${index}.bin`, "bs=1M", "count=2", "status=none"];
	const middle = Math.floor(sizeMiB / 2);
	return ["if=/dev/urandom", `of=${dir}/big.bin`, "bs=1M", "count=2", `seek=${middle}`, "conv=notrunc", "status=none"];
}

async function timed<T>(action: () => Promise<T>): Promise<{ value: T; ms: number }> {
	const start = performance.now();
	const value = await action();
	return { value, ms: Math.round(performance.now() - start) };
}

export async function measureApproach(strategy: Approach, sizeMiB: number, change: Change): Promise<Measurement> {
	const name = `bench-${strategy.mode}-${sizeMiB}-${change}`;
	let workspace = await strategy.create(name);
	const before = await usedBytes(strategy.root);
	if (sizeMiB > 0) await run("dd", ddArgs(workspace.hostDir, sizeMiB, "initial", 0));
	const afterData = await usedBytes(strategy.root);

	const snapshotsMs: number[] = [];
	const snapshots: (readonly string[])[] = [];
	for (let index = 1; index <= 3; index++) {
		if (index > 1) await run("dd", ddArgs(workspace.hostDir, sizeMiB, change, index));
		const { value, ms } = await timed(() => strategy.snapshot(workspace, index, snapshots.at(-1)));
		workspace = value.workspace;
		snapshots.push(value.snapshot);
		snapshotsMs.push(ms);
	}
	const afterHistory = await usedBytes(strategy.root);
	const restored = await timed(() => strategy.restore(snapshots.at(-1)!, `${name}-restored`));

	await strategy.destroy(restored.value);
	for (const snapshot of snapshots) await strategy.discard(snapshot);
	await strategy.destroy(workspace);
	return {
		approach: strategy.mode,
		sizeMiB,
		change,
		snapshotsMs,
		restoreMs: restored.ms,
		dataBytes: afterData - before,
		historyBytes: afterHistory - afterData,
	};
}

export async function measureCommit(sizeMiB: number, change: Change): Promise<Measurement> {
	const name = "tether-m0-ckpt-bench";
	const restoredName = `${name}-restored`;
	const tags: string[] = [];
	const inContainer = async (args: string[]): Promise<void> => {
		const result = await dockerExec(name, `dd ${args.join(" ")}`);
		if (result.code !== 0) throw new Error(`dd in ${name} failed: ${result.stderr.trim()}`);
	};

	await removeContainer(name);
	await startContainer(name);
	await dockerExec(name, "mkdir -p /data");
	// 容器可写层和镜像都在系统盘上
	const before = await usedBytes("/");
	if (sizeMiB > 0) await inContainer(ddArgs("/data", sizeMiB, "initial", 0));
	const afterData = await usedBytes("/");

	const snapshotsMs: number[] = [];
	for (let index = 1; index <= 3; index++) {
		if (index > 1) await inContainer(ddArgs("/data", sizeMiB, change, index));
		const tag = `tether-m0-ckpt:bench-${sizeMiB}-${change}-${index}`;
		const { value, ms } = await timed(() => docker(["commit", "--change", `LABEL ${LABEL}`, name, tag]));
		if (value.code !== 0) throw new Error(`docker commit failed: ${value.stderr.trim()}`);
		tags.push(tag);
		snapshotsMs.push(ms);
	}
	const afterHistory = await usedBytes("/");
	const restored = await timed(() => startContainer(restoredName, { image: tags.at(-1)! }));

	await removeContainer(restoredName);
	await removeContainer(name);
	await docker(["image", "rm", "--force", ...tags]);
	return {
		approach: "docker-commit",
		sizeMiB,
		change,
		snapshotsMs,
		restoreMs: restored.ms,
		dataBytes: afterData - before,
		historyBytes: afterHistory - afterData,
	};
}

import { execFile } from "node:child_process";
import { mkdir, open, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { TetherError } from "@tether/core";
import { docker, dockerOrThrow } from "./docker-cli.ts";
import type { WorkspaceStorage } from "./workspace.ts";

const execFileAsync = promisify(execFile);

export interface ImageStorageOptions {
	workspaceRoot: string;
	/** 沙箱用户 uid:gid，镜像里文件系统的根目录归它。 */
	user: string;
	/** 跑 losetup 的一次性特权容器用的镜像（默认沙箱镜像里有 losetup）。 */
	helperImage: string;
}

const IMAGE_FILE = "disk.img";
/** mkfs.xfs（xfsprogs ≥ 5.19）不接受小于 300 MB 的文件系统。 */
export const MIN_DISK_MB = 300;

export const volumeName = (sessionId: string) => `tether-${sessionId}`;

/**
 * 镜像模式（ADR-011）：每个会话一个 XFS 镜像文件 <workspaceRoot>/<sessionId>/disk.img，大小就是 diskMb。
 * 一次性特权容器把它接成 loop 设备，Docker 的 local 卷把设备挂成 /workspace。存档是克隆这一个文件，耗时与文件数无关。
 * Tether 进程不需要 root：mkfs.xfs 作用于自己的普通文件；只有 losetup 需要特权，经 docker 执行（docker 组本来就等同 root）。
 */
export function createImageStorage(options: ImageStorageOptions): WorkspaceStorage {
	const dirOf = (sessionId: string) => join(options.workspaceRoot, sessionId);
	const imageOf = (sessionId: string) => join(dirOf(sessionId), IMAGE_FILE);
	const [uid, gid] = options.user.split(":");

	/**
	 * 一次性特权容器里跑一段 sh（losetup 要特权）；loop 设备是内核全局的，容器退出后仍在。
	 * 找"接着这个镜像的设备"一律用 losetup --associated：它按设备号和 inode 比较。
	 * /sys/block/loopN/loop/backing_file 不能用来比：在容器里接上的设备，那里记的是相对于绑定挂载的路径。
	 */
	async function helper(script: string, image: string): Promise<string> {
		const root = await realpath(options.workspaceRoot);
		return dockerOrThrow([
			"run",
			"--rm",
			"--privileged",
			"--network",
			"none",
			"--volume",
			"/dev:/dev",
			"--volume",
			`${root}:${root}`,
			options.helperImage,
			"sh",
			"-c",
			script,
			"sh",
			image,
		]);
	}

	const ASSOCIATED = 'losetup --list --noheadings --output NAME --associated "$1"';

	async function create(sessionId: string, diskMb: number): Promise<void> {
		const dir = dirOf(sessionId);
		await mkdir(dir, { recursive: true });
		const image = imageOf(sessionId);
		// 稀疏文件：只占写进去的数据
		const file = await open(image, "wx");
		try {
			await file.truncate(diskMb * 1024 * 1024);
		} finally {
			await file.close();
		}
		// protofile 让根目录直接归沙箱用户，不用借 root 容器 chown
		const proto = join(dir, "proto");
		await writeFile(proto, `/dev/null\n0 0\nd--755 ${uid} ${gid}\n$\n`);
		try {
			await execFileAsync("mkfs.xfs", ["-q", "-m", "reflink=1", "-p", proto, image]);
		} catch (error) {
			const stderr = (error as { stderr?: string }).stderr?.trim();
			throw new TetherError("sandbox_failed", `cannot format the workspace image ${image}: ${stderr || String(error)}`);
		} finally {
			await rm(proto, { force: true });
		}
	}

	/** 已经接上就复用，否则接到一个空闲的 loop 设备上。 */
	async function attach(sessionId: string): Promise<string> {
		const image = await realpath(imageOf(sessionId));
		const out = await helper(`d=$(${ASSOCIATED} | head -n 1); [ -n "$d" ] || d=$(losetup --find --show "$1"); echo "$d"`, image);
		return out.trim();
	}

	async function devicesOf(image: string): Promise<string[]> {
		return (await helper(ASSOCIATED, image)).split("\n").map((line) => line.trim()).filter(Boolean);
	}

	async function volumeDevice(sessionId: string): Promise<string | undefined> {
		const result = await docker(["volume", "inspect", "--format", '{{index .Options "device"}}', volumeName(sessionId)]);
		return result.code === 0 ? result.stdout.trim() : undefined;
	}

	return {
		mode: "image",

		async prepare(sessionId, diskMb) {
			if (diskMb < MIN_DISK_MB) {
				throw new TetherError("invalid_request", `a workspace image needs at least ${MIN_DISK_MB} MB, got ${diskMb}`);
			}
			const exists = await stat(imageOf(sessionId)).then(
				() => true,
				() => false,
			);
			if (!exists) await create(sessionId, diskMb);
			const device = await attach(sessionId);
			// 卷的选项建好就不能改：记着的设备不对就删了重建（调用方保证此时没有容器在用它）
			const current = await volumeDevice(sessionId);
			if (current !== undefined && current !== device) {
				await dockerOrThrow(["volume", "rm", volumeName(sessionId)]);
			}
			if (current !== device) {
				await dockerOrThrow([
					"volume",
					"create",
					"--driver",
					"local",
					"--label",
					"tether.managed=1",
					"--opt",
					"type=xfs",
					"--opt",
					`device=${device}`,
					// 存档是同一个文件系统的克隆，UUID 相同，同时挂载要 nouuid
					"--opt",
					"o=nouuid",
					volumeName(sessionId),
				]);
			}
			// nocopy：不加的话 Docker 把镜像里 /workspace 的内容和 root 属主复制进空卷
			return ["--volume", `${volumeName(sessionId)}:/workspace:nocopy`];
		},

		/** 卷记着的设备还接着本会话的镜像吗？宿主重启后设备没了或换成了别的镜像，就是不再接着。 */
		async beforeStart(sessionId) {
			const device = await volumeDevice(sessionId);
			const image = await realpath(imageOf(sessionId)).catch(() => undefined);
			if (device === undefined || image === undefined) return false;
			return (await devicesOf(image)).includes(device);
		},

		async remove(sessionId) {
			const removed = await docker(["volume", "rm", "--force", volumeName(sessionId)]);
			if (removed.code !== 0) {
				throw new TetherError("sandbox_failed", `cannot remove volume ${volumeName(sessionId)}: ${removed.stderr.trim()}`);
			}
			// 先摘 loop 设备再删文件：文件删了就再也找不到接着它的设备，空间也一直占着
			const image = await realpath(imageOf(sessionId)).catch(() => undefined);
			if (image !== undefined) {
				await helper(`for d in $(${ASSOCIATED}); do losetup --detach "$d"; done`, image);
			}
			await rm(dirOf(sessionId), { recursive: true, force: true });
		},
	};
}

/** 两个目录之间能不能 reflink（同一个文件系统且支持）；能就用镜像模式。 */
export async function probeReflink(workspaceRoot: string, checkpointRoot: string): Promise<boolean> {
	await mkdir(workspaceRoot, { recursive: true });
	await mkdir(checkpointRoot, { recursive: true });
	const name = `.reflink-probe-${process.pid}-${Date.now()}`;
	const source = join(workspaceRoot, name);
	const target = join(checkpointRoot, name);
	try {
		await writeFile(source, "probe");
		await execFileAsync("cp", ["--reflink=always", source, target]);
		return true;
	} catch {
		return false;
	} finally {
		await rm(source, { force: true });
		await rm(target, { force: true });
	}
}

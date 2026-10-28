import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packagedDaemon } from "@earendil-works/pi-env";
import { TetherError, type SandboxCreate, type SandboxProvider, type SandboxSpec } from "@tether/core";
import { docker, dockerOrThrow, isNoSuchContainer } from "./docker-cli.ts";
import type { WorkspaceStorage } from "./workspace.ts";
import { createDirectoryStorage } from "./workspace-directory.ts";
import { createImageStorage, MIN_DISK_MB, probeReflink } from "./workspace-image.ts";

export { MIN_DISK_MB };

const SANDBOX_DIR = fileURLToPath(new URL("../../../sandbox/", import.meta.url));
const NAME_PREFIX = "tether-";
const MANAGED_LABEL = "tether.managed=1";
const SESSION_LABEL = "tether.session";
/** 建容器时的 SandboxSpec（JSON），挂载失效时按它重建。 */
const SPEC_LABEL = "tether.spec";
/** 会话 ID 会拼进容器名和宿主目录，只允许普通名字，挡住 "../" 之类。 */
const SESSION_ID = /^[A-Za-z0-9_-]+$/;
/** PID 1 是 sleep，不处理 SIGTERM，docker stop 总要等满超时再 SIGKILL，所以超时设短。 */
const STOP_TIMEOUT_SECONDS = "1";

export interface DockerSandboxOptions {
	/** 宿主上的工作区根目录，每个会话一个子目录，挂载为容器的 /workspace。 */
	workspaceRoot: string;
	/** 容器运行身份 uid:gid，应与 workspaceRoot 的属主一致。 */
	user: string;
	/** spec.template 为空时用的镜像。 */
	defaultImage: string;
	/** docker run --runtime，例如 gVisor 的 runsc；不设则用 Docker 默认的 runc。 */
	runtime?: string;
	/** 工作区的存法（ADR-011）：image 需要 workspaceRoot 支持 reflink，由组装层用 probeWorkspaceStorage 选。 */
	storage: "image" | "directory";
	/** spec.resources.diskMb 没填时镜像的大小。目录模式不限制磁盘。 */
	defaultDiskMb: number;
}

/**
 * 选工作区的存法：workspaceRoot 和 checkpointRoot 之间能 reflink 就用镜像，否则用目录。
 * 存档要从工作区克隆到 checkpointRoot，所以两者必须在同一个支持 reflink 的文件系统上。
 */
export async function probeWorkspaceStorage(workspaceRoot: string, checkpointRoot: string): Promise<"image" | "directory"> {
	return (await probeReflink(workspaceRoot, checkpointRoot)) ? "image" : "directory";
}

/** 构建默认沙箱镜像：Dockerfile、launch.sh 和 pi-env daemon 二进制放进临时构建上下文。 */
export async function buildSandboxImage(tag: string): Promise<void> {
	const context = await mkdtemp(join(tmpdir(), "tether-image-"));
	try {
		const arch = process.arch as Parameters<typeof packagedDaemon>[0]["arch"];
		await copyFile(packagedDaemon({ platform: "linux", arch }), join(context, "pi-env"));
		for (const script of ["launch.sh", "fence.sh"]) await copyFile(join(SANDBOX_DIR, script), join(context, script));
		await dockerOrThrow(["build", "--quiet", "--tag", tag, "--file", join(SANDBOX_DIR, "Dockerfile"), context]);
	} finally {
		await rm(context, { recursive: true, force: true });
	}
}

export function createDockerSandboxProvider(options: DockerSandboxOptions): SandboxProvider {
	const workspaceRoot = resolve(options.workspaceRoot);
	const sessionOf = (sandboxId: string) => sandboxId.slice(NAME_PREFIX.length);
	const storage: WorkspaceStorage =
		options.storage === "image"
			? createImageStorage({ workspaceRoot, user: options.user, helperImage: options.defaultImage })
			: createDirectoryStorage({ workspaceRoot, helperImage: options.defaultImage });

	/** 按配置建并启动容器；工作区由 storage 准备。spec 记在标签里，挂载失效时按它重建（start）。 */
	async function run(sessionId: string, spec: SandboxSpec): Promise<void> {
		const sandboxId = `${NAME_PREFIX}${sessionId}`;
		const mount = await storage.prepare(sessionId, spec.resources.diskMb ?? options.defaultDiskMb);
		const args = [
			"run",
			"--detach",
			"--name",
			sandboxId,
			// PID 1 必须是 sleep（fence.sh 和 ADR-007 的防护都依赖它）：不让 daemon.json 的 init 或模板镜像的 ENTRYPOINT 换掉它
			"--init=false",
			"--entrypoint",
			"sleep",
			"--label",
			MANAGED_LABEL,
			"--label",
			`${SESSION_LABEL}=${sessionId}`,
			"--label",
			`${SPEC_LABEL}=${JSON.stringify(spec)}`,
			"--cpus",
			String(spec.resources.cpu),
			"--memory",
			`${spec.resources.memoryMb}m`,
			"--pids-limit",
			"512",
			// 容器里的进程以普通用户运行，用不到任何 Linux 能力；也不许经 setuid 程序提权
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
			...(options.runtime ? ["--runtime", options.runtime] : []),
			"--network",
			spec.network === "egress" ? "bridge" : "none",
			"--user",
			options.user,
			...mount,
			spec.template === "" ? options.defaultImage : spec.template,
			"infinity",
			];
		await dockerOrThrow(args);
	}

	return {
		name: "docker",
		capabilities: { snapshot: false, fork: false, rollback: false, preservesMemoryOnStop: false },

		async create({ sessionId, spec }: SandboxCreate) {
			if (!SESSION_ID.test(sessionId)) {
				throw new TetherError("invalid_request", `session id ${JSON.stringify(sessionId)} is not a plain name`);
			}
			const sandboxId = `${NAME_PREFIX}${sessionId}`;
			try {
				await run(sessionId, spec);
			} catch (error) {
				// docker run 可能已经建好容器、只是启动失败：删掉它和刚建的工作区，否则下次创建撞上同名容器
				await docker(["rm", "--force", sandboxId]).catch(() => {});
				await storage.remove(sessionId).catch(() => {});
				throw error;
			}
			return { sandboxId };
		},

		async status(sandboxId) {
			const result = await docker(["inspect", "--format", "{{.State.Status}}", sandboxId]);
			if (isNoSuchContainer(result)) return "missing";
			if (result.code !== 0) {
				throw new TetherError("sandbox_failed", `docker inspect failed: ${result.stderr.trim()}`);
			}
			return result.stdout.trim() === "running" ? "running" : "stopped";
		},

		async start(sandboxId) {
			const sessionId = sessionOf(sandboxId);
			if (await storage.beforeStart(sessionId)) {
				await dockerOrThrow(["start", sandboxId]);
				return;
			}
			// 容器记着的挂载失效了（宿主重启后 loop 设备换了编号或接到了别的镜像上）：按原配置重建容器。
			// 工作区在镜像里，不受影响；丢的只是容器层，和停止时进程丢失是同一类，模型照常收到重连说明。
			const label = await dockerOrThrow(["inspect", "--format", `{{index .Config.Labels "${SPEC_LABEL}"}}`, sandboxId]);
			const spec = JSON.parse(label) as SandboxSpec;
			await dockerOrThrow(["rm", "--force", sandboxId]);
			await run(sessionId, spec);
		},

		async stop(sandboxId) {
			await dockerOrThrow(["stop", "--time", STOP_TIMEOUT_SECONDS, sandboxId]);
		},

		async destroy(sandboxId) {
			const result = await docker(["rm", "--force", sandboxId]);
			if (result.code !== 0 && !isNoSuchContainer(result)) {
				throw new TetherError("sandbox_failed", `docker rm failed: ${result.stderr.trim()}`);
			}
			const sessionId = sessionOf(sandboxId);
			if (SESSION_ID.test(sessionId)) await storage.remove(sessionId);
		},

		async listManaged() {
			const out = await dockerOrThrow([
				"ps",
				"--all",
				"--filter",
				`label=${MANAGED_LABEL}`,
				"--format",
				`{{.Names}}\t{{.Label "${SESSION_LABEL}"}}\t{{.State}}`,
			]);
			return out
				.split("\n")
				.filter((line) => line.trim() !== "")
				.map((line) => {
					const [sandboxId = "", sessionId = "", state = ""] = line.split("\t");
					// 与 status() 一致：只有 running 算运行，created、exited、paused 等都算停止
					return { sandboxId, sessionId, status: state === "running" ? "running" : "stopped" } as const;
				});
		},

		async fence(sandboxId, epoch) {
			// kill -1 在共享宿主 PID 命名空间的容器里会杀掉宿主上的进程：先确认容器有自己的命名空间
			const inspect = await docker(["inspect", "--format", "{{.HostConfig.PidMode}}", sandboxId]);
			if (inspect.code !== 0) {
				throw new TetherError("sandbox_failed", `cannot fence ${sandboxId}: ${inspect.stderr.trim()}`);
			}
			const pidMode = inspect.stdout.trim();
			if (pidMode !== "") {
				throw new TetherError(
					"sandbox_failed",
					`refusing to fence ${sandboxId}: it does not have its own PID namespace (PidMode=${pidMode})`,
				);
			}
			const result = await docker(["exec", sandboxId, "/opt/tether/fence.sh", String(epoch)]);
			if (result.code !== 0) {
				throw new TetherError(
					"sandbox_failed",
					`fence of ${sandboxId} at epoch ${epoch} failed (${result.code}): ${result.stderr.trim()}`,
				);
			}
			return { killed: result.stdout.trim().split(/\s+/).filter(Boolean).length };
		},

		/** 给 pi-env 的 Connection 用；Connection 会在末尾追加 serve --token <hex>。 */
		daemonCommand(sandboxId, epoch) {
			return ["docker", "exec", "-i", sandboxId, "/opt/tether/launch.sh", String(epoch)];
		},
	};
}

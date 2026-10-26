import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packagedDaemon } from "@earendil-works/pi-env";
import { TetherError, type SandboxCreate, type SandboxProvider } from "@tether/core";
import { docker, dockerOrThrow, isNoSuchContainer } from "./docker-cli.ts";

const SANDBOX_DIR = fileURLToPath(new URL("../../../sandbox/", import.meta.url));
const NAME_PREFIX = "tether-";
const MANAGED_LABEL = "tether.managed=1";
const SESSION_LABEL = "tether.session";
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
	const workspaceOf = (sessionId: string) => join(workspaceRoot, sessionId);
	const sessionOf = (sandboxId: string) => sandboxId.slice(NAME_PREFIX.length);

	/** 工作区里可能有容器以其他身份写下的文件，借一个一次性 root 容器来删（沿用 M0 的做法）。 */
	async function removeWorkspace(sessionId: string): Promise<void> {
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
			options.defaultImage,
			"rm",
			"-rf",
			`/parent/${basename(target)}`,
		]);
		if (result.code !== 0) {
			throw new TetherError("sandbox_failed", `cannot remove workspace ${target}: ${result.stderr.trim()}`);
		}
	}

	return {
		name: "docker",
		capabilities: { snapshot: false, fork: false, rollback: false, preservesMemoryOnStop: false },

		async create({ sessionId, spec }: SandboxCreate) {
			if (!SESSION_ID.test(sessionId)) {
				throw new TetherError("invalid_request", `session id ${JSON.stringify(sessionId)} is not a plain name`);
			}
			const sandboxId = `${NAME_PREFIX}${sessionId}`;
			const workspace = workspaceOf(sessionId);
			await mkdir(workspace, { recursive: true });
			// spec.resources.diskMb 不会到这里：校验时就拒绝（UNSUPPORTED_IN_M2）。Docker 限制磁盘依赖存储驱动（overlay2 + xfs pquota），测试机不满足。
			await dockerOrThrow([
				"run",
				"--detach",
				"--name",
				sandboxId,
				"--label",
				MANAGED_LABEL,
				"--label",
				`${SESSION_LABEL}=${sessionId}`,
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
				"--volume",
				`${workspace}:/workspace`,
				spec.template === "" ? options.defaultImage : spec.template,
				"sleep",
				"infinity",
			]);
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
			await dockerOrThrow(["start", sandboxId]);
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
			if (SESSION_ID.test(sessionId)) await removeWorkspace(sessionId);
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

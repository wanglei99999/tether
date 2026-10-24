import { execFile } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { packagedDaemon } from "@earendil-works/pi-env";

const execFileAsync = promisify(execFile);

export const IMAGE = "tether-m0-sandbox:dev";
/** 所有实验创建的容器和镜像都带这个标签，清理只按它或名字前缀来。 */
export const LABEL = "tether.m0=1";

const SPIKE_DIR = fileURLToPath(new URL(".", import.meta.url));
const BUILD_CONTEXT = resolve(".tmp/m0-image");
/** 每个实验容器的资源上限，避免拖垮 2 GiB 的测试机。 */
const LIMITS = ["--cpus", "1", "--memory", "512m", "--pids-limit", "256"] as const;

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface ContainerOptions {
	image?: string;
	/** 宿主上的工作区目录，默认挂载为容器的 /workspace。 */
	workspace?: string;
	/** 工作区在容器里的挂载点，默认 /workspace。 */
	target?: string;
	/** Task 6 的 overlay 做法需要让宿主上的重新挂载传播进容器。 */
	propagation?: "rslave";
	/** 以这个 uid:gid 运行容器；Task 6 用宿主测试用户的身份，让工作区文件不属于 root。 */
	user?: string;
}

interface ExecFileError {
	code: number;
	stdout: string;
	stderr: string;
}

function isExitError(error: unknown): error is ExecFileError {
	return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "number";
}

/** 运行 docker CLI；非零退出码作为结果返回，不抛错。docker 本身找不到时才抛错。 */
export async function docker(args: readonly string[]): Promise<CommandResult> {
	try {
		const { stdout, stderr } = await execFileAsync("docker", args, { maxBuffer: 64 * 1024 * 1024 });
		return { code: 0, stdout, stderr };
	} catch (error: unknown) {
		if (isExitError(error)) return { code: error.code, stdout: error.stdout, stderr: error.stderr };
		throw error;
	}
}

async function dockerOrThrow(args: readonly string[]): Promise<string> {
	const result = await docker(args);
	if (result.code !== 0) {
		throw new Error(`docker ${args[0]} failed (${result.code}): ${result.stderr.trim()}`);
	}
	return result.stdout;
}

/** 把 daemon 二进制和 launch.sh 放进构建上下文，构建沙箱镜像。 */
export async function buildImage(): Promise<void> {
	await mkdir(BUILD_CONTEXT, { recursive: true });
	await copyFile(packagedDaemon({ platform: "linux", arch: "x64" }), resolve(BUILD_CONTEXT, "pi-env"));
	await copyFile(resolve(SPIKE_DIR, "launch.sh"), resolve(BUILD_CONTEXT, "launch.sh"));
	await dockerOrThrow([
		"build",
		"--quiet",
		"--label",
		LABEL,
		"--tag",
		IMAGE,
		"--file",
		resolve(SPIKE_DIR, "sandbox.Dockerfile"),
		BUILD_CONTEXT,
	]);
}

export async function startContainer(name: string, options: ContainerOptions = {}): Promise<string> {
	const target = options.target ?? "/workspace";
	const propagation = options.propagation ? `:${options.propagation}` : "";
	const mount = options.workspace ? ["--volume", `${resolve(options.workspace)}:${target}${propagation}`] : [];
	const user = options.user ? ["--user", options.user] : [];
	await dockerOrThrow([
		"run",
		"--detach",
		"--name",
		name,
		"--label",
		LABEL,
		...LIMITS,
		...user,
		...mount,
		options.image ?? IMAGE,
		"sleep",
		"infinity",
	]);
	return name;
}

/** 删除容器；容器不存在时什么也不做。 */
export async function removeContainer(name: string): Promise<void> {
	await docker(["rm", "--force", name]);
}

export async function dockerExec(name: string, script: string): Promise<CommandResult> {
	return docker(["exec", name, "sh", "-c", script]);
}

/** 给 `ConnectionOptions.command` 用；Connection 会在末尾追加 `serve --token <hex>`。 */
export function daemonCommand(name: string, epoch: number): string[] {
	return ["docker", "exec", "-i", name, "/opt/tether/launch.sh", String(epoch)];
}

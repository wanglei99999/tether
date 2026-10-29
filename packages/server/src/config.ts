import { resolve } from "node:path";
import { DEFAULT_MAX_RUNNING_SANDBOXES, TetherError } from "@tether/core";

/** 工作区镜像的默认大小。镜像是稀疏文件，不预占这么多。 */
const DEFAULT_DISK_MB = 10_240;

export interface Config {
	/** tether.sqlite、engine.sqlite 和工作区都在这里。 */
	dataDir: string;
	host: string;
	port: number;
	/** 设置后所有请求都要带 Bearer token（Task 11）。 */
	token?: string;
	workspaceRoot: string;
	/** 存档放在这里（<dataDir>/checkpoints），必须和 workspaceRoot 在同一个文件系统上。 */
	checkpointRoot: string;
	/** 工作区的存法（TETHER_WORKSPACE_STORAGE）：auto 启动时探测 reflink，能用就是 image。 */
	workspaceStorage: "auto" | "image" | "directory";
	/** 没填 diskMb 时工作区镜像的大小（TETHER_DEFAULT_DISK_MB，默认 10240）。 */
	defaultDiskMb: number;
	sandboxImage: string;
	/** 沙箱容器的运行时（TETHER_SANDBOX_RUNTIME，例如 gVisor 的 runsc）；不设则用 Docker 默认的 runc。 */
	sandboxRuntime?: string;
	/** 每条 setup 命令的上限（TETHER_SETUP_TIMEOUT_SECONDS，默认 600 秒）。 */
	setupTimeoutMs: number;
	/** 同时运行的沙箱上限（TETHER_MAX_RUNNING_SANDBOXES，默认 4）。 */
	maxRunningSandboxes: number;
	/** 沙箱闲置多久后停止（TETHER_STOP_AFTER_SECONDS，默认 3600 秒）。 */
	stopAfterMs: number;
	/** 停止后再闲置多久删除沙箱（先存最终存档；TETHER_DESTROY_AFTER_SECONDS，默认 7 天），必须长于 stopAfterMs。 */
	destroyAfterMs: number;
	/** 拉取模板镜像的上限（TETHER_IMAGE_PULL_TIMEOUT_SECONDS，默认 600 秒）。 */
	imagePullTimeoutMs: number;
	/** 存档所在的盘空闲低于这个百分比就稀疏化（TETHER_CHECKPOINT_MIN_FREE_PERCENT，默认 10）。 */
	checkpointMinFreePercent: number;
	/** 巡检间隔（TETHER_SWEEP_INTERVAL_SECONDS，默认 60 秒）。 */
	sweepIntervalMs: number;
}

/** 0 到 100 之间（不含 100）的百分比；0 表示不稀疏化。 */
function percent(env: NodeJS.ProcessEnv, name: string, defaultValue: number): number {
	const raw = setting(env, name);
	if (raw === undefined) return defaultValue;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0 || value >= 100) {
		throw new TetherError("invalid_request", `${name} must be a percentage from 0 to below 100, got ${raw}`);
	}
	return value;
}

/** 以秒配置的时长，转成毫秒；必须是正数。 */
function duration(env: NodeJS.ProcessEnv, name: string, defaultSeconds: number): number {
	const raw = setting(env, name);
	if (raw === undefined) return defaultSeconds * 1000;
	const seconds = Number(raw);
	if (!Number.isFinite(seconds) || seconds <= 0) {
		throw new TetherError("invalid_request", `${name} must be a positive number, got ${raw}`);
	}
	return Math.round(seconds * 1000);
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, defaultValue: number): number {
	const raw = setting(env, name);
	if (raw === undefined) return defaultValue;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		throw new TetherError("invalid_request", `${name} must be a positive integer, got ${raw}`);
	}
	return value;
}

const STORAGE_MODES = ["auto", "image", "directory"] as const;

function workspaceStorage(raw: string | undefined): Config["workspaceStorage"] {
	if (raw === undefined) return "auto";
	const mode = STORAGE_MODES.find((m) => m === raw);
	if (!mode) {
		throw new TetherError("invalid_request", `TETHER_WORKSPACE_STORAGE must be one of ${STORAGE_MODES.join(", ")}, got ${raw}`);
	}
	return mode;
}

/** 空字符串和未设置同样处理：`TETHER_DATA_DIR=` 不应该把数据写进当前目录。 */
function setting(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const value = env[name];
	return value === undefined || value === "" ? undefined : value;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
	const dataDir = resolve(setting(env, "TETHER_DATA_DIR") ?? "./data");
	const rawPort = setting(env, "TETHER_PORT") ?? "7420";
	const port = Number(rawPort);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new TetherError("invalid_request", `TETHER_PORT must be a port number, got ${rawPort}`);
	}
	const token = setting(env, "TETHER_TOKEN");
	const sandboxRuntime = setting(env, "TETHER_SANDBOX_RUNTIME");
	const stopAfterMs = duration(env, "TETHER_STOP_AFTER_SECONDS", 3600);
	const destroyAfterMs = duration(env, "TETHER_DESTROY_AFTER_SECONDS", 7 * 24 * 3600);
	// 都从最后一次使用算起：删除不晚于停止的话，运行中的沙箱会先被停掉，停止这一档就没有意义了
	if (destroyAfterMs <= stopAfterMs) {
		throw new TetherError(
			"invalid_request",
			`TETHER_DESTROY_AFTER_SECONDS must be longer than TETHER_STOP_AFTER_SECONDS (${stopAfterMs / 1000})`,
		);
	}
	return {
		dataDir,
		host: setting(env, "TETHER_HOST") ?? "127.0.0.1",
		port,
		...(token !== undefined && { token }),
		workspaceRoot: resolve(dataDir, "workspaces"),
		checkpointRoot: resolve(dataDir, "checkpoints"),
		workspaceStorage: workspaceStorage(setting(env, "TETHER_WORKSPACE_STORAGE")),
		defaultDiskMb: positiveInteger(env, "TETHER_DEFAULT_DISK_MB", DEFAULT_DISK_MB),
		sandboxImage: setting(env, "TETHER_SANDBOX_IMAGE") ?? "tether-sandbox:dev",
		...(sandboxRuntime !== undefined && { sandboxRuntime }),
		setupTimeoutMs: duration(env, "TETHER_SETUP_TIMEOUT_SECONDS", 600),
		maxRunningSandboxes: positiveInteger(env, "TETHER_MAX_RUNNING_SANDBOXES", DEFAULT_MAX_RUNNING_SANDBOXES),
		stopAfterMs,
		destroyAfterMs,
		checkpointMinFreePercent: percent(env, "TETHER_CHECKPOINT_MIN_FREE_PERCENT", 10),
		imagePullTimeoutMs: duration(env, "TETHER_IMAGE_PULL_TIMEOUT_SECONDS", 600),
		sweepIntervalMs: duration(env, "TETHER_SWEEP_INTERVAL_SECONDS", 60),
	};
}

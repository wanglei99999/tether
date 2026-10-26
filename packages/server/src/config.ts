import { resolve } from "node:path";
import { DEFAULT_MAX_RUNNING_SANDBOXES, TetherError } from "@tether/core";

export interface Config {
	/** tether.sqlite、engine.sqlite 和工作区都在这里。 */
	dataDir: string;
	host: string;
	port: number;
	/** 设置后所有请求都要带 Bearer token（Task 11）。 */
	token?: string;
	workspaceRoot: string;
	sandboxImage: string;
	/** 每条 setup 命令的上限（TETHER_SETUP_TIMEOUT_SECONDS，默认 600 秒）。 */
	setupTimeoutMs: number;
	/** 同时运行的沙箱上限（TETHER_MAX_RUNNING_SANDBOXES，默认 4）。 */
	maxRunningSandboxes: number;
	/** 沙箱闲置多久后停止（TETHER_STOP_AFTER_SECONDS，默认 3600 秒）。 */
	stopAfterMs: number;
	/** 巡检间隔（TETHER_SWEEP_INTERVAL_SECONDS，默认 60 秒）。 */
	sweepIntervalMs: number;
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

function maxRunningSandboxes(raw: string | undefined): number {
	if (raw === undefined) return DEFAULT_MAX_RUNNING_SANDBOXES;
	const limit = Number(raw);
	if (!Number.isInteger(limit) || limit <= 0) {
		throw new TetherError("invalid_request", `TETHER_MAX_RUNNING_SANDBOXES must be a positive integer, got ${raw}`);
	}
	return limit;
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
	return {
		dataDir,
		host: setting(env, "TETHER_HOST") ?? "127.0.0.1",
		port,
		...(token !== undefined && { token }),
		workspaceRoot: resolve(dataDir, "workspaces"),
		sandboxImage: setting(env, "TETHER_SANDBOX_IMAGE") ?? "tether-sandbox:dev",
		setupTimeoutMs: duration(env, "TETHER_SETUP_TIMEOUT_SECONDS", 600),
		maxRunningSandboxes: maxRunningSandboxes(setting(env, "TETHER_MAX_RUNNING_SANDBOXES")),
		stopAfterMs: duration(env, "TETHER_STOP_AFTER_SECONDS", 3600),
		sweepIntervalMs: duration(env, "TETHER_SWEEP_INTERVAL_SECONDS", 60),
	};
}

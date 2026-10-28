import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
	it("uses the documented defaults", () => {
		expect(loadConfig({})).toEqual({
			dataDir: resolve("./data"),
			host: "127.0.0.1",
			port: 7420,
			workspaceRoot: resolve("./data/workspaces"),
			checkpointRoot: resolve("./data/checkpoints"),
			workspaceStorage: "auto",
			defaultDiskMb: 10_240,
			sandboxImage: "tether-sandbox:dev",
			setupTimeoutMs: 600_000,
			maxRunningSandboxes: 4,
			stopAfterMs: 3_600_000,
			destroyAfterMs: 604_800_000,
			checkpointMinFreePercent: 10,
			imagePullTimeoutMs: 600_000,
			sweepIntervalMs: 60_000,
		});
	});

	it("reads TETHER_* settings", () => {
		const config = loadConfig({
			TETHER_DATA_DIR: "/srv/tether",
			TETHER_HOST: "0.0.0.0",
			TETHER_PORT: "8080",
			TETHER_TOKEN: "secret",
			TETHER_SANDBOX_IMAGE: "custom:1",
			TETHER_SETUP_TIMEOUT_SECONDS: "90",
			TETHER_MAX_RUNNING_SANDBOXES: "2",
			TETHER_STOP_AFTER_SECONDS: "1800",
			TETHER_DESTROY_AFTER_SECONDS: "86400",
			TETHER_CHECKPOINT_MIN_FREE_PERCENT: "25",
			TETHER_IMAGE_PULL_TIMEOUT_SECONDS: "120",
			TETHER_SWEEP_INTERVAL_SECONDS: "0.5",
		});

		expect(config).toEqual({
			dataDir: "/srv/tether",
			host: "0.0.0.0",
			port: 8080,
			token: "secret",
			workspaceRoot: "/srv/tether/workspaces",
			checkpointRoot: "/srv/tether/checkpoints",
			workspaceStorage: "auto",
			defaultDiskMb: 10_240,
			sandboxImage: "custom:1",
			setupTimeoutMs: 90_000,
			maxRunningSandboxes: 2,
			stopAfterMs: 1_800_000,
			destroyAfterMs: 86_400_000,
			checkpointMinFreePercent: 25,
			imagePullTimeoutMs: 120_000,
			sweepIntervalMs: 500,
		});
	});

	it("reads TETHER_SANDBOX_RUNTIME, and leaves it unset by default", () => {
		expect(loadConfig({ TETHER_SANDBOX_RUNTIME: "runsc" }).sandboxRuntime).toBe("runsc");
		expect("sandboxRuntime" in loadConfig({})).toBe(false);
		expect("sandboxRuntime" in loadConfig({ TETHER_SANDBOX_RUNTIME: "" })).toBe(false);
	});

	it("treats empty values as unset", () => {
		expect(loadConfig({ TETHER_DATA_DIR: "", TETHER_PORT: "", TETHER_TOKEN: "" })).toEqual(loadConfig({}));
	});

	it("rejects a port that is not a port number", () => {
		expect(() => loadConfig({ TETHER_PORT: "http" })).toThrow(/TETHER_PORT/);
		expect(() => loadConfig({ TETHER_PORT: "70000" })).toThrow(/TETHER_PORT/);
	});

	it("rejects durations that are not a positive number of seconds", () => {
		for (const name of [
			"TETHER_SETUP_TIMEOUT_SECONDS",
			"TETHER_STOP_AFTER_SECONDS",
			"TETHER_DESTROY_AFTER_SECONDS",
			"TETHER_IMAGE_PULL_TIMEOUT_SECONDS",
			"TETHER_SWEEP_INTERVAL_SECONDS",
		]) {
			for (const value of ["0", "-5", "ten"]) {
				expect(() => loadConfig({ [name]: value }), `${name}=${value}`).toThrow(new RegExp(name));
			}
		}
	});

	it("accepts a free-space floor from 0 to below 100 percent", () => {
		expect(loadConfig({ TETHER_CHECKPOINT_MIN_FREE_PERCENT: "0" }).checkpointMinFreePercent).toBe(0);
		expect(loadConfig({ TETHER_CHECKPOINT_MIN_FREE_PERCENT: "2.5" }).checkpointMinFreePercent).toBe(2.5);
		for (const value of ["100", "-1", "ten"]) {
			expect(() => loadConfig({ TETHER_CHECKPOINT_MIN_FREE_PERCENT: value }), value).toThrow(/TETHER_CHECKPOINT_MIN_FREE_PERCENT/);
		}
	});

	it("requires TETHER_DESTROY_AFTER_SECONDS to be longer than TETHER_STOP_AFTER_SECONDS", () => {
		for (const destroy of ["3600", "60"]) {
			expect(() => loadConfig({ TETHER_STOP_AFTER_SECONDS: "3600", TETHER_DESTROY_AFTER_SECONDS: destroy }), destroy).toThrow(
				expect.objectContaining({ code: "invalid_request", message: expect.stringMatching(/TETHER_DESTROY_AFTER_SECONDS/) }),
			);
		}
		expect(loadConfig({ TETHER_STOP_AFTER_SECONDS: "3600", TETHER_DESTROY_AFTER_SECONDS: "3601" }).destroyAfterMs).toBe(3_601_000);
	});

	it("reads the workspace storage mode and accepts only auto, image and directory", () => {
		expect(loadConfig({ TETHER_WORKSPACE_STORAGE: "image" }).workspaceStorage).toBe("image");
		expect(loadConfig({ TETHER_WORKSPACE_STORAGE: "directory" }).workspaceStorage).toBe("directory");
		expect(() => loadConfig({ TETHER_WORKSPACE_STORAGE: "xfs" })).toThrow(
			expect.objectContaining({ code: "invalid_request", message: expect.stringMatching(/TETHER_WORKSPACE_STORAGE/) }),
		);
	});

	it("reads the default disk size and rejects one that is not a positive integer", () => {
		expect(loadConfig({ TETHER_DEFAULT_DISK_MB: "2048" }).defaultDiskMb).toBe(2048);
		for (const value of ["0", "-1", "abc", "1.5"]) {
			expect(() => loadConfig({ TETHER_DEFAULT_DISK_MB: value }), value).toThrow(/TETHER_DEFAULT_DISK_MB/);
		}
	});

	it("rejects a sandbox limit that is not a positive integer", () => {
		for (const value of ["0", "-1", "abc", "1.5"]) {
			expect(() => loadConfig({ TETHER_MAX_RUNNING_SANDBOXES: value }), value).toThrow(
				expect.objectContaining({ code: "invalid_request", message: expect.stringMatching(/TETHER_MAX_RUNNING_SANDBOXES/) }),
			);
		}
	});
});

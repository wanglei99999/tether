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
			sandboxImage: "tether-sandbox:dev",
			setupTimeoutMs: 600_000,
			maxRunningSandboxes: 4,
			stopAfterMs: 3_600_000,
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
			TETHER_SWEEP_INTERVAL_SECONDS: "0.5",
		});

		expect(config).toEqual({
			dataDir: "/srv/tether",
			host: "0.0.0.0",
			port: 8080,
			token: "secret",
			workspaceRoot: "/srv/tether/workspaces",
			sandboxImage: "custom:1",
			setupTimeoutMs: 90_000,
			maxRunningSandboxes: 2,
			stopAfterMs: 1_800_000,
			sweepIntervalMs: 500,
		});
	});

	it("treats empty values as unset", () => {
		expect(loadConfig({ TETHER_DATA_DIR: "", TETHER_PORT: "", TETHER_TOKEN: "" })).toEqual(loadConfig({}));
	});

	it("rejects a port that is not a port number", () => {
		expect(() => loadConfig({ TETHER_PORT: "http" })).toThrow(/TETHER_PORT/);
		expect(() => loadConfig({ TETHER_PORT: "70000" })).toThrow(/TETHER_PORT/);
	});

	it("rejects durations that are not a positive number of seconds", () => {
		for (const name of ["TETHER_SETUP_TIMEOUT_SECONDS", "TETHER_STOP_AFTER_SECONDS", "TETHER_SWEEP_INTERVAL_SECONDS"]) {
			for (const value of ["0", "-5", "ten"]) {
				expect(() => loadConfig({ [name]: value }), `${name}=${value}`).toThrow(new RegExp(name));
			}
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

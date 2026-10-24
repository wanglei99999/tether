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
		});
	});

	it("reads TETHER_* settings", () => {
		const config = loadConfig({
			TETHER_DATA_DIR: "/srv/tether",
			TETHER_HOST: "0.0.0.0",
			TETHER_PORT: "8080",
			TETHER_TOKEN: "secret",
			TETHER_SANDBOX_IMAGE: "custom:1",
		});

		expect(config).toEqual({
			dataDir: "/srv/tether",
			host: "0.0.0.0",
			port: 8080,
			token: "secret",
			workspaceRoot: "/srv/tether/workspaces",
			sandboxImage: "custom:1",
		});
	});

	it("treats empty values as unset", () => {
		expect(loadConfig({ TETHER_DATA_DIR: "", TETHER_PORT: "", TETHER_TOKEN: "" })).toEqual(loadConfig({}));
	});

	it("rejects a port that is not a port number", () => {
		expect(() => loadConfig({ TETHER_PORT: "http" })).toThrow(/TETHER_PORT/);
		expect(() => loadConfig({ TETHER_PORT: "70000" })).toThrow(/TETHER_PORT/);
	});
});

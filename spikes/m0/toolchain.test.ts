import { existsSync } from "node:fs";
import { Harness } from "@earendil-works/pi-durable";
import { packagedDaemon } from "@earendil-works/pi-env";
import { describe, expect, it } from "vitest";

describe("toolchain", () => {
	it("ships the linux-x64 daemon", () => {
		expect(existsSync(packagedDaemon({ platform: "linux", arch: "x64" }))).toBe(true);
	});

	it("imports pi-durable", () => {
		expect(typeof Harness.open).toBe("function");
	});
});

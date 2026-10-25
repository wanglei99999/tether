import { Connection, isConnectionLost } from "@earendil-works/pi-env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildImage, daemonCommand, dockerExec, removeContainer, startContainer } from "./docker.ts";

const CONTAINER = "tether-m0-conn";
const MISSING = "tether-m0-missing";

describe("pi-env daemon in a container", () => {
	const connection = new Connection({ command: daemonCommand(CONTAINER, 1) });
	const missing = new Connection({ command: daemonCommand(MISSING, 1) });

	beforeAll(async () => {
		await buildImage();
		await removeContainer(CONTAINER);
		await startContainer(CONTAINER);
	}, 600_000);

	afterAll(async () => {
		connection.close();
		missing.close();
		await removeContainer(CONTAINER);
	});

	it("answers hello from inside the container", async () => {
		const info = await connection.info();
		expect(info.os).toBe("linux");
		expect(info.arch).toBe("x86_64");
		expect(info.cwd).toBe("/workspace");
	});

	it("records the daemon under its epoch and PID", async () => {
		const info = await connection.info();
		const { stdout } = await dockerExec(CONTAINER, "ls /run/tether/daemons");
		// launch.sh 用 exec 换成 daemon，记录里的 PID 就是 daemon 自己的 PID
		expect(stdout).toBe(`1.${info.pid}\n`);
	});

	it("fails with a lost error when the container is gone", async () => {
		const error: unknown = await missing.info().catch((e: unknown) => e);
		expect(isConnectionLost(error)).toBe(true);
	}, 30_000);
});

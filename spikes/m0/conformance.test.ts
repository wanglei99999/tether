import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildImage, daemonCommand, dockerExec, removeContainer, startContainer } from "./docker.ts";

const CONTAINER = "tether-m0-conformance";
const connection = new Connection({ command: daemonCommand(CONTAINER, 1) });

beforeAll(async () => {
	await buildImage();
	await removeContainer(CONTAINER);
	await startContainer(CONTAINER);
}, 600_000);

afterAll(async () => {
	connection.close();
	await removeContainer(CONTAINER);
});

/** 每个用例一个容器内的新目录；不能像上游那样用宿主的 mkdtempSync，路径必须在容器里。 */
async function caseDir(): Promise<string> {
	const { code, stdout, stderr } = await dockerExec(CONTAINER, "mktemp -d /workspace/case-XXXXXX");
	if (code !== 0) throw new Error(`mktemp failed in ${CONTAINER}: ${stderr.trim()}`);
	return stdout.trim();
}

registerEnvConformance(
	{ describe, expect, it },
	"RemoteExecutionEnv in Docker",
	async (use) => {
		const cwd = await caseDir();
		try {
			await use(
				new RemoteExecutionEnv({ connection, id: `docker:${CONTAINER}`, cwd, watch: { pollIntervalMs: 100 } }),
			);
		} finally {
			await dockerExec(CONTAINER, `rm -rf '${cwd}'`);
		}
	},
	{ listFiles: true },
);

import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildImage, docker, dockerExec, IMAGE, LABEL, removeContainer, startContainer } from "./docker.ts";
import { assertPidIsolated, fencedCommand } from "./fence.ts";
import { context } from "./harness.ts";

const TMP = resolve(".tmp");
const OBSERVE = "tether-m0-orphan";
const FENCE = "tether-m0-fence";
const PID_HOST = "tether-m0-pidhost";
/** holder 的命令先建这个标记文件，再 sleep 300，最后写 late.txt。 */
const STARTED = "test -e /workspace/holder.started";
/** 方括号让模式不匹配 pgrep 所在的 sh 自己的命令行。 */
const OLD_SLEEP = "pgrep -f '[s]leep 300'";
const OLD_DAEMON = "pgrep -f '[p]i-env serve'";

interface Holder {
	process: ChildProcess;
	exited: Promise<void>;
}

/** 在子进程里以 epoch 1 连上容器，开始执行长命令，等到命令真正开始。 */
async function startHolder(container: string): Promise<Holder> {
	const child = spawn(process.execPath, [resolve("spikes/m0/holder.ts"), container, "1"], {
		stdio: ["ignore", "inherit", "inherit"],
	});
	const exited = new Promise<void>((done) => child.once("exit", () => done()));
	const deadline = Date.now() + 60_000;
	while ((await dockerExec(container, STARTED)).code !== 0) {
		if (Date.now() > deadline) throw new Error(`holder did not start its command in ${container}`);
		await sleep(100);
	}
	return { process: child, exited };
}

async function stopHolder(holder: Holder): Promise<void> {
	holder.process.kill("SIGKILL");
	await holder.exited;
}

async function freshContainer(name: string): Promise<void> {
	await removeContainer(name);
	await startContainer(name);
}

beforeAll(async () => {
	await buildImage();
	await mkdir(TMP, { recursive: true });
}, 600_000);

afterAll(async () => {
	await Promise.all([OBSERVE, FENCE, PID_HOST].map(removeContainer));
});

describe("old commands after the harness fails", () => {
	it.each(["SIGKILL", "SIGSTOP"] as const)(
		"observes the old command after %s of its holder",
		async (signal) => {
			await freshContainer(OBSERVE);
			const holder = await startHolder(OBSERVE);
			const failedAt = Date.now();
			holder.process.kill(signal);

			const samples: { atSeconds: number; oldSleep: boolean; oldDaemon: boolean }[] = [];
			try {
				for (const atSeconds of [1, 10, 40]) {
					await sleep(failedAt + atSeconds * 1000 - Date.now());
					samples.push({
						atSeconds,
						oldSleep: (await dockerExec(OBSERVE, OLD_SLEEP)).code === 0,
						oldDaemon: (await dockerExec(OBSERVE, OLD_DAEMON)).code === 0,
					});
				}
			} finally {
				await stopHolder(holder);
			}
			const lateWritten = (await dockerExec(OBSERVE, "test -e /workspace/late.txt")).code === 0;
			await writeFile(
				resolve(TMP, `orphan-observation-${signal}.json`),
				`${JSON.stringify({ signal, samples, lateWritten }, null, "\t")}\n`,
			);
			expect(samples.at(-1)!.oldSleep).toBe(false);
		},
		120_000,
	);
});

describe("epoch fencing", () => {
	it("fences the previous epoch before the new daemon serves", async () => {
		await freshContainer(FENCE);
		const holder = await startHolder(FENCE);
		// 挂起而不是杀死：管道还开着，旧 daemon 不会因为 EOF 自己退出
		holder.process.kill("SIGSTOP");

		let epoch = 1;
		const connection = new Connection({ command: fencedCommand(FENCE, () => ++epoch) });
		const env = new RemoteExecutionEnv({ connection, id: `docker:${FENCE}`, cwd: "/workspace" });
		try {
			const result = await env.exec("echo fresh > /workspace/fresh.txt", undefined, context);
			expect(result.ok && result.value.exitCode).toBe(0);

			expect((await dockerExec(FENCE, OLD_SLEEP)).code).toBe(1);
			expect((await dockerExec(FENCE, "ls /run/tether/daemons")).stdout).toMatch(/^2\.\d+\n$/);

			// 超过 daemon 30 秒的静默期之后：旧命令没有机会写出 late.txt，新连接仍然可用
			await sleep(35_000);
			expect((await dockerExec(FENCE, "test -e /workspace/late.txt")).code).toBe(1);
			const again = await env.exec("cat /workspace/fresh.txt", undefined, context);
			expect(again.ok && again.value.exitCode).toBe(0);
			expect(epoch).toBe(2);
		} finally {
			connection.close();
			await stopHolder(holder);
		}
	}, 120_000);

	it("refuses to fence a container that shares the host's PID namespace", async () => {
		// 只验证检查本身，不对这个容器执行 kill：检查一旦有 bug，kill -1 会杀掉整台机器的进程
		await removeContainer(PID_HOST);
		const run = await docker(["run", "--detach", "--name", PID_HOST, "--label", LABEL, "--pid", "host", IMAGE, "sleep", "infinity"]);
		expect(run.code).toBe(0);
		await expect(assertPidIsolated(PID_HOST)).rejects.toThrow(/PID namespace/);
		await expect(assertPidIsolated(OBSERVE)).resolves.toBeUndefined();
	});
});

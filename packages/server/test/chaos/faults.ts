import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const REPO = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const RUN_SERVER = "packages/server/test/fixtures/run-chaos-tether.ts";
const START_TIMEOUT_MS = 120_000;

export const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** 命令的标准输出；失败时返回 undefined，故障注入的目标可能已经不在了。 */
export async function tryCommand(file: string, args: string[]): Promise<string | undefined> {
	try {
		return (await run(file, args)).stdout;
	} catch {
		return undefined;
	}
}

/** 子进程里的 Tether 服务端，可以反复杀掉再启动。 */
export class ServerProcess {
	#child: ChildProcess | undefined;
	readonly #env: NodeJS.ProcessEnv;
	readonly #logFile: string;

	constructor(env: NodeJS.ProcessEnv, logFile: string) {
		this.#env = env;
		this.#logFile = logFile;
	}

	get pid(): number | undefined {
		return this.#child?.pid;
	}

	async start(): Promise<void> {
		const child = spawn(process.execPath, [RUN_SERVER], {
			cwd: REPO,
			env: { ...process.env, ...this.#env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		this.#child = child;
		const log = createWriteStream(this.#logFile, { flags: "a" });
		child.stderr?.pipe(log);
		await new Promise<void>((done, fail) => {
			const timer = setTimeout(() => fail(new Error("server did not start in time")), START_TIMEOUT_MS);
			child.stdout?.on("data", (chunk: Buffer) => {
				log.write(chunk);
				if (chunk.toString().includes("listening")) {
					clearTimeout(timer);
					done();
				}
			});
			child.once("exit", (code, signal) => {
				clearTimeout(timer);
				fail(new Error(`server exited during startup (${code ?? signal})`));
			});
		});
	}

	async stop(signal: NodeJS.Signals): Promise<void> {
		const child = this.#child;
		if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
		const exited = new Promise<void>((done) => child.once("exit", () => done()));
		child.kill(signal);
		await exited;
	}
}

/** 服务端持有的、连到这个容器的 docker exec 客户端。Docker 后端没有网络可切，挂起它等于连接卡住。 */
export async function execClients(serverPid: number, container: string): Promise<number[]> {
	const out = await tryCommand("ps", ["-o", "pid=,args=", "--ppid", String(serverPid)]);
	return (out ?? "")
		.split("\n")
		.filter((line) => line.includes("docker exec") && line.includes(container) && line.includes("launch.sh"))
		.map((line) => Number.parseInt(line.trim(), 10));
}

export async function containerExists(container: string): Promise<boolean> {
	return (await tryCommand("docker", ["inspect", "--type", "container", container])) !== undefined;
}

/** 这一轮的数据目录下还接着的 loop 设备。只认这个目录，loop0 上的测试盘绝不能动。 */
export async function loopDevices(dataDir: string): Promise<string[]> {
	const out = await tryCommand("losetup", ["--list", "--noheadings", "--output", "NAME,BACK-FILE"]);
	return (out ?? "").split("\n").flatMap((line) => {
		const [device, file] = line.trim().split(/\s+/);
		return device && file?.startsWith(`${dataDir}/`) ? [device] : [];
	});
}

/** 中途失败的轮次用：删掉这些会话的容器和卷，释放这一轮的 loop 设备。 */
export async function cleanupRound(sessionIds: readonly string[], dataDir: string, image: string): Promise<void> {
	for (const id of sessionIds) {
		await tryCommand("docker", ["rm", "-f", `tether-${id}`]);
		await tryCommand("docker", ["volume", "rm", "-f", `tether-${id}`]);
	}
	for (const device of await loopDevices(dataDir)) {
		await tryCommand("docker", ["run", "--rm", "--privileged", "--entrypoint", "losetup", image, "--detach", device]);
	}
}

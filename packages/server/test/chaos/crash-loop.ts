import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TetherClient } from "@tether/sdk";
import { chaosMessage } from "@tether/testkit";
import { chaosSpec, freePort, untilUp } from "./driver.ts";
import { cleanupRound, execClients, ServerProcess, sleep } from "./faults.ts";

/**
 * 连续崩溃：pi 1.4.0 把进程死时处于 running 的任务各计一次，任务提交新状态后清零，
 * 到 settings.restartLimit（默认 5）就停下不再重跑。随机时间表碰不到，这里连续杀。
 */

const WATCH_TIMEOUT_MS = 180_000;
const ABORT_TIMEOUT_MS = 30_000;
const EXEC_WAIT_MS = 20_000;

/** 杀的时机。early：启动后立刻，模型请求和存档的钩子里；spaced：隔开一点，工作有进展；tool：工具执行中。 */
export type CrashPosition = "early" | "spaced" | "tool";

export interface CrashLoopReport {
	position: CrashPosition;
	kills: number;
	/** 最后放它跑时，这条消息的结果；pending 是到期限还没结束。 */
	status: string;
	parkedReports: number;
	/** 卡住时：中止请求之后会话的 running，和新消息能不能得到回答。 */
	afterAbort?: { running: boolean; next: string };
	interrupted: number;
	logTail: string[];
}

async function raced<T>(work: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
	return Promise.race([work.catch(() => fallback), sleep(timeoutMs).then(() => fallback)]);
}

export async function runCrashLoop(options: {
	position: CrashPosition;
	kills: number;
	root: string;
	image: string;
}): Promise<CrashLoopReport> {
	const dataDir = join(options.root, `crash-loop-${options.position}`);
	rmSync(dataDir, { recursive: true, force: true });
	mkdirSync(dataDir, { recursive: true });
	const logFile = join(dataDir, "server.log");
	const port = await freePort();
	const server = new ServerProcess(
		{
			TETHER_DATA_DIR: dataDir,
			TETHER_PORT: String(port),
			TETHER_SANDBOX_IMAGE: options.image,
			TETHER_SWEEP_INTERVAL_SECONDS: "2",
		},
		logFile,
	);
	const client = new TetherClient({ baseUrl: `http://127.0.0.1:${port}` });
	const sessionIds: string[] = [];

	try {
		await server.start();
		const { agent } = await client.agents.create({ name: "crash-loop", spec: chaosSpec(undefined) });
		const session = await client.sessions.create({ agentId: agent.id });
		sessionIds.push(session.id);
		const { submissionId } = await client.sessions.send(session.id, chaosMessage(0, 0), { requestId: "crash-loop" });

		const killPoint = async () => {
			if (options.position === "early") return;
			if (options.position === "spaced") {
				await sleep(1_500);
				return;
			}
			const deadline = Date.now() + EXEC_WAIT_MS;
			while (Date.now() < deadline) {
				const pid = server.pid;
				if (pid !== undefined && (await execClients(pid, `tether-${session.id}`)).length > 0) return;
				await sleep(100);
			}
		};

		for (let kill = 0; kill < options.kills; kill += 1) {
			await killPoint();
			await server.stop("SIGKILL");
			await server.start();
		}

		const wait = untilUp(() => client.sessions.waitSubmission(session.id, submissionId)).then((r) => r.status as string);
		const status = await raced(wait, WATCH_TIMEOUT_MS, "pending");

		let afterAbort: CrashLoopReport["afterAbort"];
		if (status === "pending") {
			await client.sessions.abort(session.id).catch(() => {});
			await sleep(ABORT_TIMEOUT_MS);
			const { items } = await client.sessions.transcript(session.id, { limit: 1 });
			const next = client.sessions
				.send(session.id, chaosMessage(0, 1), { requestId: "crash-loop-after" })
				.then((sent) => client.sessions.waitSubmission(session.id, sent.submissionId))
				.then((r) => r.status as string);
			afterAbort = {
				running: items.length === 0,
				next: await raced(next, WATCH_TIMEOUT_MS, "pending"),
			};
		}
		const { items } = await client.sessions.transcript(session.id, { limit: 100 });
		const log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
		await client.sessions.archive(session.id).catch(() => {});
		return {
			position: options.position,
			kills: options.kills,
			status,
			parkedReports: (log.match(/parked until retryTask/g) ?? []).length,
			...(afterAbort && { afterAbort }),
			interrupted: items.filter((e) => e.toolResult?.isError && /interrupt/i.test(e.toolResult.text)).length,
			logTail: log.split("\n").filter(Boolean).slice(-5),
		};
	} finally {
		await server.stop("SIGKILL");
		await cleanupRound(sessionIds, dataDir, options.image);
		rmSync(dataDir, { recursive: true, force: true });
	}
}

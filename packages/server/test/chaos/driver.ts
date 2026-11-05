import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentVersionSpec, RunStatus, TranscriptEntry } from "@tether/core";
import { type SessionStream, TetherApiError, TetherClient } from "@tether/sdk";
import {
	chaosMessage,
	checkRound,
	createRandom,
	type Fault,
	type ForkHistory,
	inspectMessage,
	planRound,
	type RoundPlan,
	type SendRecord,
	type SessionHistory,
	type Violation,
} from "@tether/testkit";
import { FAUX_MODEL } from "../fixtures/faux.ts";
import { cleanupRound, containerExists, execClients, loopDevices, ServerProcess, sleep, tryCommand } from "./faults.ts";

const run = promisify(execFile);

/** 故障结束后每个提交的期限（I0）。 */
const SETTLE_TIMEOUT_MS = 180_000;
const STREAM_SETTLE_MS = 15_000;
const STALL_KILL_DELAY_MS = 1_000;
/** 最后发两条消息：丢失恢复的说明写在一轮中途时，模型要到下一轮才看到。 */
const BARRIER_MESSAGES = 2;

export interface RoundOptions {
	seed: number;
	round: number;
	/** 放这一轮数据目录的地方，必须和 reflink 盘同一个文件系统。 */
	root: string;
	image: string;
	runtime?: string;
	storage?: "image" | "directory";
	sessions?: number;
	messages?: number;
	gapMs?: number;
	faults?: number;
	/** 用这份时间表代替随机生成的。 */
	plan?: RoundPlan;
	/** 破坏性对照：直接在容器里把一条命令再执行一次，必须判 I2 失败。 */
	sabotage?: "duplicate";
	keepFailed?: boolean;
}

export interface FaultEffect extends Fault {
	/** 这次故障确实碰到了东西：会话在运行、找到了连接、容器还在。 */
	hit: boolean;
}

export interface RoundReport {
	seed: number;
	round: number;
	durationMs: number;
	faults: FaultEffect[];
	/** 被打断、得到"已中断"结果的工具调用数。 */
	interrupted: number;
	/** 其他出错的工具调用数，例如巡检发现容器丢失之前的 sandbox_failed。 */
	toolErrors: number;
	violations: Violation[];
	/** 驱动程序自己出的错，比如服务端启动不起来。 */
	error?: string;
	dataDir?: string;
}

export function chaosSpec(storage: RoundOptions["storage"], setup: string[] = []): AgentVersionSpec {
	return {
		model: FAUX_MODEL,
		instructions: "chaos",
		tools: ["bash"],
		sandbox: {
			template: "",
			resources: { cpu: 1, memoryMb: 256, ...(storage !== "directory" && { diskMb: 512 }) },
			network: "none",
			setup,
			variables: [],
		},
		checkpointPolicy: "perRun",
		permissions: { denyTools: [], requireApproval: [] },
	};
}

export async function freePort(): Promise<number> {
	return new Promise((done, fail) => {
		const probe = createServer();
		probe.once("error", fail);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			probe.close(() => done(typeof address === "object" && address ? address.port : 0));
		});
	});
}

function isNetwork(error: unknown): boolean {
	return error instanceof TetherApiError && error.code === "network";
}

/** 服务端可能正在重启：网络错误一直重试，到期限为止。 */
export async function untilUp<T>(call: () => Promise<T>, timeoutMs = SETTLE_TIMEOUT_MS): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			return await call();
		} catch (error) {
			if (!isNetwork(error) || Date.now() > deadline) throw error;
			await sleep(250);
		}
	}
}

interface Tracked {
	label: string;
	id: string;
	sends: { requestId: string; content: string; submission: Promise<string> }[];
	stream: SessionStream;
	removed: boolean;
}

class Round {
	readonly #client: TetherClient;
	readonly #tracked: Tracked[] = [];
	readonly #stalled = new Set<number>();
	readonly sessionIds: string[] = [];

	constructor(client: TetherClient) {
		this.#client = client;
	}

	get tracked(): readonly Tracked[] {
		return this.#tracked;
	}

	async open(label: string, id: string): Promise<Tracked> {
		this.sessionIds.push(id);
		const stream = this.#client.follow(id, () => {});
		const tracked: Tracked = { label, id, sends: [], stream, removed: false };
		this.#tracked.push(tracked);
		return tracked;
	}

	send(session: Tracked, content: string): void {
		const requestId = `${session.label}-${content}`;
		const submission = untilUp(() => this.#client.sessions.send(session.id, content, { requestId })).then(
			(accepted) => accepted.submissionId,
		);
		session.sends.push({ requestId, content, submission });
	}

	/** 客户端不知道崩溃前的请求有没有收到，用同一个 requestId 再发一次（I1）。 */
	async resendLatest(): Promise<void> {
		await Promise.all(
			this.#tracked.flatMap((session) => {
				const latest = session.sends.at(-1);
				if (latest === undefined) return [];
				return [
					untilUp(() => this.#client.sessions.send(session.id, latest.content, { requestId: latest.requestId })).catch(
						() => {},
					),
				];
			}),
		);
	}

	async inject(fault: Fault, server: ServerProcess, kill: (downMs: number) => Promise<void>): Promise<FaultEffect> {
		const session = this.#tracked[fault.session]!;
		const container = `tether-${session.id}`;
		const clients = async () => (server.pid === undefined ? [] : execClients(server.pid, container));
		const stop = (pids: readonly number[]) => {
			for (const pid of pids) {
				process.kill(pid, "SIGSTOP");
				this.#stalled.add(pid);
			}
		};

		switch (fault.kind) {
			case "kill9": {
				const hit = (await clients()).length > 0;
				await kill(fault.downMs ?? 0);
				return { ...fault, hit };
			}
			case "stall": {
				const pids = await clients();
				stop(pids);
				const release = sleep(fault.holdMs ?? 0).then(() => {
					for (const pid of pids) {
						this.#stalled.delete(pid);
						try {
							process.kill(pid, "SIGCONT");
						} catch {
							// 服务端被杀时它可能已经退出了
						}
					}
				});
				this.#releases.push(release);
				return { ...fault, hit: pids.length > 0 };
			}
			case "stallThenKill": {
				const pids = await clients();
				stop(pids);
				await sleep(STALL_KILL_DELAY_MS);
				await kill(fault.downMs ?? 0);
				return { ...fault, hit: pids.length > 0 };
			}
			case "removeContainer": {
				const hit = await containerExists(container);
				if (hit && (await tryCommand("docker", ["rm", "-f", container])) !== undefined) session.removed = true;
				return { ...fault, hit };
			}
		}
	}

	readonly #releases: Promise<void>[] = [];

	async releaseStalls(): Promise<void> {
		await Promise.all(this.#releases);
	}

	/** 挂起后服务端被杀，孤儿 docker exec 一直挂着，这里结束它们。 */
	killOrphans(): void {
		for (const pid of this.#stalled) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// 已经没了
			}
		}
		this.#stalled.clear();
	}
}

async function settle(client: TetherClient, session: Tracked): Promise<SendRecord[]> {
	const deadline = Date.now() + SETTLE_TIMEOUT_MS;
	return Promise.all(
		session.sends.map(async ({ requestId, content, submission }): Promise<SendRecord> => {
			const waited = (async (): Promise<RunStatus> => {
				const id = await submission;
				const result = await untilUp(() => client.sessions.waitSubmission(session.id, id));
				return result.status;
			})();
			const timeout = sleep(Math.max(0, deadline - Date.now())).then(() => "pending" as const);
			const status = await Promise.race([waited.catch(() => "pending" as const), timeout]);
			return { requestId, content, status };
		}),
	);
}

async function transcriptOf(client: TetherClient, id: string): Promise<TranscriptEntry[]> {
	const items: TranscriptEntry[] = [];
	let before: string | undefined;
	for (;;) {
		const page = await client.sessions.transcript(id, { limit: 100, ...(before !== undefined && { before }) });
		items.push(...page.items);
		if (page.next === undefined) return items.reverse();
		before = page.next;
	}
}

/** 事件流重连要时间：等它追上记录，或者到期限，把当时持有的条目交给检查函数。 */
async function streamEntries(stream: SessionStream, transcript: readonly TranscriptEntry[]): Promise<string[]> {
	const wanted = transcript.map((entry) => entry.id);
	const deadline = Date.now() + STREAM_SETTLE_MS;
	for (;;) {
		const held = new Set(stream.view.entries.map((entry) => entry.id));
		if (wanted.every((id) => held.has(id)) || Date.now() > deadline) return [...held];
		await sleep(200);
	}
}

async function readExecLog(client: TetherClient, id: string): Promise<string[]> {
	try {
		const bytes = await client.sessions.file(id, "/workspace/.chaos/exec.log");
		return new TextDecoder().decode(bytes).split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

async function fileNames(client: TetherClient, id: string): Promise<string[]> {
	return (await client.sessions.files(id)).map((entry) => entry.name);
}

function readNotes(file: string): Map<string, string[]> {
	const notes = new Map<string, Set<string>>();
	if (existsSync(file)) {
		for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
			const { label, text } = JSON.parse(line) as { label: string; text: string };
			notes.set(label, (notes.get(label) ?? new Set()).add(text));
		}
	}
	return new Map([...notes].map(([label, texts]) => [label, [...texts]]));
}

function listDir(path: string): string[] {
	return existsSync(path) ? readdirSync(path) : [];
}

async function leftovers(sessionIds: readonly string[], dataDir: string): Promise<string[]> {
	const found: string[] = [];
	for (const id of sessionIds) {
		const name = `tether-${id}`;
		if (await containerExists(name)) found.push(`container ${name}`);
		if ((await tryCommand("docker", ["volume", "inspect", name])) !== undefined) found.push(`volume ${name}`);
	}
	found.push(...(await loopDevices(dataDir)).map((device) => `loop device ${device}`));
	found.push(...listDir(join(dataDir, "workspaces")).map((name) => `workspace ${name}`));
	found.push(...listDir(join(dataDir, "checkpoints")).map((name) => `checkpoints of ${name}`));
	return found;
}

async function sabotage(id: string, log: readonly string[]): Promise<void> {
	const line = log.find((entry) => entry.endsWith(" start"));
	if (line === undefined) throw new Error("nothing to duplicate");
	await run("docker", ["exec", `tether-${id}`, "sh", "-c", `echo "${line}" >> /workspace/.chaos/exec.log`]);
}

export async function runRound(options: RoundOptions): Promise<RoundReport> {
	const started = Date.now();
	const dataDir = join(options.root, `${options.seed}-${options.round}`);
	rmSync(dataDir, { recursive: true, force: true });
	mkdirSync(dataDir, { recursive: true });
	const notesFile = join(dataDir, "model-notes.jsonl");
	const port = await freePort();
	const sessions = options.sessions ?? 2;
	const messages = options.messages ?? 3;
	const plan =
		options.plan ??
		planRound(options.seed, options.round, {
			sessions,
			messages,
			gapMs: options.gapMs ?? 15_000,
			faults: options.faults ?? 3,
		});

	const server = new ServerProcess(
		{
			TETHER_DATA_DIR: dataDir,
			TETHER_PORT: String(port),
			TETHER_SANDBOX_IMAGE: options.image,
			TETHER_SWEEP_INTERVAL_SECONDS: "2",
			TETHER_CHAOS_NOTES: notesFile,
			...(options.runtime && { TETHER_SANDBOX_RUNTIME: options.runtime }),
			...(options.storage && { TETHER_WORKSPACE_STORAGE: options.storage }),
		},
		join(dataDir, "server.log"),
	);
	const client = new TetherClient({ baseUrl: `http://127.0.0.1:${port}` });
	const round = new Round(client);
	const effects: FaultEffect[] = [];
	const report = (rest: Partial<RoundReport>): RoundReport => ({
		seed: options.seed,
		round: options.round,
		durationMs: Date.now() - started,
		faults: effects,
		interrupted: 0,
		toolErrors: 0,
		violations: [],
		...rest,
	});

	const kill = async (downMs: number) => {
		await server.stop("SIGKILL");
		await sleep(downMs);
		await server.start();
		await round.resendLatest();
	};

	let result: RoundReport;
	try {
		await server.start();
		const { agent } = await client.agents.create({ name: "chaos", spec: chaosSpec(options.storage) });
		for (let index = 0; index < sessions; index += 1) {
			const session = await client.sessions.create({ agentId: agent.id });
			await round.open(`s${index}`, session.id);
		}

		// 发消息和故障按时间表合成一条时间线；故障一个一个做，发消息不等结果
		type Step = { at: number; run: () => Promise<void> };
		const steps: Step[] = [
			...plan.messageAt.flatMap((times, index) =>
				times.map(
					(at, message): Step => ({
						at,
						run: async () => round.send(round.tracked[index]!, chaosMessage(index, message)),
					}),
				),
			),
			...plan.faults.map(
				(fault): Step => ({
					at: fault.at,
					run: async () => {
						effects.push(await round.inject(fault, server, kill));
					},
				}),
			),
		].sort((a, b) => a.at - b.at);
		const zero = Date.now();
		for (const step of steps) {
			await sleep(Math.max(0, step.at - (Date.now() - zero)));
			await step.run();
		}
		await round.releaseStalls();

		const live = round.tracked.filter((session) => session.label.startsWith("s"));
		for (let barrier = 0; barrier < BARRIER_MESSAGES; barrier += 1) {
			for (const session of live) {
				round.send(session, chaosMessage(live.indexOf(session), messages + barrier));
			}
			await Promise.all(live.map((session) => settle(client, session)));
		}
		const settled = await Promise.all(live.map((session) => settle(client, session)));

		if (options.sabotage === "duplicate") await sabotage(live[0]!.id, await readExecLog(client, live[0]!.id));

		// 每个会话在一条随机的用户消息处分叉，让它跑两轮，再看工作区
		const random = createRandom(options.seed, options.round + 1);
		const histories: SessionHistory[] = [];
		const forkSends = new Map<string, { atEntryId: string; session: Tracked }>();
		for (const session of live) {
			const transcript = await transcriptOf(client, session.id);
			const users = transcript.filter((entry) => entry.role === "user");
			const picked = users[Math.floor(random() * users.length)];
			if (picked === undefined) continue;
			const forked = await client.sessions.fork(session.id, picked.id);
			const index = live.indexOf(session);
			const tracked = await round.open(`f${index}`, forked.id);
			for (let message = 0; message < BARRIER_MESSAGES; message += 1) {
				round.send(tracked, inspectMessage(index, message));
				await settle(client, tracked);
			}
			forkSends.set(session.id, { atEntryId: picked.id, session: tracked });
		}

		const notes = readNotes(notesFile);
		for (const [index, session] of live.entries()) {
			const transcript = await transcriptOf(client, session.id);
			const planned = forkSends.get(session.id);
			let fork: ForkHistory | undefined;
			if (planned !== undefined) {
				fork = {
					label: planned.session.label,
					atEntryId: planned.atEntryId,
					sends: await settle(client, planned.session),
					files: await fileNames(client, planned.session.id),
					notes: notes.get(planned.session.label) ?? [],
				};
			}
			histories.push({
				label: session.label,
				sends: settled[index]!,
				transcript,
				streamEntryIds: await streamEntries(session.stream, transcript),
				execLog: await readExecLog(client, session.id),
				files: await fileNames(client, session.id),
				notes: notes.get(session.label) ?? [],
				removed: session.removed,
				...(fork && { fork }),
			});
		}

		for (const session of round.tracked) session.stream.close();
		for (const id of round.sessionIds) await client.sessions.archive(id);
		await server.stop("SIGTERM");

		const entries = histories.flatMap((history) => history.transcript);
		const results = entries.flatMap((entry) => (entry.toolResult?.isError ? [entry.toolResult.text] : []));
		const interrupted = results.filter((text) => /interrupt/i.test(text)).length;
		result = report({
			interrupted,
			toolErrors: results.length - interrupted,
			violations: checkRound({ sessions: histories, leftovers: await leftovers(round.sessionIds, dataDir) }),
		});
	} catch (error) {
		result = report({ error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
	} finally {
		for (const session of round.tracked) session.stream.close();
		round.killOrphans();
		await server.stop("SIGKILL");
	}

	const failed = result.violations.length > 0 || result.error !== undefined;
	await cleanupRound(round.sessionIds, dataDir, options.image);
	if (failed && options.keepFailed) return { ...result, dataDir };
	rmSync(dataDir, { recursive: true, force: true });
	return result;
}

/** 混沌测试的故障时间表：同一个种子和轮号得到同一份，见设计文档 §11.3。 */

export type FaultKind = "kill9" | "stall" | "stallThenKill" | "removeContainer";

export interface Fault {
	/** 从这一轮开始算的毫秒数。 */
	at: number;
	kind: FaultKind;
	/** 第几个会话；stall 和 removeContainer 作用在它的沙箱上。 */
	session: number;
	/** stall：挂起 docker exec 多久。跨过 daemon 30 秒的静默退出才能测到隔离。 */
	holdMs?: number;
	/** kill9、stallThenKill：服务端停多久再启动。 */
	downMs?: number;
}

export interface RoundPlan {
	faults: Fault[];
	/** 每个会话每条消息的发送时刻。 */
	messageAt: number[][];
	durationMs: number;
}

export interface RoundOptions {
	sessions: number;
	messages: number;
	/** 同一个会话两条消息的间隔。 */
	gapMs: number;
	faults: number;
}

const KINDS: readonly FaultKind[] = ["kill9", "stall", "stallThenKill", "removeContainer"];
/** 快照约 0.3 秒，均匀随机几乎碰不到，这么多故障紧跟在发消息之后。 */
const NEAR_MESSAGE_RATIO = 0.4;
const NEAR_MESSAGE_MS = 500;

/** mulberry32：产生 [0, 1) 的伪随机数。 */
export function createRandom(seed: number, round: number): () => number {
	let state = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(round | 0, 0x85ebca6b)) >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
		mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
	};
}

export function planRound(seed: number, round: number, options: RoundOptions): RoundPlan {
	const random = createRandom(seed, round);
	const between = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));

	const messageAt = Array.from({ length: options.sessions }, () => {
		const start = between(0, 2_000);
		return Array.from({ length: options.messages }, (_, index) => start + index * options.gapMs);
	});
	const durationMs = options.messages * options.gapMs;

	const faults = Array.from({ length: options.faults }, (): Fault => {
		const kind = KINDS[between(0, KINDS.length - 1)]!;
		const session = between(0, options.sessions - 1);
		const near = random() < NEAR_MESSAGE_RATIO;
		const at = near
			? messageAt[session]![between(0, options.messages - 1)]! + between(0, NEAR_MESSAGE_MS)
			: between(0, durationMs);
		return {
			at,
			kind,
			session,
			...(kind === "stall" && { holdMs: between(2_000, 40_000) }),
			...((kind === "kill9" || kind === "stallThenKill") && { downMs: between(0, 5_000) }),
		};
	}).sort((a, b) => a.at - b.at);

	return { faults, messageAt, durationMs };
}

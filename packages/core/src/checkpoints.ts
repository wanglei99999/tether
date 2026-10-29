import type { TranscriptEntry } from "./events.ts";
import type { CheckpointRecord, ForkOrigin, SessionRecord } from "./model.ts";
import type { AgentEngine, AppStore } from "./ports.ts";

/** 会改动工作区的工具；read 没有副作用。 */
export const SIDE_EFFECT_TOOLS: readonly string[] = ["bash", "write", "edit"];
/** 说明里最多列这么多条没有发生的操作，每条最长这么多字符（设计决定 11）。 */
export const MAX_MISSED_CALLS = 20;
export const MAX_MISSED_CALL_LENGTH = 200;

/** 读会话 sessionId 的记录里 (afterEntryId, uptoEntryId] 区间内执行过的工具调用要用到的条目，从旧到新。 */
export type ReadEntries = (sessionId: string, afterEntryId: string, uptoEntryId: string) => Promise<TranscriptEntry[]>;

const num = (entryId: string): number => Number(entryId);

/**
 * 记录的内容就是它对齐的那一刻：不是沿用别的存档的快照（basisCheckpointId），也不是失败的那一轮。
 * 查找存档、挑重建用的存档只看这种记录。
 */
export function holdsOwnContent(checkpoint: CheckpointRecord): boolean {
	return checkpoint.basisCheckpointId === null && !checkpoint.failed;
}

/**
 * (after, upto] 区间内执行过的工具调用，按执行顺序。一次调用以它的结果条目为准：
 * 调用条目在区间前、结果在区间里，说明它是在区间里执行的。
 */
export function executedCalls(
	entries: readonly TranscriptEntry[],
	afterEntryId: string,
	uptoEntryId: string,
): { name: string; args: unknown }[] {
	const calls = new Map<string, { name: string; args: unknown }>();
	for (const entry of entries) for (const call of entry.toolCalls ?? []) calls.set(call.id, call);
	return entries.flatMap((entry) => {
		const id = num(entry.id);
		if (entry.toolResult === undefined || id <= num(afterEntryId) || id > num(uptoEntryId)) return [];
		const call = calls.get(entry.toolResult.callId);
		return call ? [call] : [];
	});
}

function describeCall({ name, args }: { name: string; args: unknown }): string {
	const fields = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
	const detail = name === "bash" ? fields["command"] : fields["path"];
	const text = `${name}: ${typeof detail === "string" ? detail : JSON.stringify(detail ?? null)}`;
	return text.length <= MAX_MISSED_CALL_LENGTH ? text : `${text.slice(0, MAX_MISSED_CALL_LENGTH - 1)}…`;
}

/** (after, upto] 区间内执行过的、会改动工作区的调用。 */
export function sideEffectCalls(
	entries: readonly TranscriptEntry[],
	afterEntryId: string,
	uptoEntryId: string,
): { name: string; args: unknown }[] {
	return executedCalls(entries, afterEntryId, uptoEntryId).filter((call) => SIDE_EFFECT_TOOLS.includes(call.name));
}

/** 存档之后、分叉点之前执行过、在新工作区里没有发生的操作，写进给模型的说明（设计决定 11）。 */
export function missedCalls(entries: readonly TranscriptEntry[], afterEntryId: string, uptoEntryId: string): string[] {
	const missed = sideEffectCalls(entries, afterEntryId, uptoEntryId).map(describeCall);
	if (missed.length <= MAX_MISSED_CALLS) return missed;
	return [...missed.slice(0, MAX_MISSED_CALLS), `and ${missed.length - MAX_MISSED_CALLS} more`];
}

/**
 * 从引擎读一段记录：(after, upto] 之间的条目，加上往前翻到的、这些结果对应的调用条目。从旧到新。
 * 新的在前一页页往前翻，翻过 after 并且每个结果都找到了调用就停。
 */
export async function readEntries(
	engine: Pick<AgentEngine, "transcript">,
	engineSessionId: string,
	afterEntryId: string,
	uptoEntryId: string,
): Promise<TranscriptEntry[]> {
	const collected: TranscriptEntry[] = [];
	const pending = new Set<string>();
	let before: string | undefined = String(num(uptoEntryId) + 1);
	while (before !== undefined) {
		const page: { items: TranscriptEntry[]; next?: string } = await engine.transcript(engineSessionId, { limit: 100, before });
		for (const entry of page.items) {
			collected.push(entry);
			for (const call of entry.toolCalls ?? []) pending.delete(call.id);
			if (entry.toolResult !== undefined && num(entry.id) > num(afterEntryId)) pending.add(entry.toolResult.callId);
		}
		const oldest = page.items.at(-1);
		if (oldest === undefined || (num(oldest.id) <= num(afterEntryId) && pending.size === 0)) break;
		before = page.next;
	}
	return collected.reverse();
}

/**
 * 在会话的条目处找存档（设计决定 8，加上 Task 1 的修正）。atEntryId 为 undefined 表示"最新"。
 * 每一级会话 L、上界 b（起初是 atEntryId）：
 * - L 自己 entryId > b 的第一张 C'：b 到 C' 之间没有执行过 write、edit、bash，C' 就等于 b 那一刻，用它；
 * - 否则 L 自己 entryId ≤ b 的最新一张；
 * - 都没有就到 L 分叉来源的会话，b = min(b, 分叉点)。
 * 依据是条目 ID 在整个引擎里递增：一条分叉链上的记录 ID 严格递增。
 */
export async function findCheckpoint(
	store: AppStore,
	sessionId: string,
	atEntryId: string | undefined,
	read: ReadEntries,
): Promise<CheckpointRecord | undefined> {
	let level: string | undefined = sessionId;
	let bound = atEntryId;
	while (level !== undefined) {
		const own = (await store.listCheckpoints(level)).filter(holdsOwnContent);
		if (bound === undefined) {
			if (own.length > 0) return own.at(-1);
		} else {
			const upper = bound;
			const next = own.find((checkpoint) => num(checkpoint.entryId) > num(upper));
			if (next !== undefined && !(await changedBetween(read, level, upper, next.entryId))) return next;
			const latest = own.findLast((checkpoint) => num(checkpoint.entryId) <= num(upper));
			if (latest !== undefined) return latest;
		}
		const origin: ForkOrigin | null | undefined = (await store.getSession(level))?.forkedFrom;
		if (!origin) return undefined;
		bound = bound === undefined || num(origin.entryId) < num(bound) ? origin.entryId : bound;
		level = origin.sessionId;
	}
	return undefined;
}

async function changedBetween(read: ReadEntries, sessionId: string, after: string, upto: string): Promise<boolean> {
	return sideEffectCalls(await read(sessionId, after, upto), after, upto).length > 0;
}

/**
 * 沙箱丢失后从哪张存档重建：会话自己最新的、内容是它自己的一张（holdsOwnContent）；自己还没有的分叉会话用分叉选中的那张。
 * 每轮存档在"这一轮开始时沙箱已丢失"时用同一张，两边必须一致。
 */
export async function restorePoint(store: AppStore, session: SessionRecord): Promise<CheckpointRecord | undefined> {
	const latest = (await store.listCheckpoints(session.id)).filter(holdsOwnContent).at(-1);
	if (latest !== undefined) return latest;
	const checkpointId = session.forkedFrom?.checkpointId;
	return checkpointId === undefined || checkpointId === null ? undefined : store.getCheckpoint(checkpointId);
}

/**
 * 存档对齐到的、atEntryId 所在记录上的那一刻：存档在它那一级的上界之前，就是存档的条目；
 * 在上界之后（无改动的下一张），就是上界本身。missedCalls 从这里往后列。
 */
export async function alignedEntry(
	store: AppStore,
	sessionId: string,
	atEntryId: string,
	checkpoint: CheckpointRecord,
): Promise<string> {
	let level = sessionId;
	let bound = atEntryId;
	while (level !== checkpoint.sessionId) {
		const origin = (await store.getSession(level))?.forkedFrom;
		if (!origin) break;
		if (num(origin.entryId) < num(bound)) bound = origin.entryId;
		level = origin.sessionId;
	}
	return num(checkpoint.entryId) <= num(bound) ? checkpoint.entryId : bound;
}

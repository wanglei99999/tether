import type { RunStatus, TranscriptEntry } from "@tether/core";

/** 一轮混沌测试结束时收集到的全部事实，检查函数只看这些。 */

export type InvariantId = "I0" | "I1" | "I2" | "I3" | "I4" | "I5" | "I6" | "I7";

export interface Violation {
	invariant: InvariantId;
	session?: string;
	detail: string;
}

export interface SendRecord {
	requestId: string;
	content: string;
	/** pending：故障结束后到期限还没结束。 */
	status: RunStatus | "pending";
}

export interface ForkHistory {
	label: string;
	/** 分叉点，来源会话里的条目 ID。 */
	atEntryId: string;
	sends: SendRecord[];
	/** /workspace 顶层的文件名。 */
	files: string[];
	/** 模型实际收到的说明，包括继承来的。 */
	notes: string[];
}

export interface SessionHistory {
	label: string;
	sends: SendRecord[];
	/** 从旧到新。 */
	transcript: TranscriptEntry[];
	/** 全程订阅的事件流结束时持有的条目。 */
	streamEntryIds: string[];
	/** .chaos/exec.log 的行。 */
	execLog: string[];
	files: string[];
	notes: string[];
	/** 驱动程序确实删掉过这个会话的容器。 */
	removed: boolean;
	fork?: ForkHistory;
}

export interface RoundHistory {
	sessions: SessionHistory[];
	/** 归档全部会话后这一轮还剩下的东西。 */
	leftovers: string[];
}

const FILE = /^f-(.+)\.txt$/;

interface LogLine {
	token: string;
	event: string;
}

/** 进程可能写到一半被杀，不成形的行跳过。 */
function parseLog(lines: readonly string[]): LogLine[] {
	return lines.flatMap((line) => {
		const match = /^(\S+) (start|tick|end)$/.exec(line);
		return match ? [{ token: match[1]!, event: match[2]! }] : [];
	});
}

function checkFinished(label: string, sends: readonly SendRecord[]): Violation[] {
	return sends
		.filter((send) => send.status === "pending" || send.status === "unanswered")
		.map((send) => ({
			invariant: "I0" as const,
			session: label,
			detail: `${send.content} (${send.requestId}) ended as ${send.status}`,
		}));
}

function checkOncePerRequest(session: SessionHistory): Violation[] {
	return session.sends.flatMap((send) => {
		const count = session.transcript.filter((e) => e.role === "user" && e.text === send.content).length;
		return count > 1
			? [{ invariant: "I1" as const, session: session.label, detail: `${send.content} appears ${count} times` }]
			: [];
	});
}

function checkOnceExecuted(session: SessionHistory): Violation[] {
	const starts = new Map<string, number>();
	for (const { token, event } of parseLog(session.execLog)) {
		if (event === "start") starts.set(token, (starts.get(token) ?? 0) + 1);
	}
	return [...starts]
		.filter(([, count]) => count > 1)
		.map(([token, count]) => ({
			invariant: "I2" as const,
			session: session.label,
			detail: `${token} started ${count} times`,
		}));
}

function checkNoOldProcess(session: SessionHistory): Violation[] {
	const violations: Violation[] = [];
	let latest: string | undefined;
	for (const { token, event } of parseLog(session.execLog)) {
		if (event === "start") latest = token;
		else if (event === "tick" && token !== latest) {
			violations.push({
				invariant: "I3",
				session: session.label,
				detail: `${token} was still running after ${latest} started`,
			});
		}
	}
	return violations;
}

function checkRemovalExplained(session: SessionHistory): Violation[] {
	if (!session.removed) return [];
	const violations: Violation[] = [];
	const recorded = session.transcript.some(
		(e) => e.kind === "tether.sandbox" && (e.data as { reason?: string } | undefined)?.reason === "recovered",
	);
	if (!recorded) {
		violations.push({
			invariant: "I4",
			session: session.label,
			detail: "the container was removed but no tether.sandbox entry says recovered",
		});
	}
	if (!session.notes.some((note) => note.includes("previous sandbox was lost"))) {
		violations.push({
			invariant: "I4",
			session: session.label,
			detail: "the container was removed but the model never received a note",
		});
	}
	return violations;
}

function checkStream(session: SessionHistory): Violation[] {
	const seen = new Set(session.streamEntryIds);
	const missing = session.transcript.filter((e) => !seen.has(e.id)).map((e) => e.id);
	return missing.length === 0
		? []
		: [{ invariant: "I5", session: session.label, detail: `the stream never showed entries ${missing.join(", ")}` }];
}

function checkFork(session: SessionHistory): Violation[] {
	const fork = session.fork;
	if (fork === undefined) return [];
	const at = Number(fork.atEntryId);
	const calledAt = new Map<string, number>();
	const succeededBy = new Map<string, number>();
	for (const entry of session.transcript) {
		for (const call of entry.toolCalls ?? []) {
			if (!calledAt.has(call.id)) calledAt.set(call.id, Number(entry.id));
		}
		if (entry.toolResult && !entry.toolResult.isError) succeededBy.set(entry.toolResult.callId, Number(entry.id));
	}

	const violations: Violation[] = [];
	const present = new Set<string>();
	for (const file of fork.files) {
		const token = FILE.exec(file)?.[1];
		if (token === undefined) continue;
		present.add(token);
		const called = calledAt.get(token);
		if (called !== undefined && called > at) {
			violations.push({
				invariant: "I6",
				session: fork.label,
				detail: `${file} was written at entry ${called}, after the fork point ${at}`,
			});
		}
	}
	const notes = fork.notes.join("\n");
	const truncated = /and \d+ more/.test(notes);
	for (const [token, result] of succeededBy) {
		if (!token.endsWith("-t0") && !token.endsWith("-t2")) continue;
		if (result > at || present.has(token) || truncated || notes.includes(token)) continue;
		violations.push({
			invariant: "I6",
			session: fork.label,
			detail: `f-${token}.txt succeeded before the fork point but is missing and no note mentions it`,
		});
	}
	return violations;
}

/** 每条不变式一个函数；空数组表示这一轮全部成立。 */
export function checkRound(history: RoundHistory): Violation[] {
	const perSession = history.sessions.flatMap((session) => [
		...checkFinished(session.label, session.sends),
		...(session.fork ? checkFinished(session.fork.label, session.fork.sends) : []),
		...checkOncePerRequest(session),
		...checkOnceExecuted(session),
		...checkNoOldProcess(session),
		...checkRemovalExplained(session),
		...checkStream(session),
		...checkFork(session),
	]);
	const leftovers = history.leftovers.map((detail): Violation => ({ invariant: "I7", detail }));
	return [...perSession, ...leftovers];
}

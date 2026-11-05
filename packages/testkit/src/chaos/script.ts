/**
 * 混沌测试的假模型做决定的部分：只看这次请求带的消息，所以服务重启后接着往下走。
 * 普通 faux 是一个队列，重启后从头开始，崩溃之后答不对。
 */

export interface ModelMessage {
	role: "user" | "assistant" | "tool";
	text: string;
}

export type ChaosStep =
	| { text: string }
	| { token: string; toolCall: { name: "bash"; args: { command: string } } };

const CHAOS = "chaos:";
const INSPECT = "inspect:";
const LOG = ".chaos/exec.log";
/** 一轮的工具调用：写文件、长命令、写文件。被中断的调用也有结果，所以重试时令牌会变。 */
const PLAN = ["write", "long", "write"] as const;
const TICK_SECONDS = 0.2;

export function chaosMessage(session: number, message: number): string {
	return `${CHAOS}${session}:${message}`;
}

export function inspectMessage(fork: number, message: number): string {
	return `${INSPECT}${fork}:${message}`;
}

function hash(text: string): number {
	let value = 0;
	for (const char of text) value = (Math.imul(value, 31) + char.charCodeAt(0)) >>> 0;
	return value;
}

/** 长命令写 15-40 条 tick，也就是 3-8 秒，时长由令牌决定。 */
export function ticksFor(token: string): number {
	return 15 + (hash(token) % 26);
}

export function writeCommand(token: string): string {
	return `: ${token}; mkdir -p .chaos; echo "${token} start" >> ${LOG}; echo ${token} > f-${token}.txt; echo "${token} end" >> ${LOG}`;
}

export function longCommand(token: string): string {
	return (
		`: ${token}; mkdir -p .chaos; echo "${token} start" >> ${LOG}; i=0; ` +
		`while [ $i -lt ${ticksFor(token)} ]; do echo "${token} tick" >> ${LOG}; sleep ${TICK_SECONDS}; i=$((i+1)); done; ` +
		`echo "${token} end" >> ${LOG}`
	);
}

function isTurn(message: ModelMessage): boolean {
	return message.role === "user" && (message.text.startsWith(CHAOS) || message.text.startsWith(INSPECT));
}

export function nextStep(messages: readonly ModelMessage[]): ChaosStep {
	const index = messages.findLastIndex(isTurn);
	if (index === -1) return { text: "nothing to do" };
	const turn = messages[index]!.text;
	const results = messages.slice(index + 1).filter((message) => message.role === "tool").length;

	if (turn.startsWith(INSPECT)) {
		if (results > 0) return { text: "inspected" };
		const token = `i${turn.slice(INSPECT.length).replace(":", "-m")}-t0`;
		return { token, toolCall: { name: "bash", args: { command: `: ${token}; ls -a /workspace > /dev/null` } } };
	}
	const kind = PLAN[results];
	if (kind === undefined) return { text: "done" };
	const token = `s${turn.slice(CHAOS.length).replace(":", "-m")}-t${results}`;
	const command = kind === "write" ? writeCommand(token) : longCommand(token);
	return { token, toolCall: { name: "bash", args: { command } } };
}

/** 模型这次收到的 Tether 说明：用户角色、又不是驱动程序发的消息。 */
export function modelNotes(messages: readonly ModelMessage[]): string[] {
	return messages.filter((m) => m.role === "user" && !isTurn(m)).map((m) => m.text);
}

/** 这次请求属于哪个会话：分叉的记录里同时有两种消息，按最后一条算。 */
export function turnLabel(messages: readonly ModelMessage[]): string | undefined {
	const turn = messages.findLast(isTurn)?.text;
	if (turn === undefined) return undefined;
	return turn.startsWith(INSPECT)
		? `f${turn.slice(INSPECT.length).split(":")[0]}`
		: `s${turn.slice(CHAOS.length).split(":")[0]}`;
}

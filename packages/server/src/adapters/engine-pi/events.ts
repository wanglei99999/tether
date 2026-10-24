import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentEvent, EntryRecord, SnapshotEvent } from "@earendil-works/pi-durable";
import type { SessionView, TetherEvent } from "@tether/core";
import { toTranscriptEntry } from "./transcript.ts";

/*
 * pi 的 watchEvents()（pi-durable harness/events.ts，示例 test/examples/19-json.ts）→ Tether 事件：
 *
 *   snapshot                          → snapshot（entries、run、generation.message、tools、inbox 折成 SessionView）
 *   message_start（assistant 流式）    → message_start，首个 partial 已有的文字作为 message_delta
 *   message_start（user / toolResult）→ 不发：紧跟着的 message_end 带完整条目
 *   message_update                    → message_delta；text 块被整体替换时，重发 message_start 加全文
 *   message_end（pi.assistant）        → message_end
 *   message_end（其他）                → entry；已经随 tool_end 发过的工具结果不再发
 *   entry_appended                    → entry（没有 model 的条目，例如 tether.* 不带 modelText）
 *   tool_execution_start              → tool_start（只要模型发起的调用，嵌套调用不发）
 *   tool_execution_update.output      → tool_output，只转 append；trimStart 是 pi 的显示窗口，set 是重置，都不转
 *   tool_execution_end（带 entry）     → tool_end
 *   tool_execution_end（无 entry）     → 不发：工具出错或被中断，run_end 会清掉运行中的工具
 *   submission（input，已结束）        → run_end；status 取 done / unanswered，reason 为 aborted 时是 aborted
 *   其余（run_start、turn_*、inbox_update、usage_changed、agent_changed、重试、压缩、task_failed）→ 不发
 *
 * pi 的流式增量不带消息 ID：一个会话同一时刻最多一条在流式输出的消息，所以 message_start / message_delta
 * 用固定的 STREAMING_ID，message_end 用落盘后的条目 ID。
 */

export const STREAMING_ID = "streaming";

type Block = AssistantMessage["content"][number];

function textOfBlocks(blocks: ReadonlyMap<number, string>): string {
	return [...blocks.entries()]
		.sort(([a], [b]) => a - b)
		.map(([, text]) => text)
		.join("");
}

function textBlocks(message: AssistantMessage | undefined): Map<number, string> {
	const blocks = new Map<number, string>();
	for (const [index, block] of (message?.content ?? []).entries()) {
		if (block.type === "text") blocks.set(index, block.text);
	}
	return blocks;
}

function toView(snapshot: SnapshotEvent): SessionView {
	const streaming = textOfBlocks(textBlocks(snapshot.generation?.message));
	return {
		running: snapshot.run !== undefined,
		entries: snapshot.entries.map(toTranscriptEntry),
		...(snapshot.generation?.message !== undefined && { streaming: { text: streaming } }),
		tools: snapshot.tools
			.filter((slot) => slot.status === "running")
			.map((slot) => ({ callId: slot.callId, name: slot.name, output: slot.output ?? "" })),
		queued: snapshot.inbox.length,
	};
}

/** 一次订阅一个翻译器：它要记住正在流式输出的消息，才能把块替换转成全文。 */
export function createEventTranslator(): (events: readonly AgentEvent[]) => TetherEvent[] {
	let blocks = new Map<number, string>();
	/** 已经随 tool_end 发出的工具结果条目，紧跟着的 message_end 不再重复。 */
	const sentWithTool = new Set<number>();

	const restart = (out: TetherEvent[]) => {
		out.push({ type: "message_start", messageId: STREAMING_ID });
		const text = textOfBlocks(blocks);
		if (text !== "") out.push({ type: "message_delta", messageId: STREAMING_ID, text });
	};

	const endMessage = (entry: EntryRecord, out: TetherEvent[]) => {
		if (sentWithTool.delete(entry.id)) return;
		const converted = toTranscriptEntry(entry);
		if (entry.kind === "pi.assistant") {
			blocks = new Map();
			out.push({ type: "message_end", messageId: converted.id, entry: converted });
		} else {
			out.push({ type: "entry", entry: converted });
		}
	};

	return (events) => {
		const out: TetherEvent[] = [];
		for (const event of events) {
			switch (event.type) {
				case "snapshot":
					blocks = textBlocks(event.generation?.message);
					sentWithTool.clear();
					out.push({ type: "snapshot", view: toView(event) });
					break;
				case "message_start":
					if (event.message.role === "assistant") {
						blocks = textBlocks(event.message);
						restart(out);
					}
					break;
				case "message_update": {
					let delta = "";
					let replaced = false;
					for (const change of event.changes) {
						if (change.type === "text_start" && change.block.type === "text") {
							blocks.set(change.contentIndex, change.block.text);
							delta += change.block.text;
						} else if (change.type === "text_delta") {
							blocks.set(change.contentIndex, (blocks.get(change.contentIndex) ?? "") + change.delta);
							delta += change.delta;
						} else if (change.type === "block" && (change.block as Block).type === "text") {
							blocks.set(change.contentIndex, (change.block as Extract<Block, { type: "text" }>).text);
							replaced = true;
						} else if (change.type === "message") {
							blocks = textBlocks(change.message);
							replaced = true;
						}
					}
					if (replaced) restart(out);
					else if (delta !== "") out.push({ type: "message_delta", messageId: STREAMING_ID, text: delta });
					break;
				}
				case "message_end":
					endMessage(event.entry, out);
					break;
				case "entry_appended":
					out.push({ type: "entry", entry: toTranscriptEntry(event.entry) });
					break;
				case "tool_execution_start":
					if (event.parentToolCallId === undefined) {
						out.push({ type: "tool_start", callId: event.toolCallId, name: event.toolName, args: event.args });
					}
					break;
				case "tool_execution_update":
					if (event.parentToolCallId === undefined && event.output && "append" in event.output && event.output.append) {
						out.push({ type: "tool_output", callId: event.toolCallId, text: event.output.append });
					}
					break;
				case "tool_execution_end":
					if (event.parentToolCallId === undefined && event.entry !== undefined) {
						sentWithTool.add(event.entry.id);
						out.push({ type: "tool_end", callId: event.toolCallId, entry: toTranscriptEntry(event.entry) });
					}
					break;
				case "submission": {
					const record = event.record;
					if (record.type !== "input" || (record.status !== "done" && record.status !== "unanswered")) break;
					const status =
						record.status === "done" ? "done" : record.reason === "aborted" ? "aborted" : "unanswered";
					out.push({ type: "run_end", submissionId: String(record.id), status });
					break;
				}
				default:
					break;
			}
		}
		return out;
	};
}

/** 一次性翻译一组 pi 事件（从 snapshot 开始）。订阅时用 createEventTranslator 保留跨批次的状态。 */
export function toTetherEvents(piEvents: readonly AgentEvent[]): TetherEvent[] {
	return createEventTranslator()(piEvents);
}

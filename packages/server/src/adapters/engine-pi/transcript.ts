import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { TranscriptEntry } from "@tether/core";

function textOf(message: Message | undefined): string {
	if (message === undefined) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function assistantEntry(id: string, kind: string, message: AssistantMessage | undefined): TranscriptEntry {
	const toolCalls = (message?.content ?? []).flatMap((part) =>
		part.type === "toolCall" ? [{ id: part.id, name: part.name, args: part.arguments as unknown }] : [],
	);
	const text = textOf(message);
	return {
		id,
		kind,
		role: "assistant",
		...(text !== "" && { text }),
		...(toolCalls.length > 0 && { toolCalls }),
	};
}

function toolResultEntry(id: string, kind: string, message: ToolResultMessage | undefined): TranscriptEntry {
	return {
		id,
		kind,
		role: "tool",
		toolResult: { callId: message?.toolCallId ?? "", isError: message?.isError ?? false, text: textOf(message) },
	};
}

/** pi 的条目转成 Tether 的格式。数字 ID 转成字符串；不认识的 kind 原样带上 kind 和 data。 */
export function toTranscriptEntry(entry: EntryRecord): TranscriptEntry {
	const id = String(entry.id);
	const message = entry.model?.[0];
	switch (entry.kind) {
		case "pi.user":
			return { id, kind: entry.kind, role: "user", text: textOf(message) };
		case "pi.assistant":
			return assistantEntry(id, entry.kind, message as AssistantMessage | undefined);
		case "pi.tool-result":
			return toolResultEntry(id, entry.kind, message as ToolResultMessage | undefined);
		default:
			return { id, kind: entry.kind, ...(entry.data !== undefined && { data: entry.data }) };
	}
}

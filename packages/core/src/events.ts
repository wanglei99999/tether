/** 会话记录里的一条。引擎条目的 ID 一律转成字符串。 */
export interface TranscriptEntry {
	id: string;
	/** 引擎条目用引擎的类型名；Tether 写入的条目以 "tether." 开头。 */
	kind: string;
	role?: "user" | "assistant" | "tool";
	text?: string;
	toolCalls?: { id: string; name: string; args: unknown }[];
	toolResult?: { callId: string; isError: boolean; text: string };
	data?: unknown;
}

export interface RunningTool {
	callId: string;
	name: string;
	output: string;
}

/** 客户端看到的会话状态：已落盘的条目，加上正在流式输出的内容。 */
export interface SessionView {
	running: boolean;
	entries: TranscriptEntry[];
	streaming?: { text: string };
	tools: RunningTool[];
	queued: number;
}

export type RunStatus = "done" | "unanswered" | "aborted";

export type TetherEvent =
	| { type: "snapshot"; view: SessionView }
	| { type: "message_start"; messageId: string }
	| { type: "message_delta"; messageId: string; text: string }
	| { type: "message_end"; messageId: string; entry: TranscriptEntry }
	| { type: "tool_start"; callId: string; name: string; args: unknown }
	| { type: "tool_output"; callId: string; text: string }
	| { type: "tool_end"; callId: string; entry: TranscriptEntry }
	/** 用户输入和 tether.* 条目。 */
	| { type: "entry"; entry: TranscriptEntry }
	| { type: "run_end"; submissionId: string; status: RunStatus };

function withoutStreaming(view: SessionView): SessionView {
	const { streaming: _dropped, ...rest } = view;
	return rest;
}

/** 纯函数：不修改输入，返回新的视图。SDK 和测试用它维护本地状态。 */
export function applyEvent(view: SessionView, event: TetherEvent): SessionView {
	switch (event.type) {
		case "snapshot":
			return structuredClone(event.view);
		case "message_start":
			return { ...view, running: true, streaming: { text: "" } };
		case "message_delta":
			return { ...view, streaming: { text: (view.streaming?.text ?? "") + event.text } };
		case "message_end":
			return { ...withoutStreaming(view), entries: [...view.entries, event.entry] };
		case "tool_start":
			return { ...view, running: true, tools: [...view.tools, { callId: event.callId, name: event.name, output: "" }] };
		case "tool_output":
			return {
				...view,
				tools: view.tools.map((tool) =>
					tool.callId === event.callId ? { ...tool, output: tool.output + event.text } : tool,
				),
			};
		case "tool_end":
			return {
				...view,
				tools: view.tools.filter((tool) => tool.callId !== event.callId),
				entries: [...view.entries, event.entry],
			};
		case "entry":
			return { ...view, entries: [...view.entries, event.entry] };
		case "run_end":
			// queued 只由 snapshot 给出：排队的输入会在下一轮开始时通过新的事件体现。
			return { ...withoutStreaming(view), running: false, tools: [] };
	}
}

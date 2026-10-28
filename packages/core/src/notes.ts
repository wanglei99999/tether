/**
 * SandboxService 要写进会话记录的一条条目（设计文档 §4.4）。
 * 带 modelText 时模型也看得到：环境变了却不告诉模型，它会照着旧环境继续做（spec §8.4）。
 */
export interface SandboxNote {
	kind: "tether.sandbox" | "tether.admission" | "tether.checkpoint";
	data: Record<string, unknown>;
	modelText?: string;
}

/** 模型可见说明的固定文本，原样使用。 */
export const NOTES = {
	stoppedIdle: (minutes: number) =>
		`The sandbox was stopped after ${minutes} minutes without activity. Processes started earlier, including background servers, have ended. Files in /workspace are kept, and the sandbox starts again on the next tool call.`,
	stoppedOutside:
		"The sandbox was stopped outside Tether. Processes started earlier, including background servers, have ended. Files in /workspace are kept, and the sandbox starts again on the next tool call.",
	reconnected:
		"The connection to the sandbox was re-established. Processes started earlier, including background servers, have ended. Files in /workspace are kept.",
	reset: (reason: string) =>
		`The previous sandbox was lost (${reason}). A new sandbox was created from the template and the setup commands ran again. Files that were in /workspace are gone, and so are processes started earlier.`,
} as const;

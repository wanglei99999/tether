/**
 * SandboxService 要写进会话记录的一条条目（设计文档 §4.4）。
 * 带 modelText 时模型也看得到：环境变了却不告诉模型，它会照着旧环境继续做（spec §8.4）。
 */
export interface SandboxNote {
	kind: "tether.sandbox" | "tether.admission" | "tether.checkpoint" | "tether.fork";
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
	forked: (missed: string[]) =>
		`This session was forked from another session. /workspace was restored from a checkpoint; processes from the original session are not running, and only /workspace was restored.` +
		(missed.length === 0
			? ""
			: ` These operations ran after that checkpoint and did not happen in this workspace:\n${missed.map((m) => `- ${m}`).join("\n")}`),
	forkFresh:
		"This session was forked from another session, but no checkpoint of its workspace was available. /workspace is a fresh sandbox from the template; files from the original session are not here.",
} as const;

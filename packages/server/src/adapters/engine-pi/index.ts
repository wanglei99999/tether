import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
	type Conversation,
	type ConversationId,
	createRegistry,
	type EntryId,
	Harness,
	type SubmissionId,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { type AgentEngine, type EngineAgentConfig, TetherError, type TranscriptEntry } from "@tether/core";
import { toTranscriptEntry } from "./transcript.ts";

export { toTranscriptEntry } from "./transcript.ts";

export interface PiEngineOptions {
	/** 引擎自己的 SQLite 文件（engine.sqlite），与应用库分开，见设计文档 §5。 */
	database: string;
	models: Models;
	/** 工具调用时按引擎会话 ID 取执行环境；返回 undefined 表示这个会话没有沙箱。 */
	envFor: (engineSessionId: string) => Promise<ExecutionEnv | undefined>;
	onError?: (error: unknown) => void;
}

const context = BACKGROUND_CONTEXT;

/** 引擎的 ID 是正整数，对外一律是字符串。 */
function parseId(id: string): number | undefined {
	return /^[1-9]\d*$/.test(id) ? Number(id) : undefined;
}

export async function openPiEngine(options: PiEngineOptions): Promise<AgentEngine> {
	const registry = createRegistry();
	registry.install(CodingTools);
	const harness = await Harness.open(
		await openNodeSqliteStorage(options.database),
		{
			models: options.models,
			registry,
			env: (target) => options.envFor(String(target.conversationId)),
			...(options.onError && { onReport: options.onError }),
		},
		context,
	);

	async function find(engineSessionId: string): Promise<Conversation | undefined> {
		const id = parseId(engineSessionId);
		return id === undefined ? undefined : harness.conversation(id as ConversationId, context);
	}

	async function require(engineSessionId: string): Promise<Conversation> {
		const conversation = await find(engineSessionId);
		if (!conversation) throw new TetherError("not_found", `engine session ${engineSessionId} not found`);
		return conversation;
	}

	async function entry(conversation: Conversation, id: EntryId): Promise<TranscriptEntry | undefined> {
		const page = await conversation.entries({ minEntryId: id, maxEntryId: id }, 1, undefined, context);
		const found = page.items[0];
		return found && toTranscriptEntry(found);
	}

	return {
		async createSession(config: EngineAgentConfig) {
			const { model, instructions, tools, cwd } = config;
			const conversation = await harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: {
						model: { provider: model.provider, modelId: model.modelId },
						...(model.thinkingLevel && { thinkingLevel: model.thinkingLevel }),
						instructions,
						tools: (CodingTools.tools ?? []).filter((tool) => tools.includes(tool.name)),
						cwd,
					},
				},
				context,
			);
			return String(conversation.id);
		},

		async hasSession(engineSessionId) {
			return (await find(engineSessionId)) !== undefined;
		},

		async submit(engineSessionId, input) {
			const conversation = await require(engineSessionId);
			const submission = await conversation.submit(
				{
					type: "input",
					content: input.content,
					requestId: input.requestId,
					...(input.whenBusy && { whenBusy: input.whenBusy }),
				},
				context,
			);
			return { submissionId: String(submission.id) };
		},

		async waitSubmission(submissionId) {
			const id = parseId(submissionId);
			const submission = id === undefined ? undefined : await harness.submission(id as SubmissionId, context);
			if (!submission) throw new TetherError("not_found", `submission ${submissionId} not found`);
			const settled = await submission.wait(context);
			if (settled.status !== "done" || settled.type !== "input") return { status: settled.status };
			const conversation = await require(String(settled.conversationId));
			const answer = await entry(conversation, settled.answer);
			return answer ? { status: "done", answer } : { status: "done" };
		},

		async abort(engineSessionId) {
			await (await require(engineSessionId)).abort(context);
		},

		async transcript(engineSessionId, page) {
			const conversation = await require(engineSessionId);
			const before = page.before === undefined ? undefined : parseId(page.before);
			if (page.before !== undefined && before === undefined) {
				throw new TetherError("invalid_request", `invalid transcript cursor ${page.before}`);
			}
			// 新的在前；游标就是上一页最后一条的 ID，下一页从它之前开始
			const result = await conversation.entries(
				{ order: "descending", ...(before !== undefined && { maxEntryId: (before - 1) as EntryId }) },
				page.limit,
				undefined,
				context,
			);
			const items = result.items.map(toTranscriptEntry);
			const last = items.at(-1);
			return result.next !== undefined && last ? { items, next: last.id } : { items };
		},

		async appendEntry(engineSessionId, draft) {
			const conversation = await require(engineSessionId);
			// 只等准入，不等写入：会话正忙时，带 model 的条目要排到这一轮结束才落到记录里
			await conversation.submit(
				{
					type: "write",
					entry: {
						kind: draft.kind,
						data: draft.data as JsonValue,
						...(draft.modelText !== undefined && {
							model: [{ role: "user", content: draft.modelText, timestamp: Date.now() }],
						}),
					},
				},
				context,
			);
		},

		async subscribe() {
			throw new TetherError("internal", "subscribe is implemented in Task 8");
		},

		resume() {
			harness.resume();
		},

		async close() {
			await harness.close(context);
		},
	};
}

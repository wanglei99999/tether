import { appendFileSync } from "node:fs";
import type { Message, Models } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type ModelMessage, modelNotes, nextStep, turnLabel } from "@tether/testkit";

/** 一轮不会超过这么多次模型请求；faux 是个队列，放够多份同一个函数。 */
const QUEUE_LENGTH = 10_000;

function toModelMessage(message: Message): ModelMessage {
	const text =
		typeof message.content === "string"
			? message.content
			: message.content.map((part) => ("text" in part ? part.text : "")).join("");
	const role = message.role === "toolResult" ? "tool" : message.role === "user" ? "user" : "assistant";
	return { role, text };
}

/**
 * 混沌测试的模型：回答只取决于这次请求的消息（testkit 的 nextStep），服务重启后接着走。
 * delayMs 模拟思考很久的模型，连续崩溃场景用。
 * 说明文本不在记录接口里，所以把模型实际收到的说明记进 notesFile，一行一个 JSON。
 */
export function chaosModels(notesFile: string | undefined, delayMs = 0): Models {
	const faux = fauxProvider();
	faux.setResponses(
		Array.from({ length: QUEUE_LENGTH }, () => async (context: { messages: Message[] }) => {
			if (delayMs > 0) await new Promise((done) => setTimeout(done, delayMs));
			const messages = context.messages.map(toModelMessage);
			const label = turnLabel(messages);
			if (notesFile !== undefined && label !== undefined) {
				for (const text of modelNotes(messages)) appendFileSync(notesFile, `${JSON.stringify({ label, text })}\n`);
			}
			const step = nextStep(messages);
			if ("text" in step) return fauxAssistantMessage(step.text);
			return fauxAssistantMessage([fauxToolCall("bash", step.toolCall.args, { id: step.token })], {
				stopReason: "toolUse",
			});
		}),
	);
	const models = createModels();
	models.setProvider(faux.provider);
	return models;
}

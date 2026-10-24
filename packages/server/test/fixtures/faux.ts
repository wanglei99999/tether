import type { Message, Models } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ScriptStep } from "@tether/testkit";

export const FAUX_MODEL = { provider: "faux", modelId: "faux-1" } as const;

function messageText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map((part) => ("text" in part ? part.text : "")).join("");
}

/** 剧本翻译成 faux 的回答；每次回答前把这次请求收到的消息文本记进 requests。 */
export function toFaux(script: ScriptStep[], requests: string[][] = []): FauxResponseStep[] {
	return script.map((step, index) => (context) => {
		requests.push(context.messages.map(messageText));
		if ("text" in step) return fauxAssistantMessage(step.text);
		const args = step.toolCall.args as Parameters<typeof fauxToolCall>[1];
		return fauxAssistantMessage([fauxToolCall(step.toolCall.name, args, { id: `call-${index}` })], {
			stopReason: "toolUse",
		});
	});
}

/** 只有 faux 一个提供方的 Models，按剧本回答。 */
export function fauxModels(script: ScriptStep[], requests?: string[][]): Models {
	const faux = fauxProvider();
	faux.setResponses(toFaux(script, requests));
	const models = createModels();
	models.setProvider(faux.provider);
	return models;
}

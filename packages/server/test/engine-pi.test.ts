import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { AgentEngine } from "@tether/core";
import { type MadeEngine, registerAgentEngineConformance, type ScriptStep } from "@tether/testkit";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { openPiEngine } from "../src/adapters/engine-pi/index.ts";

const MODEL = { provider: "faux", modelId: "faux-1" } as const;
const root = mkdtempSync(join(tmpdir(), "tether-engine-"));
const workdir = mkdtempSync(join(root, "work-"));
let databases = 0;

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

function messageText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map((part) => ("text" in part ? part.text : "")).join("");
}

/** 剧本翻译成 faux 的回答；每次回答前记下这次请求收到的消息文本。 */
function toFaux(script: ScriptStep[], requests: string[][]): FauxResponseStep[] {
	return script.map((step, index) => (context) => {
		requests.push(context.messages.map(messageText));
		return "text" in step
			? fauxAssistantMessage(step.text)
			: fauxAssistantMessage([fauxToolCall(step.toolCall.name, step.toolCall.args as Parameters<typeof fauxToolCall>[1], { id: `call-${index}` })], {
					stopReason: "toolUse",
				});
	});
}

async function make(script: ScriptStep[]): Promise<MadeEngine> {
	const database = join(root, `engine-${databases++}.sqlite`);
	const requests: string[][] = [];

	async function open(steps: ScriptStep[]): Promise<AgentEngine> {
		const faux = fauxProvider();
		faux.setResponses(toFaux(steps, requests));
		const models = createModels();
		models.setProvider(faux.provider);
		// 第二组用例让模型调用 bash；这里在本机临时目录里执行，不需要 Docker
		return openPiEngine({ database, models, envFor: async () => new NodeExecutionEnv({ cwd: workdir }) });
	}

	let engine = await open(script);
	return {
		get engine() {
			return engine;
		},
		model: MODEL,
		async reopen(steps) {
			await engine.close();
			engine = await open(steps);
			return engine;
		},
		requests: () => requests,
		close: () => engine.close(),
	};
}

registerAgentEngineConformance({ describe, it, expect, beforeEach }, "pi-durable", make);

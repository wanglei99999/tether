import { type Message, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
	createRegistry,
	defineExtension,
	defineTool,
	GenerationTask,
	Harness,
	hook,
	LiveDoc,
	MemoryStorage,
	type SubmissionId,
	type TaskId,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { context, MODEL, toolCall } from "./harness.ts";

/** beforeRequest 每次被调用时看到的东西。 */
interface RequestProbe {
	runTaskId?: TaskId;
	startedBy?: SubmissionId;
	/** 这次请求所属的 generation 任务。 */
	generationTaskId: TaskId;
	lastRole?: string;
	messagesJson: string;
}

const noop = defineTool({
	name: "noop",
	description: "Does nothing",
	parameters: Type.Object({}),
	execute: async () => ({}),
});

/** 没有执行环境的 Harness：只用一个不碰环境的工具，钩子把每次请求前读到的运行信息记下来。 */
async function openProbedHarness(responses: FauxResponseStep[]) {
	const probes: RequestProbe[] = [];
	const faux = fauxProvider();
	faux.setResponses(responses);
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(
		defineExtension({
			name: "probe",
			tools: [noop],
			hooks: [
				hook(GenerationTask, {
					beforeRequest: async (request, api, hookContext) => {
						const live = await api.snapshot(LiveDoc, api.conversationId, hookContext);
						probes.push({
							runTaskId: live?.run?.taskId,
							startedBy: live?.run?.inputs[0],
							generationTaskId: api.taskId,
							lastRole: request.messages.at(-1)?.role,
							messagesJson: JSON.stringify(request.messages),
						});
						return undefined;
					},
				}),
			],
		}),
	);
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	const root = await harness.root(context, { agent: { model: MODEL } });
	return { harness, root, probes };
}

describe("pi-durable hooks and custom entries", () => {
	it("identifies the run and the input that started it from beforeRequest", async () => {
		const { harness, root, probes } = await openProbedHarness([
			toolCall("noop", {}, "n"),
			fauxAssistantMessage("ok1"),
			fauxAssistantMessage("ok2"),
		]);
		try {
			const first = await root.submit({ type: "input", content: "run 1" }, context);
			const firstSettled = await first.wait(context);
			const second = await root.submit({ type: "input", content: "run 2" }, context);
			await second.wait(context);

			// 第一轮两次请求（工具调用前后），第二轮一次
			expect(probes).toHaveLength(3);
			// LiveDoc.run.taskId 是当前 generation 任务，每次模型回合都换，不能当作"这一轮"的标识
			expect(probes.map((probe) => probe.runTaskId)).toEqual(probes.map((probe) => probe.generationTaskId));
			expect(probes[1]!.runTaskId).not.toBe(probes[0]!.runTaskId);
			// 一轮里不变的是 run.inputs[0]：触发这一轮的提交
			expect(probes[0]!.startedBy).toBe(first.id);
			expect(probes[1]!.startedBy).toBe(first.id);
			expect(probes[2]!.startedBy).toBe(second.id);
			// 便宜的判别方式：一轮的第一次请求以用户消息结尾，之后的以工具结果结尾
			expect(probes.map((probe) => probe.lastRole)).toEqual(["user", "toolResult", "user"]);

			// 触发这一轮的提交，记录着它放进对话的用户条目
			expect(firstSettled.type === "input" && firstSettled.status === "done").toBe(true);
			const userEntry = firstSettled.type === "input" ? firstSettled.entry : undefined;
			const transcript = await root.entries({}, 50, undefined, context);
			expect(transcript.items.find((entry) => entry.id === userEntry)?.kind).toBe("pi.user");
		} finally {
			await harness.close(context);
		}
	});

	it("writes tether entries that the model does or does not see", async () => {
		const { harness, root, probes } = await openProbedHarness([fauxAssistantMessage("ok")]);
		try {
			const note: Message = { role: "user", content: "工作区已重置", timestamp: 0 };
			await (
				await root.submit({ type: "write", entry: { kind: "tether.sandbox", data: { state: "running" } } }, context)
			).wait(context);
			await (
				await root.submit({ type: "write", entry: { kind: "tether.note", data: { reason: "reset" }, model: [note] } }, context)
			).wait(context);
			await (await root.submit({ type: "input", content: "go" }, context)).wait(context);

			// 条目都在，顺序与提交顺序一致（entries 返回新的在前）
			const kinds = (await root.entries({}, 50, undefined, context)).items.map((entry) => entry.kind).reverse();
			const at = (kind: string): number => kinds.indexOf(kind);
			expect(at("tether.sandbox")).toBeGreaterThanOrEqual(0);
			expect(at("tether.sandbox")).toBeLessThan(at("tether.note"));
			expect(at("tether.note")).toBeLessThan(at("pi.user"));

			// 模型只看到带 model 的那一条
			expect(probes).toHaveLength(1);
			expect(probes[0]!.messagesJson).toContain("工作区已重置");
			expect(probes[0]!.messagesJson).not.toContain("running");
		} finally {
			await harness.close(context);
		}
	});
});

import type { AgentEngine, EngineAgentConfig, ModelRef, TranscriptEntry } from "@tether/core";
import type { ConformanceRunner } from "./app-store.ts";

/** 与模型实现无关的剧本：每一步是模型的一次回答。 */
export type ScriptStep = { text: string } | { toolCall: { name: string; args: unknown } };

export interface MadeEngine {
	engine: AgentEngine;
	/** 剧本对应的模型，createSession 时用。 */
	model: ModelRef;
	/** 关闭当前引擎，在同一份存储上重新打开，模型换成新剧本。 */
	reopen(script: ScriptStep[]): Promise<AgentEngine>;
	/** 每次模型请求收到的消息文本，按请求顺序；重新打开后继续累积。 */
	requests(): string[][];
	close(): Promise<void>;
}

function config(model: ModelRef): EngineAgentConfig {
	return { model, instructions: "Be brief.", tools: [], cwd: "/workspace" };
}

function texts(entries: TranscriptEntry[]): string[] {
	return entries.flatMap((entry) => (entry.text === undefined ? [] : [entry.text]));
}

/** 任何 AgentEngine 实现都要通过的用例。 */
export function registerAgentEngineConformance(
	runner: ConformanceRunner,
	name: string,
	make: (script: ScriptStep[]) => Promise<MadeEngine>,
): void {
	const { describe, it, expect } = runner;

	async function withEngine(script: ScriptStep[], body: (made: MadeEngine) => Promise<void>): Promise<void> {
		const made = await make(script);
		try {
			await body(made);
		} finally {
			await made.close();
		}
	}

	describe(`AgentEngine conformance: ${name}`, () => {
		it("answers an input and lists user and assistant entries newest first", async () => {
			await withEngine([{ text: "Hi there." }], async ({ engine, model }) => {
				const id = await engine.createSession(config(model));
				expect(await engine.hasSession(id)).toBe(true);

				const { submissionId } = await engine.submit(id, { content: "hello", requestId: "r1" });
				const settled = await engine.waitSubmission(submissionId);

				expect(settled.status).toBe("done");
				expect(settled.answer).toMatchObject({ role: "assistant", text: "Hi there." });
				const { items } = await engine.transcript(id, { limit: 10 });
				// 引擎可以有自己的簿记条目（没有 role），这里只看对话
				expect(items.filter((e) => e.role).map((e) => [e.role, e.text])).toEqual([
					["assistant", "Hi there."],
					["user", "hello"],
				]);
				for (const entry of items) expect(typeof entry.id).toBe("string");
			});
		});

		it("pages the transcript with before", async () => {
			await withEngine([{ text: "one" }, { text: "two" }], async ({ engine, model }) => {
				const id = await engine.createSession(config(model));
				await engine.waitSubmission((await engine.submit(id, { content: "a", requestId: "r1" })).submissionId);
				await engine.waitSubmission((await engine.submit(id, { content: "b", requestId: "r2" })).submissionId);

				const all = await engine.transcript(id, { limit: 100 });
				expect(texts(all.items)).toEqual(["two", "b", "one", "a"]);
				expect(all.next).toBeUndefined();

				const first = await engine.transcript(id, { limit: 2 });
				expect(first.items).toHaveLength(2);
				expect(first.next).toBeDefined();
				const rest = await engine.transcript(id, { limit: 100, before: first.next });
				expect(rest.next).toBeUndefined();

				expect([...first.items, ...rest.items].map((e) => e.id)).toEqual(all.items.map((e) => e.id));
			});
		});

		it("returns the same submission for a repeated requestId, also after reopen, without asking the model again", async () => {
			const made = await make([{ text: "Once." }]);
			try {
				const id = await made.engine.createSession(config(made.model));
				const first = await made.engine.submit(id, { content: "go", requestId: "same" });
				await made.engine.waitSubmission(first.submissionId);
				const again = await made.engine.submit(id, { content: "go", requestId: "same" });
				expect(again.submissionId).toBe(first.submissionId);

				const reopened = await made.reopen([]);
				const afterReopen = await reopened.submit(id, { content: "go", requestId: "same" });

				expect(afterReopen.submissionId).toBe(first.submissionId);
				expect((await reopened.waitSubmission(afterReopen.submissionId)).status).toBe("done");
				expect(made.requests()).toHaveLength(1);
			} finally {
				await made.close();
			}
		});

		it("returns the first submission when a requestId is reused with different content", async () => {
			await withEngine([{ text: "First answer." }], async ({ engine, model, requests }) => {
				const id = await engine.createSession(config(model));
				const first = await engine.submit(id, { content: "original", requestId: "dup" });
				await engine.waitSubmission(first.submissionId);

				const second = await engine.submit(id, { content: "different", requestId: "dup" });

				expect(second.submissionId).toBe(first.submissionId);
				expect(texts((await engine.transcript(id, { limit: 10 })).items)).toEqual(["First answer.", "original"]);
				expect(requests()).toHaveLength(1);
			});
		});

		it("keeps conversations separate", async () => {
			await withEngine([{ text: "for A" }, { text: "for B" }], async ({ engine, model }) => {
				const a = await engine.createSession(config(model));
				const b = await engine.createSession(config(model));
				expect(a).not.toBe(b);

				await engine.waitSubmission((await engine.submit(a, { content: "to A", requestId: "r" })).submissionId);
				await engine.waitSubmission((await engine.submit(b, { content: "to B", requestId: "r" })).submissionId);

				expect(texts((await engine.transcript(a, { limit: 10 })).items)).toEqual(["for A", "to A"]);
				expect(texts((await engine.transcript(b, { limit: 10 })).items)).toEqual(["for B", "to B"]);
			});
		});

		it("appends a tether entry without model text that the model does not see", async () => {
			await withEngine([{ text: "ok" }], async ({ engine, model, requests }) => {
				const id = await engine.createSession(config(model));
				await engine.appendEntry(id, { kind: "tether.sandbox", data: { state: "secret-marker" } });
				await engine.waitSubmission((await engine.submit(id, { content: "hi", requestId: "r" })).submissionId);

				const { items } = await engine.transcript(id, { limit: 10 });
				expect(items.find((e) => e.kind === "tether.sandbox")).toMatchObject({ data: { state: "secret-marker" } });
				expect(requests()[0]?.join("\n")).not.toContain("secret-marker");
			});
		});

		it("appends a tether entry with model text that the model sees on the next request", async () => {
			await withEngine([{ text: "noted" }], async ({ engine, model, requests }) => {
				const id = await engine.createSession(config(model));
				await engine.appendEntry(id, {
					kind: "tether.sandbox",
					data: { state: "stopped" },
					modelText: "The sandbox was stopped while idle.",
				});
				await engine.waitSubmission((await engine.submit(id, { content: "hi", requestId: "r" })).submissionId);

				expect(requests()[0]).toContain("The sandbox was stopped while idle.");
			});
		});

		it("reports an unknown session", async () => {
			await withEngine([], async ({ engine }) => {
				expect(await engine.hasSession("999999")).toBe(false);
				expect(await engine.hasSession("not-a-number")).toBe(false);
				await expect(engine.submit("999999", { content: "x", requestId: "r" })).rejects.toMatchObject({
					code: "not_found",
				});
			});
		});
	});
}

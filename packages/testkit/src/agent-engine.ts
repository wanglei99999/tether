import {
	type AgentEngine,
	applyEvent,
	type EngineAgentConfig,
	type ModelRef,
	type SessionView,
	type TetherEvent,
	type TranscriptEntry,
} from "@tether/core";
import type { ConformanceRunner } from "./app-store.ts";

/** 与模型实现无关的剧本：每一步是模型的一次回答。 */
export type ScriptStep = { text: string } | { toolCall: { name: string; args: unknown } };

/**
 * make 的实现要给会话提供一个能执行 shell 命令的环境：第二组用例让模型调用 bash（例如 sleep）。
 */
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

function bashConfig(model: ModelRef): EngineAgentConfig {
	return { ...config(model), tools: ["bash"] };
}

function texts(entries: TranscriptEntry[]): string[] {
	return entries.flatMap((entry) => (entry.text === undefined ? [] : [entry.text]));
}

const bash = (command: string): ScriptStep => ({ toolCall: { name: "bash", args: { command } } });

interface Recorded {
	events: TetherEvent[];
	/** 等到某个事件出现，返回它。 */
	until(predicate: (event: TetherEvent) => boolean, timeoutMs?: number): Promise<TetherEvent>;
	stop(): Promise<void>;
}

/** 订阅并记下所有事件；提交之前订阅，事件就不会漏。 */
async function record(engine: AgentEngine, sessionId: string): Promise<Recorded> {
	const events: TetherEvent[] = [];
	const waiters = new Set<() => void>();
	const subscription = await engine.subscribe(sessionId, (batch) => {
		events.push(...batch);
		for (const wake of waiters) wake();
	});
	return {
		events,
		until(predicate, timeoutMs = 20_000) {
			return new Promise((resolve, reject) => {
				const check = () => {
					const found = events.find(predicate);
					if (!found) return;
					waiters.delete(check);
					clearTimeout(timer);
					resolve(found);
				};
				const timer = setTimeout(() => {
					waiters.delete(check);
					reject(new Error(`event not seen within ${timeoutMs} ms; got ${events.map((e) => e.type).join(", ")}`));
				}, timeoutMs);
				waiters.add(check);
				check();
			});
		},
		stop: () => subscription.stop(),
	};
}

function fold(events: TetherEvent[]): SessionView {
	const [first, ...rest] = events;
	if (first?.type !== "snapshot") throw new Error(`first event is ${first?.type}, not snapshot`);
	return rest.reduce(applyEvent, first.view);
}

/** 整个记录，旧的在前，与 SessionView.entries 的顺序一致。 */
async function fullTranscript(engine: AgentEngine, sessionId: string): Promise<TranscriptEntry[]> {
	return [...(await engine.transcript(sessionId, { limit: 1000 })).items].reverse();
}

const runEndOf = (submissionId: string) => (event: TetherEvent) =>
	event.type === "run_end" && event.submissionId === submissionId;

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

		it("delivers a snapshot first, then events whose application equals the final transcript", async () => {
			await withEngine([bash("echo hi"), { text: "It printed hi." }], async ({ engine, model }) => {
				const id = await engine.createSession(bashConfig(model));
				const recorded = await record(engine, id);
				try {
					const { submissionId } = await engine.submit(id, { content: "run it", requestId: "r" });
					await recorded.until(runEndOf(submissionId));

					const view = fold(recorded.events);
					const transcript = await fullTranscript(engine, id);
					expect(view.entries.map((e) => e.id)).toEqual(transcript.map((e) => e.id));
					expect(view.entries).toEqual(transcript);
					expect(view).toMatchObject({ running: false, tools: [] });
					expect(view.streaming).toBeUndefined();
					expect(recorded.events.some((e) => e.type === "tool_start" && e.name === "bash")).toBe(true);
				} finally {
					await recorded.stop();
				}
			});
		});

		it("delivers to two subscribers independently", async () => {
			await withEngine([{ text: "Hello both." }], async ({ engine, model }) => {
				const id = await engine.createSession(config(model));
				const first = await record(engine, id);
				const second = await record(engine, id);
				try {
					const { submissionId } = await engine.submit(id, { content: "hi", requestId: "r" });
					await first.until(runEndOf(submissionId));
					await second.until(runEndOf(submissionId));

					const transcript = await fullTranscript(engine, id);
					expect(fold(first.events).entries).toEqual(transcript);
					expect(fold(second.events).entries).toEqual(transcript);
				} finally {
					await first.stop();
					await second.stop();
				}
			});
		});

		it("queues a follow-up while busy and answers it after the current run", async () => {
			const script = [bash("sleep 1"), { text: "first done" }, { text: "second done" }];
			await withEngine(script, async ({ engine, model }) => {
				const id = await engine.createSession(bashConfig(model));
				const recorded = await record(engine, id);
				try {
					const a = await engine.submit(id, { content: "first", requestId: "a" });
					await recorded.until((e) => e.type === "tool_start");
					const b = await engine.submit(id, { content: "second", requestId: "b", whenBusy: "followUp" });

					expect((await engine.waitSubmission(a.submissionId)).answer?.text).toBe("first done");
					expect((await engine.waitSubmission(b.submissionId)).answer?.text).toBe("second done");
					const order = texts(await fullTranscript(engine, id));
					expect(order.indexOf("second")).toBeGreaterThan(order.indexOf("first done"));
				} finally {
					await recorded.stop();
				}
			});
		});

		it("rejects with TetherError busy when whenBusy is reject", async () => {
			await withEngine([bash("sleep 1"), { text: "done" }], async ({ engine, model }) => {
				const id = await engine.createSession(bashConfig(model));
				const recorded = await record(engine, id);
				try {
					const a = await engine.submit(id, { content: "first", requestId: "a" });
					await recorded.until((e) => e.type === "tool_start");

					await expect(
						engine.submit(id, { content: "second", requestId: "b", whenBusy: "reject" }),
					).rejects.toMatchObject({ name: "TetherError", code: "busy" });
					await engine.waitSubmission(a.submissionId);
				} finally {
					await recorded.stop();
				}
			});
		});

		it("aborts a running tool and settles the submission as unanswered", async () => {
			await withEngine([bash("sleep 30"), { text: "never" }], async ({ engine, model }) => {
				const id = await engine.createSession(bashConfig(model));
				const recorded = await record(engine, id);
				try {
					const started = Date.now();
					const { submissionId } = await engine.submit(id, { content: "wait", requestId: "r" });
					await recorded.until((e) => e.type === "tool_start");

					await engine.abort(id);

					expect((await engine.waitSubmission(submissionId)).status).toBe("unanswered");
					expect(Date.now() - started).toBeLessThan(15_000);
					const end = await recorded.until(runEndOf(submissionId));
					expect(end).toMatchObject({ status: "aborted" });
					expect(fold(recorded.events)).toMatchObject({ running: false, tools: [] });
				} finally {
					await recorded.stop();
				}
			});
		});

		it("continues an unfinished run after reopen", async () => {
			const made = await make([bash("sleep 2"), { text: "too late" }]);
			try {
				const id = await made.engine.createSession(bashConfig(made.model));
				const recorded = await record(made.engine, id);
				const { submissionId } = await made.engine.submit(id, { content: "go", requestId: "r" });
				await recorded.until((e) => e.type === "tool_start");
				await recorded.stop();

				const reopened = await made.reopen([{ text: "Recovered." }]);
				reopened.resume();

				const settled = await reopened.waitSubmission(submissionId);
				expect(settled).toMatchObject({ status: "done", answer: { text: "Recovered." } });
			} finally {
				await made.close();
			}
		});

		it("reports running during a run and not running after it settles", async () => {
			await withEngine([bash("sleep 1"), { text: "slept" }], async ({ engine, model }) => {
				const id = await engine.createSession(bashConfig(model));
				expect(await engine.isRunning(id)).toBe(false);
				const recorded = await record(engine, id);
				try {
					const { submissionId } = await engine.submit(id, { content: "sleep", requestId: "r" });
					await recorded.until((e) => e.type === "tool_start");

					expect(await engine.isRunning(id)).toBe(true);

					await engine.waitSubmission(submissionId);
					await recorded.until(runEndOf(submissionId));
					expect(await engine.isRunning(id)).toBe(false);
				} finally {
					await recorded.stop();
				}
			});
		});

		it("reports an unknown session from isRunning with not_found", async () => {
			await withEngine([], async ({ engine }) => {
				await expect(engine.isRunning("999999")).rejects.toMatchObject({ code: "not_found" });
			});
		});

		it("forks at an entry: the fork sees entries up to it and none after", async () => {
			await withEngine([{ text: "one" }, { text: "two" }], async ({ engine, model }) => {
				const id = await engine.createSession(config(model));
				const first = await engine.waitSubmission((await engine.submit(id, { content: "a", requestId: "r1" })).submissionId);
				await engine.waitSubmission((await engine.submit(id, { content: "b", requestId: "r2" })).submissionId);

				const fork = await engine.fork(id, first.answer!.id);

				expect(fork).not.toBe(id);
				expect(await engine.hasSession(fork)).toBe(true);
				expect(texts((await engine.transcript(fork, { limit: 10 })).items)).toEqual(["one", "a"]);
			});
		});

		it("gives entries written after a fork ids greater than the fork point", async () => {
			await withEngine([{ text: "one" }, { text: "two" }, { text: "three" }], async ({ engine, model }) => {
				const id = await engine.createSession(config(model));
				const first = await engine.waitSubmission((await engine.submit(id, { content: "a", requestId: "r1" })).submissionId);
				await engine.waitSubmission((await engine.submit(id, { content: "b", requestId: "r2" })).submissionId);
				const parentIds = (await engine.transcript(id, { limit: 100 })).items.map((e) => Number(e.id));
				const fork = await engine.fork(id, first.answer!.id);

				await engine.waitSubmission((await engine.submit(fork, { content: "c", requestId: "r3" })).submissionId);

				const forkEntries = (await engine.transcript(fork, { limit: 100 })).items;
				const added = forkEntries.filter((e) => Number(e.id) > Number(first.answer!.id));
				expect(texts(added)).toEqual(["three", "c"]);
				// 不只大于分叉点，也大于父会话里已有的全部条目：ID 在整个存储里递增
				for (const entry of added) expect(Number(entry.id)).toBeGreaterThan(Math.max(...parentIds));
			});
		});

		it("keeps the parent unchanged when the fork gets new entries", async () => {
			await withEngine([{ text: "one" }, { text: "two" }, { text: "three" }], async ({ engine, model }) => {
				const id = await engine.createSession(config(model));
				const first = await engine.waitSubmission((await engine.submit(id, { content: "a", requestId: "r1" })).submissionId);
				await engine.waitSubmission((await engine.submit(id, { content: "b", requestId: "r2" })).submissionId);
				const fork = await engine.fork(id, first.answer!.id);

				await engine.waitSubmission((await engine.submit(fork, { content: "c", requestId: "r3" })).submissionId);

				expect(texts((await engine.transcript(id, { limit: 10 })).items)).toEqual(["two", "b", "one", "a"]);
			});
		});

		it("rejects a fork at an entry that does not exist with invalid_request", async () => {
			await withEngine([{ text: "one" }], async ({ engine, model }) => {
				const id = await engine.createSession(config(model));
				await engine.waitSubmission((await engine.submit(id, { content: "a", requestId: "r1" })).submissionId);

				await expect(engine.fork(id, "999999")).rejects.toMatchObject({ code: "invalid_request" });
				await expect(engine.fork(id, "not-a-number")).rejects.toMatchObject({ code: "invalid_request" });
			});
		});

		it("returns the user entry of a submission once it is placed", async () => {
			await withEngine([{ text: "Hi there." }], async ({ engine, model }) => {
				const id = await engine.createSession(config(model));
				const { submissionId } = await engine.submit(id, { content: "hello", requestId: "r1" });
				await engine.waitSubmission(submissionId);

				const user = (await engine.transcript(id, { limit: 10 })).items.find((e) => e.role === "user");
				expect(await engine.submissionEntry(submissionId)).toBe(user!.id);
				await expect(engine.submissionEntry("999999")).rejects.toMatchObject({ code: "not_found" });
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

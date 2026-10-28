import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { AgentEngine } from "@tether/core";
import { type MadeEngine, registerAgentEngineConformance, type ScriptStep } from "@tether/testkit";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { openPiEngine } from "../src/adapters/engine-pi/index.ts";
import { FAUX_MODEL, fauxModels } from "./fixtures/faux.ts";

const root = mkdtempSync(join(tmpdir(), "tether-engine-"));
const workdir = mkdtempSync(join(root, "work-"));
let databases = 0;

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

async function make(script: ScriptStep[]): Promise<MadeEngine> {
	const database = join(root, `engine-${databases++}.sqlite`);
	const requests: string[][] = [];

	async function open(steps: ScriptStep[]): Promise<AgentEngine> {
		// 第二组用例让模型调用 bash；这里在本机临时目录里执行，不需要 Docker
		return openPiEngine({
			database,
			models: fauxModels(steps, requests),
			envFor: async () => new NodeExecutionEnv({ cwd: workdir }),
		});
	}

	let engine = await open(script);
	return {
		get engine() {
			return engine;
		},
		model: FAUX_MODEL,
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

describe("pi engine run-start hook", () => {
	const bashConfig = { model: FAUX_MODEL, instructions: "Be brief.", tools: ["bash"], cwd: "/workspace" };

	async function openWithHook(
		script: ScriptStep[],
		onRunStart: (engineSessionId: string, submissionId: string) => Promise<void>,
		onError: (error: unknown) => void = () => {},
	): Promise<AgentEngine> {
		return openPiEngine({
			database: join(root, `engine-${databases++}.sqlite`),
			models: fauxModels(script),
			envFor: async () => new NodeExecutionEnv({ cwd: workdir }),
			onRunStart,
			onError,
		});
	}

	it("calls onRunStart before every model request with the submission that started the run", async () => {
		const calls: [string, string][] = [];
		const engine = await openWithHook(
			[{ toolCall: { name: "bash", args: { command: "true" } } }, { text: "ran" }, { text: "second" }],
			async (session, submission) => {
				calls.push([session, submission]);
			},
		);
		try {
			const id = await engine.createSession(bashConfig);
			const s1 = (await engine.submit(id, { content: "first", requestId: "r1" })).submissionId;
			await engine.waitSubmission(s1);
			const s2 = (await engine.submit(id, { content: "second", requestId: "r2" })).submissionId;
			await engine.waitSubmission(s2);

			// 第一轮两次请求（工具调用前后），第二轮一次
			expect(calls).toEqual([
				[id, s1],
				[id, s1],
				[id, s2],
			]);
		} finally {
			await engine.close();
		}
	});

	it("keeps inputs[0] as the first submission when a steer input joins the run", async () => {
		const calls: string[] = [];
		let toolStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			toolStarted = resolve;
		});
		const engine = await openWithHook(
			[{ toolCall: { name: "bash", args: { command: "sleep 1" } } }, { text: "steered" }],
			async (_session, submission) => {
				calls.push(submission);
			},
		);
		try {
			const id = await engine.createSession(bashConfig);
			const subscription = await engine.subscribe(id, (events) => {
				if (events.some((e) => e.type === "tool_start")) toolStarted();
			});
			const s1 = (await engine.submit(id, { content: "first", requestId: "r1" })).submissionId;
			await started;
			const s2 = (await engine.submit(id, { content: "also this", requestId: "r2", whenBusy: "steer" })).submissionId;
			await engine.waitSubmission(s1);
			await engine.waitSubmission(s2);
			await subscription.stop();

			// steer 的输入并进这一轮：工具结果之后那次请求的 inputs[0] 仍是第一条提交
			expect(calls).toEqual([s1, s1]);
		} finally {
			await engine.close();
		}
	});

	it("reports an onRunStart failure through onError and still answers", async () => {
		const errors: unknown[] = [];
		const engine = await openWithHook(
			[{ text: "answered anyway" }],
			async () => {
				throw new Error("snapshot exploded");
			},
			(error) => errors.push(error),
		);
		try {
			const id = await engine.createSession(bashConfig);
			const settled = await engine.waitSubmission((await engine.submit(id, { content: "go", requestId: "r" })).submissionId);

			expect(settled).toMatchObject({ status: "done", answer: { text: "answered anyway" } });
			expect(errors.map((e) => (e instanceof Error ? e.message : String(e)))).toContain("snapshot exploded");
		} finally {
			await engine.close();
		}
	});
});

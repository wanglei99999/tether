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

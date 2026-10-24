import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { ToolResultEntry } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildImage, dockerExec, removeContainer, startContainer } from "./docker.ts";
import { CRASH_COMMAND, context, openSpikeHarness, toolCall } from "./harness.ts";

const CONTAINER = "tether-m0-e2e";
const TMP = resolve(".tmp");

async function freshDatabase(name: string): Promise<string> {
	const path = resolve(TMP, name);
	await mkdir(TMP, { recursive: true });
	await Promise.all(["", "-wal", "-shm"].map((suffix) => rm(path + suffix, { force: true })));
	return path;
}

/**
 * 等到容器里的检查脚本成功；超时抛错。
 * 不用 `pgrep -f`：`docker exec sh -c "pgrep -f '...'"` 里的 sh 自己的命令行就含有模式，会匹配到自己。
 */
async function waitFor(check: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if ((await dockerExec(CONTAINER, check)).code === 0) return;
		await sleep(100);
	}
	throw new Error(`'${check}' did not succeed in ${CONTAINER} after ${timeoutMs} ms`);
}

function resultText(message: ToolResultMessage): string {
	return message.content.map((item) => (item.type === "text" ? item.text : "")).join("");
}

describe("pi-durable drives tools inside the container", () => {
	beforeAll(async () => {
		await buildImage();
		await removeContainer(CONTAINER);
		await startContainer(CONTAINER);
	}, 600_000);

	afterAll(async () => {
		await removeContainer(CONTAINER);
	});

	it("runs write and bash inside the container and does not resubmit after reopen", async () => {
		const database = await freshDatabase("e2e.sqlite");
		const first = await openSpikeHarness(database, CONTAINER, [
			toolCall("write", { path: "hello.txt", content: "from tether" }, "w"),
			toolCall("bash", { command: "wc -c < hello.txt > size.txt" }, "b"),
			fauxAssistantMessage("Done."),
		]);
		const submission = await first.root.submit({ type: "input", content: "go", requestId: "e2e-1" }, context);
		expect((await submission.wait(context)).status).toBe("done");
		expect(first.faux.state.callCount).toBe(3);
		await first.close();

		// hello.txt 是 11 字节的 "from tether"（write 不追加换行），size.txt 是容器里 wc 算出的 "11\n"
		const files = await dockerExec(CONTAINER, "cat /workspace/hello.txt /workspace/size.txt");
		expect(files.stdout).toBe("from tether11\n");

		// 重新打开同一个 SQLite，用同一个 requestId 再提交：拿回原来的提交，模型不再被调用
		const second = await openSpikeHarness(database, CONTAINER, []);
		try {
			const again = await second.root.submit({ type: "input", content: "go", requestId: "e2e-1" }, context);
			expect(again.id).toBe(submission.id);
			expect((await again.wait(context)).status).toBe("done");
			expect(second.faux.state.callCount).toBe(0);
		} finally {
			await second.close();
		}
	});

	it("reports an interrupted bash after the harness process is killed, without rerunning it", async () => {
		const database = await freshDatabase("e2e-crash.sqlite");
		const child = spawn(process.execPath, [resolve("spikes/m0/crash-child.ts"), database, CONTAINER], {
			stdio: ["ignore", "inherit", "inherit"],
		});
		const exited = new Promise<void>((done) => child.once("exit", () => done()));
		try {
			// runs.txt 出现，说明 bash 已经在容器里开始执行
			await waitFor("test -s /workspace/runs.txt", 60_000);
		} finally {
			child.kill("SIGKILL");
			await exited;
		}

		const recovered = await openSpikeHarness(database, CONTAINER, [fauxAssistantMessage("Recovered.")]);
		try {
			const submission = await recovered.root.submit(
				{ type: "input", content: "run it", requestId: "crash-1" },
				context,
			);
			expect((await submission.wait(context)).status).toBe("done");
			// 只有被中断之后的那一轮请求了模型；bash 没有被重新执行
			expect(recovered.faux.state.callCount).toBe(1);

			const transcript = await recovered.root.entries({}, 50, undefined, context);
			const results = transcript.items
				.filter((entry) => ToolResultEntry.is(entry))
				.map((entry) => entry.model![0] as ToolResultMessage)
				.filter((message) => message.toolCallId === "s");
			expect(results).toHaveLength(1);
			expect(results[0]!.isError).toBe(true);
			expect(resultText(results[0]!)).toMatch(/interrupt/i);

			// 观察，不断言：旧命令会不会在引擎认定它中断之后继续跑完（任务 5 用隔离解决）
			await sleep(7_000);
			const runs = await dockerExec(CONTAINER, "cat /workspace/runs.txt 2>/dev/null | wc -l");
			const late = await dockerExec(CONTAINER, "test -e /workspace/log.txt");
			const observation = {
				command: CRASH_COMMAND,
				resultText: resultText(results[0]!),
				runs: Number(runs.stdout.trim()),
				oldCommandFinished: late.code === 0,
			};
			await writeFile(resolve(TMP, "e2e-crash-observation.json"), `${JSON.stringify(observation, null, "\t")}\n`);
			expect(observation.runs).toBe(1);
		} finally {
			await recovered.close();
		}
	}, 180_000);
});

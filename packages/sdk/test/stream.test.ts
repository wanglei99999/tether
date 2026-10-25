import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SDK = fileURLToPath(new URL("../src/index.ts", import.meta.url));

/** 拿一个当前没人监听的端口。 */
async function closedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	await new Promise<void>((done) => server.close(() => done()));
	if (address === null || typeof address === "string") throw new Error("no port");
	return address.port;
}

describe("SessionStream", () => {
	// 连接被拒绝时 Node 的 WebSocket 只发 error、不一定发 close。只在 close 里安排重连的话，
	// 进程里没有别的事可做就会以退出码 0 直接退出，CLI 的 send --follow 看起来像成功了
	it("keeps reconnecting in a bare process while the server is unreachable", async () => {
		const port = await closedPort();
		const script = `
			import { TetherClient } from ${JSON.stringify(SDK)};
			new TetherClient({ baseUrl: "http://127.0.0.1:${port}" }).follow("ses_1", () => {});
		`;
		const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
		const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));

		const early = await Promise.race([exited, sleep(1_500).then(() => "running" as const)]);
		child.kill();
		await exited;
		expect(early).toBe("running");
	});
});

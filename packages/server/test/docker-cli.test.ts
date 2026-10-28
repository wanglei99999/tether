import { describe, expect, it } from "vitest";
import { docker } from "../src/adapters/sandbox-docker/docker-cli.ts";

// 用别的可执行文件代替 docker：sleep 模拟卡住的守护进程，sh 模拟出错退出
describe("docker", () => {
	it("fails a docker command that runs past its timeout with sandbox_failed", async () => {
		const started = Date.now();

		await expect(docker(["5"], { timeoutMs: 300, bin: "sleep" })).rejects.toMatchObject({
			code: "sandbox_failed",
			message: "docker 5 timed out after 0.3 s",
		});
		// 到时就杀掉子进程，不等它自己结束
		expect(Date.now() - started).toBeLessThan(3_000);
	});

	it("returns a non-zero exit as a result, not an error", async () => {
		expect(await docker(["-c", "echo oops >&2; exit 3"], { bin: "sh" })).toEqual({ code: 3, stdout: "", stderr: "oops\n" });
	});
});

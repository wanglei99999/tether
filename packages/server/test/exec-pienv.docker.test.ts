import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import type { SandboxBinding } from "@tether/core";
import { sampleSandboxSpec } from "@tether/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPiEnvExecChannel } from "../src/adapters/exec-pienv/index.ts";
import { buildSandboxImage, createDockerSandboxProvider } from "../src/adapters/sandbox-docker/index.ts";

const run = promisify(execFile);
const IMAGE = "tether-sandbox:dev";
const T0 = "2026-10-25T00:00:00.000Z";

const workspaceRoot = mkdtempSync(join(tmpdir(), "tether-ws-"));
const provider = createDockerSandboxProvider({
	workspaceRoot,
	user: `${process.getuid?.()}:${process.getgid?.()}`,
	defaultImage: IMAGE,
});
/** 只测通道本身：不经 SandboxService，不隔离，固定用绑定里的 epoch。 */
let connects = 0;
const channel = createPiEnvExecChannel({
	connect: async (b) => {
		connects++;
		return provider.daemonCommand(b.sandboxId, b.epoch);
	},
});
let binding: SandboxBinding;

async function dockerExec(script: string): Promise<string> {
	return (await run("docker", ["exec", binding.sandboxId, "sh", "-c", script])).stdout.trim();
}

beforeAll(async () => {
	await buildSandboxImage(IMAGE);
	const sessionId = `ses_x${process.pid}_${Date.now().toString(36)}`;
	const { sandboxId } = await provider.create({ sessionId, spec: sampleSandboxSpec() });
	binding = {
		sessionId,
		provider: "docker",
		sandboxId,
		epoch: 1,
		state: "running",
		template: "",
		createdAt: T0,
		lastUsedAt: T0,
	};
});

afterAll(async () => {
	channel.closeAll();
	if (binding) await provider.destroy(binding.sandboxId);
	rmSync(workspaceRoot, { recursive: true, force: true });
});

registerEnvConformance(
	{ describe, expect, it },
	"exec-pienv on docker",
	async (use) => {
		// 路径必须在容器里，不能用宿主的 mkdtemp
		const cwd = await dockerExec("mktemp -d /workspace/case-XXXXXX");
		try {
			await use(channel.piEnv(binding, cwd));
		} finally {
			await dockerExec(`rm -rf ${cwd}`);
		}
	},
	{ listFiles: true },
);

describe("exec-pienv TetherEnv", () => {
	it("reads back what it writes through TetherEnv", async () => {
		const env = channel.env(binding, { cwd: "/workspace" });

		await env.writeFile("notes/hello.txt", "héllo\n");

		expect(await env.readText("notes/hello.txt")).toBe("héllo\n");
		expect(await env.exists("notes/hello.txt")).toBe(true);
		expect(await env.exists("notes/absent.txt")).toBe(false);
		expect(await env.list("notes")).toEqual([{ name: "hello.txt", kind: "file", size: 7 }]);
	});

	it("runs commands in cwd and returns exit code, stdout and stderr", async () => {
		const env = channel.env(binding, { cwd: "/workspace" });

		const result = await env.exec("pwd; echo oops >&2; exit 3");

		expect(result).toEqual({ exitCode: 3, stdout: "/workspace\n", stderr: "oops\n" });
	});

	it("passes shellEnv as environment variables without interpolation", async () => {
		const env = channel.env(binding, { cwd: "/workspace", shellEnv: { NAME: "x; touch pwned" } });

		const result = await env.exec('printf %s "$NAME"');

		expect(result.stdout).toBe("x; touch pwned");
		expect(await env.exists("pwned")).toBe(false);
	});

	it("passes per-call env the same way", async () => {
		const env = channel.env(binding, { cwd: "/workspace" });

		const result = await env.exec('printf %s "$REPO_URL"', { env: { REPO_URL: '"; touch pwned2; "' } });

		expect(result.stdout).toBe('"; touch pwned2; "');
		expect(await env.exists("pwned2")).toBe(false);
	});

	it("reads bytes, file info and the real path through the daemon", async () => {
		const env = channel.env(binding, { cwd: "/workspace" });
		await env.writeFile("bin/data.bin", new Uint8Array([0, 255, 1, 2]));
		await dockerExec("ln -sfn /etc /workspace/etc-link");

		expect(await env.readBytes("bin/data.bin")).toEqual(new Uint8Array([0, 255, 1, 2]));
		expect(await env.info("bin/data.bin")).toEqual({ name: "data.bin", kind: "file", size: 4 });
		expect(await env.info("bin")).toMatchObject({ name: "bin", kind: "dir" });
		expect(await env.realPath("bin/../bin/data.bin")).toBe("/workspace/bin/data.bin");
		expect(await env.realPath("etc-link")).toBe("/etc");
		await expect(env.realPath("nope")).rejects.toMatchObject({ code: "not_found" });
	});

	it("maps a missing file to TetherError not_found", async () => {
		const env = channel.env(binding, { cwd: "/workspace" });

		await expect(env.readText("does/not/exist.txt")).rejects.toMatchObject({ name: "TetherError", code: "not_found" });
	});

	it("reuses one connection for the same sandbox", async () => {
		await channel.env(binding, { cwd: "/workspace" }).exists("a");
		const before = connects;
		await channel.env(binding, { cwd: "/tmp" }).exists("b");

		const records = (await dockerExec("ls /run/tether/daemons")).split("\n");

		expect(connects).toBe(before);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatch(/^1\.\d+$/);
	});

	it("keeps files across provider stop and start", async () => {
		const env = channel.env(binding, { cwd: "/workspace" });
		await env.writeFile("survives.txt", "still here");

		await provider.stop(binding.sandboxId);
		await provider.start(binding.sandboxId);

		expect(await channel.env(binding, { cwd: "/workspace" }).readText("survives.txt")).toBe("still here");
	});
});

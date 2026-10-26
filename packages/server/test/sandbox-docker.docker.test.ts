import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SandboxProvider } from "@tether/core";
import { registerSandboxProviderConformance, sampleSandboxSpec } from "@tether/testkit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildSandboxImage, createDockerSandboxProvider } from "../src/adapters/sandbox-docker/index.ts";
import { runtimeOption } from "./fixtures/runtime.ts";

const run = promisify(execFile);
const IMAGE = "tether-sandbox:dev";
const USER = `${process.getuid?.()}:${process.getgid?.()}`;

async function docker(...args: string[]): Promise<string> {
	return (await run("docker", args)).stdout.trim();
}

function inspect(sandboxId: string, format: string): Promise<string> {
	return docker("inspect", "--format", format, sandboxId);
}

let counter = 0;
const nextSessionId = () => `ses_t${process.pid}_${Date.now().toString(36)}_${counter++}`;

beforeAll(async () => {
	await buildSandboxImage(IMAGE);
});

/** 每个用例一个独立的工作区根目录，结束时销毁这次建过的所有沙箱。 */
async function makeProvider(options: { runtime?: string } = {}) {
	const workspaceRoot = mkdtempSync(join(tmpdir(), "tether-ws-"));
	const provider = createDockerSandboxProvider({ workspaceRoot, user: USER, defaultImage: IMAGE, ...runtimeOption(), ...options });
	const created: string[] = [];
	const tracked: SandboxProvider = {
		...provider,
		create: async (input) => {
			const result = await provider.create(input);
			created.push(result.sandboxId);
			return result;
		},
	};
	return {
		provider: tracked,
		workspaceRoot,
		sessionId: nextSessionId,
		cleanup: async () => {
			for (const sandboxId of created) await provider.destroy(sandboxId);
			rmSync(workspaceRoot, { recursive: true, force: true });
		},
	};
}

registerSandboxProviderConformance({ describe, it, expect, beforeEach }, "docker", () => makeProvider());

describe("docker sandbox specifics", () => {
	let made: Awaited<ReturnType<typeof makeProvider>>;

	beforeEach(async () => {
		made = await makeProvider();
		return () => made.cleanup();
	});

	afterAll(async () => {
		// 兜底：用例中途失败时也不留下本进程建的容器
		const names = await docker("ps", "-aq", "--filter", "label=tether.managed=1", "--filter", `name=tether-ses_t${process.pid}_`);
		if (names) await run("docker", ["rm", "--force", ...names.split("\n")]);
	});

	it("runs the container as the given uid:gid with PID 1 sleep", async () => {
		const { sandboxId } = await made.provider.create({ sessionId: made.sessionId(), spec: sampleSandboxSpec() });

		expect(await docker("exec", sandboxId, "sh", "-c", "echo $(id -u):$(id -g)")).toBe(USER);
		expect(await docker("exec", sandboxId, "cat", "/proc/1/comm")).toBe("sleep");
	});

	it("applies cpu, memory and network none", async () => {
		const { sandboxId } = await made.provider.create({ sessionId: made.sessionId(), spec: sampleSandboxSpec() });

		expect(await inspect(sandboxId, "{{.HostConfig.NanoCpus}}")).toBe("1000000000");
		expect(await inspect(sandboxId, "{{.HostConfig.Memory}}")).toBe(String(512 * 1024 * 1024));
		expect(await inspect(sandboxId, "{{.HostConfig.NetworkMode}}")).toBe("none");
	});

	it("uses bridge networking for egress", async () => {
		const { sandboxId } = await made.provider.create({
			sessionId: made.sessionId(),
			spec: sampleSandboxSpec({ network: "egress" }),
		});

		expect(await inspect(sandboxId, "{{.HostConfig.NetworkMode}}")).toBe("bridge");
	});

	it("mounts <workspaceRoot>/<sessionId> at /workspace", async () => {
		const sessionId = made.sessionId();
		const { sandboxId } = await made.provider.create({ sessionId, spec: sampleSandboxSpec() });

		await docker("exec", sandboxId, "sh", "-c", "echo hello > /workspace/probe.txt");

		expect(existsSync(join(made.workspaceRoot, sessionId, "probe.txt"))).toBe(true);
	});

	it("removes the workspace directory on destroy", async () => {
		const sessionId = made.sessionId();
		const { sandboxId } = await made.provider.create({ sessionId, spec: sampleSandboxSpec() });
		await docker("exec", sandboxId, "sh", "-c", "mkdir -p /workspace/a/b && echo x > /workspace/a/b/c");

		await made.provider.destroy(sandboxId);

		expect(existsSync(join(made.workspaceRoot, sessionId))).toBe(false);
	});

	it("labels containers tether.managed=1 and tether.session=<id>", async () => {
		const sessionId = made.sessionId();
		const { sandboxId } = await made.provider.create({ sessionId, spec: sampleSandboxSpec() });

		expect(await inspect(sandboxId, '{{index .Config.Labels "tether.managed"}}')).toBe("1");
		expect(await inspect(sandboxId, '{{index .Config.Labels "tether.session"}}')).toBe(sessionId);
	});

	it("runs the sandbox with no capabilities and no-new-privileges", async () => {
		const { sandboxId } = await made.provider.create({ sessionId: made.sessionId(), spec: sampleSandboxSpec() });

		expect(await inspect(sandboxId, "{{json .HostConfig.CapDrop}}")).toBe('["ALL"]');
		expect(await inspect(sandboxId, "{{json .HostConfig.CapAdd}}")).toBe("null");
		expect(await inspect(sandboxId, "{{json .HostConfig.SecurityOpt}}")).toBe('["no-new-privileges"]');
		// 进程里看到的有效能力集也是空的
		expect(await docker("exec", sandboxId, "sh", "-c", "grep CapEff /proc/self/status")).toMatch(/CapEff:\s+0+$/);
	});

	// 用 runsc 而不是默认的 runc：传不传都是 runc 的话测不出来。需要测试机装了 gVisor（Task 9）
	it("passes the configured runtime to docker run", async () => {
		const gvisor = await makeProvider({ runtime: "runsc" });
		try {
			const { sandboxId } = await gvisor.provider.create({ sessionId: gvisor.sessionId(), spec: sampleSandboxSpec() });
			expect(await inspect(sandboxId, "{{.HostConfig.Runtime}}")).toBe("runsc");
		} finally {
			await gvisor.cleanup();
		}
	});

	it("removes the container and the workspace when docker run creates it but cannot start it", async () => {
		// 空镜像里没有 sleep：容器建得出来，启动失败
		await run("sh", ["-c", "tar cf - --files-from /dev/null | docker import - tether-test-empty:1"]);
		const sessionId = made.sessionId();

		await expect(
			made.provider.create({ sessionId, spec: sampleSandboxSpec({ template: "tether-test-empty:1" }) }),
		).rejects.toMatchObject({ code: "sandbox_failed" });

		expect(await docker("ps", "-aq", "--filter", `name=^tether-${sessionId}$`)).toBe("");
		expect(existsSync(join(made.workspaceRoot, sessionId))).toBe(false);
		// 同一个会话再建一次不会撞上残留的同名容器
		const { sandboxId } = await made.provider.create({ sessionId, spec: sampleSandboxSpec() });
		expect(await made.provider.status(sandboxId)).toBe("running");
	});

	it("keeps sleep as PID 1 when the template image has its own entrypoint", async () => {
		// 入口是一个不 exec 的 shell：不覆盖的话 PID 1 是 sh，fence 永远失败
		await run("sh", [
			"-c",
			`printf 'FROM ${IMAGE}\\nENTRYPOINT ["/bin/sh", "-c", "sleep infinity; true"]\\n' | docker build -q -t tether-test-entrypoint:1 -`,
		]);
		const { sandboxId } = await made.provider.create({
			sessionId: made.sessionId(),
			spec: sampleSandboxSpec({ template: "tether-test-entrypoint:1" }),
		});

		expect(await docker("exec", sandboxId, "cat", "/proc/1/comm")).toBe("sleep");
		await expect(made.provider.fence(sandboxId, 1)).resolves.toMatchObject({ killed: expect.any(Number) });
	});

	it("rejects a session id that is not a plain name", async () => {
		await expect(
			made.provider.create({ sessionId: "../escape", spec: sampleSandboxSpec() }),
		).rejects.toMatchObject({ code: "invalid_request" });
	});
});

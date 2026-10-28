import { execFile } from "node:child_process";
import { existsSync, realpathSync, rmSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SandboxProvider } from "@tether/core";
import { registerSandboxProviderConformance, sampleSandboxSpec } from "@tether/testkit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildSandboxImage, createDockerSandboxProvider } from "../src/adapters/sandbox-docker/index.ts";
import { runtimeOption } from "./fixtures/runtime.ts";
import { freshRoot, type StorageMode } from "./fixtures/storage.ts";

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
async function makeProvider(mode: StorageMode, options: { runtime?: string } = {}) {
	const workspaceRoot = freshRoot(mode);
	const provider = createDockerSandboxProvider({
		workspaceRoot,
		user: USER,
		defaultImage: IMAGE,
		storage: mode,
		defaultDiskMb: 512,
		...runtimeOption(),
		...options,
	});
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

afterAll(async () => {
	// 兜底：用例中途失败时也不留下本进程建的容器和卷
	const names = await docker("ps", "-aq", "--filter", "label=tether.managed=1", "--filter", `name=tether-ses_t${process.pid}_`);
	if (names) await run("docker", ["rm", "--force", ...names.split("\n")]);
	const volumes = await docker("volume", "ls", "-q", "--filter", `name=tether-ses_t${process.pid}_`);
	if (volumes) await run("docker", ["volume", "rm", "--force", ...volumes.split("\n")]);
});

for (const mode of ["image", "directory"] as const) {
	registerSandboxProviderConformance({ describe, it, expect, beforeEach }, `docker (${mode})`, () => makeProvider(mode));

	describe(`docker sandbox specifics (${mode})`, () => {
		let made: Awaited<ReturnType<typeof makeProvider>>;

		beforeEach(async () => {
			made = await makeProvider(mode);
			return () => made.cleanup();
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

		it("lets the sandbox user write to /workspace", async () => {
			const { sandboxId } = await made.provider.create({ sessionId: made.sessionId(), spec: sampleSandboxSpec() });

			await docker("exec", sandboxId, "sh", "-c", "echo hello > /workspace/probe.txt");

			expect(await docker("exec", sandboxId, "cat", "/workspace/probe.txt")).toBe("hello");
			expect(await docker("exec", sandboxId, "stat", "-c", "%u:%g", "/workspace")).toBe(USER);
		});

		it("keeps files across stop and start", async () => {
			const { sandboxId } = await made.provider.create({ sessionId: made.sessionId(), spec: sampleSandboxSpec() });
			await docker("exec", sandboxId, "sh", "-c", "echo kept > /workspace/kept.txt");

			await made.provider.stop(sandboxId);
			await made.provider.start(sandboxId);

			expect(await docker("exec", sandboxId, "cat", "/workspace/kept.txt")).toBe("kept");
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

		// 用 runsc 而不是默认的 runc：传不传都是 runc 的话测不出来。需要测试机装了 gVisor
		it("passes the configured runtime to docker run", async () => {
			const gvisor = await makeProvider(mode, { runtime: "runsc" });
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
}

describe("docker sandbox specifics (directory only)", () => {
	let made: Awaited<ReturnType<typeof makeProvider>>;

	beforeEach(async () => {
		made = await makeProvider("directory");
		return () => made.cleanup();
	});

	it("mounts <workspaceRoot>/<sessionId> at /workspace", async () => {
		const sessionId = made.sessionId();
		const { sandboxId } = await made.provider.create({ sessionId, spec: sampleSandboxSpec() });

		await docker("exec", sandboxId, "sh", "-c", "echo hello > /workspace/probe.txt");

		expect(existsSync(join(made.workspaceRoot, sessionId, "probe.txt"))).toBe(true);
	});
});

describe("docker sandbox specifics (image only)", () => {
	let made: Awaited<ReturnType<typeof makeProvider>>;

	beforeEach(async () => {
		made = await makeProvider("image");
		return () => made.cleanup();
	});

	const disk = (sessionId: string) => join(made.workspaceRoot, sessionId, "disk.img");
	/** 一次性特权容器里跑 losetup（loop 设备是内核全局的）。 */
	const losetup = async (...args: string[]) => {
		const root = realpathSync(made.workspaceRoot);
		return docker("run", "--rm", "--privileged", "--network", "none", "-v", "/dev:/dev", "-v", `${root}:${root}`, IMAGE, "losetup", ...args);
	};
	/** 接着这个文件的 loop 设备（按设备号和 inode 找，和实现用的是同一种办法）。 */
	const associated = async (file: string) =>
		(await losetup("--list", "--noheadings", "--output", "NAME", "--associated", realpathSync(file))).split("\n").filter(Boolean);

	it("mounts an XFS image of diskMb at /workspace", async () => {
		const sessionId = made.sessionId();
		const spec = sampleSandboxSpec({ resources: { cpu: 1, memoryMb: 512, diskMb: 512 } });
		const { sandboxId } = await made.provider.create({ sessionId, spec });

		expect(await docker("exec", sandboxId, "stat", "-f", "-c", "%T", "/workspace")).toBe("xfs");
		const sizeMb = Number(await docker("exec", sandboxId, "sh", "-c", "df -m --output=size /workspace | tail -1"));
		// XFS 的日志和元数据占掉一部分：512 MB 的镜像约 448 MB 可用；要证明的是"这是镜像，不是宿主盘"
		expect(sizeMb).toBeGreaterThan(400);
		expect(sizeMb).toBeLessThanOrEqual(512);
		expect(existsSync(disk(sessionId))).toBe(true);
	});

	it("rejects a diskMb that XFS cannot format with invalid_request", async () => {
		const spec = sampleSandboxSpec({ resources: { cpu: 1, memoryMb: 512, diskMb: 299 } });

		await expect(made.provider.create({ sessionId: made.sessionId(), spec })).rejects.toMatchObject({ code: "invalid_request" });
	});

	it("refuses writes past diskMb without touching the host disk", async () => {
		const spec = sampleSandboxSpec({ resources: { cpu: 1, memoryMb: 512, diskMb: 320 } });
		const { sandboxId } = await made.provider.create({ sessionId: made.sessionId(), spec });
		const free = () => {
			const stats = statfsSync(made.workspaceRoot);
			return stats.bavail * stats.bsize;
		};
		const before = free();

		const result = await run("docker", ["exec", sandboxId, "sh", "-c", "dd if=/dev/zero of=/workspace/big bs=1M count=900 2>&1"]).then(
			({ stdout }) => ({ ok: true, out: stdout }),
			(error: { stdout?: string }) => ({ ok: false, out: error.stdout ?? "" }),
		);

		expect(result.ok).toBe(false);
		expect(result.out).toMatch(/No space left on device/);
		expect(before - free()).toBeLessThan(340 * 1024 * 1024);
	});

	it("re-attaches the image when the loop device was taken by another image", async () => {
		// Review Focus 2：宿主重启后 /dev/loopN 可能接到了别的镜像上
		const sessionId = made.sessionId();
		const { sandboxId } = await made.provider.create({ sessionId, spec: sampleSandboxSpec() });
		await docker("exec", sandboxId, "sh", "-c", "echo mine > /workspace/mine.txt");
		await made.provider.stop(sandboxId);
		const [device] = await associated(disk(sessionId));
		expect(device).toBeDefined();

		const other = join(made.workspaceRoot, "other.img");
		await run("sh", ["-c", `truncate -s 320M ${other} && mkfs.xfs -q ${other}`]);
		await losetup("--detach", device!);
		await losetup(device!, realpathSync(other));
		try {
			await made.provider.start(sandboxId);

			expect(await docker("exec", sandboxId, "cat", "/workspace/mine.txt")).toBe("mine");
			expect((await associated(disk(sessionId))).length).toBeGreaterThan(0);
		} finally {
			for (const loop of await associated(other)) await losetup("--detach", loop);
		}
	});

	it("removes the volume, the loop device and the image on destroy", async () => {
		const sessionId = made.sessionId();
		const { sandboxId } = await made.provider.create({ sessionId, spec: sampleSandboxSpec() });
		const image = realpathSync(disk(sessionId));
		const devices = await associated(image);
		expect(devices).toHaveLength(1);

		await made.provider.destroy(sandboxId);

		await expect(docker("volume", "inspect", `tether-${sessionId}`)).rejects.toThrow();
		expect(existsSync(image)).toBe(false);
		// 设备已经摘掉：不再出现在已接设备的列表里
		const attached = (await losetup("--list", "--noheadings", "--output", "NAME")).split("\n");
		expect(attached).not.toContain(devices[0]);
	});
});

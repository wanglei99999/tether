import type { SandboxProvider, SandboxSpec } from "@tether/core";
import type { ConformanceRunner } from "./app-store.ts";

export interface MadeProvider {
	provider: SandboxProvider;
	/** 每次返回一个没用过的会话 ID。 */
	sessionId: () => string;
	cleanup(): Promise<void>;
}

export function sampleSandboxSpec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
	return {
		template: "",
		resources: { cpu: 1, memoryMb: 512 },
		network: "none",
		setup: [],
		variables: [],
		...overrides,
	};
}

/**
 * 任何 SandboxProvider 都要通过的生命周期用例。
 * testkit 不依赖 pi-env，没法经 daemon 读写文件，所以"停止再启动后文件还在"由 ExecChannel 的测试覆盖。
 */
export function registerSandboxProviderConformance(
	runner: ConformanceRunner,
	name: string,
	make: () => Promise<MadeProvider>,
): void {
	const { describe, it, expect, beforeEach } = runner;

	describe(`SandboxProvider conformance: ${name}`, () => {
		let made: MadeProvider;

		beforeEach(async () => {
			made = await make();
			return () => made.cleanup();
		});

		it("creates a running sandbox and lists it as managed with its session", async () => {
			const sessionId = made.sessionId();
			const { sandboxId } = await made.provider.create({ sessionId, spec: sampleSandboxSpec() });

			expect(await made.provider.status(sandboxId)).toBe("running");
			expect(await made.provider.listManaged()).toContainEqual({ sandboxId, sessionId, status: "running" });
		});

		it("reports missing after destroy, and destroy of a missing sandbox does not throw", async () => {
			const sessionId = made.sessionId();
			const { sandboxId } = await made.provider.create({ sessionId, spec: sampleSandboxSpec() });

			await made.provider.destroy(sandboxId);

			expect(await made.provider.status(sandboxId)).toBe("missing");
			expect((await made.provider.listManaged()).map((sandbox) => sandbox.sandboxId)).not.toContain(sandboxId);
			await expect(made.provider.destroy(sandboxId)).resolves.toBeUndefined();
		});

		it("reports stopped after stop and running after start, still listed as managed", async () => {
			const sessionId = made.sessionId();
			const { sandboxId } = await made.provider.create({ sessionId, spec: sampleSandboxSpec() });

			await made.provider.stop(sandboxId);
			expect(await made.provider.status(sandboxId)).toBe("stopped");
			expect(await made.provider.listManaged()).toContainEqual({ sandboxId, sessionId, status: "stopped" });

			await made.provider.start(sandboxId);
			expect(await made.provider.status(sandboxId)).toBe("running");
			expect(await made.provider.listManaged()).toContainEqual({ sandboxId, sessionId, status: "running" });
		});

		it("fences a fresh sandbox and reports how many processes it killed", async () => {
			const sessionId = made.sessionId();
			const { sandboxId } = await made.provider.create({ sessionId, spec: sampleSandboxSpec() });

			const { killed } = await made.provider.fence(sandboxId, 1);

			expect(killed).toBeGreaterThanOrEqual(0);
			expect(await made.provider.status(sandboxId)).toBe("running");
		});

		it("fails to fence a missing sandbox with sandbox_failed", async () => {
			const sessionId = made.sessionId();
			const { sandboxId } = await made.provider.create({ sessionId, spec: sampleSandboxSpec() });
			await made.provider.destroy(sandboxId);

			await expect(made.provider.fence(sandboxId, 1)).rejects.toMatchObject({ code: "sandbox_failed" });
		});

		it("snapshots a running sandbox and keeps it running", async () => {
			const { sandboxId } = await made.provider.create({ sessionId: made.sessionId(), spec: sampleSandboxSpec() });

			const { snapshotId } = await made.provider.snapshot(sandboxId);

			expect(typeof snapshotId).toBe("string");
			expect(await made.provider.status(sandboxId)).toBe("running");
			expect(await made.provider.listSnapshots()).toContainEqual({ snapshotId, partial: false });
		});

		it("snapshots a stopped sandbox and leaves it stopped", async () => {
			const { sandboxId } = await made.provider.create({ sessionId: made.sessionId(), spec: sampleSandboxSpec() });
			await made.provider.stop(sandboxId);

			const { snapshotId } = await made.provider.snapshot(sandboxId);

			expect(await made.provider.status(sandboxId)).toBe("stopped");
			expect((await made.provider.listSnapshots()).map((s) => s.snapshotId)).toContain(snapshotId);
		});

		it("creates a running sandbox from a snapshot", async () => {
			const { sandboxId } = await made.provider.create({ sessionId: made.sessionId(), spec: sampleSandboxSpec() });
			const { snapshotId } = await made.provider.snapshot(sandboxId);
			const sessionId = made.sessionId();

			const restored = await made.provider.create({ sessionId, spec: sampleSandboxSpec(), from: snapshotId });

			expect(restored.sandboxId).not.toBe(sandboxId);
			expect(await made.provider.status(restored.sandboxId)).toBe("running");
			expect(await made.provider.listManaged()).toContainEqual({ sandboxId: restored.sandboxId, sessionId, status: "running" });
		});

		it("lists snapshots and deletes one; deleting a missing one does not throw", async () => {
			const { sandboxId } = await made.provider.create({ sessionId: made.sessionId(), spec: sampleSandboxSpec() });
			const first = await made.provider.snapshot(sandboxId);
			const second = await made.provider.snapshot(sandboxId);

			await made.provider.deleteSnapshot(first.snapshotId);
			await made.provider.deleteSnapshot(first.snapshotId);

			const ids = (await made.provider.listSnapshots()).map((s) => s.snapshotId);
			expect(ids).not.toContain(first.snapshotId);
			expect(ids).toContain(second.snapshotId);
		});

		it("rejects a snapshot id that is not of the documented form with invalid_request", async () => {
			// 快照 ID 会拼进路径：形如 ../x 的一律拒绝
			await expect(made.provider.deleteSnapshot("../x")).rejects.toMatchObject({ code: "invalid_request" });
			await expect(
				made.provider.create({ sessionId: made.sessionId(), spec: sampleSandboxSpec(), from: "../../etc/passwd" }),
			).rejects.toMatchObject({ code: "invalid_request" });
		});

		it("reports free and total bytes of the snapshot storage", async () => {
			const { freeBytes, totalBytes } = await made.provider.storage();

			expect(totalBytes).toBeGreaterThan(0);
			expect(freeBytes).toBeGreaterThan(0);
			expect(freeBytes).toBeLessThanOrEqual(totalBytes);
		});

		it("returns a daemon command that ends with the epoch", async () => {
			const sessionId = made.sessionId();
			const { sandboxId } = await made.provider.create({ sessionId, spec: sampleSandboxSpec() });

			const command = made.provider.daemonCommand(sandboxId, 7);

			expect(command.length).toBeGreaterThan(1);
			expect(command.at(-1)).toBe("7");
		});
	});
}

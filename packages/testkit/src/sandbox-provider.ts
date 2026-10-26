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
			expect(await made.provider.listManaged()).toContainEqual({ sandboxId, sessionId });
		});

		it("reports missing after destroy, and destroy of a missing sandbox does not throw", async () => {
			const sessionId = made.sessionId();
			const { sandboxId } = await made.provider.create({ sessionId, spec: sampleSandboxSpec() });

			await made.provider.destroy(sandboxId);

			expect(await made.provider.status(sandboxId)).toBe("missing");
			expect(await made.provider.listManaged()).not.toContainEqual({ sandboxId, sessionId });
			await expect(made.provider.destroy(sandboxId)).resolves.toBeUndefined();
		});

		it("reports stopped after stop and running after start, still listed as managed", async () => {
			const sessionId = made.sessionId();
			const { sandboxId } = await made.provider.create({ sessionId, spec: sampleSandboxSpec() });

			await made.provider.stop(sandboxId);
			expect(await made.provider.status(sandboxId)).toBe("stopped");
			expect(await made.provider.listManaged()).toContainEqual({ sandboxId, sessionId });

			await made.provider.start(sandboxId);
			expect(await made.provider.status(sandboxId)).toBe("running");
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

		it("returns a daemon command that ends with the epoch", async () => {
			const sessionId = made.sessionId();
			const { sandboxId } = await made.provider.create({ sessionId, spec: sampleSandboxSpec() });

			const command = made.provider.daemonCommand(sandboxId, 7);

			expect(command.length).toBeGreaterThan(1);
			expect(command.at(-1)).toBe("7");
		});
	});
}

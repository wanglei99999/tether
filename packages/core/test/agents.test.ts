import { MemoryAppStore, sampleSpec } from "@tether/testkit";
import { describe, expect, it } from "vitest";
import { AgentService, BUILTIN_TOOLS } from "../src/index.ts";
import { FakeClock, FakeIds } from "./fakes.ts";

function service() {
	const store = new MemoryAppStore();
	return { store, agents: new AgentService({ store, clock: new FakeClock(), ids: new FakeIds(), catalog: BUILTIN_TOOLS }) };
}

describe("AgentService", () => {
	it("creates an agent with version 1 and validates tools against the catalog", async () => {
		const { store, agents } = service();

		const { agent, version } = await agents.create({ name: "fixer", spec: sampleSpec() });

		expect(agent).toMatchObject({ id: "agt_0001", ownerId: "local", name: "fixer", description: "" });
		expect(version).toMatchObject({ agentId: agent.id, version: 1, spec: sampleSpec() });
		expect(await store.getVersion(agent.id)).toEqual(version);
		await expect(
			agents.create({ name: "bad", spec: { ...sampleSpec(), tools: ["teleport"] } }),
		).rejects.toMatchObject({ code: "invalid_request", message: expect.stringContaining("teleport") });
	});

	it("rejects unsupported fields on create and on a new version, and accepts them when the service supports them", async () => {
		const { agents } = service();
		// 审批默认还不支持（M3 之后单独一份计划）
		const approval = { ...sampleSpec(), permissions: { denyTools: [], requireApproval: ["bash"] } };
		const unsupported = { code: "invalid_request", message: "permissions.requireApproval is not supported yet" };

		await expect(agents.create({ name: "a", spec: approval })).rejects.toMatchObject(unsupported);
		const { agent } = await agents.create({ name: "a", spec: sampleSpec() });
		await expect(agents.addVersion(agent.id, approval)).rejects.toMatchObject(unsupported);

		const store = new MemoryAppStore();
		const later = new AgentService({
			store,
			clock: new FakeClock(),
			ids: new FakeIds(),
			catalog: BUILTIN_TOOLS,
			unsupported: { diskMb: true, approval: false, checkpoints: false },
		});
		await expect(later.create({ name: "b", spec: approval })).resolves.toMatchObject({ version: { version: 1 } });
	});

	it("accepts only an image reference as the sandbox template", async () => {
		const { agents } = service();
		const withTemplate = (template: string) => {
			const spec = sampleSpec();
			return { ...spec, sandbox: { ...spec.sandbox, template } };
		};

		// template 放在 docker run 的镜像位置：以 - 开头会被当成 docker 的参数
		for (const template of ["--privileged", "-v/:/host", "img --rm", "img\nx"]) {
			await expect(agents.create({ name: "a", spec: withTemplate(template) }), template).rejects.toMatchObject({
				code: "invalid_request",
			});
		}
		for (const template of ["", "node:22-slim", "ghcr.io/org/sandbox:1.2", "registry:5000/a/b@sha256:abc123"]) {
			await expect(agents.create({ name: "a", spec: withTemplate(template) }), template).resolves.toBeDefined();
		}
	});

	it("rejects an empty name", async () => {
		const { agents } = service();
		await expect(agents.create({ name: "", spec: sampleSpec() })).rejects.toMatchObject({ code: "invalid_request" });
	});

	it("adds versions 2 and 3 and returns the latest by default", async () => {
		const { agents } = service();
		const { agent } = await agents.create({ name: "fixer", spec: sampleSpec() });

		await agents.addVersion(agent.id, sampleSpec("v2"));
		const third = await agents.addVersion(agent.id, sampleSpec("v3"));

		expect(third.version).toBe(3);
		expect(await agents.getVersion(agent.id)).toEqual(third);
		expect((await agents.getVersion(agent.id, 2)).spec.instructions).toBe("v2");
	});

	it("rejects a version for an archived agent with conflict", async () => {
		const { agents } = service();
		const { agent } = await agents.create({ name: "fixer", spec: sampleSpec() });
		await agents.archive(agent.id);

		expect((await agents.get(agent.id)).archivedAt).toBeDefined();
		await expect(agents.addVersion(agent.id, sampleSpec())).rejects.toMatchObject({ code: "conflict" });
	});

	it("returns not_found for an unknown agent", async () => {
		const { agents } = service();

		await expect(agents.get("agt_missing")).rejects.toMatchObject({ code: "not_found" });
		await expect(agents.getVersion("agt_missing")).rejects.toMatchObject({ code: "not_found" });
		await expect(agents.addVersion("agt_missing", sampleSpec())).rejects.toMatchObject({ code: "not_found" });
		await expect(agents.archive("agt_missing")).rejects.toMatchObject({ code: "not_found" });
		const { agent } = await agents.create({ name: "fixer", spec: sampleSpec() });
		await expect(agents.getVersion(agent.id, 7)).rejects.toMatchObject({ code: "not_found" });
	});
});

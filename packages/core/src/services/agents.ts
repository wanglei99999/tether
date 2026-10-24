import { TetherError } from "../errors.ts";
import type { AgentRecord, AgentVersionRecord } from "../model.ts";
import type { AppStore, Clock, Ids } from "../ports.ts";
import type { ToolDescriptor } from "../tools.ts";
import { validateVersionSpec } from "../validate.ts";

export interface AgentServiceDeps {
	store: AppStore;
	clock: Clock;
	ids: Ids;
	/** 服务端已安装的工具目录，版本里的工具名按它校验。 */
	catalog: readonly ToolDescriptor[];
}

/** 单用户阶段所有记录都属于 "local"（设计文档 §5.1）。 */
export const LOCAL_OWNER = "local";

export class AgentService {
	readonly #deps: AgentServiceDeps;

	constructor(deps: AgentServiceDeps) {
		this.#deps = deps;
	}

	async create(input: {
		name: string;
		description?: string;
		spec: unknown;
	}): Promise<{ agent: AgentRecord; version: AgentVersionRecord }> {
		if (typeof input.name !== "string" || input.name.trim() === "") {
			throw new TetherError("invalid_request", "name must be a non-empty string");
		}
		const spec = validateVersionSpec(input.spec, this.#deps.catalog);
		const at = this.#deps.clock.now();
		const agent: AgentRecord = {
			id: this.#deps.ids.next("agt"),
			ownerId: LOCAL_OWNER,
			name: input.name,
			description: input.description ?? "",
			createdAt: at,
		};
		const version: AgentVersionRecord = { agentId: agent.id, version: 1, spec, createdAt: at };
		await this.#deps.store.createAgent(agent, version);
		return { agent, version };
	}

	async addVersion(agentId: string, spec: unknown): Promise<AgentVersionRecord> {
		const agent = await this.get(agentId);
		if (agent.archivedAt !== undefined) throw new TetherError("conflict", `agent ${agentId} is archived`);
		const valid = validateVersionSpec(spec, this.#deps.catalog);
		return this.#deps.store.addVersion(agentId, valid, this.#deps.clock.now());
	}

	async get(id: string): Promise<AgentRecord> {
		const agent = await this.#deps.store.getAgent(id);
		if (!agent) throw new TetherError("not_found", `agent ${id} not found`);
		return agent;
	}

	list(): Promise<AgentRecord[]> {
		return this.#deps.store.listAgents();
	}

	/** 省略 version 时取最新版本。 */
	async getVersion(agentId: string, version?: number): Promise<AgentVersionRecord> {
		const found = await this.#deps.store.getVersion(agentId, version);
		if (!found) {
			const which = version === undefined ? "any version" : `version ${version}`;
			throw new TetherError("not_found", `agent ${agentId} has no ${which}`);
		}
		return found;
	}

	async archive(id: string): Promise<void> {
		await this.get(id);
		await this.#deps.store.archiveAgent(id, this.#deps.clock.now());
	}
}

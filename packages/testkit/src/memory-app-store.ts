import {
	TetherError,
	type AgentRecord,
	type AgentVersionRecord,
	type AgentVersionSpec,
	type AppStore,
	type SandboxBinding,
	type SessionRecord,
} from "@tether/core";

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** 给服务层测试用的 AppStore。读写都复制，调用方拿到的对象改了也不影响存储。 */
export class MemoryAppStore implements AppStore {
	readonly #agents = new Map<string, AgentRecord>();
	readonly #versions = new Map<string, AgentVersionRecord[]>();
	readonly #sessions = new Map<string, SessionRecord>();
	readonly #bindings = new Map<string, SandboxBinding>();

	async createAgent(agent: AgentRecord, first: AgentVersionRecord): Promise<void> {
		if (this.#agents.has(agent.id)) throw new TetherError("conflict", `agent ${agent.id} already exists`);
		this.#agents.set(agent.id, structuredClone(agent));
		this.#versions.set(agent.id, [structuredClone(first)]);
	}

	async getAgent(id: string): Promise<AgentRecord | undefined> {
		return structuredClone(this.#agents.get(id));
	}

	async listAgents(): Promise<AgentRecord[]> {
		return [...this.#agents.values()].sort(byId).map((agent) => structuredClone(agent));
	}

	async archiveAgent(id: string, at: string): Promise<void> {
		const agent = this.#requireAgent(id);
		this.#agents.set(id, { ...agent, archivedAt: at });
	}

	async addVersion(agentId: string, spec: AgentVersionSpec, at: string): Promise<AgentVersionRecord> {
		this.#requireAgent(agentId);
		const versions = this.#versions.get(agentId) ?? [];
		const record: AgentVersionRecord = {
			agentId,
			version: versions.length + 1,
			spec: structuredClone(spec),
			createdAt: at,
		};
		this.#versions.set(agentId, [...versions, record]);
		return structuredClone(record);
	}

	async getVersion(agentId: string, version?: number): Promise<AgentVersionRecord | undefined> {
		const versions = this.#versions.get(agentId) ?? [];
		const found = version === undefined ? versions.at(-1) : versions.find((v) => v.version === version);
		return structuredClone(found);
	}

	async createSession(session: SessionRecord): Promise<void> {
		if (this.#sessions.has(session.id)) throw new TetherError("conflict", `session ${session.id} already exists`);
		this.#sessions.set(session.id, structuredClone(session));
	}

	async setEngineSessionId(sessionId: string, engineSessionId: string): Promise<void> {
		const session = this.#requireSession(sessionId);
		this.#sessions.set(sessionId, { ...session, engineSessionId });
	}

	async getSession(id: string): Promise<SessionRecord | undefined> {
		return structuredClone(this.#sessions.get(id));
	}

	async getSessionByEngineId(engineSessionId: string): Promise<SessionRecord | undefined> {
		const found = [...this.#sessions.values()].find((s) => s.engineSessionId === engineSessionId);
		return structuredClone(found);
	}

	async listSessions(query: {
		agentId?: string;
		status?: SessionRecord["status"];
		limit: number;
		after?: string;
	}): Promise<{ items: SessionRecord[]; next?: string }> {
		const after = query.after;
		const matching = [...this.#sessions.values()]
			.filter((s) => query.agentId === undefined || s.agentId === query.agentId)
			.filter((s) => query.status === undefined || s.status === query.status)
			.filter((s) => after === undefined || s.id < after)
			.sort(byId)
			.reverse();
		const items = matching.slice(0, query.limit).map((s) => structuredClone(s));
		const last = items.at(-1);
		return matching.length > query.limit && last ? { items, next: last.id } : { items };
	}

	async sessionsWithoutEngine(): Promise<SessionRecord[]> {
		return [...this.#sessions.values()]
			.filter((s) => s.engineSessionId === null)
			.sort(byId)
			.map((s) => structuredClone(s));
	}

	async updateSession(
		id: string,
		patch: Partial<Pick<SessionRecord, "status" | "title" | "lastActiveAt">>,
	): Promise<void> {
		const session = this.#requireSession(id);
		const { status, title, lastActiveAt } = patch;
		this.#sessions.set(id, {
			...session,
			...(status !== undefined && { status }),
			...(title !== undefined && { title }),
			...(lastActiveAt !== undefined && { lastActiveAt }),
		});
	}

	async getBinding(sessionId: string): Promise<SandboxBinding | undefined> {
		return structuredClone(this.#bindings.get(sessionId));
	}

	async putBinding(binding: SandboxBinding): Promise<void> {
		this.#bindings.set(binding.sessionId, structuredClone(binding));
	}

	async deleteBinding(sessionId: string): Promise<void> {
		this.#bindings.delete(sessionId);
	}

	async listBindings(): Promise<SandboxBinding[]> {
		return [...this.#bindings.values()]
			.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))
			.map((b) => structuredClone(b));
	}

	#requireAgent(id: string): AgentRecord {
		const agent = this.#agents.get(id);
		if (!agent) throw new TetherError("not_found", `agent ${id} not found`);
		return agent;
	}

	#requireSession(id: string): SessionRecord {
		const session = this.#sessions.get(id);
		if (!session) throw new TetherError("not_found", `session ${id} not found`);
		return session;
	}
}

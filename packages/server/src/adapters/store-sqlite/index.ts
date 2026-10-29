import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
	assertBindingState,
	TetherError,
	type AgentRecord,
	type AgentVersionRecord,
	type AgentVersionSpec,
	type AppStore,
	type BindingPatch,
	type CheckpointRecord,
	type ExpectedState,
	type ForkOrigin,
	type SandboxBinding,
	type SessionRecord,
} from "@tether/core";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.ts";

type Row = Record<string, unknown>;

function text(row: Row, column: string): string {
	return row[column] as string;
}

function optionalText(row: Row, column: string): string | undefined {
	const value = row[column];
	return value === null || value === undefined ? undefined : (value as string);
}

function toAgent(row: Row): AgentRecord {
	const archivedAt = optionalText(row, "archived_at");
	return {
		id: text(row, "id"),
		ownerId: text(row, "owner_id"),
		name: text(row, "name"),
		description: text(row, "description"),
		createdAt: text(row, "created_at"),
		...(archivedAt !== undefined && { archivedAt }),
	};
}

function toVersion(row: Row): AgentVersionRecord {
	return {
		agentId: text(row, "agent_id"),
		version: Number(row.version),
		spec: JSON.parse(text(row, "spec")) as AgentVersionSpec,
		createdAt: text(row, "created_at"),
	};
}

function toSession(row: Row): SessionRecord {
	const title = optionalText(row, "title");
	const forkedFrom = optionalText(row, "forked_from");
	return {
		id: text(row, "id"),
		ownerId: text(row, "owner_id"),
		agentId: text(row, "agent_id"),
		agentVersion: Number(row.agent_version),
		engineSessionId: optionalText(row, "engine_session_id") ?? null,
		parentSessionId: null,
		forkedFrom: forkedFrom === undefined ? null : (JSON.parse(forkedFrom) as ForkOrigin),
		variables: JSON.parse(text(row, "variables")) as Record<string, string>,
		status: text(row, "status") as SessionRecord["status"],
		...(title !== undefined && { title }),
		createdAt: text(row, "created_at"),
		lastActiveAt: text(row, "last_active_at"),
	};
}

function toBinding(row: Row): SandboxBinding {
	const reason = optionalText(row, "reason");
	return {
		sessionId: text(row, "session_id"),
		provider: text(row, "provider") as SandboxBinding["provider"],
		sandboxId: text(row, "sandbox_id"),
		epoch: Number(row.epoch),
		state: text(row, "state") as SandboxBinding["state"],
		template: text(row, "template"),
		createdAt: text(row, "created_at"),
		lastUsedAt: text(row, "last_used_at"),
		...(reason !== undefined && { reason }),
	};
}

function toCheckpoint(row: Row): CheckpointRecord {
	return {
		id: text(row, "id"),
		sessionId: text(row, "session_id"),
		submissionId: text(row, "submission_id"),
		entryId: String(row.entry_id),
		snapshotId: optionalText(row, "snapshot_id") ?? null,
		basisCheckpointId: optionalText(row, "basis_checkpoint_id") ?? null,
		failed: row.failed === 1,
		kind: text(row, "kind") as CheckpointRecord["kind"],
		createdAt: text(row, "created_at"),
	};
}

function isConstraintError(error: unknown): boolean {
	return error instanceof Error && /constraint failed/i.test(error.message);
}

/** 从当前版本逐步升到 SCHEMA_VERSION，全部在一个事务里：中途失败就回到原来的版本。 */
function migrate(db: DatabaseSync): void {
	const row = db.prepare("PRAGMA user_version").get() as Row;
	const current = Number(row.user_version);
	if (current === SCHEMA_VERSION) return;
	if (current > SCHEMA_VERSION) {
		throw new TetherError("internal", `unsupported tether.sqlite schema version ${current}`);
	}
	db.exec("BEGIN IMMEDIATE");
	try {
		for (const step of MIGRATIONS.slice(current)) db.exec(step);
		db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

class SqliteAppStore implements AppStore {
	readonly #db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.#db = db;
	}

	#all(sql: string, ...params: SQLInputValue[]): Row[] {
		return this.#db.prepare(sql).all(...params) as Row[];
	}

	#get(sql: string, ...params: SQLInputValue[]): Row | undefined {
		return this.#db.prepare(sql).get(...params) as Row | undefined;
	}

	/** 返回受影响的行数。 */
	#run(sql: string, ...params: SQLInputValue[]): number {
		return Number(this.#db.prepare(sql).run(...params).changes);
	}

	#transaction<T>(work: () => T): T {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const result = work();
			this.#db.exec("COMMIT");
			return result;
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	async createAgent(agent: AgentRecord, first: AgentVersionRecord): Promise<void> {
		try {
			this.#transaction(() => {
				this.#run(
					`INSERT INTO agent_definitions (id, owner_id, name, description, created_at, archived_at)
					 VALUES (?, ?, ?, ?, ?, ?)`,
					agent.id,
					agent.ownerId,
					agent.name,
					agent.description,
					agent.createdAt,
					agent.archivedAt ?? null,
				);
				this.#run(
					"INSERT INTO agent_versions (agent_id, version, spec, created_at) VALUES (?, ?, ?, ?)",
					first.agentId,
					first.version,
					JSON.stringify(first.spec),
					first.createdAt,
				);
			});
		} catch (error) {
			if (isConstraintError(error)) throw new TetherError("conflict", `agent ${agent.id} already exists`);
			throw error;
		}
	}

	async getAgent(id: string): Promise<AgentRecord | undefined> {
		const row = this.#get("SELECT * FROM agent_definitions WHERE id = ?", id);
		return row && toAgent(row);
	}

	async listAgents(): Promise<AgentRecord[]> {
		return this.#all("SELECT * FROM agent_definitions ORDER BY id").map(toAgent);
	}

	async archiveAgent(id: string, at: string): Promise<void> {
		if (this.#run("UPDATE agent_definitions SET archived_at = ? WHERE id = ?", at, id) === 0) {
			throw new TetherError("not_found", `agent ${id} not found`);
		}
	}

	async addVersion(agentId: string, spec: AgentVersionSpec, at: string): Promise<AgentVersionRecord> {
		return this.#transaction(() => {
			if (!this.#get("SELECT 1 FROM agent_definitions WHERE id = ?", agentId)) {
				throw new TetherError("not_found", `agent ${agentId} not found`);
			}
			const row = this.#get("SELECT MAX(version) AS latest FROM agent_versions WHERE agent_id = ?", agentId);
			const version = Number(row?.latest ?? 0) + 1;
			this.#run(
				"INSERT INTO agent_versions (agent_id, version, spec, created_at) VALUES (?, ?, ?, ?)",
				agentId,
				version,
				JSON.stringify(spec),
				at,
			);
			return { agentId, version, spec: structuredClone(spec), createdAt: at };
		});
	}

	async getVersion(agentId: string, version?: number): Promise<AgentVersionRecord | undefined> {
		const row =
			version === undefined
				? this.#get("SELECT * FROM agent_versions WHERE agent_id = ? ORDER BY version DESC LIMIT 1", agentId)
				: this.#get("SELECT * FROM agent_versions WHERE agent_id = ? AND version = ?", agentId, version);
		return row && toVersion(row);
	}

	async createSession(session: SessionRecord): Promise<void> {
		try {
			this.#run(
				`INSERT INTO sessions (id, owner_id, agent_id, agent_version, engine_session_id, parent_session_id,
				   forked_from, variables, status, title, created_at, last_active_at)
				 VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
				session.id,
				session.ownerId,
				session.agentId,
				session.agentVersion,
				session.engineSessionId,
				session.forkedFrom === null ? null : JSON.stringify(session.forkedFrom),
				JSON.stringify(session.variables),
				session.status,
				session.title ?? null,
				session.createdAt,
				session.lastActiveAt,
			);
		} catch (error) {
			if (isConstraintError(error)) throw new TetherError("conflict", `session ${session.id} already exists`);
			throw error;
		}
	}

	async setEngineSessionId(sessionId: string, engineSessionId: string): Promise<void> {
		if (this.#run("UPDATE sessions SET engine_session_id = ? WHERE id = ?", engineSessionId, sessionId) === 0) {
			throw new TetherError("not_found", `session ${sessionId} not found`);
		}
	}

	async getSession(id: string): Promise<SessionRecord | undefined> {
		const row = this.#get("SELECT * FROM sessions WHERE id = ?", id);
		return row && toSession(row);
	}

	async getSessionByEngineId(engineSessionId: string): Promise<SessionRecord | undefined> {
		const row = this.#get("SELECT * FROM sessions WHERE engine_session_id = ?", engineSessionId);
		return row && toSession(row);
	}

	async listSessions(query: {
		agentId?: string;
		status?: SessionRecord["status"];
		limit: number;
		after?: string;
	}): Promise<{ items: SessionRecord[]; next?: string }> {
		const agentId = query.agentId ?? null;
		const status = query.status ?? null;
		const after = query.after ?? null;
		// 多取一条，用来判断还有没有下一页。ID 按时间可排序，新的在前。
		const rows = this.#all(
			`SELECT * FROM sessions
			 WHERE (? IS NULL OR agent_id = ?) AND (? IS NULL OR status = ?) AND (? IS NULL OR id < ?)
			 ORDER BY id DESC LIMIT ?`,
			agentId,
			agentId,
			status,
			status,
			after,
			after,
			query.limit + 1,
		);
		const items = rows.slice(0, query.limit).map(toSession);
		const last = items.at(-1);
		return rows.length > query.limit && last ? { items, next: last.id } : { items };
	}

	async sessionsWithoutEngine(): Promise<SessionRecord[]> {
		return this.#all("SELECT * FROM sessions WHERE engine_session_id IS NULL ORDER BY id").map(toSession);
	}

	async updateSession(
		id: string,
		patch: Partial<Pick<SessionRecord, "status" | "title" | "lastActiveAt">>,
	): Promise<void> {
		const changed = this.#run(
			`UPDATE sessions SET
			   status = COALESCE(?, status),
			   title = COALESCE(?, title),
			   last_active_at = COALESCE(?, last_active_at)
			 WHERE id = ?`,
			patch.status ?? null,
			patch.title ?? null,
			patch.lastActiveAt ?? null,
			id,
		);
		if (changed === 0) throw new TetherError("not_found", `session ${id} not found`);
	}

	async getBinding(sessionId: string): Promise<SandboxBinding | undefined> {
		const row = this.#get("SELECT * FROM sandbox_bindings WHERE session_id = ?", sessionId);
		return row && toBinding(row);
	}

	async createBinding(binding: SandboxBinding): Promise<void> {
		try {
			this.#run(
				`INSERT INTO sandbox_bindings
				   (session_id, provider, sandbox_id, epoch, state, template, created_at, last_used_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				binding.sessionId,
				binding.provider,
				binding.sandboxId,
				binding.epoch,
				binding.state,
				binding.template,
				binding.createdAt,
				binding.lastUsedAt,
			);
		} catch (error) {
			if (isConstraintError(error)) {
				throw new TetherError("conflict", `sandbox binding for ${binding.sessionId} already exists`);
			}
			throw error;
		}
	}

	async updateBinding(sessionId: string, patch: BindingPatch, expected?: ExpectedState): Promise<SandboxBinding> {
		return this.#transaction(() => {
			const current = this.#requireBinding(sessionId);
			assertBindingState(current, expected);
			// reason：不给就不动（第一个参数为 0），给 null 就清除
			this.#run(
				`UPDATE sandbox_bindings SET
				   state = COALESCE(?, state),
				   last_used_at = COALESCE(?, last_used_at),
				   reason = CASE WHEN ? THEN ? ELSE reason END
				 WHERE session_id = ?`,
				patch.state ?? null,
				patch.lastUsedAt ?? null,
				patch.reason === undefined ? 0 : 1,
				patch.reason ?? null,
				sessionId,
			);
			return this.#requireBinding(sessionId);
		});
	}

	async nextEpoch(sessionId: string): Promise<number> {
		const row = this.#get(
			"UPDATE sandbox_bindings SET epoch = epoch + 1 WHERE session_id = ? RETURNING epoch",
			sessionId,
		);
		if (!row) throw new TetherError("not_found", `sandbox binding for ${sessionId} not found`);
		return Number(row.epoch);
	}

	#requireBinding(sessionId: string): SandboxBinding {
		const row = this.#get("SELECT * FROM sandbox_bindings WHERE session_id = ?", sessionId);
		if (!row) throw new TetherError("not_found", `sandbox binding for ${sessionId} not found`);
		return toBinding(row);
	}

	async deleteBinding(sessionId: string): Promise<void> {
		this.#run("DELETE FROM sandbox_bindings WHERE session_id = ?", sessionId);
	}

	async listBindings(): Promise<SandboxBinding[]> {
		return this.#all("SELECT * FROM sandbox_bindings ORDER BY session_id").map(toBinding);
	}

	async addCheckpoint(checkpoint: CheckpointRecord): Promise<void> {
		try {
			this.#run(
				`INSERT INTO checkpoints (id, session_id, submission_id, entry_id, snapshot_id, basis_checkpoint_id, failed, kind, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				checkpoint.id,
				checkpoint.sessionId,
				checkpoint.submissionId,
				Number(checkpoint.entryId),
				checkpoint.snapshotId,
				checkpoint.basisCheckpointId,
				checkpoint.failed ? 1 : 0,
				checkpoint.kind,
				checkpoint.createdAt,
			);
		} catch (error) {
			if (isConstraintError(error)) {
				throw new TetherError("conflict", `a checkpoint for submission ${checkpoint.submissionId} already exists`);
			}
			throw error;
		}
	}

	async getCheckpoint(id: string): Promise<CheckpointRecord | undefined> {
		const row = this.#get("SELECT * FROM checkpoints WHERE id = ?", id);
		return row && toCheckpoint(row);
	}

	async checkpointForSubmission(submissionId: string): Promise<CheckpointRecord | undefined> {
		const row = this.#get("SELECT * FROM checkpoints WHERE submission_id = ?", submissionId);
		return row && toCheckpoint(row);
	}

	async listCheckpoints(sessionId: string): Promise<CheckpointRecord[]> {
		return this.#all("SELECT * FROM checkpoints WHERE session_id = ? ORDER BY entry_id", sessionId).map(toCheckpoint);
	}

	async listAllCheckpoints(): Promise<CheckpointRecord[]> {
		return this.#all("SELECT * FROM checkpoints ORDER BY id").map(toCheckpoint);
	}

	async deleteCheckpoint(id: string): Promise<void> {
		this.#run("DELETE FROM checkpoints WHERE id = ?", id);
	}

	async checkpointReferenced(id: string): Promise<boolean> {
		const row = this.#get(
			`SELECT 1 FROM sessions
			 WHERE status != 'archived' AND forked_from IS NOT NULL AND json_extract(forked_from, '$.checkpointId') = ?
			 LIMIT 1`,
			id,
		);
		return row !== undefined;
	}
}

/** 打开 Tether 的应用库。path 传 ":memory:" 得到一个只在内存里的库。 */
export async function openSqliteAppStore(path: string): Promise<{ store: AppStore; close(): Promise<void> }> {
	const db = new DatabaseSync(path);
	try {
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA foreign_keys = ON");
		db.exec("PRAGMA busy_timeout = 5000");
		migrate(db);
	} catch (error) {
		db.close();
		throw error;
	}
	return {
		store: new SqliteAppStore(db),
		close: async () => db.close(),
	};
}

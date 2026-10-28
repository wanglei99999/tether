/** 表结构照设计文档 §5。改表结构就是在 MIGRATIONS 末尾加一步，SCHEMA_VERSION 随之加一。 */
export const SCHEMA_VERSION = 2;

export const SCHEMA_V1 = `
CREATE TABLE agent_definitions (
	id           TEXT PRIMARY KEY,
	owner_id     TEXT NOT NULL,
	name         TEXT NOT NULL,
	description  TEXT NOT NULL,
	created_at   TEXT NOT NULL,
	archived_at  TEXT
);

-- 版本不可变，整份配置存成一个 JSON 字段，读的时候也是整份读。
CREATE TABLE agent_versions (
	agent_id    TEXT NOT NULL REFERENCES agent_definitions(id),
	version     INTEGER NOT NULL,
	spec        TEXT NOT NULL,
	created_at  TEXT NOT NULL,
	PRIMARY KEY (agent_id, version)
);

CREATE TABLE sessions (
	id                 TEXT PRIMARY KEY,
	owner_id           TEXT NOT NULL,
	agent_id           TEXT NOT NULL,
	agent_version      INTEGER NOT NULL,
	engine_session_id  TEXT UNIQUE,
	parent_session_id  TEXT,
	forked_from        TEXT,
	variables          TEXT NOT NULL,
	status             TEXT NOT NULL,
	title              TEXT,
	created_at         TEXT NOT NULL,
	last_active_at     TEXT NOT NULL
);
CREATE INDEX sessions_by_agent_status ON sessions (agent_id, status, id);

CREATE TABLE sandbox_bindings (
	session_id    TEXT PRIMARY KEY,
	provider      TEXT NOT NULL,
	sandbox_id    TEXT NOT NULL,
	epoch         INTEGER NOT NULL,
	state         TEXT NOT NULL,
	template      TEXT NOT NULL,
	created_at    TEXT NOT NULL,
	last_used_at  TEXT NOT NULL
);
`;

/** 第 2 版（M3）：存档表；绑定记下变成 lost 的原因。sessions.forked_from 第 1 版已有，存 JSON。 */
export const SCHEMA_V2 = `
-- entry_id 是引擎的全局递增整数，按数值比较和排序
CREATE TABLE checkpoints (
	id             TEXT PRIMARY KEY,
	session_id     TEXT NOT NULL,
	submission_id  TEXT NOT NULL UNIQUE,
	entry_id       INTEGER NOT NULL,
	snapshot_id    TEXT NOT NULL,
	kind           TEXT NOT NULL,
	created_at     TEXT NOT NULL
);
CREATE INDEX checkpoints_by_session ON checkpoints (session_id, entry_id);

ALTER TABLE sandbox_bindings ADD COLUMN reason TEXT;
`;

/** MIGRATIONS[i] 把第 i 版升到第 i + 1 版。 */
export const MIGRATIONS: readonly string[] = [SCHEMA_V1, SCHEMA_V2];

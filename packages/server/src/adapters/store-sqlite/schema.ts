/** 表结构照设计文档 §5。checkpoints 表 M3 再建，届时把 SCHEMA_VERSION 加一并补迁移。 */
export const SCHEMA_VERSION = 1;

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

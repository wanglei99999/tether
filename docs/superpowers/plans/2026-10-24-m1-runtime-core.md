# M1 运行时核心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 M0 验证过的零件装进一个能部署、能通过 HTTP/WebSocket 调用的服务：创建带版本的 agent，开会话，发消息，工具在每个会话自己的 Docker 容器里执行，事件实时推给客户端，服务重启后未完成的运行继续。

**Architecture:** npm workspaces 下五个包（spec §4.1.1）。`core` 只有领域模型、端口接口和领域服务，不依赖 pi、Docker、SQLite；`server` 里的四个适配器（`engine-pi`、`exec-pienv`、`sandbox-docker`、`store-sqlite`）实现端口，`main.ts` 负责组装；`testkit` 是每个端口的一致性测试，第二阶段的自研实现要通过同一套。`sdk` 封装 API，`cli` 基于 `sdk`。

**Tech Stack:** Node ≥ 22.19（type stripping 直接运行 `.ts`，不编译）、TypeScript 7（只做 `tsc --noEmit`）、Vitest 5、`typebox` 1.3.27（与 pi 同版本）、`node:sqlite`、Hono + `@hono/node-server` + `@hono/node-ws`、Node 22 内置 `WebSocket`、pi 四个包 1.3.0、Docker 29。

**Spec:** `docs/superpowers/specs/2026-10-20-tether-design.md`（M1 定义在 §10；相关设计在 §4、§5、§6.1–6.3、§7、§11.1–11.2）。M0 的结论 `docs/m0-findings.md` 是本计划的事实依据，尤其第 6、9 节。

## Global Constraints

- pi 依赖锁定精确版本 `1.3.0`，所有依赖都写精确版本，不写 `^` 或 `~`（spec §12）。
- pi 的类型只允许出现在 `packages/server/src/adapters/` 和 `packages/server/src/main.ts`（spec §3 反目标）。
- `core` 的运行时依赖只有 `typebox`（spec §4.1.1）。
- 包内互相引用不经过构建：每个包的 `package.json` 用 `"exports": { ".": "./src/index.ts" }`，靠 workspace 符号链接解析（Node 按真实路径判断，`packages/*/src` 不在 `node_modules` 里，type stripping 生效）。
- 统一响应信封：`{ ok: true, data }` / `{ ok: false, error: { code, message } }`；错误码是契约，消息不是（spec §7.1）。
- 应用表先写，引擎会话后建，引擎会话 ID 回填（spec §5）。
- 沙箱容器以服务进程的 `uid:gid` 运行，工作区是宿主目录挂载（m0-findings 第 6 节）。容器 PID 1 是 `sleep infinity`（M2 的 epoch 隔离依赖它）。
- 所有容器带标签 `tether.managed=1` 和 `tether.session=<sessionId>`；清理只按这两个标签做。
- 测试全部在测试机 `tether-m0` 上运行（运行方式同 M0 计划的"运行环境"一节）；模型一律用 `pi-ai` 的 faux provider。
- 默认 `npm test` 不跑 `spikes/`（M0 全量要 7 分钟）；`npm run test:spikes` 单独跑。
- 提交信息用约定式提交格式，中文描述。

## 本里程碑不做

以下端点和能力按 spec §10 属于后续里程碑，M1 不实现，路由也不注册：会话分叉与检查点（M3）、审批（M3）、会话归档与沙箱销毁（M2）、闲置两档与准入控制（M2）、epoch 隔离（M2，M1 的 epoch 固定为 1）、沙箱文件浏览 `sandbox/files`、`sandbox/file`（M2）、`/v1/metrics`（M4）、自定义工具（M1 只提供内置的 `read`/`write`/`edit`/`bash`）。

## 设计决定（本计划新增）

- **`TetherEnv` 只取最小子集**：spec §4.2 原定与 `ExecutionEnv` 结构相同。内置工具直接用 pi 的实现、拿 pi 自己的环境对象，不经过 `core`；`core` 只在执行 `setup` 和以后的自定义工具时需要环境。所以 `TetherEnv` 只有 `readText`、`writeFile`、`exists`、`list`、`exec` 五个方法，第二阶段自研引擎时再按需扩充。Task 3 写成 ADR-009 并修订 spec §4.2。
- **引擎拿 pi 的环境对象由 `main.ts` 接线**：`engine-pi` 需要完整的 pi `ExecutionEnv`，`exec-pienv` 同时提供 `piEnv(binding)`（pi 类型）和端口方法 `env(binding)`（`TetherEnv`）。`main.ts` 把"core 解析出绑定"和"exec-pienv 给出 pi 环境"拼成 `engine-pi` 需要的回调，适配器之间不互相导入。
- **HTTP 框架选 Hono**：路由、中间件和 WebSocket 升级都有官方 Node 适配，`app.request()` 可以不开端口直接测路由。

## Review Focus

1. **新会话的第一轮里模型并行调用多个工具**：多个工具调用同时进入 `env` 回调，只能创建一个容器、执行一次 `setup`。Task 9 的 `ensureSandbox` 单飞测试。
2. **`setup` 命令失败**：工具调用得到包含失败命令及其输出的错误结果；失败的容器被删除、不留绑定；下一次工具调用重新创建。Task 9 测试。
3. **会话变量里带 shell 元字符**：值 `x; touch /workspace/pwned` 作为环境变量传给 `setup`，不被拼接执行。Task 9 的 Docker 集成测试。
4. **同一个 `requestId` 带不同内容再次提交**：返回第一次的提交，不报错、不执行第二次（pi 的语义，客户端要知道）。Task 11 的 API 测试。
5. **订阅一个不存在的会话的事件流**：WebSocket 以关闭码 4404 关闭，不挂起。Task 12 测试。

---

## 文件结构

```text
tether/
├── package.json                 Task 1  workspaces；脚本 test、test:spikes、typecheck
├── tsconfig.json                Task 1  include packages/*/src、packages/*/test、spikes
├── vitest.config.ts             Task 1  projects: unit、docker；spikes 只在 test:spikes 里
├── packages/core/
│   ├── package.json             Task 1  @tether/core，依赖只有 typebox
│   ├── src/index.ts             Task 2  重新导出
│   ├── src/errors.ts            Task 2  TetherError 与错误码
│   ├── src/model.ts             Task 2  TypeBox schema 与记录类型
│   ├── src/validate.ts          Task 2  版本与会话变量的校验
│   ├── src/tools.ts             Task 2  ToolDescriptor、TetherTool、BUILTIN_TOOLS
│   ├── src/env.ts               Task 3  TetherEnv
│   ├── src/events.ts            Task 3  TranscriptEntry、SessionView、TetherEvent
│   ├── src/ports.ts             Task 3  AppStore、AgentEngine、SandboxProvider、ExecChannel、Clock、Ids
│   ├── src/services/agents.ts   Task 9  AgentService
│   ├── src/services/sandboxes.ts Task 9 SandboxService（ensureSandbox、单飞、setup）
│   ├── src/services/sessions.ts Task 9  SessionService
│   ├── src/startup.ts           Task 10 recover()：§4.5 的前三步
│   └── test/                    各任务的单元测试与测试替身
├── packages/testkit/
│   ├── package.json             Task 4  @tether/testkit，依赖 @tether/core
│   ├── src/app-store.ts         Task 4  registerAppStoreConformance
│   ├── src/memory-app-store.ts  Task 4  内存实现（参照答案，也给 core 测试用）
│   ├── src/sandbox-provider.ts  Task 5  registerSandboxProviderConformance
│   └── src/agent-engine.ts      Task 7  registerAgentEngineConformance
├── packages/server/
│   ├── package.json             Task 1  @tether/server
│   ├── sandbox/Dockerfile       Task 5  默认沙箱镜像 tether-sandbox:dev
│   ├── sandbox/launch.sh        Task 5  沿用 M0 的 launch.sh
│   ├── src/adapters/store-sqlite/   Task 4
│   ├── src/adapters/sandbox-docker/ Task 5
│   ├── src/adapters/exec-pienv/     Task 6
│   ├── src/adapters/engine-pi/      Task 7、8
│   ├── src/http/                    Task 11、12
│   ├── src/config.ts                Task 10 环境变量 → Config
│   ├── src/app.ts                   Task 10 createTether(deps)：组装与 §4.5 启动顺序
│   ├── src/main.ts                  Task 10 进程入口
│   └── test/                        适配器测试、架构测试、API 测试
├── packages/sdk/                    Task 13 @tether/sdk
└── packages/cli/                    Task 14 @tether/cli
```

`spikes/m0/` 原样保留，不进入任何包。

---

### Task 1: Monorepo 骨架与依赖边界

**Files:**
- Modify: `package.json`、`tsconfig.json`、`vitest.config.ts`
- Create: `packages/{core,testkit,server,sdk,cli}/package.json`、各包 `src/index.ts`（暂时只有 `export {}`）
- Test: `packages/server/test/architecture.test.ts`

**Interfaces:**
- Produces: `npm test`（unit + docker 两个 project）、`npm run test:unit`、`npm run test:docker`、`npm run test:spikes`、`npm run typecheck`。

- [ ] **Step 1: 改根 `package.json`**

`"workspaces": ["packages/*"]`；根的 `dependencies` 改为 `devDependencies` 并保留（`spikes/m0` 仍从根解析 pi 包）；脚本见上。vitest 的 `projects`：`unit` 包含 `packages/*/test/**/*.test.ts` 但排除 `*.docker.test.ts`；`docker` 只包含 `packages/*/test/**/*.docker.test.ts`，`fileParallelism: false`、`testTimeout: 120_000`；`test:spikes` 用单独的 `vitest.spikes.config.ts` 指向 `spikes/**/*.test.ts`。

- [ ] **Step 2: 写失败的架构测试 `packages/server/test/architecture.test.ts`**

用正则从 `.ts` 文件里提取 `from "…"` 和 `import("…")` 的模块名，断言：

```ts
it("core imports only relative paths and typebox", ...)          // packages/core/src/**
it("testkit imports only core, vitest and relative paths", ...)  // packages/testkit/src/**
it("no adapter imports another adapter", ...)                    // packages/server/src/adapters/<a>/** 不出现 ../<b>/
it("pi packages appear only in adapters and main.ts", ...)       // packages/server/src 其余目录、sdk、cli 不出现 @earendil-works/
it("sdk imports only core and relative paths", ...)
```

另外断言每个 `packages/*/package.json` 的依赖版本都不以 `^` 或 `~` 开头。

- [ ] **Step 3: 运行，确认失败**（各包 `src` 目录还不存在）

Run: `npm run test:unit -- packages/server/test/architecture.test.ts`
Expected: FAIL

- [ ] **Step 4: 建五个包的 `package.json` 与空 `src/index.ts`**

包名 `@tether/core`、`@tether/testkit`、`@tether/server`、`@tether/sdk`、`@tether/cli`，全部 `"private": true`、`"type": "module"`、`exports` 指向 `./src/index.ts`。依赖：core → `typebox@1.3.27`；testkit → `@tether/core`（`"*"` 指向 workspace）；server → core、testkit（dev）、pi 四包、`hono`、`@hono/node-server`、`@hono/node-ws`；sdk → core；cli → sdk。Hono 系列取当前稳定版，写精确版本。然后 `npm install`。

- [ ] **Step 5: 运行全部单元测试和类型检查**

Run: `npm run test:unit && npm run typecheck`
Expected: 架构测试 PASS；typecheck 无错误。

- [ ] **Step 6: 提交**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts vitest.spikes.config.ts packages
git commit -m "chore: 建立五个包的 monorepo 骨架与依赖边界测试"
```

---

### Task 2: core 的领域模型与校验

**Files:**
- Create: `packages/core/src/{errors,model,validate,tools}.ts`
- Test: `packages/core/test/validate.test.ts`

**Interfaces:**
- Produces（`errors.ts`）：`type ErrorCode = "invalid_request" | "unauthorized" | "not_found" | "conflict" | "busy" | "sandbox_failed" | "engine_failed" | "internal"`；`class TetherError extends Error { constructor(code: ErrorCode, message: string, detail?: unknown) }`。
- Produces（`model.ts`，TypeBox schema 与 `Static` 类型同名导出）：
  - `ModelRef = { provider: string; modelId: string; thinkingLevel?: "off" | "low" | "medium" | "high" }`
  - `SandboxSpec = { template: string; resources: { cpu: number; memoryMb: number; diskMb?: number }; network: "none" | "egress"; setup: string[]; variables: string[] }`
  - `AgentVersionSpec = { model: ModelRef; instructions: string; tools: string[]; sandbox: SandboxSpec; checkpointPolicy: "none" | "perRun"; permissions: { denyTools: string[]; requireApproval: string[] } }`
  - 记录类型：`AgentRecord { id; ownerId; name; description; createdAt; archivedAt? }`、`AgentVersionRecord { agentId; version; spec: AgentVersionSpec; createdAt }`、`SessionRecord { id; ownerId; agentId; agentVersion; engineSessionId: string | null; parentSessionId: null; forkedFrom: null; variables: Record<string, string>; status: "active" | "idle" | "archived" | "failed"; title?; createdAt; lastActiveAt }`、`SandboxBinding { sessionId; provider: "docker"; sandboxId; epoch: number; state: "creating" | "running" | "stopped" | "lost" | "destroyed"; template; createdAt; lastUsedAt }`。时间一律 ISO 字符串。
- Produces（`tools.ts`）：`ToolDescriptor { name; description; replay: "safe" | "unsafe"; sideEffects: "none" | "sandbox" | "external" }`；`TetherTool extends ToolDescriptor { parameters: TSchema; execute(args, env: TetherEnv, signal?: AbortSignal): Promise<{ output: string; isError?: boolean }> }`（M1 只定义，不接入）；`BUILTIN_TOOLS: readonly ToolDescriptor[]`，四项：`read`（`replay: "safe"`、`sideEffects: "none"`），`write`、`edit`、`bash`（`replay: "unsafe"`、`sideEffects: "sandbox"`）。
- Produces（`validate.ts`）：`validateVersionSpec(spec: unknown, catalog: readonly ToolDescriptor[]): AgentVersionSpec`、`validateSessionVariables(values: unknown, declared: readonly string[]): Record<string, string>`，不合法抛 `TetherError("invalid_request", …)`。

- [ ] **Step 1: 写失败的测试 `validate.test.ts`**

```ts
it("accepts a complete spec and returns it typed", ...)
it("rejects a tool that is not in the catalog", ...)            // message 含工具名
it("rejects a tool listed in both tools and denyTools", ...)
it("rejects variable names that are not shell identifiers", ...) // 合法：/^[A-Z_][A-Z0-9_]*$/
it("rejects cpu <= 0 and memoryMb < 64", ...)
it("rejects session variables not declared by the version", ...)
it("rejects non-string variable values", ...)
it("keeps variable values verbatim, including shell metacharacters", ...) // "x; touch /workspace/pwned" 原样返回
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm run test:unit -- packages/core`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现四个文件**

校验用 `typebox` 的 `Value.Check` / `Value.Errors`，错误消息里带出第一个失败的路径。

- [ ] **Step 4: 运行，确认通过；再跑架构测试和 typecheck**

Run: `npm run test:unit && npm run typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core
git commit -m "feat(core): 领域模型、错误码与版本、变量校验"
```

---

### Task 3: core 的端口、事件格式与 TetherEnv

**Files:**
- Create: `packages/core/src/{env,events,ports}.ts`、`docs/adr/ADR-009-tether-env-minimal.md`
- Modify: `docs/adr/README.md`（索引加一行）、`docs/superpowers/specs/2026-10-20-tether-design.md`（§4.2 末尾关于 `ExecutionEnv` 的引用块）
- Test: `packages/core/test/events.test.ts`

**Interfaces:**
- Produces（`env.ts`）：

```ts
interface ExecResult { exitCode: number; stdout: string; stderr: string }
interface TetherEnv {
	readonly cwd: string;
	readText(path: string): Promise<string>;
	writeFile(path: string, content: string | Uint8Array): Promise<void>;
	exists(path: string): Promise<boolean>;
	list(path: string): Promise<{ name: string; kind: "file" | "dir" | "symlink" | "other"; size: number }[]>;
	exec(command: string, options?: { env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal }): Promise<ExecResult>;
}
```

  文件不存在等错误抛 `TetherError("not_found" | "sandbox_failed", …)`。

- Produces（`events.ts`）：
  - `TranscriptEntry = { id: string; kind: string; role?: "user" | "assistant" | "tool"; text?: string; toolCalls?: { id: string; name: string; args: unknown }[]; toolResult?: { callId: string; isError: boolean; text: string }; data?: unknown }`。引擎条目 ID 一律转成字符串。
  - `SessionView = { running: boolean; entries: TranscriptEntry[]; streaming?: { text: string }; tools: { callId: string; name: string; output: string }[]; queued: number }`
  - `TetherEvent` 联合：`snapshot { view }`、`message_start { messageId }`、`message_delta { messageId; text }`、`message_end { messageId; entry: TranscriptEntry }`、`tool_start { callId; name; args }`、`tool_output { callId; text }`、`tool_end { callId; entry: TranscriptEntry }`、`entry { entry: TranscriptEntry }`（用户输入、`tether.*` 条目）、`run_end { submissionId: string; status: "done" | "unanswered" | "aborted" }`。
  - `applyEvent(view: SessionView, event: TetherEvent): SessionView`：纯函数，返回新对象，`snapshot` 整体替换。SDK 和测试都用它维护本地状态。
- Produces（`ports.ts`）：

```ts
interface AppStore {
	createAgent(agent: AgentRecord, first: AgentVersionRecord): Promise<void>;
	getAgent(id: string): Promise<AgentRecord | undefined>;
	listAgents(): Promise<AgentRecord[]>;
	archiveAgent(id: string, at: string): Promise<void>;
	addVersion(agentId: string, spec: AgentVersionSpec, at: string): Promise<AgentVersionRecord>; // version = 当前最大 + 1，事务内完成
	getVersion(agentId: string, version?: number): Promise<AgentVersionRecord | undefined>;       // 省略 version 取最新
	createSession(session: SessionRecord): Promise<void>;
	setEngineSessionId(sessionId: string, engineSessionId: string): Promise<void>;
	getSession(id: string): Promise<SessionRecord | undefined>;
	getSessionByEngineId(engineSessionId: string): Promise<SessionRecord | undefined>;
	listSessions(query: { agentId?: string; status?: SessionRecord["status"]; limit: number; after?: string }): Promise<{ items: SessionRecord[]; next?: string }>;
	sessionsWithoutEngine(): Promise<SessionRecord[]>;
	updateSession(id: string, patch: Partial<Pick<SessionRecord, "status" | "title" | "lastActiveAt">>): Promise<void>;
	getBinding(sessionId: string): Promise<SandboxBinding | undefined>;
	putBinding(binding: SandboxBinding): Promise<void>;
	deleteBinding(sessionId: string): Promise<void>;
	listBindings(): Promise<SandboxBinding[]>;
}
interface EngineAgentConfig { model: ModelRef; instructions: string; tools: string[]; cwd: string }
interface AgentEngine {
	createSession(config: EngineAgentConfig): Promise<string>;                 // 返回引擎会话 ID
	hasSession(engineSessionId: string): Promise<boolean>;
	submit(engineSessionId: string, input: { content: string; requestId: string; whenBusy?: "followUp" | "steer" | "reject" }): Promise<{ submissionId: string }>;
	waitSubmission(submissionId: string): Promise<{ status: "done" | "unanswered"; answer?: TranscriptEntry }>;
	abort(engineSessionId: string): Promise<void>;
	transcript(engineSessionId: string, page: { limit: number; before?: string }): Promise<{ items: TranscriptEntry[]; next?: string }>; // 新的在前
	appendEntry(engineSessionId: string, entry: { kind: `tether.${string}`; data: unknown; modelText?: string }): Promise<void>;
	subscribe(engineSessionId: string, listener: (events: TetherEvent[]) => void): Promise<{ stop(): Promise<void> }>; // 第一批是 snapshot
	resume(): void;
	close(): Promise<void>;
}
interface SandboxCreate { sessionId: string; spec: SandboxSpec }
interface SandboxProvider {
	readonly name: "docker";
	readonly capabilities: { snapshot: boolean; fork: boolean; rollback: boolean; preservesMemoryOnStop: boolean };
	create(input: SandboxCreate): Promise<{ sandboxId: string }>;
	status(sandboxId: string): Promise<"running" | "stopped" | "missing">;
	start(sandboxId: string): Promise<void>;
	stop(sandboxId: string): Promise<void>;
	destroy(sandboxId: string): Promise<void>;                                  // 同时删除工作区目录；不存在不报错
	listManaged(): Promise<{ sandboxId: string; sessionId: string }[]>;
	daemonCommand(sandboxId: string, epoch: number): string[];
}
interface ExecChannel {
	env(binding: SandboxBinding, options: { cwd: string; shellEnv?: Record<string, string> }): TetherEnv;
	close(sandboxId: string): void;
}
interface Clock { now(): string }
interface Ids { next(prefix: "agt" | "ses"): string }   // 形如 agt_<ULID 或 UUIDv7>
```

- [ ] **Step 1: 写失败的测试 `events.test.ts`**

```ts
it("replaces the whole view on snapshot", ...)
it("accumulates message deltas and clears streaming on message_end", ...)   // entries 末尾多一条，streaming 为 undefined
it("appends tool output by callId and drops the tool on tool_end", ...)
it("returns a new object and never mutates the input view", ...)           // Object.freeze 输入后调用不抛错
```

- [ ] **Step 2: 运行，确认失败**

- [ ] **Step 3: 实现 `env.ts`、`events.ts`、`ports.ts`，在 `index.ts` 导出**

- [ ] **Step 4: 写 ADR-009，修订 spec §4.2**

ADR-009《`TetherEnv` 先取最小子集》，格式同已有 ADR（状态/日期/决策人 wangl；背景/备选方案/决策/后果/参考）。备选方案：A 完整复制 `ExecutionEnv`（二十多个方法，签名带 chord 的 `Context`）；B 最小子集，内置工具直接用 pi 的环境对象。选 B，后果写明第二阶段自研引擎要自己提供内置工具时再扩充接口。spec §4.2 末尾的引用块改为指向 ADR-009。

- [ ] **Step 5: 运行单元测试、架构测试、typecheck**

Run: `npm run test:unit && npm run typecheck`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/core docs/adr docs/superpowers/specs
git commit -m "feat(core): 端口接口、事件格式与最小 TetherEnv（ADR-009）"
```

---

### Task 4: 应用存储

**Files:**
- Create: `packages/testkit/src/{app-store,memory-app-store,index}.ts`、`packages/server/src/adapters/store-sqlite/{index,schema}.ts`
- Test: `packages/testkit/test/memory-app-store.test.ts`、`packages/server/test/store-sqlite.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `AppStore` 与记录类型。
- Produces: `registerAppStoreConformance(runner: { describe; it; expect; beforeEach }, name: string, open: () => Promise<{ store: AppStore; close(): Promise<void> }>)`；`class MemoryAppStore implements AppStore`；`openSqliteAppStore(path: string): Promise<{ store: AppStore; close(): Promise<void> }>`（`":memory:"` 可用）。

- [ ] **Step 1: 在 `testkit/src/app-store.ts` 写一致性用例**

```ts
it("creates an agent with version 1 atomically", ...)
it("numbers versions 1, 2, 3 and returns the latest when version is omitted", ...)
it("assigns distinct versions to concurrent addVersion calls", ...)          // Promise.all 两次 → {2, 3}
it("returns undefined for a missing agent, version, session and binding", ...)
it("finds a session by its engine session id after setEngineSessionId", ...)
it("lists sessions without an engine id", ...)
it("filters sessions by agent and status and pages with after", ...)        // limit 2，三条记录，两页
it("replaces a binding on put and removes it on delete", ...)
it("round-trips variables with shell metacharacters", ...)
```

- [ ] **Step 2: `memory-app-store.test.ts` 与 `store-sqlite.test.ts` 各调用一次 `registerAppStoreConformance`，运行确认失败**

- [ ] **Step 3: 实现 `MemoryAppStore`，运行 testkit 测试至通过**

- [ ] **Step 4: 实现 `store-sqlite`**

`node:sqlite` 的 `DatabaseSync`，WAL 模式，表结构照 spec §5 的四张表（`checkpoints` M3 再建）；JSON 字段存 TEXT；`addVersion` 在 `BEGIN IMMEDIATE` 事务里取最大版本加一。

- [ ] **Step 5: 运行两套测试与 typecheck，确认通过**

Run: `npm run test:unit -- packages/testkit packages/server/test/store-sqlite.test.ts && npm run typecheck`

- [ ] **Step 6: 提交**

```bash
git add packages/testkit packages/server/src/adapters/store-sqlite packages/server/test/store-sqlite.test.ts
git commit -m "feat: AppStore 一致性测试、内存实现与 SQLite 适配器"
```

---

### Task 5: Docker 沙箱后端

**Files:**
- Create: `packages/server/sandbox/{Dockerfile,launch.sh}`、`packages/server/src/adapters/sandbox-docker/{index,docker-cli}.ts`、`packages/testkit/src/sandbox-provider.ts`
- Test: `packages/server/test/sandbox-docker.docker.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `SandboxProvider`、`SandboxSpec`。
- Produces: `createDockerSandboxProvider(options: { workspaceRoot: string; user: string; defaultImage: string }): SandboxProvider`；`buildSandboxImage(tag: string): Promise<void>`；`registerSandboxProviderConformance(runner, name, make: () => Promise<{ provider: SandboxProvider; sessionId: () => string; cleanup(): Promise<void> }>)`。

- [ ] **Step 1: 写 `testkit/src/sandbox-provider.ts` 的一致性用例**

```ts
it("creates a running sandbox and lists it as managed with its session", ...)
it("reports missing after destroy, and destroy of a missing sandbox does not throw", ...)
it("reports stopped after stop and running after start, still listed as managed", ...)
it("returns a daemon command that ends with the epoch", ...)
```

testkit 不依赖 pi-env，无法经 daemon 写文件，所以"停止再启动后文件还在"由 Task 6 的 Docker 测试覆盖。

- [ ] **Step 2: Docker 测试文件调用一致性用例，并加 Docker 专有用例**

```ts
it("runs the container as the given uid:gid with PID 1 sleep", ...)        // docker exec id -u、cat /proc/1/comm
it("applies cpu, memory and network none", ...)                            // docker inspect: NanoCpus=1e9, Memory=512MiB, NetworkMode=none
it("uses bridge networking for egress", ...)
it("mounts <workspaceRoot>/<sessionId> at /workspace", ...)
it("removes the workspace directory on destroy", ...)
it("labels containers tether.managed=1 and tether.session=<id>", ...)
```

- [ ] **Step 3: 运行，确认失败**

Run: `npm run test:docker -- sandbox-docker`

- [ ] **Step 4: 实现**

`Dockerfile`、`launch.sh` 沿用 `spikes/m0/` 的写法，镜像标签 `tether-sandbox:dev`。容器名 `tether-<sessionId>`；`create` 先 `mkdir -p <workspaceRoot>/<sessionId>` 再 `docker run -d --label tether.managed=1 --label tether.session=<id> --cpus <cpu> --memory <memoryMb>m --pids-limit 512 --network none|bridge --user <uid:gid> -v <ws>:/workspace <image> sleep infinity`。`spec.template` 为空字符串时用 `defaultImage`。`diskMb` M1 忽略并在代码注释里说明。`destroy` 的工作区删除沿用 M0 `removeTree` 的一次性容器做法。`capabilities` 全部为 `false`（M3 实现快照后改）。

- [ ] **Step 5: 运行，确认通过**

- [ ] **Step 6: 提交**

```bash
git add packages/server/sandbox packages/server/src/adapters/sandbox-docker packages/testkit/src/sandbox-provider.ts packages/server/test/sandbox-docker.docker.test.ts
git commit -m "feat: Docker 沙箱后端与 SandboxProvider 一致性测试"
```

---

### Task 6: 执行通道

**Files:**
- Create: `packages/server/src/adapters/exec-pienv/index.ts`
- Test: `packages/server/test/exec-pienv.docker.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `ExecChannel`、`TetherEnv`、`SandboxBinding`；Task 5 的 provider（测试里用来建容器）。
- Produces: `createPiEnvExecChannel(options: { daemonCommand: (sandboxId: string, epoch: number) => string[] }): ExecChannel & { piEnv(binding: SandboxBinding, cwd: string): ExecutionEnv /* pi 类型 */; closeAll(): void }`。同一 `(sandboxId, epoch)` 复用一个 `Connection`；epoch 变化时关闭旧连接、建新连接。

- [ ] **Step 1: 写测试**

```ts
// 一个 provider 建的容器，epoch 1
registerEnvConformance({ describe, expect, it }, "exec-pienv on docker", provider, { listFiles: true }) // piEnv，cwd 用容器内 mktemp -d
it("reads back what it writes through TetherEnv", ...)
it("passes shellEnv as environment variables without interpolation", ...)  // shellEnv { NAME: "x; touch pwned" }，exec("printf %s \"$NAME\"") → stdout 原样；pwned 不存在
it("maps a missing file to TetherError not_found", ...)
it("reuses one connection for the same sandbox and epoch", ...)            // 两次 env() 后 daemon 记录目录只有一条 1.<pid>
it("keeps files across provider stop and start", ...)                      // 补 Task 5 的那一条
```

- [ ] **Step 2: 运行，确认失败**

- [ ] **Step 3: 实现**

`TetherEnv` 的五个方法包装 `RemoteExecutionEnv` 的对应方法，`Result` 的错误转换成 `TetherError`；`exec` 的 `env` 选项通过以 `shellEnv` 新建一个共享同一 `Connection` 的 `RemoteExecutionEnv` 实现。

- [ ] **Step 4: 运行，确认通过**

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/adapters/exec-pienv packages/server/test/exec-pienv.docker.test.ts
git commit -m "feat: pi-env 执行通道适配器"
```

---

### Task 7: 引擎适配器（一）：会话、提交、记录、自定义条目

**Files:**
- Create: `packages/server/src/adapters/engine-pi/{index,transcript}.ts`、`packages/testkit/src/agent-engine.ts`
- Test: `packages/server/test/engine-pi.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `AgentEngine`、`EngineAgentConfig`、`TranscriptEntry`。
- Produces:
  - `openPiEngine(options: { database: string; models: Models; envFor: (engineSessionId: string) => Promise<ExecutionEnv | undefined>; onError?: (error: unknown) => void }): Promise<AgentEngine>`。`registry` 安装 `CodingTools`；`createSession` 用 `harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model, instructions, tools, cwd } })`，`tools` 按名字从 `CodingTools` 里挑。
  - `registerAgentEngineConformance(runner, name, make: (script: ScriptStep[]) => Promise<{ engine: AgentEngine; reopen(script: ScriptStep[]): Promise<AgentEngine>; requests(): string[][]; close(): Promise<void> }>)`，其中 `ScriptStep = { text: string } | { toolCall: { name: string; args: unknown } }` 是 testkit 自己定义的、与模型实现无关的剧本格式，`engine-pi` 的测试把它翻译成 faux 响应；`requests()` 返回每次模型请求收到的消息文本，按请求顺序。
  - `toTranscriptEntry(entry: EntryRecord): TranscriptEntry`（`transcript.ts`）：`pi.user` → `role: "user"`；`pi.assistant` → `role: "assistant"`，文本和工具调用；`pi.tool-result` → `role: "tool"`；其余 kind 原样带 `kind` 和 `data`。

- [ ] **Step 1: 写 `testkit/src/agent-engine.ts` 的第一组用例**

```ts
it("answers an input and lists user and assistant entries newest first", ...)
it("returns the same submission for a repeated requestId, also after reopen, without asking the model again", ...)
it("returns the first submission when a requestId is reused with different content", ...)  // Review Focus 4
it("keeps conversations separate", ...)                                     // 两个会话各自的 transcript 互不包含
it("appends a tether entry without model text that the model does not see", ...)
it("appends a tether entry with model text that the model sees on the next request", ...)
```

模型是否"看到"由 `requests()` 判断。

- [ ] **Step 2: `engine-pi.test.ts` 调用一致性用例（不需要 Docker，`envFor` 返回 `undefined`），运行确认失败**

- [ ] **Step 3: 实现 `engine-pi` 与 `transcript.ts`**

存储 `openNodeSqliteStorage(database)`；faux 剧本翻译与 M0 `spikes/m0/harness.ts` 的 `toolCall` 相同。`appendEntry` 用 `submit({ type: "write", entry: { kind, data, model: modelText ? [{ role: "user", content: modelText, timestamp: Date.now() }] : undefined } })`。引擎的数字 ID 一律 `String()` 后对外。

- [ ] **Step 4: 运行，确认通过；typecheck**

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/adapters/engine-pi packages/testkit/src/agent-engine.ts packages/server/test/engine-pi.test.ts
git commit -m "feat: pi-durable 引擎适配器与 AgentEngine 一致性测试（会话、提交、条目）"
```

---

### Task 8: 引擎适配器（二）：事件流、忙时行为、中断、续跑

**Files:**
- Create: `packages/server/src/adapters/engine-pi/events.ts`
- Modify: `packages/server/src/adapters/engine-pi/index.ts`、`packages/testkit/src/agent-engine.ts`
- Test: `packages/server/test/engine-pi.test.ts`（同一个文件，用例来自 testkit）

**Interfaces:**
- Consumes: Task 3 的 `TetherEvent`、`applyEvent`；Task 7 的 `openPiEngine`。
- Produces: `AgentEngine.subscribe` / `abort` / `resume` / `waitSubmission` 的实现；`toTetherEvents(piEvents: unknown[]): TetherEvent[]`（`events.ts`）。

- [ ] **Step 1: 在 testkit 里加第二组用例**

```ts
it("delivers a snapshot first, then events whose application equals the final transcript", ...) // applyEvent 折叠后的 entries 与 transcript() 一致
it("delivers to two subscribers independently", ...)
it("queues a follow-up while busy and answers it after the current run", ...)
it("rejects with TetherError busy when whenBusy is reject", ...)
it("aborts a running tool and settles the submission as unanswered", ...)   // 剧本：toolCall 一个会阻塞的工具（testkit 用 bash: sleep 30），abort 后 waitSubmission
it("continues an unfinished run after reopen", ...)                         // 剧本第一步后关闭（不等完成），reopen + resume，waitSubmission → done
```

阻塞工具需要执行环境：`make` 的实现负责提供一个能执行 `sleep` 的环境；`engine-pi.test.ts` 用 pi-durable 的 `NodeExecutionEnv`（本机临时目录）满足它，不需要 Docker。

- [ ] **Step 2: 运行，确认失败**

- [ ] **Step 3: 实现**

`subscribe` 基于 `watchEvents(harness, conversationId, context)`：先把 `stream.snapshot` 转成 `snapshot` 事件，之后每批转换。pi 事件名与字段以 `pi-latest/packages/durable/test/examples/19-json.ts` 的完整输出为准，映射写在 `events.ts` 顶部的注释表里；pi 侧落后 100 批时发来的新 `snapshot` 同样转换成 `snapshot`。`busy` 由 pi 的 `ConversationBusy` 转成 `TetherError("busy", …)`。

- [ ] **Step 4: 运行，确认通过；typecheck**

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/adapters/engine-pi packages/testkit/src/agent-engine.ts
git commit -m "feat: 引擎适配器的事件流、忙时行为、中断与续跑"
```

---

### Task 9: core 的领域服务

**Files:**
- Create: `packages/core/src/services/{agents,sandboxes,sessions}.ts`、`packages/core/test/fakes.ts`
- Test: `packages/core/test/{agents,sandboxes,sessions}.test.ts`、`packages/server/test/sandboxes.docker.test.ts`

**Interfaces:**
- Consumes: Task 2–4 的类型、端口与 `MemoryAppStore`。
- Produces:
  - `class AgentService { constructor(deps: { store; clock; ids; catalog: readonly ToolDescriptor[] }); create(input: { name; description?; spec: unknown }): Promise<{ agent: AgentRecord; version: AgentVersionRecord }>; addVersion(agentId, spec: unknown); get(id); list(); getVersion(agentId, version?); archive(id) }`。
  - `class SandboxService { constructor(deps: { store; provider: SandboxProvider; exec: ExecChannel; clock; record: (sessionId: string, data: { state: SandboxBinding["state"]; reason?: string }) => Promise<void> }); ensureSandbox(sessionId: string): Promise<SandboxBinding>; status(sessionId): Promise<SandboxBinding | undefined> }`。`record` 由 `app.ts` 接到 `engine.appendEntry`，写一条不带 `modelText` 的 `tether.sandbox` 条目（spec §4.4）；M1 在创建成功、启动、`setup` 失败、发现丢失四处调用。
  - `class SessionService { constructor(deps: { store; engine: AgentEngine; agents: AgentService; clock; ids }); create(input: { agentId; agentVersion?; variables?: unknown }): Promise<SessionRecord>; get(id); list(query); sendMessage(id, input: { content; requestId; whenBusy? }): Promise<{ submissionId }>; abort(id); transcript(id, page); subscribe(id, listener) }`。
  - `fakes.ts`：`FakeEngine implements AgentEngine`（记录调用，`createSession` 可配置为抛错）、`FakeProvider implements SandboxProvider`（内存状态，可配置 `create` 延迟）、`FakeExecChannel`（`exec` 按脚本返回结果，记录收到的命令与 `env`）。

- [ ] **Step 1: 写失败的单元测试**

`agents.test.ts`：

```ts
it("creates an agent with version 1 and validates tools against the catalog", ...)
it("rejects a version for an archived agent with conflict", ...)
it("returns not_found for an unknown agent", ...)
```

`sandboxes.test.ts`：

```ts
it("creates the sandbox, runs every setup command in /workspace with variables as env, and stores a running binding", ...)
it("creates only one sandbox for concurrent ensureSandbox calls on a new session", ...)  // Review Focus 1：10 个并发调用，FakeProvider.create 被调用 1 次
it("reuses a running binding without calling the provider", ...)
it("starts a stopped sandbox", ...)
it("on setup failure destroys the sandbox, deletes the binding and throws sandbox_failed with the command and its output", ...) // Review Focus 2
it("creates again on the next call after a setup failure", ...)
it("marks the binding lost and throws sandbox_failed when the provider reports it missing", ...)
it("records a tether.sandbox entry on create, start, setup failure and loss", ...)  // record 的调用序列
```

`sessions.test.ts`：

```ts
it("writes the session before creating the engine session and backfills the engine id", ...) // FakeEngine.createSession 里读 store，记录已存在且 engineSessionId 为 null
it("leaves engineSessionId null when the engine fails, and rethrows engine_failed", ...)
it("pins the session to the latest version when agentVersion is omitted", ...)
it("validates variables against the pinned version", ...)
it("passes model, instructions, tools and cwd /workspace to the engine", ...)
it("returns not_found for messages to an unknown session", ...)
```

- [ ] **Step 2: 运行，确认失败**

- [ ] **Step 3: 实现三个服务**

`ensureSandbox` 的单飞：`Map<sessionId, Promise<SandboxBinding>>`，完成或失败后删除。`setup` 依次执行，`exec(command, { env: session.variables })`，退出码非零即失败，错误消息含命令和 stdout/stderr 的最后 4 KB。M1 的 epoch 固定为 1。

- [ ] **Step 4: 写 Docker 集成测试 `sandboxes.docker.test.ts` 并运行**

用真实的 `SandboxService` + Task 5、6 的适配器 + `MemoryAppStore`：

```ts
it("passes variables to setup as env without interpolation", ...)   // setup ["printf %s \"$NAME\" > name.txt"]，NAME = "x; touch /workspace/pwned" → name.txt 内容原样，pwned 不存在（Review Focus 3）
it("reports the failing setup command and its output", ...)      // setup ["echo boom >&2; exit 3"]
```

Run: `npm run test:unit -- packages/core && npm run test:docker -- sandboxes`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core packages/server/test/sandboxes.docker.test.ts
git commit -m "feat(core): agent、会话与沙箱领域服务"
```

---

### Task 10: 启动恢复与组装

**Files:**
- Create: `packages/core/src/startup.ts`、`packages/server/src/{config,app,main}.ts`
- Test: `packages/core/test/startup.test.ts`、`packages/server/test/app.docker.test.ts`

**Interfaces:**
- Consumes: Task 3–9。
- Produces:
  - `recover(deps: { store; engine; provider; sessions: SessionService; log }): Promise<{ repairedSessions: number; lostBindings: number; removedOrphans: number }>`：spec §4.5 第 1、2 步，然后调用 `engine.resume()`（第 3 步）。第 1 步对 `sessionsWithoutEngine()` 补建引擎会话，补建失败的标记 `failed`；第 2 步把 `status` 为 `missing` 的绑定标记 `lost`，删除 `listManaged()` 里没有绑定的容器。
  - `loadConfig(env: NodeJS.ProcessEnv): Config`，`Config = { dataDir; host; port; token?; workspaceRoot; sandboxImage }`；默认值 `TETHER_DATA_DIR=./data`、`TETHER_HOST=127.0.0.1`、`TETHER_PORT=7420`、`TETHER_TOKEN` 未设置、`TETHER_SANDBOX_IMAGE=tether-sandbox:dev`、`workspaceRoot=<dataDir>/workspaces`。
  - `createTether(config: Config, overrides?: { models?: Models }): Promise<{ app: Hono; services; close(): Promise<void> }>`：按 spec §4.5 的顺序打开应用存储、对账、打开引擎并 `resume()`，最后才返回（HTTP 由调用方监听）。`envFor` 在这里拼：按引擎会话 ID 查会话 → `sandboxes.ensureSandbox` → `exec.piEnv(binding, "/workspace")`。
  - `main.ts`：`loadConfig(process.env)` → `createTether` → `@hono/node-server` 监听；屏蔽 `node:sqlite` 的 `ExperimentalWarning`（只过滤这一条）；`SIGTERM`/`SIGINT` 时 `close()`。
- [ ] **Step 1: 写失败的测试 `startup.test.ts`**

```ts
it("repairs sessions without an engine id before resuming the engine", ...)        // 调用顺序记录：createSession… → resume
it("marks a session failed when its engine session cannot be created", ...)
it("marks bindings lost whose sandbox is missing", ...)
it("removes managed sandboxes that have no binding", ...)
it("reconciles sandboxes before resuming the engine", ...)                          // FakeProvider.listManaged 的调用早于 FakeEngine.resume
```

- [ ] **Step 2: 运行，确认失败；实现 `startup.ts`；运行至通过**

- [ ] **Step 3: 写 `app.docker.test.ts`**

```ts
it("runs a tool in the session's own container end to end", ...)  // faux：bash "echo hi > a.txt" → "done"；services 层调用，容器里 a.txt 为 "hi\n"
it("gives two sessions two containers", ...)
it("resumes an unfinished run after the process is killed", ...)  // 子进程跑 createTether（faux 剧本 bash sleep 3 再回答），SIGKILL 后在本进程 createTether 同一 dataDir，waitSubmission → done，bash 结果为 interrupted
```

最后一条的子进程脚本放在 `packages/server/test/fixtures/run-tether.ts`，做法同 M0 的 `crash-child.ts`：读 `TETHER_*` 配置和 `TETHER_FAUX_SCRIPT`（`ScriptStep[]` 的 JSON），用 faux 模型调用 `createTether` 并监听端口。Task 14 的 CLI 测试复用它。

- [ ] **Step 4: 实现 `config.ts`、`app.ts`、`main.ts`，运行至通过；typecheck**

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/startup.ts packages/core/test/startup.test.ts packages/server/src packages/server/test
git commit -m "feat: 启动恢复顺序与服务组装"
```

---

### Task 11: HTTP API

**Files:**
- Create: `packages/server/src/http/{routes,envelope,auth}.ts`
- Modify: `packages/server/src/app.ts`（挂载路由）
- Test: `packages/server/test/http.test.ts`（用 `app.request()`，faux 模型，`envFor` 不需要 Docker 的剧本）

**Interfaces:**
- Consumes: Task 9 的服务，Task 10 的 `createTether`。
- Produces: 下列路由，全部返回 Global Constraints 里的信封。错误码到 HTTP 状态：`invalid_request` 400、`not_found` 404、`conflict` 409、`busy` 409、`sandbox_failed` 502、`engine_failed` 502、`internal` 500；未知异常记日志后返回 `internal`，消息不含内部细节。

```text
POST /v1/agents                      { name, description?, spec } → { agent, version }
GET  /v1/agents                      → { items }
GET  /v1/agents/:id                  → { agent, latestVersion }
POST /v1/agents/:id/versions         { spec } → { version }
GET  /v1/agents/:id/versions/:v      → { version }
POST /v1/agents/:id/archive          → { agent }
POST /v1/sessions                    { agentId, agentVersion?, variables? } → { session }
GET  /v1/sessions                    ?agentId&status&limit(默认 20，最大 100)&after → { items, next? }
GET  /v1/sessions/:id                → { session, sandbox?: SandboxBinding }
POST /v1/sessions/:id/messages       { content, requestId, whenBusy? } → { submissionId }（202）
POST /v1/sessions/:id/abort          → {}
GET  /v1/sessions/:id/transcript     ?limit&before → { items, next? }
GET  /v1/sessions/:id/sandbox        → { binding | null }
GET  /v1/health                      → { status: "ok" }
```

请求体用 TypeBox schema 校验。设置了 `TETHER_TOKEN` 时，除 `/v1/health` 外都要求 `Authorization: Bearer <token>`，否则 401（错误码 `unauthorized`，加入 `ErrorCode`）。

- [ ] **Step 1: 写失败的测试**

```ts
it("creates an agent, adds a version and reads both back", ...)
it("rejects an unknown tool with 400 invalid_request", ...)
it("returns 404 not_found with the envelope for an unknown session", ...)
it("requires requestId on messages", ...)                                     // 400
it("returns the same submissionId for a repeated requestId with different content", ...) // Review Focus 4
it("returns 409 busy for whenBusy reject while a run is in progress", ...)
it("pages sessions with limit and after", ...)
it("requires the bearer token when configured, except on health", ...)
it("does not leak internal error messages", ...)                              // 让 store 抛一个带路径的错误 → message 为固定文本
```

- [ ] **Step 2: 运行，确认失败；实现；运行至通过；typecheck**

- [ ] **Step 3: 提交**

```bash
git add packages/server/src/http packages/server/src/app.ts packages/core/src/errors.ts packages/server/test/http.test.ts
git commit -m "feat: HTTP API 与统一响应信封"
```

---

### Task 12: WebSocket 事件流

**Files:**
- Create: `packages/server/src/http/events.ts`
- Modify: `packages/server/src/app.ts`、`packages/server/src/main.ts`（注入 `@hono/node-ws` 的升级处理）
- Test: `packages/server/test/events.test.ts`（真实监听一个随机端口，用 Node 内置 `WebSocket` 连接）

**Interfaces:**
- Consumes: Task 9 的 `SessionService.subscribe`，Task 3 的 `TetherEvent`。
- Produces: `WS /v1/sessions/:id/events`。每条 WebSocket 消息是一个 JSON 数组 `TetherEvent[]`（一批）；第一条消息只含一个 `snapshot`。会话不存在时以关闭码 `4404` 关闭；鉴权失败 `4401`；客户端断开时取消订阅。

- [ ] **Step 1: 写失败的测试**

```ts
it("sends a snapshot first, then the events of a run", ...)          // 发消息后收到 message_start … run_end
it("folds to the same entries as GET transcript", ...)              // applyEvent 折叠
it("serves two clients of the same session", ...)
it("closes with 4404 for an unknown session", ...)                  // Review Focus 5
it("stops the engine subscription when the client disconnects", ...) // FakeEngine 或计数：stop 被调用
```

- [ ] **Step 2: 运行，确认失败；实现；运行至通过；typecheck**

- [ ] **Step 3: 提交**

```bash
git add packages/server/src packages/server/test/events.test.ts
git commit -m "feat: 会话事件流 WebSocket"
```

---

### Task 13: SDK

**Files:**
- Create: `packages/sdk/src/{index,client,stream}.ts`
- Test: `packages/sdk/test/sdk.test.ts`（在测试进程里 `createTether` + 监听随机端口，faux 模型）

**Interfaces:**
- Consumes: Task 3 的类型与 `applyEvent`；Task 11、12 的 API。
- Produces:
  - `class TetherClient { constructor(options: { baseUrl: string; token?: string; fetch?: typeof fetch }); agents: { create; list; get; addVersion; getVersion; archive }; sessions: { create; list; get; send(id, content, options?: { whenBusy?; requestId? }): Promise<{ submissionId }>; abort; transcript; sandbox }; follow(sessionId, onView: (view: SessionView, event: TetherEvent) => void): SessionStream }`。失败时抛 `TetherApiError { code: ErrorCode | "network"; status?: number; message }`。
  - `send` 不传 `requestId` 时生成 `crypto.randomUUID()`；网络错误（`fetch` 抛出）时用同一个 `requestId` 重试，最多 2 次，间隔 200 ms、400 ms。
  - `SessionStream { readonly view: SessionView; close(): void }`：断线后按 250 ms 起、每次翻倍、上限 5 s 重连；收到 `snapshot` 整体替换本地状态（spec §7.3）。

- [ ] **Step 1: 写失败的测试**

```ts
it("covers agents and sessions end to end against a real server", ...)
it("retries send with the same requestId after a network error", ...)   // 注入的 fetch 第一次抛 TypeError → 服务端只有一个提交
it("raises TetherApiError with the server's code", ...)
it("follows a session and ends with the same entries as transcript", ...)
it("reconnects after the server restarts and replaces state with the new snapshot", ...) // close() 服务再 createTether 同一 dataDir 同一端口
```

- [ ] **Step 2: 运行，确认失败；实现；运行至通过；架构测试与 typecheck**

- [ ] **Step 3: 提交**

```bash
git add packages/sdk
git commit -m "feat(sdk): TypeScript 客户端与自动重连的事件流"
```

---

### Task 14: CLI 与端到端验收

**Files:**
- Create: `packages/cli/src/{index,main,commands}.ts`、`packages/cli/bin/tether`（`#!/usr/bin/env node` 指向 `../src/main.ts`）
- Create: `README.md`（仓库根，替换现有内容中的"如何运行"一节；若无则新建）
- Test: `packages/cli/test/cli.docker.test.ts`

**Interfaces:**
- Consumes: Task 13 的 `TetherClient`。
- Produces（服务地址取 `TETHER_URL`，默认 `http://127.0.0.1:7420`；`TETHER_TOKEN` 同服务端）：

```text
tether agent create --file <agent.json>        打印 agent id 与 version
tether agent list
tether session create <agentId> [--version N] [--var KEY=VALUE]...
tether send <sessionId> <text> [--follow]       --follow：流式打印文本增量与工具开始/结束，run_end 后退出，退出码 0；unanswered 时退出码 1
tether sandbox <sessionId>
```

  输出默认是人读的文本；`--json` 时每个命令打印 API 返回的 `data`。

- [ ] **Step 1: 写失败的测试**

服务端子进程跑 `packages/server/test/fixtures/run-tether.ts`（Task 10），faux 剧本：`bash "printf %s \"$NAME\" > who.txt && cat who.txt"` → 回答。

```ts
it("creates an agent from a file, opens a session with a variable, and follows a run", ...)
// agent.json 的 setup: ["touch ready"]，variables: ["NAME"]；session --var NAME=tether
// send --follow 的输出包含 bash 的开始与结束和最终回答；退出码 0
// tether sandbox 显示 running；docker exec 读 /workspace/who.txt 为 "tether"，/workspace/ready 存在
it("prints the API error code and exits 1 for an unknown session", ...)
```

- [ ] **Step 2: 运行，确认失败；实现；运行至通过**

- [ ] **Step 3: 写 README 的"运行"一节**

内容：前置条件（Linux、Docker、Node ≥ 22.19）；`npm install`；构建沙箱镜像 `node packages/server/src/main.ts --build-sandbox`（在 `main.ts` 里加这个参数，调用 Task 5 的 `buildSandboxImage`）；启动服务；用 CLI 走一遍上面的测试流程；环境变量表（Task 10 的 `Config`）；当前限制（M1 未做的能力，照本计划"本里程碑不做"一节）。只写实际验证过的命令。

- [ ] **Step 4: 全量验证**

Run: `npm test && npm run typecheck`
Expected: 全部 PASS。测试机上没有残留的 `tether.managed=1` 容器。

- [ ] **Step 5: 提交**

```bash
git add packages/cli README.md packages/server/src/main.ts
git commit -m "feat(cli): 命令行客户端与 M1 端到端验收"
```

# M3 检查点与分叉 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让沙箱的文件能跟着对话回到过去：每轮开始前给工作区存一张档，并与这一轮的用户条目对齐；会话可以在任意条目处分叉，新会话的工作区取自对应的存档；容器丢失时从最近的存档恢复；闲置超过 `destroyAfter` 的沙箱先存最终档再删除。存档不一致、找不到或被清理时，一律写模型可见的说明。

**Architecture:** 规则全部在 `core`：新的 `CheckpointService` 决定何时存档、对齐到哪个条目、分叉和恢复时取哪张存档、怎么清理；`SandboxService` 的创建路径多一个"从存档创建"的分支。后端只提供能力：`SandboxProvider` 增加 `snapshot`、`deleteSnapshot`、`listSnapshots`、`storage`，`create` 可以带 `from`。Docker 后端的工作区从"宿主目录"改为"每会话一个 XFS 镜像文件"（宿主盘支持 reflink 时）：镜像由一次性特权容器接成 loop 设备，Docker 的 local 卷挂成 `/workspace`；存档就是暂停容器、`sync`、`cp --reflink` 克隆镜像文件。宿主盘不支持 reflink 时退回目录工作区加 `rsync --link-dest`。引擎适配器用 pi 的 `beforeRequest` 钩子在每轮第一次请求模型前回调 core，用 `Conversation.fork` 分叉。

**Tech Stack:** 与 M2 相同：Node ≥ 22.19、TypeScript 7（`tsc --noEmit`）、Vitest 5、`typebox` 1.3.27、`node:sqlite`、Hono、pi 四个包 1.3.0、Docker 29、gVisor（测试机）；宿主工具：`mkfs.xfs`（xfsprogs 6.6）、`cp --reflink`、`sync`、`rsync`（只在目录模式）。

**Spec:** `docs/superpowers/specs/2026-10-20-tether-design.md`（M3 定义在 §10；相关设计在 §4.2、§4.5、§5.3、§8.3、§8.4、§8.5）。决定依据：`docs/adr/ADR-006-checkpoint-workspace-mount-reflink.md`、`docs/m0-findings.md` 第 6、7 节；本计划写作前在测试机上的两次实测（见"设计决定"第 1 条），脚本留在作者的 scratchpad，结论写进 Task 11 的 ADR-011。

## Global Constraints

- M1、M2 计划的 Global Constraints 全部继续有效（精确版本、pi 类型只在适配器和组装根、`core` 只依赖 `typebox`、信封与错误码、容器标签、PID 1 是 `sleep`、epoch 只经 `nextEpoch`、测试在 `tether-m0` 上跑、faux 模型、约定式提交与中文描述）。
- 任何让环境与对话不一致的变化（从存档恢复、分叉到较早的存档、找不到存档按模板新建）都写一条**模型可见**的条目，文本固定为 Task 5 的 `NOTES` 新增项（spec §8.4 "永远不假装环境还是原来的样子"）。
- 存档**每轮都留**（作者的决定，替换 spec §8.3 的"每个会话保留最近 N 个"）：只有宿主盘空闲空间低于下限时才稀疏化（Task 9）；被某个未归档会话的 `forkedFrom.checkpointId` 引用的存档永不删除。
- 一轮的标识是触发它的提交 ID（`LiveDoc.run.inputs[0]`），不是 `run.taskId`（m0-findings §7）。同一个提交最多一张存档。
- Tether 进程以普通用户运行，不加 sudo。需要特权的只有 `losetup`，经 `docker run --rm --privileged` 的一次性容器执行（`tether` 在 docker 组里，本来就等同 root，不扩大权限）。
- 不改测试机的 sshd 和防火墙，不开端口（作者的约束）。

## 本里程碑不做

- 工具审批（spec §6.4）：拆成单独一份计划，排在 M3 之后、M4 之前（作者的决定）。`UNSUPPORTED` 里的 `approval` 继续为 true。
- 手动钉住存档（作者的决定：有了每轮存档和空间下限，暂不需要）。
- 内存快照、原地回滚：Docker 做不到，`capabilities.rollback`、`preservesMemoryOnStop` 仍为 false，说明里写明进程不保留。
- `/workspace` 之外的容器层改动（`apt`、`/tmp`、`~` 下的文件）不进存档；说明文本写明"只有 /workspace 被还原"。把家目录放进镜像留作以后（需要改沙箱镜像的 `HOME`，和模板镜像的约定一起考虑）。

## 设计决定（本计划新增）

1. **工作区改为每会话一个 XFS 镜像文件。** 实测（测试机，XFS 测试盘挂在 ext4 上的 loop 设备）：目录 `cp -a --reflink` 的耗时与文件数成正比，5 万个小文件每张 4 s、每张约 27 MiB 元数据，20 万个 20 s；镜像文件 `FICLONE` 每张约 0.3 s（含冻结），删除 4 ms，恢复不到 0.9 s，只为改动的块占空间。完整链路实测：`tether` 用户 `mkfs.xfs -p <protofile>`（根目录属主设为沙箱用户）、一次性特权容器 `losetup --find --show`（约 0.4 s）、`docker volume create --driver local --opt type=xfs --opt device=/dev/loopN --opt o=nouuid`、`-v <卷>:/workspace:nocopy`（不加 `nocopy` 时 Docker 把镜像里 `/workspace` 的 root 属主复制进空卷）；后台进程每 10 ms 写文件时，暂停 + `sync` + 克隆 + 恢复共 262 ms，恢复出的内容恰好是暂停那一刻的；镜像大小就是磁盘上限。
2. **镜像大小就是 `diskMb`。** 不填时用 `TETHER_DEFAULT_DISK_MB`（默认 10240）。镜像是稀疏文件，不预占空间。镜像模式下 `diskMb` 从 `Unsupported` 里放开，目录模式下仍拒绝。
3. **工作区存储两种模式，启动时自动选择。** `TETHER_WORKSPACE_STORAGE=auto|image|directory`，默认 `auto`：在 `workspaceRoot` 上试一次 `cp --reflink=always`，成功用 `image`，失败用 `directory` 并打一条警告。显式 `image` 而探测失败时启动报错。
4. **存档放在 `<dataDir>/checkpoints/<sessionId>/<snapshotId>.img`（目录模式是同名目录）。** 必须和 `workspaceRoot` 在同一个文件系统上（reflink 不跨文件系统），启动时一起探测。不放在会话工作区目录里，因为丢失重建会先 `destroy` 旧沙箱。存档先写 `<id>.tmp` 再改名，`.tmp` 由启动对账删除。
5. **存档失败不阻塞对话。** 钩子里存档出错时记日志，写一条客户端可见的 `tether.checkpoint` 条目（`data.error`），这一轮照常运行。以后在这一轮分叉，会按"较早的存档"规则降级并写说明。
6. **不在没有沙箱时存档。** 一轮开始时会话还没有绑定（纯聊天，或分叉后还没调用过工具），工作区就是模板本身或分叉指定的那张存档，不需要再存。策略为 `none` 时也不存。
7. **分叉时就定下用哪张存档，记在新会话的 `forkedFrom`。** `forkedFrom: { sessionId, entryId, checkpointId: string | null }`。沙箱仍是懒创建：第一次工具调用时按 `checkpointId` 从存档创建，**不再执行 setup**（存档里已经有 setup 的结果）。模型可见的说明在分叉时写入新会话。
8. **查找存档沿分叉链向上。** 在会话 S 的条目 E 处找存档：S 自己 `entryId ≤ E` 的最新一张；没有就到 `S.forkedFrom.sessionId`，`E' = min(E, S.forkedFrom.entryId)`，重复。依据是 pi 的条目 ID 在整个存储里全局递增（`durableMetadata.next_id`），分叉后的新条目 ID 一定大于分叉点；Task 1 用测试钉住这个前提。
9. **"引用"代替"永久保留"标记。** 一张存档能不能删，看有没有未归档会话的 `forkedFrom.checkpointId` 指向它，不另设 `pinned` 字段。闲置删除前的最终存档是这个会话最新的一张，稀疏化总保留每个会话最新的 5 张，不需要特殊标记。
10. **闲置删除后绑定为 `lost`，原因持久化。** 绑定增加 `reason` 字段（`TEXT NULL`），取代内存里的 `#lostReasons`（M2 重启后原因丢失、缺省为 "missing" 的问题一并解决）。状态表不改。
11. **说明里列出没有发生的操作。** 存档早于目标条目时，从新会话的记录里读出 `(C.entryId, E]` 之间的工具调用，只列 `write`、`edit`、`bash`（`read` 没有副作用），每条截到 200 字符，最多 20 条，多出的写"以及另外 N 条"。不重放（spec §8.3）。
12. **启动时 loop 设备和卷要重新对上。** 宿主重启后 loop 设备全部消失，卷里记着的 `/dev/loopN` 可能已经接到别的会话的镜像上。`start` 前先读 `/sys/block/<loopN>/loop/backing_file`（普通用户可读），不是本会话的镜像就删掉容器和卷、重新接 loop、按同一个镜像重建容器，数据不丢（只丢容器层，和停止时进程丢失属于同一类，说明文本不变）。

## M2 暂缓问题的处理

来自 PR #3 描述里的暂缓清单：

- 在本计划里处理：拉取新模板镜像在准入锁内（Task 10：锁外先 `docker pull`）；docker 调用没有超时（Task 10：`docker()` 加默认超时，快照、loop 相关调用同样受限）；cleanup failed 的 lost 容器不计入准入（Task 10）；`#stoppedNote` 无条件把会话改成 idle（Task 8 顺手改为只在没有运行时改，闲置删除复用这段）。
- 继续推迟：秒级 `stopAfter` 的分钟数不准；巡检逐会话等锁；setup 不能被 abort/archive 取消；运行中容器消失到下次巡检前工具调用都失败；测试缺口（`--pid host` 只测宿主侧、CLI 归档用例依赖顺序）；从 M1 升级时旧容器没有 `fence.sh`（没有 M1 部署）。
- M1 推迟的非沙箱项（缺 API key 时 unanswered 无原因、SDK 1011 无限重连、引擎会话创建失败的会话一直 active、非回环地址无 token 不告警、openPiEngine 抛错不关存储、setup 输出截尾前无上限、CLI 读坏文件打印堆栈、WebSocket 无背压、waitSubmission 不校验会话、SDK 回调抛错成未捕获异常、长轮询无超时）：继续推迟，和本里程碑无关。

## Review Focus

1. **存档时沙箱里有后台进程在不停写文件。** 存档是暂停那一刻的一致状态：暂停前写下的都在，之后写的都不在，同一个进程写的两个文件不会一新一旧。Task 4 测试。
2. **宿主重启后 `/dev/loopN` 接到了另一个会话的镜像上。** `start` 发现 `backing_file` 不是本会话的镜像，重新接 loop 并重建容器；绝不能把别的会话的工作区挂进来。Task 3 测试（用 `losetup -d` 加接另一个镜像到同一编号来模拟）。
3. **存档进行到一半服务崩溃，重启后同一轮的钩子再次触发。** 不会出现第二张存档，也不会留下 `.tmp`；数据库里没有记录的存档文件被启动对账删除。Task 5、Task 9 测试。
4. **在分叉出来的会话里、对一个继承来的条目（早于它自己的分叉点）再分叉。** 查找沿分叉链走到上一级会话，取到 `≤ E` 的那张，而不是第一次分叉用的那张。Task 6 测试。
5. **agent 把工作区写满（`diskMb`）。** 工具调用得到"空间不足"的错误，宿主盘和其他会话不受影响，满盘的工作区照样能存档和恢复。Task 3、Task 4 测试。

---

## 文件结构

```text
packages/core/src/
  model.ts                    Task 2、6、7  SessionRecord.forkedFrom、SandboxBinding.reason、CheckpointRecord
  ports.ts                    Task 1–4、9  AgentEngine.fork/submissionEntry；AppStore 存档方法；SandboxProvider 快照能力
  notes.ts                    Task 5  NOTES 新增 restored、forked、forkFresh；SandboxNote.kind 加 tether.checkpoint
  validate.ts                 Task 3、5  UNSUPPORTED_IN_M3；diskMb 按存储模式决定
  checkpoints.ts              Task 6  新建：沿分叉链查找存档 findCheckpoint()、列出没发生的操作 missedCalls()
  services/checkpoints.ts     Task 5、8、9  新建：CheckpointService（存档、清理、稀疏化）
  services/sandboxes.ts       Task 6–8、10  从存档创建、丢失恢复、闲置删除、锁外拉镜像
  services/sessions.ts        Task 6、9  fork、归档时清理存档；attachEngine 支持分叉
  startup.ts                  Task 9  对账存档文件与 loop 设备
packages/testkit/src/
  app-store.ts、memory-app-store.ts   Task 2
  agent-engine.ts             Task 1
  sandbox-provider.ts         Task 4
packages/server/
  src/adapters/engine-pi/     Task 1  fork、submissionEntry、onRunStart 钩子
  src/adapters/store-sqlite/  Task 2  SCHEMA_VERSION 2 与迁移
  src/adapters/sandbox-docker/
    index.ts                  Task 3、4、10
    workspace-image.ts        Task 3、4  新建：镜像模式（mkfs、loop、卷、克隆）
    workspace-directory.ts    Task 3、4  新建：目录模式（M2 的做法搬出来，加 rsync 存档）
    docker-cli.ts             Task 10  超时
  src/config.ts               Task 3、8、9
  src/app.ts                  Task 5、6、8、9
  src/http/routes.ts          Task 6
packages/sdk/src/client.ts    Task 6
packages/cli/src/commands.ts  Task 6
docs/adr/ADR-011-workspace-images-and-checkpoints.md   Task 11
```

---

### Task 1: 引擎的分叉、提交条目和"一轮开始"钩子

**Files:**
- Modify: `packages/core/src/ports.ts`、`packages/server/src/adapters/engine-pi/index.ts`、`packages/testkit/src/agent-engine.ts`
- Test: `packages/testkit/src/agent-engine.ts`（pi 适配器跑同一套）、`packages/server/test/engine-pi.test.ts`

**Interfaces:**
- Produces（`AgentEngine` 新增）：
  - `fork(engineSessionId: string, entryId: string): Promise<string>`：在条目处分叉，返回新引擎会话 ID。条目不属于这个会话（ID 非法、不存在）时 `invalid_request`。
  - `submissionEntry(submissionId: string): Promise<string | undefined>`：提交放进对话的那条用户条目的 ID，还没放进去时 `undefined`；未知提交 `not_found`。
- Produces（`PiEngineOptions` 新增）：`onRunStart?: (engineSessionId: string, submissionId: string) => Promise<void>`。适配器注册一个扩展，`hook(GenerationTask, { beforeRequest })` 里读 `api.snapshot(LiveDoc, api.conversationId, ctx)?.run?.inputs[0]`，有值就 `await onRunStart(...)`，返回 `undefined`。**每次请求都调用**，去重交给 core（键是提交 ID，查存储很便宜）；`onRunStart` 抛错时适配器不吞掉之外的任何东西，只交给 `onError` 并继续（设计决定 5）。

- [ ] **Step 1: 在 `registerAgentEngineConformance` 里写失败的用例**

```ts
it("forks at an entry: the fork sees entries up to it and none after", ...)          // 两轮后在第一轮的用户条目分叉，fork 的 transcript 里没有第二轮
it("gives entries written after a fork ids greater than the fork point", ...)        // 设计决定 8 的前提
it("keeps the parent unchanged when the fork gets new entries", ...)
it("rejects a fork at an entry that does not exist with invalid_request", ...)
it("returns the user entry of a submission once it is placed", ...)               // 等提交结束后 submissionEntry 等于 transcript 里那条用户条目
```

`engine-pi.test.ts`（只测 pi 适配器）：

```ts
it("calls onRunStart before every model request with the submission that started the run", ...) // 一轮两次请求、第二轮一次：调用参数依次是 [s1, s1, s2]
it("keeps inputs[0] as the first submission when a steer input joins the run", ...)              // m0-findings §7 的缺口；steer 的那次请求参数仍是 s1
it("reports an onRunStart failure through onError and still answers", ...)
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm run test:unit -- packages/server/test/engine-pi.test.ts packages/testkit`
Expected: FAIL（`fork is not a function` 等）

- [ ] **Step 3: 实现。** `fork` 用 `conversation.fork(at, { ownership: { kind: "ownerless" } }, context)`；`submissionEntry` 读 `harness.submission(id)` 的状态里 `entry` 字段（`placed`/`done` 时才有）。core 的测试替身（`packages/core/test/fakes.ts` 的 FakeEngine）实现同样的语义：条目 ID 用一个全局计数器。

- [ ] **Step 4: 运行，确认通过**

Run: `npm run test:unit && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交** `feat: 引擎支持分叉、提交条目查询和每轮开始的钩子`

---

### Task 2: 存档记录、分叉来源与丢失原因（AppStore）

**Files:**
- Modify: `packages/core/src/model.ts`、`packages/core/src/ports.ts`、`packages/testkit/src/app-store.ts`、`packages/testkit/src/memory-app-store.ts`、`packages/server/src/adapters/store-sqlite/{schema,index}.ts`
- Test: `packages/testkit/src/app-store.ts`、`packages/server/test/store-sqlite.test.ts`

**Interfaces:**
- Produces:
  - `interface CheckpointRecord { id: string; sessionId: string; submissionId: string; entryId: string; snapshotId: string; kind: "filesystem"; createdAt: string }`
  - `SessionRecord.forkedFrom: { sessionId: string; entryId: string; checkpointId: string | null } | null`
  - `SandboxBinding.reason?: string`；`BindingPatch` 加入 `reason`（写 `null` 清除）。
  - `AppStore` 新增：`addCheckpoint(c: CheckpointRecord): Promise<void>`（同一 `submissionId` 已有时 `conflict`）；`getCheckpoint(id)`；`checkpointForSubmission(submissionId): Promise<CheckpointRecord | undefined>`；`listCheckpoints(sessionId): Promise<CheckpointRecord[]>`（按 `entryId` 数值升序）；`deleteCheckpoint(id)`；`listAllCheckpoints(): Promise<CheckpointRecord[]>`；`checkpointReferenced(id): Promise<boolean>`（有未归档会话的 `forkedFrom.checkpointId` 等于它）。
  - `Ids.next` 的前缀加 `"cp"`。
- SQLite：`SCHEMA_VERSION = 2`。迁移 1→2：`CREATE TABLE checkpoints (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, submission_id TEXT NOT NULL UNIQUE, entry_id INTEGER NOT NULL, snapshot_id TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL)`、`CREATE INDEX checkpoints_by_session ON checkpoints (session_id, entry_id)`、`ALTER TABLE sandbox_bindings ADD COLUMN reason TEXT`。`forked_from` 已有，存 JSON。`entry_id` 用 INTEGER 存，比较按数值（字符串比较会把 "10" 排在 "9" 前面）。

- [ ] **Step 1: 写失败的用例**（`registerAppStoreConformance`）

```ts
it("stores a checkpoint and finds it by submission", ...)
it("rejects a second checkpoint for the same submission with conflict", ...)
it("lists a session's checkpoints in numeric entry order", ...)          // entryId "9" 在 "10" 前面
it("round-trips forkedFrom on a session", ...)
it("reports a checkpoint referenced only while the referencing session is not archived", ...)
it("sets and clears the binding reason without touching the epoch", ...)
```

`store-sqlite.test.ts`：`it("migrates a version 1 database to version 2 keeping its rows", ...)`（用 SCHEMA_V1 建库、写一行会话和绑定，再用新代码打开）。

- [ ] **Step 2: 运行，确认失败**

Run: `npm run test:unit -- packages/testkit packages/server/test/store-sqlite.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现内存版、SQLite 版和迁移。** 迁移在一个事务里按版本号逐步执行，末尾写 `user_version`；数据库版本比代码新时报错（沿用现有的检查）。

- [ ] **Step 4: 运行全部单元测试和类型检查**

Run: `npm run test:unit && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交** `feat: 存档记录、分叉来源与持久化的丢失原因`

---

### Task 3: Docker 工作区改为镜像文件（含目录模式退路）

**Files:**
- Create: `packages/server/src/adapters/sandbox-docker/workspace-image.ts`、`workspace-directory.ts`
- Modify: `packages/server/src/adapters/sandbox-docker/index.ts`、`packages/server/src/config.ts`、`packages/server/src/app.ts`、`packages/core/src/validate.ts`
- Test: `packages/server/test/sandbox-docker.docker.test.ts`、`packages/server/test/config.test.ts`

**Interfaces:**
- 适配器内部（不进 core）：

```ts
interface WorkspaceStorage {
  readonly mode: "image" | "directory";
  /** 建好工作区，返回 docker run 里挂 /workspace 的参数。from 是存档路径时从它克隆。 */
  prepare(sessionId: string, diskMb: number, from?: string): Promise<string[]>;
  /** 容器 start 之前调用；返回 false 表示挂载参数已失效（loop 对不上），调用方要重建容器。 */
  beforeStart(sessionId: string): Promise<boolean>;
  remove(sessionId: string): Promise<void>;
}
```

- `DockerSandboxOptions` 新增 `storage: "image" | "directory"`、`checkpointRoot: string`、`defaultDiskMb: number`。
- 新增 `export async function probeWorkspaceStorage(workspaceRoot: string, checkpointRoot: string): Promise<"image" | "directory">`：在两个目录之间试 `cp --reflink=always` 一个小文件。
- `Config` 新增 `workspaceStorage: "auto" | "image" | "directory"`（`TETHER_WORKSPACE_STORAGE`）、`checkpointRoot`（`<dataDir>/checkpoints`）、`defaultDiskMb`（`TETHER_DEFAULT_DISK_MB`，默认 10240，正整数）。
- `validate.ts`：`UNSUPPORTED_IN_M2` 改名 `UNSUPPORTED_IN_M3 = { diskMb: false, approval: true, checkpoints: false }`；组装层在目录模式下传 `{ ...UNSUPPORTED_IN_M3, diskMb: true }`。

镜像模式的固定做法（设计决定 1、12）：
- 文件：`<workspaceRoot>/<sessionId>/disk.img`；`mkfs.xfs -q -m reflink=1 -p <protofile>`，protofile 内容 `"/dev/null\n0 0\nd--755 <uid> <gid>\n$\n"`。
- loop：`docker run --rm --privileged --network none -v /dev:/dev -v <dir>:<dir> <defaultImage> losetup --find --show <disk.img>`；已经接上的（扫描 `/sys/block/loop*/loop/backing_file` 等于 `disk.img` 的真实路径）直接复用。
- 卷：名字 `tether-<sessionId>`，`docker volume create --driver local --label tether.managed=1 --opt type=xfs --opt device=<loop> --opt o=nouuid`；容器参数 `--volume tether-<sessionId>:/workspace:nocopy`。
- `beforeStart`：卷的 `device` 选项（`docker volume inspect`）对应的 `backing_file` 不是本会话的 `disk.img` 时返回 false；`start` 收到 false 就 `docker rm -f` 容器、删卷、重新 `prepare`（不带 `from`，镜像已在）、按原参数 `docker run`。
- `remove`：删卷、`losetup -d`（同样经一次性容器）、删目录。
- 目录模式：M2 现有代码原样搬进 `workspace-directory.ts`（`removeWorkspace` 的一次性 root 容器也在这里）。

- [ ] **Step 1: 写失败的用例**（`sandbox-docker.docker.test.ts`，镜像模式；`fixtures` 里按 `TETHER_TEST_WORKSPACE_ROOT` 指到 XFS 盘，默认 `/data/tether-xfs/test`）

```ts
it("mounts an XFS image of diskMb at /workspace owned by the sandbox user", ...)   // df 显示约 diskMb；容器里能写
it("refuses writes past diskMb without touching the host disk", ...)               // dd 3 倍大小 → 失败；宿主空闲空间变化 < diskMb
it("keeps files across stop and start", ...)
it("re-attaches the image when the loop device was taken by another image", ...)   // Review Focus 2：stop；经特权容器 losetup -d 原设备，再把另一个镜像接到同一编号；start 后读到的是自己的文件
it("removes the volume, the loop device and the image on destroy", ...)
```

`config.test.ts`：`TETHER_WORKSPACE_STORAGE` 只接受三个值；`TETHER_DEFAULT_DISK_MB` 必须是正整数；`checkpointRoot` 在 `dataDir` 下。
目录模式：已有的 `sandbox-docker.docker.test.ts` 用例用 `describe.each(["image", "directory"])` 各跑一遍（目录模式的工作区根在 ext4 的临时目录）。

- [ ] **Step 2: 运行，确认失败**

Run（测试机）: `npm run test:docker -- packages/server/test/sandbox-docker.docker.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现两种存储和探测；`app.ts` 按探测结果选模式，显式 `image` 但探测失败时启动报 `invalid_request`（消息写明需要支持 reflink 的文件系统，例如 XFS `reflink=1`）。**

- [ ] **Step 4: 运行 Docker 测试和单元测试**

Run: `npm run test:docker && npm run test:unit && npm run typecheck`
Expected: PASS（`--pid host` 等 M2 用例两种模式都通过）

- [ ] **Step 5: 提交** `feat: 沙箱工作区改为每会话一个 XFS 镜像，宿主不支持 reflink 时退回目录`

---

### Task 4: 后端的快照能力

**Files:**
- Modify: `packages/core/src/ports.ts`、`packages/server/src/adapters/sandbox-docker/{index,workspace-image,workspace-directory}.ts`、`packages/testkit/src/sandbox-provider.ts`
- Test: `packages/testkit/src/sandbox-provider.ts`、`packages/server/test/sandbox-docker.docker.test.ts`

**Interfaces:**
- Produces（`SandboxProvider`）：
  - `capabilities.snapshot: true`（Docker 两种模式都是 true）。
  - `SandboxCreate` 加 `from?: string`（`snapshotId`）。
  - `snapshot(sandboxId: string): Promise<{ snapshotId: string }>`：运行中的先 `docker pause`、`sync`、克隆、`docker unpause`（`finally` 里恢复）；停止的直接克隆。`snapshotId` 形如 `<sessionId>/<随机 16 位十六进制>`，文件 `<checkpointRoot>/<snapshotId>.img`（目录模式是目录），先写 `.tmp` 再改名。沙箱不存在时 `sandbox_failed`。
  - `deleteSnapshot(snapshotId: string): Promise<void>`：不存在不报错。`snapshotId` 不匹配 `^[A-Za-z0-9_-]+/[0-9a-f]{16}$` 时 `invalid_request`（它会拼进路径）。
  - `listSnapshots(): Promise<{ snapshotId: string; partial: boolean }[]>`：`partial` 是 `.tmp`。
  - `storage(): Promise<{ freeBytes: number; totalBytes: number }>`：`checkpointRoot` 所在文件系统，用 `fs.statfs`。
- 目录模式的快照：`rsync -a --delete --link-dest=<上一张> <workspace>/ <tmp>/`（没有上一张就不带 `--link-dest`），恢复用 `cp -a`（不能用硬链接，否则改工作区会改到存档）。

- [ ] **Step 1: 写失败的用例**

`registerSandboxProviderConformance` 新增（只依赖 provider 自己的方法）：

```ts
it("snapshots a running sandbox and keeps it running", ...)
it("snapshots a stopped sandbox", ...)
it("creates a running sandbox from a snapshot", ...)
it("lists snapshots and deletes one; deleting a missing one does not throw", ...)
it("rejects a snapshot id that is not of the documented form with invalid_request", ...) // "../x"
it("reports free and total bytes of the checkpoint filesystem", ...)
```

`sandbox-docker.docker.test.ts`（经 `docker exec` 看文件，两种模式各一遍）：

```ts
it("restores the files as of the snapshot, not later changes", ...)
it("takes a point-in-time snapshot while a background process keeps writing", ...) // Review Focus 1：进程交替写 a、b 两个计数器文件，恢复后 a == b
it("keeps the source and the restored sandbox independent", ...)
it("snapshots and restores a workspace that is full", ...)                         // Review Focus 5
it("keeps the snapshot after the source sandbox is destroyed", ...)
```

- [ ] **Step 2: 运行，确认失败**

Run（测试机）: `npm run test:docker -- packages/server/test/sandbox-docker.docker.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现。** `create({ from })` 镜像模式是 `cp --reflink=always <快照> <disk.img>` 后走普通 `prepare`；`docker run` 失败时的清理（M2 的做法）同样删掉克隆出来的镜像。

- [ ] **Step 4: 运行 Docker 测试和单元测试**

Run: `npm run test:docker && npm run test:unit && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交** `feat: Docker 后端的快照、从快照创建与存档清单`

---

### Task 5: 每轮存档（CheckpointService）

**Files:**
- Create: `packages/core/src/services/checkpoints.ts`
- Modify: `packages/core/src/notes.ts`、`packages/core/src/index.ts`、`packages/core/src/services/sandboxes.ts`（暴露 `snapshot(sessionId)`，在会话锁里）、`packages/server/src/app.ts`
- Test: `packages/core/test/checkpoints.test.ts`、`packages/server/test/app.docker.test.ts`

**Interfaces:**
- Consumes：Task 1 的 `onRunStart`、`submissionEntry`；Task 2 的存档方法；Task 4 的 `snapshot`。
- Produces：
  - `SandboxService.snapshot(sessionId: string): Promise<{ snapshotId: string } | undefined>`：会话锁内；绑定是 `running` 或 `stopped` 才存，否则 `undefined`。不刷新 `lastUsedAt`。
  - `class CheckpointService`，构造依赖 `{ store, sandboxes: Pick<SandboxService, "snapshot">, provider: Pick<SandboxProvider, "deleteSnapshot" | "listSnapshots" | "storage">, engine: Pick<AgentEngine, "submissionEntry">, clock, ids, record, log }`。
  - `onRunStart(sessionId: string, submissionId: string): Promise<void>`：已有该提交的存档 → 返回；会话版本的 `checkpointPolicy` 是 `none` → 返回；`sandboxes.snapshot` 返回 `undefined` → 返回；`submissionEntry` 为 `undefined`（理论上不会，钩子触发时输入已放进对话）→ 删掉刚存的快照、记日志、返回；否则 `addCheckpoint` 并写客户端可见条目 `{ kind: "tether.checkpoint", data: { checkpointId, entryId, durationMs } }`（`durationMs` 是存档耗时，spec §8.3 要求采集，M4 的指标从这里取）。`addCheckpoint` 报 `conflict`（并发的同一轮）时删掉自己的快照。任何错误：记日志，写 `{ kind: "tether.checkpoint", data: { submissionId, error } }`，不抛出（设计决定 5）。
  - `SandboxNote.kind` 加 `"tether.checkpoint"`。
- 组装：`openPiEngine({ onRunStart: async (engineSessionId, submissionId) => { const s = await store.getSessionByEngineId(engineSessionId); if (s) await checkpoints.onRunStart(s.id, submissionId); } })`；`AgentService` 用 `UNSUPPORTED_IN_M3`。

- [ ] **Step 1: 写失败的用例**（`checkpoints.test.ts`，用 `fakes.ts` 的替身）

```ts
it("takes one checkpoint per submission and aligns it to the submission's user entry", ...)
it("does nothing on a second call for the same submission", ...)          // Review Focus 3 的一半
it("skips sessions without a sandbox and versions with checkpointPolicy none", ...)
it("deletes its own snapshot when a concurrent call already recorded the round", ...)
it("records a client-only entry and does not throw when the snapshot fails", ...)
```

`app.docker.test.ts`（faux 模型，perRun）：`it("checkpoints each round after the first tool call created the sandbox", ...)`：第一轮调用 `write`，第二、三轮各一次；`listCheckpoints` 有 2 张（第一轮开始时还没有沙箱），`entryId` 分别等于第二、三轮的用户条目。

- [ ] **Step 2: 运行，确认失败**

Run: `npm run test:unit -- packages/core/test/checkpoints.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现并接线。**

- [ ] **Step 4: 运行**

Run: `npm run test:unit && npm run typecheck`，测试机 `npm run test:docker -- packages/server/test/app.docker.test.ts`
Expected: PASS

- [ ] **Step 5: 提交** `feat: 每轮开始前存档并对齐到这一轮的用户条目`

---

### Task 6: 分叉

**Files:**
- Create: `packages/core/src/checkpoints.ts`
- Modify: `packages/core/src/notes.ts`、`packages/core/src/services/{sessions,sandboxes}.ts`、`packages/core/src/startup.ts`（修复半成品时分叉会话走 `engine.fork`）、`packages/server/src/http/routes.ts`、`packages/sdk/src/client.ts`、`packages/cli/src/commands.ts`
- Test: `packages/core/test/checkpoints-lookup.test.ts`、`packages/core/test/sessions.test.ts`、`packages/core/test/sandboxes.test.ts`、`packages/server/test/app.docker.test.ts`、`packages/cli/test/cli.docker.test.ts`

**Interfaces:**
- Produces：
  - `findCheckpoint(store: AppStore, sessionId: string, atEntryId: string | undefined): Promise<CheckpointRecord | undefined>`：设计决定 8 的算法，`undefined` 表示"最新"。
  - `missedCalls(entries: TranscriptEntry[], afterEntryId: string, uptoEntryId: string | undefined): string[]`：设计决定 11 的格式，`bash: <command>`、`write: <path>`、`edit: <path>`。
  - `NOTES.forked(missed: string[])`、`NOTES.forkFresh`（文本见下）。
  - `SessionService.fork(id: string, entryId: string): Promise<SessionRecord>`：源会话已归档 → `conflict`；`findCheckpoint(源, entryId)` 得到 C；写新会话记录（`forkedFrom: { sessionId, entryId, checkpointId: C?.id ?? null }`，同版本、同变量，`engineSessionId: null`），`engine.fork` 后回填；写模型可见的说明：C 为空 → `NOTES.forkFresh`；否则 `NOTES.forked(missedCalls(新会话的记录, C.entryId, entryId))`。
  - `SandboxService` 的创建路径：会话没有绑定、`forkedFrom?.checkpointId` 非空、存档还在 → `provider.create({ sessionId, spec, from: snapshotId })`，跳过 setup，`creating → running`；存档已不在（被清理）→ 按模板创建并写 `NOTES.forkFresh`。
  - HTTP：`POST /v1/sessions/:id/fork`，body `{ entryId: string }`，返回 `{ session }`；`GET /v1/sessions/:id/checkpoints` 返回 `{ items: CheckpointRecord[] }`。SDK：`sessions.fork(id, entryId)`、`sessions.checkpoints(id)`。CLI：`tether session fork <id> <entryId>`、`tether checkpoints <id>`。

说明文本（固定）：

```ts
forked: (missed: string[]) =>
  `This session was forked from another session. /workspace was restored from a checkpoint; processes from the original session are not running, and only /workspace was restored.` +
  (missed.length === 0 ? "" : ` These operations ran after that checkpoint and did not happen in this workspace:\n${missed.map((m) => `- ${m}`).join("\n")}`),
forkFresh:
  "This session was forked from another session, but no checkpoint of its workspace was available. /workspace is a fresh sandbox from the template; files from the original session are not here.",
```

- [ ] **Step 1: 写失败的用例**

```ts
// checkpoints-lookup.test.ts
it("finds the latest checkpoint at or before the entry", ...)
it("compares entry ids as numbers", ...)
it("walks up to the parent with the fork point as the bound", ...)
it("finds the grandparent's checkpoint for a fork at an inherited entry", ...)   // Review Focus 4
it("lists only side-effecting calls after the checkpoint, truncated, with a remainder count", ...)
// sessions.test.ts
it("forks at an entry with an aligned checkpoint and tells the model nothing was missed", ...)
it("forks at an entry after the checkpoint and lists the calls that did not happen", ...)
it("forks without any checkpoint and tells the model the workspace is fresh", ...)
it("rejects forking an archived session with conflict", ...)
// sandboxes.test.ts
it("creates a forked session's sandbox from its checkpoint without running setup", ...)
it("falls back to the template and tells the model when the fork's checkpoint is gone", ...)
// startup.test.ts
it("repairs a half-created fork by forking the engine session, not creating a new one", ...)
```

`app.docker.test.ts`：`it("forks a session and the fork sees the files as of the fork point", ...)`：三轮各写一个文件 f1、f2、f3，在第三轮的用户条目分叉；fork 里有 f1、f2，没有 f3；原会话三个都在。`cli.docker.test.ts`：`tether session fork` 打印新会话 ID，`tether checkpoints` 列出存档。

- [ ] **Step 2: 运行，确认失败**

Run: `npm run test:unit -- packages/core`
Expected: FAIL

- [ ] **Step 3: 实现。** `missedCalls` 需要的记录用 `engine.transcript(新会话, { limit: 100, before })` 往前翻，翻到 `entryId ≤ C.entryId` 为止。

- [ ] **Step 4: 运行**

Run: `npm run test:unit && npm run typecheck`，测试机 `npm run test:docker`
Expected: PASS

- [ ] **Step 5: 提交** `feat: 会话分叉，工作区取自分叉点之前最近的存档`

---

### Task 7: 丢失后从存档恢复

**Files:**
- Modify: `packages/core/src/services/sandboxes.ts`、`packages/core/src/notes.ts`、`packages/core/src/startup.ts`
- Test: `packages/core/test/sandboxes.test.ts`、`packages/server/test/sandboxes.docker.test.ts`

**Interfaces:**
- Produces：
  - `#markLost(binding, event, reason)` 把原因写进 `binding.reason`（Task 2），删除 `#lostReasons`；重建成功后清除 `reason`。启动对账标记 lost 时也写 `reason: "missing"`。
  - 重建（`#create(sessionId, lost)`）：`findCheckpoint(store, sessionId, undefined)` 得到 C 且存档还在 → `provider.create({ from: C.snapshotId })`，跳过 setup，写 `NOTES.restored(reason, missedCalls(本会话记录, C.entryId, undefined))`；否则走 M2 的模板重建和 `NOTES.reset(reason)`。准入、锁顺序、失败时绑定留在 `lost` 的规则不变。
  - `NOTES.restored`：

```ts
restored: (reason: string, missed: string[]) =>
  `The previous sandbox was lost (${reason}). /workspace was restored from the latest checkpoint; processes started earlier are not running, and only /workspace was restored.` +
  (missed.length === 0 ? "" : ` These operations ran after that checkpoint and are not reflected in /workspace:\n${missed.map((m) => `- ${m}`).join("\n")}`),
```

- [ ] **Step 1: 写失败的用例**

```ts
it("rebuilds a lost sandbox from the latest checkpoint and lists the calls after it", ...)
it("rebuilds from the template when the session has no checkpoint", ...)        // M2 的行为不变
it("keeps the lost reason across a restart of the service", ...)               // 新建一个 SandboxService 实例，原因仍在说明里
it("leaves the binding lost when creating from the checkpoint fails", ...)
```

`sandboxes.docker.test.ts`：`it("restores files from the checkpoint after the container is removed outside Tether", ...)`。

- [ ] **Step 2: 运行，确认失败**

Run: `npm run test:unit -- packages/core/test/sandboxes.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现。**

- [ ] **Step 4: 运行**

Run: `npm run test:unit && npm run typecheck`，测试机 `npm run test:docker`
Expected: PASS

- [ ] **Step 5: 提交** `feat: 沙箱丢失后从最近的存档恢复，丢失原因持久化`

---

### Task 8: 闲置删除档

**Files:**
- Modify: `packages/core/src/services/sandboxes.ts`、`packages/core/src/services/checkpoints.ts`、`packages/server/src/config.ts`、`packages/server/src/app.ts`
- Test: `packages/core/test/sandboxes.test.ts`、`packages/server/test/config.test.ts`

**Interfaces:**
- Produces：
  - `SandboxServiceDeps.destroyAfterMs?: number`，默认 `DEFAULT_DESTROY_AFTER_MS = 7 * 24 * 60 * 60 * 1000`；`Config.destroyAfterMs`（`TETHER_DESTROY_AFTER_SECONDS`，默认 604800）。启动时 `destroyAfterMs <= stopAfterMs` 报 `invalid_request`。
  - `SandboxServiceDeps.finalCheckpoint?: (sessionId: string) => Promise<boolean>`，由组装层接到 `CheckpointService.final(sessionId)`：存一张存档，`submissionId` 为 `final:<sessionId>:<binding.createdAt>`（每个沙箱至多一张最终存档），`entryId` 取 `engine.transcript(…, { limit: 1 })` 的最新条目；策略 `none` 返回 false；失败返回 false 并记日志。
  - 巡检：`stopped` 且 `now - lastUsedAt ≥ destroyAfterMs` → `finalCheckpoint`（不论成功与否）→ `provider.destroy` → 绑定 `vanish` 为 `lost`，`reason: "removed after <days> days without activity"`，只写客户端条目（模型在恢复时从 `NOTES.restored` 得知）。`SweepResult` 加 `destroyedIdle`。
  - `#stoppedNote` 只在会话没有运行时改为 idle（M2 暂缓项）。

- [ ] **Step 1: 写失败的用例**

```ts
it("takes a final checkpoint and removes a sandbox stopped longer than destroyAfter", ...)
it("restores the removed sandbox from the final checkpoint on the next tool call", ...)
it("removes the sandbox even when the final checkpoint fails, and the rebuild uses an earlier one", ...)
it("does not remove a stopped sandbox younger than destroyAfter", ...)
it("does not mark a running session idle when its sandbox stops", ...)
```

`config.test.ts`：`TETHER_DESTROY_AFTER_SECONDS` 不大于 `TETHER_STOP_AFTER_SECONDS` 时报错。

- [ ] **Step 2: 运行，确认失败**

Run: `npm run test:unit -- packages/core/test/sandboxes.test.ts packages/server/test/config.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现。**

- [ ] **Step 4: 运行**

Run: `npm run test:unit && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交** `feat: 闲置超过 destroyAfter 时存最终档并删除沙箱`

---

### Task 9: 存档的清理与对账

**Files:**
- Modify: `packages/core/src/services/checkpoints.ts`、`packages/core/src/services/sessions.ts`、`packages/core/src/startup.ts`、`packages/core/src/sweeper.ts`（每轮巡检后调用稀疏化）、`packages/server/src/adapters/sandbox-docker/index.ts`（`listManaged` 之外列出受管的卷和 loop 设备）、`packages/server/src/config.ts`、`packages/server/src/app.ts`
- Test: `packages/core/test/checkpoints.test.ts`、`packages/core/test/startup.test.ts`、`packages/server/test/sandbox-docker.docker.test.ts`

**Interfaces:**
- Produces：
  - `CheckpointService.collect(sessionId: string): Promise<number>`：会话已归档时，删除它所有没被引用的存档（`checkpointReferenced`）；会话的 `forkedFrom` 指向的会话也已归档时，对那个会话递归调用一次（引用它的最后一个分叉归档后，存档才能删）。`SessionService.archive` 在销毁沙箱之后调用它。
  - `CheckpointService.thin(): Promise<number>`：`storage()` 的空闲比例低于 `minFreeRatio`（`TETHER_CHECKPOINT_MIN_FREE_PERCENT`，默认 10）时，按下面的顺序一张一张删，每删一张重新看一次空闲空间，回到下限以上就停：
    1. 候选：不被引用、不是所在会话最新 5 张的存档；
    2. 会话按 `lastActiveAt` 从旧到新；
    3. 同一会话里，先删序号（按 `entryId` 从旧到新，0 起）不是 10 的倍数的，再删其余的。
    每删一张记一条 `log.warn`，不写会话条目（之后在那里分叉或恢复时，`findCheckpoint` 找到更早的一张，说明会列出没发生的操作）。
  - 启动对账（`recover`，在引擎 `resume` 之前）：`listSnapshots()` 里 `partial` 的删除；没有对应 `CheckpointRecord` 的删除；记录里有、文件没有的删除记录并记日志。Docker 后端：卷名 `tether-*` 而没有对应容器的删除；`backing_file` 在 `workspaceRoot` 下而对应会话没有绑定的 loop 设备 `losetup -d`。`RecoverResult` 加 `removedSnapshots`。

- [ ] **Step 1: 写失败的用例**

```ts
it("deletes an archived session's checkpoints except the ones a live fork references", ...)
it("deletes the referenced checkpoint once the last referencing fork is archived", ...)
it("thins oldest sessions first, keeping each session's newest five and every tenth", ...)
it("stops thinning as soon as free space is above the floor", ...)
it("never thins a referenced checkpoint", ...)
// startup.test.ts
it("removes partial snapshots and snapshots without a record before resume", ...)   // Review Focus 3 的另一半
it("drops checkpoint records whose snapshot file is gone", ...)
```

`sandbox-docker.docker.test.ts`：`it("lists and removes leftover volumes and loop devices of sessions without a container", ...)`。

- [ ] **Step 2: 运行，确认失败**

Run: `npm run test:unit -- packages/core`
Expected: FAIL

- [ ] **Step 3: 实现并接线**（`startSweeper` 的回调改为先 `sandboxes.sweep()` 再 `checkpoints.thin()`）。

- [ ] **Step 4: 运行**

Run: `npm run test:unit && npm run typecheck`，测试机 `npm run test:docker`
Expected: PASS

- [ ] **Step 5: 提交** `feat: 存档的引用清理、空间不足时的稀疏化与启动对账`

---

### Task 10: M2 暂缓项：锁外拉镜像、docker 超时、准入计数

**Files:**
- Modify: `packages/server/src/adapters/sandbox-docker/{docker-cli,index}.ts`、`packages/core/src/ports.ts`、`packages/core/src/services/sandboxes.ts`、`packages/server/src/config.ts`
- Test: `packages/server/test/sandbox-docker.docker.test.ts`、`packages/core/test/sandboxes.test.ts`

**Interfaces:**
- Produces：
  - `SandboxProvider.prepareImage(spec: SandboxSpec): Promise<void>`：本地没有镜像就 `docker pull`。`SandboxService.#create` 在进入准入锁**之前**调用它。
  - `docker(args, { timeoutMs })`：默认 `DOCKER_TIMEOUT_MS = 120_000`，`pull` 用 `TETHER_IMAGE_PULL_TIMEOUT_SECONDS`（默认 600）；超时杀掉子进程并抛 `sandbox_failed`（消息含命令和超时）。
  - 准入计数把 `state === "lost" && reason === "cleanup failed"` 的绑定也算进去（容器可能还在跑）。

- [ ] **Step 1: 写失败的用例**

```ts
it("pulls a missing template image before taking the admission lock", ...)   // core：替身记录调用顺序 prepareImage 在 admission 前
it("counts a lost sandbox whose cleanup failed towards the limit", ...)
it("fails a docker command that runs past its timeout with sandbox_failed", ...) // docker-cli 单测：用 sleep 代替 docker 的可执行文件
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm run test:unit -- packages/core/test/sandboxes.test.ts packages/server/test`
Expected: FAIL

- [ ] **Step 3: 实现。** `docker-cli.ts` 的可执行文件名允许注入（只给测试用）。

- [ ] **Step 4: 运行**

Run: `npm run test:unit && npm run typecheck`，测试机 `npm run test:docker`
Expected: PASS

- [ ] **Step 5: 提交** `fix: 锁外拉取模板镜像，docker 调用加超时，清理失败的沙箱计入准入`

---

### Task 11: gVisor、端到端验收与文档

**Files:**
- Create: `docs/adr/ADR-011-workspace-images-and-checkpoints.md`
- Modify: `docs/adr/README.md`、`docs/superpowers/specs/2026-10-20-tether-design.md`、`README.md`

- [ ] **Step 1: gVisor 下跑全部 Docker 测试**

Run（测试机）: `TETHER_SANDBOX_RUNTIME=runsc npm run test:docker`
Expected: PASS。`docker pause` 或 loop 卷在 runsc 下不支持时，不跳过，写成 ADR-011 的限制并在 `capabilities` 或启动检查里如实拒绝。

- [ ] **Step 2: 端到端验收（测试机，faux 模型，按 README 的 CLI 命令）**：建 perRun 的 agent；三轮各写一个文件；`tether checkpoints` 看到 2 张；在第三轮分叉，`tether files` 看到 f1、f2；在 fork 里再分叉一次、对继承来的第二轮条目分叉；`docker rm -f` 原会话容器后发消息，文件恢复且模型收到说明；把 `TETHER_STOP_AFTER_SECONDS=60`、`TETHER_DESTROY_AFTER_SECONDS=120` 跑一遍闲置删除和恢复；归档全部会话后 `<dataDir>/checkpoints` 为空、`losetup -a` 和 `docker volume ls` 没有残留。

- [ ] **Step 3: 写 ADR-011**：工作区镜像文件的选择（两次实测数字、Cube 的同类做法）、loop 经一次性特权容器、`nocopy`、宿主重启后重新接 loop、每轮都留与空间下限的稀疏化、引用代替钉住、目录模式退路。`docs/adr/README.md` 加索引。

- [ ] **Step 4: 改 spec**：§5.3 的 `checkpoints` 表与 `forkedFrom`、`reason`；§8.3 保留规则改为"每轮都留，空闲空间低于下限时稀疏化，被分叉引用的不删"（作者的决定）；§8.4 "有检查点"一支的实现说明；§8.5 第三档的实现说明；§4.2 能力表 Docker 一栏的快照改为"每会话 XFS 镜像的 reflink 克隆，不支持 reflink 时目录加 rsync"；§10 写 M3 完成与审批拆出。

- [ ] **Step 5: 改 README**：新配置项（`TETHER_WORKSPACE_STORAGE`、`TETHER_DEFAULT_DISK_MB`、`TETHER_DESTROY_AFTER_SECONDS`、`TETHER_CHECKPOINT_MIN_FREE_PERCENT`、`TETHER_IMAGE_PULL_TIMEOUT_SECONDS`）；新命令（`session fork`、`checkpoints`）；"检查点与分叉"一节（实测数字、只还原 /workspace、进程不保留）；推荐 XFS `reflink=1` 数据盘，目录模式的代价；当前限制更新。

- [ ] **Step 6: 运行全部测试和类型检查**

Run: `npm run typecheck && npm test`（测试机）
Expected: PASS

- [ ] **Step 7: 提交** `docs: M3 的 ADR、spec 与 README`

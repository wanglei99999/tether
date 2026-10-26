# M2 沙箱生命周期 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每个会话的沙箱有完整、可解释的生命周期：重连时清掉旧 daemon 和它的命令（epoch 隔离），同时运行的沙箱有上限（准入控制），闲置一小时后停止并告诉模型，容器丢了按模板重建并告诉模型，会话可以归档，客户端可以浏览沙箱里的文件；容器加固并可选用 gVisor 运行。

**Architecture:** 生命周期的规则全部在 `core` 的 `SandboxService` 里：一张显式的状态转换表决定每个操作能不能做、做完是什么状态；每个会话的操作串行执行；所有状态写入都带"期望的当前状态"。后端相关的部分只有两个新能力：`SandboxProvider.fence()`（在容器里杀掉旧进程）和带状态的 `listManaged()`。`ExecChannel` 每次启动 daemon 前回调 `SandboxService.connect()` 取得新 epoch 和启动命令。定期巡检 `sweep()` 由 `core` 的定时器驱动，组装层只负责启动和停止它。

**Tech Stack:** 与 M1 相同：Node ≥ 22.19、TypeScript 7（`tsc --noEmit`）、Vitest 5、`typebox` 1.3.27、`node:sqlite`、Hono、pi 四个包 1.3.0、Docker 29；新增 gVisor（`runsc`，只装在测试机上）。

**Spec:** `docs/superpowers/specs/2026-10-20-tether-design.md`（M2 定义在 §10；相关设计在 §4.6、§5.3、§6.3、§6.5、§7.1、§8.2、§8.4、§8.5、§14）。决定依据：`docs/adr/ADR-007-epoch-fencing.md`、`docs/adr/ADR-008-idle-two-tiers.md`、`docs/m0-findings.md` 第 5 节；隔离脚本的参照实现 `spikes/m0/fence.ts`，卡住连接的测试做法 `spikes/m0/orphan.test.ts`。

## Global Constraints

- M1 计划的 Global Constraints 全部继续有效（精确版本、pi 类型只在适配器和组装根、`core` 只依赖 `typebox`、信封与错误码、容器标签、测试在 `tether-m0` 上跑、faux 模型、约定式提交与中文描述）。
- 容器 PID 1 必须是 `sleep`：`kill -KILL -1` 只在 PID 1 是容器自己的 `sleep` 且 `HostConfig.PidMode` 为空时执行（spec §8.2 防护）。
- 任何让环境与对话不一致的变化（停止、重连杀掉进程、按模板重建）都要写一条**模型可见**的条目；文本固定为本计划 Task 2 的 `NOTES`（spec §8.4 "永远不假装环境还是原来的样子"）。
- 默认值：`maxRunningSandboxes` 4（spec §4.6）、`stopAfter` 1 小时（spec §8.5）、巡检间隔 60 秒；全部可配置（spec §15）。
- `sandbox_bindings` 的 `epoch` 只能经 `AppStore.nextEpoch()` 改变；其他写入不得带上 `epoch`。
- 不改测试机的 sshd 和防火墙，不开端口（作者的约束）；Task 9 安装 gVisor 只改 `/etc/docker/daemon.json` 并重启 Docker。

## 本里程碑不做

- 闲置超过 `destroyAfter` 的删除档（spec §8.5 第三档）：它要求先做最终快照，快照属于 M3，这一档和快照一起在 M3 实现（作者的决定）。Task 10 改 spec §10 的 M2/M3 范围。
- 从检查点重建（spec §8.4 的"有检查点"分支）、分叉、审批：M3。M2 只做"没有检查点就按模板重建"的分支（作者的决定）。
- `/v1/metrics`、查看页：M4。
- 拦截容器访问云厂商的元数据地址（`100.100.100.200`）：需要宿主防火墙规则，不改防火墙，写进 README 的已知限制。

## 设计决定（本计划新增）

- **绑定写入不再整行覆盖。** M1 的 `putBinding` 是 `INSERT OR REPLACE`：拿着旧对象写回会把 epoch 改回旧值，也会覆盖巡检刚写的状态。改为 `createBinding` / `updateBinding(patch, expected)` / `nextEpoch` / `deleteBinding`，`updateBinding` 在当前状态不是期望值时报 `conflict`。
- **状态转换是一张表。** `core/src/sandbox-lifecycle.ts` 的 `nextState(from, event)` 是唯一的转换规则；`SandboxService` 的每次状态写入都经过它。
- **每个会话的沙箱操作串行。** `SandboxService` 用每会话一把的异步锁取代 M1 的单飞 Map：工具调用、巡检停止、重建、归档不会交错。
- **隔离由 `core` 编排，杀进程由后端做。** 什么时候隔离、epoch 怎么取、要不要写说明，与后端无关，放在 `SandboxService.connect()`；"在容器里杀掉旧进程"依赖后端（Docker 是 `docker exec` 加 `kill -1`），是 `SandboxProvider.fence()`。spec §4.2 把隔离放在 ExecChannel 层，这里的分法让 ExecChannel 只管连接，策略仍然与后端无关；Task 10 写进 ADR-010。
- **准入拒绝用新错误码 `sandbox_limit`（HTTP 503）。** 它不是会话忙（`busy`），也不是后端故障（`sandbox_failed`）。
- **准入条目对模型不可见。** 模型已经从工具的错误结果里看到原因，`tether.admission` 条目给客户端看，再给模型一份是重复。
- **巡检时正在运行的会话不算闲置，并把 `lastUsedAt` 刷新为当前时间。** 这样一轮运行结束后，闲置从下一次巡检算起，误差不超过一个巡检间隔；正在跑的长命令不会被停止。

## M1 推迟问题的处理

来自 M1 执行记录里的 12 条 `minor (deferred)`：

- 在本计划里处理：setup 失败加清理失败时原始错误被替换（Task 2）；容器丢失后悄悄在旧工作区上重建（Task 6）；`lazyEnv` 对任何属性名都返回函数、没有并发首调的测试（Task 3）；运行中的绑定从不和 Docker 核对（Task 5）；恢复期间不能在 resume 之前写引擎条目（Task 5）；`tether.close()` 不等进行中的工作（Task 5，只覆盖巡检和沙箱操作）。
- 继续推迟（与沙箱生命周期无关）：缺 API key 时运行以 `unanswered` 结束且不给原因；SDK 遇到 1011 无限重连；引擎会话创建失败的会话一直是 `active`；监听非回环地址却没设 token 时不告警；`openPiEngine` 抛错时存储不关闭；setup 输出在截尾前不设上限、CLI 读坏文件打印堆栈、WebSocket 无背压。
- M1 之后评审新提出、也继续推迟的：`waitSubmission` 不检查提交是否属于该会话；SDK 回调抛错会变成未捕获异常；长轮询没有超时参数。

## Review Focus

1. **巡检决定停止某个会话的沙箱时，这个会话正好开始一次工具调用。** 二者在同一把会话锁里先后执行：停止后的工具调用会重新启动容器并收到停止说明，不会拿到一个正在被停止的容器。Task 5 测试。
2. **一条命令跑得比 `stopAfter` 还久。** 会话在运行，巡检不停止它，只刷新 `lastUsedAt`。Task 5 测试。
3. **容器共享宿主的 PID 命名空间（`--pid host`）。** `fence` 拒绝执行并报 `sandbox_failed`，宿主上的进程不受影响。Task 3 测试。
4. **五个新会话同时发起第一次工具调用，上限是 4。** 恰好 4 个建出容器，第 5 个的工具结果是"沙箱数量已达上限"，并且有一条 `tether.admission` 条目。Task 4 测试。
5. **文件浏览的路径逃出工作区**（`../../etc/passwd`，或工作区里指向 `/etc` 的符号链接）。返回 `invalid_request`，不读取。Task 8 测试。

---

## 文件结构

```text
packages/core/src/
  model.ts                    Task 1  SandboxBinding.epoch 初值改为 0
  ports.ts                    Task 1、3、5  AppStore 绑定方法；SandboxProvider.fence、listManaged 带状态；AgentEngine.isRunning
  errors.ts                   Task 4  新错误码 sandbox_limit
  env.ts                      Task 8  TetherEnv 增加 readBytes、info、realPath
  sandbox-lifecycle.ts        Task 2  新建：状态转换表 nextState()
  notes.ts                    Task 2  新建：模型可见说明的固定文本
  lock.ts                     Task 2  新建：每个键一把的异步锁 KeyedLock
  sweeper.ts                  Task 5  新建：定时巡检 startSweeper()
  services/sandboxes.ts       Task 2–8  生命周期的全部规则
  services/sessions.ts        Task 5、7  idle 状态、归档
  startup.ts                  Task 5  对账返回待写说明，不在 resume 之前写引擎
packages/testkit/src/
  app-store.ts                Task 1  绑定方法的一致性用例
  memory-app-store.ts         Task 1
  sandbox-provider.ts         Task 3、5  fence、带状态的 listManaged
  agent-engine.ts             Task 5  isRunning
packages/server/
  sandbox/fence.sh            Task 3  新建：容器内的隔离脚本（从 spikes/m0/fence.ts 的 FENCE_SCRIPT 搬出）
  sandbox/Dockerfile          Task 3  复制 fence.sh
  src/adapters/store-sqlite/  Task 1
  src/adapters/sandbox-docker/ Task 3、5、9
  src/adapters/exec-pienv/    Task 3、8  connect 回调；lazyEnv 只代理已知方法；TetherEnv 新方法
  src/adapters/engine-pi/     Task 5  isRunning
  src/http/                   Task 7、8  archive、sandbox/files、sandbox/file
  src/config.ts               Task 4、5、9  新配置项
  src/app.ts                  Task 3、5  接线、启动和停止巡检
packages/sdk/src/client.ts    Task 7、8
packages/cli/src/commands.ts  Task 7、8
docs/adr/ADR-010-sandbox-lifecycle-rules.md   Task 10
```

---

### Task 1: 绑定的写入规则（AppStore）

**Files:**
- Modify: `packages/core/src/ports.ts`、`packages/core/src/model.ts`、`packages/testkit/src/app-store.ts`、`packages/testkit/src/memory-app-store.ts`、`packages/server/src/adapters/store-sqlite/index.ts`
- Modify（调用方跟着改，行为不变）：`packages/core/src/services/sandboxes.ts`、`packages/core/src/startup.ts`、`packages/core/test/*.ts`
- Test: `packages/testkit/src/app-store.ts`（内存版与 SQLite 版同一套）

**Interfaces:**
- Produces（替换 `putBinding`）：
  - `createBinding(binding: SandboxBinding): Promise<void>`：已存在时 `TetherError("conflict")`。
  - `updateBinding(sessionId: string, patch: BindingPatch, expected?: { state: SandboxState | readonly SandboxState[] }): Promise<SandboxBinding>`，`type BindingPatch = Partial<Pick<SandboxBinding, "state" | "lastUsedAt">>`。不存在时 `not_found`；当前状态不在 `expected.state` 里时 `conflict`，不写入；返回写入后的绑定。
  - `nextEpoch(sessionId: string): Promise<number>`：原子地加一并返回新值；不存在时 `not_found`。
  - `deleteBinding`、`getBinding`、`listBindings` 不变。
- 新绑定的 `epoch` 初值为 `0`，第一次连接得到 `1`。删除 `sandboxes.ts` 里的 `EPOCH` 常量。

- [ ] **Step 1: 在 `registerAppStoreConformance` 里写失败的用例**，并删掉 "replaces a binding on put and removes it on delete"：

```ts
it("creates a binding once and rejects a second create with conflict", ...)
it("updates state and lastUsedAt without touching the epoch", ...)        // 先 nextEpoch 两次，再 update，epoch 仍是 2
it("rejects an update whose expected state does not match, leaving the binding unchanged", ...) // code "conflict"
it("accepts an update when the current state is one of several expected states", ...)
it("increments the epoch atomically", ...)       // 10 个并发 nextEpoch 返回 1..10 各一次
it("removes a binding on delete", ...)
it("rejects update and nextEpoch of a missing binding with not_found", ...)
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm run test:unit -- packages/testkit packages/server/test/store-sqlite.test.ts`
Expected: FAIL（`createBinding is not a function` 等）

- [ ] **Step 3: 实现内存版和 SQLite 版。** SQLite 的 `updateBinding` 在 `#transaction` 里先读后写；`nextEpoch` 用 `UPDATE … SET epoch = epoch + 1 WHERE session_id = ? RETURNING epoch`。

- [ ] **Step 4: 改调用方。** `SandboxService` 和 `recover()` 里的 `putBinding` 按语义换成 `createBinding` / `updateBinding`（这一步不加 `expected`，Task 2 再加）；core 测试的替身跟着改。

- [ ] **Step 5: 运行全部单元测试和类型检查**

Run: `npm run test:unit && npm run typecheck`
Expected: PASS

- [ ] **Step 6: 提交** `refactor: 绑定改为按字段更新，epoch 只能原子递增`

---

### Task 2: 状态转换表、会话锁与模型可见说明

**Files:**
- Create: `packages/core/src/sandbox-lifecycle.ts`、`packages/core/src/notes.ts`、`packages/core/src/lock.ts`
- Modify: `packages/core/src/services/sandboxes.ts`、`packages/core/src/index.ts`、`packages/server/src/app.ts`（`record` 的新签名）
- Test: `packages/core/test/sandbox-lifecycle.test.ts`、`packages/core/test/lock.test.ts`、`packages/core/test/sandboxes.test.ts`

**Interfaces:**
- Produces:
  - `type SandboxEvent = "create" | "setup_done" | "setup_failed" | "abandon" | "stop" | "start" | "vanish" | "destroy"`
  - `nextState(from: SandboxState | undefined, event: SandboxEvent): SandboxState | undefined`（`undefined` 表示没有绑定）。不允许的转换抛 `TetherError("conflict", "cannot <event> a sandbox that is <from ?? 'absent'>")`。允许的转换恰好是：

    ```text
    absent   --create-->       creating
    lost     --create-->       creating     （按模板重建，Task 6）
    creating --setup_done-->   running
    creating --setup_failed--> absent       （setup 失败且清理成功：删掉绑定）
    creating --abandon-->      lost         （setup 失败且清理也失败：留给下次重建时再清）
    running  --stop-->         stopped
    stopped  --start-->        running
    running|stopped --vanish-->  lost
    creating|running|stopped|lost|destroyed --destroy--> destroyed
    ```

    共 6 个起点（含 absent）× 8 个事件。
  - `class KeyedLock { run<T>(key: string, work: () => Promise<T>): Promise<T> }`：同一个 key 的 work 按调用顺序串行，不同 key 并行；work 抛错不影响后面排队的 work。
  - `interface SandboxNote { kind: "tether.sandbox" | "tether.admission"; data: Record<string, unknown>; modelText?: string }`；`SandboxServiceDeps.record` 改为 `(sessionId: string, note: SandboxNote) => Promise<void>`。app.ts 把 `modelText` 传给 `engine.appendEntry`。
  - `NOTES`（`notes.ts`，模型可见文本，原样使用）：

    ```ts
    export const NOTES = {
      stoppedIdle: (minutes: number) =>
        `The sandbox was stopped after ${minutes} minutes without activity. Processes started earlier, including background servers, have ended. Files in /workspace are kept, and the sandbox starts again on the next tool call.`,
      stoppedOutside:
        "The sandbox was stopped outside Tether. Processes started earlier, including background servers, have ended. Files in /workspace are kept, and the sandbox starts again on the next tool call.",
      reconnected:
        "The connection to the sandbox was re-established. Processes started earlier, including background servers, have ended. Files in /workspace are kept.",
      reset: (reason: string) =>
        `The previous sandbox was lost (${reason}). A new sandbox was created from the template and the setup commands ran again. Files that were in /workspace are gone, and so are processes started earlier.`,
    } as const;
    ```

- [ ] **Step 1: 写失败的表驱动测试** `sandbox-lifecycle.test.ts`：对 6 个起点 × 8 个事件逐一断言，表里有的得到对应状态，其余抛 `conflict`。

```ts
it("allows exactly the transitions in the table", ...)
it("treats destroy of a destroyed sandbox as a no-op transition", ...)
```

- [ ] **Step 2: 写失败的锁测试** `lock.test.ts`：

```ts
it("runs work for the same key one at a time in call order", ...)
it("runs work for different keys concurrently", ...)
it("keeps running queued work after one throws", ...)
```

- [ ] **Step 3: 在 `sandboxes.test.ts` 加失败的用例**

```ts
it("keeps the setup error when cleanup also fails and marks the binding lost", ...)
// FakeProvider.failDestroy = true；ensureSandbox 抛出的错误消息含失败的 setup 命令；绑定状态是 lost；record 收到 { state: "lost", reason: "cleanup failed" }
it("writes every state change with the expected current state", ...)
// 用一个包装 MemoryAppStore 的 spy：每次 updateBinding 都带 expected
it("serializes concurrent ensureSandbox calls for one session into one create", ...)  // 取代 M1 的单飞测试，断言不变
```

- [ ] **Step 4: 运行，确认失败**

Run: `npm run test:unit -- packages/core`
Expected: FAIL

- [ ] **Step 5: 实现 `nextState`、`KeyedLock`、`NOTES`，改 `SandboxService`。** 改变沙箱状态的对外方法（`ensureSandbox`，以及后面任务加的 `sweep` 里的每个会话、`destroy`）都包在 `#lock.run(sessionId, …)` 里；Task 3 的 `connect` 例外，见那里的说明。锁的顺序固定为先会话锁、后 Task 4 的准入锁，不反过来拿；状态写入一律经私有方法 `#transition(binding, event, patch?)`，它算出 `nextState` 并以 `expected: binding.state` 调用 `updateBinding`。setup 失败时清理的每一步（`exec.close`、`provider.destroy`、删绑定、写条目）各自 `try`，失败记日志（`SandboxServiceDeps` 新增 `log: Log`），最后抛原始错误。

- [ ] **Step 6: 运行全部单元测试和类型检查**

Run: `npm run test:unit && npm run typecheck`
Expected: PASS

- [ ] **Step 7: 提交** `refactor: 沙箱状态转换表与会话锁，setup 清理失败不再吞掉原始错误`

---

### Task 3: epoch 隔离

**Files:**
- Create: `packages/server/sandbox/fence.sh`、`packages/server/test/fence.docker.test.ts`
- Modify: `packages/server/sandbox/Dockerfile`、`packages/core/src/ports.ts`、`packages/core/src/services/sandboxes.ts`、`packages/testkit/src/sandbox-provider.ts`、`packages/server/src/adapters/sandbox-docker/index.ts`、`packages/server/src/adapters/exec-pienv/index.ts`、`packages/server/src/adapters/exec-pienv/lazy.ts`、`packages/server/src/app.ts`、`packages/core/test/fakes.ts`
- Test: 上面的 docker 测试；`packages/core/test/sandboxes.test.ts`；`packages/server/test/lazy-env.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `nextEpoch`；Task 2 的 `NOTES.reconnected`、锁。
- Produces:
  - `SandboxProvider.fence(sandboxId: string, epoch: number): Promise<{ killed: number }>`：杀掉容器里除 PID 1 以外的全部进程，删除 epoch 更小的 daemon 记录。前提检查失败（`PidMode` 非空、PID 1 不是 `sleep`）或脚本失败时抛 `TetherError("sandbox_failed")`。
  - `SandboxService.connect(sessionId: string): Promise<readonly string[]>`：绑定必须是 `creating` 或 `running`，否则 `conflict`；`epoch = nextEpoch()`；`fence()`；如果这个容器自上次创建 / 启动以来已经连过一次（服务内存里的 `#connected` 集合，创建和启动时清掉这个会话），写模型可见的 `tether.sandbox` 条目：`{ data: { state: "running", reason: "reconnected", epoch, killed }, modelText: NOTES.reconnected }`；返回 `provider.daemonCommand(sandboxId, epoch)`。服务重启后集合为空，所以重启后的第一次连接也写说明（崩溃时 daemon 退出会带走后台进程，模型要知道）。**`connect` 不拿会话锁**：setup 在 `ensureSandbox` 持有会话锁时经 ExecChannel 发命令，`Connection` 在这时回调 `connect`，再拿同一把锁会死锁；epoch 的原子性由 `nextEpoch` 保证，一个容器同一时刻只有一条连接由 ExecChannel 按 `sandboxId` 复用连接保证。
  - `PiEnvExecChannelOptions` 改为 `{ connect: (binding: SandboxBinding) => Promise<readonly string[]> }`，作为 pi-env `Connection` 的 `command` 函数（`Connection` 每次启动 daemon 前调用它）；连接按 `sandboxId` 复用，不再按 epoch 比较。
  - `lazyEnv` 只代理 pi `ExecutionEnv`（`FileSystem` 与 `Shell`）里的方法名，名单写成 `lazy.ts` 里的常量；其余属性返回 `undefined`（例如可选的 `listFiles` 不在名单里时，pi 的特性检查得到 `undefined`）。

- [ ] **Step 1: 写失败的单元测试**（`sandboxes.test.ts`，FakeProvider 加 `fence` 记录调用）

```ts
it("takes a new epoch and fences before returning the daemon command", ...)   // 调用顺序 nextEpoch → fence → daemonCommand，命令末尾是新 epoch
it("does not write a reconnect note for the first connection after create", ...)
it("writes a model-visible reconnect note for a second connection", ...)
it("fails the connection when fencing fails, without returning a command", ...)
it("refuses to connect a stopped or lost sandbox with conflict", ...)
```

- [ ] **Step 2: 写失败的 lazyEnv 测试**

```ts
it("returns undefined for properties that are not ExecutionEnv methods", ...)
it("resolves the environment once for two concurrent first calls", ...)
```

- [ ] **Step 3: 在 `registerSandboxProviderConformance` 加失败的用例**

```ts
it("fences a fresh sandbox and reports how many processes it killed", ...)    // killed >= 0，之后 status 仍是 running
it("fails to fence a missing sandbox with sandbox_failed", ...)
```

- [ ] **Step 4: 写失败的 Docker 测试** `fence.docker.test.ts`（真实容器、真实 `exec-pienv`；旧连接的做法参照 `spikes/m0/orphan.test.ts`）

```ts
it("kills the old epoch's background command when a new connection starts", ...)
// 通道 A 上执行 `nohup sh -c 'sleep 3; echo late > late.txt' >/dev/null 2>&1 &`；
// 另建一个通道 B（同一个 SandboxService）执行 `true`；等 4 秒；late.txt 不存在；
// /run/tether/daemons/ 里只有新 epoch 的记录；绑定的 epoch 是 2
it("kills the old command while the old connection is stuck (SIGSTOP)", ...)
// 用一个子进程持有通道 A 并 SIGSTOP 它（同 M0 的 holder），其余断言同上，最后 SIGCONT 并结束子进程
it("refuses to fence a container that shares the host PID namespace", ...)
// 测试自己 docker run --pid host（带 tether 标签、PID 1 为 sleep）；provider.fence 抛 sandbox_failed；
// 测试进程在宿主上启动的一个 sleep 仍然存活
```

- [ ] **Step 5: 运行，确认失败**

Run: `npm run test:unit -- packages/core packages/server/test/lazy-env.test.ts && npm run test:docker -- fence sandbox-docker`
Expected: FAIL

- [ ] **Step 6: 实现。** `fence.sh` 是 `spikes/m0/fence.ts` 里 `FENCE_SCRIPT` 的内容（参数 `$1` 为 epoch，输出被杀的 PID），装进镜像的 `/opt/tether/fence.sh`；Docker 的 `fence()` 先查 `HostConfig.PidMode`，再 `docker exec <id> /opt/tether/fence.sh <epoch>`，`killed` 是输出里 PID 的个数。app.ts 里 `createPiEnvExecChannel({ connect: (binding) => sandboxes.connect(binding.sessionId) })`（`sandboxes` 在后面声明，回调只在运行时调用）。

- [ ] **Step 7: 重新构建镜像并运行全部测试**

Run: `npm test && npm run typecheck`
Expected: PASS；跑完后测试机上没有残留的 Tether 容器（`docker ps -aq --filter label=tether.managed=1` 为空）

- [ ] **Step 8: 提交** `feat: 重连时按 epoch 隔离旧 daemon 及其命令`

---

### Task 4: 准入控制

**Files:**
- Modify: `packages/core/src/errors.ts`、`packages/core/src/services/sandboxes.ts`、`packages/server/src/http/envelope.ts`、`packages/server/src/config.ts`、`packages/server/src/app.ts`
- Test: `packages/core/test/sandboxes.test.ts`、`packages/server/test/config.test.ts`、`packages/server/test/app.docker.test.ts`

**Interfaces:**
- Produces:
  - `ErrorCode` 增加 `"sandbox_limit"`，HTTP 状态 503。
  - `SandboxServiceDeps.maxRunning?: number`，默认 `DEFAULT_MAX_RUNNING_SANDBOXES = 4`。
  - `Config.maxRunningSandboxes`，环境变量 `TETHER_MAX_RUNNING_SANDBOXES`（正整数，默认 4）。
  - 创建、启动、重建一个沙箱之前，在一把全局的准入锁里数 `running` 与 `creating` 的绑定（不含本会话）；达到上限时写 `{ kind: "tether.admission", data: { limit, running } }`（无 `modelText`），然后抛 `TetherError("sandbox_limit", "sandbox limit reached: <running> of <limit> sandboxes are running; try again after another session goes idle")`。已经在运行的沙箱上的工具调用不检查准入。

- [ ] **Step 1: 写失败的单元测试**

```ts
it("refuses a new sandbox at the limit with sandbox_limit and records tether.admission", ...)
it("admits again after another sandbox stops", ...)
it("admits exactly the limit when first tool calls in more sessions arrive at once", ...)  // createDelayMs = 20，5 个会话、上限 4
it("never refuses tool calls on a sandbox that is already running", ...)
it("applies the limit to starting a stopped sandbox", ...)
```

`config.test.ts`：`TETHER_MAX_RUNNING_SANDBOXES` 默认 4；`0`、`-1`、`abc` 抛 `invalid_request`。

- [ ] **Step 2: 运行，确认失败**

Run: `npm run test:unit -- packages/core packages/server/test/config.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现。** 全局准入锁用 Task 2 的 `KeyedLock`，键为常量 `"admission"`；数数和写 `creating`（或启动后写 `running`）在同一次锁内完成。

- [ ] **Step 4: 加 Docker 集成测试并运行**（`app.docker.test.ts`，`maxRunningSandboxes: 1`，两个会话的 faux 脚本都先调用 bash）

```ts
it("returns the sandbox limit as the second session's tool result and records tether.admission", ...)
```

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交** `feat: 准入控制，同时运行的沙箱数有上限`

---

### Task 5: 闲置停止与巡检

**Files:**
- Create: `packages/core/src/sweeper.ts`、`packages/core/test/sweeper.test.ts`
- Modify: `packages/core/src/ports.ts`、`packages/core/src/services/sandboxes.ts`、`packages/core/src/services/sessions.ts`、`packages/core/src/startup.ts`、`packages/testkit/src/agent-engine.ts`、`packages/testkit/src/sandbox-provider.ts`、`packages/server/src/adapters/engine-pi/index.ts`、`packages/server/src/adapters/sandbox-docker/index.ts`、`packages/server/src/config.ts`、`packages/server/src/app.ts`、`packages/core/test/fakes.ts`
- Test: `packages/core/test/sandboxes.test.ts`、`packages/core/test/sessions.test.ts`、`packages/core/test/startup.test.ts`、`packages/server/test/app.docker.test.ts`

**Interfaces:**
- Consumes: Task 2 的锁与 `NOTES`；Task 3 的 `exec.close`。
- Produces:
  - `AgentEngine.isRunning(engineSessionId: string): Promise<boolean>`：与 `SessionView.running` 同一来源（pi 上是 `watchEvents` 快照的 `run`，取到即停止这个流）；未知会话 `not_found`。
  - `SandboxProvider.listManaged()` 返回 `{ sandboxId: string; sessionId: string; status: "running" | "stopped" }[]`，一次后端调用（Docker：一次 `docker ps --all`）。
  - `SandboxServiceDeps` 增加 `engine: Pick<AgentEngine, "isRunning">`、`stopAfterMs?: number`（默认 `DEFAULT_STOP_AFTER_MS = 3_600_000`）。
  - `SandboxService.sweep(): Promise<SweepResult>`，`interface SweepResult { stoppedIdle: number; stoppedOutside: number; lost: number }`。每个会话在自己的锁里处理，一个会话出错只记日志：
    1. 绑定 `running` 但容器已停止 → `stop`，写 `NOTES.stoppedOutside`（模型可见），会话状态改为 `idle`；
    2. 绑定 `running` 或 `stopped` 但容器不在 → `vanish`，写不带 `modelText` 的 `{ state: "lost", reason: "missing" }`（重建时再写模型可见的说明，Task 6）；
    3. 绑定 `running`、会话正在运行 → `lastUsedAt` 改为当前时间；
    4. 绑定 `running`、会话不在运行、`now - lastUsedAt >= stopAfterMs` → `provider.stop`、`exec.close`、`stop`，写 `NOTES.stoppedIdle(stopAfter 的分钟数)`（模型可见），会话状态改为 `idle`。
  - `ensureSandbox` 返回已在运行的绑定时把 `lastUsedAt` 改为当前时间。
  - `SessionService.sendMessage` 遇到 `idle` 的会话先改回 `active`。
  - `startSweeper(sweep: () => Promise<unknown>, intervalMs: number, log: Log): { stop(): Promise<void> }`：两次巡检不重叠；`stop()` 等进行中的那次结束。
  - `recover()` 的对账不再调用任何引擎方法：需要写的说明（启动时发现容器已停止的会话写 `NOTES.stoppedOutside`）作为 `RecoverResult.notes: { sessionId: string; note: SandboxNote }[]` 返回，组装层在 `recover()` 之后逐条写入。原因：pi 的 `submit` 会开启调度，在 resume 之前写条目等于提前续跑。
  - `Config` 增加 `stopAfterMs`（`TETHER_STOP_AFTER_SECONDS`，默认 3600）、`sweepIntervalMs`（`TETHER_SWEEP_INTERVAL_SECONDS`，默认 60）。`createTether` 在恢复和写完对账说明之后启动巡检；`close()` 先停巡检，再关事件流、引擎、通道、存储。
  - core 测试用的 `ManualClock`（`fakes.ts`）：`now()` 返回当前设定的时间，`advance(ms)` 往后拨。

- [ ] **Step 1: 在 `registerAgentEngineConformance` 加失败的用例**

```ts
it("reports running during a run and not running after it settles", ...)
it("reports an unknown session from isRunning with not_found", ...)
```

- [ ] **Step 2: 写失败的巡检单元测试**（`sandboxes.test.ts`，`ManualClock`，FakeEngine 增加可设置的 `running`）

```ts
it("stops a sandbox idle for stopAfter, writes the model-visible note and marks the session idle", ...)
it("does not stop a sandbox whose session is running, and refreshes lastUsedAt", ...)
it("does not stop a sandbox used within stopAfter", ...)
it("restarts the stopped sandbox on the next tool call", ...)
it("runs a tool call that arrives during a sweep's stop after the stop, restarting the sandbox", ...)  // Review Focus 1
it("marks a running binding stopped with the outside-stop note when the container is stopped", ...)
it("marks a binding lost when its container is gone", ...)
it("keeps sweeping other sessions when one fails", ...)
```

`sessions.test.ts`：`it("turns an idle session active again when a message is sent", ...)`。
`sweeper.test.ts`：`it("never runs two sweeps at once", ...)`、`it("waits for the running sweep on stop", ...)`。
`startup.test.ts`：`it("calls no engine method other than resume during recovery", ...)`、`it("returns an outside-stop note for a binding whose container was stopped while Tether was down", ...)`。

- [ ] **Step 3: 运行，确认失败**

Run: `npm run test:unit`
Expected: FAIL

- [ ] **Step 4: 实现。** 更新 testkit 里 `listManaged` 的断言为带 `status` 的形状。

- [ ] **Step 5: 加 Docker 集成测试并运行**（`app.docker.test.ts`：`stopAfterMs: 1_000`、`sweepIntervalMs: 200`）

```ts
it("stops an idle sandbox, and the next tool call starts it again with the note in the transcript", ...)
// 文件仍在；transcript 里有 stoppedIdle 的文本；容器状态 running；会话状态回到 active
```

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 6: 提交** `feat: 闲置停止沙箱并告知模型，定期与 Docker 核对绑定`

---

### Task 6: 沙箱丢失后按模板重建

**Files:**
- Modify: `packages/core/src/services/sandboxes.ts`
- Test: `packages/core/test/sandboxes.test.ts`、`packages/server/test/app.docker.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `create` from `lost`、`NOTES.reset`；Task 4 的准入；Task 5 写下的 `lost`。
- Produces: `ensureSandbox` 遇到 `lost`：先用 `nextState("lost", "create")` 确认可以重建，再 `exec.close`、`provider.destroy(sandboxId)`（删掉容器残留和工作区）、删掉旧绑定、按模板创建新绑定（`epoch` 从 0 开始）并执行 setup（走准入），成功后写 `{ kind: "tether.sandbox", data: { state: "running", reason: "recovered" }, modelText: NOTES.reset(<原因>) }`。原因是绑定变为 `lost` 时记下的 `reason`（`"missing"`、`"cleanup failed"`）；为此 `SandboxBinding` 不加字段，原因取自 `#lostReasons` 内存表，服务重启后缺省为 `"missing"`。`stopped` 的绑定在启动时发现容器不在，也走这条路径，不再抛 `sandbox_failed`。客户端从 `tether.sandbox` 条目的 `reason: "recovered"` 得知重建（spec §8.4 的 `sandbox_recovered`，不另设事件类型）。

- [ ] **Step 1: 写失败的单元测试**

```ts
it("rebuilds a lost sandbox from the template, reruns setup and writes the reset note", ...)
it("rebuilds a stopped sandbox whose container is gone on the next tool call", ...)
it("applies the sandbox limit to a rebuild", ...)
it("leaves the binding lost when the rebuild's setup fails", ...)
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm run test:unit -- packages/core`
Expected: FAIL

- [ ] **Step 3: 实现。**

- [ ] **Step 4: 加 Docker 集成测试并运行**

```ts
it("rebuilds after the container is removed by hand; the old file is gone and the reset note is in the transcript", ...)
```

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交** `feat: 沙箱丢失后按模板重建并告知模型`

---

### Task 7: 会话归档

**Files:**
- Modify: `packages/core/src/services/sandboxes.ts`、`packages/core/src/services/sessions.ts`、`packages/server/src/http/routes.ts`、`packages/server/src/app.ts`、`packages/sdk/src/client.ts`、`packages/cli/src/commands.ts`
- Test: `packages/core/test/sessions.test.ts`、`packages/core/test/sandboxes.test.ts`、`packages/server/test/http.test.ts`、`packages/server/test/app.docker.test.ts`、`packages/cli/test/cli.docker.test.ts`

**Interfaces:**
- Produces:
  - `SandboxService.destroy(sessionId: string, reason: string): Promise<void>`：没有绑定或已是 `destroyed` 时什么都不做；否则 `exec.close`、`provider.destroy`、`destroy` 转换（保留 `destroyed` 的行），写 `{ state: "destroyed", reason }`（无 `modelText`）。`ensureSandbox` 遇到 `destroyed` 抛 `conflict`；巡检跳过它。
  - `SessionServiceDeps` 增加 `sandboxes: Pick<SandboxService, "destroy">`。
  - `SessionService.archive(id: string): Promise<SessionRecord>`：先把状态改为 `archived`（之后的消息被拒绝），再 `engine.abort`（有引擎会话时），再 `sandboxes.destroy(id, "archived")`。对已归档的会话再调用一次也执行 `destroy`，所以上次销毁失败可以重试。
  - `POST /v1/sessions/:id/archive` → `{ session }`；SDK `sessions.archive(id): Promise<SessionRecord>`；CLI `tether session archive <sessionId>`（用法文本加这一行）。

- [ ] **Step 1: 写失败的单元测试**

```ts
it("archives a session: status archived, run aborted, sandbox destroyed", ...)
it("rejects messages to an archived session with conflict", ...)          // M1 已有，确认仍通过
it("retries the sandbox destroy when archive is called again after a failure", ...)
it("does nothing for destroy without a binding", ...)
it("refuses ensureSandbox for a destroyed sandbox with conflict", ...)
```

`http.test.ts`：`it("archives a session and returns it", ...)`、`it("returns not_found when archiving an unknown session", ...)`。

- [ ] **Step 2: 运行，确认失败**

Run: `npm run test:unit`
Expected: FAIL

- [ ] **Step 3: 实现。**

- [ ] **Step 4: 加 Docker 和 CLI 测试并运行**

```ts
// app.docker.test.ts
it("destroys the container and the workspace directory when a session is archived", ...)
// cli.docker.test.ts
it("archives a session from the command line", ...)
```

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交** `feat: 会话归档，销毁沙箱`

---

### Task 8: 沙箱文件浏览

**Files:**
- Modify: `packages/core/src/env.ts`、`packages/core/src/services/sandboxes.ts`、`packages/server/src/adapters/exec-pienv/index.ts`、`packages/server/src/http/routes.ts`、`packages/sdk/src/client.ts`、`packages/cli/src/commands.ts`、`packages/core/test/fakes.ts`
- Test: `packages/core/test/sandboxes.test.ts`、`packages/server/test/exec-pienv.docker.test.ts`、`packages/server/test/http.test.ts`、`packages/server/test/app.docker.test.ts`

**Interfaces:**
- Produces:
  - `TetherEnv` 增加 `readBytes(path: string): Promise<Uint8Array>`、`info(path: string): Promise<DirEntry>`、`realPath(path: string): Promise<string>`（分别包装 pi 的 `readBinaryFile`、`fileInfo`、`canonicalPath`，错误转换规则同 M1 的 `call()`）。
  - `SandboxService.listFiles(sessionId: string, path: string): Promise<DirEntry[]>`、`SandboxService.readFile(sessionId: string, path: string): Promise<{ name: string; content: Uint8Array }>`：
    - 没有绑定 → `not_found`（"session X has no sandbox yet"），不创建沙箱；`stopped` → 启动（走准入）；`lost` → 走 Task 6 的重建；`destroyed` → `conflict`。
    - 路径相对 `/workspace`，空路径即 `/workspace`；先 `realPath`，结果不是 `/workspace` 或它下面的路径时 `invalid_request`（"path is outside /workspace"），符号链接按解析后的位置判断。
    - 文件大于 `MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024` 时 `invalid_request`（"file is larger than 10 MiB"）；目录用 `readFile` 读时 `invalid_request`。
    - 浏览不刷新 `lastUsedAt`：看文件不算会话在使用沙箱。
  - `GET /v1/sessions/:id/sandbox/files?path=` → `{ items: DirEntry[] }`；`GET /v1/sessions/:id/sandbox/file?path=` → 原始字节，`content-type: application/octet-stream`，`content-disposition: attachment; filename="<name>"`（错误仍用 JSON 信封）。
  - SDK：`sessions.files(id, path?): Promise<DirEntry[]>`、`sessions.file(id, path): Promise<Uint8Array>`。CLI：`tether files <sessionId> [path]`（列目录，每行 `kind  size  name`）、`tether cat <sessionId> <path>`（原样写到 stdout）。

- [ ] **Step 1: 写失败的单元测试**（FakeExecChannel 的环境实现新方法，`realPath` 按测试设定的映射返回）

```ts
it("lists /workspace when the path is empty", ...)
it("rejects a path that resolves outside /workspace with invalid_request", ...)   // Review Focus 5：../../etc 与符号链接两种
it("reports not_found for a session without a sandbox and creates none", ...)
it("starts a stopped sandbox before reading", ...)
it("rejects a file larger than 10 MiB", ...)
it("does not refresh lastUsedAt", ...)
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm run test:unit -- packages/core`
Expected: FAIL

- [ ] **Step 3: 实现 core、exec-pienv、路由、SDK、CLI。**

- [ ] **Step 4: 加 Docker 与 HTTP 测试并运行**

```ts
// exec-pienv.docker.test.ts
it("reads bytes, file info and the real path through the daemon", ...)
// app.docker.test.ts
it("lists and downloads a file the agent wrote", ...)                         // 二进制内容逐字节相等
it("refuses a symlink in the workspace that points to /etc", ...)
// http.test.ts
it("serves a file as octet-stream with its name", ...)
```

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交** `feat: 浏览和下载沙箱工作区里的文件`

---

### Task 9: 容器加固、gVisor 与暂不支持的配置

**Files:**
- Modify: `packages/server/src/adapters/sandbox-docker/index.ts`、`packages/server/src/config.ts`、`packages/server/src/app.ts`、`packages/core/src/validate.ts`、`packages/core/src/services/agents.ts`、`packages/testkit/src/sandbox-provider.ts`
- Test: `packages/server/test/sandbox-docker.docker.test.ts`、`packages/core/test/validate.test.ts`、`packages/core/test/agents.test.ts`、`packages/server/test/config.test.ts`

**Interfaces:**
- Produces:
  - 沙箱容器增加 `--cap-drop ALL`、`--security-opt no-new-privileges`。删工作区的一次性 root 容器不加（它要越过文件属主删除）。
  - `DockerSandboxOptions.runtime?: string` → `--runtime <runtime>`；`Config.sandboxRuntime`，环境变量 `TETHER_SANDBOX_RUNTIME`（不设则不传 `--runtime`，即 runc）。
  - `validateVersionSpec(spec, catalog, unsupported)`，`unsupported: { diskMb: boolean; approval: boolean; checkpoints: boolean }`：`resources.diskMb` 有值、`permissions.requireApproval` 非空、`checkpointPolicy` 为 `"perRun"` 时，对应项为 `true` 就抛 `invalid_request`（"<字段> is not supported yet"）。`AgentServiceDeps.unsupported` 由组装层给出，M2 三项都是 `true`。

- [ ] **Step 1: 写失败的测试**

```ts
// validate.test.ts
it("rejects diskMb, requireApproval and perRun while they are unsupported", ...)
it("accepts them when supported", ...)
// sandbox-docker.docker.test.ts
it("runs the sandbox with no capabilities and no-new-privileges", ...)     // docker inspect 的 CapDrop 与 SecurityOpt
it("passes the configured runtime to docker run", ...)                      // runtime: "runc" 时 HostConfig.Runtime 为 runc
// config.test.ts
it("reads TETHER_SANDBOX_RUNTIME", ...)
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm run test:unit -- packages/core packages/server/test/config.test.ts && npm run test:docker -- sandbox-docker`
Expected: FAIL

- [ ] **Step 3: 实现。** 加固后先跑一遍 M1 的 Docker 测试，确认 setup 和工具调用不依赖被去掉的能力。

- [ ] **Step 4: 运行全部测试**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 在 tether-m0 上安装 gVisor。** 按 gVisor 官方的 apt 源安装 `runsc`，`sudo runsc install`（写入 `/etc/docker/daemon.json` 的 `runtimes.runsc`），`sudo systemctl restart docker`。安装前确认没有正在运行的 Tether 测试容器。

Run: `docker run --rm --runtime runsc tether-sandbox:dev cat /proc/1/comm`
Expected: `cat`（runsc 能启动容器）

- [ ] **Step 6: 用 runsc 跑 Docker 测试**

Run: `TETHER_TEST_RUNTIME=runsc npm run test:docker`（测试夹具读 `TETHER_TEST_RUNTIME`，传给 provider 的 `runtime`）
Expected: PASS；隔离测试同样通过（`kill -1` 与 `/proc/1/comm` 在 gVisor 里成立）。不通过的用例要查明原因：属于 gVisor 已知差异的，在 README 写明并让该用例在 runsc 下跳过，同时在执行记录里留一条 Ruling。

- [ ] **Step 7: 提交** `feat: 沙箱容器去掉全部能力、可选 gVisor，暂不支持的配置直接拒绝`

---

### Task 10: 文档与端到端验收

**Files:**
- Create: `docs/adr/ADR-010-sandbox-lifecycle-rules.md`
- Modify: `docs/adr/README.md`、`docs/superpowers/specs/2026-10-20-tether-design.md`（§4.2、§4.6、§10）、`README.md`

**Interfaces:**
- Consumes: 前面所有任务。

- [ ] **Step 1: 写 ADR-010**，记录"设计决定"一节的前五条：按字段更新绑定、状态转换表、会话锁、隔离的分工（core 编排、后端杀进程）、`sandbox_limit` 错误码。格式同 ADR-007。

- [ ] **Step 2: 改 spec。** §4.2 写明 `fence()` 是 SandboxProvider 的职责、何时隔离由 core 决定；§4.6 写错误码 `sandbox_limit`；§10 把"闲置删除档"从 M2 移到 M3，把"无检查点的丢失重建"从 M3 移到 M2。

- [ ] **Step 3: 改 README。** 新配置项（`TETHER_MAX_RUNNING_SANDBOXES`、`TETHER_STOP_AFTER_SECONDS`、`TETHER_SWEEP_INTERVAL_SECONDS`、`TETHER_SANDBOX_RUNTIME`）；新命令（`session archive`、`files`、`cat`）；"当前限制"更新：去掉 M2 已实现的项，加上元数据地址未拦截、闲置删除档在 M3、gVisor 下跳过的用例（如有）。

- [ ] **Step 4: 端到端验收。** 在 tether-m0 上用真实配置（`stopAfter` 设为 60 秒、上限设为 1）按 README 跑一遍：建 agent、两个会话各发一条触发 bash 的消息（第二个看到上限）、等一分钟看到第一个会话的沙箱停止、再发消息看到它启动并有说明、`tether files` 与 `tether cat`、`tether session archive` 后容器和工作区都不在。

Expected: 每一步的输出与 README 描述一致；结束后没有残留容器。

- [ ] **Step 5: 运行全部测试并提交**

Run: `npm test && npm run typecheck`
Expected: PASS

提交 `docs: M2 的 ADR、spec 范围调整与 README`

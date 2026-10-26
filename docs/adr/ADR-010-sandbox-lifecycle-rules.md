# ADR-010：沙箱生命周期的规则放在 core，用状态表、会话锁和带期望值的写入保证一致

**状态**：已采纳（M2 已实现，2026-10-26）
**日期**：2026-10-26
**决策人**：wangl

---

## 背景

M1 的沙箱只有"第一次工具调用时创建、停了就启动"两种操作，状态写入是 `putBinding` 整行覆盖，并发的工具调用靠一个单飞 Map 合并。M2 加入了更多会改变沙箱状态的操作：重连时的 epoch 隔离（ADR-007）、闲置停止和与 Docker 的定期核对（ADR-008）、丢失后重建、归档销毁、准入控制、文件浏览时启动沙箱。这些操作来自不同的地方（引擎的工具调用、定时巡检、HTTP 请求），会在同一个会话上并发发生。

M1 的做法在这种情况下有三个问题：

- 整行覆盖会丢更新：一个调用方拿着旧对象写回，会把巡检刚写的 `stopped` 改回 `running`，也会把 epoch 改回旧值，让隔离失效。
- 哪个状态下能做哪个操作分散在各个方法的 `if` 里，新增一个操作就要重新检查一遍所有分支。
- 单飞 Map 只合并"同时创建"，不能让"巡检正要停止"和"工具调用正要使用"排队。

另外两个需要定下来的问题：epoch 隔离里"什么时候隔离、要不要告诉模型"和"怎样在容器里杀进程"分别归谁；准入拒绝用哪个错误码。

---

## 备选方案

| 维度 | A：每个操作自己检查，写入整行覆盖（M1 做法） | B：状态表 + 每会话一把锁 + 带期望状态的按字段写入 |
|---|---|---|
| 丢更新 | 会：旧对象写回覆盖别人的改动 | 不会：只写改动的字段，当前状态不是期望值时报 `conflict` |
| 能做什么操作 | 散在各方法里 | 一张表 `nextState(from, event)`，表里没有的转换报 `conflict` |
| 并发 | 只合并同时创建 | 同一会话的全部操作排队；不同会话并行 |
| epoch | 可能被覆盖回旧值 | 只能经 `nextEpoch()` 原子加一，其他写入不带 epoch |
| 实现位置 | 服务和存储里各一部分 | `core/src/sandbox-lifecycle.ts`、`core/src/lock.ts`，存储只提供按字段写入 |

隔离的分工也有两种：一是按 spec §4.2 原来的写法，全部放在 ExecChannel 里；二是 core 编排、后端只负责"在容器里杀进程"。准入拒绝的错误码可以复用 `busy`、`sandbox_failed`，或新增一个。

---

## 决策

选择 **方案 B**，具体是五条：

1. **绑定按字段更新。** `AppStore` 用 `createBinding`（已存在报 `conflict`）、`updateBinding(sessionId, patch, expected)`（当前状态不在 `expected` 里时报 `conflict`，不写入）、`nextEpoch(sessionId)`（`UPDATE … RETURNING` 原子加一）和 `deleteBinding` 取代 `putBinding`。`SandboxService` 的每次状态写入都带上它读到的状态作为期望值。
2. **状态转换是一张表。** `nextState(from, event)` 是唯一的转换规则：`absent | lost --create--> creating --setup_done--> running --stop--> stopped --start--> running`；`creating --setup_failed--> absent`、`creating --abandon--> lost`；`running | stopped --vanish--> lost`；任意状态 `--destroy--> destroyed`。表里没有的转换（例如对 `destroyed` 再 `create`）报 `conflict`。
3. **每个会话的沙箱操作串行。** `SandboxService` 用每个键一把的异步锁 `KeyedLock`：工具调用、巡检、重建、归档、文件浏览在同一个会话上排队执行。准入另有一把全局锁，获取顺序固定为先会话锁、再准入锁。`connect()`（ExecChannel 启动 daemon 前的回调）不拿会话锁：setup 在持锁时经 ExecChannel 发命令，再拿同一把锁会死锁；它的正确性由 `nextEpoch` 的原子性和"一个容器同一时刻一条连接"保证。
4. **隔离由 core 编排，杀进程由后端做。** 什么时候隔离、epoch 怎么取、要不要写模型可见的说明，与后端无关，放在 `SandboxService.connect()`；"在容器里杀掉旧进程"依赖后端，是 `SandboxProvider.fence(sandboxId, epoch)`（Docker 上是 `docker exec` 执行 `kill -KILL -1`，带 ADR-007 的两道防护）。ExecChannel 只管连接，每次启动 daemon 前调用 `connect()` 取命令。
5. **准入拒绝用新错误码 `sandbox_limit`（HTTP 503）。** 它既不是会话忙（`busy`，409），也不是后端故障（`sandbox_failed`，502），客户端应该稍后重试。拒绝时写一条 `tether.admission` 条目，不带模型文本：模型已经从工具的错误结果里看到原因。

---

## 后果

**正面**：
- 巡检和工具调用撞在一起时有确定的顺序：停止后到来的工具调用重新启动容器并收到停止说明，不会拿到一个正在被停止的容器（`sandboxes.test.ts` 有对应用例）。
- epoch 不会被旧对象写回，隔离总是用最新的 epoch。
- 新增一种操作只需要在表里加一行转换，再在锁里写操作本身。
- 隔离策略与后端无关：接入 E2B 时只需实现 `fence()`，"何时隔离、写什么说明"不用重写。

**负面**：
- 同一会话的文件浏览、工具调用、巡检互相等待；一个慢操作（例如几分钟的 setup）会让同会话的其他请求等着。不同会话不受影响。
- 准入锁在"建容器、写 `creating`"期间持有，所有会话的容器创建是串行的（setup 在锁外执行）。
- 锁只在一个进程里有效。一台主机只跑一个 Tether 实例（README 的当前限制），跨实例要换成数据库层的锁。
- spec §4.2 原来写的是"连接管理和 epoch 隔离都在 ExecChannel 这一层"，按第 4 条改写。

---

## 参考

- 设计文档 §4.2、§4.6、§5.3、§8.2、§8.4、§8.5：`docs/superpowers/specs/2026-10-20-tether-design.md`
- M2 计划的"设计决定"一节：`docs/superpowers/plans/2026-10-26-m2-sandbox-lifecycle.md`
- ADR-007（epoch 隔离）、ADR-008（闲置分两档）
- 实现：`packages/core/src/sandbox-lifecycle.ts`、`packages/core/src/lock.ts`、`packages/core/src/services/sandboxes.ts`

# M4 混沌测试 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用一个可复现的驱动程序，在随机时刻对真实的 Tether 服务端和 Docker 容器注入故障，检查 §11.3 的承诺是否成立，产出发现的问题清单。

**Architecture:** 不依赖 Docker 的部分（随机数、故障时间表、假模型的决策、不变式检查）是纯函数，放在 `testkit` 里用单元测试覆盖。驱动程序放在 `server` 的测试目录，以子进程启动服务端，注入故障，收集历史，交给检查函数。发现的问题这份计划只记录，修复是下一轮。

**Tech Stack:** 与 M3 相同，pi 四个包 1.4.0；测试机 `tether-m0`（2 vCPU、1.6 GiB 内存、`/data/tether-xfs` 8 GiB）。

**Spec:** `docs/superpowers/specs/2026-10-20-tether-design.md` §11.3（混沌测试）、§8（持久化与沙箱的交界）、§3（可验证性、"没有测试支撑的可靠性声明"是反目标）。

## Global Constraints

- M1 到 M3 计划的 Global Constraints 继续有效：精确版本、pi 类型只在适配器和组装根、`testkit` 只依赖 `core` 和 `vitest`（`architecture.test.ts` 检查）。
- 驱动程序只碰带 `tether.managed=1` 标签且属于自己这一轮数据目录的容器和卷。不执行 `losetup -D`、`docker system prune`、`docker volume prune`；`loop0` 绝不能动，它支撑着 `/data/tether-xfs`。
- 只在 `tether-m0` 上运行。不改 sshd 和防火墙，不开端口。
- 同一个种子产生同一份故障时间表。进程调度不受控制，所以同一个种子不保证复现同一个交错；README 和报告都按这个口径写。
- 混沌测试不进 `npm test`：单次运行要几十分钟，而且它的产出是问题清单，可能是红的。入口是 `npm run chaos`。
- 每轮的执行记录写进 `docs/superpowers/plans/2026-11-05-m4-rulings.md`，用户可见的变化写进 CHANGELOG `[未发布]`，随任务提交。

## 本计划不做

- 修复混沌测试发现的产品问题。除非它挡住驱动程序本身，否则只记进报告。下一轮按报告单独修，每个修复先写复现用例。
- 查看页、`/v1/metrics`、真实模型验证、发布文档：M4 的后续轮次。
- 宿主机重启、磁盘写满、OOM 这些故障：测试机上不好安全地自动注入（重启会影响 `loop0` 上的测试盘）。报告里列为没有覆盖。

## 设计决定

1. **假模型按对话内容决定下一步，不按调用次数。** 现有 faux 是一个队列（`pendingResponses.shift()`），服务重启后从头开始，崩溃之后答不对。混沌用的假模型是一个纯函数：`nextStep(messages) → 文本或工具调用`，只看这次请求带的消息。队列里放足够多份同一个函数（一轮不会超过 10000 次请求）。同样的对话内容在任何进程里得到同样的回答，重启后自然接着往下走。

2. **每次工具调用有唯一令牌，令牌由已有的工具结果数算出。** 令牌形如 `s<轮号>-m<消息号>-t<本轮已有的工具结果数>`。被中断的调用也有结果，所以模型重试时令牌会变。同一个令牌在执行记录里出现两次，就是工具被执行了两次。

3. **执行记录写在工作区的 `.chaos/exec.log`。** 每条命令开始写 `<令牌> start`，长命令每 200 ms 写一条 `<令牌> tick`，结束写 `<令牌> end`，时间戳用容器时钟的纳秒。写文件的步骤额外生成 `f-<令牌>.txt`。限制：从存档恢复后，存档之后的记录也跟着没了。所以"不重复执行"和"没有旧进程"在恢复过的会话上只能检查恢复之后的那一段，报告要写明这个缺口。

4. **"切断网络"改为挂起 `docker exec` 客户端。** Docker 后端走本机 `docker exec`，没有网络可切。对服务端子进程里的 `docker exec` 发 `SIGSTOP`，效果是连接卡住不断开（§8.2 的场景，M0 Task 5 和 `fence.docker.test.ts` 用的也是它）。设计文档 §11.3 按此修改。

5. **在 §11.3 的 5 条之外加 3 条。** §11.3 写在 M3 之前，也没检查"会话会不会卡死"：
   - I0 会话不卡死：故障停止后，每个提交都在期限内结束。pi 1.4.0 的崩溃保护可能让任务停下不再重跑（`restartLimit` 默认 5，`scheduler.ts`），而 Tether 只把 `task_parked` 记进日志，所以这条重点防它。
   - I6 工作区和说明一致：分叉出来的工作区里不能有分叉点之后才写的文件；该有而没有的文件，必须出现在说明的"没有发生的操作"里。
   - I7 没有残留：归档全部会话后，这一轮的容器、卷、loop 设备、`workspaces/`、`checkpoints/` 都清空。

6. **把混沌用的假模型接进新的夹具，不改 `run-tether.ts`。** `run-chaos-tether.ts` 只在模型上不同。

7. **轮数按实测定。** 测试机只有 2 vCPU，同时跑 2 个会话。Task 6 先量一轮的耗时，默认目标是 runc 和 runsc 各 50 轮，目录模式 20 轮；一轮超过 3 分钟就减少轮数，总时长上限 6 小时，实际轮数写进报告。

## 不变式

| 编号 | 承诺 | 怎么查 |
|---|---|---|
| I0 | 会话不卡死 | 故障结束后 180 秒内，所有提交的状态都到 `done` 或 `unanswered`，且 `unanswered` 带原因 |
| I1 | 同一个 `requestId` 最多一次运行 | 驱动程序在崩溃后用同一个 `requestId` 重发；记录里这条用户消息只有一条 |
| I2 | 不能重放的工具不执行两次 | `exec.log` 里同一个令牌至多一条 `start` |
| I3 | 重连后没有旧进程 | 令牌 B 的 `start` 之后，不再有更早令牌 A 的 `tick` |
| I4 | 环境变化一定有说明 | 容器被删过（驱动程序知道）的会话，之后的记录里一定有 `tether.sandbox`，`reason` 为 `recovered`，并有模型可见的说明 |
| I5 | 已提交的事件客户端最终能看到 | SDK 事件流全程订阅、断线自动重连；结束时它的 `entries` 与 `transcript` 接口的条目 ID 一致 |
| I6 | 工作区和说明一致 | 见设计决定 5 |
| I7 | 没有残留 | 见设计决定 5 |

## Review Focus

1. 检查函数把违反判成通过：每条不变式都要有一个构造出来的违反样例，Task 3 钉住。
2. 驱动程序看不到真实数据，全部空转通过：Task 4 的破坏性对照（直接在容器里把令牌再执行一次，必须判 I2 失败）钉住。
3. 驱动程序自己留下东西：`SIGSTOP` 的 `docker exec` 在服务端被杀后变成孤儿，一直挂着；中途失败的轮次留下容器和卷。Task 4 的清理钉住，并且清理必须按数据目录限定范围，不能波及别的 loop 设备。
4. 假的通过：故障落在什么都没发生的时刻。报告要统计每种故障实际打断了几次工具调用，Task 4 的历史里记录。
5. 快照期间崩溃是最窄的窗口（约 0.3 秒），均匀随机几乎碰不到。时间表要有一部分故障紧跟在发消息之后（0–500 ms），Task 1 钉住。

---

### Task 1: 随机数和故障时间表

**Files:**
- Create: `packages/testkit/src/chaos/schedule.ts`
- Modify: `packages/testkit/src/index.ts`
- Test: `packages/testkit/test/chaos-schedule.test.ts`

**Interfaces:**
- Produces: `type Fault = { at: number; kind: "kill9" | "stall" | "stallThenKill" | "removeContainer"; session: number; holdMs?: number; downMs?: number }`；`planRound(seed: number, round: number, options: { sessions: number; messages: number; durationMs: number; faults: number }): { faults: Fault[]; messageGaps: number[] }`。

- [ ] **Step 1: 写失败的测试**

`same seed and round give the same plan`；`different rounds give different plans`；`at least a quarter of the faults fall 0–500 ms after a message`（对 200 轮统计，Review Focus 5）；`every kind appears over 200 rounds`；`faults are sorted by time`。

- [ ] **Step 2: 运行，确认失败**

Run: `bash m1.sh 'npx vitest run --project unit packages/testkit/test/chaos-schedule.test.ts'`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

随机数用 mulberry32，种子由 `seed` 和 `round` 混合。不用 `Math.random`。`stall` 的 `holdMs` 在 2–40 秒之间，跨过 daemon 30 秒的静默退出；`kill9` 的 `downMs` 在 0–5 秒之间。

- [ ] **Step 4: 运行，确认通过，提交**

Run: 同 Step 2。Expected: PASS。

```bash
git commit -m "test: 混沌测试的随机数和故障时间表"
```

### Task 2: 按对话内容回答的假模型

**Files:**
- Create: `packages/testkit/src/chaos/script.ts`
- Create: `packages/server/test/fixtures/chaos-model.ts`
- Create: `packages/server/test/fixtures/run-chaos-tether.ts`
- Test: `packages/testkit/test/chaos-script.test.ts`

**Interfaces:**
- Consumes: pi-ai faux 的 `FauxResponseFactory`（只在 `server` 的夹具里）。
- Produces: `nextStep(view: { lastUser: string; toolResultsSinceUser: number }): ScriptStep`，`commandFor(token, kind)`；用户消息形如 `chaos:<session>:<message>`，决定这一轮有几次工具调用和令牌。`chaosModels(): Models`。

一轮的工具调用固定是 4 步：`write`（生成 `f-<令牌>.txt`）、`long`（循环写 `tick`，持续 3–8 秒，时长由令牌的哈希决定）、`write`、结束文本。`.chaos/` 由每条命令 `mkdir -p`。容器被恢复后目录可能不在，所以不能假设它存在。

- [ ] **Step 1: 写失败的测试**

`the step depends only on the conversation`；`an interrupted call counts, so the retry gets a new token`；`four tool steps then text`；`a message that is not chaos:* gets a plain answer`（分叉后的 Tether 说明不算用户消息）。

- [ ] **Step 2: 运行，确认失败**

Run: `bash m1.sh 'npx vitest run --project unit packages/testkit/test/chaos-script.test.ts'`
Expected: FAIL。

- [ ] **Step 3: 实现**

`chaos-model.ts` 把 `messages` 转成 `view`：取最后一条用户消息，数它之后的工具结果。队列放 10000 份同一个工厂函数。`run-chaos-tether.ts` 除模型外与 `run-tether.ts` 一致。

- [ ] **Step 4: 运行，确认通过，提交**

Run: 同 Step 2。Expected: PASS。

```bash
git commit -m "test: 混沌测试的假模型，按对话内容回答，重启后接着走"
```

### Task 3: 不变式检查

**Files:**
- Create: `packages/testkit/src/chaos/invariants.ts`
- Test: `packages/testkit/test/chaos-invariants.test.ts`

**Interfaces:**
- Produces: `RoundHistory`（每个会话的 `requestIds`、`submissions`、`transcript`、`streamEntryIds`、`execLog`、`files`、`removedAt`、分叉的 `forks`，以及 `leftovers`）；`checkRound(history: RoundHistory): Violation[]`，`Violation = { invariant: "I0" | ... | "I7"; session?: string; detail: string }`。

- [ ] **Step 1: 写失败的测试**

一份全部成立的历史返回空数组。I0–I7 每条一个违反样例，只报对应的那一条。边界样例：

- `a token started twice is I2`；`a restored session only checks the log after the restore`（设计决定 3 的缺口，不能误报）。
- `a tick of an older token after a newer start is I3`；`a tick before the newer start is fine`。
- `a fork with a file written after the fork point is I6`；`a missing file listed in the note is fine`；`a missing file not in the note is I6`。

- [ ] **Step 2: 运行，确认失败**

Run: `bash m1.sh 'npx vitest run --project unit packages/testkit/test/chaos-invariants.test.ts'`
Expected: FAIL。

- [ ] **Step 3: 实现 `checkRound`，每条不变式一个小函数**

- [ ] **Step 4: 运行，确认通过，提交**

Run: 同 Step 2。Expected: PASS。

```bash
git commit -m "test: 混沌测试的不变式检查"
```

### Task 4: 驱动程序

**Files:**
- Create: `packages/server/test/chaos/driver.ts`（一轮：启动、发消息、注入故障、收集、归档、检查）
- Create: `packages/server/test/chaos/faults.ts`（四种故障，以及清理）
- Create: `packages/server/test/chaos/main.ts`（命令行：`--seed`、`--rounds`、`--from`、`--runtime`、`--storage`、`--keep-failed`）
- Modify: `package.json`（脚本 `"chaos": "node packages/server/test/chaos/main.ts"`）
- Test: `packages/server/test/chaos.docker.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `planRound`，Task 2 的夹具，Task 3 的 `checkRound`，SDK 的客户端和事件流。
- Produces: `runRound(options): Promise<RoundReport>`；`RoundReport` 带种子、时间表、每种故障实际打断的工具调用数、违反列表和耗时。每轮写一行 JSON 到 `<输出目录>/rounds.jsonl`，失败的轮次保留数据目录和服务端日志。

要点：

- 数据目录是 `/data/tether-xfs/chaos/<种子>-<轮号>/`，巡检间隔 2 秒，端口每轮新取。
- 找 `docker exec` 子进程：`pgrep -P <服务端 PID>`，匹配命令行里的容器名。
- 容器里的日志和文件用 `tether cat`、文件浏览接口取，不直接读镜像。
- 分叉检查：每个会话结束后，在随机一条用户条目处分叉，发一条让它列出文件的消息，收集文件列表和说明。
- 清理：杀掉 `SIGSTOP` 的孤儿 `docker exec`；归档失败的轮次，按 `tether-ses_` 名字和这一轮数据库里的会话 ID 删容器和卷，释放镜像路径属于这一轮数据目录的 loop 设备。

- [ ] **Step 1: 写失败的测试**

`a round without faults has no violations`；`a round with one kill9 during a long command has no violations and counts one interrupted call`；`a duplicate execution injected directly into the container is reported as I2`（破坏性对照，`--sabotage duplicate`，Review Focus 2）；`cleanup leaves no container, volume or loop device of the round and keeps loop0`。

- [ ] **Step 2: 运行，确认失败**

Run: `bash m1.sh 'npx vitest run --project docker packages/server/test/chaos.docker.test.ts'`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现驱动程序和故障**

- [ ] **Step 4: 运行，确认通过，再跑类型检查和单元测试**

Run: 同 Step 2，以及 `bash m1.sh 'npm run typecheck && npm run test:unit'`。Expected: 全部 PASS。

如果 `kill9` 的用例因为产品问题失败，这条用例改为断言已知结果，问题记进 rulings，不在这里修产品代码。

- [ ] **Step 5: 提交**

```bash
git commit -m "test: 混沌测试驱动程序"
```

### Task 5: 连续崩溃场景

随机时间表很难碰到 pi 崩溃保护的触发条件，所以单独写一个定向场景。pi 的计数规则是：进程死时处于 `running` 的任务计一次，任务提交新状态后清零，到 5 次就停下。

**Files:**
- Modify: `packages/server/test/chaos/main.ts`（`--scenario crash-loop`）
- Create: `packages/server/test/chaos/crash-loop.ts`

- [ ] **Step 1: 实现场景**

发一条消息，之后连续 8 次：启动服务、等到第一个工具开始或启动后 500 ms（取先到者）、`kill -9`。分别在三个位置试：模型请求的钩子里（存档时）、工具执行中、创建沙箱时。最后一次放它跑完，记录 I0 的结果、日志里有没有 `task_parked`、会话的 `running` 状态和中止请求的行为。

- [ ] **Step 2: 在测试机上运行，把观察写进 rulings**

Run: `bash m1.sh 'npm run chaos -- --scenario crash-loop'`
Expected: 这一步不预设结果。无论任务是否卡住，都记录现象和复现命令。卡住就是下一轮的修复输入，修法下一轮和作者讨论，备选方案记进 rulings：`restartLimit` 设成 `Infinity`、停下时写说明并结束这一轮、启动时重试。

- [ ] **Step 3: 提交**

```bash
git commit -m "test: 混沌测试的连续崩溃场景"
```

### Task 6: 跑全量，写报告

**Files:**
- Create: `docs/acceptance/m4-chaos.md`
- Modify: `docs/superpowers/specs/2026-10-20-tether-design.md`（§11.3：挂起 `docker exec`、新增的 3 条不变式、同一种子的口径）
- Modify: `CHANGELOG.md`、`docs/superpowers/plans/2026-11-05-m4-rulings.md`

- [ ] **Step 1: 量一轮的耗时，按设计决定 7 定轮数**

Run: `bash m1.sh 'npm run chaos -- --seed 1 --rounds 3'`
Expected: 输出每轮耗时和违反列表，3 轮结束后没有残留。

- [ ] **Step 2: 后台跑三组**

Run: `npm run chaos -- --seed 20261105 --rounds <N>`，分别用默认（runc + 镜像模式）、`--runtime runsc`、`--storage directory`。
Expected: 每组结束时输出通过轮数和违反汇总。结果可以是红的，这份计划不要求全绿。

- [ ] **Step 3: 确认测试机干净**

Run: `ssh -n -T admin@tether-m0 "sudo losetup -a; sudo docker ps -a --filter name=tether- -q | wc -l; sudo docker volume ls -q | grep -c '^tether-'"`
Expected: 只有 `loop0`，容器和卷都是 0。失败轮次保留的数据目录分析完再手动删。

- [ ] **Step 4: 写报告并提交**

报告写明：实际轮数和总时长；每种故障实际打断了多少次工具调用；每条不变式的结果；每个问题的现象、复现种子、判断的严重程度；没有覆盖的部分（宿主重启、磁盘写满、OOM、设计决定 3 的缺口）。

```bash
git commit -m "docs: M4 混沌测试报告"
```

- [ ] **Step 5: 独立审查，向作者汇报**

整个分支交给一个新的审查者，附上 Review Focus。修完它提出的驱动程序问题后，把问题清单交给作者，讨论下一轮修哪些。这份计划到此结束，PR 等作者确认后合并。

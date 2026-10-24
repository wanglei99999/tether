# M0 风险验证结论

第一阶段的技术路径没有阻塞点。pi-env daemon 在普通 Docker 容器里通过了全部 29 个一致性用例；pi-durable 通过 `RemoteExecutionEnv` 驱动容器里的工具，崩溃后不重跑；epoch 隔离把"服务端卡住时旧命令继续运行"的 30 秒窗口降到零；工作区挂载加 reflink 的检查点在 500 MB 工作区上打一次快照只要几毫秒。ADR-005、006、007 因此改为已采纳。实测推翻了两处设计细节：本轮运行的标识要用 `LiveDoc.run.inputs[0]`，不能用 `run.taskId`；ext4 上的检查点退路仍是 rsync，overlay 分层不可用。

实验代码在 `spikes/m0/`（分支 `m0-server`，提交 `4e5bce1` 到 `cf62b2c`），是可丢弃的代码。原始数据在测试机的 `~/tether/.tmp/` 下，不进仓库，本文摘录了关键数字。

## 1. 环境

| 项 | 值 |
|---|---|
| 测试机 | 阿里云轻量服务器 `tether-m0`，2 vCPU，可用内存 1.6 GiB，另加 2 GiB swap，40 GiB ESSD 云盘 |
| 系统 | Ubuntu 24.04.2，内核 6.8.0-63，系统盘 ext4 |
| XFS 测试盘 | 8 GiB 文件经 loop 设备挂到 `/data/tether-xfs`，`mkfs.xfs -m reflink=1`。底下还有一层 ext4，耗时会比真实 XFS 数据盘略高 |
| Docker | 29.9.2，cgroup v2，镜像存储是 containerd（`docker info` 的驱动显示 `overlayfs`，不是 `overlay2`） |
| Node | 22.23.4（nvm），`node:sqlite` 可用但打印实验特性警告 |
| 依赖 | `@earendil-works/pi-durable`、`pi-env`、`pi-ai`、`chord` 均为 1.3.0；vitest 5.0.5；typescript 7.0.2 |

每个实验容器带 `tether.m0=1` 标签和 `--cpus 1 --memory 512m --pids-limit 256` 上限。全部测试跑完后，测试机上没有残留的容器、镜像或挂载。

## 2. daemon 在容器内运行（Task 2）

**结论。** `docker exec -i <容器> /opt/tether/launch.sh <epoch> serve --token …` 可以直接作为 `Connection` 的启动命令，不需要额外的桥接。

**证据。** `connection.test.ts` 的 3 个用例：`hello` 在 123 ms 内返回 `linux` / `x86_64`，工作目录 `/workspace`；`launch.sh` 写下的记录 `1.<PID>` 与 daemon 报告的 PID 一致（`exec` 不换 PID）；容器不存在时 `info()` 在 46 ms 内以 `isConnectionLost` 为真的错误结束，不挂起。

**对设计的影响。** pi-env 附带的 linux-x64 daemon 是静态链接的（`static-pie`），计划里担心的"glibc 二进制在 alpine 里起不来"不存在，沙箱模板可以用任何基础镜像。沙箱镜像 `debian:bookworm-slim` 加 `bash coreutils procps git` 共 249 MB。

## 3. env 一致性（Task 3）

**结论。** 29 / 29 通过，没有需要绕开的差异。

**证据。** `conformance.test.ts` 用 `registerEnvConformance(…, { listFiles: true })`，每个用例在容器里 `mktemp -d /workspace/case-XXXXXX` 作为 `cwd`。覆盖二进制读取 5 个、目录遍历 4 个、文件监听 9 个、命令执行 6 个、`listFiles` 5 个。

**对设计的影响。** 计划担心文件监听在容器的 overlayfs 上失效。daemon 以 100 ms 轮询监听，9 个监听用例全部通过，§4.3 选 pi-env 作为执行层的理由成立。

## 4. pi-durable 端到端（Task 4）

**结论。** pi-durable 通过 `env: () => new RemoteExecutionEnv(…)` 把工具调用送进容器；同一个 `requestId` 重开后拿回原提交；工具执行中 harness 进程被杀，重开后这次调用得到中断结果，不重跑。

**证据。** `durable-e2e.test.ts`：

- faux 模型依次调用 `write` 和 `bash`，容器里读出 `from tether11\n`。关闭后用同一个 SQLite 重开、用同一个 `requestId` 再提交，返回的提交 ID 相同，faux 调用次数为 0。
- `crash-child.ts` 在子进程里让 `bash` 执行 `echo started >> runs.txt; sleep 5; echo x >> log.txt`，`runs.txt` 出现后 `SIGKILL` 子进程。重开后这次调用只有一条结果，`isError` 为真，内容是 `Tool bash was interrupted and may have partially run`；`runs.txt` 只有一行；faux 只被调用一次（中断之后的那一轮）。数据：`.tmp/e2e-crash-observation.json`。

**对设计的影响。** §8.1 描述的"至多执行一次"语义在容器执行下成立。这次 `log.txt` 没有出现：子进程被杀后 `docker exec` 客户端随之退出，daemon 读到 EOF，杀掉了旧命令。这只覆盖了进程退出的情况，连接卡住的情况见第 5 节。

## 5. 崩溃窗口与 epoch 隔离（Task 5）

**结论。** 持有连接的进程被挂起时，旧命令会再运行 30 秒左右；通过 `ConnectionOptions.command` 函数在每次启动 daemon 之前执行 `kill -KILL -1`，这个窗口降为零。ADR-007 成立。

**证据。** `orphan.test.ts`。holder 子进程执行 `sleep 300; echo late > late.txt` 后，分别发送两种信号，在 1、10、40 秒检查容器（数据：`.tmp/orphan-observation-*.json`）：

| 信号 | 模拟的情况 | 1 秒 | 10 秒 | 40 秒 |
|---|---|---|---|---|
| `SIGKILL` | 服务端进程退出 | 旧 daemon、旧命令都已结束 | 已结束 | 已结束 |
| `SIGSTOP` | 服务端卡住，管道未关闭 | 都还在运行 | 都还在运行 | 已结束（daemon 30 秒静默超时） |

隔离用例：holder 被 `SIGSTOP` 后立即用 `fencedCommand` 建立新连接。新连接上的命令正常完成；`pgrep -f '[s]leep 300'` 找不到旧命令；`/run/tether/daemons/` 只剩 `2.<PID>`；35 秒后 `late.txt` 不存在，新连接仍可用。一次隔离调用三次 docker CLI（`docker inspect`、检查 PID 1 的 `docker exec`、清理脚本的 `docker exec`），连续测 10 次耗时 253–272 ms，中位数 264 ms。它只发生在建立连接时，不在每次工具调用上。

**对设计的影响。**

- §8.2 末尾"要么包装 `Connection`，要么禁用自动重启"的二选一不再需要。`Connection` 每次启动 daemon 前都会调用 `command` 函数，隔离放在这个函数里，不修改 pi-env。
- `kill -1` 在共享宿主 PID 命名空间的容器里会杀掉宿主上的进程。实现里有两道检查：宿主侧 `assertPidIsolated()` 检查 `HostConfig.PidMode` 为空且容器内 PID 1 是容器自己的 init；容器内的脚本在 kill 之前再检查一次 `/proc/1/comm`。防护测试只调用检查函数，不对 `--pid=host` 容器执行 `fence`。
- 判断进程是否存活时，`docker exec sh -c "pgrep -f 'sleep 5'"` 会匹配到执行 pgrep 的 sh 自己。Task 4 第一次运行就因此在命令开始前杀掉了子进程。用 `[s]leep` 写法或标记文件判断。M4 的混沌测试要沿用这个做法。

## 6. 检查点（Task 6）

**结论。** reflink 的快照和恢复耗时与工作区大小无关，空间只随改动增长，ADR-006 的首选成立。docker commit 比 ADR-006 估计的还贵。overlay 分层因为正确性问题被排除，ext4 上的退路仍是 rsync。

**证据。** `checkpoint.test.ts` 的 7 个用例。

docker commit 对同一个容器连续提交三次（50 MB 大文件加每次改写 1 MB），三层的大小都是 53.5 MB（`.tmp/checkpoint-commit-layers.json`）。ext4 系统盘不支持 reflink，XFS 测试盘支持（`.tmp/checkpoint-fs.json`）。reflink、rsync、overlay 三种工作区做法都满足：恢复出的工作区里文件是快照时的版本，原来的后台进程不在，改恢复出的工作区不影响快照。

成本测量对每种做法连续打 3 次快照，第 2、3 次之前各改动一次，改动分两种：新写一个 2 MiB 文件，或在大文件中间原地改写 2 MiB。下表是 500 MiB 工作区的数字（`.tmp/checkpoint-timing.json`）：

| 做法 | 每次快照 | 恢复 | 3 次快照新增空间，新文件改动 | 3 次快照新增空间，原地改动 |
|---|---|---|---|---|
| reflink（XFS） | 7–9 ms | 5 ms | 4.0 MiB | 4.1 MiB |
| rsync（ext4） | 新写文件：第一次 2468 ms，之后 63–238 ms；原地改动：每次 5.7–7.0 s | 2.2–5.4 s | 508 MiB | 1500 MiB |
| overlay 分层（ext4） | 43–56 ms | 57–67 ms | 4.0 MiB | 1000 MiB |
| docker commit | 13–16 s | 337–357 ms | 3016 MiB | 3000 MiB |

0 MiB 和 50 MiB 两档的趋势相同：reflink 在三档上的快照耗时都在 5–9 ms，rsync 的第一次快照和恢复与工作区大小成正比。

overlay 分层的问题来自 `pins that a running process keeps writing into a layer frozen by a lazy unmount` 这个用例：容器里有进程开着工作区里的文件时，普通 `umount` 报 `target is busy`；改用 `umount --lazy` 后，那个进程继续写进已经冻结的层，2 秒内 `log.txt` 从 12 字节涨到 32 字节，内核日志报 `lowerdir is in-use as upperdir/workdir of another mount, accessing files from both mounts will result in undefined behavior`（`.tmp/checkpoint-overlay-frozen.json`）。要得到可靠的快照，必须先结束占用工作区的进程，与 `perRun` 不打断后台服务的要求冲突。

**对设计的影响。**

- 在 containerd 镜像存储下，docker commit 每提交一次占用约两倍层大小（50 MiB 工作区 3 次提交新增 316 MiB，500 MiB 新增 3016 MiB）。原因推测是同一层同时存了压缩的内容和解压后的快照，没有深究，因为结论不受影响。
- 默认保留 5 个检查点：在 reflink 上，保留数的代价只是改动量，5 个没有问题。在 rsync 上，项目里有大文件且经常原地修改时，每个检查点可能复制整个文件（500 MiB 文件 3 个检查点占 1.5 GiB）。§8.3 改为：reflink 默认保留 5 个；rsync 默认保留 5 个，但 README 写明这个代价，并推荐把工作区放在 XFS 数据盘上。
- 沙箱以普通用户运行。Task 6 的容器用宿主测试用户的 `uid:gid` 运行（`--user`），否则容器里以 root 写下的文件，宿主上的非 root 进程既无法完整复制也无法删除。正式实现中，Tether 管理工作区目录时也会遇到同样的问题，所以沙箱默认以非 root 用户运行，并与工作区目录的属主一致。

## 7. 运行开始钩子与自定义条目（Task 7）

**结论。** `beforeRequest` 能识别"这一轮"以及触发它的用户条目，但要读 `LiveDoc`，并且要用对字段。`tether.*` 条目带 `model` 字段时模型可见，不带时只留在记录里。ADR-005 成立。

**证据。** `hooks.test.ts`。`HookApi` 只能读文档（`snapshot` / `snapshotAsOf`），读不到条目；generation 任务的输入是空对象。改为在钩子里读 `api.snapshot(LiveDoc, api.conversationId, context)`。第一轮两次请求、第二轮一次请求读到的值：

| 字段 | 第 1 轮第 1 次 | 第 1 轮第 2 次 | 第 2 轮 |
|---|---|---|---|
| `run.taskId` | 9 | 14 | 18 |
| `run.inputs[0]` | 8 | 8 | 17 |

`run.taskId` 与 `api.taskId` 相同，是当前 generation 任务，每个模型回合都换。`run.inputs[0]` 等于两次 `submit` 返回的提交 ID，同一轮内不变。提交记录在 `placed` / `done` 状态下带 `entry` 字段，就是本轮的 `pi.user` 条目。另外，一轮的第一次请求以 `user` 消息结尾，之后的请求以 `toolResult` 结尾。

可见性用例依次提交 `tether.sandbox`（只有 `data`）、`tether.note`（带 `model: [{ role: "user", content: "工作区已重置" }]`）和一条输入。三条条目按提交顺序出现在记录里；发给模型的消息包含"工作区已重置"，不包含 `tether.sandbox` 的任何内容。

**对设计的影响。**

- `perRun` 检查点以 `run.inputs[0]`（提交 ID）为键，在 Tether 的应用存储里查是否已经为这一轮打过快照，没有才打。键在崩溃恢复后不变，`beforeRequest` 因重试或恢复被再次调用时不会重复打快照。`checkpoints.entryId` 在快照完成后由提交记录的 `entry` 填入。
- §4.2 AgentEngine 的"运行开始钩子带上对齐用的条目 ID"改为"带上触发本轮的提交 ID，由它解析出条目 ID"。
- 引导式输入（`whenBusy: "steer"`）会往运行中的一轮追加输入，`run.inputs[0]` 是否保持为第一条，M0 没有测，M3 实现检查点时补一个用例。

## 8. 阻塞点

无。

## 9. 对 M1 的输入

- **引擎适配器的组装方式**：`spikes/m0/harness.ts` 是 `engine-pi` 适配器的雏形。`Harness.open(storage, { models, registry, env }, context)` 之后用 `harness.root(context, { agent: { model, cwd } })` 拿会话；`env` 工厂每次调用工具时执行，同一个 `Connection` 可以被多个 `RemoteExecutionEnv` 实例共用。
- **输入可以放成自定义条目**：`submit({ type: "input", entry: { kind, data } })` 让用户输入以应用自己的 `kind` 出现在记录里（`kind` 不能以 `pi.` 开头），模型看到的仍是用户消息。如果 Tether 需要在用户消息上带作者、来源之类的信息，用这个字段，不必另写条目。
- **`run.taskId` 不是运行标识**：见第 7 节。
- **非 root 沙箱**：容器以与工作区目录属主相同的 `uid:gid` 运行，见第 6 节。
- **测试中判断进程存活**：不能用会匹配自身的 `pgrep -f` 模式，见第 5 节。
- **SQLite**：Node 22 的 `node:sqlite` 可用，会打印实验特性警告；应用存储选 `node:sqlite` 时要在启动时屏蔽这条警告，或者改用 `better-sqlite3`。

# Changelog

Tether 还没有发布版本号，按里程碑记录。每个里程碑合进 `main` 时定稿；`[未发布]` 是正在进行的里程碑，随任务完成追加。只记使用者能感知的变化：API、命令、配置、数据目录、行为和已知限制。设计上的取舍见 `docs/adr/`。

## [未发布]：M3 检查点与分叉

计划：`docs/superpowers/plans/2026-10-28-m3-checkpoints-and-forks.md`。

### 变更

- 工作区的存法（ADR-011，M3 结束时写）：数据目录在支持 reflink 的文件系统上时（例如 XFS `reflink=1`），每个会话的工作区是一个 XFS 镜像文件 `workspaces/<会话>/disk.img`，经 loop 设备和 Docker 卷挂成 `/workspace`；否则仍是 M2 的宿主目录挂载，并在启动时打印一条警告。启动时自动选择，也可以用 `TETHER_WORKSPACE_STORAGE` 指定。镜像模式下宿主上看不到工作区里的单个文件，要用 `tether files`、`tether cat` 或文件浏览 API。
- 镜像模式需要的 `losetup` 由一次性的 `--privileged` 容器执行；Tether 进程本身仍以普通用户运行，不需要 sudo。
- `tether.sqlite` 升到第 2 版（新增 `checkpoints` 表，`sandbox_bindings` 增加 `reason` 列）。第 1 版的库在启动时自动迁移，数据保留。

### 新增

- `sandbox.resources.diskMb` 在镜像模式下生效：镜像的大小就是工作区的磁盘上限，写满时工具得到 "No space left on device"，宿主盘不受影响。最小 300（`mkfs.xfs` 的下限），小于它在创建 agent 版本时报 `invalid_request`。目录模式下仍然拒绝这个字段。
- 工作区快照（还没有 API，Task 5 起由每轮存档使用）：运行中的沙箱先 `docker pause` 再复制，存下的是暂停那一刻的一致状态，之后照常运行；后台进程会被冻结约 0.3 秒。快照只含 `/workspace`，不含进程和内存。镜像模式克隆 `disk.img`，目录模式用 `rsync --link-dest`（主机上需要 `rsync`）。快照在 `<数据目录>/checkpoints/<会话>/`。
- 配置 `TETHER_WORKSPACE_STORAGE`（`auto`、`image`、`directory`，默认 `auto`）和 `TETHER_DEFAULT_DISK_MB`（没填 `diskMb` 时镜像的大小，默认 10240，镜像是稀疏文件，不预占）。存档目录固定为 `<数据目录>/checkpoints`，必须和 `workspaces/` 在同一个文件系统上。

### 升级注意

- 从 M2 升级、数据目录又在 XFS 上时，M2 建的会话工作区还是目录，新代码会按镜像模式找 `disk.img`。目前没有正式部署，M3 不做迁移；升级前请归档全部会话，或者设 `TETHER_WORKSPACE_STORAGE=directory`。

## M2 沙箱生命周期：2026-10-27

PR #3，合并提交 `d32f761`。决定见 ADR-010。

### 新增

- 闲置停止：会话不在运行、沙箱超过 `TETHER_STOP_AFTER_SECONDS`（默认 3600）没被用过，巡检停止容器，文件保留，并写一条模型可见的说明；会话状态变成 `idle`，下一次工具调用重新启动容器。巡检间隔 `TETHER_SWEEP_INTERVAL_SECONDS`（默认 60）。
- 准入控制：运行中和创建中的沙箱数上限 `TETHER_MAX_RUNNING_SANDBOXES`（默认 4）。超过时工具调用失败，HTTP 错误码 `sandbox_limit`（503），会话记录里有一条 `tether.admission`。
- epoch 隔离（ADR-007）：连接沙箱里的 daemon 之前，先杀掉旧连接留下的全部进程；重连时告诉模型后台进程已结束。
- 丢失重建：容器被删掉后，巡检把绑定标成 `lost`，下一次工具调用按模板重建并重新执行 `setup`，告诉模型原来的文件和进程都没了。
- 会话归档：`POST /v1/sessions/:id/archive`、SDK `sessions.archive`、CLI `tether session archive`。先标记 `archived`，再中止当前运行，最后删除容器和工作区。
- 文件浏览：`GET /v1/sessions/:id/sandbox/files?path=`、`/sandbox/file?path=`，CLI `tether files`、`tether cat`。路径解析后必须在 `/workspace` 下，单个文件最大 10 MiB。
- 可选 gVisor：`TETHER_SANDBOX_RUNTIME=runsc`。

### 变更

- 沙箱容器加 `--cap-drop ALL`、`no-new-privileges`，PID 1 固定为 `sleep`（模板镜像的 `ENTRYPOINT` 和 daemon 的 `init` 设置不再生效）。
- `diskMb`、非空的 `requireApproval`、`checkpointPolicy: "perRun"` 填了直接报 `invalid_request`，不再悄悄忽略。
- 启动恢复不再在引擎续跑之前写会话条目。

### 已知限制

- `network: "egress"` 的沙箱能访问云厂商的元数据地址，需要在宿主防火墙上拦截。
- 会话锁和准入锁只在一个进程内有效，一台 Docker 主机只能跑一个 Tether。
- 在一轮运行中途写下的说明，模型要到下一轮才看到。

## M1 运行时核心：2026-10-25

PR #2，合并提交 `c480374`。第一个能用的版本。

### 新增

- 服务端：`node packages/server/src/main.ts`，`--build-sandbox` 构建沙箱镜像。配置从 `TETHER_*` 环境变量读，`TETHER_TOKEN` 设置后除 `/v1/health` 外都要 Bearer token。
- Agent 定义与版本：版本不可变，会话固定在创建时的版本上。
- 会话：带变量创建（变量以环境变量传给 `setup`，不拼进命令）；发消息带 `requestId`，重复提交不会执行两次；会话忙时按 `whenBusy`（`followUp`、`steer`、`reject`）处理；中断。
- 事件流：`GET /v1/sessions/:id/events`（WebSocket），先发完整快照，再发增量；断线重连拿新的快照。
- 崩溃续跑：服务进程被 `kill -9` 后重启，未完成的提交从断点继续，正在执行的工具调用得到"已中断"的结果，不重跑。
- 沙箱：每个会话一个 Docker 容器，第一次工具调用时才创建，`setup` 命令在那时执行（`TETHER_SETUP_TIMEOUT_SECONDS`，默认 600）。内置工具 `read`、`write`、`edit`、`bash` 在容器里执行，模型凭据不进容器。
- TypeScript SDK（自动重连的事件流）和命令行工具 `tether`（`agent`、`session`、`send --follow`、`sandbox`）。

## M0 风险验证：2026-10-24

PR #1，合并提交 `8bcd0dc`。实验代码在 `spikes/m0/`，没有使用者能用的功能。结论见 `docs/m0-findings.md`：pi-env daemon 能在 Docker 容器里通过 `docker exec` 工作，pi-durable 崩溃后不重跑工具，epoch 隔离有效，reflink 检查点的耗时与工作区大小无关。

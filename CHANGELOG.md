# Changelog

Tether 还没有发布版本号，按里程碑记录。每个里程碑合进 `main` 时定稿；`[未发布]` 是正在进行的里程碑，随任务完成追加。只记使用者能感知的变化：API、命令、配置、数据目录、行为和已知限制。设计上的取舍见 `docs/adr/`。

## [未发布]：M3 检查点与分叉

计划：`docs/superpowers/plans/2026-10-28-m3-checkpoints-and-forks.md`。

### 变更

- 工作区的存法（ADR-011，M3 结束时写）：数据目录在支持 reflink 的文件系统上时（例如 XFS `reflink=1`），每个会话的工作区是一个 XFS 镜像文件 `workspaces/<会话>/disk.img`，经 loop 设备和 Docker 卷挂成 `/workspace`；否则仍是 M2 的宿主目录挂载，并在启动时打印一条警告。启动时自动选择，也可以用 `TETHER_WORKSPACE_STORAGE` 指定。镜像模式下宿主上看不到工作区里的单个文件，要用 `tether files`、`tether cat` 或文件浏览 API。
- 镜像模式需要的 `losetup` 由一次性的 `--privileged` 容器执行；Tether 进程本身仍以普通用户运行，不需要 sudo。
- 丢失重建改为从存档恢复：沙箱被删掉后，下一次工具调用从会话最近的一张存档建新沙箱（自己还没有存档的分叉会话用分叉时选中的那张），不再执行 `setup`，并告诉模型工作区还原到了那张存档、之后执行过的哪些操作不在里面（最多 20 条）。没有存档或最近的存档是模板时，仍按 M2 的方式按模板重建。`tether.sandbox` 条目的 `data.checkpointId` 记下用的是哪一张。
- 沙箱停止时，会话只有在没有一轮正在运行时才改为 `idle`（M2 里无条件改）。
- 模板镜像在准入之前准备好：本地没有就先 `docker pull`（上限 `TETHER_IMAGE_PULL_TIMEOUT_SECONDS`，默认 600），拉取期间别的会话照常创建和启动沙箱。拉取失败报 `sandbox_failed`（"cannot pull image …"）。M2 里拉取发生在 `docker run` 里、占着全局准入锁。
- docker 调用加了上限：默认 120 秒，超时杀掉 docker 命令行进程，报 `sandbox_failed`（"docker <子命令> timed out after … s"）。`--build-sandbox` 不限。
- setup 失败、容器又没删掉（丢失原因 "cleanup failed"）的沙箱计入运行中的名额，它的容器可能还在跑。
- 丢失原因写进数据库：M2 里原因只在内存中，服务重启后说明里一律写 "missing"；现在重启后仍是原来的原因。
- `tether.sqlite` 升到第 2 版（新增 `checkpoints` 表，`sandbox_bindings` 增加 `reason` 列）。第 1 版的库在启动时自动迁移，数据保留。

### 新增

- `sandbox.resources.diskMb` 在镜像模式下生效：镜像的大小就是工作区的磁盘上限，写满时工具得到 "No space left on device"，宿主盘不受影响。最小 300（`mkfs.xfs` 的下限），小于它在创建 agent 版本时报 `invalid_request`。目录模式下仍然拒绝这个字段。
- 每轮存档：`checkpointPolicy: "perRun"` 可以用了。用户每发一条消息、模型开始干活之前，给工作区存一张档，对齐到这条消息的条目；同一轮只存一次，重试和崩溃恢复不会重复存。会话还没有沙箱时只记一条"模板"存档，不复制任何东西。会话记录里每次存档有一条客户端可见的 `tether.checkpoint`（`data.checkpointId`、`entryId`、`durationMs`；模板存档带 `template: true`）。存档失败不打断这一轮，`tether.checkpoint` 里带 `error`。
- 会话分叉：`POST /v1/sessions/:id/fork`（body `{ entryId }`）、SDK `sessions.fork`、CLI `tether session fork <会话> <条目>`。新会话用同一个 agent 版本和变量，对话到这一条为止，原会话不变。工作区取自这一刻最近的存档：分叉点之后的下一张存档之前没有执行过 `write`、`edit`、`bash` 就用它，否则用分叉点之前最近的一张；自己没有就沿分叉来源往上找。新会话里有一条模型可见的 `tether.fork` 说明：工作区已还原（进程不在）；存档早于分叉点时列出中间没有发生的操作，最多 20 条；找不到存档时说明工作区是模板。沙箱仍在第一次工具调用时创建，从存档建的不再执行 `setup`。条目不在会话里报 `invalid_request`，已归档的会话报 `conflict`。
- 闲置删除：停止的沙箱从最后一次使用起超过 `TETHER_DESTROY_AFTER_SECONDS`（默认 604800，即 7 天，必须大于 `TETHER_STOP_AFTER_SECONDS`，否则启动报错）没被用过，巡检先存一张最终存档（对齐到会话最新的一条记录，`tether.checkpoint` 带 `final: true`；存档策略为 `none` 的会话不存），再删除容器和工作区，绑定变成 `lost`，原因是 "removed after 7 days without activity"。这一步只写客户端条目；下次工具调用从最终存档恢复时，模型才收到说明。最终存档失败也照样删除，恢复时用更早的存档。
- 存档清理：会话归档后删除它的存档，被未归档的分叉会话引用的那张保留，到引用它的最后一个分叉也归档时再删。几条存档记录共用一张快照时（沙箱丢失的那一轮沿用上一张），最后一条记录删掉才删快照文件。
- 稀疏化：存档所在的盘空闲低于 `TETHER_CHECKPOINT_MIN_FREE_PERCENT`（默认 10，设为 0 不稀疏化）时，每次巡检后一张一张删存档，空闲回到下限以上就停。最久没活动的会话先删；每个会话最新 5 张不动；更早的先删序号不是 10 的倍数的。被分叉引用的和模板存档不删。每删一张记一条日志，不写进会话。
- 启动对账：存到一半的快照文件、没有存档记录的快照文件删除；快照文件已经不在的存档记录删除；镜像模式下没有容器的会话，释放它的 Docker 卷和 loop 设备（镜像文件保留，丢失重建时再删）。只看本实例 `workspaces/` 下的会话，宿主上别的 loop 设备不动。
- 列出存档：`GET /v1/sessions/:id/checkpoints`、SDK `sessions.checkpoints`、CLI `tether checkpoints <会话>`，从旧到新，模板存档的 `snapshotId` 为 `null`。
- 工作区快照：运行中的沙箱先 `docker pause` 再复制，存下的是暂停那一刻的一致状态，之后照常运行；后台进程会被冻结约 0.3 秒。快照只含 `/workspace`，不含进程和内存。镜像模式克隆 `disk.img`，目录模式用 `rsync --link-dest`（主机上需要 `rsync`）。快照在 `<数据目录>/checkpoints/<会话>/`。
- 配置 `TETHER_WORKSPACE_STORAGE`（`auto`、`image`、`directory`，默认 `auto`）和 `TETHER_DEFAULT_DISK_MB`（没填 `diskMb` 时镜像的大小，默认 10240，镜像是稀疏文件，不预占）。存档目录固定为 `<数据目录>/checkpoints`，必须和 `workspaces/` 在同一个文件系统上。

### 修复

- 镜像模式下容器在 Tether 之外被删掉后，Docker 卷和容器同名（`tether-<会话>`），状态查询读到卷而报错，巡检永远标不成 `lost`。查容器的 `docker inspect` 一律限定 `--type container`（M3 端到端验收发现，`docs/acceptance/m3.md`）。
- 删掉一个会话的最后一张快照时，连同 `checkpoints/<会话>/` 目录一起删除。
- 目录模式的快照可能混进上一张的旧文件：`rsync --link-dest` 默认按整秒比较修改时间，同一秒内改过、长度没变的文件被当成没改，链接到上一张快照的旧内容。改为连纳秒一起比较（`--modify-window=-1`）。在 gVisor 下跑 Docker 测试时发现（目录模式的一致性用例 15 次失败 2 次），runc 下同样会发生。

- 沙箱丢失后开始的那一轮、分叉会话的第一轮，存档记录沿用更早的快照，却对齐到这一轮的用户条目；丢失恢复和分叉按它算"没有发生的操作"，会告诉模型什么都没丢。存档记录增加 `basisCheckpointId`，这种记录查找时跳过，用它沿用的那条（最终审查发现）。
- 存档失败后，同一轮后面的模型请求会再存一次，存下的是这一轮工具改过的状态。失败时记一条 `failed` 的存档记录挡住同一轮，查找时跳过它。
- 存档到一半进程崩溃（或 `unpause` 失败）留下的 paused 容器，之后每次启动都被 Docker 拒绝。启动时遇到 paused 改为 `unpause`；存档前一律 `sync`，`sync` 有 120 秒上限。
- 稀疏化不删和别的记录共用快照的存档（删了省不出空间）。

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

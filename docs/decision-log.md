# 决定记录

按日期记录 Tether 每个阶段的设计决定、理由和改过主意的地方，供以后回看"当时为什么这么定"。设计细节以 [设计文档](superpowers/specs/2026-10-20-tether-design.md) 为准，这里只记结论和来由。决定背后的原理写在 [Agent基础设施](https://github.com/wanglei99999/learn_note/tree/main/Agent基础设施) 笔记系列里。

## 2026-10-20 立项

**定位。** 一开始的想法是"开源版的后台编码 agent"（类似 Codex Cloud）。讨论后定位改成更通用的一层：服务端 agent 运行时，负责会话持久化与崩溃续跑、执行沙箱、实时事件流、agent 定义与版本。豆包、ChatGPT 网页版、企业内部 agent 都需要这一层。以后的"多 agent 管理 App"作为第一个正式客户端，另外立项，只通过公开 API 使用运行时。

**两阶段。** 第一阶段用 pi 的现成包（pi-durable、pi-env）拼出完整系统；第二阶段保留 pi-ai 和 agent 循环，把执行 daemon、沙箱后端、持久化引擎、事件同步逐个换成自己写的实现。为此每一层前面都要有 Tether 自己的接口和一套一致性测试，pi 的实现是"参照答案"。

**harness 不进沙箱。** 多租户的服务端场景下，凭据、会话状态、资源占用三条边界都更容易守住。代价是每次工具调用都要跨一次进程边界，以及会话和沙箱两份状态要对齐。见笔记[harness 的位置](https://github.com/wanglei99999/learn_note/blob/main/Agent基础设施/02-harness的位置.md)。

**沙箱后端。** 先考虑过 E2B 云服务和 CubeSandbox（腾讯开源，兼容 E2B API，基于 RustVMM）。E2B 云服务付费且有跨境延迟；E2B 自部署依赖 Terraform、PostgreSQL、Redis、ClickHouse，太重；CubeSandbox 需要 KVM 或 PVM、XFS 和较大的磁盘。最后决定第一阶段只做 Docker，"先做简单的，跑通再深入"。接口按以后能接 E2B、Cube、Firecracker 来设计。见笔记[沙箱后端](https://github.com/wanglei99999/learn_note/blob/main/Agent基础设施/07-沙箱后端.md)。

**范围。** 认证、多租户、多 agent 协作、App 都不在第一阶段。数据模型里预留 `ownerId` 和 `parentSessionId`。服务只在内网访问。

## 2026-10-21 架构细化

**五个包。** `core`（领域模型和端口接口，零外部依赖）、`testkit`（一致性测试和混沌测试）、`server`（适配器按目录划分，加 HTTP/WS 和组装）、`sdk`、`cli`。一度压到三个包，后来发现砍过头了：`core` 和 `testkit` 的独立性要靠包依赖来保证，不能只靠 lint。

**单一事件源。** 沙箱状态、检查点、各种说明都写成 `tether.*` 条目，和模型的回答走同一条提交线，不另设事件通道。

**闲置两档。** 闲置 1 小时停止容器、7 天删除。曾经想直接停止，理由是"闲置时没有进程在跑"，这个理由是错的：agent 常用 `npm run dev &` 启动后台服务。停止时必须写一条模型可见的说明。

**审批工具放回第一阶段。** 曾经被推迟，后来恢复：崩溃后审批请求仍在、批准后只执行一次，是持久化执行的典型问题，也是这个项目要学的内容。

**补上工作区初始化。** agent 版本配置 `setup` 命令（例如克隆仓库），会话创建时传入的变量以环境变量的形式交给这些命令，不做字符串拼接。

**检查点改用工作区挂载 + reflink。** 原方案是 `docker commit`。分析后发现同一个容器反复提交，每一层都包含容器创建以来的全部改动，五个检查点可能占掉几 GB。调研了 Replit、Fly.io、Modal、CubeSandbox 的做法后，改成工作区挂载到宿主目录，支持 reflink 时用 `cp --reflink`，不支持时退回 `rsync --link-dest`。见笔记[沙箱检查点](https://github.com/wanglei99999/learn_note/blob/main/Agent基础设施/06-沙箱检查点.md)。还待 M0 实测。

**epoch 隔离的两处修正。** 读 pi-env 协议时发现：daemon 在标准输入结束时会立即退出，30 秒静默只是另一种退出条件；daemon 给每个命令单独开会话，按 daemon 的会话杀不到命令。隔离改成在新 daemon 启动前，在容器里执行 `kill -KILL -1`，前提是一个容器只有一条连接。插入点是 `ConnectionOptions.command` 函数，不用修改 pi-env。见笔记[崩溃后的旧进程](https://github.com/wanglei99999/learn_note/blob/main/Agent基础设施/05-崩溃后的旧进程.md)。

**开发环境。** 开发机是 Windows 10，WSL 不用。Windows 上有 Node 24.9.0（nvm4w），没有 Docker。M0 的运行环境还没定。

## 待办

- 确定 M0 的运行环境（需要能跑 Docker 的 Linux）。
- 执行 M0 的 8 个任务，结论写进 `docs/m0-findings.md`，再回填到相关笔记。
- M0 之后写 M1 的实现计划。

# Tether：服务端 Agent 运行时设计

> 状态：草案，待 wangl 审阅
> 日期：2026-10-20
> 名称 `Tether` 是暂定的工作名（我的决定），寓意"harness 留在服务端，沙箱被拴在远端"，可以随时改。

## 1. 这是什么，为什么做

Tether 是一个可以自托管的**服务端 agent 运行时**。它负责把 agent 跑在服务器上需要的那套机制：会话持久化与崩溃续跑、隔离的执行沙箱、实时事件流、agent 定义与版本管理。对外只暴露 HTTP/WebSocket API 和一个 TypeScript SDK。

动机（来自讨论）：

- 豆包、ChatGPT 网页版、企业内部 agent，凡是部署在服务端的 agent 都需要这一层。它是通用基础设施，不绑定某一种 agent 或某一个前端。
- 作者想通过这个项目亲手掌握 harness 的底层知识：任务沙箱、持久化执行、远程执行协议、状态同步。
- 这是作者 GitHub 上的重要作品，设计质量和可讲述性与"能跑"同等重要。

以后会有一个"多 agent 管理 App"作为第一个正式客户端，单独立项。它只通过公开 API 使用 Tether，不碰内部实现。

## 2. 两阶段路线

**第一阶段：用 pi 现成的包拼出完整系统。** 持久化用 `pi-durable`，沙箱内执行用 `pi-env` 的 daemon，沙箱生命周期先用 Docker（作者的决定：先做简单的，跑通再深入），E2B / CubeSandbox 作为后续可选后端，agent 循环和模型接入用 `pi-durable` 自带的部分和 `pi-ai`。目标是端到端跑通、所有行为测试通过。

**第二阶段：保留 `pi-ai`（模型接入）和 `pi-agent` 级别的 agent 循环，把下面几层逐个换成自己写的实现**，上游代码只作参考，不复用：

1. 沙箱内执行 daemon（替换 `pi-env`）
2. 沙箱后端（Firecracker microVM，作为 E2B / CubeSandbox 之外的第三种）
3. 持久化执行引擎（替换 `pi-durable`）
4. 事件同步（支持断线续传，见 §7.3）

两阶段之所以可行，靠两条硬约束（见 §4）：每一层前面都有 Tether 自己的接口；每一层都有一套与实现无关的行为测试。第一阶段 pi 的实现是"参照答案"，第二阶段自己的实现必须通过同一套测试。

## 3. 目标、非目标、反目标

### 目标（第一阶段）

- **Agent 定义**：用户可以创建多个角色不同的 agent（提示词、模型、工具、沙箱模板、权限），带版本号。
- **会话**：同一个 agent 可以同时开多个会话；会话固定在启动时的 agent 版本上。
- **持久化续跑**：服务端进程被 `kill -9` 后重启，未完成的会话从断点继续；同一个用户请求不会被执行两次。
- **执行沙箱**：harness 不进沙箱。每个会话绑定一个沙箱，工具在沙箱里执行；模型 API key 等凭据永远不进沙箱。
- **沙箱生命周期**：创建、闲置暂停、按需恢复、过期重建、会话结束回收。
- **快照与分叉**：在支持的后端上，会话检查点与沙箱快照对齐；分叉会话时沙箱也一起分叉。
- **实时事件流**：多个客户端可以同时订阅同一个会话；断线重连后拿到当前完整状态。
- **可替换性**：第一阶段只实现 Docker 后端（runc，可选 gVisor），但 SandboxProvider 接口按"E2B / CubeSandbox / Firecracker 以后都能接进来"来设计：能力用显式标志声明，core 不假设任何后端特有的行为。E2B、CubeSandbox 适配器是第一阶段之后的可选项（§14）。
- **可验证性**：混沌测试（随机时间点杀进程、断网）作为一等公民，结果写进 README。

### 非目标（明确以后再做）

- 认证、多用户注册、多租户隔离、配额。第一版是单用户部署，但所有资源带 `ownerId` 字段，为以后扩展留口子。
- 多 agent 协作（主 agent 派任务给子 agent）。数据模型里预留 `parentSessionId`，第一版不使用。
- 多 agent 管理 App。第一阶段只提供一个开发用的简易查看页（§9），不是产品。
- harness 进沙箱的执行模式。
- 水平扩展。`pi-durable` 的约束是"一个进程独占一份存储"，第一版就是单进程、单机。
- Windows 沙箱。

### 反目标（技术上能跑，但出现就算失败）

- **变成 E2B SDK 的薄包装。** 价值在于持久化与沙箱的交界处（§8），不在于转发 API。
- **上层代码直接依赖 pi 的实验性 API。** `pi-durable` 标着 experimental、API 随时会变；pi 的类型只允许出现在适配层。
- **没有测试支撑的可靠性声明。** README 里每一条"崩溃安全""不会重复执行"都要对应一个能复现的测试。
- **抄厂商的性能数字。** 只写自己在自己服务器上测出来的数据。

## 4. 架构

### 4.1 总体结构

```text
            客户端（SDK / CLI / 查看页 / 以后的 App）
                        │  HTTP + WebSocket
┌───────────────────────▼─────────────────────────────┐
│ api        路由、请求校验、WebSocket 事件推送        │
├─────────────────────────────────────────────────────┤
│ core       Agent 定义、会话、版本固定、检查点策略    │  ← 只依赖下面的接口
├──────────────┬──────────────────┬───────────────────┤
│ AgentEngine  │ SandboxProvider  │ ExecChannel       │  ← Tether 自己定义的三个接口
├──────────────┼──────────────────┼───────────────────┤
│ 阶段1:       │ 阶段1:           │ 阶段1:            │
│ pi-durable   │ Docker/E2B/Cube  │ pi-env daemon     │
│ 阶段2: 自研  │ 阶段2: +Firecracker│ 阶段2: 自研 daemon│
└──────────────┴──────────────────┴───────────────────┘
        │                  │                  │
   SQLite 存储        沙箱后端 API      沙箱内的字节管道
```

### 4.2 三个接口（替换点）

**AgentEngine**：持久化的 agent 执行引擎。职责：创建会话、提交输入（带幂等 `requestId`）、中断、分叉、订阅事件、进程重启后恢复。第一阶段实现是对 `pi-durable` 的 `Harness` / `Conversation` 的适配。

**SandboxProvider**：沙箱生命周期，不负责执行。职责：按模板创建、按 ID 重连、暂停、恢复、销毁；提供一条到沙箱内 daemon 的**字节管道**；可选能力：快照、从快照创建、原地回滚、分叉。能力用显式的 `capabilities` 标出，core 根据能力决定策略，不做"假装支持"。

| 能力 | Docker | E2B | CubeSandbox |
|---|---|---|---|
| 创建 / 重连 / 销毁 | ✅ | ✅ | ✅ |
| 暂停 / 恢复（含内存） | `docker pause`（不跨重启） | ✅ | ✅ |
| 快照 | `docker commit`（仅文件系统） | ✅ `createSnapshot` | ✅ |
| 从快照创建 | ✅ | ✅ | ✅ |
| 原地回滚 | ❌ | ❌（用"从快照创建新沙箱"代替） | ✅ `rollback` |
| 分叉 | 用快照模拟 | 用快照模拟 | ✅ `fork` |

第一阶段只实现 Docker 一列。Docker 的检查点只有文件系统（`kind: filesystem`），恢复或分叉后沙箱里原来在跑的进程都不存在，§8.3 的系统说明要写明这一点。

上表的 E2B 与 CubeSandbox 列来自它们的文档（E2B JS SDK v2.19、CubeSandbox v0.7 / `@cubesandbox/sdk` 0.7.3），接入这些后端时必须实测确认，以实测为准更新这张表。注意：CubeSandbox 的快照、回滚、分叉是它独有的扩展 API，不在 E2B 标准 SDK 里，所以 Cube 适配器使用 `@cubesandbox/sdk` 而不是 `e2b` 包。

**ExecChannel**：沙箱内的文件与命令操作。对上实现 `pi-durable` 的 `ExecutionEnv` 接口（文件读写、目录、监听、`exec`），对下通过 SandboxProvider 给的字节管道和沙箱内 daemon 通信。第一阶段直接用 `pi-env` 的 `RemoteExecutionEnv` + Rust daemon。

> 关于 `ExecutionEnv` 这个类型：第一阶段它来自 `pi-durable`。为了第二阶段替换引擎时不受影响，Tether 在 `core` 里复制一份结构相同的接口定义（`TetherEnv`），适配层做双向转换。复制而不是引用，是为了让 pi 的类型不出现在接口层。

### 4.3 为什么执行层选"pi-env daemon + 字节管道"，而不是直接调 E2B 的文件/命令 API

这是一个关键决定（我的决定，理由如下）：

- `ExecutionEnv` 有二十多个方法，包括按偏移读二进制、截断、flush、文件监听、输出窗口等。E2B SDK 只覆盖其中一部分，剩下的要用 shell 命令拼，语义很难做严格。
- `pi-env` daemon 已经实现了全部方法，并且自带 `registerEnvConformance()` 一致性测试和与 `NodeExecutionEnv` 的随机对比测试，语义有保证。
- 它对慢链路做了专门优化（输出窗口、大结果排在命令输出之后），正好适合"harness 不进沙箱"的跨网络场景。
- 所有后端走同一个执行层，Docker / E2B / Cube 的差异被压缩到"生命周期 + 怎么拿到一条字节管道"。第二阶段替换 daemon 时，后端代码一行不用动。

代价是沙箱模板里要预装 daemon，以及需要一条字节管道。`pi-env` 的 `Connection` 只认"启动一个本地子进程，用它的 stdin/stdout"，所以各后端这样提供管道：

- **Docker**：`docker exec -i <容器> /opt/tether/pi-env serve ...`，直接可用。
- **E2B / CubeSandbox**：沙箱模板里运行一个小的 WebSocket 桥（监听一个端口，收到连接后启动 `pi-env serve` 并转发 stdin/stdout）；服务端的 `Connection.command` 指向一个本地桥接脚本，把自己的 stdin/stdout 接到这个 WebSocket 上。端口通过后端的代理暴露（E2B 的 `getHost(port)`、Cube 的 CubeProxy），连接需要携带每个沙箱单独生成的密钥，桥校验后才启动 daemon。

第一阶段只有 Docker，用 `docker exec -i` 就够了，WebSocket 桥是接入 E2B / Cube 时才需要的部分。**它是接入远程后端时最大的技术风险**，届时首先验证。如果端口转发在某个后端上走不通，退路是为该后端写一个直接调用其文件/命令 API 的 `ExecutionEnv`，并接受部分方法降级；一致性测试会标出降级了哪些。

## 5. 数据模型

存储分两部分（我的决定）：

- **引擎状态**：由 AgentEngine 自己管理。第一阶段是 `pi-durable` 的 SQLite 存储，一个文件 `engine.sqlite`，Tether 不直接读写其中的表。
- **应用状态**：Tether 自己的 SQLite 文件 `tether.sqlite`，存下面这些表。分成两个文件，是因为 `pi-durable` 要求独占自己的存储，也让第二阶段替换引擎时应用数据不受影响。

两份存储之间的一致性规则：**应用表里的记录先写，引擎里的会话后建，引擎会话 ID 回填。** 重启时扫描"应用表有记录但引擎里没有会话"的半成品，补建或标记失败。这是一个跨存储的小型两阶段问题，作为行为测试的一项。

### 5.1 AgentDefinition

```text
agent_definitions
  id            agent 的稳定 ID
  ownerId       单用户阶段固定为 "local"
  name, description
  createdAt, archivedAt?

agent_versions                不可变，改配置 = 新增一行
  agentId, version            (agentId, version) 唯一，version 单调递增
  model                       { provider, modelId, thinkingLevel? }
  instructions                系统提示词
  tools                       允许的工具名列表（来自服务端已安装的工具目录）
  sandbox                     { template, resources: { cpu, memoryMb, diskMb? }, network: "none" | "egress" }
  checkpointPolicy            见 §8.3
  permissions                 第一版只有 { denyTools: [] , requireApproval: [] } 两个字段，requireApproval 的执行见 §6.4
  createdAt
```

工具是服务端代码，agent 版本里只存名字。服务端启动时登记一份"工具目录"，创建版本时校验名字都存在。

**工具接口归 Tether 所有**（我的决定）。`core` 定义 `TetherTool`：名字、TypeBox 参数 schema、`replay: "safe" | "unsafe"`、`sideEffects: "none" | "sandbox" | "external"`、`execute(args, env: TetherEnv, ctx)`。`engine-pi` 负责把 `TetherTool` 适配成 `pi-durable` 的 extension；第二阶段的自研引擎直接消费 `TetherTool`。内置的 `read` / `write` / `edit` / `bash` 也以 `TetherTool` 的形式提供，第一阶段内部可以包装 `pi-durable` 自带的实现。`sideEffects` 用于 §8.3 / §8.4 里"列出有副作用的工具调用"和混沌测试不变式 2，所以这些逻辑不依赖任何引擎特有的元数据。

### 5.2 Session

```text
sessions
  id
  ownerId
  agentId, agentVersion       创建时固定，之后不变
  engineSessionId             引擎里的会话 ID（回填）
  parentSessionId?            预留给多 agent 协作，第一版恒为空
  forkedFrom?                 { sessionId, entryId }，由分叉产生时填写
  status                      active | idle | archived | failed
  title?
  createdAt, lastActiveAt
```

会话的消息历史、运行状态、工具调用、用量都在引擎里，不在应用表里重复存。

### 5.3 Sandbox 绑定与检查点

```text
sandbox_bindings
  sessionId
  provider                    docker | e2b | cube
  sandboxId                   后端给的 ID
  epoch                       每次（重新）连接 +1，用于隔离旧 daemon，见 §8.2
  state                       creating | running | paused | lost | destroyed
  template, createdAt, lastUsedAt

checkpoints
  id
  sessionId
  entryId                     引擎 transcript 里的条目 ID，检查点对齐的位置
  provider, snapshotId
  kind                        filesystem | full（含内存）
  createdAt
```

`sandbox_bindings` 放在应用表而不是引擎文档里，原因是生命周期管理（闲置回收、重连）需要在不打开会话的情况下批量扫描。引擎侧的 `env` 回调每次工具调用时按 `sessionId` 查这张表拿到连接。

## 6. 核心流程

### 6.1 创建会话

1. 读取 agent 的指定版本（默认最新），写 `sessions` 记录（status=active，engineSessionId 为空）。
2. 在引擎里创建会话，用该版本的配置 `configure`：模型、指令、工具列表、`cwd`。回填 `engineSessionId`。
3. **沙箱懒创建**：不在创建会话时启动沙箱，第一次工具调用时才创建。纯聊天的会话不占沙箱资源。

### 6.2 提交消息

- 客户端必须带 `requestId`（SDK 自动生成）。引擎按 `requestId` 去重，客户端超时重试不会产生第二次执行。
- 会话忙时的行为由 `whenBusy` 决定：`followUp`（默认，排队到当前运行结束）、`steer`（插入到当前工具轮之后）、`reject`。这三种直接映射 `pi-durable` 的 inbox 语义。

### 6.3 工具调用与沙箱

引擎每次工具调用都会调 `env` 回调。Tether 的回调：

1. 查 `sandbox_bindings`。没有绑定 → 按 agent 版本的沙箱配置创建，写绑定。
2. 绑定状态是 `paused` → 恢复。
3. 返回一个包装了 ExecChannel 的 `ExecutionEnv`；连接按 `(sessionId, epoch)` 复用。
4. 后端报告沙箱已不存在（过期、被手动删除）→ 走 §8.4 的重建流程。

### 6.4 需要审批的工具

`permissions.requireApproval` 里的工具，调用前由 `beforeTool` 钩子拦下：在会话里写一条"等待审批"的状态，工具调用以"等待中"挂起，客户端通过 API 批准或拒绝。实现方式（在钩子里阻塞等待、还是返回 block 后由审批结果重新驱动）留给实现者，但必须满足：服务端在等待审批期间崩溃重启，审批请求依然在，批准后只执行一次。**如果 `pi-durable` 的钩子模型做不到这一点，这一项可以降级为只支持 `denyTools`，在文档里说明。**

### 6.5 中断、归档

- 中断：调用引擎的 abort，排队中的输入撤回，运行中的工具收到取消信号，daemon 杀掉命令的进程组。
- 归档：会话标记 archived，沙箱销毁，检查点按保留策略清理。

## 7. 对外 API

### 7.1 资源与端点

HTTP JSON，路径前缀 `/v1`。下面是第一版的完整清单，字段细节留给实现者。

```text
POST   /v1/agents                         创建 agent（同时创建 version 1）
GET    /v1/agents  /v1/agents/:id
POST   /v1/agents/:id/versions            新增版本
GET    /v1/agents/:id/versions/:v
POST   /v1/agents/:id/archive

POST   /v1/sessions                       { agentId, agentVersion? }
GET    /v1/sessions  /v1/sessions/:id     列表支持按 agent、状态过滤，分页
POST   /v1/sessions/:id/messages          { content, requestId, whenBusy? }
POST   /v1/sessions/:id/abort
POST   /v1/sessions/:id/fork              { entryId }，见 §8.3
POST   /v1/sessions/:id/approvals/:callId { decision: "approve" | "deny" }
POST   /v1/sessions/:id/archive
GET    /v1/sessions/:id/transcript        分页读历史条目

GET    /v1/sessions/:id/sandbox           绑定状态、后端、资源
GET    /v1/sessions/:id/sandbox/files?path=   浏览沙箱文件（给客户端的文件面板用）
GET    /v1/sessions/:id/sandbox/file?path=    下载单个文件
WS     /v1/sessions/:id/terminal          交互式终端（pi-env 的 pty 能力），仅调试用途，可配置关闭

WS     /v1/sessions/:id/events            事件流，见 §7.2
GET    /v1/health  /v1/metrics
```

统一响应信封：`{ ok: true, data }` / `{ ok: false, error: { code, message } }`。错误码是契约的一部分，消息不是。

### 7.2 事件流

WebSocket 连接建立后，服务端先发一个 `snapshot`（会话当前完整状态），之后按提交顺序发增量事件：消息开始/文本增量/结束、工具开始/输出增量/结束、审批请求、沙箱状态变化、检查点创建、错误。第一阶段直接由 `pi-durable` 的 `watchEvents` 转换而来，Tether 在其上加入沙箱和检查点事件。

事件格式由 Tether 自己定义（不直接透传 pi 的事件对象），这样第二阶段替换引擎时客户端不受影响。

### 7.3 断线重连（第一阶段与第二阶段的差别）

`pi-durable` 的 watch 不支持回放：客户端断线重连、或者落后超过 100 批，都只能拿到一个新的完整快照。第一阶段接受这个行为，SDK 在收到快照时整体替换本地状态。

第二阶段的自研事件同步要做到：每个事件带单调递增的序号，重连时带上 `lastSeq`，服务端补发缺失的增量，只有缺口太大时才退回快照。这是第二阶段的一项明确改进，也是可以写进文章的对比点。

### 7.4 SDK 与 CLI

- `@tether/sdk`（TypeScript）：封装上面的 HTTP 和 WebSocket，自动生成 `requestId`，事件流自动重连并维护本地会话状态。
- `tether` CLI：基于 SDK，覆盖创建 agent、开会话、发消息、实时跟随输出、查看沙箱。混沌测试和演示都用它驱动。

## 8. 最难的部分：持久化与沙箱的交界

这一节是项目的核心价值，也是文章的主要素材。

### 8.1 引擎的语义（第一阶段由 pi-durable 提供）

- 所有状态先提交再展示；流式输出和工具输出每 100ms 提交一次。
- 每个工具调用是一个持久化任务，执行前先提交"意图"。进程崩溃后：声明为 `replay: "safe"` 的工具会重跑；其他工具（包括 `bash`、`write`、`edit`）不重跑，模型收到一个 `interrupted` 错误结果，附上崩溃前已提交的输出。
- 同一个 `requestId` 的提交只会被接受一次。

也就是说，引擎保证的是**工具"至多执行一次"**，不保证执行完成。

### 8.2 问题一：崩溃后旧命令还在跑（隔离旧 daemon）

`pi-env` 的 daemon 在连接断开后，会等 30 秒没有心跳才杀掉它启动的所有进程组并退出。于是有这样一个窗口：

1. 服务端在 `bash: npm install` 执行中崩溃；
2. 服务端 10 秒后重启，引擎告诉模型"这个命令被中断了"；
3. 模型决定重新执行 `npm install`；
4. 此时旧 daemon 还活着，旧的 `npm install` 也还在跑，两个进程同时写 `node_modules`。

解决办法是**按 epoch 隔离**（我的设计）：

- 每次服务端（重新）连接某个沙箱时，`sandbox_bindings.epoch` 加 1。
- 新 daemon 启动时带上 epoch，并在沙箱里写一个 epoch 文件（例如 `/run/tether/epoch`）。
- 建立新连接后、交还给引擎之前，先杀掉所有 epoch 更小的 daemon 及其进程组（daemon 启动时把 PID 和 epoch 记到沙箱里的一个目录）。
- 只有清理完成，这次重连才算成功，工具调用才能继续。
- **注意**：`pi-env` 的 `Connection` 在连接断开后，会在下一次请求时自动启动一个新 daemon（见 `docs/protocol.md` 的 Liveness 一节）。这会绕过上面的 epoch 流程。因此 ExecChannel 不能直接使用 `Connection` 的自动重启：要么包装它，在每次（重新）启动前走一遍 epoch 加一和清理；要么禁用自动重启，由 Tether 自己负责重连。具体做法由实现者在 M2 决定，但必须通过这一节的行为测试。

行为测试：在长命令执行中杀掉服务端，5 秒内重启，断言旧命令在新工具调用开始前已经结束，且文件系统里没有两个进程交错写入的痕迹。

### 8.3 问题二：会话能回到过去，文件系统不能（检查点）

引擎的会话可以分叉到任意一个历史条目，但沙箱的文件系统只有"现在"。如果不处理，分叉出来的会话看到的是未来的文件。

**检查点策略**（agent 版本里的 `checkpointPolicy`）：

- `none`：不做快照。分叉时新会话拿一个全新的沙箱（按模板创建），并在新会话开头写一条系统说明，告诉模型"工作区已重置"。
- `perRun`（默认）：每次用户输入开始一轮运行之前，对沙箱做一次快照，记录到 `checkpoints`，对齐到这个输入对应的条目。
- `perToolRound`：每一轮工具调用结束后都做快照。最精确，代价最大，适合演示和实验。

**分叉的规则**：在条目 `E` 处分叉时，找 `entryId ≤ E` 的最近检查点 `C`。

- 如果 `C` 恰好对齐 `E`：新会话的沙箱从 `C` 创建（Cube 上用 `fork`，其他后端用"从快照创建"），文件系统与对话完全一致。
- 如果 `C` 早于 `E`：仍从 `C` 创建，同时在新会话里写一条系统说明，列出 `C` 之后到 `E` 之间执行过的、有副作用的工具调用（从 transcript 里读），告诉模型这些操作在当前工作区里没有发生。**不尝试自动重放这些工具调用**（它们大多不是幂等的）。

**检查点保留**（我的决定）：每个会话保留最近 N 个检查点（默认 20，可配置），另外永久保留被分叉引用过的检查点和 §8.5 的最终快照；会话归档时全部删除。所以分叉和重建是**尽力而为**的：理想的检查点被清理后，按上面"`C` 早于 `E`"的规则退回更早的检查点，最差退回全新模板，并且一定写系统说明。

快照开销：E2B 做快照时会暂停沙箱，Cube 号称百毫秒级。每次快照的耗时作为指标采集，`perRun` 和 `perToolRound` 的实际代价写进 README。

### 8.4 问题三：沙箱丢了（过期、宿主机故障）

- 沙箱后端报告沙箱不存在时，绑定状态改为 `lost`。
- 如果有检查点：从最新的检查点重建，然后在会话里写一条系统说明（检查点之后的操作丢失了，同 §8.3 的说明格式）。
- 如果没有检查点：按模板新建，写一条"工作区已重置"的说明。
- 两种情况都在事件流里发 `sandbox_recovered` 事件，客户端能看到发生了什么。

原则：**永远不假装环境还是原来的样子。** 环境与对话不一致时，必须让模型和用户都知道。

### 8.5 闲置与回收

- 会话闲置超过 `idlePauseAfter`（默认 10 分钟）：暂停沙箱。E2B 和 Cube 都有内建的自动暂停，优先用后端能力，Tether 只在后端不支持时自己调度。
- 闲置超过 `destroyAfter`（默认 7 天）：做一次最终快照（如果策略不是 `none`），然后销毁沙箱。之后再来消息，按 §8.4 从快照重建。
- 服务端启动时做一次对账：列出后端上带 Tether 标签的所有沙箱，与 `sandbox_bindings` 比对，清理孤儿沙箱，修正状态。

## 9. 开发用查看页

一个简单的单页 HTML（无构建步骤，由服务端直接提供），列出会话、实时显示事件流、展示沙箱文件和检查点时间线。它的用途是开发调试和录演示视频，**不是产品**，不追求设计。以后的 App 会替代它。

## 10. 第一阶段里程碑

**M0：风险验证（spike，代码可以扔）**
- `pi-durable` + Docker + `pi-env` daemon（`docker exec -i`）端到端跑通一次工具调用。
- 在 Docker 后端上跑通 `registerEnvConformance()`。
- 验证 `pi-env` 的 `Connection` 能否关闭自动重启或被包装（§8.2 的前提）。
- 验证 `docker commit` + 从镜像创建容器能作为检查点用，记录耗时。
- 产出：一页结论，确认第一阶段的技术路径没有阻塞点。

**M1：运行时核心**
- 仓库骨架、`core` 的三个接口、应用存储、AgentEngine 的 pi-durable 适配器。
- Agent 定义与版本、会话创建、消息提交、事件流 WebSocket、Docker 后端。
- SDK 与 CLI 的最小版本。

**M2：沙箱生命周期**
- Docker 后端的完整生命周期：懒创建、暂停/恢复、重连、对账、资源与网络限制、可选 gVisor 运行时。
- epoch 隔离（§8.2）。

**M3：检查点与分叉**
- 检查点策略、快照记录、会话分叉、沙箱丢失重建（§8.3、§8.4）。
- 审批工具（§6.4），或确认降级。

**M4：混沌测试与发布**
- 混沌测试框架（§11.3），在 Docker 后端上跑通（runc 和 gVisor 各一遍，如果服务器装了 gVisor）。

**第一阶段之后（可选）**：E2B 适配器、CubeSandbox 适配器。各自先验证 §4.3 的字节管道，再跑同一套接口测试和少量混沌测试。
- 查看页、README、架构图、一篇介绍文章的草稿。

## 11. 测试策略

### 11.1 接口一致性测试（每个接口一套）

- **SandboxProvider**：生命周期、能力表中声明支持的每项能力。同一套测试跑 Docker / E2B / Cube，以后跑 Firecracker。
- **ExecChannel**：直接复用 `pi-durable` 的 `registerEnvConformance()`，在每个后端上跑。第二阶段的自研 daemon 也必须通过。
- **AgentEngine**：Tether 自己写。覆盖幂等提交、忙时三种行为、中断、分叉、重启续跑。引擎用 `pi-ai` 的 faux provider 驱动，不依赖真实模型，结果可确定。

### 11.2 API 级集成测试

通过 SDK 打真实的 HTTP/WebSocket，faux 模型，Docker 后端，覆盖第 7 节所有端点。

### 11.3 混沌测试

一个测试驱动程序，以子进程方式启动 Tether 服务端，用 faux 模型编排脚本化的 agent 行为（例如"写文件、跑长命令、再写文件"），在随机时间点：

- `kill -9` 服务端后重启；
- 切断服务端到沙箱的网络一段时间；
- 直接删除沙箱。

每次运行后检查不变式：

1. 每个 `requestId` 最多对应一次运行；
2. 非 replay-safe 的工具没有被执行两次（通过沙箱里的执行记录核对）；
3. 重连后不存在 epoch 更小的存活进程；
4. 环境与对话不一致时，transcript 里一定有对应的系统说明；
5. 已提交的事件，客户端最终都能看到（重连后的快照里包含它们）。

可以用固定随机种子复现。README 里写上跑了多少轮、发现过什么问题。

## 12. 技术选型（我的决定）

| 项 | 选择 | 理由 |
|---|---|---|
| 语言 | TypeScript，Node 22+ | 与 pi 一致；pi-durable / pi-env 都是 TS |
| 仓库结构 | npm workspaces monorepo：`core`、`engine-pi`、`sandbox-docker`、`sandbox-e2b`、`sandbox-cube`、`server`、`sdk`、`cli`、`testkit` | 每个替换点是独立包，第二阶段新增 `engine-tether`、`sandbox-firecracker`、`daemon` |
| HTTP 框架 | Hono 或 Fastify，实现者选 | 都够用；需要原生 WebSocket 支持 |
| 应用存储 | SQLite（`better-sqlite3` 或 `node:sqlite`） | 单机够用，与引擎存储同类 |
| 校验 | TypeBox | pi 全家用 TypeBox，schema 可复用 |
| 测试 | Vitest | pi 的一致性测试套件兼容 Vitest |
| pi 依赖 | 锁定精确版本，升级是单独的提交 | 上游 experimental，API 会变 |
| 许可证 | MIT | 与 pi 一致；E2B、Cube 是 Apache 2.0，作为依赖调用没有冲突 |

## 13. 第二阶段概要（只定方向，届时另写设计）

1. **自研 daemon**：替换 `pi-env`。语言待定（Rust 或 Go）。必须通过 `registerEnvConformance()`。对比点：协议设计、输出背压、进程组管理。
2. **Firecracker 后端**：在作者的服务器上实现 `SandboxProvider`，包括 rootfs 模板、快照、网络。对比点：与 Cube（RustVMM）、E2B（Firecracker）的实现差异，以及实测启动时间、内存开销。
3. **自研持久化引擎**：基于 `pi-ai` 和 agent 循环，自己实现提交日志、任务检查点、恢复。必须通过 AgentEngine 一致性测试和全部混沌测试。
4. **事件同步**：带序号的增量补发（§7.3）。

每完成一项，产出一篇"pi 是怎么做的、我是怎么做的、为什么不一样"的文章。

## 14. 部署环境与访问

- 开发：作者的 Windows 10 + WSL2，Docker 后端。
- 部署：作者的 Linux 服务器，内网访问，运维走 SSH。Tether 服务端和 Docker 都跑在这台服务器上，**第一阶段的沙箱后端就是这台机器上的 Docker**（作者的决定）。
- **为什么 Docker 够用**：单用户、内网，沙箱主要防的是 agent 自己误操作（删文件、搞乱环境），不是外部攻击。每个容器限制 CPU、内存、磁盘和网络；需要更强隔离时把运行时换成 gVisor（`runsc`），代码不变。
- **Docker 的已知局限**（写进 README）：与宿主共享内核；检查点只有文件系统；`docker pause` 不跨宿主重启。
- **以后的远程后端**：E2B 云服务（付费，可能有跨境延迟）、CubeSandbox 自部署（需要 x86_64、PVM 或原生 KVM、`/data/cubelet` 为 XFS 且 ≥ 50GB、≥ 4 核 8GB）。E2B 自部署（`e2b-dev/infra`）依赖 Terraform、PostgreSQL、Redis、ClickHouse 和对象存储，不考虑。接入远程后端时要实测服务器到沙箱的往返延迟：harness 不进沙箱，每次工具调用都要跨一次网络。
- **访问控制**（作者的决定：内网访问）：服务端默认只监听 `127.0.0.1`，监听地址可配置为内网网卡；可选一个配置文件里的固定 bearer token，默认关闭；交互式终端端点默认关闭。不做公网暴露。

## 15. 留给实现者决定的事

- HTTP 框架的具体选择；
- 各包的内部模块划分；
- 事件格式的具体字段（遵守 §7.2 的约束）；
- 查看页的样式；
- WebSocket 桥接脚本的实现细节（遵守 §4.3 的鉴权要求）；
- 默认超时、闲置时长等数值（给出合理默认值，全部可配置）。

## 参考

- `pi-durable` README 与 `docs/spec.md`（本地：`pi-latest/packages/durable`）
- `pi-env` README、`docs/protocol.md`、`docs/semantics.md`（本地：`pi-latest/packages/env`）
- `pi-durable/test/examples/29-sandbox-per-conversation.ts`：每会话一个沙箱的官方示例
- CubeSandbox：https://github.com/TencentCloud/CubeSandbox（`docs/guide/quickstart.md`、`docs/guide/snapshot-rollback-clone.md`、`openapi.yml`）
- E2B：https://e2b.dev/docs ，自托管代码 `e2b-dev/infra`
- 社区已有的 `pi-extension-e2b`：在 coding-agent 层把工具换成 E2B 版本，单机 CLI 用途，与 Tether 定位不同

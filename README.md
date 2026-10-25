# Tether

自托管的服务端 agent 运行时。agent 的循环跑在服务进程里，每个会话的工具调用在自己的 Docker 容器里执行；服务进程被 `kill -9` 后重启，没跑完的会话从断点继续。客户端通过 HTTP 和 WebSocket 接入，仓库里带一个 TypeScript SDK 和命令行工具 `tether`。

第一阶段的引擎是 pi 1.3.0（`@earendil-works/pi-durable`、`pi-env`），Tether 在它前面定义了自己的接口，第二阶段换成自研实现。设计见 `docs/superpowers/specs/2026-10-20-tether-design.md`，决策记录在 `docs/adr/`。

## 运行

下面的命令在 Ubuntu 24.04、Node 22.23.4 上验证过。验证机器上没有模型 API key，所以"用 CLI 走一遍"里接真实模型的那次 `send` 没有跑通过；同样的流程（建 agent、带变量开会话、`send --follow`、看沙箱）由 `packages/cli/test/cli.docker.test.ts` 用 faux 模型验证。

### 前置条件

- Linux 和 Docker。服务进程要能执行 `docker`（运行它的用户在 `docker` 组里）。沙箱容器以服务进程的 `uid:gid` 运行，工作区是数据目录下的宿主目录挂载，所以宿主上的文件属于这个用户。
- Node ≥ 22.19。仓库没有构建步骤，各个包直接以 TypeScript 源码运行，依赖 Node 的 type stripping。
- 模型 API key：`ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY`。

### 安装和构建沙箱镜像

```bash
npm install
node packages/server/src/main.ts --build-sandbox
```

`--build-sandbox` 用 `packages/server/sandbox/Dockerfile` 构建 `TETHER_SANDBOX_IMAGE` 指定的镜像，然后退出。首次构建要拉基础镜像。

### 启动服务

```bash
export TETHER_DATA_DIR=/srv/tether TETHER_TOKEN=change-me ANTHROPIC_API_KEY=...
node packages/server/src/main.ts
# tether listening on http://127.0.0.1:7420
```

启动时先修复上次中断留下的状态：补建没建成的引擎会话，对账 Docker 容器（删掉没有绑定的 Tether 容器），再续跑未完成的提交，然后才开始监听。`SIGTERM` 或 `SIGINT` 时关闭事件流和存储后退出。

`GET /v1/health` 不需要 token，可以给探针用：

```bash
curl http://127.0.0.1:7420/v1/health
# {"ok":true,"data":{"status":"ok"}}
```

### 用 CLI 走一遍

CLI 读 `TETHER_URL`（默认 `http://127.0.0.1:7420`）和 `TETHER_TOKEN`。`npm install` 之后在仓库里可以用 `npx tether`。

agent 定义写在一个 JSON 文件里，`spec` 的字段见 `packages/core/src/model.ts`：

```json
{
  "name": "demo",
  "spec": {
    "model": { "provider": "anthropic", "modelId": "claude-sonnet-5-5" },
    "instructions": "You are a careful engineer.",
    "tools": ["read", "write", "edit", "bash"],
    "sandbox": {
      "template": "",
      "resources": { "cpu": 1, "memoryMb": 512 },
      "network": "egress",
      "setup": ["printf %s \"$GREETING\" > greeting.txt"],
      "variables": ["GREETING"]
    },
    "checkpointPolicy": "none",
    "permissions": { "denyTools": [], "requireApproval": [] }
  }
}
```

```bash
export TETHER_TOKEN=change-me
npx tether agent create --file agent.json
# agt_01a171fd8d2900001a25b6f5 version 1
npx tether session create agt_01a171fd8d2900001a25b6f5 --var GREETING=hello
# ses_01a171fd998800009db3e7ce (agent agt_01a171fd8d2900001a25b6f5 version 1)
npx tether send ses_01a171fd998800009db3e7ce "列出工作区里的文件" --follow
npx tether sandbox ses_01a171fd998800009db3e7ce
# running  tether-ses_01a171fd998800009db3e7ce
```

- `send --follow` 先订阅事件流再发消息，边跑边打印模型的文字和每次工具调用（`[bash] {...}`、`[done] ...`），这次运行结束后退出。运行完成退出码 0；没有得到回答（`unanswered`）或被中断时退出码 1，并打印 `[run unanswered]`。没有配置模型 API key 时就是这个结果，服务端目前不给出原因。
- 不带 `--follow` 时 `send` 只打印提交 ID 就返回，agent 在服务端继续跑。
- 每个命令加 `--json` 打印 API 返回的 `data`。API 错误打印 `error: <错误码>: <消息>`，退出码 1；用法错误退出码 2。
- 容器在第一次工具调用时才创建，`setup` 命令在那时依次执行。会话变量以环境变量传给 `setup`，不拼进命令，工具执行时看不到这些变量。

### 配置

服务端从环境变量读配置，值为空字符串时按未设置处理。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `TETHER_DATA_DIR` | `./data` | `tether.sqlite`、`engine.sqlite` 和 `workspaces/`（每个会话一个子目录）都在这里 |
| `TETHER_HOST` | `127.0.0.1` | 监听地址 |
| `TETHER_PORT` | `7420` | 监听端口 |
| `TETHER_TOKEN` | 不设置 | 设置后除 `/v1/health` 外都要 `Authorization: Bearer <token>`；事件流的 WebSocket 也接受 `?token=` |
| `TETHER_SANDBOX_IMAGE` | `tether-sandbox:dev` | 沙箱镜像，`--build-sandbox` 构建的也是它 |
| `ANTHROPIC_API_KEY`、`OPENAI_API_KEY` | 不设置 | 模型凭据，只在服务进程里，不进沙箱 |

token 是单一的共享口令，M1 没有用户和权限。服务走明文 HTTP，监听非本机地址时前面要放一个提供 HTTPS 的反向代理；用 `?token=` 时注意它可能出现在代理的访问日志里。

### 测试

测试要求 Linux 和 Docker，模型一律用 pi-ai 的 faux provider，不需要 API key。

```bash
npm run test:unit
npm run test:docker   # 首次运行会构建沙箱镜像
npm run typecheck
```

### 当前限制

以下能力属于后续里程碑，M1 没有实现，相应的端点也没有注册：

- 会话分叉与检查点、工具审批（M3）
- 会话归档与沙箱销毁、闲置后停止沙箱、准入控制、epoch 隔离（M2）
- 沙箱文件浏览 `sandbox/files`、`sandbox/file`（M2）
- `/v1/metrics`（M4）
- 自定义工具：M1 只有内置的 `read`、`write`、`edit`、`bash`

另外两条：

- 一台 Docker 主机上只跑一个 Tether 实例。启动对账会删掉所有带 `tether.managed=1` 标签、但不在自己数据库里的容器，两个实例会互相删对方的沙箱。
- 事件流断线重连时只能拿到新的完整快照，不补发断线期间的增量（设计文档 §7.3）。

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

查看和下载沙箱 `/workspace` 里的文件，以及归档会话：

```bash
npx tether files ses_01a171fd998800009db3e7ce          # 列 /workspace；可以再给一个相对路径
# file             5  greeting.txt
npx tether cat ses_01a171fd998800009db3e7ce greeting.txt
# hello
npx tether session archive ses_01a171fd998800009db3e7ce
# ses_01a171fd998800009db3e7ce archived
npx tether sandbox ses_01a171fd998800009db3e7ce
# destroyed  tether-ses_01a171fd998800009db3e7ce
```

- `files` 每行是 `类型  大小  名字`；`cat` 把文件原样写到标准输出，最大 10 MiB。路径相对 `/workspace`，解析符号链接之后不在 `/workspace` 下的一律拒绝（`invalid_request: path is outside /workspace`）。还没有沙箱的会话报 `not_found`，不会为了看文件创建沙箱；沙箱停了会先启动。对应的 HTTP 端点是 `GET /v1/sessions/:id/sandbox/files?path=` 和 `GET /v1/sessions/:id/sandbox/file?path=`（成功时返回原始字节）。
- `session archive` 先把会话标成 `archived`（之后发消息报 `conflict`），中止正在跑的一轮，再删除容器和工作区。删除失败时再执行一次即可重试。

### 沙箱生命周期

- **闲置停止**：会话不在运行、沙箱超过 `TETHER_STOP_AFTER_SECONDS` 没被工具调用用过，巡检就停止容器，文件保留，进程全部结束。会话记录里写一条模型能看到的说明，会话状态变成 `idle`；下一次工具调用重新启动容器。正在跑的长命令不算闲置。
- **重连**：连接 daemon 时先杀掉容器里旧连接留下的全部进程（epoch 隔离，ADR-007），后台服务（`npm run dev &` 之类）会结束；如果不是新建或刚启动后的第一次连接，同样写一条模型可见的说明。
- **丢失后重建**：容器被删掉（例如手动 `docker rm`）后，巡检把绑定标成 `lost`，下一次工具调用按模板重建、重新执行 `setup`，并告诉模型原来的文件和进程都没了。在容器外被停掉的容器同样会被发现并写说明。
- **准入**：运行中和创建中的沙箱数达到 `TETHER_MAX_RUNNING_SANDBOXES` 时，需要新占名额的工具调用（新建、启动、重建）直接失败，模型收到的工具结果是 `sandbox limit reached: 4 of 4 sandboxes are running; try again after another session goes idle`（pi 会把它包在 `<harness>[error] …</harness>` 里，`send --follow` 打印成 `[failed]`），HTTP 层对应错误码 `sandbox_limit`（503）。已经在运行的沙箱不受影响。
- 会话记录里的 `tether.sandbox` 条目（`data.state`、`data.reason`）和 `tether.admission` 条目让客户端看到上面每一件事。
- **容器加固**：沙箱容器去掉全部 Linux 能力（`--cap-drop ALL`）并禁止提权（`no-new-privileges`），以服务进程的 `uid:gid` 运行，资源和网络按 agent 版本的 `sandbox` 配置限制。

用 gVisor 运行沙箱（可选，宿主上执行一次）：按 [gVisor 文档](https://gvisor.dev/docs/user_guide/install/) 用 apt 安装 `runsc`，然后

```bash
sudo runsc install                # 在 /etc/docker/daemon.json 里注册 runsc
sudo systemctl restart docker
export TETHER_SANDBOX_RUNTIME=runsc
```

全部 Docker 测试在 gVisor release-20261019.0 下验证过（`TETHER_SANDBOX_RUNTIME=runsc npm run test:docker`），没有需要跳过的用例。

### 配置

服务端从环境变量读配置，值为空字符串时按未设置处理。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `TETHER_DATA_DIR` | `./data` | `tether.sqlite`、`engine.sqlite` 和 `workspaces/`（每个会话一个子目录）都在这里 |
| `TETHER_HOST` | `127.0.0.1` | 监听地址 |
| `TETHER_PORT` | `7420` | 监听端口 |
| `TETHER_TOKEN` | 不设置 | 设置后除 `/v1/health` 外都要 `Authorization: Bearer <token>`；事件流的 WebSocket 也接受 `?token=` |
| `TETHER_SANDBOX_IMAGE` | `tether-sandbox:dev` | 沙箱镜像，`--build-sandbox` 构建的也是它 |
| `TETHER_SETUP_TIMEOUT_SECONDS` | `600` | 每条 `setup` 命令的上限；超时算 `setup` 失败，容器删除，下一次工具调用重新创建 |
| `TETHER_MAX_RUNNING_SANDBOXES` | `4` | 同时运行（含创建中）的沙箱上限，正整数；见下面的"沙箱生命周期" |
| `TETHER_STOP_AFTER_SECONDS` | `3600` | 沙箱闲置这么久后停止容器 |
| `TETHER_SWEEP_INTERVAL_SECONDS` | `60` | 巡检间隔：多久核对一次绑定与 Docker、停掉闲置的沙箱 |
| `TETHER_SANDBOX_RUNTIME` | 不设置 | 沙箱容器的运行时，例如 gVisor 的 `runsc`（要先在 Docker 里注册，见下文）；不设置用 Docker 默认的 `runc` |
| `ANTHROPIC_API_KEY`、`OPENAI_API_KEY` | 不设置 | 模型凭据，只在服务进程里，不进沙箱 |

token 是单一的共享口令，目前没有用户和权限。服务走明文 HTTP，监听非本机地址时前面要放一个提供 HTTPS 的反向代理；用 `?token=` 时注意它可能出现在代理的访问日志里。

### 测试

测试要求 Linux 和 Docker，模型一律用 pi-ai 的 faux provider，不需要 API key。

```bash
npm run test:unit
npm run test:docker   # 首次运行会构建沙箱镜像
npm run typecheck
TETHER_SANDBOX_RUNTIME=runsc npm run test:docker   # 可选：在 gVisor 下再跑一遍
```

### 当前限制

以下能力属于后续里程碑，还没有实现，相应的端点也没有注册：

- 会话分叉与检查点、从检查点重建、工具审批（M3）
- 闲置超过 `destroyAfter` 后删除沙箱（它要先做最终快照，和检查点一起在 M3）
- `/v1/metrics`（M4）
- 自定义工具：只有内置的 `read`、`write`、`edit`、`bash`

agent 版本里有三个字段已经定义但还没有实现：`sandbox.resources.diskMb`、`permissions.requireApproval`（非空）、`checkpointPolicy: "perRun"`。填了会直接报 `invalid_request: <字段> is not supported yet`，不会被悄悄忽略。

另外：

- 一台 Docker 主机上只跑一个 Tether 实例。启动对账会删掉所有带 `tether.managed=1` 标签、但不在自己数据库里的容器，两个实例会互相删对方的沙箱。会话锁和准入锁也只在一个进程内有效。
- 事件流断线重连时只能拿到新的完整快照，不补发断线期间的增量（设计文档 §7.3）。
- `network: "egress"` 的沙箱能访问云厂商的元数据地址（例如阿里云的 `100.100.100.200`），拦截它需要宿主的防火墙规则，Tether 不改防火墙。部署在云主机上时请在宿主上自行拦截。
- 文件浏览先把路径解析成真实路径、检查在 `/workspace` 下，再读取；沙箱里的进程在这两步之间把路径换成符号链接，理论上能让读取落到 `/workspace` 之外。读到的仍只是容器里的文件，不涉及宿主。
- 丢失重建、重连的说明如果是在一轮运行中写下的，模型要到下一轮才看到；这一轮的工具结果已经反映了新环境。

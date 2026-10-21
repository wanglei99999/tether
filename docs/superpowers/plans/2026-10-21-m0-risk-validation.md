# M0 风险验证 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用最小的实验代码确认第一阶段的技术路径没有阻塞点：pi-env daemon 能在 Docker 容器里通过一致性测试，pi-durable 能驱动容器里的工具，服务端崩溃后的旧进程能被 epoch 隔离清理，`docker commit` 能当检查点用，pi-durable 的钩子和自定义条目能支撑 `perRun` 检查点与单一事件源。

**Architecture:** 所有代码放在 `spikes/m0/`，是可丢弃的实验代码，不是正式包的开头。每个实验写成一个 Vitest 测试文件，测试本身就是实验记录；最后把测得的结论写进 `docs/m0-findings.md`，并据此修订设计文档。

**Tech Stack:** Node ≥ 22.19（在 WSL Ubuntu-24.04 里运行）、TypeScript（Node 原生类型剥离，不编译）、Vitest、Docker 29（WSL 内）、`@earendil-works/pi-durable` / `pi-env` / `pi-ai` / `chord` 精确版本 1.3.0。

**Spec:** `docs/superpowers/specs/2026-10-20-tether-design.md`（M0 定义在 §10，相关设计在 §4.3、§8.2、§8.3、§14）

## Global Constraints

- pi 依赖锁定精确版本 `1.3.0`，不写 `^` 或 `~`（spec §12："锁定精确版本，升级是单独的提交"）。
- Node 版本下限 `22.19.0`（pi 1.3.0 的 `engines.node`）。
- 所有命令在 WSL `Ubuntu-24.04` 里执行，仓库路径为 `/mnt/d/Coding/GitCoding/idea/tether`。Windows 侧不运行 Node 或 Docker 命令。
- 模型一律用 `pi-ai` 的 faux provider，不调用真实模型，不需要 API key。
- 沙箱内 daemon 路径固定为 `/opt/tether/pi-env`，工作目录固定为 `/workspace`。
- 测试创建的容器名前缀 `tether-m0-`，镜像名 `tether-m0-sandbox:dev`；每个测试文件在 `afterAll` 里删除自己创建的容器。
- 提交信息使用约定式提交格式，中文描述（与仓库已有提交一致）。

## Review Focus

1. **daemon 二进制与容器 libc 不匹配**：pi-env 的 linux-x64 二进制如果是动态链接 glibc，在 alpine 镜像里会直接起不来。镜像固定用 `debian:bookworm-slim`，Task 2 的测试断言 `connection.info()` 能返回 `os: "linux"`。
2. **服务端崩溃后旧命令继续运行**：这是 spec §8.2 的核心问题。Task 5 用真实的 `SIGKILL`（管道关闭）和 `SIGSTOP`（连接卡住）作用于持有连接的 Node 进程，然后在不同时间点检查容器里的旧命令是否还活着，不用模拟。
3. **隔离逻辑误杀新 daemon**：fence 只能杀 epoch 更小的 daemon。Task 5 的测试在 fence 之后断言新连接上的命令能正常完成。
4. **容器被删除后的连接行为**：`docker exec` 指向不存在的容器时，`Connection` 应该返回 `lost` 错误，而不是挂起。Task 2 加一个测试覆盖。
5. **检查点恢复后进程丢失**：spec §4.2 说 Docker 检查点只有文件系统。Task 6 的测试断言恢复后的容器里文件还在、原来的后台进程不在，把这个局限钉成事实。

---

## 文件结构

```text
tether/
├── .gitignore                       Task 1
├── .nvmrc                           Task 1
├── package.json                     Task 1  私有根包，依赖与脚本
├── tsconfig.json                    Task 1  仅供编辑器和 tsc --noEmit 类型检查
├── vitest.config.ts                 Task 1
├── spikes/m0/
│   ├── toolchain.test.ts            Task 1  依赖可导入、daemon 二进制存在
│   ├── sandbox.Dockerfile           Task 2  实验用沙箱镜像
│   ├── launch.sh                    Task 2  daemon 启动包装：记录 epoch 与 PID
│   ├── docker.ts                    Task 2  容器辅助函数
│   ├── connection.test.ts           Task 2  daemon 能在容器里跑起来
│   ├── conformance.test.ts          Task 3  pi-durable 的 env 一致性测试
│   ├── durable-e2e.test.ts          Task 4  Harness + 容器内工具调用
│   ├── fence.ts                     Task 5  epoch 隔离原型
│   ├── holder.ts                    Task 5  被 SIGKILL 的子进程脚本
│   ├── orphan.test.ts               Task 5  崩溃后旧命令的存活实验 + 隔离验证
│   ├── checkpoint.test.ts           Task 6  docker commit 检查点实验
│   └── hooks.test.ts                Task 7  运行开始钩子与自定义条目
└── docs/m0-findings.md              Task 8
```

---

### Task 1: 工具链与依赖

**Files:**
- Create: `.gitignore`、`.nvmrc`、`package.json`、`tsconfig.json`、`vitest.config.ts`
- Test: `spikes/m0/toolchain.test.ts`

**Interfaces:**
- Produces: `npm test` 跑全部 spikes 测试；`npm run typecheck` 跑 `tsc --noEmit`。

- [ ] **Step 1: 在 WSL 里准备 Node**

Run（WSL）：`curl -fsSL https://fnm.vercel.app/install | bash && source ~/.bashrc && fnm install 22 && fnm default 22 && node -v`
Expected: 输出 `v22.x.y`，且 `x.y ≥ 19.0`。WSL 里当前没有 Node（已确认），`npm` 8.19.4 来自 Windows 互操作，不要用它。

- [ ] **Step 2: 写配置文件**

- `.nvmrc`：`22`
- `.gitignore`：`node_modules/`、`*.sqlite*`、`.tmp/`
- `package.json`：`"name": "tether"`、`"private": true`、`"type": "module"`、`"engines": { "node": ">=22.19.0" }`；`dependencies` 为 `@earendil-works/pi-durable`、`@earendil-works/pi-env`、`@earendil-works/pi-ai`、`@earendil-works/chord`，全部 `"1.3.0"`；`devDependencies` 为 `vitest`、`typescript`、`@types/node`（实现者取当前稳定版，写精确版本）；脚本 `"test": "vitest run"`、`"typecheck": "tsc --noEmit"`。
- `tsconfig.json`：`"module": "nodenext"`、`"target": "es2023"`、`"strict": true`、`"noEmit": true`、`"allowImportingTsExtensions": true`、`"include": ["spikes"]`。
- `vitest.config.ts`：`testTimeout: 120_000`，`fileParallelism: false`（实验之间共享 Docker，顺序执行避免互相干扰）。

- [ ] **Step 3: 写失败的测试 `spikes/m0/toolchain.test.ts`**

```ts
import { existsSync } from "node:fs";
import { packagedDaemon } from "@earendil-works/pi-env";
import { Harness } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

describe("toolchain", () => {
	it("ships the linux-x64 daemon", () => {
		expect(existsSync(packagedDaemon({ platform: "linux", arch: "x64" }))).toBe(true);
	});
	it("imports pi-durable", () => {
		expect(typeof Harness.open).toBe("function");
	});
});
```

- [ ] **Step 4: 运行，确认失败**

Run（WSL，仓库根目录）：`npx vitest run spikes/m0/toolchain.test.ts`
Expected: FAIL，原因是依赖尚未安装（`Cannot find package '@earendil-works/pi-env'`）。

- [ ] **Step 5: 安装依赖并重跑**

Run: `npm install && npx vitest run spikes/m0/toolchain.test.ts && npm run typecheck`
Expected: 2 个测试 PASS；typecheck 无错误。

- [ ] **Step 6: 提交**

```bash
git add .gitignore .nvmrc package.json package-lock.json tsconfig.json vitest.config.ts spikes/m0/toolchain.test.ts
git commit -m "chore: 初始化 M0 实验工具链，锁定 pi 1.3.0"
```

---

### Task 2: 沙箱镜像与容器内 daemon 连接

**Files:**
- Create: `spikes/m0/sandbox.Dockerfile`、`spikes/m0/launch.sh`、`spikes/m0/docker.ts`
- Test: `spikes/m0/connection.test.ts`

**Interfaces:**
- Consumes: Task 1 的依赖。
- Produces（`spikes/m0/docker.ts`）：
  - `IMAGE = "tether-m0-sandbox:dev"`
  - `buildImage(): Promise<void>` —— 构建镜像；把 `packagedDaemon({ platform: "linux", arch: "x64" })` 复制进构建上下文。
  - `startContainer(name: string, image?: string): Promise<string>` —— `docker run -d --name <name> <image> sleep infinity`，返回容器名。
  - `removeContainer(name: string): Promise<void>` —— `docker rm -f`，容器不存在时不报错。
  - `dockerExec(name: string, script: string): Promise<{ code: number; stdout: string }>` —— `docker exec <name> sh -c <script>`。
  - `daemonCommand(name: string, epoch: number): string[]` —— 返回 `["docker", "exec", "-i", name, "/opt/tether/launch.sh", String(epoch)]`。`Connection` 会在末尾追加 `serve --token <hex>`。

- [ ] **Step 1: 写 `sandbox.Dockerfile` 和 `launch.sh`**

镜像基于 `debian:bookworm-slim`，安装 `bash coreutils procps git`，创建 `/workspace` 和 `/run/tether/daemons`，复制 daemon 到 `/opt/tether/pi-env`、`launch.sh` 到 `/opt/tether/launch.sh`（都 `chmod 755`），`WORKDIR /workspace`。

`launch.sh` 的行为（`/bin/sh`）：第一个参数是 epoch，其余参数原样传给 daemon。写一个空的记录文件 `/run/tether/daemons/<epoch>.<PID>`，然后 `exec` 成 daemon（`exec` 保证 PID 不变）：

```sh
#!/bin/sh
epoch="$1"; shift
: > "/run/tether/daemons/$epoch.$$"
exec /opt/tether/pi-env "$@"
```

记录只用来观察和断言"当前是哪个 epoch"，隔离本身不依赖它（见 Task 5）。不要用 `setsid` 把 daemon 和命令圈进同一个会话：daemon 会给每个命令单独开会话（pi-env `docs/semantics.md`："Each command gets a new session"），按会话杀不到命令。

- [ ] **Step 2: 写失败的测试 `spikes/m0/connection.test.ts`**

```ts
describe("pi-env daemon in a container", () => {
	// beforeAll: buildImage(); startContainer("tether-m0-conn")
	// afterAll: connection.close(); removeContainer("tether-m0-conn")
	it("answers hello from inside the container", async () => {
		const connection = new Connection({ command: daemonCommand("tether-m0-conn", 1) });
		const info = await connection.info();
		expect(info.os).toBe("linux");
		expect(info.arch).toBe("x86_64");
	});
	it("records the daemon under its epoch", async () => {
		const { stdout } = await dockerExec("tether-m0-conn", "ls /run/tether/daemons");
		expect(stdout).toMatch(/^1\.\d+$/m);
	});
	it("fails with a lost error when the container is gone", async () => {
		const connection = new Connection({ command: daemonCommand("tether-m0-missing", 1) });
		const error = await connection.info().catch((e) => e);
		expect(isConnectionLost(error)).toBe(true);
		connection.close();
	});
});
```

- [ ] **Step 3: 运行，确认失败**

Run: `npx vitest run spikes/m0/connection.test.ts`
Expected: FAIL，`docker.ts` 尚不存在。

- [ ] **Step 4: 实现 `spikes/m0/docker.ts`**

用 `node:child_process` 的 `execFile` 调用 `docker` CLI。`buildImage` 先把 daemon 二进制和 `launch.sh` 复制到 `.tmp/m0-image/`，再用它作为构建上下文。

- [ ] **Step 5: 运行，确认通过**

Run: `npx vitest run spikes/m0/connection.test.ts`
Expected: 3 个测试 PASS。如果第一个测试因为 daemon 起不来而失败，看 `onLog` 输出，在 findings 里记录原因（Review Focus 1）。

- [ ] **Step 6: 提交**

```bash
git add spikes/m0/sandbox.Dockerfile spikes/m0/launch.sh spikes/m0/docker.ts spikes/m0/connection.test.ts
git commit -m "test: 验证 pi-env daemon 可在 Docker 容器内通过 docker exec 连接"
```

---

### Task 3: 在容器里跑 env 一致性测试

**Files:**
- Test: `spikes/m0/conformance.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `buildImage`、`startContainer`、`removeContainer`、`dockerExec`、`daemonCommand`；`registerEnvConformance` 来自 `@earendil-works/pi-durable/testing`；`RemoteExecutionEnv` 来自 `@earendil-works/pi-env`。

- [ ] **Step 1: 写测试**

容器名 `tether-m0-conformance`，epoch 1，一个共享的 `Connection`。`registerEnvConformance({ describe, expect, it }, "RemoteExecutionEnv in Docker", provider, { listFiles: true })`。`provider` 每次用 `dockerExec(name, "mktemp -d /workspace/case-XXXXXX")` 在容器里创建一个目录作为 `cwd`，用 `new RemoteExecutionEnv({ connection, id: "docker:tether-m0-conformance", cwd, watch: { pollIntervalMs: 100 } })` 调用 `use`，结束后 `dockerExec(name, "rm -rf <cwd>")`。

注意 `cwd` 必须是容器内路径，不能像上游测试那样用宿主的 `mkdtempSync`。

- [ ] **Step 2: 运行**

Run: `npx vitest run spikes/m0/conformance.test.ts --reporter=verbose 2>&1 | tee .tmp/conformance.log`
Expected: 全部 PASS。如果有失败的用例，**不要修改测试或绕过**：把失败用例的名字和错误信息记到 `.tmp/conformance.log`，Task 7 写进 findings，判断是 Docker 环境的差异（例如 watch 在 overlayfs 上的行为）还是阻塞点。

- [ ] **Step 3: 提交**

```bash
git add spikes/m0/conformance.test.ts
git commit -m "test: 在 Docker 容器内运行 pi-durable env 一致性测试"
```

---

### Task 4: pi-durable 驱动容器内的工具

**Files:**
- Test: `spikes/m0/durable-e2e.test.ts`

**Interfaces:**
- Consumes: Task 2 的辅助函数；`Harness`、`createRegistry` 来自 `@earendil-works/pi-durable`；`CodingTools` 来自 `@earendil-works/pi-durable/tools`；`openNodeSqliteStorage` 来自 `@earendil-works/pi-durable/storage/sqlite/node`；`createModels` 来自 `@earendil-works/pi-ai/models`；`fauxProvider`、`fauxAssistantMessage`、`fauxToolCall` 来自 `@earendil-works/pi-ai/providers/faux`；`BACKGROUND_CONTEXT` 来自 `@earendil-works/chord/context`。参考上游示例 `pi-latest/packages/durable/test/examples/29-sandbox-per-conversation.ts` 的写法。

- [ ] **Step 1: 写测试**

```ts
it("runs write and bash inside the container and persists across reopen", async () => {
	// faux 响应顺序：
	//   1. toolUse: write { path: "hello.txt", content: "from tether" }
	//   2. toolUse: bash  { command: "wc -c < hello.txt > size.txt" }
	//   3. "Done."
	// Harness.open(await openNodeSqliteStorage(".tmp/e2e.sqlite"), { models, registry, env }, ctx)
	//   env: () => new RemoteExecutionEnv({ connection, id: "docker:tether-m0-e2e", cwd: "/workspace" })
	// root.submit({ type: "input", content: "go", requestId: "e2e-1" }) → wait → status "done"
	const { stdout } = await dockerExec("tether-m0-e2e", "cat /workspace/hello.txt /workspace/size.txt");
	expect(stdout).toBe("from tether11\n");
	// harness.close() 后用同一个 sqlite 文件重新 open：
	// root.submit 同一个 requestId "e2e-1" → 返回的 submission.id 与第一次相同，faux 没有被再次调用
});
```

断言的值：`hello.txt` 内容为 `from tether`（11 字节，`write` 不追加换行），`size.txt` 为 `11\n`。如果 `write` 的实际行为与此不同，以实际行为为准修改期望值，并在 findings 里记一笔。

- [ ] **Step 2: 运行**

Run: `npx vitest run spikes/m0/durable-e2e.test.ts`
Expected: PASS。

- [ ] **Step 3: 提交**

```bash
git add spikes/m0/durable-e2e.test.ts
git commit -m "test: pi-durable 通过 RemoteExecutionEnv 在容器内执行工具"
```

---

### Task 5: 崩溃后的旧命令与 epoch 隔离

这是 M0 最重要的实验，对应 spec §8.2。

**Files:**
- Create: `spikes/m0/holder.ts`、`spikes/m0/fence.ts`
- Test: `spikes/m0/orphan.test.ts`

**Interfaces:**
- Consumes: Task 2 的辅助函数。
- Produces（`spikes/m0/fence.ts`）：
  - `fence(container: string, currentEpoch: number): Promise<{ killed: number[] }>` —— 在容器里执行一段脚本：先用 `ps` 记下除 PID 1 和脚本自身以外的所有 PID（作为返回值），再执行 `kill -KILL -1`（杀掉除 PID 1 和调用者以外的所有进程，即旧 daemon 和它启动的全部命令），最后删除 `/run/tether/daemons/` 下 epoch 小于 `currentEpoch` 的记录。前提是一个容器同一时刻只有一条连接（spec §8.2）。
  - `fencedCommand(container: string, nextEpoch: () => number): () => Promise<string[]>` —— 给 `ConnectionOptions.command` 用的函数：每次被调用时取一个新 epoch，先 `fence(container, epoch)`，再返回 `daemonCommand(container, epoch)`。`Connection` 每次（重新）启动 daemon 都会调用它，这就是在不修改 `Connection` 的前提下插入隔离的地方。

`holder.ts` 是一个独立脚本：参数为容器名和 epoch，建立 `Connection` + `RemoteExecutionEnv`，执行 `sleep 300; echo late > /workspace/late.txt`，在命令开始后向 stdout 打印一行 `started`，然后一直等待。

- [ ] **Step 1: 写实验测试（先观察，不加隔离）**

pi-env 的 daemon 在 stdin 结束时立即退出，在 30 秒收不到任何字节时也会退出（`docs/protocol.md` 的 Liveness 一节）。两种情况分开观察：holder 被杀（管道关闭）和 holder 被挂起（连接卡住但没断）。

```ts
it.each(["SIGKILL", "SIGSTOP"])("observes the old command after %s of its holder", async (signal) => {
	// spawn("node", ["--experimental-strip-types", "spikes/m0/holder.ts", name, "1"])，等到 stdout 出现 "started"
	// holder.kill(signal)
	// 在 t = 1s、10s、40s 时：dockerExec(name, "pgrep -f 'sleep 300' || true")
	// 把结果写入 .tmp/orphan-observation-<signal>.json；SIGSTOP 的用例结束时对 holder 发 SIGKILL 收尾
	// 断言：t=40s 时 sleep 已经不存在
});
```

预期：`SIGKILL` 时 t=1s 就已不存在（`docker exec` 客户端随 holder 退出，daemon 读到 EOF）；`SIGSTOP` 时 t=1s、10s 还在，t=40s 不在。这只是预期，实测结果不同就记录实测，findings 里写明。t=40s 时还在属于必须标红的结论。

- [ ] **Step 2: 运行并记录**

Run: `npx vitest run spikes/m0/orphan.test.ts -t "observes"`
Expected: 两个用例运行完成，两份 `.tmp/orphan-observation-*.json` 记录三个时间点的结果。

- [ ] **Step 3: 写隔离的失败测试**

```ts
it("fences the previous epoch before the new daemon serves", async () => {
	// 用 holder 以 epoch 1 启动 "sleep 300; echo late > /workspace/late.txt"，等 "started"，SIGSTOP holder（连接卡住，旧 daemon 不会自己退出）
	// 立刻（1 秒内）：
	//   let epoch = 1;
	//   const connection = new Connection({ command: fencedCommand(name, () => ++epoch) });
	//   const env = new RemoteExecutionEnv({ connection, id: "docker:" + name, cwd: "/workspace" });
	//   const result = await env.exec("echo fresh > /workspace/fresh.txt", undefined, ctx);
	expect(result.ok && result.value.exitCode).toBe(0);
	// 旧会话里的 sleep 已被杀掉：
	expect((await dockerExec(name, "pgrep -f 'sleep 300'")).code).toBe(1);
	// 记录目录里只剩 epoch 2：
	expect((await dockerExec(name, "ls /run/tether/daemons")).stdout).toMatch(/^2\.\d+\n$/);
	// 等 35 秒后旧命令也没有机会写出 late.txt：
	expect((await dockerExec(name, "test -e /workspace/late.txt")).code).toBe(1);
});
```

- [ ] **Step 4: 运行，确认失败**

Run: `npx vitest run spikes/m0/orphan.test.ts -t "fences"`
Expected: FAIL，`fence.ts` 尚不存在。

- [ ] **Step 5: 实现 `fence` 和 `fencedCommand`**

- [ ] **Step 6: 运行，确认通过**

Run: `npx vitest run spikes/m0/orphan.test.ts`
Expected: 两个测试都 PASS。

- [ ] **Step 7: 提交**

```bash
git add spikes/m0/holder.ts spikes/m0/fence.ts spikes/m0/orphan.test.ts
git commit -m "test: 观察崩溃后容器内旧命令的存活并验证 epoch 隔离"
```

---

### Task 6: `docker commit` 作为检查点

对应 spec §4.2 Docker 列和 §8.3。

**Files:**
- Test: `spikes/m0/checkpoint.test.ts`

**Interfaces:**
- Consumes: Task 2 的辅助函数（`startContainer` 的第二个参数用于从快照镜像启动）。

- [ ] **Step 1: 写测试**

```ts
it("restores files but not processes from a committed image", async () => {
	// 源容器 tether-m0-ckpt-src：写 /workspace/a.txt = "v1"，后台启动 "sleep 600 &"
	// docker commit tether-m0-ckpt-src tether-m0-ckpt:1，记录耗时
	// 从 tether-m0-ckpt:1 启动 tether-m0-ckpt-dst
	expect((await dockerExec(dst, "cat /workspace/a.txt")).stdout).toBe("v1");
	expect((await dockerExec(dst, "pgrep -f 'sleep 600'")).code).toBe(1);
	// 源容器之后的修改不影响快照：
	// 在 src 写 a.txt = "v2"，再从 tether-m0-ckpt:1 启动另一个容器，读到的仍是 "v1"
});

it("measures commit time against workspace size", async () => {
	// 三档：空工作区、50MB、500MB（用 head -c <n> /dev/urandom 生成随机文件）
	// 每档 docker commit 三次取中位数，写入 .tmp/checkpoint-timing.json
	// 同时用 docker image inspect 记录每个快照镜像新增层的大小
	// 不设断言阈值，只记录
});
```

`afterAll` 删除所有 `tether-m0-ckpt-*` 容器和 `tether-m0-ckpt:*` 镜像。

- [ ] **Step 2: 运行**

Run: `npx vitest run spikes/m0/checkpoint.test.ts`
Expected: 第一个测试 PASS；第二个测试生成 `.tmp/checkpoint-timing.json`。

- [ ] **Step 3: 提交**

```bash
git add spikes/m0/checkpoint.test.ts
git commit -m "test: 验证 docker commit 检查点的恢复语义并测量耗时"
```

---

### Task 7: 运行开始钩子与自定义条目

对应 spec §4.2（AgentEngine 的运行开始钩子）、§4.4（单一事件源）、§8.3（`perRun` 检查点）。

**Files:**
- Test: `spikes/m0/hooks.test.ts`

**Interfaces:**
- Consumes: Task 4 的 Harness 组装方式；`defineExtension`、`hook`、`GenerationTask` 来自 `@earendil-works/pi-durable`。不需要 Docker，用 `MemoryStorage`，不配置 `env`，faux 脚本里不调用工具，只用一个不碰环境的自定义工具 `noop`（`defineTool`，`execute` 返回 `{}`）。

已知事实（`pi-durable/src/harness/types.ts` 的 `GenerationHooks`）：`beforeRequest(request, api, context)` 在**每一次**请求尝试之前调用，包括崩溃恢复后的重试；`api` 是 `HookApi`（`DocumentReader` + `conversationId` + `taskId` + `memo`），文档里没有直接给出"本轮运行对应的用户条目 ID"。一轮运行包含多个 generation 任务（每个模型回合一个），所以"本轮的第一次请求"要靠条目 ID 去重来识别。

- [ ] **Step 1: 写测试**

```ts
it("identifies the user entry that started each run from beforeRequest", async () => {
	// faux：run1 = toolUse(noop) → "ok1"（两次请求）；run2 = "ok2"（一次请求）
	// 扩展 probe：hook(GenerationTask, { beforeRequest: async (_req, api, ctx) => {
	//   从 api 能读到的内容里找出本对话最新的 pi.user 条目 ID（实现者查 DocumentReader 的方法），
	//   push 到 seen 数组；返回 undefined（不改请求）
	// }})
	// 提交 run1 → wait；提交 run2 → wait
	expect(seen).toHaveLength(3);
	expect(seen[0]).toBe(seen[1]);       // 同一轮的两次请求指向同一个用户条目
	expect(seen[2]).not.toBe(seen[0]);   // 新一轮指向新的用户条目
	expect(seen[0]).toBe(run1UserEntryId); // 与 transcript 里 run1 的 pi.user 条目一致
});

it("writes tether entries that the model does or does not see", async () => {
	// 运行前提交 { type: "write", entry: { kind: "tether.sandbox", data: { state: "running" } } }
	// 再提交 { type: "write", entry: { kind: "tether.note", data: {...}, model: [{ role: "user", content: "工作区已重置" }] } }
	// 然后提交一轮输入；在 beforeRequest 里记录 request.messages
	// 断言：transcript 里两条 tether.* 条目都在，顺序与提交顺序一致；
	//      messages 里包含 "工作区已重置"，不包含 tether.sandbox 的任何内容
});
```

如果从 `HookApi` 读不到用户条目 ID，**不要改用别的钩子硬凑**：把能读到的内容记下来，第一个测试标记为 `it.fails`，在 findings 里写明，并给出备选方案（例如在 core 侧于 inbox 条目被放入时触发检查点），交给 M1 设计决定。`model` 字段的确切形状以 `pi-durable` 的类型为准，与上面的写法不同时按类型改。

- [ ] **Step 2: 运行**

Run: `npx vitest run spikes/m0/hooks.test.ts`
Expected: 两个测试 PASS，或者第一个测试按上面的规则标记为已知失败并有记录。

- [ ] **Step 3: 提交**

```bash
git add spikes/m0/hooks.test.ts
git commit -m "test: 验证运行开始钩子能识别本轮用户条目，以及自定义条目的可见性"
```

---

### Task 8: 结论与设计修订

**Files:**
- Create: `docs/m0-findings.md`
- Modify: `docs/superpowers/specs/2026-10-20-tether-design.md`（§4.2 能力表 Docker 列、§8.2、§10 的 M0 小节）

- [ ] **Step 1: 写 `docs/m0-findings.md`**

固定结构，每节写"结论 / 证据（测试名或 `.tmp` 文件里的数据）/ 对设计的影响"：

1. 环境：Node 版本、Docker 版本、WSL 发行版、pi 版本。
2. daemon 在容器内运行（Task 2）。
3. env 一致性测试结果（Task 3）：通过数 / 总数，失败用例逐条列出。
4. pi-durable 端到端（Task 4）。
5. 崩溃窗口与 epoch 隔离（Task 5）：三个时间点的观察结果；`command` 函数作为隔离插入点是否成立。
6. 检查点（Task 6）：恢复语义；三档工作区的 commit 中位耗时和磁盘占用（`docker image inspect` 的层大小），据此确认 spec §8.3 的默认保留数 5 是否合适。
7. 运行开始钩子与自定义条目（Task 7）：能否识别本轮用户条目；两种条目的可见性。
8. 阻塞点清单：没有就写"无"；有的话写明影响哪个里程碑。
9. 对 M1 的输入：M1 计划需要知道的事实。

- [ ] **Step 2: 修订设计文档**

- §4.2 能力表 Docker 列按实测结果更新。
- §8.2 末尾关于 `Connection` 自动重启的注意事项：如果 Task 5 证实 `command` 函数可以作为插入点，改写成确定的做法（"通过 `ConnectionOptions.command` 函数在每次启动前执行 fence"），删除"要么包装、要么禁用"的二选一表述。
- §10 M0 小节末尾加一行指向 `docs/m0-findings.md`。

- [ ] **Step 3: 全量验证**

Run: `npm test && npm run typecheck`
Expected: 全部测试 PASS（Task 3 中如有已在 findings 里记录的已知失败用例，例外），typecheck 无错误。

- [ ] **Step 4: 提交**

```bash
git add docs/m0-findings.md docs/superpowers/specs/2026-10-20-tether-design.md
git commit -m "docs: 记录 M0 风险验证结论并修订设计"
```

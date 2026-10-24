# M0 风险验证 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用最小的实验代码确认第一阶段的技术路径没有阻塞点：pi-env daemon 能在 Docker 容器里通过一致性测试，pi-durable 能驱动容器里的工具，服务端崩溃后的旧进程能被 epoch 隔离清理，工作区挂载加 reflink（ext4 上退回 rsync 硬链接或 overlay 分层）的检查点比 `docker commit` 更省空间且语义正确，pi-durable 的钩子和自定义条目能支撑 `perRun` 检查点与单一事件源。

**Architecture:** 所有代码放在 `spikes/m0/`，是可丢弃的实验代码，不是正式包的开头。每个实验写成一个 Vitest 测试文件，测试本身就是实验记录；最后把测得的结论写进 `docs/m0-findings.md`，并据此修订设计文档。

**Tech Stack:** Node ≥ 22.19、TypeScript（Node 原生类型剥离，不编译）、Vitest、Docker CE（官方 apt 源）、`@earendil-works/pi-durable` / `pi-env` / `pi-ai` / `chord` 精确版本 1.3.0。全部运行在测试机 `tether-m0` 上。

**运行环境:** 测试机 `tether-m0`（阿里云轻量，Ubuntu 24.04，x86_64，2 vCPU / 2 GiB，40 GiB ESSD，系统盘 ext4），用户已授权专门用于 Tether。代码在 Windows 的 worktree 里写、提交、推送到 GitHub 分支 `m0-server`；服务器上以用户 `tether` 在 `~/tether` 里 `git pull` 后运行测试。本机执行远程命令的形式：`ssh -n tether-m0 'sudo -iu tether bash -lc "cd ~/tether && <命令>"'`（Windows 的 OpenSSH 必须带 `-n`，否则等待 stdin 卡住）。

**Spec:** `docs/superpowers/specs/2026-10-20-tether-design.md`（M0 定义在 §10，相关设计在 §4.3、§8.2、§8.3、§14）

## Global Constraints

- pi 依赖锁定精确版本 `1.3.0`，不写 `^` 或 `~`（spec §12："锁定精确版本，升级是单独的提交"）。
- Node 版本下限 `22.19.0`（pi 1.3.0 的 `engines.node`）。
- Node 和 Docker 命令只在 `tether-m0` 上执行，Windows 侧只写代码和 git。不用 WSL。
- 模型一律用 `pi-ai` 的 faux provider，不调用真实模型，不需要 API key。
- 沙箱内 daemon 路径固定为 `/opt/tether/pi-env`，工作目录固定为 `/workspace`。
- 测试创建的容器名前缀 `tether-m0-`，镜像名 `tether-m0-sandbox:dev`；每个测试文件在 `afterAll` 里删除自己创建的容器。
- 防护措施（即使是专用机也保留，正式实现会沿用）：
  1. 所有容器和由 `docker commit` 产生的镜像都带标签 `tether.m0=1`；清理只按名字前缀或这个标签删除，不用 `docker system prune` 之类的全局命令。
  2. 容器一律带资源上限 `--cpus 1 --memory 512m --pids-limit 256`。
  3. 容器不得使用 `--pid=host`；`fence` 执行 `kill -KILL -1` 之前先用 `docker inspect` 确认 `HostConfig.PidMode` 为空，并在容器内确认 `/proc/1/comm` 是容器自己的 init（`sleep`），任一不满足就抛错、不执行。
  4. Task 6 开始前检查 `df` 剩余空间，系统盘不足 10 GiB 或 XFS 盘不足 6 GiB 时直接失败。
  5. 不改 sshd 配置、防火墙，不开放端口。
- 提交信息使用约定式提交格式，中文描述（与仓库已有提交一致）。

## Review Focus

1. **daemon 二进制与容器 libc 不匹配**：pi-env 的 linux-x64 二进制如果是动态链接 glibc，在 alpine 镜像里会直接起不来。镜像固定用 `debian:bookworm-slim`，Task 2 的测试断言 `connection.info()` 能返回 `os: "linux"`。
2. **服务端崩溃后旧命令继续运行**：这是 spec §8.2 的核心问题。Task 5 用真实的 `SIGKILL`（管道关闭）和 `SIGSTOP`（连接卡住）作用于持有连接的 Node 进程，然后在不同时间点检查容器里的旧命令是否还活着，不用模拟。
3. **隔离逻辑误杀新 daemon**：fence 只能杀 epoch 更小的 daemon。Task 5 的测试在 fence 之后断言新连接上的命令能正常完成。
4. **容器被删除后的连接行为**：`docker exec` 指向不存在的容器时，`Connection` 应该返回 `lost` 错误，而不是挂起。Task 2 加一个测试覆盖。
5. **检查点恢复后进程丢失**：spec §4.2 说 Docker 检查点只有文件系统。Task 6 的测试断言恢复后的容器里文件还在、原来的后台进程不在，把这个局限钉成事实。
6. **overlay 分层的冻结层被旧进程写入**：overlay 做法在打快照时把当前可写层冻结成只读层、换一个新的可写层。容器里仍在运行、持有旧挂载的进程，可能继续写进已经冻结的那一层，快照就不再是快照。Task 6 专门测这种情况，结果决定 overlay 能不能作为 ext4 上的退路。

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
│   ├── checkpoint.ts                Task 6  工作区快照与恢复（reflink / rsync / overlay）
│   ├── checkpoint.test.ts           Task 6  四种检查点做法的对比实验
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

- [ ] **Step 0: 准备测试机（以 root 执行，只做一次）**

每一步执行前把命令告诉用户。

1. 系统更新与基础工具：`apt-get update && apt-get install -y ca-certificates curl git rsync xfsprogs`。
2. Docker CE：按 Docker 官方文档添加 apt 源，安装 `docker-ce docker-ce-cli containerd.io docker-buildx-plugin`。阿里云机器拉 Docker Hub 慢时，配置 `/etc/docker/daemon.json` 的 `registry-mirrors`，并在 findings 里记录。
3. 2 GiB swap：`fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`，写入 `/etc/fstab`。
4. 用户：`useradd -m -s /bin/bash tether && usermod -aG docker tether`。sudoers 只放行挂载命令：`tether ALL=(root) NOPASSWD: /usr/bin/mount, /usr/bin/umount`（Task 6 的 overlay 需要）。
5. XFS 测试盘：`fallocate -l 8G /var/lib/tether-xfs.img && mkfs.xfs -m reflink=1 /var/lib/tether-xfs.img && mkdir -p /data/tether-xfs && mount -o loop /var/lib/tether-xfs.img /data/tether-xfs && chown tether: /data/tether-xfs`，写入 `/etc/fstab`。
6. 克隆仓库：`sudo -iu tether git clone -b m0-server https://github.com/wanglei99999/tether.git ~/tether`。

Expected: `docker run --rm hello-world` 成功；`swapon --show` 有 `/swapfile`；`stat -f -c %T /data/tether-xfs` 输出 `xfs`。

- [ ] **Step 1: 以 `tether` 用户准备 Node**

Run: `curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && . ~/.nvm/nvm.sh && nvm install 22 && node -v`
Expected: 输出 `v22.x.y`，且 `x.y ≥ 19.0`。

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

Run（tether-m0，仓库根目录）：`npx vitest run spikes/m0/toolchain.test.ts`
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
  - `startContainer(name: string, options?: { image?: string; workspace?: string; propagation?: "rslave" }): Promise<string>` —— `docker run -d --name <name> --label tether.m0=1 --cpus 1 --memory 512m --pids-limit 256 [-v <workspace 的绝对路径>:/workspace[:rslave]] <image，默认 IMAGE> sleep infinity`，返回容器名。`propagation` 只给 Task 6 的 overlay 做法用。
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

第二个测试（2026-10-24 与用户确认后加入）：工具执行到一半时 harness 进程崩溃。Harness 放在子进程 `spikes/m0/crash-child.ts` 里，faux 让它调用 `bash: echo started >> runs.txt; sleep 5; echo x >> log.txt`；`runs.txt` 出现后对子进程发 `SIGKILL`；用同一个 SQLite 重新打开、用同一个 `requestId` 拿回提交并等待。断言：这次 `bash` 只有一条结果、是错误、内容含 "interrupted"；重开后模型只被调用一次（中断之后的那一轮）；`runs.txt` 只有一行（没有重跑）。旧命令有没有跑完只记录到 `.tmp/e2e-crash-observation.json`，留给 Task 5。辅助模块 `spikes/m0/harness.ts` 供两个测试和子进程共用。

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
  - `fence(container: string, currentEpoch: number): Promise<{ killed: number[] }>` —— 先做 Global Constraints 防护第 3 条的两项检查（`HostConfig.PidMode` 为空、容器内 `/proc/1/comm` 为 `sleep`），不满足就抛错。然后在容器里执行一段脚本：先用 `ps` 记下除 PID 1 和脚本自身以外的所有 PID（作为返回值），再执行 `kill -KILL -1`（杀掉除 PID 1 和调用者以外的所有进程，即旧 daemon 和它启动的全部命令），最后删除 `/run/tether/daemons/` 下 epoch 小于 `currentEpoch` 的记录。前提是一个容器同一时刻只有一条连接（spec §8.2）。
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

再加一个防护测试：对以 `--pid=host` 启动的容器，`assertPidIsolated` 必须抛错。测试只调用检查函数，不对这个容器调用 `fence`：检查一旦有 bug，`kill -1` 会杀掉整台测试机的进程（2026-10-24 实现时调整）。`fence` 在容器内的脚本里也会在 kill 之前再检查一次 `/proc/1/comm`，作为第二道防线。

- [ ] **Step 4: 运行，确认失败**

Run: `npx vitest run spikes/m0/orphan.test.ts -t "fence"`
Expected: FAIL，`fence.ts` 尚不存在。

- [ ] **Step 5: 实现 `fence` 和 `fencedCommand`**

- [ ] **Step 6: 运行，确认通过**

Run: `npx vitest run spikes/m0/orphan.test.ts`
Expected: 全部测试 PASS。

- [ ] **Step 7: 提交**

```bash
git add spikes/m0/holder.ts spikes/m0/fence.ts spikes/m0/orphan.test.ts
git commit -m "test: 观察崩溃后容器内旧命令的存活并验证 epoch 隔离"
```

---

### Task 6: 检查点四种做法的对比

对应 spec §4.2 Docker 列、§8.3 和 ADR-006。要回答四个问题：`docker commit` 反复提交是否真的重复存储；工作区快照的恢复语义是否正确；在 ext4 上 rsync 硬链接和 overlay 分层哪个更适合当退路；四种做法各占多少时间和空间。

测试机系统盘是 ext4，不支持 reflink。reflink 做法在 Step 0 建的 XFS 测试盘 `/data/tether-xfs` 上测，其余三种在系统盘上测。XFS 盘是 loop 设备，底下还有一层 ext4，耗时会比真实 XFS 数据盘略高，findings 里注明。

**Files:**
- Create: `spikes/m0/checkpoint.ts`
- Test: `spikes/m0/checkpoint.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `startContainer(name, { workspace, propagation })`、`dockerExec`、`removeContainer`。
- Produces（`spikes/m0/checkpoint.ts`）：
  - `EXT4_ROOT = ".tmp/m0-workspaces"`、`XFS_ROOT = "/data/tether-xfs/m0-workspaces"`：两种文件系统上存放工作区和快照的目录。
  - `supportsReflink(dir: string): Promise<boolean>`：在 `dir` 里建一个小文件，执行 `cp --reflink=always`，成功返回 `true`。
  - 目录式快照（`mode: "reflink" | "rsync"`）：
    - `snapshot(workspace, dest, previous, mode)`：`reflink` 执行 `cp -a --reflink=always <workspace>/. <dest>/`；`rsync` 执行 `rsync -a --delete [--link-dest=<previous>] <workspace>/ <dest>/`。
    - `restore(snap, dest, mode)`：`reflink` 同样用 `cp -a --reflink=always`；`rsync` 用不带 `--link-dest` 的 `cp -a`，保证恢复出的工作区和快照不共享 inode。
  - overlay 分层（工作区是宿主上的 overlay 挂载，目录 `<ws>/layers/<n>`、`<ws>/upper`、`<ws>/work`、挂载点 `<ws>/mnt`；`mount`/`umount` 通过 `sudo` 执行）：
    - `overlayCreate(ws): Promise<void>`：建目录；把 `<ws>/mnt` bind 到自身并 `--make-shared`，再在上面挂 overlay（第一次没有只读层时用一个空的 `layers/0`）。
    - `overlaySnapshot(ws): Promise<number>`：卸载 overlay，把 `upper` 改名为 `layers/<n>`（冻结），建新的空 `upper` 和 `work`，以 `lowerdir=layers/n:...:layers/0` 重新挂载；返回 `n`。
    - `overlayRestore(ws, n, dest): Promise<void>`：在新目录 `dest` 上用 `lowerdir=<ws>/layers/n:...:0` 加一个新的空可写层挂载，不复制任何数据。
    - `overlayDestroy(ws): Promise<void>`：卸载所有相关挂载并删除目录。

- [ ] **Step 1: 写测试**

```ts
it("records how docker commit layers grow on one container", async () => {
	// 容器 tether-m0-ckpt-commit（不挂载工作区）：在 /data 写 50 MB 随机文件 big.bin，再写 1 MB 的 small.bin
	// 提交 c1；原地改写 small.bin（1 MB）后提交 c2；再改写一次提交 c3
	// 用 docker history --no-trunc --format '{{.Size}}' 取每个镜像最上面那一层的大小
	// 写入 .tmp/checkpoint-commit-layers.json；不设断言，只记录
	// 预期（ADR-006 的分析）：三层都约 51 MB；实测不同就记录实测
});

it("detects reflink support on both filesystems", async () => {
	// 对 EXT4_ROOT 和 XFS_ROOT 分别记录 stat -f -c %T 的类型和 supportsReflink() 的结果，写入 .tmp/checkpoint-fs.json
	expect(await supportsReflink(XFS_ROOT)).toBe(true); // Step 0 的 XFS 盘没建好时在这里失败
});

it.each([
	["reflink", XFS_ROOT],
	["rsync", EXT4_ROOT],
	["overlay", EXT4_ROOT],
])("restores files but not processes with %s", async (mode, root) => {
	// 工作区 ws-src 挂载进容器 src（overlay 用 <ws>/mnt 并带 propagation: "rslave"）：
	//   写 /workspace/a.txt = "v1"，后台启动 "sleep 600 &"
	// 打快照 1；之后在 src 里把 a.txt 改成 "v2"
	// 从快照 1 恢复到 ws-dst；容器 dst 挂载 ws-dst
	expect((await dockerExec(dst, "cat /workspace/a.txt")).stdout).toBe("v1");
	expect((await dockerExec(dst, "pgrep -f 'sleep 600'")).code).toBe(1);
	// 恢复出的工作区与快照互不影响：在 dst 里把 a.txt 改成 "v3"，快照 1 里的 a.txt 仍是 "v1"
	// overlay 额外断言：快照后 src 容器里 /workspace 看到的是重新挂载后的 overlay（写入 b.txt 后出现在新的 upper，不在 layers/1）
});

it("checks whether a running process can write into a frozen overlay layer", async () => {
	// 对应 Review Focus 6。容器 src 里后台启动：exec 3>/workspace/log.txt; while true; do echo x >&3; sleep 0.2; done
	// overlaySnapshot(ws) 冻结 layers/1 后等 2 秒，记录 layers/1/log.txt 的大小前后是否变化
	// 同时记录：卸载 overlay 是否因为文件被占用而失败（umount 报 busy 时改用 umount -l 并记录）
	// 写入 .tmp/checkpoint-overlay-frozen.json；不设断言，只记录。
	// 冻结层被写入，或者必须先停掉容器里的进程才能打快照，都要在 findings 里写明，并据此决定 overlay 能否当退路
});

it("measures time and space of the four approaches", async () => {
	// 开始前检查剩余空间（Global Constraints 防护第 4 条）
	// 工作区三档：空、50 MB、500 MB（head -c <n> /dev/urandom 生成 big.bin）
	// 每档、每种做法（docker commit、reflink、rsync、overlay）各连续做 3 次快照，两次快照之间做两种改动之一，分两组记录：
	//   组 A：新写一个 2 MB 的文件
	//   组 B：在 big.bin 中间原地改写 2 MB（dd conv=notrunc），用来暴露文件粒度（rsync、overlay 要复制整个文件）和块粒度（reflink）的差别
	// 记录每次快照的耗时、做快照前后 df --output=used 的差值；再各做一次恢复并记录耗时
	// 写入 .tmp/checkpoint-timing.json；不设断言阈值，只记录
});
```

`afterAll` 先对所有 overlay 工作区调用 `overlayDestroy`，再删除所有带 `tether.m0=1` 标签的 `tether-m0-ckpt-*` 容器和 `tether-m0-ckpt:*` 镜像，最后删除 `EXT4_ROOT` 和 `XFS_ROOT`。

实现时的调整（2026-10-24）：
- 写测试前先在测试机上手动探测了 overlay 的行为：父目录 shared + 容器端 `rslave` 能把宿主上的重新挂载传播进运行中的容器；有进程开着工作区文件时普通卸载报 busy，延迟卸载后冻结层继续被写入，内核日志报 `lowerdir is in-use as upperdir ... undefined behavior`。冻结层测试据此改为断言这一事实（"pins"），不只记录。
- 三种工作区做法统一成 `spikes/m0/checkpoint-bench.ts` 里的 `Approach` 接口（create / snapshot / restore / discard / destroy），恢复语义测试和成本测量共用；docker commit 单独测量。
- Task 6 的容器以宿主测试用户的 uid:gid 运行（`ContainerOptions.user`），否则工作区里的文件属于 root，测试用户无法复制和删除。overlay workdir 里内核建的 root 目录用一次性容器删除（`removeTree`）。

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run spikes/m0/checkpoint.test.ts`
Expected: FAIL，`checkpoint.ts` 尚不存在。

- [ ] **Step 3: 实现 `spikes/m0/checkpoint.ts`**

- [ ] **Step 4: 运行**

Run: `npx vitest run spikes/m0/checkpoint.test.ts`
Expected: reflink 检测和三种恢复语义的测试 PASS；其余测试生成 `.tmp/checkpoint-commit-layers.json`、`.tmp/checkpoint-fs.json`、`.tmp/checkpoint-overlay-frozen.json`、`.tmp/checkpoint-timing.json`。500 MB 一档在 2 GiB 内存的机器上可能较慢，超过 `testTimeout` 时只对这个用例放宽超时，不删减档位。

- [ ] **Step 5: 提交**

```bash
git add spikes/m0/checkpoint.ts spikes/m0/checkpoint.test.ts
git commit -m "test: 对比 docker commit、reflink、rsync、overlay 四种检查点的语义、耗时与空间"
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

实现时的结果（2026-10-24）：`HookApi` 只能读文档（`snapshot`），读不到条目，generation 任务的输入为空。改为读 `LiveDoc`：`run.inputs[0]` 是触发本轮的提交 ID，同一轮内不变、新一轮更换；提交记录（`placed`/`done`）的 `entry` 就是本轮的 `pi.user` 条目。`LiveDoc.run.taskId` 是当前 generation 任务的 ID，每个模型回合都会变，不能当本轮标识。测试按这些事实断言。

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

1. 环境：测试机规格（`tether-m0`，CPU、内存、磁盘类型）、内核版本、Node 版本、Docker 版本、pi 版本、XFS 测试盘是 loop 设备这一点。
2. daemon 在容器内运行（Task 2）。
3. env 一致性测试结果（Task 3）：通过数 / 总数，失败用例逐条列出。
4. pi-durable 端到端（Task 4）。
5. 崩溃窗口与 epoch 隔离（Task 5）：三个时间点的观察结果；`command` 函数作为隔离插入点是否成立。
6. 检查点（Task 6）：docker commit 反复提交的层大小是否如 ADR-006 所预期；三种工作区做法的恢复语义；overlay 冻结层会不会被运行中的进程写入；四种做法在三档工作区、两种改动方式下的耗时和空间。据此确认 ADR-006 的选择、ext4 上的退路用 rsync 还是 overlay、spec §8.3 的默认保留数 5，并更新 ADR-006 的状态。
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

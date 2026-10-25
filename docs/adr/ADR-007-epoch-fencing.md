# ADR-007：用 epoch 隔离清理崩溃后的旧进程

**状态**：已采纳（M0 已验证，2026-10-24）
**日期**：2026-10-21
**决策人**：wangl

---

## 背景

服务端崩溃重启后，`pi-durable` 把执行到一半的非 replay-safe 工具报告为"中断"，模型可能重新执行同一个命令。但命令运行在沙箱里，由 `pi-env` 的 daemon 启动，旧 daemon 和旧命令不一定已经停止。

`pi-env` 的 daemon 有两个退出条件（`docs/protocol.md` 的 Liveness 一节）：标准输入结束时立即退出；30 秒没收到任何字节时退出。退出时杀掉它启动的所有进程组。服务端进程崩溃时管道通常正常关闭，旧命令立即被杀；连接卡住而没有断开时（客户端进程被挂起、远程后端的代理没有转发连接关闭），旧命令会继续运行最多 30 秒，与新连接上重新执行的命令同时写工作区。

另有两个事实影响清理方式：daemon 给每个命令单独开一个会话（`docs/semantics.md`），按 daemon 的会话或进程组杀不到命令；`pi-env` 的 `Connection` 在连接丢失后自动启动新 daemon，启动命令可以是一个每次启动前调用的函数。

---

## 备选方案

| 维度 | A：等 daemon 自己退出 | B：按 daemon 的会话 / 进程组清理 | C：新 daemon 启动前在容器里 `kill -KILL -1` |
|---|---|---|---|
| 窗口 | 最长 30 秒 | 零，但杀不全 | 零 |
| 能否杀到命令 | 能（daemon 退出时） | 不能：每个命令单独开会话 | 能，包括孤儿进程 |
| 前提 | 无 | 无 | 一个容器同一时刻只有一条连接 |
| 实现位置 | 无 | 需要修改 daemon 的启动方式 | `ConnectionOptions.command` 函数，不改 pi-env |

---

## 决策

选择 **方案 C**：

- `sandbox_bindings.epoch` 在每次（重新）连接时加一。
- daemon 通过包装脚本 `launch.sh <epoch>` 启动，脚本在 `/run/tether/daemons/` 下写 `<epoch>.<PID>` 的记录后 `exec` 成 daemon。记录只用于观察和断言，隔离不依赖它。
- `ConnectionOptions.command` 函数在每次启动 daemon 之前：epoch 加一并写回；在容器里执行 `kill -KILL -1`（杀掉除 PID 1 和调用者以外的所有进程）；返回新 daemon 的 `docker exec` 命令行。隔离失败时函数抛错，这次启动失败，不允许新 daemon 在隔离完成前启动。
- 每次隔离之后写一条模型可见的 `tether.sandbox` 条目，说明连接已重建、此前的后台进程已结束。

远程后端如果做不到一容器一连接，退回按记录的 PID 逐个清理子进程组，届时另写 ADR。

M0 的 Task 5 分别用 `SIGKILL`（管道关闭）和 `SIGSTOP`（连接卡住）验证旧命令的实际存活时间和隔离的有效性。

**M0 验证结果**（`spikes/m0/orphan.test.ts`，`docs/m0-findings.md` 第 5 节）：

- `SIGKILL` 持有连接的进程：1 秒时旧 daemon 和旧命令都已结束。`SIGSTOP`：1 秒、10 秒时都还在运行，40 秒时已结束。卡住时的窗口确实存在，长度由 daemon 的 30 秒静默超时决定。
- `SIGSTOP` 之后立即以 `fencedCommand` 建立新连接：旧命令被清理，记录目录只剩新 epoch，35 秒后旧命令要写的 `late.txt` 不存在，新连接仍可用。`Connection` 每次启动 daemon 前确实调用 `command` 函数，插入点成立。
- 实现时加了两道防护：宿主侧检查 `HostConfig.PidMode` 为空且容器内 PID 1 是容器自己的 init；容器内的脚本在 kill 之前再查一次 PID 1。

---

## 后果

**正面**：
- 新连接上的第一个命令开始之前，旧 epoch 的进程已经全部停止，消除了两个所有者同时写工作区的窗口。
- 不需要修改 `pi-env`，插入点是它公开的启动命令函数。

**负面**：
- 每次重连都会结束沙箱里的所有后台服务（例如 agent 用 `npm run dev &` 启动的开发服务器）。daemon 退出时本来也会杀掉它们，隔离让这件事变得确定，但必须告诉模型。
- 依赖一容器一连接的前提；违反这个前提会误杀正在使用的连接。
- 每次建立连接多三次 docker CLI 调用（检查两次、清理一次），M0 实测一次隔离 253–272 ms，中位数 264 ms。只在建立连接时发生。

---

## 参考

- 设计文档 §8.2：`docs/superpowers/specs/2026-10-20-tether-design.md`
- M0 计划 Task 5：`docs/superpowers/plans/2026-10-21-m0-risk-validation.md`
- `pi-env` 的 `docs/protocol.md`、`docs/semantics.md`、`src/connection.ts`
- [Martin Kleppmann, How to do distributed locking (2016)](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)
- 笔记：[崩溃后的旧进程](https://github.com/wanglei99999/learn_note/blob/main/Agent基础设施/05-崩溃后的旧进程.md)

# ADR-003：第一阶段的沙箱后端用 Docker

**状态**：已采纳
**日期**：2026-10-20
**决策人**：wangl

---

## 背景

harness 不进沙箱（ADR-002）之后，需要一个沙箱后端提供生命周期管理（创建、查找、停止、启动、销毁）和一条到沙箱内 daemon 的字节管道。

考察过的候选和它们的门槛：

- **E2B 云服务**：Firecracker microVM，接口成熟。付费；服务端在国内时有跨境延迟，harness 不进沙箱意味着每次工具调用都要承担。
- **E2B 自部署**（`e2b-dev/infra`）：依赖 Terraform、PostgreSQL、Redis、ClickHouse 和对象存储，部署脚本面向 GCP/AWS，单机运维成本高。
- **CubeSandbox**（腾讯开源，Apache 2.0，兼容 E2B API，基于 RustVMM）：支持单机部署，有原生的快照、回滚、分叉。需要 x86_64、KVM 或其 PVM 内核、`/data/cubelet` 为 XFS 且至少 50 GB、至少 4 核 8 GB。
- **Docker**：开发机和服务器都能跑，零费用，没有额外的基础设施。

部署环境是单用户、内网访问，沙箱主要防的是模型误操作，不是外部攻击。

---

## 备选方案

| 维度 | A：E2B 云服务 | B：CubeSandbox 自部署 | C：Docker（可选 gVisor） |
|---|---|---|---|
| 隔离 | 独立内核 | 独立内核 | 共享内核；gVisor 用用户态内核加强 |
| 内存快照 | 有 | 有 | 没有，只能保存文件系统 |
| 费用 | 按用量付费 | 机器成本 | 零 |
| 前置条件 | API key | KVM/PVM、XFS、大磁盘 | 任意 Linux |
| 跑通的速度 | 快 | 慢：先要把部署搞定 | 最快 |

---

## 决策

选择 **方案 C**：第一阶段只实现 Docker 后端，默认 runc，可通过配置切换到 gVisor（`runsc`）。先做简单的，跑通再深入。

`SandboxProvider` 接口按以后能接 E2B、CubeSandbox、Firecracker 来设计：能力（快照、从快照创建、原地回滚、分叉、保存内存）用显式标志声明，core 根据能力选择策略，不假设任何后端特有的行为。E2B 和 CubeSandbox 适配器是第一阶段之后的可选项；第二阶段自研一个 Firecracker 后端。

---

## 后果

**正面**：
- 没有外部依赖和费用，M0 可以立刻开始。
- 隔离强度可以通过换运行时（runc → runsc）提升，代码不变。
- 接口按多后端设计，以后加后端只是新增一个实现。

**负面**：
- 与宿主共享内核，不适合运行不可信的多租户代码。
- 检查点只有文件系统；恢复、分叉、闲置停止之后，沙箱里的后台进程都没有了，需要写说明告诉模型。
- 接远程后端时要额外解决字节管道问题（WebSocket 桥），这部分风险推迟到第一阶段之后。

---

## 参考

- 设计文档 §4.2、§4.3、§14：`docs/superpowers/specs/2026-10-20-tether-design.md`
- 笔记：[沙箱后端](https://github.com/wanglei99999/learn_note/blob/main/Agent基础设施/07-沙箱后端.md)
- CubeSandbox：https://github.com/TencentCloud/CubeSandbox

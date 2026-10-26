# 架构决定记录（ADR）

一个重要决定一个文件，写明背景、备选方案、决策和后果。系统当前应该是什么样子，以[设计文档](../superpowers/specs/2026-10-20-tether-design.md)为准；ADR 记录它为什么是这个样子。决定被推翻时不删除旧 ADR，把状态改成"已被 ADR-xxx 取代"，再写一份新的。

状态有四种：提议中、已采纳、已采纳待验证（依赖实验结果）、已被取代。

| 编号 | 决定 | 状态 | 日期 |
|---|---|---|---|
| [ADR-001](ADR-001-server-side-agent-runtime-two-phases.md) | 定位为服务端 agent 运行时，分两阶段实现 | 已采纳 | 2026-10-20 |
| [ADR-002](ADR-002-harness-outside-sandbox.md) | harness 不进沙箱 | 已采纳 | 2026-10-20 |
| [ADR-003](ADR-003-docker-as-phase1-sandbox.md) | 第一阶段的沙箱后端用 Docker | 已采纳 | 2026-10-20 |
| [ADR-004](ADR-004-ports-and-adapters-five-packages.md) | 端口与适配器架构，五个包 | 已采纳 | 2026-10-21 |
| [ADR-005](ADR-005-single-event-source.md) | 单一事件源，沙箱与检查点事件写进引擎日志 | 已采纳（M0 已验证） | 2026-10-21 |
| [ADR-006](ADR-006-checkpoint-workspace-mount-reflink.md) | 检查点用工作区挂载加 reflink，不用 docker commit | 已采纳（M0 已验证） | 2026-10-21 |
| [ADR-007](ADR-007-epoch-fencing.md) | 用 epoch 隔离清理崩溃后的旧进程 | 已采纳（M0 已验证） | 2026-10-21 |
| [ADR-008](ADR-008-idle-two-tiers.md) | 闲置分两档，停止容器时写说明 | 已采纳 | 2026-10-21 |
| [ADR-009](ADR-009-tether-env-minimal.md) | `TetherEnv` 先取最小子集 | 已采纳 | 2026-10-25 |
| [ADR-010](ADR-010-sandbox-lifecycle-rules.md) | 沙箱生命周期的规则放在 core：状态表、会话锁、带期望值的写入 | 已采纳（M2 已实现） | 2026-10-26 |

# ADR-004：端口与适配器架构，五个包

**状态**：已采纳
**日期**：2026-10-21
**决策人**：wangl

---

## 背景

ADR-001 要求每一层前面都有 Tether 自己的接口，第二阶段能逐层替换实现。替换点有四个：持久化引擎（AgentEngine）、沙箱生命周期（SandboxProvider）、执行通道（ExecChannel）、应用存储。

`pi-durable` 要求一个进程独占一份存储，第一阶段只能是单进程。代码怎么切分，要同时满足三件事："core 不依赖任何实现"可以被验证；一致性测试独立于第一阶段的实现；包的数量不至于让第一阶段的维护成本过高。

---

## 备选方案

| 维度 | A：每个替换点一个包（八个包） | B：三个包，替换点按目录划分 | C：五个包 |
|---|---|---|---|
| 包 | core、engine-pi、exec-pienv、sandbox-docker、store-sqlite、server、sdk、cli、testkit | server（含 core 和适配器）、sdk、cli | core、testkit、server（适配器按目录）、sdk、cli |
| core 的独立性 | 包依赖保证 | 只靠 lint | 包依赖保证 |
| 一致性测试的独立性 | 包依赖保证 | 和实现混在一起 | 包依赖保证 |
| 维护成本 | 高 | 低 | 中 |

---

## 决策

选择 **方案 C**：

```text
packages/
  core/      领域模型、端口接口、领域服务（零外部依赖，TypeBox 除外）
  testkit/   每个端口的一致性测试 + 混沌测试驱动
  server/    src/adapters/{engine-pi, exec-pienv, sandbox-docker, store-sqlite}/
             src/http/   HTTP/WS
             src/main.ts 组装与启动
  sdk/  cli/
```

`core` 和 `testkit` 必须是独立的包：`core` 的依赖里没有任何实现库，"core 不依赖实现"由包管理器保证；`testkit` 是第二阶段自研实现要通过的考卷，不能和第一阶段的实现放在一起。适配器在 `server` 内按目录划分，lint 规则限制依赖方向：`core` 不能导入 `server`，各适配器目录互不导入，只有 `main.ts` 同时看到它们。

第二阶段新增实现就是新增一个适配器目录（例如 `adapters/engine-tether`、`adapters/sandbox-firecracker`），跑同一套 `testkit`。

方案 B 曾被选用过一轮，后来发现砍过头了：只靠 lint 守边界，"core 和 testkit 独立"这件事无法被直接验证，而这正是两阶段路线的基础。

---

## 后果

**正面**：
- "一个接口两种实现"在仓库结构上直接可见，替换一层不影响其他层。
- 一致性测试和混沌测试可以原样作用于第二阶段的实现。
- 包的数量适中，第一阶段不需要为每个适配器维护单独的包配置。

**负面**：
- 适配器之间的边界靠 lint，配置不当时可能被绕过，需要在 CI 里强制执行。
- 单进程架构以后要拆分（例如 API 网关和执行 worker 分开），需要沿接口重新切分进程。

---

## 参考

- 设计文档 §4.1、§4.1.1、§12：`docs/superpowers/specs/2026-10-20-tether-design.md`

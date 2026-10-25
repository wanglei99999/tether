# ADR-009：`TetherEnv` 先取最小子集

**状态**：已采纳
**日期**：2026-10-25
**决策人**：wangl

---

## 背景

设计文档 §4.2 原本的写法是：`core` 复制一份与 `pi-durable` 的 `ExecutionEnv` 结构相同的接口，叫 `TetherEnv`，适配层做双向转换。这样 pi 的类型不会出现在接口层，第二阶段换引擎时接口不用动。

写 M1 计划时逐个核对了 `ExecutionEnv`，发现它有二十多个方法，包括按偏移读二进制、截断、flush、文件监听、输出窗口等，有些签名还带着 chord 的 `Context` 类型。照搬的话，`core` 要么依赖 chord，要么再复制一批 chord 的类型。

M1 里真正通过 `TetherEnv` 调用沙箱的只有 Tether 自己的代码：执行 setup 命令、检查工作区、测试里读写文件。内置工具 `read` / `write` / `edit` / `bash` 直接用 pi 自带的实现，拿到的是 `pi-env` 给的 `ExecutionEnv`，完全不经过 `TetherEnv`。

---

## 备选方案

**A：完整复制 `ExecutionEnv`**

- 二十多个方法全部在 `core` 里重新声明，chord 的 `Context` 等类型也一起复制。
- 好处：第二阶段自研引擎时，内置工具可以直接基于 `TetherEnv` 写。
- 坏处：M1 里大部分方法没有调用方，也没有测试覆盖；复制来的签名一旦和上游不一致，只有到第二阶段才会发现。

**B：最小子集**

- 只声明 Tether 现在用得到的方法：`cwd`、`readText`、`writeFile`、`exists`、`list`、`exec`。
- 内置工具继续用 pi 的环境对象，由 `exec-pienv` 适配器额外提供 `piEnv()`，只在组装层使用。
- 好处：接口里每个方法都有调用方和测试。
- 坏处：第二阶段自研引擎要自己实现内置工具时，需要扩充接口。

---

## 决策

选择 **方案 B**。

`core/src/env.ts` 里的 `TetherEnv` 只有上面六个成员。错误统一用 `TetherError`：文件不存在是 `not_found`，沙箱或连接出错是 `sandbox_failed`。

`ExecChannel.env()` 返回 `TetherEnv`。`exec-pienv` 适配器在同一个连接上额外提供 `piEnv()`，返回 pi 的 `ExecutionEnv`，交给 `engine-pi` 的内置工具使用。pi 的类型只出现在适配器和组装层，架构测试保证这一点。

---

## 后果

**正面**：

- `core` 不依赖 chord，也不需要复制 chord 的类型。
- 接口小，以后接 E2B 等后端时，要实现的方法也少。

**负面**：

- 第二阶段自研引擎、自己提供内置工具时，需要按工具实际用到的能力扩充 `TetherEnv`。届时以 `pi-env` 的一致性测试为参照，补哪个方法就补哪个方法的测试。
- M1 里存在两条访问沙箱的路径：Tether 自己用 `TetherEnv`，内置工具用 pi 的 `ExecutionEnv`。两者共用同一个连接，epoch 隔离对两者都生效。

---

## 参考

- 设计文档 §4.2、§5.1：`docs/superpowers/specs/2026-10-20-tether-design.md`
- M1 计划 Task 3、Task 6：`docs/superpowers/plans/2026-10-24-m1-runtime-core.md`
- ADR-004：端口与适配器架构

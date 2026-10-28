# ADR-011：工作区改为每会话一个 XFS 镜像文件，检查点每轮都留、按空间稀疏化

**状态**：已采纳（M3 已实现，2026-10-28）；部分取代 ADR-006
**日期**：2026-10-28
**决策人**：wangl

---

## 背景

ADR-006 定下检查点用"工作区挂载 + reflink"：宿主目录挂成 `/workspace`，快照时 `cp -a --reflink=always` 整个目录。M0 用 500 MiB、文件数很少的工作区实测，每张 7–9 ms，耗时与工作区大小无关。

M3 开工前在测试机上补测了文件数多的情况（XFS 测试盘挂在 ext4 上的 loop 设备）。目录级的 reflink 要为每个文件单独建一份元数据，耗时与文件数成正比：5 万个小文件每张约 4 s、每张约 27 MiB 元数据；20 万个约 20 s。一个装了 `node_modules` 的仓库就有几万个文件，而 `perRun` 在每轮开始前都要存一张，这个耗时直接加在每轮的首个响应之前。

ADR-006 还留下两个问题：

- 磁盘配额：目录挂载没有大小上限，`sandbox.resources.diskMb` 在 M2 里只能拒绝。
- 保留规则："每个会话保留最近 5 个"。用户的会话会很长，在第 50 轮之后分叉另做一件事、再聊 50 轮，想回到第 30 轮就没有存档了。pi 的分叉是同一份存储里的不同对话，任何一条记录都能分叉，存档不应该比对话先消失。

---

## 备选方案

| 维度 | A：目录 + reflink（ADR-006） | B：每会话一个 XFS 镜像文件 | C：目录 + rsync 硬链接（退路） |
|---|---|---|---|
| 存一张 | 与文件数成正比（5 万文件约 4 s） | 一次 `FICLONE`，含冻结约 0.3 s | 比较后复制改过的文件，大文件原地改动要整份复制 |
| 恢复 / 分叉 | 与文件数成正比 | 克隆镜像，不到 0.9 s | 完整复制 |
| 删除一张 | 删整棵目录树 | 删一个文件，约 4 ms | 删整棵目录树 |
| 磁盘上限 | 没有 | 镜像大小就是上限，写满报 "No space left on device" | 没有 |
| 宿主上看文件 | 直接看 | 看不到，要经 `tether files` 或文件 API | 直接看 |
| 前置条件 | XFS `reflink=1` | XFS `reflink=1`；losetup 需要特权 | 无 |

B 的完整链路在测试机上实测过：`tether` 用户 `mkfs.xfs -p <protofile>` 格式化自己的镜像文件；一次性特权容器 `losetup --find --show` 接成 loop 设备（约 0.4 s）；`docker volume create --driver local --opt type=xfs --opt device=/dev/loopN --opt o=nouuid` 建卷；`-v <卷>:/workspace:nocopy` 挂进容器。后台进程每 10 ms 写一次文件时，`docker pause` + `sync` + 克隆 + `unpause` 共 262 ms，恢复出的内容恰好是暂停那一刻的。

CubeSandbox 做法相同：每个沙箱一个磁盘镜像文件，快照是对镜像文件的 reflink，要求数据目录 `/data/cubelet` 是 XFS。

保留规则有三种：保留最近 N 张（ADR-006）；全部保留、靠人工钉住要长期保留的；全部保留、磁盘不够时按规则删。

---

## 决策

1. **支持 reflink 时，工作区是 `<数据目录>/workspaces/<会话>/disk.img`。** 大小是 `diskMb`，不填用 `TETHER_DEFAULT_DISK_MB`（默认 10240），稀疏文件不预占空间。XFS 的下限是 300 MB，`diskMb` 更小时创建 agent 版本就报 `invalid_request`。启动时在 `workspaces/` 和 `checkpoints/` 之间试一次 reflink，成功用镜像模式，失败退回目录模式（方案 C）并打一条警告；`TETHER_WORKSPACE_STORAGE` 可以指定。
2. **losetup 经一次性特权容器执行，Tether 进程不需要 root。** loop 设备一律用 `losetup --associated` 按设备号和 inode 查找。`/sys/block/loopN/loop/backing_file` 不能用：在容器里接上的设备，那里记的是相对于文件系统挂载点的路径，第一版因此泄漏了 20 个 loop 设备。
3. **挂载加 `nocopy`，镜像根目录用 protofile 交给沙箱用户。** 不加 `nocopy` 时 Docker 把镜像里 `/workspace` 的内容和 root 属主复制进空卷，沙箱用户写不进去。
4. **宿主重启后重新接 loop。** 容器的 `SandboxSpec` 记在标签 `tether.spec` 里。启动容器前发现卷记着的设备不再接着本会话的镜像，就删掉容器、重新接 loop、按标签重建容器；数据在镜像里，丢的只是容器层。
5. **快照前暂停容器。** 运行中的沙箱 `docker pause` → `sync` → 克隆 → `unpause`（放在 `finally`），后台进程冻结约 0.3 s；快照是同一时刻的一致状态。去掉暂停后，镜像模式的一致性用例立即失败。
6. **每轮都留存档，空闲空间低于下限才稀疏化。** 下限是 `TETHER_CHECKPOINT_MIN_FREE_PERCENT`（默认 10）。稀疏化最久没活动的会话先删，每个会话最新 5 张不动，更早的先删序号不是 10 的倍数的；每删一张重看一次空间。
7. **用"被引用"代替"钉住"。** 一张存档被未归档的分叉会话（`forkedFrom.checkpointId`）引用就不删，不另设 `pinned` 字段；会话归档时删掉它没被引用的存档，引用它的最后一个分叉归档后再删被引用的那张。几条记录共用一张快照时（沙箱丢失的那一轮沿用上一张），最后一条记录删掉才删文件。
8. **目录模式保留为退路。** 不支持 reflink 的数据目录照常能用：快照 `rsync -a --delete --link-dest`，恢复 `cp -a`，没有磁盘上限，`diskMb` 仍然拒绝。

存档的对齐、分叉时挑存档的规则、丢失恢复和闲置删除的流程见 spec §8.3–§8.5；执行中的具体决定见 `docs/superpowers/plans/2026-10-28-m3-rulings.md`。

---

## 后果

**正面**：
- 存一张、恢复、分叉的耗时与文件数无关，`perRun` 每轮多出的等待约 0.3 s。
- `diskMb` 有了真正的上限，写满只影响这个会话，宿主盘不受影响。
- 存档跟着对话走：任何一条记录都能分叉，空间不够时才变稀疏，被分叉用到的永远留着。
- 与 CubeSandbox 的做法一致，第二阶段对比时有共同基础。

**负面**：
- 宿主上看不到工作区里的单个文件，排查要经 `tether files`、`tether cat`。
- 每次准备工作区多一次一次性特权容器（约 0.4 s）；部署要允许 Tether 用 `--privileged` 跑 losetup（docker 组本来就等同 root）。
- 从 M2 升级、数据目录又在 XFS 上时，旧会话的工作区是目录，新代码按镜像找 `disk.img`；M3 不做迁移（CHANGELOG 的升级注意）。
- 稀疏化后在被删的位置分叉或恢复，会退到更早的一张，说明里列出中间没有发生的操作，不重放。
- 在 gVisor（`runsc`）下全部 Docker 测试通过；容器里 `/workspace` 显示为 `v9fs`（gVisor 的文件代理），容量和上限照样是镜像的。

ADR-006 中"工作区挂载、只快照 `/workspace`、不用 docker commit、ext4 退回 rsync"仍然有效；"目录级 `cp --reflink`"和"每个会话保留最近 5 个"由本 ADR 取代。

---

## 参考

- M3 计划的"设计决定"一节：`docs/superpowers/plans/2026-10-28-m3-checkpoints-and-forks.md`
- 执行中的决定：`docs/superpowers/plans/2026-10-28-m3-rulings.md`
- 设计文档 §4.2、§5.3、§8.3–§8.5：`docs/superpowers/specs/2026-10-20-tether-design.md`
- ADR-006（检查点用工作区挂载加 reflink）、ADR-008（闲置分两档）
- 实现：`packages/server/src/adapters/sandbox-docker/workspace-image.ts`、`snapshots.ts`、`packages/core/src/services/checkpoints.ts`、`packages/core/src/checkpoints.ts`

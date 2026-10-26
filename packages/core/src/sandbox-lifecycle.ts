import { TetherError } from "./errors.ts";
import type { SandboxState } from "./model.ts";

export type SandboxEvent = "create" | "setup_done" | "setup_failed" | "abandon" | "stop" | "start" | "vanish" | "destroy";

/** "absent" 表示还没有绑定，或者绑定已经删掉。 */
type From = SandboxState | "absent";

/**
 * 沙箱状态的全部合法转换（ADR-010）。SandboxService 的每次状态写入都先经过这里，
 * 表里没有的组合说明调用方的判断错了，报 conflict，不写入。
 */
const TRANSITIONS: Record<SandboxEvent, Partial<Record<From, From>>> = {
	// lost 也能 create：按模板重建（Task 6）
	create: { absent: "creating", lost: "creating" },
	setup_done: { creating: "running" },
	// setup 失败且容器已清掉：绑定删除
	setup_failed: { creating: "absent" },
	// setup 失败但清理也失败：容器可能还在，留到下次重建时再清
	abandon: { creating: "lost" },
	stop: { running: "stopped" },
	start: { stopped: "running" },
	vanish: { running: "lost", stopped: "lost" },
	destroy: { creating: "destroyed", running: "destroyed", stopped: "destroyed", lost: "destroyed", destroyed: "destroyed" },
};

/** 返回 undefined 表示转换后没有绑定。 */
export function nextState(from: SandboxState | undefined, event: SandboxEvent): SandboxState | undefined {
	const source: From = from ?? "absent";
	const target = TRANSITIONS[event][source];
	if (target === undefined) throw new TetherError("conflict", `cannot ${event} a sandbox that is ${source}`);
	return target === "absent" ? undefined : target;
}

import type { SandboxBinding } from "./model.ts";
import { NOTES, type SandboxNote } from "./notes.ts";
import type { AgentEngine, AppStore, SandboxProvider } from "./ports.ts";
import type { SessionService } from "./services/sessions.ts";

export interface Log {
	warn(message: string, detail?: unknown): void;
}

export interface RecoverDeps {
	store: AppStore;
	/** 已打开、还没 resume 的引擎。 */
	engine: AgentEngine;
	provider: SandboxProvider;
	sessions: SessionService;
	log: Log;
}

export interface RecoverResult {
	repairedSessions: number;
	lostBindings: number;
	removedOrphans: number;
	/**
	 * 对账发现的、要写进会话记录的说明。recover() 不写引擎：pi 的写入会开启调度，在 resume 之前写等于提前续跑。
	 * 由组装层在 recover() 返回之后逐条写入。
	 */
	notes: { sessionId: string; note: SandboxNote }[];
}

/** 已经不对应容器的绑定，对账时跳过。 */
const SETTLED: readonly SandboxBinding["state"][] = ["lost", "destroyed"];

/**
 * 启动恢复，顺序照设计文档 §4.5：
 * 1. 给"应用表有记录、引擎里没有会话"的半成品补建引擎会话（分叉会话补的是引擎分叉），补不了的标记 failed；
 * 2. 与 Docker 对账：按实际状态修正绑定，容器不在的标记 lost，没有绑定的容器删除；
 * 3. 引擎 resume()，继续崩溃前没跑完的提交。
 * 第 2 步必须在第 3 步之前，否则续跑的工具调用会拿到过期的沙箱状态。
 */
export async function recover(deps: RecoverDeps): Promise<RecoverResult> {
	const repaired = await repairSessions(deps);
	const { lostBindings, removedOrphans, notes } = await reconcileSandboxes(deps);
	deps.engine.resume();
	return { repairedSessions: repaired.count, lostBindings, removedOrphans, notes: [...repaired.notes, ...notes] };
}

/** 分叉会话补上引擎分叉后，分叉时没来得及写的说明一并交出去。 */
async function repairSessions({
	store,
	sessions,
	log,
}: RecoverDeps): Promise<{ count: number; notes: RecoverResult["notes"] }> {
	let count = 0;
	const notes: RecoverResult["notes"] = [];
	for (const session of await store.sessionsWithoutEngine()) {
		if (session.status === "failed") continue;
		let engineSessionId: string;
		try {
			engineSessionId = await sessions.attachEngine(session);
			count++;
		} catch (error) {
			await store.updateSession(session.id, { status: "failed" });
			log.warn(`session ${session.id} marked failed: its engine session cannot be created`, error);
			continue;
		}
		if (session.forkedFrom === null) continue;
		try {
			notes.push({ sessionId: session.id, note: await sessions.forkNote({ ...session, engineSessionId }) });
		} catch (error) {
			log.warn(`the fork note of session ${session.id} cannot be prepared`, error);
		}
	}
	return { count, notes };
}

async function reconcileSandboxes({
	store,
	provider,
	log,
}: RecoverDeps): Promise<Pick<RecoverResult, "lostBindings" | "removedOrphans" | "notes">> {
	let lostBindings = 0;
	let removedOrphans = 0;
	const notes: RecoverResult["notes"] = [];
	const kept = new Set<string>();

	for (const binding of await store.listBindings()) {
		if (SETTLED.includes(binding.state)) continue;
		// creating 说明 setup 跑到一半进程就没了，工作区状态不可信，删掉，下次工具调用重建
		if (binding.state === "creating") {
			await provider.destroy(binding.sandboxId);
			await store.deleteBinding(binding.sessionId);
			removedOrphans++;
			log.warn(`sandbox ${binding.sandboxId} of session ${binding.sessionId} was left half-created; removed`);
			continue;
		}
		const status = await provider.status(binding.sandboxId);
		if (status === "missing") {
			await store.updateBinding(binding.sessionId, { state: "lost", reason: "missing" }, { state: binding.state });
			lostBindings++;
			log.warn(`sandbox ${binding.sandboxId} of session ${binding.sessionId} is gone; binding marked lost`);
			continue;
		}
		kept.add(binding.sandboxId);
		if (status !== binding.state) {
			await store.updateBinding(binding.sessionId, { state: status }, { state: binding.state });
		}
		// 停机期间容器被停了，里面的进程都没了：和巡检发现时一样告诉模型，会话改为 idle
		if (binding.state === "running" && status === "stopped") {
			notes.push({
				sessionId: binding.sessionId,
				note: {
					kind: "tether.sandbox",
					data: { state: "stopped", reason: "stopped outside Tether" },
					modelText: NOTES.stoppedOutside,
				},
			});
			const session = await store.getSession(binding.sessionId);
			if (session?.status === "active") await store.updateSession(binding.sessionId, { status: "idle" });
		}
	}

	for (const { sandboxId, sessionId } of await provider.listManaged()) {
		if (kept.has(sandboxId)) continue;
		await provider.destroy(sandboxId);
		removedOrphans++;
		log.warn(`removed orphan sandbox ${sandboxId} (session ${sessionId})`);
	}
	return { lostBindings, removedOrphans, notes };
}

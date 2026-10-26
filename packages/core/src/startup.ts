import type { SandboxBinding } from "./model.ts";
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
}

/** 已经不对应容器的绑定，对账时跳过。 */
const SETTLED: readonly SandboxBinding["state"][] = ["lost", "destroyed"];

/**
 * 启动恢复，顺序照设计文档 §4.5：
 * 1. 给"应用表有记录、引擎里没有会话"的半成品补建引擎会话，补不了的标记 failed；
 * 2. 与 Docker 对账：按实际状态修正绑定，容器不在的标记 lost，没有绑定的容器删除；
 * 3. 引擎 resume()，继续崩溃前没跑完的提交。
 * 第 2 步必须在第 3 步之前，否则续跑的工具调用会拿到过期的沙箱状态。
 */
export async function recover(deps: RecoverDeps): Promise<RecoverResult> {
	const repairedSessions = await repairSessions(deps);
	const { lostBindings, removedOrphans } = await reconcileSandboxes(deps);
	deps.engine.resume();
	return { repairedSessions, lostBindings, removedOrphans };
}

async function repairSessions({ store, sessions, log }: RecoverDeps): Promise<number> {
	let repaired = 0;
	for (const session of await store.sessionsWithoutEngine()) {
		if (session.status === "failed") continue;
		try {
			await sessions.attachEngine(session);
			repaired++;
		} catch (error) {
			await store.updateSession(session.id, { status: "failed" });
			log.warn(`session ${session.id} marked failed: its engine session cannot be created`, error);
		}
	}
	return repaired;
}

async function reconcileSandboxes({
	store,
	provider,
	log,
}: RecoverDeps): Promise<Pick<RecoverResult, "lostBindings" | "removedOrphans">> {
	let lostBindings = 0;
	let removedOrphans = 0;
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
			await store.updateBinding(binding.sessionId, { state: "lost" }, { state: binding.state });
			lostBindings++;
			log.warn(`sandbox ${binding.sandboxId} of session ${binding.sessionId} is gone; binding marked lost`);
			continue;
		}
		kept.add(binding.sandboxId);
		if (status !== binding.state) {
			await store.updateBinding(binding.sessionId, { state: status }, { state: binding.state });
		}
	}

	for (const { sandboxId, sessionId } of await provider.listManaged()) {
		if (kept.has(sandboxId)) continue;
		await provider.destroy(sandboxId);
		removedOrphans++;
		log.warn(`removed orphan sandbox ${sandboxId} (session ${sessionId})`);
	}
	return { lostBindings, removedOrphans };
}

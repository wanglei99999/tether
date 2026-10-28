import { restorePoint } from "../checkpoints.ts";
import { TetherError } from "../errors.ts";
import type { CheckpointRecord, SandboxBinding, SessionRecord } from "../model.ts";
import type { AgentEngine, AppStore, Clock, Ids, SandboxProvider } from "../ports.ts";
import type { Log } from "../startup.ts";
import type { SandboxRecord, SandboxService } from "./sandboxes.ts";

export interface CheckpointServiceDeps {
	store: AppStore;
	sandboxes: Pick<SandboxService, "snapshot">;
	provider: Pick<SandboxProvider, "deleteSnapshot">;
	/** submissionEntry 找一轮的用户条目；transcript 找最终存档对齐的最新条目。 */
	engine: Pick<AgentEngine, "submissionEntry" | "transcript">;
	clock: Clock;
	ids: Ids;
	record: SandboxRecord;
	log: Log;
}

/** 这一轮开始时工作区是什么：一张新快照、沿用的快照、模板（null），或者不记（undefined）。 */
type RoundStart = { snapshotId: string | null; taken: boolean } | undefined;

/**
 * 每轮存档（spec §8.3 perRun）：一轮运行第一次请求模型之前，给工作区存一张档，对齐到触发这一轮的用户条目。
 * 一轮的标识是提交 ID：钩子在一轮里每次请求都会调用，崩溃恢复后也会再调用，已经记过的提交直接跳过。
 */
export class CheckpointService {
	readonly #deps: CheckpointServiceDeps;

	constructor(deps: CheckpointServiceDeps) {
		this.#deps = deps;
	}

	/** 引擎的运行开始钩子（RunStartListener）。存档失败不打断这一轮：记日志，写一条客户端可见的条目。 */
	async onRunStart(sessionId: string, submissionId: string): Promise<void> {
		try {
			await this.#checkpoint(sessionId, submissionId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#deps.log.warn(`checkpoint of session ${sessionId} for submission ${submissionId} failed`, error);
			await this.#deps
				.record(sessionId, { kind: "tether.checkpoint", data: { submissionId, error: message } })
				.catch((recordError: unknown) => this.#deps.log.warn("recording a failed checkpoint failed", recordError));
		}
	}

	async #checkpoint(sessionId: string, submissionId: string): Promise<void> {
		const { store, engine, provider, clock, ids, record } = this.#deps;
		if (await store.checkpointForSubmission(submissionId)) return;
		const session = await store.getSession(sessionId);
		if (!session || !(await this.#perRun(session))) return;

		const started = Date.now();
		const start = await this.#roundStart(sessionId);
		if (start === undefined) return;
		const durationMs = start.taken ? Date.now() - started : 0;
		const discard = async () => {
			if (start.taken && start.snapshotId !== null) await provider.deleteSnapshot(start.snapshotId);
		};

		const entryId = await engine.submissionEntry(submissionId);
		if (entryId === undefined) {
			// 钩子触发时输入已经放进对话，不该走到这里
			await discard();
			this.#deps.log.warn(`submission ${submissionId} has no user entry yet; no checkpoint for this round`);
			return;
		}
		const checkpoint: CheckpointRecord = {
			id: ids.next("cp"),
			sessionId,
			submissionId,
			entryId,
			snapshotId: start.snapshotId,
			kind: "filesystem",
			createdAt: clock.now(),
		};
		try {
			await store.addCheckpoint(checkpoint);
		} catch (error) {
			await discard();
			// 同一轮的另一次调用先记上了：它的快照留下，自己的删掉
			if (error instanceof TetherError && error.code === "conflict") return;
			throw error;
		}
		await record(sessionId, {
			kind: "tether.checkpoint",
			data: { checkpointId: checkpoint.id, entryId, durationMs, ...(start.snapshotId === null && { template: true }) },
		});
	}

	/**
	 * 闲置删除前的最终存档（设计决定 9）：对齐到会话记录的最新一条，沙箱已经停止，之后工作区不会再变。
	 * 每个沙箱至多一张（提交 ID 带上沙箱的创建时间）；策略不是 perRun、会话还没有记录时不存。
	 * 快照由 take 在调用方持有的会话锁里存。失败只记日志、返回 false，调用方照样删除沙箱。
	 */
	async final(binding: SandboxBinding, take: () => Promise<string>): Promise<boolean> {
		const { store, engine, provider, clock, ids, record, log } = this.#deps;
		const { sessionId } = binding;
		const submissionId = `final:${sessionId}:${binding.createdAt}`;
		try {
			if (await store.checkpointForSubmission(submissionId)) return true;
			const session = await store.getSession(sessionId);
			if (!session?.engineSessionId || !(await this.#perRun(session))) return false;
			const [latest] = (await engine.transcript(session.engineSessionId, { limit: 1 })).items;
			if (latest === undefined) return false;

			const started = Date.now();
			const snapshotId = await take();
			const checkpoint: CheckpointRecord = {
				id: ids.next("cp"),
				sessionId,
				submissionId,
				entryId: latest.id,
				snapshotId,
				kind: "filesystem",
				createdAt: clock.now(),
			};
			await store.addCheckpoint(checkpoint).catch(async (error: unknown) => {
				await provider.deleteSnapshot(snapshotId);
				throw error;
			});
			await record(sessionId, {
				kind: "tether.checkpoint",
				data: { checkpointId: checkpoint.id, entryId: latest.id, durationMs: Date.now() - started, final: true },
			});
			return true;
		} catch (error) {
			log.warn(`final checkpoint of session ${sessionId} failed`, error);
			return false;
		}
	}

	async #perRun(session: SessionRecord): Promise<boolean> {
		const version = await this.#deps.store.getVersion(session.agentId, session.agentVersion);
		return version?.spec.checkpointPolicy === "perRun";
	}

	/**
	 * - 沙箱在（运行或停止）：存一张新快照。
	 * - 还没有沙箱：工作区就是第一次工具调用时会建出来的那个，普通会话是模板（null），分叉会话是分叉选中的存档。
	 *   这条记录也挡住了同一轮后面的调用：这一轮的工具调用建出沙箱之后，不能再在半轮的状态上存档。
	 * - 沙箱丢了：下一次工具调用从 restorePoint 那张存档重建，这一轮开始时的工作区就是它，沿用它的快照（没有就是模板）。
	 * - 创建中、已销毁：不记。
	 */
	async #roundStart(sessionId: string): Promise<RoundStart> {
		const { store } = this.#deps;
		const result = await this.#deps.sandboxes.snapshot(sessionId);
		if ("snapshotId" in result) return { snapshotId: result.snapshotId, taken: true };
		if (result.state === "absent") return { snapshotId: await this.#forkSnapshot(sessionId), taken: false };
		if (result.state === "lost") {
			const session = await store.getSession(sessionId);
			const point = session ? await restorePoint(store, session) : undefined;
			return { snapshotId: point?.snapshotId ?? null, taken: false };
		}
		return undefined;
	}

	/** 分叉会话选中的存档的快照；不是分叉会话、存档是模板或已被清理时为 null。 */
	async #forkSnapshot(sessionId: string): Promise<string | null> {
		const checkpointId = (await this.#deps.store.getSession(sessionId))?.forkedFrom?.checkpointId;
		if (checkpointId === undefined || checkpointId === null) return null;
		return (await this.#deps.store.getCheckpoint(checkpointId))?.snapshotId ?? null;
	}
}

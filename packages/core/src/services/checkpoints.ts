import { restorePoint } from "../checkpoints.ts";
import { TetherError } from "../errors.ts";
import type { CheckpointRecord, SandboxBinding, SessionRecord } from "../model.ts";
import type { AgentEngine, AppStore, Clock, Ids, SandboxProvider } from "../ports.ts";
import type { Log } from "../startup.ts";
import type { SandboxRecord, SandboxService } from "./sandboxes.ts";

export interface CheckpointServiceDeps {
	store: AppStore;
	sandboxes: Pick<SandboxService, "snapshot">;
	/** deleteSnapshot 删快照文件；storage 看存档所在的盘还剩多少，稀疏化按它判断。 */
	provider: Pick<SandboxProvider, "deleteSnapshot" | "storage">;
	/** submissionEntry 找一轮的用户条目；transcript 找最终存档对齐的最新条目。 */
	engine: Pick<AgentEngine, "submissionEntry" | "transcript">;
	clock: Clock;
	ids: Ids;
	record: SandboxRecord;
	log: Log;
	/** 存档所在的盘空闲比例低于它就稀疏化，默认 DEFAULT_MIN_FREE_RATIO。 */
	minFreeRatio?: number;
}

export const DEFAULT_MIN_FREE_RATIO = 0.1;
/** 稀疏化不动每个会话最新的这么多张（设计决定 9）。 */
export const KEEP_NEWEST_CHECKPOINTS = 5;
/** 稀疏化先删序号不是它的倍数的，留下稀疏的一串，分叉和恢复时离得不会太远。 */
export const THIN_STRIDE = 10;

const byEntry = (a: CheckpointRecord, b: CheckpointRecord) => Number(a.entryId) - Number(b.entryId);

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

	/**
	 * 归档会话的存档清理（设计决定 9）：删掉没被未归档的分叉引用的那些。会话是从另一个已归档的会话分叉来的，
	 * 对那个会话也清理一次：引用它的最后一个分叉归档之后，它被引用的存档才能删。会话没归档时什么都不做。
	 */
	async collect(sessionId: string): Promise<number> {
		const { store } = this.#deps;
		const session = await store.getSession(sessionId);
		if (session?.status !== "archived") return 0;
		let removed = 0;
		for (const checkpoint of await store.listCheckpoints(sessionId)) {
			if (await store.checkpointReferenced(checkpoint.id)) continue;
			await this.#remove(checkpoint);
			removed++;
		}
		const source = session.forkedFrom?.sessionId;
		return source === undefined ? removed : removed + (await this.collect(source));
	}

	/**
	 * 存档所在的盘空闲比例低于下限时稀疏化，一张一张删，每删一张重新看空间，够了就停。顺序：
	 * 最久没活动的会话先删；每个会话最新 KEEP_NEWEST_CHECKPOINTS 张不动；同一会话里先删序号（按条目从旧到新，0 起）
	 * 不是 THIN_STRIDE 倍数的，再删其余的，都从旧到新。被分叉引用的、模板存档（不占空间）不删。
	 * 只记日志：之后在那里分叉或恢复，会找到更早的一张，说明里列出没有发生的操作。
	 */
	async thin(): Promise<number> {
		if (await this.#enoughSpace()) return 0;
		let removed = 0;
		for (const checkpoint of await this.#thinCandidates()) {
			await this.#remove(checkpoint);
			removed++;
			this.#deps.log.warn(
				`free space for checkpoints is low; removed checkpoint ${checkpoint.id} of session ${checkpoint.sessionId} (entry ${checkpoint.entryId})`,
			);
			if (await this.#enoughSpace()) break;
		}
		return removed;
	}

	async #enoughSpace(): Promise<boolean> {
		const { freeBytes, totalBytes } = await this.#deps.provider.storage();
		return totalBytes > 0 && freeBytes / totalBytes >= (this.#deps.minFreeRatio ?? DEFAULT_MIN_FREE_RATIO);
	}

	async #thinCandidates(): Promise<CheckpointRecord[]> {
		const { store } = this.#deps;
		const bySession = new Map<string, CheckpointRecord[]>();
		for (const checkpoint of await store.listAllCheckpoints()) {
			bySession.set(checkpoint.sessionId, [...(bySession.get(checkpoint.sessionId) ?? []), checkpoint]);
		}
		const sessions = await Promise.all(
			[...bySession.keys()].map(async (id) => ({ id, lastActiveAt: (await store.getSession(id))?.lastActiveAt ?? "" })),
		);
		sessions.sort((a, b) => a.lastActiveAt.localeCompare(b.lastActiveAt));

		const ordered: CheckpointRecord[] = [];
		for (const { id } of sessions) {
			const all = [...(bySession.get(id) ?? [])].sort(byEntry);
			const older = all.slice(0, Math.max(0, all.length - KEEP_NEWEST_CHECKPOINTS)).map((checkpoint, index) => ({ checkpoint, index }));
			const sparse = older.filter(({ index }) => index % THIN_STRIDE !== 0);
			const strided = older.filter(({ index }) => index % THIN_STRIDE === 0);
			ordered.push(...[...sparse, ...strided].map(({ checkpoint }) => checkpoint));
		}
		const candidates: CheckpointRecord[] = [];
		for (const checkpoint of ordered) {
			if (checkpoint.snapshotId !== null && !(await store.checkpointReferenced(checkpoint.id))) candidates.push(checkpoint);
		}
		return candidates;
	}

	/**
	 * 删一条存档记录；快照没有别的记录再用（沙箱丢失的那一轮沿用上一张快照，几条记录可以共用一张）才删快照文件。
	 * 先删记录：删文件前崩溃留下的没有记录的文件，由启动对账删掉。
	 */
	async #remove(checkpoint: CheckpointRecord): Promise<void> {
		const { store, provider } = this.#deps;
		await store.deleteCheckpoint(checkpoint.id);
		if (checkpoint.snapshotId === null) return;
		const shared = (await store.listAllCheckpoints()).some((other) => other.snapshotId === checkpoint.snapshotId);
		if (!shared) await provider.deleteSnapshot(checkpoint.snapshotId);
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

import type { DirEntry, ExecResult, TetherEnv } from "../env.ts";
import { TetherError } from "../errors.ts";
import { KeyedLock } from "../lock.ts";
import type { BindingPatch, SandboxBinding, SandboxState } from "../model.ts";
import { NOTES, type SandboxNote } from "../notes.ts";
import type { AgentEngine, AppStore, Clock, ExecChannel, SandboxProvider } from "../ports.ts";
import { nextState, type SandboxEvent } from "../sandbox-lifecycle.ts";
import type { Log } from "../startup.ts";

export type SandboxRecord = (sessionId: string, note: SandboxNote) => Promise<void>;

export interface SandboxServiceDeps {
	store: AppStore;
	provider: SandboxProvider;
	exec: ExecChannel;
	/** 巡检用它判断会话是否正在运行：正在跑的会话不算闲置。 */
	engine: Pick<AgentEngine, "isRunning">;
	clock: Clock;
	/** 写一条条目进会话记录（设计文档 §4.4），由组装层接到引擎的 appendEntry。 */
	record: SandboxRecord;
	log: Log;
	/** 每条 setup 命令的上限。不设上限的话，一条不退出的命令（连不上的 git clone）会让会话一直等下去。 */
	setupTimeoutMs?: number;
	/** 同时运行（含创建中）的沙箱上限，默认 DEFAULT_MAX_RUNNING_SANDBOXES（spec §4.6）。 */
	maxRunning?: number;
	/** 会话不在运行、沙箱这么久没用就停止，默认 DEFAULT_STOP_AFTER_MS（spec §8.5）。 */
	stopAfterMs?: number;
}

/** 一轮巡检停掉和标记丢失的沙箱数。 */
export interface SweepResult {
	stoppedIdle: number;
	stoppedOutside: number;
	lost: number;
}

export const WORKSPACE = "/workspace";
export const DEFAULT_SETUP_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_RUNNING_SANDBOXES = 4;
export const DEFAULT_STOP_AFTER_MS = 60 * 60 * 1000;
/** 文件下载的上限。 */
export const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;

const tooLarge = () => new TetherError("invalid_request", "file is larger than 10 MiB");
/** 准入锁只有一把，所有会话共用这个键。 */
const ADMISSION = "admission";
/** setup 失败时错误消息里保留的输出长度。 */
const OUTPUT_TAIL_BYTES = 4096;

function tail(text: string): string {
	return text.length <= OUTPUT_TAIL_BYTES ? text : `…${text.slice(-OUTPUT_TAIL_BYTES)}`;
}

function setupFailure(command: string, result: ExecResult): TetherError {
	const output = [result.stdout && `stdout:\n${tail(result.stdout)}`, result.stderr && `stderr:\n${tail(result.stderr)}`]
		.filter(Boolean)
		.join("\n");
	return new TetherError(
		"sandbox_failed",
		`sandbox setup failed: \`${command}\` exited with exit code ${result.exitCode}${output ? `\n${output}` : ""}`,
		{ command, exitCode: result.exitCode },
	);
}

/** 会话的沙箱：第一次需要时创建并执行 setup，之后复用；停止了就启动。状态转换见 sandbox-lifecycle.ts。 */
export class SandboxService {
	readonly #deps: SandboxServiceDeps;
	/** 同一个会话的沙箱操作排队执行：工具调用、巡检、重建、归档不会交错。 */
	readonly #lock = new KeyedLock();
	/** 全局的准入锁，总在会话锁之内获取：先会话锁，再准入锁。 */
	readonly #admission = new KeyedLock();
	/**
	 * 刚创建或刚启动、还没连过 daemon 的会话：容器里没有旧进程，这次连接不用告诉模型。
	 * 其余连接都是重连。只在内存里：服务重启后为空，重启后的第一次连接也写说明（崩溃时 daemon 退出会带走后台进程）。
	 */
	readonly #fresh = new Set<string>();
	/** 绑定变成 lost 的原因，重建时写进模型可见的说明。只在内存里：服务重启后缺省为 "missing"。 */
	readonly #lostReasons = new Map<string, string>();

	constructor(deps: SandboxServiceDeps) {
		this.#deps = deps;
	}

	ensureSandbox(sessionId: string): Promise<SandboxBinding> {
		return this.#lock.run(sessionId, () => this.#ensure(sessionId));
	}

	/**
	 * 删掉会话的容器和工作区，绑定留作记录，状态为 destroyed（之后 ensureSandbox 报 conflict）。
	 * 没有绑定或已经 destroyed 时什么都不做；后端删除失败时绑定不变，可以重试。
	 */
	destroy(sessionId: string, reason: string): Promise<void> {
		return this.#lock.run(sessionId, async () => {
			const { store, provider, exec } = this.#deps;
			const binding = await store.getBinding(sessionId);
			if (!binding || binding.state === "destroyed") return;
			exec.close(binding.sandboxId);
			await provider.destroy(binding.sandboxId);
			await this.#transition(binding, "destroy");
			this.#fresh.delete(sessionId);
			this.#lostReasons.delete(sessionId);
			await this.#note(sessionId, { state: "destroyed", reason });
		});
	}

	status(sessionId: string): Promise<SandboxBinding | undefined> {
		return this.#deps.store.getBinding(sessionId);
	}

	/** 列出工作区里的一个目录，path 相对 /workspace，空字符串即 /workspace。 */
	listFiles(sessionId: string, path: string): Promise<DirEntry[]> {
		return this.#browse(sessionId, path, async (env, real) => {
			if ((await env.info(real)).kind !== "dir") throw new TetherError("invalid_request", `${path} is not a directory`);
			return env.list(real);
		});
	}

	/** 读工作区里的一个文件，最大 MAX_DOWNLOAD_BYTES。 */
	readFile(sessionId: string, path: string): Promise<{ name: string; content: Uint8Array }> {
		return this.#browse(sessionId, path, async (env, real) => {
			const info = await env.info(real);
			if (info.kind !== "file") throw new TetherError("invalid_request", `${path} is not a regular file`);
			if (info.size > MAX_DOWNLOAD_BYTES) throw tooLarge();
			const content = await env.readBytes(real);
			// 文件可能在 info 和读取之间变大
			if (content.byteLength > MAX_DOWNLOAD_BYTES) throw tooLarge();
			return { name: info.name, content };
		});
	}

	/**
	 * 浏览文件的公共部分：在会话锁里拿到可用的沙箱（没有就 not_found，不为看文件创建；停止的启动，丢失的重建），
	 * 把路径解析成真实路径（符号链接跟到底），不在 /workspace 下就拒绝。不刷新 lastUsedAt：看文件不算在用沙箱。
	 * 已知限制：解析和读取之间，沙箱里的进程可以把路径上的目录换成符号链接；读到的仍是容器里的文件。
	 */
	#browse<T>(sessionId: string, path: string, use: (env: TetherEnv, real: string) => Promise<T>): Promise<T> {
		return this.#lock.run(sessionId, async () => {
			const { store, exec } = this.#deps;
			if (!(await store.getSession(sessionId))) throw new TetherError("not_found", `session ${sessionId} not found`);
			let binding = await store.getBinding(sessionId);
			if (!binding) throw new TetherError("not_found", `session ${sessionId} has no sandbox yet`);
			if (binding.state !== "running") binding = await this.#ensure(sessionId);
			const env = exec.env(binding, { cwd: WORKSPACE });
			const real = await env.realPath(path === "" ? "." : path);
			if (real !== WORKSPACE && !real.startsWith(`${WORKSPACE}/`)) {
				throw new TetherError("invalid_request", "path is outside /workspace");
			}
			return use(env, real);
		});
	}

	/**
	 * ExecChannel 每次启动 daemon 前调用：取新 epoch，杀掉旧 epoch 的 daemon 和它的命令，返回新 daemon 的启动命令。
	 * 不拿会话锁：setup 在 ensureSandbox 持锁时经 ExecChannel 发命令，这里再拿同一把锁会死锁。
	 * epoch 的原子性由 nextEpoch 保证；一个容器同一时刻只有一条连接由 ExecChannel 按 sandboxId 复用连接保证。
	 */
	async connect(sessionId: string): Promise<readonly string[]> {
		const { store, provider } = this.#deps;
		const binding = await store.getBinding(sessionId);
		if (binding?.state !== "creating" && binding?.state !== "running") {
			throw new TetherError("conflict", `cannot connect a sandbox that is ${binding?.state ?? "absent"}`);
		}
		const epoch = await store.nextEpoch(sessionId);
		const { killed } = await provider.fence(binding.sandboxId, epoch);
		// 不是创建或启动后的第一次连接，就是重连：旧连接的后台进程刚被杀掉，告诉模型
		if (!this.#fresh.delete(sessionId)) {
			await this.#deps.record(sessionId, {
				kind: "tether.sandbox",
				data: { state: binding.state, reason: "reconnected", epoch, killed },
				modelText: NOTES.reconnected,
			});
		}
		return provider.daemonCommand(binding.sandboxId, epoch);
	}

	/**
	 * 定期巡检：和后端核对每个 running、stopped 的绑定，停掉闲置的沙箱。
	 * 每个会话在自己的锁里处理，和工具调用排队；一个会话出错只记日志，不影响其他会话。
	 */
	async sweep(): Promise<SweepResult> {
		const { store, provider, log } = this.#deps;
		const result: SweepResult = { stoppedIdle: 0, stoppedOutside: 0, lost: 0 };
		// 先取绑定再取容器：之后才建的沙箱不在这一轮里，不会因为列表里没有它而被误判丢失
		const bindings = (await store.listBindings()).filter((b) => b.state === "running" || b.state === "stopped");
		const listed = new Map((await provider.listManaged()).map((s) => [s.sandboxId, s.status]));
		for (const { sessionId } of bindings) {
			try {
				const outcome = await this.#lock.run(sessionId, () => this.#sweepOne(sessionId, listed));
				if (outcome) result[outcome]++;
			} catch (error) {
				log.warn(`sweeping the sandbox of session ${sessionId} failed`, error);
			}
		}
		return result;
	}

	async #sweepOne(
		sessionId: string,
		listed: ReadonlyMap<string, "running" | "stopped">,
	): Promise<keyof SweepResult | undefined> {
		const { store, provider, exec, engine, clock } = this.#deps;
		// 等锁期间工具调用可能已经改了绑定，以锁内读到的为准
		const binding = await store.getBinding(sessionId);
		if (binding?.state !== "running" && binding?.state !== "stopped") return undefined;
		let status: "running" | "stopped" | "missing" = listed.get(binding.sandboxId) ?? "missing";
		// 列表是锁外取的，和绑定不一致时再问一次后端
		if (status !== binding.state) status = await provider.status(binding.sandboxId);

		if (status === "missing") {
			exec.close(binding.sandboxId);
			await this.#markLost(binding, "vanish", "missing");
			return "lost";
		}
		if (binding.state === "stopped") return undefined;

		if (status === "stopped") {
			exec.close(binding.sandboxId);
			await this.#transition(binding, "stop");
			await this.#stoppedNote(sessionId, "stopped outside Tether", NOTES.stoppedOutside);
			return "stoppedOutside";
		}

		const session = await store.getSession(sessionId);
		if (session?.engineSessionId && (await engine.isRunning(session.engineSessionId))) {
			// 正在跑（例如一条长命令）不算闲置；闲置从这一轮结束后算起
			await store.updateBinding(sessionId, { lastUsedAt: clock.now() }, { state: "running" });
			return undefined;
		}
		const stopAfterMs = this.#deps.stopAfterMs ?? DEFAULT_STOP_AFTER_MS;
		if (Date.parse(clock.now()) - Date.parse(binding.lastUsedAt) < stopAfterMs) return undefined;

		await provider.stop(binding.sandboxId);
		exec.close(binding.sandboxId);
		await this.#transition(binding, "stop");
		await this.#stoppedNote(sessionId, "idle", NOTES.stoppedIdle(Math.round(stopAfterMs / 60_000)));
		return "stoppedIdle";
	}

	/** 沙箱停了：写模型可见的说明，活动中的会话改为 idle。 */
	async #stoppedNote(sessionId: string, reason: string, modelText: string): Promise<void> {
		await this.#deps.record(sessionId, { kind: "tether.sandbox", data: { state: "stopped", reason }, modelText });
		const session = await this.#deps.store.getSession(sessionId);
		if (session?.status === "active") await this.#deps.store.updateSession(sessionId, { status: "idle" });
	}

	async #ensure(sessionId: string): Promise<SandboxBinding> {
		const { store, provider, clock } = this.#deps;
		let binding = await store.getBinding(sessionId);
		// 每次工具调用都走这里，运行中的直接用，不过准入，只刷新最后使用时间。
		// 容器在运行中丢失由巡检或执行通道的报错发现。
		if (binding?.state === "running") {
			return store.updateBinding(sessionId, { lastUsedAt: clock.now() }, { state: "running" });
		}
		if (binding?.state === "stopped") {
			if ((await provider.status(binding.sandboxId)) !== "missing") {
				const stopped = binding;
				return this.#admit(sessionId, () => this.#start(stopped));
			}
			// 停着的容器不见了：和巡检发现时一样标成 lost，接着重建
			binding = await this.#markLost(binding, "vanish", "missing");
		}
		// 按状态表检查能不能创建：absent 和 lost 可以，destroyed（归档）不行
		nextState(binding?.state, "create");
		return this.#create(sessionId, binding);
	}

	/** 标成 lost 并记下原因；客户端看得到，模型等重建时再告诉（NOTES.reset）。 */
	async #markLost(binding: SandboxBinding, event: SandboxEvent, reason: string): Promise<SandboxBinding> {
		const lost = await this.#transition(binding, event);
		this.#lostReasons.set(binding.sessionId, reason);
		await this.#note(binding.sessionId, { state: "lost", reason });
		return lost;
	}

	async #start(binding: SandboxBinding): Promise<SandboxBinding> {
		const { provider } = this.#deps;
		await provider.start(binding.sandboxId);
		this.#fresh.add(binding.sessionId);
		const running = await this.#transition(binding, "start", { lastUsedAt: this.#deps.clock.now() });
		await this.#note(binding.sessionId, { state: "running", reason: "started" });
		return running;
	}

	/**
	 * 按模板创建沙箱并执行 setup。给了 lost 的旧绑定就是重建：先删掉旧容器和工作区，再新建，成功后告诉模型环境重置了。
	 * 旧绑定一直留到新容器建好：被准入拒绝或 docker run 失败时绑定还是 lost，下次仍按重建处理。
	 */
	async #create(sessionId: string, lost?: SandboxBinding): Promise<SandboxBinding> {
		const { store, provider, exec, clock } = this.#deps;
		const session = await store.getSession(sessionId);
		if (!session) throw new TetherError("not_found", `session ${sessionId} not found`);
		const version = await store.getVersion(session.agentId, session.agentVersion);
		if (!version) {
			throw new TetherError("internal", `session ${sessionId} pins missing version ${session.agentVersion}`);
		}
		const spec = version.spec.sandbox;

		// 删旧容器和工作区可能很慢，放在准入锁外面；删除可以重复，被准入拒绝或新建失败时绑定还是 lost
		if (lost) {
			exec.close(lost.sandboxId);
			await provider.destroy(lost.sandboxId);
		}
		// 写下 creating 就占住了名额，setup 可能跑几分钟，在准入锁外面跑
		const creating = await this.#admit(sessionId, async () => {
			const { sandboxId } = await provider.create({ sessionId, spec });
			// 新容器建好了才删旧绑定：docker run 失败时绑定留在 lost，下次仍按重建处理并告诉模型
			if (lost) await store.deleteBinding(sessionId);
			const at = clock.now();
			const binding: SandboxBinding = {
				sessionId,
				provider: provider.name,
				sandboxId,
				epoch: 0,
				state: "creating",
				template: spec.template,
				createdAt: at,
				lastUsedAt: at,
			};
			await store.createBinding(binding);
			return binding;
		});
		this.#fresh.add(sessionId);

		try {
			await this.#runSetup(creating, spec.setup, session.variables);
		} catch (error) {
			await this.#cleanUpFailedSetup(creating, lost !== undefined);
			throw error;
		}

		const running = await this.#transition(creating, "setup_done");
		if (lost) {
			const reason = this.#lostReasons.get(sessionId) ?? "missing";
			this.#lostReasons.delete(sessionId);
			await this.#deps.record(sessionId, {
				kind: "tether.sandbox",
				data: { state: "running", reason: "recovered" },
				modelText: NOTES.reset(reason),
			});
		} else {
			await this.#note(sessionId, { state: "running", reason: "created" });
		}
		return running;
	}

	/**
	 * 新占一个运行名额（创建、启动）之前的准入检查。数数和占位（occupy 里写 creating 或 running）在同一把全局锁里，
	 * 几个会话同时第一次调用工具时不会都数到"还有空位"。本会话自己的绑定不算。
	 */
	#admit<T>(sessionId: string, occupy: () => Promise<T>): Promise<T> {
		return this.#admission.run(ADMISSION, async () => {
			const limit = this.#deps.maxRunning ?? DEFAULT_MAX_RUNNING_SANDBOXES;
			const running = (await this.#deps.store.listBindings()).filter(
				(b) => b.sessionId !== sessionId && (b.state === "running" || b.state === "creating"),
			).length;
			if (running >= limit) {
				// 模型从工具的错误结果里已经看到原因，这条只给客户端看
				await this.#deps.record(sessionId, { kind: "tether.admission", data: { limit, running } });
				throw new TetherError(
					"sandbox_limit",
					`sandbox limit reached: ${running} of ${limit} sandboxes are running; try again after another session goes idle`,
				);
			}
			return occupy();
		});
	}

	async #runSetup(binding: SandboxBinding, setup: readonly string[], variables: Record<string, string>): Promise<void> {
		const timeoutMs = this.#deps.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS;
		const env = this.#deps.exec.env(binding, { cwd: WORKSPACE });
		for (const command of setup) {
			// 变量只经环境变量传入，命令原样执行（设计文档 §5.1）
			const result = await env.exec(command, { env: variables, timeoutMs }).catch((error: unknown) => {
				const reason = error instanceof Error ? error.message : String(error);
				throw new TetherError("sandbox_failed", `sandbox setup failed: \`${command}\`: ${reason}`, { command });
			});
			if (result.exitCode !== 0) throw setupFailure(command, result);
		}
	}

	/**
	 * setup 失败后的清理。每一步失败只记日志，调用方随后抛出原始的 setup 错误。
	 * 容器删掉了就删绑定（setup_failed），下次从头创建；没删掉，或这是一次重建，就把绑定标成 lost（abandon），
	 * 下次按重建处理：再删一次残留，并告诉模型环境重置了。
	 */
	async #cleanUpFailedSetup(binding: SandboxBinding, rebuilding: boolean): Promise<void> {
		const { exec, provider, store, log } = this.#deps;
		const { sessionId, sandboxId } = binding;
		try {
			exec.close(sandboxId);
		} catch (error) {
			log.warn(`closing the connection to sandbox ${sandboxId} failed after setup failed`, error);
		}
		let destroyed = true;
		try {
			await provider.destroy(sandboxId);
		} catch (error) {
			destroyed = false;
			log.warn(`destroy of sandbox ${sandboxId} failed after setup failed; binding marked lost`, error);
		}
		try {
			if (!destroyed) {
				await this.#markLost(binding, "abandon", "cleanup failed");
			} else if (rebuilding) {
				// 重建失败：绑定留在 lost，原来的丢失原因不变，下次仍按重建处理并告诉模型环境重置了
				await this.#transition(binding, "abandon");
				await this.#note(sessionId, { state: "lost", reason: "setup failed" });
			} else {
				nextState(binding.state, "setup_failed");
				await store.deleteBinding(sessionId);
				await this.#note(sessionId, { state: "destroyed", reason: "setup failed" });
			}
		} catch (error) {
			log.warn(`recording the failed setup of sandbox ${sandboxId} failed`, error);
		}
	}

	/** 唯一改状态的地方：按状态表算出新状态，并要求存储里的当前状态仍是 binding.state。 */
	async #transition(
		binding: SandboxBinding,
		event: SandboxEvent,
		patch: Omit<BindingPatch, "state"> = {},
	): Promise<SandboxBinding> {
		const state = nextState(binding.state, event);
		if (state === undefined) {
			throw new TetherError("internal", `${event} removes the binding; delete it instead of updating`);
		}
		return this.#deps.store.updateBinding(binding.sessionId, { ...patch, state }, { state: binding.state });
	}

	#note(sessionId: string, data: { state: SandboxState; reason: string }): Promise<void> {
		return this.#deps.record(sessionId, { kind: "tether.sandbox", data });
	}
}


import type { ExecResult } from "../env.ts";
import { TetherError } from "../errors.ts";
import { KeyedLock } from "../lock.ts";
import type { BindingPatch, SandboxBinding, SandboxState } from "../model.ts";
import type { SandboxNote } from "../notes.ts";
import type { AppStore, Clock, ExecChannel, SandboxProvider } from "../ports.ts";
import { nextState, type SandboxEvent } from "../sandbox-lifecycle.ts";
import type { Log } from "../startup.ts";

export type SandboxRecord = (sessionId: string, note: SandboxNote) => Promise<void>;

export interface SandboxServiceDeps {
	store: AppStore;
	provider: SandboxProvider;
	exec: ExecChannel;
	clock: Clock;
	/** 写一条条目进会话记录（设计文档 §4.4），由组装层接到引擎的 appendEntry。 */
	record: SandboxRecord;
	log: Log;
	/** 每条 setup 命令的上限。不设上限的话，一条不退出的命令（连不上的 git clone）会让会话一直等下去。 */
	setupTimeoutMs?: number;
}

export const WORKSPACE = "/workspace";
export const DEFAULT_SETUP_TIMEOUT_MS = 10 * 60 * 1000;
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

	constructor(deps: SandboxServiceDeps) {
		this.#deps = deps;
	}

	ensureSandbox(sessionId: string): Promise<SandboxBinding> {
		return this.#lock.run(sessionId, () => this.#ensure(sessionId));
	}

	status(sessionId: string): Promise<SandboxBinding | undefined> {
		return this.#deps.store.getBinding(sessionId);
	}

	async #ensure(sessionId: string): Promise<SandboxBinding> {
		const binding = await this.#deps.store.getBinding(sessionId);
		// 每次工具调用都走这里，运行中的直接用；容器在运行中丢失由执行通道的报错暴露（Task 5 做巡检）。
		if (binding?.state === "running") return binding;
		if (binding?.state === "stopped") return this.#start(binding);
		// 其余状态先按状态表检查能不能重建，再作废旧绑定（Task 6 换成正式重建并写说明）
		nextState(binding?.state, "create");
		if (binding) await this.#deps.store.deleteBinding(sessionId);
		return this.#create(sessionId);
	}

	async #start(binding: SandboxBinding): Promise<SandboxBinding> {
		const { provider } = this.#deps;
		if ((await provider.status(binding.sandboxId)) === "missing") {
			await this.#transition(binding, "vanish");
			await this.#note(binding.sessionId, { state: "lost", reason: "missing" });
			throw new TetherError("sandbox_failed", `sandbox ${binding.sandboxId} of session ${binding.sessionId} is gone`);
		}
		await provider.start(binding.sandboxId);
		const running = await this.#transition(binding, "start", { lastUsedAt: this.#deps.clock.now() });
		await this.#note(binding.sessionId, { state: "running", reason: "started" });
		return running;
	}

	async #create(sessionId: string): Promise<SandboxBinding> {
		const { store, provider, clock } = this.#deps;
		const session = await store.getSession(sessionId);
		if (!session) throw new TetherError("not_found", `session ${sessionId} not found`);
		const version = await store.getVersion(session.agentId, session.agentVersion);
		if (!version) {
			throw new TetherError("internal", `session ${sessionId} pins missing version ${session.agentVersion}`);
		}
		const spec = version.spec.sandbox;

		const { sandboxId } = await provider.create({ sessionId, spec });
		const at = clock.now();
		const creating: SandboxBinding = {
			sessionId,
			provider: provider.name,
			sandboxId,
			epoch: 0,
			state: "creating",
			template: spec.template,
			createdAt: at,
			lastUsedAt: at,
		};
		await store.createBinding(creating);

		try {
			await this.#runSetup(creating, spec.setup, session.variables);
		} catch (error) {
			await this.#cleanUpFailedSetup(creating);
			throw error;
		}

		const running = await this.#transition(creating, "setup_done");
		await this.#note(sessionId, { state: "running", reason: "created" });
		return running;
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
	 * 容器删掉了就删绑定（setup_failed）；没删掉就把绑定标成 lost（abandon），下次重建时再清。
	 */
	async #cleanUpFailedSetup(binding: SandboxBinding): Promise<void> {
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
			if (destroyed) {
				nextState(binding.state, "setup_failed");
				await store.deleteBinding(sessionId);
				await this.#note(sessionId, { state: "destroyed", reason: "setup failed" });
			} else {
				await this.#transition(binding, "abandon");
				await this.#note(sessionId, { state: "lost", reason: "cleanup failed" });
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


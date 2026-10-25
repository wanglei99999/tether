import type { ExecResult } from "../env.ts";
import { TetherError } from "../errors.ts";
import type { SandboxBinding } from "../model.ts";
import type { AppStore, Clock, ExecChannel, SandboxProvider } from "../ports.ts";

export type SandboxRecord = (sessionId: string, data: { state: SandboxBinding["state"]; reason?: string }) => Promise<void>;

export interface SandboxServiceDeps {
	store: AppStore;
	provider: SandboxProvider;
	exec: ExecChannel;
	clock: Clock;
	/** 写一条 tether.sandbox 条目进会话记录（设计文档 §4.4），由组装层接到引擎的 appendEntry。 */
	record: SandboxRecord;
	/** 每条 setup 命令的上限。不设上限的话，一条不退出的命令（连不上的 git clone）会让会话一直等下去。 */
	setupTimeoutMs?: number;
}

export const WORKSPACE = "/workspace";
export const DEFAULT_SETUP_TIMEOUT_MS = 10 * 60 * 1000;
/** M1 不做重连隔离，epoch 固定为 1（M2 实现 ADR-007）。 */
const EPOCH = 1;
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

/** 会话的沙箱：第一次需要时创建并执行 setup，之后复用；停止了就启动。 */
export class SandboxService {
	readonly #deps: SandboxServiceDeps;
	/** 单飞：同一个会话同时只有一次 ensure 在进行，并发调用拿到同一个结果。 */
	readonly #inflight = new Map<string, Promise<SandboxBinding>>();

	constructor(deps: SandboxServiceDeps) {
		this.#deps = deps;
	}

	ensureSandbox(sessionId: string): Promise<SandboxBinding> {
		const pending = this.#inflight.get(sessionId);
		if (pending) return pending;
		const started = this.#ensure(sessionId).finally(() => this.#inflight.delete(sessionId));
		this.#inflight.set(sessionId, started);
		return started;
	}

	status(sessionId: string): Promise<SandboxBinding | undefined> {
		return this.#deps.store.getBinding(sessionId);
	}

	async #ensure(sessionId: string): Promise<SandboxBinding> {
		const binding = await this.#deps.store.getBinding(sessionId);
		// 每次工具调用都走这里，运行中的直接用；容器在运行中丢失由执行通道的报错暴露（M2 做巡检）。
		if (binding?.state === "running") return binding;
		if (binding?.state === "stopped") return this.#start(binding);
		return this.#create(sessionId);
	}

	async #start(binding: SandboxBinding): Promise<SandboxBinding> {
		const { provider, store, record } = this.#deps;
		if ((await provider.status(binding.sandboxId)) === "missing") {
			await store.putBinding({ ...binding, state: "lost" });
			await record(binding.sessionId, { state: "lost", reason: "missing" });
			throw new TetherError("sandbox_failed", `sandbox ${binding.sandboxId} of session ${binding.sessionId} is gone`);
		}
		await provider.start(binding.sandboxId);
		const running: SandboxBinding = { ...binding, state: "running", lastUsedAt: this.#deps.clock.now() };
		await store.putBinding(running);
		await record(binding.sessionId, { state: "running", reason: "started" });
		return running;
	}

	async #create(sessionId: string): Promise<SandboxBinding> {
		const { store, provider, exec, clock, record } = this.#deps;
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
			epoch: EPOCH,
			state: "creating",
			template: spec.template,
			createdAt: at,
			lastUsedAt: at,
		};
		await store.putBinding(creating);

		const timeoutMs = this.#deps.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS;
		try {
			const env = exec.env(creating, { cwd: WORKSPACE });
			for (const command of spec.setup) {
				// 变量只经环境变量传入，命令原样执行（设计文档 §5.1）
				const result = await env.exec(command, { env: session.variables, timeoutMs }).catch((error: unknown) => {
					const reason = error instanceof Error ? error.message : String(error);
					throw new TetherError("sandbox_failed", `sandbox setup failed: \`${command}\`: ${reason}`, { command });
				});
				if (result.exitCode !== 0) throw setupFailure(command, result);
			}
		} catch (error) {
			exec.close(sandboxId);
			await provider.destroy(sandboxId);
			await store.deleteBinding(sessionId);
			await record(sessionId, { state: "destroyed", reason: "setup failed" });
			throw error;
		}

		const running: SandboxBinding = { ...creating, state: "running" };
		await store.putBinding(running);
		await record(sessionId, { state: "running", reason: "created" });
		return running;
	}
}

import {
	type AgentEngine,
	type Clock,
	type EngineAgentConfig,
	type ExecChannel,
	type ExecOptions,
	type ExecResult,
	type Ids,
	type SandboxBinding,
	type SandboxCreate,
	type SandboxProvider,
	TetherError,
	type TetherEnv,
} from "../src/index.ts";

export class FakeClock implements Clock {
	#tick = 0;
	now(): string {
		return new Date(Date.UTC(2026, 9, 25, 0, 0, this.#tick++)).toISOString();
	}
}

/** 时间不自己走，advance 往后拨。 */
export class ManualClock implements Clock {
	#at = Date.UTC(2026, 9, 25);
	now(): string {
		return new Date(this.#at).toISOString();
	}
	advance(ms: number): void {
		this.#at += ms;
	}
}

export class FakeIds implements Ids {
	#next = 1;
	next(prefix: "agt" | "ses"): string {
		return `${prefix}_${String(this.#next++).padStart(4, "0")}`;
	}
}

export class FakeEngine implements AgentEngine {
	readonly created: EngineAgentConfig[] = [];
	readonly submitted: { engineSessionId: string; content: string; requestId: string }[] = [];
	/** 在 createSession 里调用，测试用它检查调用那一刻的应用表。 */
	onCreate: (config: EngineAgentConfig) => Promise<void> = async () => {};
	failCreate = false;
	/** 正在运行的引擎会话，isRunning 按它回答。 */
	readonly running = new Set<string>();
	#sessions = 0;

	async isRunning(engineSessionId: string): Promise<boolean> {
		if (!(await this.hasSession(engineSessionId))) {
			throw new TetherError("not_found", `engine session ${engineSessionId} not found`);
		}
		return this.running.has(engineSessionId);
	}

	async createSession(config: EngineAgentConfig): Promise<string> {
		this.created.push(config);
		await this.onCreate(config);
		if (this.failCreate) throw new Error("engine is down");
		return `eng_${++this.#sessions}`;
	}
	async hasSession(engineSessionId: string): Promise<boolean> {
		return Number(engineSessionId.slice(4)) <= this.#sessions;
	}
	async submit(engineSessionId: string, input: { content: string; requestId: string }) {
		this.submitted.push({ engineSessionId, ...input });
		return { submissionId: `sub_${this.submitted.length}` };
	}
	async waitSubmission() {
		return { status: "done" as const };
	}
	readonly aborted: string[] = [];
	async abort(engineSessionId: string): Promise<void> {
		this.aborted.push(engineSessionId);
	}
	async transcript() {
		return { items: [] };
	}
	async appendEntry(): Promise<void> {}
	async subscribe() {
		return { stop: async () => {} };
	}
	resume(): void {}
	async close(): Promise<void> {}
}

type ContainerState = "running" | "stopped";

export class FakeProvider implements SandboxProvider {
	readonly name = "docker" as const;
	readonly capabilities = { snapshot: false, fork: false, rollback: false, preservesMemoryOnStop: false };
	readonly containers = new Map<string, { sessionId: string; state: ContainerState }>();
	readonly calls: string[] = [];
	/** create 完成前等待的毫秒数，用来让并发调用真正交错。 */
	createDelayMs = 0;
	/** 为 true 时 destroy 抛错，模拟清理失败。 */
	failDestroy = false;
	/** 为 true 时 fence 抛错，模拟隔离失败（例如容器共享宿主 PID 命名空间）。 */
	failFence = false;
	readonly fenced: { sandboxId: string; epoch: number }[] = [];
	#created = 0;

	async create({ sessionId }: SandboxCreate) {
		this.calls.push("create");
		await new Promise((resolve) => setTimeout(resolve, this.createDelayMs));
		const sandboxId = `sbx_${++this.#created}`;
		this.containers.set(sandboxId, { sessionId, state: "running" });
		return { sandboxId };
	}
	async status(sandboxId: string) {
		this.calls.push("status");
		return this.containers.get(sandboxId)?.state ?? "missing";
	}
	async start(sandboxId: string) {
		this.calls.push("start");
		const container = this.containers.get(sandboxId);
		if (!container) throw new TetherError("sandbox_failed", `no container ${sandboxId}`);
		container.state = "running";
	}
	async stop(sandboxId: string) {
		this.calls.push("stop");
		const container = this.containers.get(sandboxId);
		if (container) container.state = "stopped";
	}
	async destroy(sandboxId: string) {
		this.calls.push("destroy");
		if (this.failDestroy) throw new TetherError("sandbox_failed", `cannot remove ${sandboxId}`);
		this.containers.delete(sandboxId);
	}
	async fence(sandboxId: string, epoch: number) {
		this.calls.push("fence");
		if (this.failFence) throw new TetherError("sandbox_failed", `cannot fence ${sandboxId}`);
		this.fenced.push({ sandboxId, epoch });
		return { killed: 0 };
	}
	async listManaged() {
		return [...this.containers].map(([sandboxId, { sessionId, state }]) => ({ sandboxId, sessionId, status: state }));
	}
	daemonCommand(sandboxId: string, epoch: number): string[] {
		return ["fake-daemon", sandboxId, String(epoch)];
	}
}

/** SessionService 用到的 SandboxService.destroy；fail 为 true 时抛错。 */
export class FakeSandboxes {
	readonly destroyed: { sessionId: string; reason: string }[] = [];
	fail = false;
	/** 在 destroy 里调用，测试用它检查调用那一刻的状态。 */
	onDestroy: (sessionId: string) => Promise<void> = async () => {};

	async destroy(sessionId: string, reason: string): Promise<void> {
		await this.onDestroy(sessionId);
		if (this.fail) throw new TetherError("sandbox_failed", `cannot destroy the sandbox of ${sessionId}`);
		this.destroyed.push({ sessionId, reason });
	}
}

export interface ExecCall {
	sandboxId: string;
	cwd: string;
	command: string;
	env?: Record<string, string>;
	timeoutMs?: number;
}

/** exec 按命令返回脚本里的结果，没写的返回成功；failures 里的命令直接抛错（例如超时）；记录每次调用。 */
export class FakeExecChannel implements ExecChannel {
	readonly calls: ExecCall[] = [];
	readonly closed: string[] = [];
	results = new Map<string, ExecResult>();
	failures = new Map<string, Error>();

	env(binding: SandboxBinding, options: { cwd: string }): TetherEnv {
		const unused = async (): Promise<never> => {
			throw new Error("not used by these tests");
		};
		return {
			cwd: options.cwd,
			readText: unused,
			writeFile: unused,
			exists: unused,
			list: unused,
			exec: async (command: string, execOptions?: ExecOptions) => {
				this.calls.push({
					sandboxId: binding.sandboxId,
					cwd: options.cwd,
					command,
					...(execOptions?.env && { env: execOptions.env }),
					...(execOptions?.timeoutMs !== undefined && { timeoutMs: execOptions.timeoutMs }),
				});
				const failure = this.failures.get(command);
				if (failure) throw failure;
				return this.results.get(command) ?? { exitCode: 0, stdout: "", stderr: "" };
			},
		};
	}
	close(sandboxId: string): void {
		this.closed.push(sandboxId);
	}
}

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
	#sessions = 0;

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
	async abort(): Promise<void> {}
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
		this.containers.delete(sandboxId);
	}
	async listManaged() {
		return [...this.containers].map(([sandboxId, { sessionId }]) => ({ sandboxId, sessionId }));
	}
	daemonCommand(sandboxId: string, epoch: number): string[] {
		return ["fake-daemon", sandboxId, String(epoch)];
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

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
	next(prefix: "agt" | "ses" | "cp"): string {
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
	/** 条目 ID 和 pi 一样在整个引擎里递增；每次提交占一个（它的用户条目）。 */
	#entries = 0;
	readonly #submissionEntries = new Map<string, string>();
	async submit(engineSessionId: string, input: { content: string; requestId: string }) {
		this.submitted.push({ engineSessionId, ...input });
		const submissionId = `sub_${this.submitted.length}`;
		this.#submissionEntries.set(submissionId, String(++this.#entries));
		return { submissionId };
	}
	async submissionEntry(submissionId: string): Promise<string | undefined> {
		const entry = this.#submissionEntries.get(submissionId);
		if (entry === undefined) throw new TetherError("not_found", `submission ${submissionId} not found`);
		return entry;
	}
	readonly forks: { engineSessionId: string; entryId: string }[] = [];
	async fork(engineSessionId: string, entryId: string): Promise<string> {
		this.forks.push({ engineSessionId, entryId });
		return `eng_${++this.#sessions}`;
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
	/** 为 true 时 create 抛错，模拟 docker run 失败。 */
	failCreate = false;
	/** 为 true 时 fence 抛错，模拟隔离失败（例如容器共享宿主 PID 命名空间）。 */
	failFence = false;
	readonly fenced: { sandboxId: string; epoch: number }[] = [];
	#created = 0;

	async create({ sessionId }: SandboxCreate) {
		this.calls.push("create");
		await new Promise((resolve) => setTimeout(resolve, this.createDelayMs));
		if (this.failCreate) throw new TetherError("sandbox_failed", "docker run failed");
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

/** 按 POSIX 规则拼接并规范化路径：处理 "." 和 ".."，根目录之上还是根目录。 */
function normalize(cwd: string, path: string): string {
	const parts: string[] = [];
	for (const part of (path.startsWith("/") ? path : `${cwd}/${path}`).split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") parts.pop();
		else parts.push(part);
	}
	return `/${parts.join("/")}`;
}

const notFound = (path: string) => new TetherError("not_found", `${path} does not exist`);

/**
 * exec 按命令返回脚本里的结果，没写的返回成功；failures 里的命令直接抛错（例如超时）；记录每次调用。
 * 文件操作走一个假文件系统：files 是绝对路径到内容（"dir" 表示目录），realPaths 覆盖 realPath 的结果（模拟符号链接）。
 */
export class FakeExecChannel implements ExecChannel {
	readonly calls: ExecCall[] = [];
	readonly closed: string[] = [];
	results = new Map<string, ExecResult>();
	failures = new Map<string, Error>();
	readonly files = new Map<string, Uint8Array | "dir">([["/workspace", "dir"]]);
	readonly realPaths = new Map<string, string>();

	env(binding: SandboxBinding, options: { cwd: string }): TetherEnv {
		const unused = async (): Promise<never> => {
			throw new Error("not used by these tests");
		};
		const entry = (path: string) => {
			const content = this.files.get(path);
			if (content === undefined) throw notFound(path);
			const name = path.slice(path.lastIndexOf("/") + 1);
			return content === "dir"
				? { name, kind: "dir" as const, size: 0 }
				: { name, kind: "file" as const, size: content.byteLength };
		};
		return {
			cwd: options.cwd,
			readText: unused,
			writeFile: unused,
			exists: unused,
			list: async (path) => {
				const dir = normalize(options.cwd, path);
				return [...this.files.keys()]
					.filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/"))
					.sort()
					.map(entry);
			},
			readBytes: async (path) => {
				const content = this.files.get(normalize(options.cwd, path));
				if (content === undefined || content === "dir") throw notFound(path);
				return content;
			},
			info: async (path) => entry(normalize(options.cwd, path)),
			realPath: async (path) => {
				const absolute = normalize(options.cwd, path);
				const mapped = this.realPaths.get(absolute);
				if (mapped !== undefined) return mapped;
				if (!this.files.has(absolute)) throw notFound(path);
				return absolute;
			},
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

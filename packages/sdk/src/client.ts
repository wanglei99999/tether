import type {
	AgentRecord,
	AgentVersionRecord,
	AgentVersionSpec,
	ErrorCode,
	RunStatus,
	SandboxBinding,
	SessionRecord,
	SessionStatus,
	TranscriptEntry,
} from "@tether/core";
import { TetherApiError } from "./errors.ts";
import { type FollowOptions, SessionStream, type ViewListener } from "./stream.ts";

export interface TetherClientOptions {
	/** 例如 `http://127.0.0.1:7420`。 */
	baseUrl: string;
	token?: string;
	/** 测试或特殊运行时注入；默认用全局 fetch。 */
	fetch?: typeof fetch;
}

export type WhenBusy = "followUp" | "steer" | "reject";

export interface SendOptions {
	whenBusy?: WhenBusy;
	/** 同一个 requestId 只会被执行一次；不传时自动生成。 */
	requestId?: string;
}

export interface Page<T> {
	items: T[];
	next?: string;
}

/** 网络错误后的重试间隔：最多重试 2 次。 */
const SEND_RETRY_DELAYS_MS = [200, 400];

type Envelope<T> = { ok: true; data: T } | { ok: false; error: { code: ErrorCode; message: string } };

function query(params: Record<string, string | number | undefined>): string {
	const entries = Object.entries(params).filter((entry): entry is [string, string | number] => entry[1] !== undefined);
	return entries.length === 0 ? "" : `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class TetherClient {
	readonly #baseUrl: string;
	readonly #token: string | undefined;
	readonly #fetch: typeof fetch;

	constructor(options: TetherClientOptions) {
		this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.#token = options.token;
		this.#fetch = options.fetch ?? fetch;
	}

	readonly agents = {
		create: (input: { name: string; description?: string; spec: AgentVersionSpec }) =>
			this.#request<{ agent: AgentRecord; version: AgentVersionRecord }>("POST", "/v1/agents", input),
		list: async () => (await this.#request<{ items: AgentRecord[] }>("GET", "/v1/agents")).items,
		get: (id: string) =>
			this.#request<{ agent: AgentRecord; latestVersion: AgentVersionRecord }>("GET", `/v1/agents/${enc(id)}`),
		addVersion: async (id: string, spec: AgentVersionSpec) =>
			(await this.#request<{ version: AgentVersionRecord }>("POST", `/v1/agents/${enc(id)}/versions`, { spec }))
				.version,
		getVersion: async (id: string, version: number) =>
			(await this.#request<{ version: AgentVersionRecord }>("GET", `/v1/agents/${enc(id)}/versions/${version}`))
				.version,
		archive: async (id: string) =>
			(await this.#request<{ agent: AgentRecord }>("POST", `/v1/agents/${enc(id)}/archive`)).agent,
	};

	readonly sessions = {
		create: async (input: { agentId: string; agentVersion?: number; variables?: Record<string, string> }) =>
			(await this.#request<{ session: SessionRecord }>("POST", "/v1/sessions", input)).session,
		list: (filter: { agentId?: string; status?: SessionStatus; limit?: number; after?: string } = {}) =>
			this.#request<Page<SessionRecord>>("GET", `/v1/sessions${query(filter)}`),
		get: (id: string) =>
			this.#request<{ session: SessionRecord; sandbox?: SandboxBinding }>("GET", `/v1/sessions/${enc(id)}`),
		send: (id: string, content: string, options: SendOptions = {}) => this.#send(id, content, options),
		/** 等一次提交结束（已经结束的立即返回）。 */
		waitSubmission: (id: string, submissionId: string) =>
			this.#request<{ status: RunStatus; answer?: TranscriptEntry }>(
				"GET",
				`/v1/sessions/${enc(id)}/submissions/${enc(submissionId)}`,
			),
		abort: async (id: string): Promise<void> => {
			await this.#request<Record<string, never>>("POST", `/v1/sessions/${enc(id)}/abort`);
		},
		transcript: (id: string, page: { limit?: number; before?: string } = {}) =>
			this.#request<Page<TranscriptEntry>>("GET", `/v1/sessions/${enc(id)}/transcript${query(page)}`),
		sandbox: async (id: string) =>
			(await this.#request<{ binding: SandboxBinding | null }>("GET", `/v1/sessions/${enc(id)}/sandbox`)).binding,
	};

	/** 实时跟随一个会话：每个事件叠加到本地状态后回调一次，断线自动重连。 */
	follow(sessionId: string, onView: ViewListener, options?: FollowOptions): SessionStream {
		const url = new URL(`${this.#baseUrl}/v1/sessions/${enc(sessionId)}/events`);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		// WebSocket 不能统一设置请求头（浏览器不支持），token 走查询参数
		if (this.#token !== undefined) url.searchParams.set("token", this.#token);
		return new SessionStream(url.toString(), onView, options);
	}

	/** 网络错误时用同一个 requestId 重试：请求可能已经到了服务端，服务端按 requestId 去重。 */
	async #send(id: string, content: string, options: SendOptions): Promise<{ submissionId: string }> {
		const body = {
			content,
			requestId: options.requestId ?? crypto.randomUUID(),
			...(options.whenBusy !== undefined && { whenBusy: options.whenBusy }),
		};
		const path = `/v1/sessions/${enc(id)}/messages`;
		for (const delay of SEND_RETRY_DELAYS_MS) {
			try {
				return await this.#request<{ submissionId: string }>("POST", path, body);
			} catch (error) {
				if (!(error instanceof TetherApiError) || error.code !== "network") throw error;
				await sleep(delay);
			}
		}
		return this.#request<{ submissionId: string }>("POST", path, body);
	}

	async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const headers: Record<string, string> = {};
		if (this.#token !== undefined) headers.authorization = `Bearer ${this.#token}`;
		if (body !== undefined) headers["content-type"] = "application/json";

		let response: Response;
		try {
			response = await this.#fetch(`${this.#baseUrl}${path}`, {
				method,
				headers,
				...(body !== undefined && { body: JSON.stringify(body) }),
			});
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new TetherApiError("network", `${method} ${path} failed: ${reason}`);
		}

		let envelope: Envelope<T>;
		try {
			envelope = (await response.json()) as Envelope<T>;
		} catch {
			throw new TetherApiError("internal", `${method} ${path}: response is not JSON`, response.status);
		}
		if (!envelope.ok) throw new TetherApiError(envelope.error.code, envelope.error.message, response.status);
		return envelope.data;
	}
}

const enc = encodeURIComponent;

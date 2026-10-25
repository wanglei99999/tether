import { applyEvent, type SessionView, type TetherEvent } from "@tether/core";
import { TetherApiError } from "./errors.ts";

const FIRST_DELAY_MS = 250;
const MAX_DELAY_MS = 5_000;

/** 服务端用这些关闭码表示"重连也没用"。 */
const FATAL_CLOSE: Record<number, { code: "unauthorized" | "not_found"; status: number }> = {
	4401: { code: "unauthorized", status: 401 },
	4404: { code: "not_found", status: 404 },
};

export type ViewListener = (view: SessionView, event: TetherEvent) => void;

export interface FollowOptions {
	/** 会话不存在或 token 不对：流已经停止，不会再重连。 */
	onError?: (error: TetherApiError) => void;
}

export function emptyView(): SessionView {
	return { running: false, entries: [], tools: [], queued: 0 };
}

/**
 * 一个会话的事件流，断线自动重连。每次连上服务端都先发 snapshot，收到就整体替换本地状态，
 * 所以断线期间漏掉的事件不需要补（spec §7.3）。
 */
export class SessionStream {
	#view: SessionView = emptyView();
	#socket: WebSocket | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#delay = FIRST_DELAY_MS;
	#closed = false;
	readonly #url: string;
	readonly #listener: ViewListener;
	readonly #options: FollowOptions;

	constructor(url: string, listener: ViewListener, options: FollowOptions = {}) {
		this.#url = url;
		this.#listener = listener;
		this.#options = options;
		this.#connect();
	}

	get view(): SessionView {
		return this.#view;
	}

	close(): void {
		this.#closed = true;
		clearTimeout(this.#timer);
		this.#socket?.close();
	}

	#connect(): void {
		const socket = new WebSocket(this.#url);
		this.#socket = socket;
		let lost = false;
		// 连接被拒绝时 Node 的 WebSocket 只发 error、不一定发 close：两个都当作断开，各取第一次。
		// 只等 close 的话重连定时器不会安排，进程里没有别的事就直接退出了
		const onLost = (code: number | undefined) => {
			if (lost) return;
			lost = true;
			this.#onClose(code);
		};
		socket.addEventListener("message", (message) => this.#receive(String(message.data)));
		socket.addEventListener("close", (event) => onLost(event.code));
		socket.addEventListener("error", () => onLost(undefined));
	}

	#receive(data: string): void {
		const events = JSON.parse(data) as TetherEvent[];
		for (const event of events) {
			if (event.type === "snapshot") this.#delay = FIRST_DELAY_MS;
			this.#view = applyEvent(this.#view, event);
			this.#listener(this.#view, event);
		}
	}

	#onClose(code: number | undefined): void {
		this.#socket = undefined;
		if (this.#closed) return;
		const fatal = code === undefined ? undefined : FATAL_CLOSE[code];
		if (fatal) {
			this.#closed = true;
			this.#options.onError?.(new TetherApiError(fatal.code, `event stream closed: ${fatal.code}`, fatal.status));
			return;
		}
		this.#timer = setTimeout(() => this.#connect(), this.#delay);
		this.#delay = Math.min(this.#delay * 2, MAX_DELAY_MS);
	}
}

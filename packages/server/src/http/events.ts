import type { NodeWebSocket } from "@hono/node-ws";
import { type Log, type SessionService, TetherError } from "@tether/core";
import type { MiddlewareHandler } from "hono";
import { bearerToken, tokenMatcher } from "./auth.ts";

/** 应用自定义关闭码（4000–4999），按 HTTP 状态取后三位。其余失败用 1011（服务端内部错误）。 */
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_NOT_FOUND = 4404;
const CLOSE_INTERNAL = 1011;

export interface EventStreamDeps {
	sessions: SessionService;
	log: Log;
	token?: string;
}

function closeCodeFor(error: unknown): number {
	return error instanceof TetherError && error.code === "not_found" ? CLOSE_NOT_FOUND : CLOSE_INTERNAL;
}

/**
 * `WS /v1/sessions/:id/events`：每条消息是一批 `TetherEvent[]`，第一批只有一个 snapshot。
 * 浏览器的 WebSocket 不能设请求头，所以 token 也可以放在 `?token=` 里。
 */
export function eventStream(deps: EventStreamDeps, upgrade: NodeWebSocket["upgradeWebSocket"]): MiddlewareHandler {
	const matches = deps.token === undefined ? undefined : tokenMatcher(deps.token);

	return upgrade((c) => {
		const sessionId = c.req.param("id") ?? "";
		const presented = bearerToken(c.req.header("authorization")) ?? c.req.query("token");
		const authorized = matches === undefined || matches(presented);
		let subscription: Promise<{ stop(): Promise<void> }> | undefined;
		let open = true;

		return {
			onOpen(_event, ws) {
				if (!authorized) return ws.close(CLOSE_UNAUTHORIZED, "unauthorized");
				subscription = deps.sessions.subscribe(sessionId, (events) => {
					if (open) ws.send(JSON.stringify(events));
				});
				subscription.catch((error: unknown) => {
					const code = closeCodeFor(error);
					if (code === CLOSE_INTERNAL) deps.log.warn("event stream failed", error);
					// 关闭原因限 123 字节，只给错误码，细节进日志
					ws.close(code, code === CLOSE_NOT_FOUND ? "not_found" : "internal");
				});
			},
			onClose() {
				open = false;
				// 订阅可能还没建好；建好以后再停，建失败就什么都不用做
				subscription
					?.then(
						(active) => active.stop(),
						() => undefined,
					)
					.catch((error: unknown) => deps.log.warn("stopping an event stream failed", error));
			},
		};
	});
}

import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { fail } from "./envelope.ts";

/** 不需要 token 的路径：健康检查给负载均衡和探针用。 */
const PUBLIC_PATHS = new Set(["/v1/health"]);
/** 事件流自己检查 token：失败要在升级之后用关闭码 4401 告诉客户端，HTTP 401 到不了 WebSocket 客户端。 */
const EVENT_STREAM = /^\/v1\/sessions\/[^/]+\/events$/;

function digest(value: string): Buffer {
	return createHash("sha256").update(value).digest();
}

/** 比较前先取摘要，长度不同也走定长比较，不泄露 token 的长度和内容。 */
export function tokenMatcher(token: string): (presented: string | undefined) => boolean {
	const expected = digest(token);
	return (presented) => presented !== undefined && timingSafeEqual(digest(presented), expected);
}

export function bearerToken(header: string | undefined): string | undefined {
	return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}

/** 设置了 token 才挂。 */
export function bearerAuth(token: string): MiddlewareHandler {
	const matches = tokenMatcher(token);
	return async (c, next) => {
		if (PUBLIC_PATHS.has(c.req.path) || EVENT_STREAM.test(c.req.path)) return next();
		if (!matches(bearerToken(c.req.header("authorization")))) {
			return fail(c, "unauthorized", "missing or invalid bearer token");
		}
		return next();
	};
}

import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { fail } from "./envelope.ts";

/** 不需要 token 的路径：健康检查给负载均衡和探针用。 */
const PUBLIC_PATHS = new Set(["/v1/health"]);

function digest(value: string): Buffer {
	return createHash("sha256").update(value).digest();
}

/** 设置了 token 才挂。比较前先取摘要，长度不同也走定长比较，不泄露 token 长度。 */
export function bearerAuth(token: string): MiddlewareHandler {
	const expected = digest(token);
	return async (c, next) => {
		if (PUBLIC_PATHS.has(c.req.path)) return next();
		const header = c.req.header("authorization") ?? "";
		const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
		if (presented === undefined || !timingSafeEqual(digest(presented), expected)) {
			return fail(c, "unauthorized", "missing or invalid bearer token");
		}
		return next();
	};
}

import { type ErrorCode, type Log, TetherError } from "@tether/core";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** 错误码是对外契约（spec §7.1），HTTP 状态跟着错误码走。 */
const STATUS: Record<ErrorCode, ContentfulStatusCode> = {
	invalid_request: 400,
	unauthorized: 401,
	not_found: 404,
	conflict: 409,
	busy: 409,
	sandbox_failed: 502,
	sandbox_limit: 503,
	engine_failed: 502,
	internal: 500,
};

export function ok(c: Context, data: unknown, status: ContentfulStatusCode = 200): Response {
	return c.json({ ok: true, data }, status);
}

export function fail(c: Context, code: ErrorCode, message: string): Response {
	return c.json({ ok: false, error: { code, message } }, STATUS[code]);
}

/** TetherError 原样给出；其余异常可能带路径、SQL 之类的内部细节，只记日志，对外给固定文本。 */
export function failFromError(c: Context, error: unknown, log: Log): Response {
	if (error instanceof TetherError) return fail(c, error.code, error.message);
	log.warn("unhandled error in HTTP handler", error);
	return fail(c, "internal", "internal error");
}

/** 对外契约：客户端按错误码判断，错误消息只给人看，随时可能调整。 */
export type ErrorCode =
	| "invalid_request"
	| "unauthorized"
	| "not_found"
	| "conflict"
	| "busy"
	| "sandbox_failed"
	/** 同时运行的沙箱已达上限，稍后重试（spec §4.6）。 */
	| "sandbox_limit"
	| "engine_failed"
	| "internal";

export class TetherError extends Error {
	readonly code: ErrorCode;
	readonly detail?: unknown;

	constructor(code: ErrorCode, message: string, detail?: unknown) {
		super(message);
		this.name = "TetherError";
		this.code = code;
		this.detail = detail;
	}
}

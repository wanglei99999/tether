import type { ErrorCode } from "@tether/core";

/** 服务端的错误码原样带出；请求根本没到服务端（连不上、响应丢了）时是 "network"。 */
export class TetherApiError extends Error {
	readonly code: ErrorCode | "network";
	readonly status?: number;

	constructor(code: ErrorCode | "network", message: string, status?: number) {
		super(message);
		this.name = "TetherApiError";
		this.code = code;
		if (status !== undefined) this.status = status;
	}
}

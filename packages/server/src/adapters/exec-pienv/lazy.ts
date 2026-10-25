import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

export interface LazyEnvOptions {
	/** 同一个沙箱要稳定：pi 用它给同一文件的修改排队。 */
	id: string;
	cwd: string;
	/** 第一次真正用到环境时才调用，例如创建沙箱；失败时下一次调用重试。 */
	resolve: () => Promise<ExecutionEnv>;
}

/**
 * pi 在每一轮准备阶段都会构建环境（用来渲染系统提示的 sections），即使这一轮不调用工具。
 * 直接在那时创建沙箱，纯聊天的会话也会占一个容器（违反 spec §4 的懒创建）。
 * 这里返回一个代理：`id`、`cwd` 直接给，其余方法第一次被调用时才 resolve 真正的环境。
 */
export function lazyEnv(options: LazyEnvOptions): ExecutionEnv {
	let real: Promise<ExecutionEnv> | undefined;
	const resolved = (): Promise<ExecutionEnv> => {
		real ??= options.resolve().catch((error: unknown) => {
			real = undefined;
			throw error;
		});
		return real;
	};

	const target = { id: options.id, cwd: options.cwd };
	return new Proxy(target, {
		get(own, property) {
			if (property === "id" || property === "cwd") return own[property];
			// 不是 thenable：pi 和 async 函数会 await 环境，有 then 的话会被当成 Promise 展开
			if (property === "then" || typeof property === "symbol") return undefined;
			if (property === "cleanup") {
				// 还没建过沙箱就没有要清理的
				return async (...args: unknown[]) => {
					const env = await real?.catch(() => undefined);
					if (env !== undefined) await call(env, property, args);
				};
			}
			return async (...args: unknown[]) => call(await resolved(), property, args);
		},
	}) as unknown as ExecutionEnv;
}

function call(env: ExecutionEnv, method: string, args: unknown[]): unknown {
	const fn = (env as unknown as Record<string, unknown>)[method];
	if (typeof fn !== "function") throw new TypeError(`execution environment has no method ${method}`);
	return fn.apply(env, args);
}

import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

export interface LazyEnvOptions {
	/** 同一个沙箱要稳定：pi 用它给同一文件的修改排队。 */
	id: string;
	cwd: string;
	/** 第一次真正用到环境时才调用，例如创建沙箱；失败时下一次调用重试。 */
	resolve: () => Promise<ExecutionEnv>;
}

/**
 * pi-durable `ExecutionEnv`（FileSystem 与 Shell）的方法名，除 cleanup 以外。名单之外的属性代理返回 undefined，
 * pi 按"有没有这个方法"判断的可选能力才不会被骗。listFiles 是可选方法，真正的环境 RemoteExecutionEnv 实现了它，
 * 放进名单让 pi 走 daemon 列文件，而不是退回逐个目录遍历。名单与 ExecutionEnv 不一致时类型检查报错（见下方 listsEveryMethod）。
 */
const METHOD_NAMES = [
	"absolutePath",
	"joinPath",
	"readTextFile",
	"openTextLineReader",
	"readTextLines",
	"readBinaryFile",
	"openBinaryReader",
	"writeFile",
	"appendFile",
	"truncateFile",
	"flushFile",
	"renameFile",
	"fileInfo",
	"listDir",
	"listFiles",
	"openDirReader",
	"watch",
	"canonicalPath",
	"exists",
	"createDir",
	"remove",
	"createTempDir",
	"createTempFile",
	"exec",
] as const satisfies readonly (keyof ExecutionEnv)[];

// pi 升级给 ExecutionEnv 加了方法而名单没跟上时，这里不再是 true，类型检查失败
type Unlisted = Exclude<keyof ExecutionEnv, (typeof METHOD_NAMES)[number] | "id" | "cwd" | "cleanup">;
const listsEveryMethod: [Unlisted] extends [never] ? true : Unlisted = true;
void listsEveryMethod;

const METHODS: ReadonlySet<string> = new Set(METHOD_NAMES);

/**
 * pi 在每一轮准备阶段都会构建环境（用来渲染系统提示的 sections），即使这一轮不调用工具。
 * 直接在那时创建沙箱，纯聊天的会话也会占一个容器（违反 spec §4 的懒创建）。
 * 这里返回一个代理：`id`、`cwd` 直接给，名单里的方法第一次被调用时才 resolve 真正的环境。
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
			// 名单外的一律 undefined，其中包括 then：pi 和 async 函数会 await 环境，有 then 的话会被当成 Promise 展开
			if (typeof property === "symbol") return undefined;
			if (property === "cleanup") {
				// 还没建过沙箱就没有要清理的
				return async (...args: unknown[]) => {
					const env = await real?.catch(() => undefined);
					if (env !== undefined) await call(env, property, args);
				};
			}
			if (!METHODS.has(property)) return undefined;
			return async (...args: unknown[]) => call(await resolved(), property, args);
		},
	}) as unknown as ExecutionEnv;
}

function call(env: ExecutionEnv, method: string, args: unknown[]): unknown {
	const fn = (env as unknown as Record<string, unknown>)[method];
	if (typeof fn !== "function") throw new TypeError(`execution environment has no method ${method}`);
	return fn.apply(env, args);
}

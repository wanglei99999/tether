import type { Log } from "./startup.ts";

export interface Sweeper {
	/** 不再开始新的巡检，并等进行中的那次结束。 */
	stop(): Promise<void>;
}

/**
 * 每 intervalMs 调用一次 sweep。上一次还没结束就跳过这一拍，两次巡检不会重叠；
 * 失败只记日志，下一拍照常进行。
 */
export function startSweeper(sweep: () => Promise<unknown>, intervalMs: number, log: Log): Sweeper {
	let running: Promise<void> | undefined;
	const tick = () => {
		if (running) return;
		running = sweep()
			.then(
				() => {},
				(error: unknown) => log.warn("sandbox sweep failed", error),
			)
			.finally(() => {
				running = undefined;
			});
	};
	const timer = setInterval(tick, intervalMs);
	return {
		async stop() {
			clearInterval(timer);
			await running;
		},
	};
}

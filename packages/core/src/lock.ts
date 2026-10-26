/**
 * 每个键一把的异步锁：同一个键的 work 按调用顺序一个个执行，不同键互不等待。
 * 某个 work 抛错只影响它自己的调用方，排在后面的照常执行。
 */
export class KeyedLock {
	/** 每个键最后一个排队的 work 结束的时刻；只 resolve，不 reject。 */
	readonly #tails = new Map<string, Promise<void>>();

	run<T>(key: string, work: () => Promise<T>): Promise<T> {
		const previous = this.#tails.get(key) ?? Promise.resolve();
		const result = previous.then(work);
		const tail = result.then(
			() => {},
			() => {},
		);
		this.#tails.set(key, tail);
		// 队列空了就删掉，键不会越积越多
		void tail.then(() => {
			if (this.#tails.get(key) === tail) this.#tails.delete(key);
		});
		return result;
	}
}

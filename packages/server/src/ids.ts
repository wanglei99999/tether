import { randomBytes } from "node:crypto";
import type { Clock, Ids } from "@tether/core";

export const systemClock: Clock = { now: () => new Date().toISOString() };

/**
 * 形如 ses_<12 位时间><4 位序号><8 位随机>，全部小写十六进制。按字符串排序就是按创建顺序，
 * 同一毫秒内靠序号保持单调；会话列表的分页依赖这一点。
 */
export function createIds(): Ids {
	let lastMs = 0;
	let sequence = 0;
	return {
		next(prefix) {
			const now = Date.now();
			if (now > lastMs) {
				lastMs = now;
				sequence = 0;
			} else {
				sequence++;
			}
			const time = lastMs.toString(16).padStart(12, "0");
			const seq = sequence.toString(16).padStart(4, "0");
			return `${prefix}_${time}${seq}${randomBytes(4).toString("hex")}`;
		},
	};
}

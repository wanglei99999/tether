import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["spikes/**/*.test.ts"],
		testTimeout: 120_000,
		// 实验之间共享同一个 Docker，顺序执行避免互相干扰
		fileParallelism: false,
	},
});

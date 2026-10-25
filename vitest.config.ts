import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				extends: true,
				test: {
					name: "unit",
					include: ["packages/*/test/**/*.test.ts"],
					exclude: ["packages/*/test/**/*.docker.test.ts"],
					testTimeout: 30_000,
				},
			},
			{
				extends: true,
				test: {
					name: "docker",
					include: ["packages/*/test/**/*.docker.test.ts"],
					testTimeout: 120_000,
					// 首次构建沙箱镜像要拉基础镜像、装包
					hookTimeout: 600_000,
					// 所有用例共用测试机上的同一个 Docker，顺序执行避免互相干扰
					fileParallelism: false,
				},
			},
		],
	},
});

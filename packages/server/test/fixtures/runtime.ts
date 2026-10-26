/**
 * Docker 测试用的容器运行时：与生产配置同一个环境变量 TETHER_SANDBOX_RUNTIME，
 * 这样子进程里跑的 Tether（run-tether.ts）也自动用上。不设则用 Docker 默认的 runc。
 * 例：TETHER_SANDBOX_RUNTIME=runsc npm run test:docker
 */
export const TEST_RUNTIME = process.env.TETHER_SANDBOX_RUNTIME || undefined;

/** 传给 createDockerSandboxProvider 的 runtime 选项。 */
export const runtimeOption = (): { runtime?: string } => (TEST_RUNTIME ? { runtime: TEST_RUNTIME } : {});

/** 传给 loadConfig 的同名设置。 */
export const runtimeEnv = (): Record<string, string> => (TEST_RUNTIME ? { TETHER_SANDBOX_RUNTIME: TEST_RUNTIME } : {});

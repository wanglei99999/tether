// node:sqlite 在 Node 22 上每次加载都打一条 ExperimentalWarning。只过滤这一条，其他警告照常输出；
// 必须在加载存储模块之前装上，所以下面的模块都用动态 import。
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
	const message = typeof warning === "string" ? warning : warning.message;
	if (/SQLite is an experimental feature/.test(message)) return;
	(emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const { serve } = await import("@hono/node-server");
const { createTether } = await import("./app.ts");
const { loadConfig } = await import("./config.ts");

const config = loadConfig(process.env);

// 部署时先跑一次：构建沙箱镜像（TETHER_SANDBOX_IMAGE），然后退出
if (process.argv.includes("--build-sandbox")) {
	const { buildSandboxImage } = await import("./adapters/sandbox-docker/index.ts");
	await buildSandboxImage(config.sandboxImage);
	process.stderr.write(`built sandbox image ${config.sandboxImage}\n`);
	process.exit(0);
}

const tether = await createTether(config);
const server = serve({ fetch: tether.app.fetch, hostname: config.host, port: config.port }, (info) => {
	process.stderr.write(`tether listening on http://${info.address}:${info.port}\n`);
});
tether.injectWebSocket(server);

let closing = false;
async function shutdown(): Promise<void> {
	if (closing) return;
	closing = true;
	server.close();
	await tether.close();
	process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

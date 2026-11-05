// 混沌测试的服务端：和 run-tether.ts 只差模型。配置读 TETHER_*，说明记进 TETHER_CHAOS_NOTES。
// 监听端口后打印 `listening <port>`，一直运行到被杀。
import { serve } from "@hono/node-server";
import { createTether } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import { chaosModels } from "./chaos-model.ts";

const config = loadConfig(process.env);
const tether = await createTether(config, { models: chaosModels(process.env.TETHER_CHAOS_NOTES) });

const server = serve({ fetch: tether.app.fetch, hostname: config.host, port: config.port }, (info) => {
	process.stdout.write(`listening ${info.port}\n`);
});
tether.injectWebSocket(server);

// 在子进程里跑一个 Tether：配置读 TETHER_*，模型是按 TETHER_FAUX_SCRIPT（ScriptStep[] 的 JSON）回答的 faux。
// 设置了 TETHER_FIXTURE_SEND（{ sessionId, content, requestId } 的 JSON）时，启动后先发这条消息，
// 在标准输出打印 `submitted <submissionId>`。然后监听端口，打印 `listening <port>`，一直运行到被杀。
// 崩溃恢复测试（app.docker.test.ts）和 CLI 测试（Task 14）用它。
// 用法：node packages/server/test/fixtures/run-tether.ts
import { serve } from "@hono/node-server";
import type { ScriptStep } from "@tether/testkit";
import { createTether } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import { fauxModels } from "./faux.ts";

const script = JSON.parse(process.env.TETHER_FAUX_SCRIPT ?? "[]") as ScriptStep[];
const config = loadConfig(process.env);
const tether = await createTether(config, { models: fauxModels(script) });

if (process.env.TETHER_FIXTURE_SEND) {
	const { sessionId, content, requestId } = JSON.parse(process.env.TETHER_FIXTURE_SEND) as {
		sessionId: string;
		content: string;
		requestId: string;
	};
	const { submissionId } = await tether.services.sessions.sendMessage(sessionId, { content, requestId });
	process.stdout.write(`submitted ${submissionId}\n`);
}

serve({ fetch: tether.app.fetch, hostname: config.host, port: config.port }, (info) => {
	process.stdout.write(`listening ${info.port}\n`);
});

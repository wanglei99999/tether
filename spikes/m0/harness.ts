import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type FauxProviderHandle,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { daemonCommand } from "./docker.ts";

export const context = BACKGROUND_CONTEXT;
export const MODEL = { provider: "faux", modelId: "faux-1" } as const;
/** 崩溃实验里被打断的命令：runs.txt 记录它开始了几次，log.txt 记录它有没有跑完。 */
export const CRASH_COMMAND = "echo started >> /workspace/runs.txt; sleep 5; echo x >> /workspace/log.txt";

type Root = Awaited<ReturnType<Harness["root"]>>;

export interface SpikeHarness {
	root: Root;
	faux: FauxProviderHandle;
	close(): Promise<void>;
}

/** 假模型的一次工具调用回合。 */
export function toolCall(name: string, args: Parameters<typeof fauxToolCall>[1], id: string): FauxResponseStep {
	return fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
}

/**
 * 在 SQLite 上打开一个 Harness：模型是按剧本回答的 faux，工具是 CodingTools，
 * 所有工具调用都经 pi-env daemon 落到容器的 /workspace。
 */
export async function openSpikeHarness(
	database: string,
	container: string,
	responses: FauxResponseStep[],
): Promise<SpikeHarness> {
	const faux = fauxProvider();
	faux.setResponses(responses);
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(CodingTools);

	const connection = new Connection({ command: daemonCommand(container, 1) });
	const harness = await Harness.open(
		await openNodeSqliteStorage(database),
		{
			models,
			registry,
			env: () => new RemoteExecutionEnv({ connection, id: `docker:${container}`, cwd: "/workspace" }),
		},
		context,
	);
	const root = await harness.root(context, { agent: { model: MODEL, cwd: "/workspace" } });
	return {
		root,
		faux,
		close: async () => {
			await harness.close(context);
			connection.close();
		},
	};
}

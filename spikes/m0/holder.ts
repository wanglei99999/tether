// 持有连接的子进程：以给定 epoch 连上容器，执行一条长命令，然后一直等，直到父进程 SIGKILL / SIGSTOP 它。
// 用法：node spikes/m0/holder.ts <容器名> <epoch>
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { daemonCommand } from "./docker.ts";
import { context } from "./harness.ts";

const [container, epochText] = process.argv.slice(2);
const epoch = Number(epochText);
if (!container || !Number.isInteger(epoch)) {
	throw new Error("usage: holder.ts <container> <epoch>");
}

const connection = new Connection({ command: daemonCommand(container, epoch) });
const env = new RemoteExecutionEnv({ connection, id: `docker:${container}`, cwd: "/workspace" });
await env.exec("touch /workspace/holder.started; sleep 300; echo late > /workspace/late.txt", undefined, context);

// 崩溃实验的子进程：提交一轮会调用长时间 bash 的对话，然后一直等，直到被父进程 SIGKILL。
// 用法：node spikes/m0/crash-child.ts <sqlite 路径> <容器名>
import { CRASH_COMMAND, context, openSpikeHarness, toolCall } from "./harness.ts";

const [database, container] = process.argv.slice(2);
if (!database || !container) {
	throw new Error("usage: crash-child.ts <database> <container>");
}

const spike = await openSpikeHarness(database, container, [toolCall("bash", { command: CRASH_COMMAND }, "s")]);
const submission = await spike.root.submit({ type: "input", content: "run it", requestId: "crash-1" }, context);
await submission.wait(context);

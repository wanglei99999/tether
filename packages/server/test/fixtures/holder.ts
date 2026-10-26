// 持有旧连接的子进程：用给定的 daemon 命令连上容器，执行一条长命令后一直等，直到父进程 SIGSTOP / SIGKILL 它。
// 用法：node holder.ts '<daemon 命令的 JSON 数组>' '<要执行的命令>'
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";

const [commandJson, script] = process.argv.slice(2);
if (commandJson === undefined || script === undefined) throw new Error("usage: holder.ts <command json> <script>");

const connection = new Connection({ command: JSON.parse(commandJson) as string[] });
const env = new RemoteExecutionEnv({ connection, id: "holder", cwd: "/workspace" });
await env.exec(script, undefined, BACKGROUND_CONTEXT);

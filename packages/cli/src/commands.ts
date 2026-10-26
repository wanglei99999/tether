import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { RunStatus, TetherEvent } from "@tether/core";
import { TetherApiError, TetherClient } from "@tether/sdk";

export const DEFAULT_URL = "http://127.0.0.1:7420";

export const USAGE = `usage:
  tether agent create --file <agent.json>
  tether agent list
  tether session create <agentId> [--version N] [--var KEY=VALUE]...
  tether session archive <sessionId>
  tether send <sessionId> <text> [--follow]
  tether sandbox <sessionId>

options:
  --json   print the API's data as JSON

environment:
  TETHER_URL    server address (default ${DEFAULT_URL})
  TETHER_TOKEN  bearer token, if the server sets one`;

export interface Io {
	out(text: string): void;
	err(text: string): void;
	env: Record<string, string | undefined>;
}

/** 用法错误：退出码 2，与 API 错误（退出码 1）区分开。 */
class UsageError extends Error {}

interface Parsed {
	positionals: string[];
	json: boolean;
	follow: boolean;
	file: string | undefined;
	version: string | undefined;
	vars: string[];
}

function parse(argv: string[]): Parsed {
	try {
		const { positionals, values } = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				json: { type: "boolean", default: false },
				follow: { type: "boolean", default: false },
				file: { type: "string" },
				version: { type: "string" },
				var: { type: "string", multiple: true, default: [] },
			},
		});
		return {
			positionals,
			json: values.json ?? false,
			follow: values.follow ?? false,
			file: values.file,
			version: values.version,
			vars: values.var ?? [],
		};
	} catch (error) {
		throw new UsageError(error instanceof Error ? error.message : String(error));
	}
}

function variables(pairs: string[]): Record<string, string> {
	const result: Record<string, string> = {};
	for (const pair of pairs) {
		const split = pair.indexOf("=");
		if (split <= 0) throw new UsageError(`--var expects KEY=VALUE, got ${pair}`);
		result[pair.slice(0, split)] = pair.slice(split + 1);
	}
	return result;
}

function version(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1) throw new UsageError(`--version expects a positive integer, got ${raw}`);
	return value;
}

function need(value: string | undefined, what: string): string {
	if (value === undefined || value === "") throw new UsageError(`missing ${what}`);
	return value;
}

/** 解析参数、执行一条命令，返回退出码。io 由调用方给，测试可以不开子进程。 */
export async function run(argv: string[], io: Io): Promise<number> {
	try {
		const args = parse(argv);
		const client = new TetherClient({
			baseUrl: io.env.TETHER_URL || DEFAULT_URL,
			...(io.env.TETHER_TOKEN ? { token: io.env.TETHER_TOKEN } : {}),
		});
		return await dispatch(client, args, io);
	} catch (error) {
		if (error instanceof UsageError) {
			io.err(`${error.message}\n\n${USAGE}\n`);
			return 2;
		}
		if (error instanceof TetherApiError) {
			io.err(`error: ${error.code}: ${error.message}\n`);
			return 1;
		}
		throw error;
	}
}

async function dispatch(client: TetherClient, args: Parsed, io: Io): Promise<number> {
	const [group, action, ...rest] = args.positionals;
	const print = (data: unknown, text: string) => io.out(args.json ? `${JSON.stringify(data, null, 2)}\n` : `${text}\n`);

	if (group === "agent" && action === "create") {
		const file = need(args.file, "--file");
		const input = JSON.parse(await readFile(file, "utf8")) as Parameters<TetherClient["agents"]["create"]>[0];
		const data = await client.agents.create(input);
		print(data, `${data.agent.id} version ${data.version.version}`);
		return 0;
	}
	if (group === "agent" && action === "list") {
		const items = await client.agents.list();
		const lines = items.map((a) => `${a.id}  ${a.name}${a.archivedAt ? "  (archived)" : ""}`);
		print({ items }, lines.join("\n") || "no agents");
		return 0;
	}
	if (group === "session" && action === "create") {
		const agentId = need(rest[0], "<agentId>");
		const agentVersion = version(args.version);
		const session = await client.sessions.create({
			agentId,
			variables: variables(args.vars),
			...(agentVersion !== undefined && { agentVersion }),
		});
		print({ session }, `${session.id} (agent ${session.agentId} version ${session.agentVersion})`);
		return 0;
	}
	if (group === "session" && action === "archive") {
		const session = await client.sessions.archive(need(rest[0], "<sessionId>"));
		print({ session }, `${session.id} archived`);
		return 0;
	}
	if (group === "send") {
		const sessionId = need(action, "<sessionId>");
		const text = need(rest[0], "<text>");
		if (args.follow) return follow(client, sessionId, text, args.json, io);
		const data = await client.sessions.send(sessionId, text);
		print(data, `submitted ${data.submissionId}`);
		return 0;
	}
	if (group === "sandbox") {
		const binding = await client.sessions.sandbox(need(action, "<sessionId>"));
		print({ binding }, binding ? `${binding.state}  ${binding.sandboxId}` : "no sandbox yet");
		return 0;
	}
	throw new UsageError(group === undefined ? "missing command" : `unknown command: ${args.positionals.join(" ")}`);
}

/** 人读格式：模型文字原样输出，工具开始和结束各占一行。 */
function render(event: TetherEvent): string {
	switch (event.type) {
		case "message_delta":
			return event.text;
		case "message_end":
			return "\n";
		case "tool_start":
			return `\n[${event.name}] ${JSON.stringify(event.args)}\n`;
		case "tool_end": {
			const result = event.entry.toolResult;
			const mark = result?.isError ? "failed" : "done";
			return `[${mark}] ${result?.text ?? ""}\n`;
		}
		case "run_end":
			return event.status === "done" ? "" : `[run ${event.status}]\n`;
		default:
			return "";
	}
}

/**
 * 先订阅再发消息，保证不漏掉这次运行的事件；收到这次提交的 run_end 后退出。
 * done 退出码 0；unanswered 和 aborted 退出码 1。
 *
 * 事件流断线期间结束的运行，重连后只能看到一个新快照，不会再有 run_end（spec §7.3）。
 * 所以重连之后向服务端确认一次这次提交的结果：已经结束的立即返回，没结束的等它结束。
 */
async function follow(client: TetherClient, sessionId: string, text: string, json: boolean, io: Io): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const ended = new Map<string, RunStatus>();
		let submissionId: string | undefined;
		let snapshots = 0;
		let finished = false;

		const finish = (status: RunStatus) => {
			if (finished) return;
			finished = true;
			stream.close();
			resolve(status === "done" ? 0 : 1);
		};
		const fail = (error: unknown) => {
			if (finished) return;
			finished = true;
			stream.close();
			reject(error);
		};
		const confirm = (id: string) => {
			client.sessions.waitSubmission(sessionId, id).then(
				(settled) => finish(settled.status),
				// 又断了：下一次重连再确认
				(error: unknown) => (error instanceof TetherApiError && error.code === "network" ? undefined : fail(error)),
			);
		};
		const send = () => {
			client.sessions.send(sessionId, text).then((sent) => {
				submissionId = sent.submissionId;
				const status = ended.get(sent.submissionId);
				if (status) finish(status);
				else if (snapshots > 1) confirm(sent.submissionId);
			}, fail);
		};

		const stream = client.follow(
			sessionId,
			(_view, event) => {
				if (event.type === "snapshot") {
					snapshots += 1;
					if (snapshots === 1) send();
					else if (submissionId !== undefined) confirm(submissionId);
					return;
				}
				io.out(json ? `${JSON.stringify(event)}\n` : render(event));
				if (event.type !== "run_end") return;
				ended.set(event.submissionId, event.status);
				if (event.submissionId === submissionId) finish(event.status);
			},
			{ onError: fail },
		);
	});
}

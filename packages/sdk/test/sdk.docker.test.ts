import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { SessionView, TetherEvent } from "@tether/core";
import { type ScriptStep, sampleSpec } from "@tether/testkit";
import { afterEach, describe, expect, it } from "vitest";
// SDK 不依赖服务端；测试借用服务端的组装和 faux 模型，起一个真实的 Tether
import { createTether } from "../../server/src/app.ts";
import { loadConfig } from "../../server/src/config.ts";
import { FAUX_MODEL, fauxModels } from "../../server/test/fixtures/faux.ts";
import { TetherApiError, TetherClient } from "../src/index.ts";

const TOKEN = "sdk-secret";
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Running {
	url: string;
	port: number;
	stop(): Promise<void>;
}

/** createTether + 监听；port 为 0 时随机分配。同一个 dataDir 可以停了再起。 */
async function start(dataDir: string, script: ScriptStep[], port = 0): Promise<Running> {
	const config = loadConfig({ TETHER_DATA_DIR: dataDir, TETHER_PORT: String(port), TETHER_TOKEN: TOKEN });
	const tether = await createTether(config, { models: fauxModels(script) });
	const { server, info } = await new Promise<{ server: ReturnType<typeof serve>; info: AddressInfo }>((resolve) => {
		const server = serve({ fetch: tether.app.fetch, hostname: "127.0.0.1", port }, (info) => resolve({ server, info }));
	});
	tether.injectWebSocket(server);
	let stopped = false;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		const closed = new Promise<void>((done) => server.close(() => done()));
		if ("closeAllConnections" in server) server.closeAllConnections();
		// tether.close() 先关掉事件流的 WebSocket，server.close() 才等得到所有连接断开
		await tether.close();
		await closed;
	};
	cleanups.push(stop);
	return { url: `http://127.0.0.1:${info.port}`, port: info.port, stop };
}

function newDataDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "tether-sdk-"));
	cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function client(url: string, fetchImpl?: typeof fetch): TetherClient {
	return new TetherClient({ baseUrl: url, token: TOKEN, ...(fetchImpl && { fetch: fetchImpl }) });
}

const spec = (tools: string[] = []) => ({ ...sampleSpec(), model: FAUX_MODEL, tools });

/** 跟随一个会话，记下每次回调；until 等到某个事件出现。 */
function follow(api: TetherClient, sessionId: string) {
	const seen: { view: SessionView; event: TetherEvent }[] = [];
	const waiters = new Set<() => void>();
	const stream = api.follow(sessionId, (view, event) => {
		seen.push({ view, event });
		for (const check of waiters) check();
	});
	cleanups.push(async () => stream.close());
	const until = (match: (event: TetherEvent, index: number) => boolean, timeoutMs = 15_000) =>
		new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				waiters.delete(check);
				reject(new Error(`event not seen; got ${seen.map((s) => s.event.type).join(", ")}`));
			}, timeoutMs);
			function check() {
				if (!seen.some((s, i) => match(s.event, i))) return;
				clearTimeout(timer);
				waiters.delete(check);
				resolve();
			}
			waiters.add(check);
			check();
		});
	return { stream, seen, until };
}

async function fullTranscript(api: TetherClient, sessionId: string) {
	return [...(await api.sessions.transcript(sessionId, { limit: 100 })).items].reverse();
}

describe("TetherClient", () => {
	it("covers agents and sessions end to end against a real server", async () => {
		const server = await start(newDataDir(), [{ text: "hello" }]);
		const api = client(server.url);

		const { agent, version } = await api.agents.create({ name: "sdk", spec: spec() });
		expect(version.version).toBe(1);
		expect((await api.agents.addVersion(agent.id, spec(["read"]))).version).toBe(2);
		expect((await api.agents.getVersion(agent.id, 1)).spec.tools).toEqual([]);
		expect(await api.agents.get(agent.id)).toMatchObject({ agent: { id: agent.id }, latestVersion: { version: 2 } });
		expect((await api.agents.list()).map((a) => a.id)).toEqual([agent.id]);

		const session = await api.sessions.create({ agentId: agent.id, agentVersion: 1 });
		expect((await api.sessions.list({ agentId: agent.id })).items.map((s) => s.id)).toEqual([session.id]);
		expect(await api.sessions.get(session.id)).toMatchObject({ session: { id: session.id, agentVersion: 1 } });
		expect(await api.sessions.sandbox(session.id)).toBeNull();

		const { submissionId } = await api.sessions.send(session.id, "hi");
		expect(submissionId).toEqual(expect.any(String));
		await api.sessions.abort(session.id);

		expect((await api.agents.archive(agent.id)).archivedAt).toEqual(expect.any(String));
	});

	it("retries send with the same requestId after a network error", async () => {
		const server = await start(newDataDir(), [{ text: "once" }]);
		const bodies: string[] = [];
		let failures = 0;
		// 第一次请求真的到了服务端，但响应在路上丢了：客户端只看到 fetch 抛错
		const flaky: typeof fetch = async (input, init) => {
			const response = await fetch(input, init);
			if (init?.method === "POST" && String(input).endsWith("/messages")) {
				bodies.push(String(init.body));
				if (failures++ === 0) throw new TypeError("fetch failed");
			}
			return response;
		};
		const api = client(server.url, flaky);
		const { agent } = await api.agents.create({ name: "retry", spec: spec() });
		const session = await api.sessions.create({ agentId: agent.id });

		await api.sessions.send(session.id, "do it once");

		expect(bodies).toHaveLength(2);
		const [first, second] = bodies.map((body) => JSON.parse(body) as { requestId: string });
		expect(second?.requestId).toBe(first?.requestId);
		await expect.poll(async () => (await fullTranscript(api, session.id)).filter((e) => e.role === "user").length).toBe(1);
	});

	it("raises TetherApiError with the server's code", async () => {
		const server = await start(newDataDir(), []);
		const api = client(server.url);

		const missing = await api.sessions.get("ses_missing").catch((error: unknown) => error);
		expect(missing).toBeInstanceOf(TetherApiError);
		expect(missing).toMatchObject({ code: "not_found", status: 404 });

		const anonymous = new TetherClient({ baseUrl: server.url });
		await expect(anonymous.agents.list()).rejects.toMatchObject({ code: "unauthorized", status: 401 });

		await server.stop();
		await expect(api.agents.list()).rejects.toMatchObject({ code: "network" });
	});

	it("follows a session and ends with the same entries as transcript", async () => {
		const server = await start(newDataDir(), [{ text: "streamed answer" }]);
		const api = client(server.url);
		const { agent } = await api.agents.create({ name: "follow", spec: spec() });
		const session = await api.sessions.create({ agentId: agent.id });
		const followed = follow(api, session.id);
		await followed.until((e) => e.type === "snapshot");

		await api.sessions.send(session.id, "talk");
		await followed.until((e) => e.type === "run_end");

		expect(followed.stream.view.entries).toEqual(await fullTranscript(api, session.id));
		expect(followed.stream.view.entries.at(-1)).toMatchObject({ role: "assistant", text: "streamed answer" });
		expect(followed.seen.at(-1)?.view).toBe(followed.stream.view);
	});

	it("reconnects after the server restarts and replaces state with the new snapshot", async () => {
		const dataDir = newDataDir();
		const first = await start(dataDir, [{ text: "before restart" }]);
		const api = client(first.url);
		const { agent } = await api.agents.create({ name: "restart", spec: spec() });
		const session = await api.sessions.create({ agentId: agent.id });
		const followed = follow(api, session.id);
		await followed.until((e) => e.type === "snapshot");
		await api.sessions.send(session.id, "one");
		await followed.until((e) => e.type === "run_end");

		await first.stop();
		await start(dataDir, [{ text: "after restart" }], first.port);
		const snapshots = () => followed.seen.filter((s) => s.event.type === "snapshot").length;
		await expect.poll(snapshots, { timeout: 15_000 }).toBe(2);

		await api.sessions.send(session.id, "two");
		await followed.until((e, i) => e.type === "run_end" && i > followed.seen.findIndex((s) => s.event.type === "run_end"));
		expect(followed.stream.view.entries).toEqual(await fullTranscript(api, session.id));
		expect(followed.stream.view.entries.map((e) => e.text).filter(Boolean)).toEqual([
			"one",
			"before restart",
			"two",
			"after restart",
		]);
	});
});

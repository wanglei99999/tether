import { setTimeout as sleep } from "node:timers/promises";
import { type AgentEngine, applyEvent, type SessionView, type TetherEvent } from "@tether/core";
import type { ScriptStep } from "@tether/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { call, listen, makeApi, newSession, type TestApi, type TestApiOptions } from "./fixtures/api.ts";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function serveApi(script: ScriptStep[], options?: TestApiOptions): Promise<{ api: TestApi; base: string }> {
	const api = await makeApi(script, options);
	cleanups.push(() => api.close());
	const server = await listen(api);
	cleanups.push(() => server.close());
	return { api, base: server.base };
}

interface Client {
	batches: TetherEvent[][];
	events(): TetherEvent[];
	until(match: (event: TetherEvent) => boolean, timeoutMs?: number): Promise<void>;
	closed: Promise<{ code: number; reason: string }>;
	close(): void;
}

function connect(url: string): Client {
	const socket = new WebSocket(url);
	const batches: TetherEvent[][] = [];
	const waiters = new Set<() => void>();
	socket.addEventListener("message", (message) => {
		batches.push(JSON.parse(String(message.data)) as TetherEvent[]);
		for (const check of waiters) check();
	});
	const closed = new Promise<{ code: number; reason: string }>((resolve) => {
		socket.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }));
	});
	cleanups.push(async () => {
		socket.close();
		await closed;
	});
	const events = () => batches.flat();
	return {
		batches,
		events,
		closed,
		close: () => socket.close(),
		until: (match, timeoutMs = 10_000) =>
			new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					waiters.delete(check);
					reject(new Error(`event not seen; got ${events().map((e) => e.type).join(", ")}`));
				}, timeoutMs);
				function check() {
					if (!events().some(match)) return;
					clearTimeout(timer);
					waiters.delete(check);
					resolve();
				}
				waiters.add(check);
				check();
			}),
	};
}

function fold(events: TetherEvent[]): SessionView {
	const [first, ...rest] = events;
	if (first?.type !== "snapshot") throw new Error(`first event is ${first?.type}, not snapshot`);
	return rest.reduce(applyEvent, first.view);
}

const runEnd = (event: TetherEvent) => event.type === "run_end";

describe("WS /v1/sessions/:id/events", () => {
	it("sends a snapshot first, then the events of a run", async () => {
		const { api, base } = await serveApi([{ text: "hello there" }]);
		const id = await newSession(api.app);
		const client = connect(`${base}/v1/sessions/${id}/events`);
		await client.until((e) => e.type === "snapshot");

		await call(api.app, "POST", `/v1/sessions/${id}/messages`, { content: "hi", requestId: "r1" });
		await client.until(runEnd);

		expect(client.batches[0]?.map((e) => e.type)).toEqual(["snapshot"]);
		const types = client.events().map((e) => e.type);
		expect(types).toContain("message_start");
		expect(types.indexOf("message_start")).toBeLessThan(types.indexOf("message_end"));
		expect(types.at(-1)).toBe("run_end");
	});

	it("folds to the same entries as GET transcript", async () => {
		const { api, base } = await serveApi([
			{ toolCall: { name: "bash", args: { command: "echo folded" } } },
			{ text: "done" },
		]);
		const id = await newSession(api.app, ["bash"]);
		const client = connect(`${base}/v1/sessions/${id}/events`);
		await client.until((e) => e.type === "snapshot");

		await call(api.app, "POST", `/v1/sessions/${id}/messages`, { content: "run it", requestId: "r1" });
		await client.until(runEnd);

		const transcript = await call(api.app, "GET", `/v1/sessions/${id}/transcript?limit=100`);
		const view = fold(client.events());
		expect(view.entries).toEqual([...transcript.body.data.items].reverse());
		expect(view).toMatchObject({ running: false, tools: [] });
	});

	it("serves two clients of the same session", async () => {
		const { api, base } = await serveApi([{ text: "to both" }]);
		const id = await newSession(api.app);
		const a = connect(`${base}/v1/sessions/${id}/events`);
		const b = connect(`${base}/v1/sessions/${id}/events`);
		await Promise.all([a.until((e) => e.type === "snapshot"), b.until((e) => e.type === "snapshot")]);

		await call(api.app, "POST", `/v1/sessions/${id}/messages`, { content: "hi", requestId: "r1" });
		await Promise.all([a.until(runEnd), b.until(runEnd)]);

		expect(fold(a.events()).entries).toEqual(fold(b.events()).entries);
	});

	it("closes with 4404 for an unknown session", async () => {
		const { base } = await serveApi([]);
		const client = connect(`${base}/v1/sessions/ses_missing/events`);
		expect(await client.closed).toMatchObject({ code: 4404 });
		expect(client.batches).toEqual([]);
	});

	it("closes with 4401 without the token, and streams with it", async () => {
		const { api, base } = await serveApi([], { token: "secret" });
		const id = await newSession(api.app, [], { authorization: "Bearer secret" });

		for (const query of ["", "?token=wrong"]) {
			const client = connect(`${base}/v1/sessions/${id}/events${query}`);
			expect(await client.closed, query).toMatchObject({ code: 4401 });
			expect(client.batches).toEqual([]);
		}
		const allowed = connect(`${base}/v1/sessions/${id}/events?token=secret`);
		await allowed.until((e) => e.type === "snapshot");
	});

	it("stops the engine subscription when the client disconnects", async () => {
		let stops = 0;
		const counting = (engine: AgentEngine): AgentEngine => {
			const wrapped: AgentEngine = Object.create(engine);
			wrapped.subscribe = async (sessionId, listener) => {
				const subscription = await engine.subscribe(sessionId, listener);
				return {
					stop: async () => {
						stops += 1;
						await subscription.stop();
					},
				};
			};
			return wrapped;
		};
		const { api, base } = await serveApi([], { wrapEngine: counting });
		const id = await newSession(api.app);
		const client = connect(`${base}/v1/sessions/${id}/events`);
		await client.until((e) => e.type === "snapshot");

		client.close();
		await client.closed;
		for (let i = 0; i < 50 && stops === 0; i++) await sleep(20);
		expect(stops).toBe(1);
	});
});

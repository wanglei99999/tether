import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoundPlan } from "@tether/testkit";
import { afterAll, describe, expect, it } from "vitest";
import { runRound } from "./chaos/driver.ts";
import { tryCommand } from "./chaos/faults.ts";

const IMAGE = process.env.TETHER_SANDBOX_IMAGE ?? "tether-sandbox:dev";
// 放在 reflink 盘上才是镜像模式；没有这块盘时退回临时目录（目录模式）
const XFS = "/data/tether-xfs";
const root = mkdtempSync(join(existsSync(XFS) ? XFS : tmpdir(), "chaos-test-"));
const ROUND_TIMEOUT_MS = 300_000;

function plan(faults: RoundPlan["faults"], messages = 2): RoundPlan {
	return { faults, messageAt: [Array.from({ length: messages }, (_, i) => i * 12_000)], durationMs: messages * 12_000 };
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("chaos driver", () => {
	it(
		"a round without faults has no violations",
		async () => {
			const report = await runRound({ seed: 1, round: 0, root, image: IMAGE, sessions: 1, messages: 2, plan: plan([]) });
			expect(report.error).toBeUndefined();
			expect(report.violations).toEqual([]);
			expect(report.interrupted).toBe(0);
		},
		ROUND_TIMEOUT_MS,
	);

	it(
		"a round with one kill9 during a long command has no violations and counts one interrupted call",
		async () => {
			// 第一条消息 0 ms：写文件很快，长命令至少 3 秒，1.5 秒后服务端在长命令里
			const report = await runRound({
				seed: 1,
				round: 1,
				root,
				image: IMAGE,
				sessions: 1,
				messages: 2,
				plan: plan([{ at: 4_000, kind: "kill9", session: 0, downMs: 500 }]),
			});
			expect(report.error).toBeUndefined();
			expect(report.violations).toEqual([]);
			expect(report.faults[0]?.hit).toBe(true);
			expect(report.interrupted).toBe(1);
		},
		ROUND_TIMEOUT_MS,
	);

	it(
		"a duplicate execution injected directly into the container is reported as I2",
		async () => {
			const report = await runRound({
				seed: 1,
				round: 2,
				root,
				image: IMAGE,
				sessions: 1,
				messages: 1,
				plan: plan([], 1),
				sabotage: "duplicate",
			});
			expect(report.error).toBeUndefined();
			expect(report.violations.map((v) => v.invariant)).toContain("I2");
		},
		ROUND_TIMEOUT_MS,
	);

	it(
		"cleanup leaves no container, volume or loop device of the round and keeps loop0",
		async () => {
			const report = await runRound({
				seed: 1,
				round: 3,
				root,
				image: IMAGE,
				sessions: 1,
				messages: 1,
				plan: plan([{ at: 4_000, kind: "stallThenKill", session: 0, downMs: 0 }], 1),
			});
			expect(report.error).toBeUndefined();
			const names = await tryCommand("docker", ["ps", "-a", "--filter", "name=tether-ses_", "--format", "{{.Names}}"]);
			expect(names?.trim()).toBe("");
			const devices = await tryCommand("losetup", ["--list", "--noheadings", "--output", "NAME,BACK-FILE"]);
			expect(devices).toContain("/dev/loop0");
			expect(devices).not.toContain(root);
		},
		ROUND_TIMEOUT_MS,
	);
});

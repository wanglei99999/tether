// 混沌测试入口：npm run chaos -- --seed 1 --rounds 3 [--from 0] [--runtime runsc] [--storage directory] [--keep-failed]
// 每轮一行 JSON 写到 <输出目录>/rounds.jsonl。只在测试机上运行，见 docs/acceptance/m4-chaos.md。
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type CrashPosition, runCrashLoop } from "./crash-loop.ts";
import { type RoundReport, runRound } from "./driver.ts";

const { values } = parseArgs({
	options: {
		seed: { type: "string", default: "1" },
		rounds: { type: "string", default: "1" },
		from: { type: "string", default: "0" },
		runtime: { type: "string" },
		storage: { type: "string" },
		"keep-failed": { type: "boolean", default: false },
		scenario: { type: "string" },
		kills: { type: "string", default: "8" },
		root: { type: "string", default: "/data/tether-xfs/chaos" },
		image: { type: "string", default: "tether-sandbox:dev" },
	},
});

const seed = Number(values.seed);
const from = Number(values.from);
const rounds = Number(values.rounds);
const storage = values.storage === "directory" || values.storage === "image" ? values.storage : undefined;
const tag = `${seed}-${values.runtime ?? "runc"}-${storage ?? "auto"}`;
const output = join(homedir(), "chaos-out", tag);
mkdirSync(output, { recursive: true });

const log = (line: string) => process.stdout.write(`${line}\n`);
const reports: RoundReport[] = [];
for (let round = from; round < from + rounds; round += 1) {
	const report = await runRound({
		seed,
		round,
		root: values.root,
		image: values.image,
		keepFailed: values["keep-failed"],
		...(values.runtime && { runtime: values.runtime }),
		...(storage && { storage }),
	});
	reports.push(report);
	appendFileSync(join(output, "rounds.jsonl"), `${JSON.stringify(report)}\n`);
	const hits = report.faults.filter((fault) => fault.hit).length;
	log(
		`round ${round}: ${(report.durationMs / 1000).toFixed(0)} s, faults ${hits}/${report.faults.length} hit, ` +
			`interrupted ${report.interrupted}, tool errors ${report.toolErrors}, violations ${report.violations.length}` +
			(report.error ? `, error: ${report.error.split("\n")[0]}` : ""),
	);
	for (const violation of report.violations) {
		log(`  ${violation.invariant} ${violation.session ?? ""}: ${violation.detail}`);
	}
}

const failed = reports.filter((report) => report.violations.length > 0 || report.error !== undefined);
log(`${reports.length - failed.length}/${reports.length} rounds clean; report in ${output}`);
process.exitCode = failed.length === 0 ? 0 : 1;

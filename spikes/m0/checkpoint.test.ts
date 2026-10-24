import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approach, measureApproach, measureCommit, type Measurement } from "./checkpoint-bench.ts";
import {
	availableBytes,
	EXT4_ROOT,
	overlaySnapshot,
	removeTree,
	run,
	supportsReflink,
	unmountUnder,
	XFS_ROOT,
} from "./checkpoint.ts";
import { buildImage, docker, dockerExec, LABEL, removeContainer, startContainer } from "./docker.ts";

const TMP = resolve(".tmp");
const USER = `${process.getuid!()}:${process.getgid!()}`;
const GiB = 1024 ** 3;

async function record(name: string, data: unknown): Promise<void> {
	await writeFile(resolve(TMP, name), `${JSON.stringify(data, null, "\t")}\n`);
}

async function removeCheckpointArtifacts(): Promise<void> {
	const containers = await docker(["ps", "-aq", "--filter", `label=${LABEL}`, "--filter", "name=tether-m0-ckpt"]);
	await Promise.all(containers.stdout.split("\n").filter(Boolean).map(removeContainer));
	const images = await docker(["image", "ls", "--quiet", "tether-m0-ckpt"]);
	const ids = [...new Set(images.stdout.split("\n").filter(Boolean))];
	if (ids.length > 0) await docker(["image", "rm", "--force", ...ids]);
	for (const root of [EXT4_ROOT, XFS_ROOT]) {
		await unmountUnder(root);
		await removeTree(root);
	}
}

beforeAll(async () => {
	await buildImage();
	await mkdir(TMP, { recursive: true });
	await removeCheckpointArtifacts();
	await mkdir(EXT4_ROOT, { recursive: true });
	await mkdir(XFS_ROOT, { recursive: true });
}, 600_000);

afterAll(removeCheckpointArtifacts, 600_000);

describe("docker commit", () => {
	it("records how layers grow when one container is committed repeatedly", async () => {
		const name = "tether-m0-ckpt-commit";
		await startContainer(name);
		const layers: { commit: string; topLayer: string }[] = [];
		const commit = async (tag: string): Promise<void> => {
			await docker(["commit", "--change", `LABEL ${LABEL}`, name, `tether-m0-ckpt:${tag}`]);
			const history = await docker(["history", "--no-trunc", "--format", "{{.Size}}", `tether-m0-ckpt:${tag}`]);
			layers.push({ commit: tag, topLayer: history.stdout.split("\n")[0]! });
		};
		await dockerExec(name, "mkdir -p /data && head -c 50M /dev/urandom > /data/big.bin && head -c 1M /dev/urandom > /data/small.bin");
		await commit("c1");
		await dockerExec(name, "head -c 1M /dev/urandom > /data/small.bin");
		await commit("c2");
		await dockerExec(name, "head -c 1M /dev/urandom > /data/small.bin");
		await commit("c3");
		await removeContainer(name);
		// ADR-006 的预期：三层都约 51 MB（每次提交都带上容器创建以来的全部改动）。只记录，不断言。
		await record("checkpoint-commit-layers.json", layers);
	}, 300_000);
});

describe("workspace filesystems", () => {
	it("detects reflink support on both filesystems", async () => {
		const result = [];
		for (const root of [EXT4_ROOT, XFS_ROOT]) {
			const type = (await run("stat", ["-f", "-c", "%T", root])).trim();
			result.push({ root, type, reflink: await supportsReflink(root) });
		}
		await record("checkpoint-fs.json", result);
		expect(result.find((r) => r.root === XFS_ROOT)?.reflink).toBe(true);
	});
});

describe("restoring a workspace snapshot", () => {
	it.each(["reflink", "rsync", "overlay"] as const)("restores files but not processes with %s", async (mode) => {
		const strategy = approach(mode);
		const src = `tether-m0-ckpt-src-${mode}`;
		const dst = `tether-m0-ckpt-dst-${mode}`;
		const workspace = await strategy.create(`restore-src-${mode}`);
		await startContainer(src, { ...workspace.mount, user: USER });
		const at = (file: string): string => `${workspace.containerDir}/${file}`;

		await dockerExec(src, `echo v1 > ${at("a.txt")} && (sleep 600 >/dev/null 2>&1 &)`);
		const snapshot = await strategy.snapshot(workspace, 1, undefined);
		// overlay：重新挂载后容器看到的是新的可写层，改动不进入刚冻结的层
		await dockerExec(src, `echo v2 > ${at("a.txt")}`);
		expect((await dockerExec(src, `cat ${at("a.txt")}`)).stdout).toBe("v2\n");

		const restored = await strategy.restore(snapshot.snapshot, `restore-dst-${mode}`);
		await startContainer(dst, { ...restored.mount, user: USER });
		expect((await dockerExec(dst, `cat ${restored.containerDir}/a.txt`)).stdout).toBe("v1\n");
		expect((await dockerExec(dst, "pgrep -f '[s]leep 600'")).code).toBe(1);

		// 恢复出的工作区与快照互不影响
		await dockerExec(dst, `echo v3 > ${restored.containerDir}/a.txt`);
		expect(await readFile(join(snapshot.snapshot[0]!, "a.txt"), "utf8")).toBe("v1\n");

		await Promise.all([removeContainer(src), removeContainer(dst)]);
		await strategy.destroy(restored);
		await strategy.destroy(snapshot.workspace);
	}, 120_000);
});

describe("overlay layers", () => {
	it("pins that a running process keeps writing into a layer frozen by a lazy unmount", async () => {
		const strategy = approach("overlay");
		const name = "tether-m0-ckpt-frozen";
		const workspace = await strategy.create("frozen");
		await startContainer(name, { ...workspace.mount, user: USER });
		await docker([
			"exec",
			"--detach",
			name,
			"sh",
			"-c",
			`exec 3>>${workspace.containerDir}/log.txt; while true; do echo x >&3; sleep 0.2; done`,
		]);
		await sleep(1_000);

		const overlay = workspace.overlay!;
		const plain = await overlaySnapshot(overlay, { lazy: false }).then(
			() => "unmounted",
			(error: unknown) => String(error),
		);
		const { overlay: next, snapshot } = await overlaySnapshot(overlay, { lazy: true });
		const frozenLog = join(snapshot[0]!, "log.txt");
		const before = (await stat(frozenLog)).size;
		await sleep(2_000);
		const after = (await stat(frozenLog)).size;
		await record("checkpoint-overlay-frozen.json", { plainUnmount: plain, frozenLogBytes: { before, after } });

		await removeContainer(name);
		await strategy.destroy({ ...workspace, overlay: next });
		// 有进程开着工作区里的文件时：普通卸载失败，延迟卸载后冻结层继续被写入
		expect(plain).toMatch(/busy/);
		expect(after).toBeGreaterThan(before);
	}, 120_000);
});

describe("cost", () => {
	it("measures time and space of the four approaches", async () => {
		expect(await availableBytes(EXT4_ROOT)).toBeGreaterThan(10 * GiB);
		expect(await availableBytes(XFS_ROOT)).toBeGreaterThan(6 * GiB);

		const results: Measurement[] = [];
		for (const sizeMiB of [0, 50, 500]) {
			const changes = sizeMiB === 0 ? (["new-file"] as const) : (["new-file", "in-place"] as const);
			for (const change of changes) {
				for (const mode of ["reflink", "rsync", "overlay"] as const) {
					results.push(await measureApproach(approach(mode), sizeMiB, change));
				}
				results.push(await measureCommit(sizeMiB, change));
				await record("checkpoint-timing.json", results);
			}
		}
	}, 1_800_000);
});

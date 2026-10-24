import { daemonCommand, docker, dockerExec } from "./docker.ts";

/** 容器的 init。fence 只在 PID 1 是它的容器里执行 kill -1。 */
const CONTAINER_INIT = "sleep";

/**
 * 在容器里执行的隔离脚本，参数 $1 是新的 epoch。
 * - 再检查一次 PID 1：即使宿主侧的检查有 bug，也不会在共享宿主 PID 命名空间的容器里 kill -1。
 * - 先列出要杀的 PID（只用内建命令遍历 /proc，不额外起进程），再 kill -KILL -1：
 *   杀掉除 PID 1 和本脚本以外的全部进程，即旧 daemon 和它启动的所有命令（每个命令单独一个会话，按会话杀不全）。
 * - 删除 epoch 更小的 daemon 记录。
 */
const FENCE_SCRIPT = `
set -u
[ "$(cat /proc/1/comm)" = "${CONTAINER_INIT}" ] || { echo "PID 1 is not the container init" >&2; exit 99; }
self=$$
pids=""
for dir in /proc/[0-9]*; do
	pid=\${dir#/proc/}
	[ "$pid" = 1 ] || [ "$pid" = "$self" ] || pids="$pids $pid"
done
[ -z "$pids" ] || kill -KILL -1 2>/dev/null || true
for record in /run/tether/daemons/*.*; do
	[ -e "$record" ] || continue
	epoch=\${record##*/}
	epoch=\${epoch%%.*}
	[ "$epoch" -lt "$1" ] && rm -f "$record"
done
echo $pids
`;

/**
 * 确认容器有自己的 PID 命名空间，且 PID 1 是容器自己的 init；否则抛错。
 * 在共享宿主 PID 命名空间的容器里执行 kill -1，会杀掉宿主上的进程。
 */
export async function assertPidIsolated(container: string): Promise<void> {
	const inspect = await docker(["inspect", "--format", "{{.HostConfig.PidMode}}", container]);
	if (inspect.code !== 0) throw new Error(`cannot inspect ${container}: ${inspect.stderr.trim()}`);
	const pidMode = inspect.stdout.trim();
	if (pidMode !== "") {
		throw new Error(`${container} does not have its own PID namespace (PidMode=${pidMode})`);
	}
	const init = (await dockerExec(container, "cat /proc/1/comm")).stdout.trim();
	if (init !== CONTAINER_INIT) {
		throw new Error(`${container} PID namespace check failed: PID 1 is '${init}', not '${CONTAINER_INIT}'`);
	}
}

/** 杀掉容器里 epoch 小于 currentEpoch 的 daemon 和它们启动的全部进程。前提：一个容器同一时刻只有一条连接。 */
export async function fence(container: string, currentEpoch: number): Promise<{ killed: number[] }> {
	await assertPidIsolated(container);
	const result = await docker(["exec", container, "sh", "-c", FENCE_SCRIPT, "fence", String(currentEpoch)]);
	if (result.code !== 0) {
		throw new Error(`fence of ${container} at epoch ${currentEpoch} failed (${result.code}): ${result.stderr.trim()}`);
	}
	const killed = result.stdout.trim().split(/\s+/).filter(Boolean).map(Number);
	return { killed };
}

/**
 * 给 `ConnectionOptions.command` 用：Connection 每次（重新）启动 daemon 都会调用它。
 * 每次取一个新 epoch，先隔离旧的，再返回新 daemon 的启动命令。这是不修改 Connection 就能插入隔离的位置。
 */
export function fencedCommand(container: string, nextEpoch: () => number): () => Promise<string[]> {
	return async () => {
		const epoch = nextEpoch();
		await fence(container, epoch);
		return daemonCommand(container, epoch);
	};
}

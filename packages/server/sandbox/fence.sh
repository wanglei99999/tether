#!/bin/sh
# 用法：fence.sh <epoch>
# 新 daemon 启动前执行（ADR-007）：杀掉容器里除 PID 1 和本脚本以外的全部进程，即旧 daemon 和它启动的所有命令
# （每个命令单独一个会话，按会话杀不全），再删除 epoch 更小的 daemon 记录。输出被杀的 PID，以空格分隔。
#
# 宿主侧已检查过容器有自己的 PID 命名空间，这里再检查一次 PID 1：
# 即使宿主侧的检查有 bug，也不会在共享宿主 PID 命名空间的容器里执行 kill -1。
set -u
case "${1:-}" in
	'' | *[!0-9]*) echo "usage: fence.sh <epoch>" >&2; exit 2 ;;
esac
[ "$(cat /proc/1/comm)" = sleep ] || { echo "PID 1 is not the container init" >&2; exit 99; }

# 先列出要杀的 PID：只用内建命令遍历 /proc，不额外起进程
self=$$
pids=""
for dir in /proc/[0-9]*; do
	pid=${dir#/proc/}
	[ "$pid" = 1 ] || [ "$pid" = "$self" ] || pids="$pids $pid"
done
[ -z "$pids" ] || kill -KILL -1 2>/dev/null || true

for record in /run/tether/daemons/*.*; do
	[ -e "$record" ] || continue
	epoch=${record##*/}
	epoch=${epoch%%.*}
	[ "$epoch" -lt "$1" ] && rm -f "$record"
done
echo $pids

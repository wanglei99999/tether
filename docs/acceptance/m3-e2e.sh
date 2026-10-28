#!/usr/bin/env bash
# M3 端到端验收：在测试机上以 tether 用户执行（数据目录在 XFS 测试盘上 → 镜像模式），假模型按剧本回答。
set -euo pipefail
cd ~/tether-m1
ROOT=/data/tether-xfs/e2e-m3
rm -rf "$ROOT" && mkdir -p "$ROOT"
export TETHER_DATA_DIR=$ROOT TETHER_PORT=7431 TETHER_TOKEN=e2e TETHER_SANDBOX_IMAGE=tether-sandbox:dev
export TETHER_URL=http://127.0.0.1:7431 TETHER_SWEEP_INTERVAL_SECONDS=5

T() { node packages/cli/bin/tether "$@"; }
step() { printf '\n=== %s\n' "$*"; }
# 会话记录里文本为 $2 的用户条目的 ID
entry() { curl -s -H "authorization: Bearer e2e" "$TETHER_URL/v1/sessions/$1/transcript?limit=100" |
	node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")).data.items;process.stdout.write(d.find(e=>e.role==="user"&&e.text===process.argv[1]).id)' "$2"; }
# 会话记录里 tether.* 条目（kind 和 data），从旧到新
notes() { curl -s -H "authorization: Bearer e2e" "$TETHER_URL/v1/sessions/$1/transcript?limit=100" |
	node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")).data.items.reverse();for(const e of d)if(e.kind.startsWith("tether."))console.log(e.kind,JSON.stringify(e.data))'; }
id() { grep -o 'ses_[A-Za-z0-9_]*' | head -n 1; }

write() { printf '{"toolCall":{"name":"bash","args":{"command":"echo %s > %s.txt"}}},{"text":"wrote %s"}' "$1" "$1" "$1"; }
LIST='{"toolCall":{"name":"bash","args":{"command":"ls /workspace"}}},{"text":"listed"}'
start() {
	TETHER_FAUX_SCRIPT="$1" node packages/server/test/fixtures/run-tether.ts >> "$ROOT/server.log" 2>&1 &
	SERVER=$!
	for _ in $(seq 60); do grep -q listening "$ROOT/server.log" && return; sleep 0.5; done
	echo "server did not start"; cat "$ROOT/server.log"; exit 1
}
stop() { kill "$SERVER"; wait "$SERVER" || true; : > "$ROOT/server.log"; SERVER=; }
# 中途失败也停掉服务，免得留下进程（容器和卷由下次启动对账或手动清理）
SERVER=
trap '[ -n "$SERVER" ] && kill "$SERVER" 2>/dev/null; true' EXIT

step "启动（应选镜像模式：没有 reflink 警告）"
start "[$(write f1),$(write f2),$(write f3),$LIST,$LIST,$LIST]"
grep -i reflink "$ROOT/server.log" || echo "no reflink warning"

step "perRun 的 agent，三轮各写一个文件"
cat > "$ROOT/agent.json" <<'JSON'
{"name":"e2e-m3","spec":{"model":{"provider":"faux","modelId":"faux-1"},"instructions":"e2e","tools":["bash"],
"sandbox":{"template":"","resources":{"cpu":1,"memoryMb":512,"diskMb":512},"network":"none","setup":[],"variables":[]},
"checkpointPolicy":"perRun","permissions":{"denyTools":[],"requireApproval":[]}}}
JSON
AGENT=$(T agent create --file "$ROOT/agent.json" | grep -o 'agt_[A-Za-z0-9_]*')
A=$(T session create "$AGENT" | id)
for m in first second third; do T send "$A" "$m" --follow; done
T files "$A"

step "tether checkpoints：3 张，第一张是模板"
T checkpoints "$A"

step "在第三条消息处分叉：fork 里只有 f1、f2"
OUT=$(T session fork "$A" "$(entry "$A" third)")
echo "$OUT"
F1=$(echo "$OUT" | id)
T send "$F1" "what is here" --follow
T files "$F1"

step "在 fork 里、对继承来的第二条消息再分叉：只有 f1"
OUT=$(T session fork "$F1" "$(entry "$A" second)")
echo "$OUT"
F2=$(echo "$OUT" | id)
T send "$F2" "what is here" --follow
T files "$F2"
notes "$F2"

step "docker rm -f 原会话的容器，再发消息：从最近的存档恢复（f1、f2），f3 列为没发生的操作"
docker rm -f "tether-$A" > /dev/null
# 正在运行的沙箱不在每次工具调用时问 Docker，丢失由巡检发现（M2 的设计）
for i in $(seq 30); do case "$(T sandbox "$A")" in lost*) echo "lost after ${i}s"; break ;; esac; sleep 1; done
T sandbox "$A"
T send "$A" "fourth" --follow
T files "$A"
notes "$A" | tail -n 4

step "重启：停止 60 秒、删除 120 秒、巡检 5 秒"
stop
export TETHER_STOP_AFTER_SECONDS=60 TETHER_DESTROY_AFTER_SECONDS=120
start "[$LIST]"
for i in $(seq 60); do
	state=$(T sandbox "$A")
	echo "$((i * 5))s  $state"
	case "$state" in lost*) break ;; esac
	sleep 5
done
notes "$A" | tail -n 4

step "删除后再发消息：从最终存档恢复"
T send "$A" "fifth" --follow
T files "$A"
notes "$A" | tail -n 2

step "归档全部会话：存档目录清空，没有卷"
for s in "$A" "$F1" "$F2"; do T session archive "$s"; done
find "$ROOT/checkpoints" -mindepth 1 | head
echo "checkpoint files: $(find "$ROOT/checkpoints" -mindepth 2 | wc -l)"
echo "tether volumes: $(docker volume ls -q --filter name=tether- | wc -l)"
echo "workspaces: $(ls "$ROOT/workspaces" | wc -l)"
stop

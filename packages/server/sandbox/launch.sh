#!/bin/sh
# 用法：launch.sh <epoch> serve --token <hex>
# 先记下 <epoch>.<PID>，再 exec 成 daemon（exec 不换 PID，记录里的 PID 就是 daemon 的 PID）。
# 记录只用来观察当前是哪个 epoch，隔离本身不依赖它。
set -eu
epoch="$1"
shift
: > "/run/tether/daemons/$epoch.$$"
exec /opt/tether/pi-env "$@"

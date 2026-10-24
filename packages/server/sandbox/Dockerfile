# Tether 默认的沙箱镜像。pi-env daemon 是静态链接的，基础镜像只需要提供命令行工具。
FROM debian:bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends bash coreutils procps git ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

# 容器以非 root 用户运行（uid 与宿主工作区属主一致），daemon 记录目录要对它可写。
RUN mkdir -p /workspace /run/tether/daemons && chmod 1777 /run/tether/daemons

COPY --chmod=755 pi-env /opt/tether/pi-env
COPY --chmod=755 launch.sh /opt/tether/launch.sh

WORKDIR /workspace

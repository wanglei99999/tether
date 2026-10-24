# M0 实验用的沙箱镜像。daemon 是静态链接的，基础镜像只需要提供命令行工具。
FROM debian:bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends bash coreutils procps git \
	&& rm -rf /var/lib/apt/lists/*

RUN mkdir -p /workspace /run/tether/daemons

COPY --chmod=755 pi-env /opt/tether/pi-env
COPY --chmod=755 launch.sh /opt/tether/launch.sh

WORKDIR /workspace

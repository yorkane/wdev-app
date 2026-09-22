# 由本仓库的 deb 装载出容器镜像。
#
# 用法（在仓库根目录；先产出 deb，构建流程见 doc/GATEWAY-PACKAGING.md）：
#   docker build -f packaging/docker/Dockerfile \
#     --build-arg DEB=dist/wdev_<版本>_amd64.deb \
#     -t codex-desktop:latest .
#
# 运行（host 网络，与原生部署等价；注意 --shm-size 是 Chromium 需要）：
#     -v codex-desktop-state:/var/lib/codex-desktop codex-desktop:latest
#
# 运行（bridge + 端口映射）：必须把 HOST 改成 0.0.0.0，否则只绑容器内 loopback，
# 宿主经 -p 映射访问不到（实测 healthz=000）：
#   docker run -d --name codex-desktop -p 3737:3737 -e HOST=0.0.0.0 \
#     --shm-size=1g --init -v codex-desktop-state:/var/lib/codex-desktop codex-desktop:latest

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=zh_CN.UTF-8 \
    OPENCODEX_HEADLESS_ELECTRON=1 \
    CODEX_DESKTOP_ENV_FILE=/etc/codex-desktop/gateway.env

# 1) 系统依赖：与 deb 的 Depends 一致（继承官方 chatgpt 包），再补 xvfb。
#    nodejs 不在其中——网关跑包内捆绑的 node（/opt/codex-desktop/gateway/node）。
ARG DEB
COPY packaging/docker/packages.txt /tmp/packages.txt
RUN apt-get update \
 && xargs -a /tmp/packages.txt apt-get install -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/* /tmp/packages.txt

# 2) 装入 deb 载荷（等价于 dpkg -i，但不跑维护脚本/postinst：容器里没有 systemd）。
#    systemd 单元在载荷的 /lib/systemd/system 下，这里刻意不装。
COPY ${DEB} /tmp/codex-desktop.deb
RUN dpkg-deb -x /tmp/codex-desktop.deb / \
 && rm -f /tmp/codex-desktop.deb

# 3) 服务账户与运行目录（原生安装由 postinst 创建）。
RUN groupadd -r codex-desktop \
 && useradd -r -g codex-desktop -d /var/lib/codex-desktop -s /usr/sbin/nologin codex-desktop \
 && mkdir -p /var/lib/codex-desktop /var/log/codex-desktop \
 && chown -R codex-desktop:codex-desktop /var/lib/codex-desktop /var/log/codex-desktop

# 4) 容器入口（替代 systemd 单元）。
COPY packaging/docker/container-entrypoint.sh /usr/local/bin/container-entrypoint.sh
RUN chmod +x /usr/local/bin/container-entrypoint.sh

# 运行状态建议挂卷：/var/lib/codex-desktop（含 codexhome 与官方运行时 profile）。
VOLUME ["/var/lib/codex-desktop"]
EXPOSE 3737

USER codex-desktop
WORKDIR /opt/codex-desktop/gateway
ENTRYPOINT ["/usr/local/bin/container-entrypoint.sh"]

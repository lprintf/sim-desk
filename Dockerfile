# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22.14.0

FROM node:${NODE_VERSION}-bookworm-slim AS frontend-build
ARG MIRROR=official
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN case "$MIRROR" in \
      official) npm_registry="https://registry.npmjs.org" ;; \
      tencent) npm_registry="https://mirrors.cloud.tencent.com/npm/" ;; \
      aliyun) npm_registry="https://registry.npmmirror.com" ;; \
      *) echo "Unsupported MIRROR: $MIRROR (expected official, tencent, or aliyun)" >&2; exit 2 ;; \
    esac && \
    npm config set registry "$npm_registry" && \
    npm ci
COPY frontend/ ./
RUN npm run build

FROM node:${NODE_VERSION}-bookworm-slim AS server-deps
ARG MIRROR=official
WORKDIR /build
RUN case "$MIRROR" in \
      official) debian_mirror="https://deb.debian.org/debian"; security_mirror="https://deb.debian.org/debian-security"; npm_registry="https://registry.npmjs.org" ;; \
      tencent) debian_mirror="https://mirrors.cloud.tencent.com/debian"; security_mirror="https://mirrors.cloud.tencent.com/debian-security"; npm_registry="https://mirrors.cloud.tencent.com/npm/" ;; \
      aliyun) debian_mirror="https://mirrors.aliyun.com/debian"; security_mirror="https://mirrors.aliyun.com/debian-security"; npm_registry="https://registry.npmmirror.com" ;; \
      *) echo "Unsupported MIRROR: $MIRROR (expected official, tencent, or aliyun)" >&2; exit 2 ;; \
    esac \
    && debian_bootstrap="$(printf '%s' "$debian_mirror" | sed 's|^https://|http://|')" \
    && security_bootstrap="$(printf '%s' "$security_mirror" | sed 's|^https://|http://|')" \
    && sed -i \
        -e "s|http://deb.debian.org/debian-security|${security_bootstrap}|g" \
        -e "s|http://deb.debian.org/debian|${debian_bootstrap}|g" \
        /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && sed -i \
        -e "s|${security_bootstrap}|${security_mirror}|g" \
        -e "s|${debian_bootstrap}|${debian_mirror}|g" \
        /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install --yes --no-install-recommends g++ make python3 \
    && npm config set registry "$npm_registry" \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM nginx:1.27-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend-build /build/frontend/out/ /usr/share/nginx/html/
EXPOSE 8080

FROM node:${NODE_VERSION}-bookworm-slim AS node-runtime

FROM ubuntu:24.04 AS runtime
ARG MIRROR=official
ARG CODEX_VERSION=0.145.0
ARG PLAYWRIGHT_MCP_VERSION=0.0.78
ARG PLAYWRIGHT_VERSION=1.62.0-alpha-1783623505000

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    HOME=/home/codex \
    CODEX_HOME=/home/codex/.codex \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

COPY --from=node-runtime /usr/local/ /usr/local/

RUN case "$MIRROR" in \
      official) ubuntu_mirror="https://archive.ubuntu.com/ubuntu"; security_mirror="https://security.ubuntu.com/ubuntu"; npm_registry="https://registry.npmjs.org" ;; \
      tencent) ubuntu_mirror="https://mirrors.cloud.tencent.com/ubuntu"; security_mirror="$ubuntu_mirror"; npm_registry="https://mirrors.cloud.tencent.com/npm/" ;; \
      aliyun) ubuntu_mirror="https://mirrors.aliyun.com/ubuntu"; security_mirror="$ubuntu_mirror"; npm_registry="https://registry.npmmirror.com" ;; \
      *) echo "Unsupported MIRROR: $MIRROR (expected official, tencent, or aliyun)" >&2; exit 2 ;; \
    esac \
    && ubuntu_bootstrap="$(printf '%s' "$ubuntu_mirror" | sed 's|^https://|http://|')" \
    && security_bootstrap="$(printf '%s' "$security_mirror" | sed 's|^https://|http://|')" \
    && sed -i \
        -e "s|http://archive.ubuntu.com/ubuntu|${ubuntu_bootstrap}|g" \
        -e "s|http://security.ubuntu.com/ubuntu|${security_bootstrap}|g" \
        /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && sed -i \
        -e "s|${security_bootstrap}|${security_mirror}|g" \
        -e "s|${ubuntu_bootstrap}|${ubuntu_mirror}|g" \
        /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get update \
    && apt-get install --yes --no-install-recommends \
        bash \
        curl \
        ffmpeg \
        file \
        fonts-liberation \
        fonts-noto-cjk \
        git \
        imagemagick \
        jq \
        less \
        libreoffice-calc \
        libreoffice-impress \
        libreoffice-writer \
        openssh-client \
        python3 \
        python3-pip \
        python3-venv \
        ripgrep \
        tini \
        unzip \
    && rm -rf /var/lib/apt/lists/* \
    && npm config set registry "$npm_registry" \
    && npm install --global \
        "@openai/codex@${CODEX_VERSION}" \
        "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
        "playwright@${PLAYWRIGHT_VERSION}" \
    && playwright install --with-deps chromium \
    && npm cache clean --force

RUN groupadd --gid 1000 codex \
    && useradd --uid 1000 --gid codex --create-home --shell /bin/bash codex \
    && mkdir -p \
        /home/codex/.codex \
        /home/codex/.config/sim-desk-browser \
        /ms-playwright \
        /opt/sim-desk/frontend/out \
        /var/lib/sim-desk \
        /workspace/output \
    && chown -R codex:codex \
        /home/codex \
        /ms-playwright \
        /opt/sim-desk \
        /var/lib/sim-desk \
        /workspace

WORKDIR /opt/sim-desk
COPY package.json package-lock.json ./
COPY --from=server-deps --chown=codex:codex /build/node_modules/ ./node_modules/
COPY --chown=codex:codex server/ ./server/
COPY --from=frontend-build --chown=codex:codex /build/frontend/out/ ./frontend/out/
COPY --chown=codex:codex docker/codex-config.defaults.toml ./defaults/config.toml
COPY --chown=codex:codex docker/entrypoint.sh /usr/local/bin/sim-desk-entrypoint
RUN chmod 0755 /usr/local/bin/sim-desk-entrypoint

USER codex
EXPOSE 3500
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/sim-desk-entrypoint"]
CMD ["node", "server/index.js"]

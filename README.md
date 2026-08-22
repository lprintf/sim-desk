# Sim Desk

Sim Desk 是一个 Compose 原生的 Codex 移动开发工作台。它复用经过验证的 Deck 桌面端和手机端界面，但把 Ubuntu 容器定义为唯一执行环境，因此部署不依赖宿主系统的 Shell、浏览器或开发工具。

## 服务

- `web`：Nginx 静态前端和 `/api`、`/ws` 反向代理，唯一对外暴露的服务。
- `runtime`：Deck Node 服务、`codex app-server`、Bash、Git、Playwright/Chromium 和媒体工具链。

runtime 已包含 Node.js、Codex CLI、Python、Git、ripgrep、FFmpeg、ImageMagick、LibreOffice headless、中英文字体和 Playwright MCP。

## 快速开始

要求：Docker Engine 和 Docker Compose v2。

```bash
cp .env.example .env
```

编辑 `.env`，至少设置：

```dotenv
SIM_DESK_WORKSPACE=/absolute/path/to/your/workspace
SIM_DESK_OUTPUT=/absolute/path/to/your/output
SIM_DESK_AUTH_KEY=replace-with-a-long-random-value
```

构建镜像：

```bash
docker compose build
```

镜像构建通过 `.env` 中的 `MIRROR` 统一选择 apt、npm 和 Playwright 浏览器下载源，支持 `official`、`tencent` 和 `aliyun`，默认值为 `official`。在阿里云或腾讯云 ECS 上使用 `aliyun`/`tencent` 时，Playwright Chromium 会从 `registry.npmmirror.com` 下载，避免访问 `cdn.playwright.dev` 过慢。国内镜像需要与 Playwright 版本对应，Compose 默认版本已与镜像中的 Chromium 构建匹配。

Codex 支持两种认证方式。

使用 ChatGPT 账号时，保持 `.env` 中的 `OPENAI_API_KEY` 为空，首次使用时在容器的持久化 `CODEX_HOME` 中登录：

```bash
docker compose run --rm runtime codex login
```

使用 API Key 时，在 `.env` 中设置：

```dotenv
OPENAI_API_KEY=replace-with-your-api-key
```

Codex 会直接从 runtime 环境读取该密钥，不需要再执行交互式登录。若使用 OpenAI-compatible 网关，再设置包含 API 版本路径的 endpoint：

```dotenv
OPENAI_BASE_URL=https://gateway.example.com/v1
CODEX_MODEL=
```

`OPENAI_BASE_URL` 和 `CODEX_MODEL` 由容器内的 Codex wrapper 转换为运行时配置，不会写入或覆盖持久化的 `config.toml`。留空 `OPENAI_BASE_URL` 即使用官方 OpenAI endpoint。

不要同时保留旧的 ChatGPT 登录和 API Key 配置；切换认证方式时可以先执行：

```bash
docker compose run --rm runtime codex logout
```

启动服务：

```bash
docker compose up -d
docker compose ps
```

## Development without rebuilding on source changes

The default Compose stack is the production-style deployment: application
source and the exported frontend are copied into immutable images. Use the
development overlay while editing Sim Desk itself:

```bash
docker compose -f compose.yaml -f compose.dev.yaml build runtime frontend-dev
docker compose -f compose.yaml -f compose.dev.yaml up runtime frontend-dev
```

Open `http://localhost:3000/?key=<SIM_DESK_AUTH_KEY>`. The development frontend
connects directly to the API on `127.0.0.1:3510`. The overlay bind-mounts
`server/` and `frontend/`; Node restarts the backend when server
files change and Next.js provides frontend hot reload. Dependencies remain in
the image or the `frontend-node-modules` volume, so ordinary source edits do
not rebuild either image.

Rebuild `runtime` after changing the Dockerfile, root dependencies, Codex or
Playwright versions, wrapper/entrypoint scripts, or system packages. Rebuild
`frontend-dev` after changing `frontend/package.json` or its lockfile. Keep the
default stack for deployment because bind-mounting application code makes the
running service depend on mutable host files and host filesystem semantics.

生产环境不发布宿主端口。外部 gateway 反向代理应加入 Docker `gateway`
网络，并把 HTTP 与 WebSocket 流量转发到：

```text
http://${HUB_GATEWAY_ALIAS:-desk}:8080
```

用户访问地址由 gateway 提供。首次访问仍使用
`https://<public-host>/?key=<SIM_DESK_AUTH_KEY>`；页面会保存 key 并从地址栏移除。

## 持久化

| 数据 | 容器路径 | Compose 存储 |
|---|---|---|
| 工作区 | `/workspace` | `SIM_DESK_WORKSPACE` bind mount |
| 生成物 | `/workspace/output` | `SIM_DESK_OUTPUT` bind mount |
| Codex 配置、登录和线程 | `/home/codex/.codex` | `codex-home` volume |
| Deck 状态和终端历史 | `/var/lib/sim-desk` | `deck-data` volume |
| 浏览器 profile | `/home/codex/.config/sim-desk-browser` | `browser-profile` volume |

删除或重建容器不会删除这些数据。执行 `docker compose down -v` 会删除三个 named volume，应当只在明确需要清空状态时使用。

外部 Codex 客户端异常退出时可能来不及写入结束事件。`CODEX_ACTIVITY_STALE_MS` 默认以 10 分钟无 session 文件活动作为运行标记的过期保护。

## Codex 与浏览器

首次创建 `CODEX_HOME` 时，entrypoint 会写入默认 `config.toml`，其中启用了 stdio Playwright MCP。它运行独立的 headless Chromium，并把截图、PDF 和浏览器日志写到 `/workspace/output/browser`。

Compose 会把 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`CODEX_MODEL`、`CODEX_SANDBOX` 和 `CODEX_APPROVAL_POLICY` 传给 runtime。除 API Key 认证外，这些值都作为 Codex 命令行配置覆盖生效，因此修改 `.env` 后重新创建 runtime 容器即可应用，也不会受到已有 `codex-home` volume 中旧配置的影响：

```bash
docker compose up -d --force-recreate runtime
```

检查容器内 Codex 和 MCP：

```bash
docker compose run --rm runtime codex --version
docker compose run --rm runtime codex doctor --summary
docker compose run --rm runtime codex mcp list
```

进入同一 Ubuntu 工作环境排查工具：

```bash
docker compose exec runtime bash
```

## 第三方 API

OpenAI、MiniMax 等密钥只放在 `.env` 或 Compose secrets，不写入镜像、前端或仓库。当前 Compose 会把 `OPENAI_API_KEY` 和 `MINIMAX_API_KEY` 注入 runtime；自定义 OpenAI-compatible endpoint 通过 `OPENAI_BASE_URL` 配置。前端和 Nginx 均不会接触这些变量。

## 常用运维

```bash
docker compose logs -f runtime
docker compose logs -f web
docker compose restart runtime
docker compose pull
docker compose build --pull
docker compose up -d
```

完整设计和边界见 [容器架构](docs/container-architecture.md)。

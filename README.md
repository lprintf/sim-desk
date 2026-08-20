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

镜像构建通过 `.env` 中的 `MIRROR` 统一选择 apt、npm 和 Playwright 浏览器下载源，支持 `official`、`tencent` 和 `aliyun`，默认值为 `official`。在阿里云或腾讯云 ECS 上使用 `aliyun`/`tencent` 时，Playwright Chromium 会从国内镜像下载，避免访问 `cdn.playwright.dev` 过慢。

首次使用时在容器的持久化 `CODEX_HOME` 中登录：

```bash
docker compose run --rm runtime codex login
```

启动服务：

```bash
docker compose up -d
docker compose ps
```

默认入口：

```text
http://localhost:3500/?key=<SIM_DESK_AUTH_KEY>
```

页面会把 key 保存到浏览器，然后从地址栏移除。外部 TLS 隧道应指向宿主的 HTTP `3500` 端口，并保留 WebSocket Upgrade。

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

检查容器内 Codex 和 MCP：

```bash
docker compose run --rm runtime codex --version
docker compose run --rm runtime codex mcp list
```

进入同一 Ubuntu 工作环境排查工具：

```bash
docker compose exec runtime bash
```

## 第三方 API

MiniMax 等密钥只放在 `.env` 或 Compose secrets，不写入镜像、前端或仓库。当前 Compose 会把 `MINIMAX_API_KEY` 注入 runtime；其他提供商可以按相同模式显式增加。

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

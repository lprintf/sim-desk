# Sim Desk 文档

Sim Desk 是运行在 Ubuntu 容器中的 Codex 移动开发工作台。宿主系统只需提供 Docker Engine、Compose、持久化磁盘和网络；Codex、Shell、Git、浏览器自动化及媒体工具均以容器内环境为准。

## 架构文档

- [容器架构](container-architecture.md)：部署边界、进程拓扑、数据持久化、浏览器与媒体能力、安全模型和实施阶段。

## 当前决策

1. Ubuntu 容器是正式 Codex 工作环境，不依赖宿主系统的 Shell、浏览器或桌面能力。
2. Nginx 负责静态前端和 `/api`、`/ws` 反向代理。
3. Deck Node 服务负责产品 API、文件/Git/PTY，并以子进程方式运行 `codex app-server --stdio`。
4. Playwright/Chromium、FFmpeg、ImageMagick、Python 和 LibreOffice headless 首期安装在同一个 runtime 镜像中。
5. `CODEX_HOME`、工作区、Deck 状态和 `/workspace/output` 生成物必须独立持久化。
6. 容器浏览器是独立自动化浏览器，不等同于宿主机已有的 Chrome 会话。

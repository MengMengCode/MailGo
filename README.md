<p align="center">
  <img src="image/icon.png" width="96" alt="MailGo">
</p>

<h1 align="center">MailGo</h1>

<p align="center">
  <img alt="Go" src="https://img.shields.io/badge/Go-1.24-00ADD8?style=flat-square&logo=go&logoColor=white">
  <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=111111">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-6-646CFF?style=flat-square&logo=vite&logoColor=white">
  <img alt="Tailwind CSS" src="https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white">
  <img alt="Docker" src="https://img.shields.io/badge/Docker-Ready-2496ED?style=flat-square&logo=docker&logoColor=white">
  <img alt="MySQL" src="https://img.shields.io/badge/MySQL-8.0-4479A1?style=flat-square&logo=mysql&logoColor=white">
  <img alt="Redis" src="https://img.shields.io/badge/Redis-7-DC382D?style=flat-square&logo=redis&logoColor=white">
</p>

<p align="center">
  <img alt="IMAP" src="https://img.shields.io/badge/IMAP-Supported-4CAF50?style=flat-square">
  <img alt="SMTP" src="https://img.shields.io/badge/SMTP-Supported-2196F3?style=flat-square">
  <img alt="PGP" src="https://img.shields.io/badge/PGP-E2E_Encryption-FF9800?style=flat-square">
  <img alt="AI" src="https://img.shields.io/badge/AI-Assistant-9C27B0?style=flat-square&logo=openai&logoColor=white">
  <img alt="i18n" src="https://img.shields.io/badge/i18n-ZH_&_EN-795548?style=flat-square">
  <img alt="Security" src="https://img.shields.io/badge/Security-Hardened-E91E63?style=flat-square">
  <img alt="License" src="https://img.shields.io/badge/License-Apache_2.0-blue?style=flat-square">
</p>

A modern, self-hosted email client with a clean web interface. Connect your IMAP/SMTP accounts and manage all your email from one place.

一个现代化的自托管 Web 邮件客户端，支持多账户 IMAP/SMTP，统一管理所有邮件。

## Installation / 安装

### Docker (Recommended / 推荐)

```bash
curl -fsSL https://raw.githubusercontent.com/MengMengCode/MailGo/main/install.sh | bash
```

The script downloads `docker-compose.yml`, generates `.env` with random secrets, pulls the pre-built image from GHCR, starts all containers (app + MySQL + Redis), and prints the initial login password.

脚本自动下载 `docker-compose.yml`，生成含随机密钥的 `.env`，从 GHCR 拉取预构建镜像，启动所有容器（应用 + MySQL + Redis），并打印初始登录密码。

Default install directory: `~/mailgo`. Override with `MAILGO_DIR=/path/to/dir`.

默认安装目录：`~/mailgo`。可通过 `MAILGO_DIR=/path/to/dir` 自定义。

### Manual / 手动部署

Requirements / 环境要求: Go 1.24+, Node.js 20+, MySQL 8.0+, Redis 7+

```bash
cd frontend && npm install && npm run build
cp -r dist ../backend/frontend-dist
cd ../backend
cp ../.env.example ../.env   # Edit with your credentials
go build -o mailgo .
./mailgo
```

## Features / 功能介绍

### English

| Area | What MailGo provides |
|---|---|
| Multi-account | Connect multiple IMAP/SMTP email accounts with a unified inbox, folder navigation, and per-account avatar & color tagging. |
| Compose & reply | Rich-text editor with formatting toolbar, inline images, drag-and-drop attachments, auto-save drafts, reply/reply-all/forward, and PGP encryption toggle. |
| PGP encryption | Generate RSA-4096 key pairs, encrypt outgoing messages, auto-decrypt incoming messages, manual private key import, and key management with download. |
| AI assistant | AI-powered compose panel for writing, translating, summarizing, and modifying emails. Supports OpenAI-compatible APIs with streaming responses. |
| Email tracking protection | Detect and block tracking pixels, read receipts, and beacons from known ESP domains. Configurable per-message allow/deny. |
| Customizable UI | Accent colors, background images with frosted glass effect, sidebar transparency, font size, border radius, shadow intensity, animation speed, compact mode, and custom CSS injection. |
| Themes & i18n | Light, dark, and system theme with cross-device sync. Chinese and English interface with cross-device language sync. |
| Search & filter | Full-text search across subjects, senders, and body content. Filter by date range, sender, subject, and attachment presence. |
| Attachments | PDF preview with page navigation, image preview, inline CID image resolution, download, and 25MB upload support. |
| Security | Session auth with HttpOnly + SameSiteStrict cookies, login rate limiting with IP banning, AES-256-GCM encryption at rest, CSP headers, SSRF protection, and CORS restriction. |

### 中文

| 模块 | MailGo 提供的能力 |
|---| ---|
| 多账户管理 | 支持连接多个 IMAP/SMTP 邮箱账户，统一收件箱、文件夹导航、按账户设置头像和标记颜色。 |
| 写信与回复 | 富文本编辑器带格式工具栏、内嵌图片、拖拽附件、自动保存草稿、回复/全部回复/转发、PGP 加密开关。 |
| PGP 加密 | 生成 RSA-4096 密钥对，加密发出的邮件，自动解密收到的加密邮件，支持手动导入私钥和密钥下载管理。 |
| AI 助手 | AI 辅助撰写面板，支持编写、翻译、摘要和修改邮件，兼容 OpenAI 接口，流式响应。 |
| 邮件追踪防护 | 检测并拦截追踪像素、阅读回执和信标，覆盖主流 ESP 追踪域名，支持按邮件单独允许/拦截。 |
| 自定义界面 | 主题色、背景图毛玻璃效果、侧栏透明度、字体大小、圆角、阴影强度、动画速度、紧凑模式、自定义 CSS 注入。 |
| 主题与国际化 | 浅色、深色、跟随系统三种主题，跨设备同步。中英文界面，跨设备语言同步。 |
| 搜索与筛选 | 全文搜索主题、发件人和正文内容，按时间范围、发件人、主题、是否有附件筛选。 |
| 附件处理 | PDF 预览含翻页、图片预览、内嵌 CID 图片解析、下载、25MB 上传支持。 |
| 安全防护 | Session 认证 HttpOnly + SameSiteStrict Cookie、登录速率限制与 IP 封禁、AES-256-GCM 静态加密、CSP 安全头、SSRF 防护、CORS 限制。 |

## Configuration / 配置

All configuration is via environment variables in `.env`:

所有配置通过 `.env` 环境变量设置：

| Variable / 变量 | Description / 说明 | Default / 默认值 |
|---|---|---|
| `ENCRYPTION_KEY` | AES-256 key for encrypting passwords at rest / 静态加密密钥 | Auto-generated / 自动生成 |
| `SERVER_PORT` | HTTP listen port / HTTP 监听端口 | `8080` |
| `TRUSTED_PROXIES` | Additional trusted reverse proxy IPs/CIDRs, comma-separated / 额外可信反代 IP 或 CIDR | Loopback only / 仅回环地址 |
| `MYSQL_HOST` | MySQL host / MySQL 主机 | `mysql` |
| `MYSQL_PORT` | MySQL port / MySQL 端口 | `3306` |
| `MYSQL_USER` | MySQL user / MySQL 用户 | `mailgo` |
| `MYSQL_PASSWORD` | MySQL password / MySQL 密码 | — |
| `MYSQL_DATABASE` | MySQL database / MySQL 数据库 | `mailgo` |
| `MYSQL_ROOT_PASSWORD` | MySQL root password / MySQL root 密码 | — |
| `REDIS_HOST` | Redis host / Redis 主机 | `redis` |
| `REDIS_PORT` | Redis port / Redis 端口 | `6379` |

## Password Management / 密码管理

```bash
# First install — auto-generated, printed to stdout
# 首次安装 — 自动生成并打印到控制台
docker logs mailgo | grep Password

# Reset password / 重置密码
docker exec mailgo /app/mailgo -reset-password

# Change password (logged in) / 修改密码（已登录状态）
# Settings > Security > Change Password
# 设置 > 安全 > 修改密码
```

## Docker Compose

The default `docker-compose.yml` pulls the pre-built image from GHCR. MySQL and Redis are connected via an internal Docker network (no host port exposure).

默认 `docker-compose.yml` 从 GHCR 拉取预构建镜像。MySQL 和 Redis 通过 Docker 内部网络连接（不暴露端口到宿主机）。

```bash
# Start / 启动
docker compose up -d

# Stop / 停止
docker compose down

# Logs / 查看日志
docker compose logs -f mailgo

# Update / 更新
docker compose pull && docker compose up -d
```

To build from source (for development), use `docker-compose.dev.yml`:

如需从源码构建（开发用途），使用 `docker-compose.dev.yml`：

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

## Direct IP and reverse proxy / 公网 IP 与反向代理

A domain is not required. Direct access works at
`http://PUBLIC_IP:8080`. The frontend uses same-origin relative API paths, so
the same build also works behind Nginx or Caddy.

不强制绑定域名，可直接访问 `http://公网IP:8080`。前端 API 使用同源相对路径，
因此同一个构建也可用于 Nginx 或 Caddy 反代。

Example same-host Nginx configuration (works with an IP or a domain):

```nginx
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Loopback proxies are trusted automatically. If the reverse proxy connects
from another container or machine, set `TRUSTED_PROXIES` to its IP or CIDR,
for example `TRUSTED_PROXIES=172.18.0.0/16`.

## Technology Stack / 技术栈

- Backend: Go 1.24, gorilla/mux, go-imap, go-message, AES-256-GCM, go-redis
- Frontend: React 19, TypeScript 5, Vite 6, Tailwind CSS 4, openpgp, lucide-react, PDF.js
- Database: MySQL 8.0, Redis 7
- Deployment: Docker, Docker Compose, GitHub Actions

## Architecture / 架构

```
┌──────────────────────────────────────────┐
│   Browser  (React + TypeScript + Vite)   │
└─────────────────┬────────────────────────┘
                  │ HTTP
┌─────────────────┴────────────────────────┐
│   Go Single Binary  (gorilla/mux)        │
│   ├── REST API        /api/v1/*          │
│   ├── IMAP Sync       go-imap            │
│   ├── SMTP Send       net/smtp           │
│   ├── AI Proxy        OpenAI-compatible  │
│   └── Static Serving  //go:embed         │
├────────────┬────────────┬────────────────┤
│   MySQL    │   Redis    │  IMAP / SMTP   │
│   (data)   │  (cache)   │  (mail servers)│
└────────────┴────────────┴────────────────┘
```

## License / 开源许可

[Apache License 2.0](LICENSE)

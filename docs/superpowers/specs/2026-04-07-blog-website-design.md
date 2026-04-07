# 个人博客网站设计文档

## 概述

基于 Astro 框架 + AstroWind 主题构建个人博客网站，全 Docker 化部署在腾讯云 CentOS 服务器上。支持暗色/亮色切换，集成 Waline 评论系统，通过 GitHub Actions 实现自动化部署。后续可扩展为完整个人站。

## 核心决策

| 维度 | 选型 | 理由 |
|------|------|------|
| 框架 | Astro 5 + AstroWind | 博客 + Landing Page 多用途模板，后续可扩展为个人站 |
| 样式 | Tailwind CSS（AstroWind 内置） | 定制灵活，暗色/亮色切换开箱即用 |
| 评论 | Waline（Docker + SQLite） | 支持匿名评论、管理后台、邮件通知，自部署 |
| 反代/静态服务 | Caddy（Docker） | 配置极简，自动 HTTPS |
| 编排 | Docker Compose | 服务器只需装 Docker，一键启动 |
| CI/CD | GitHub Actions → rsync | push 即部署 |
| 旧博客 | 导航栏链接跳转到原 GitHub Pages | 不做内容迁移 |

## 整体架构

```
┌─────────────┐     git push     ┌──────────────┐    SSH/rsync    ┌──────────────────────┐
│  本地开发     │  ──────────────▶ │ GitHub Actions │ ────────────▶  │   腾讯云 CentOS        │
│  Astro 项目   │                 │  构建静态文件   │                │                      │
│  Markdown 写作│                 └──────────────┘                │  Docker Compose       │
└─────────────┘                                                  │  ├── Caddy 容器       │
                                                                  │  │   ├── 静态文件服务   │
                                                                  │  │   └── 反代 Waline   │
                                                                  │  └── Waline 容器      │
                                                                  │      └── SQLite       │
                                                                  └──────────────────────┘
```

## 项目结构

```
blog/
├── src/
│   ├── content/
│   │   └── post/                  # Markdown 文章（扁平放置，frontmatter 分类）
│   ├── components/
│   │   └── WalineComment.astro    # Waline 评论组件
│   └── ...                        # AstroWind 其他源码
├── deploy/
│   ├── docker-compose.yml         # Caddy + Waline 编排
│   └── Caddyfile                  # Caddy 配置
├── .github/
│   └── workflows/
│       └── deploy.yml             # GitHub Actions CI/CD
├── astro.config.mjs
├── tailwind.config.mjs
├── package.json
└── README.md
```

## 文章组织

文章通过 Markdown frontmatter 定义元数据：

```markdown
---
title: "文章标题"
publishDate: 2026-04-07
category: "Kubernetes"
tags:
  - Kubernetes
  - client-go
excerpt: "文章摘要"
image: "~/assets/images/cover.jpg"
---
```

AstroWind 内置功能：
- **分类（Category）**：每篇文章一个分类，有独立分类列表页
- **标签（Tags）**：每篇文章可多个标签，有独立标签列表页
- **归档**：按时间排序的文章列表

## 服务器部署架构

### Docker Compose 编排

```
docker-compose.yml
├── Caddy 容器
│   ├── 监听 80 端口（绑域名后自动升级 443/HTTPS）
│   ├── / → 静态文件目录（挂载 /var/www/blog）
│   └── /waline → 反向代理到 Waline 容器 (waline:8360)
│
└── Waline 容器
    ├── 端口: 8360（仅内部访问）
    └── 数据: SQLite（挂载 /data/waline/data）
```

### Caddyfile 配置要点

- 默认使用 `:80`（IP 访问）
- 后续绑域名时修改为域名，Caddy 自动申请 HTTPS 证书
- `/waline` 路径反向代理到 Waline 容器

## Waline 评论系统

### 服务端
- Waline 官方 Docker 镜像
- SQLite 存储，数据挂载到宿主机 `/data/waline/data` 持久化
- 通过 Caddy 反向代理，路径为 `/waline`

### 客户端
- 创建 `WalineComment.astro` 组件，引入 `@waline/client`
- 在文章详情页模板底部引入该组件
- 自动适配暗色/亮色主题切换

### 功能
- 支持昵称 + 邮箱评论（无需登录）
- Markdown 渲染
- 评论管理后台（首次注册的用户为管理员）
- 可选开启邮件通知

## CI/CD 流程

### GitHub Actions 工作流

触发条件：`main` 分支 push

```
push to main
    ↓
checkout 代码
    ↓
安装 Node.js + pnpm
    ↓
pnpm install && pnpm build
    ↓
rsync dist/ → 服务器:/var/www/blog/
```

通过 GitHub Secrets 存储：
- `SERVER_HOST`：服务器 IP 地址
- `SERVER_SSH_KEY`：SSH 私钥
- `SERVER_USER`：SSH 用户名

### 服务器首次初始化（一次性操作）

1. 安装 Docker + Docker Compose
2. 创建目录：`/var/www/blog`（静态文件）、`/data/waline`（评论数据）
3. 上传 `docker-compose.yml` 和 `Caddyfile` 到服务器
4. `docker-compose up -d` 启动 Caddy + Waline
5. 配置 GitHub Secrets（SSH 私钥、服务器 IP、用户名）

## 主题定制

基于 AstroWind 需要定制的部分：

| 定制项 | 说明 |
|--------|------|
| Waline 评论组件 | 文章详情页底部集成 Waline 客户端 |
| 旧博客入口 | 导航栏添加「旧博客」链接，跳转到原 GitHub Pages |
| 个人信息 | 头像、昵称、简介、社交链接等配置 |
| 首页定制 | 调整 Landing Page 内容，展示个人介绍 + 最新文章 |
| 配色微调 | 在现有暗色/亮色基础上微调科技感配色 |

## 后续绑域名

1. DNS 解析指向服务器 IP
2. 修改 Caddyfile 中的地址为域名
3. `docker-compose restart` — Caddy 自动申请 HTTPS 证书
4. 更新 Astro 配置中的 site URL

## 旧博客处理

- 不做内容迁移
- 导航栏添加「旧博客」链接，跳转到 `https://mj-cjm.github.io`
- 原博客内容：10 篇 Kubernetes 源码解析系列文章（2020 年）

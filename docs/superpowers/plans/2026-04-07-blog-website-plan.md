# 个人博客网站实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 基于 AstroWind 主题构建个人博客网站，集成 Waline 评论系统，全 Docker 化部署到腾讯云 CentOS 服务器，通过 GitHub Actions 实现自动化部署。

**Architecture:** Astro 5 静态站点生成，Caddy 容器提供静态文件服务和 Waline 反向代理，Waline 容器提供评论服务（SQLite 存储），GitHub Actions 构建并通过 rsync 部署到服务器。

**Tech Stack:** Astro 5, AstroWind theme, Tailwind CSS v3, TypeScript, Waline, Caddy, Docker Compose, GitHub Actions

**Design Spec:** `docs/superpowers/specs/2026-04-07-blog-website-design.md`

---

## 文件结构

```
blog/
├── src/
│   ├── config.yaml                        # [修改] 站点配置（名称、URL、语言等）
│   ├── navigation.ts                      # [修改] 导航菜单（添加旧博客链接）
│   ├── components/
│   │   ├── CustomStyles.astro             # [修改] 科技感配色微调
│   │   └── blog/
│   │       └── WalineComment.astro        # [新建] Waline 评论组件
│   ├── data/
│   │   └── post/                          # [修改] 删除示例文章，添加自己的文章
│   ├── pages/
│   │   ├── index.astro                    # [修改] 首页定制
│   │   └── [...blog]/
│   │       └── index.astro                # [修改] 文章详情页集成评论组件
│   └── assets/
│       └── images/                        # [修改] 替换头像等图片
├── deploy/
│   ├── docker-compose.yml                 # [新建] Caddy + Waline 编排
│   └── Caddyfile                          # [新建] Caddy 路由配置
├── .github/
│   └── workflows/
│       └── deploy.yml                     # [新建] CI/CD 工作流
├── astro.config.ts                        # [可能修改] 站点 URL
├── package.json                           # [修改] 添加 @waline/client 依赖
└── README.md
```

---

## Task 1: 初始化 AstroWind 项目

**Files:**
- 整个项目根目录（从 AstroWind 模板初始化）

- [ ] **Step 1: 使用 AstroWind 模板初始化项目**

在 `/Users/chenjiamin/ai/blog` 目录下，将 AstroWind 模板代码拉入当前仓库。由于目录已有 git 仓库，先将模板代码下载到临时目录，再复制过来：

```bash
cd /Users/chenjiamin/ai/blog
# 下载 AstroWind 最新版
git clone --depth 1 https://github.com/onwidget/astrowind.git /tmp/astrowind-template
# 复制所有文件（排除 .git）到当前目录
rsync -av --exclude='.git' /tmp/astrowind-template/ .
# 清理临时目录
rm -rf /tmp/astrowind-template
```

- [ ] **Step 2: 安装依赖并验证项目能运行**

```bash
cd /Users/chenjiamin/ai/blog
npm install
npm run dev
```

在浏览器访问 `http://localhost:4321`，确认 AstroWind 默认页面正常显示。按 `Ctrl+C` 停止。

- [ ] **Step 3: 验证构建成功**

```bash
npm run build
```

预期输出：构建成功，`dist/` 目录生成静态文件。

- [ ] **Step 4: 提交初始代码**

```bash
git add -A
git commit -m "feat: initialize project with AstroWind template"
```

---

## Task 2: 配置站点基本信息

**Files:**
- Modify: `src/config.yaml`
- Modify: `src/components/CustomStyles.astro`

- [ ] **Step 1: 修改站点配置**

编辑 `src/config.yaml`：

```yaml
site:
  name: MJ-CJM Blog
  site: 'http://localhost'  # 后续替换为实际服务器 IP 或域名
  base: '/'
  trailingSlash: false

metadata:
  title:
    default: MJ-CJM Blog
    template: '%s — MJ-CJM Blog'
  description: '云计算、边缘计算、Kubernetes、Docker 技术博客'
  robots:
    index: true
    follow: true
  openGraph:
    site_name: MJ-CJM Blog
    type: website

i18n:
  language: zh-CN
  textDirection: ltr

apps:
  blog:
    isEnabled: true
    postsPerPage: 6
    post:
      isEnabled: true
      permalink: '/%slug%'
    list:
      pathname: 'blog'
    category:
      pathname: 'category'
    tag:
      pathname: 'tag'
    isRelatedPostsEnabled: true
    relatedPostsCount: 4

ui:
  theme: 'system'
```

- [ ] **Step 2: 验证配置生效**

```bash
npm run dev
```

浏览器访问 `http://localhost:4321`，确认站点标题已变为 "MJ-CJM Blog"。`Ctrl+C` 停止。

- [ ] **Step 3: 提交**

```bash
git add src/config.yaml
git commit -m "feat: configure site name, language, and metadata"
```

---

## Task 3: 配置导航栏（添加旧博客链接）

**Files:**
- Modify: `src/navigation.ts`

- [ ] **Step 1: 修改导航配置**

编辑 `src/navigation.ts`，修改 `headerData` 的 `links` 数组。保留博客相关导航，移除不需要的页面（Pricing、Services 等），添加旧博客跳转链接：

```typescript
export const headerData: HeaderData = {
  links: [
    {
      text: '博客',
      links: [
        { text: '全部文章', href: getBlogPermalink() },
        { text: '分类', href: getPermalink('category') },
        { text: '标签', href: getPermalink('tag') },
      ],
    },
    {
      text: '关于',
      href: getPermalink('/about'),
    },
    {
      text: '旧博客',
      href: 'https://mj-cjm.github.io',
      target: '_blank',
    },
  ],
  actions: [],
};
```

同时修改 `footerData` 中的 `socialLinks`（设置你的 GitHub 等社交链接）和 `footNote`（修改版权信息）。

- [ ] **Step 2: 验证导航栏**

```bash
npm run dev
```

浏览器确认：
1. 导航栏显示「博客」（带下拉菜单）、「关于」、「旧博客」
2. 点击「旧博客」在新标签页打开 `https://mj-cjm.github.io`
3. 「博客」下拉菜单包含「全部文章」「分类」「标签」

`Ctrl+C` 停止。

- [ ] **Step 3: 提交**

```bash
git add src/navigation.ts
git commit -m "feat: customize navigation with blog menu and old blog link"
```

---

## Task 4: 定制首页

**Files:**
- Modify: `src/pages/index.astro`

- [ ] **Step 1: 简化首页**

编辑 `src/pages/index.astro`，移除不需要的商业组件（Pricing、Testimonials、Brands、CallToAction 等），保留并定制：

```astro
---
import Layout from '~/layouts/PageLayout.astro';
import Hero from '~/components/widgets/Hero.astro';
import BlogLatestPosts from '~/components/widgets/BlogLatestPosts.astro';

const metadata = {
  title: 'MJ-CJM Blog — 云计算与边缘计算技术博客',
};
---

<Layout metadata={metadata}>
  <Hero
    tagline="技术博客"
    title="MJ-CJM"
    subtitle="云计算 | 边缘计算 | Kubernetes | Docker"
    actions={[
      { variant: 'primary', text: '浏览文章', href: '/blog' },
    ]}
  />

  <BlogLatestPosts
    title="最新文章"
    information="分享云计算、容器编排、边缘计算等领域的技术实践与源码分析。"
  />
</Layout>
```

- [ ] **Step 2: 验证首页**

```bash
npm run dev
```

浏览器确认首页只显示 Hero 区域 + 最新文章列表，无多余商业组件。`Ctrl+C` 停止。

- [ ] **Step 3: 提交**

```bash
git add src/pages/index.astro
git commit -m "feat: simplify homepage with hero and latest posts"
```

---

## Task 5: 清理不需要的页面

**Files:**
- Delete: `src/pages/pricing.astro`
- Delete: `src/pages/services.astro`
- Delete: `src/pages/contact.astro`
- Delete: `src/pages/homes/` (整个目录)
- Delete: `src/pages/landing/` (整个目录)
- Modify: `src/pages/about.astro`

- [ ] **Step 1: 删除不需要的页面**

```bash
cd /Users/chenjiamin/ai/blog
rm -f src/pages/pricing.astro src/pages/services.astro src/pages/contact.astro
rm -rf src/pages/homes src/pages/landing
```

- [ ] **Step 2: 简化关于页面**

编辑 `src/pages/about.astro`，改为简洁的个人介绍页面：

```astro
---
import Layout from '~/layouts/PageLayout.astro';
import HeroText from '~/components/widgets/HeroText.astro';
import Content from '~/components/widgets/Content.astro';

const metadata = {
  title: '关于',
};
---

<Layout metadata={metadata}>
  <HeroText tagline="关于我" title="MJ-CJM" />

  <Content
    items={[
      { title: '背景', description: '南京邮电大学，研究方向为边缘计算与云计算。' },
      { title: '技术栈', description: 'Kubernetes、Docker、Go、云原生技术栈。' },
      { title: '座右铭', description: 'Just do it.' },
    ]}
  >
    <Fragment slot="bg">
      <div class="absolute inset-0 bg-blue-50 dark:bg-transparent"></div>
    </Fragment>
  </Content>
</Layout>
```

- [ ] **Step 3: 验证构建无断链**

```bash
npm run build
```

预期：构建成功，无 404 或断链警告。

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "feat: remove unused pages and simplify about page"
```

---

## Task 6: 清理示例文章并创建测试文章

**Files:**
- Delete: `src/data/post/*.md`, `src/data/post/*.mdx` (所有示例文章)
- Create: `src/data/post/hello-world.md`

- [ ] **Step 1: 删除示例文章**

```bash
rm -f src/data/post/*.md src/data/post/*.mdx
```

- [ ] **Step 2: 创建测试文章**

创建 `src/data/post/hello-world.md`：

```markdown
---
publishDate: 2026-04-07T00:00:00Z
title: '你好，新博客'
excerpt: '博客迁移完成，这是新博客的第一篇文章。'
category: '杂谈'
tags:
  - 博客
---

## 新的开始

这是基于 Astro + AstroWind 构建的新博客。

旧博客的文章可以在 [这里](https://mj-cjm.github.io) 查看，包含 Kubernetes 源码解析系列。

## 技术栈

- **框架**：Astro 5 + AstroWind 主题
- **评论**：Waline
- **部署**：Caddy + Docker Compose + GitHub Actions

```

- [ ] **Step 3: 验证文章渲染**

```bash
npm run dev
```

浏览器访问 `http://localhost:4321/blog`，确认文章列表显示测试文章。点击进入文章详情页，确认内容正确渲染。`Ctrl+C` 停止。

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "feat: replace sample posts with initial test post"
```

---

## Task 7: 集成 Waline 评论组件

**Files:**
- Modify: `package.json` (添加 @waline/client 依赖)
- Create: `src/components/blog/WalineComment.astro`
- Modify: `src/pages/[...blog]/index.astro`

- [ ] **Step 1: 安装 Waline 客户端**

```bash
cd /Users/chenjiamin/ai/blog
npm install @waline/client
```

- [ ] **Step 2: 创建 Waline 评论组件**

创建 `src/components/blog/WalineComment.astro`：

```astro
---
export interface Props {
  serverURL: string;
}

const { serverURL } = Astro.props;
---

<div id="waline-comment" class="mx-auto max-w-3xl px-4 py-8"></div>

<link rel="stylesheet" href="https://unpkg.com/@waline/client@v3/dist/waline.css" />

<script define:vars={{ serverURL }}>
  async function initWaline() {
    const { init } = await import('https://unpkg.com/@waline/client@v3/dist/waline.js');

    init({
      el: '#waline-comment',
      serverURL: serverURL,
      dark: 'html.dark',
      emoji: ['https://unpkg.com/@waline/emojis@1.2.0/tw-emoji'],
      locale: {
        placeholder: '欢迎留言讨论...',
      },
    });
  }

  // 支持 Astro View Transitions
  initWaline();
  document.addEventListener('astro:after-swap', initWaline);
</script>
```

关键点：
- `dark: 'html.dark'` 让 Waline 自动跟随 AstroWind 的暗色模式（AstroWind 在 `<html>` 上添加 `dark` class）
- `serverURL` 通过 props 传入，后续部署时指向 `http://<服务器IP>/waline`
- 监听 `astro:after-swap` 支持 View Transitions 页面切换后重新初始化

- [ ] **Step 3: 在文章详情页集成评论组件**

编辑 `src/pages/[...blog]/index.astro`，在 `<ToBlogLink />` 之前添加评论组件：

找到以下代码区域：
```astro
  </SinglePost>
  <ToBlogLink />
```

修改为：
```astro
  </SinglePost>

  <WalineComment serverURL="/waline" />

  <ToBlogLink />
```

同时在文件顶部的 import 区域添加：
```astro
import WalineComment from '~/components/blog/WalineComment.astro';
```

- [ ] **Step 4: 验证评论组件渲染**

```bash
npm run dev
```

浏览器访问测试文章详情页，确认文章底部出现 Waline 评论区域的容器（此时 Waline 服务端未启动，评论框会显示加载状态或连接错误，这是正常的——我们只需确认组件已渲染到页面上）。`Ctrl+C` 停止。

- [ ] **Step 5: 验证构建成功**

```bash
npm run build
```

预期：构建成功，无错误。

- [ ] **Step 6: 提交**

```bash
git add package.json package-lock.json src/components/blog/WalineComment.astro src/pages/\[...blog\]/index.astro
git commit -m "feat: integrate Waline comment component into blog posts"
```

---

## Task 8: 创建 Docker Compose 部署配置

**Files:**
- Create: `deploy/docker-compose.yml`
- Create: `deploy/Caddyfile`

- [ ] **Step 1: 创建 Caddyfile**

创建 `deploy/Caddyfile`：

```caddyfile
:80 {
    root * /var/www/blog
    file_server

    handle_path /waline/* {
        reverse_proxy waline:8360
    }

    handle /waline {
        reverse_proxy waline:8360
    }

    # 静态资源长期缓存
    @assets path /_astro/*
    header @assets Cache-Control "public, max-age=31536000, immutable"

    # SPA fallback
    try_files {path} {path}/ /index.html
}
```

- [ ] **Step 2: 创建 docker-compose.yml**

创建 `deploy/docker-compose.yml`：

```yaml
version: '3.8'

services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - /var/www/blog:/var/www/blog:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - waline

  waline:
    image: lizheming/waline:latest
    restart: unless-stopped
    volumes:
      - /data/waline:/app/data
    environment:
      - TZ=Asia/Shanghai

volumes:
  caddy_data:
  caddy_config:
```

关键点：
- Caddy 挂载 `/var/www/blog` 为只读（`:ro`），静态文件由 CI/CD rsync 更新
- Waline 使用 SQLite（默认），数据存储在宿主机 `/data/waline`
- Caddy 的 `caddy_data` volume 用于存储 HTTPS 证书（绑域名后自动申请）
- Waline 不暴露端口到宿主机，仅通过 Caddy 反向代理访问

- [ ] **Step 3: 验证配置文件语法**

检查 YAML 语法：

```bash
cd /Users/chenjiamin/ai/blog
python3 -c "import yaml; yaml.safe_load(open('deploy/docker-compose.yml'))" && echo "YAML valid"
```

预期输出：`YAML valid`

- [ ] **Step 4: 提交**

```bash
git add deploy/
git commit -m "feat: add Docker Compose deployment config with Caddy and Waline"
```

---

## Task 9: 创建 GitHub Actions CI/CD 工作流

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: 创建 CI/CD 工作流**

创建 `.github/workflows/deploy.yml`：

```yaml
name: Deploy Blog

on:
  push:
    branches: [main]

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: npm run build

      - name: Deploy to server
        uses: easingthemes/ssh-deploy@v5
        with:
          SSH_PRIVATE_KEY: ${{ secrets.SERVER_SSH_KEY }}
          REMOTE_HOST: ${{ secrets.SERVER_HOST }}
          REMOTE_USER: ${{ secrets.SERVER_USER }}
          SOURCE: dist/
          TARGET: /var/www/blog/
          ARGS: -avz --delete
```

关键点：
- 仅 `main` 分支 push 触发
- 使用 `ssh-deploy` action（基于 rsync）部署静态文件
- `--delete` 确保删除服务器上不再存在的旧文件
- 需要在 GitHub 仓库 Settings → Secrets 中配置三个 secret

- [ ] **Step 2: 提交**

```bash
git add .github/workflows/deploy.yml
git commit -m "feat: add GitHub Actions CI/CD workflow for auto deployment"
```

---

## Task 10: 服务器初始化

**Files:**
- 无文件变更，纯服务器操作

- [ ] **Step 1: 安装 Docker 和 Docker Compose**

SSH 登录腾讯云服务器，执行：

```bash
# 安装 Docker
curl -fsSL https://get.docker.com | sh
systemctl enable docker
systemctl start docker

# 验证
docker --version
docker compose version
```

预期：Docker 和 Docker Compose 版本信息正常输出。

- [ ] **Step 2: 创建目录结构**

```bash
mkdir -p /var/www/blog
mkdir -p /data/waline
mkdir -p /opt/blog-deploy
```

- [ ] **Step 3: 上传部署配置文件**

从本地上传 `deploy/` 目录到服务器：

```bash
# 在本地执行（替换 <SERVER_IP> 和 <USER>）
scp deploy/docker-compose.yml deploy/Caddyfile <USER>@<SERVER_IP>:/opt/blog-deploy/
```

- [ ] **Step 4: 启动服务**

在服务器上执行：

```bash
cd /opt/blog-deploy
docker compose up -d
```

预期：两个容器（caddy、waline）正常启动。

```bash
docker compose ps
```

预期输出：两个服务状态为 `running`。

- [ ] **Step 5: 验证 Waline 服务**

```bash
curl http://localhost/waline
```

预期：返回 Waline API 响应（JSON 格式）。

- [ ] **Step 6: 配置 GitHub Secrets**

在 GitHub 仓库页面 → Settings → Secrets and variables → Actions，添加：

| Secret 名称 | 值 |
|-------------|-----|
| `SERVER_HOST` | 服务器公网 IP |
| `SERVER_SSH_KEY` | SSH 私钥内容（用于 rsync 部署） |
| `SERVER_USER` | SSH 登录用户名 |

---

## Task 11: 端到端验证

**Files:**
- 无文件变更

- [ ] **Step 1: 推送代码触发自动部署**

```bash
cd /Users/chenjiamin/ai/blog
git push origin main
```

- [ ] **Step 2: 检查 GitHub Actions 运行状态**

在 GitHub 仓库 → Actions 页面，确认 workflow 运行成功（绿色勾）。

- [ ] **Step 3: 验证网站可访问**

浏览器访问 `http://<服务器IP>`：
1. 首页正常显示 Hero 区域 + 最新文章
2. 导航栏显示「博客」「关于」「旧博客」
3. 暗色/亮色切换正常
4. 点击文章进入详情页
5. 文章底部显示 Waline 评论区
6. 尝试发表一条测试评论

- [ ] **Step 4: 验证 Waline 管理后台**

浏览器访问 `http://<服务器IP>/waline/ui`，注册管理员账号（第一个注册的用户自动成为管理员）。

---

## Task 12: 科技感配色微调

**Files:**
- Modify: `src/components/CustomStyles.astro`

- [ ] **Step 1: 调整配色方案**

编辑 `src/components/CustomStyles.astro`，修改 CSS 变量：

```astro
<style is:global>
  :root {
    --aw-color-primary: 59 130 246;        /* 科技蓝 blue-500 */
    --aw-color-secondary: 139 92 246;      /* 紫色点缀 violet-500 */
    --aw-color-accent: 6 182 212;          /* 青色高亮 cyan-500 */

    --aw-color-text-default: 15 23 42;     /* slate-900 */
    --aw-color-text-muted: 100 116 139;    /* slate-500 */
    --aw-color-bg-page: 248 250 252;       /* slate-50 */

    --aw-font-sans: 'Inter Variable', ui-sans-serif, system-ui, sans-serif;
    --aw-font-serif: ui-serif, Georgia, serif;
    --aw-font-heading: 'Inter Variable', ui-sans-serif, system-ui, sans-serif;
  }

  .dark {
    --aw-color-text-default: 226 232 240;  /* slate-200 */
    --aw-color-text-muted: 148 163 184;    /* slate-400 */
    --aw-color-bg-page: 2 6 23;            /* 深蓝黑 */
  }
</style>
```

关键变化：
- 主色调使用科技蓝，搭配紫色和青色点缀
- 暗色模式使用深蓝黑背景（而非纯黑），增强科技感
- 使用 Inter 字体，清晰现代

- [ ] **Step 2: 验证配色效果**

```bash
npm run dev
```

浏览器中分别切换亮色和暗色模式，确认配色协调。`Ctrl+C` 停止。

- [ ] **Step 3: 构建验证**

```bash
npm run build
```

预期：构建成功。

- [ ] **Step 4: 提交并推送部署**

```bash
git add src/components/CustomStyles.astro
git commit -m "feat: adjust color scheme for tech-style appearance"
git push origin main
```

GitHub Actions 自动部署，几分钟后线上生效。

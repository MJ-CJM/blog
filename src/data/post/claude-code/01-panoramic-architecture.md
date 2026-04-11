---
publishDate: 2026-04-07T01:00:00Z
title: '01 | 逆向一个顶级 Agent：Claude Code 的全景架构'
excerpt: '以 v2.1.88 恢复源码快照为主样本，拆解 Claude Code 的技术栈、五层架构与核心对话循环。'
image: 'https://images.unsplash.com/photo-1555949963-aa79dcee981c?w=1200&h=630&fit=crop'
category: 'Claude Code 源码解析'
tags:
  - Claude Code
  - AI Agent
  - 架构设计
  - 源码分析
---


> 以 `v2.1.88` 恢复源码快照为主样本，并参照官方公开文档与仓库，拆解 Claude Code 这类顶级 AI 编程 Agent 的内部设计。

---

## 为什么还要读源码

Claude Code 是 Anthropic 官方出品的 AI 编程 Agent。官方文档已经公开了它的产品边界和核心概念，官方 GitHub 仓库也已经可见；但这些公开资料更多回答的是“它能做什么”，很少展开“运行时到底怎么组织起来”。如果你想理解它为什么在长会话、多工具、多 Agent 场景下仍然稳定，还是得回到源码。

本文主要分析的是一个**版本固定**的实现样本：从 npm 包 source map 恢复出的 `v2.1.88` 源码快照。还原过程分三步：第一步，从 npm 包中提取 source map 文件；第二步，用工具将 source map 映射回原始 TS 源文件；第三步，补全 `tsconfig.json`、`package.json` 等构建配置，使项目可以编译和运行。最终我们得到了一个完整的可运行快照：

- **1989 个 TS/TSX 源文件**
- **约 51 万行代码**
- 可通过 `bun run dev` 直接启动运行

这棵恢复源码树之后还继续演化过，所以你在当前仓库里看到的文件数和路径会与 `v2.1.88` 快照略有差异。本文遵循一个原则：**产品口径以官方公开资料校准，实现锚点以当前仓库能验证的路径为准**。

本系列的目标不是教你“复制一个 Claude Code”——鉴权、账户体系、服务端路由都不是这类文章能复刻的。我们真正要做的是从一个成熟 Agent 产品中提炼可迁移的架构模式和设计决策。如果你正在构建自己的 Agent 项目，这里有大量值得借鉴的工程实践——从分层架构、核心循环设计到工具权限治理，每一个模块都经过了真实生产环境的打磨。

## 技术栈速览

在深入架构之前，先看看 Claude Code 的技术选型：

| 技术 | 职责 |
|------|------|
| **TypeScript** | 全量业务逻辑、类型系统、模块间协议 |
| **React + Ink** | 终端 UI 渲染（组件化 TUI，不是噱头——后面会解释） |
| **Bun** (>=1.3.5) | 运行时 + 打包器，Feature Flag 内联消除 |
| **Rust** (napi-rs) | 图像处理、音频采集、颜色差分、系统修饰键 |
| **Swift** (macOS only) | computer-use 截图、鼠标/键盘注入 |
| **@anthropic-ai/sdk** | Claude API 通信（HTTP/SSE 流式） |
| **@modelcontextprotocol/sdk** | MCP 协议，连接外部工具服务器 |
| **OpenTelemetry** | 指标采集、链路追踪、日志上报 |

这里最反直觉的选择是 **用 React 做终端 UI**。React + Ink 不是为了花哨，而是因为 Agent 的终端界面涉及大量异步状态管理：消息流实时渲染、权限审批弹窗、子 Agent 任务视图、MCP 连接状态——这些用传统的 `console.log` 或者 blessed 库根本维护不了。React 的组件化模型和状态管理在这里是真正的生产力选择。

> **Spotlight：终端 UI 不是 console.log**
> 
> Claude Code 使用了自定义 Ink fork，实现了游戏引擎级的终端渲染架构（`src/ink/screen.ts`，49KB）：
> 
> - **双缓冲屏幕网格**：前缓冲（front buffer）用于显示，后缓冲（back buffer）用于渲染。渲染完成后交换，避免屏幕撕裂和闪烁
> - **CharPool 字符串 interning**：字符存储为整数 ID，相同字符共享同一 ID。比较和 blitting 操作走整数路径，零拷贝
> - **基于 diff 的 ANSI 输出**：只输出两帧之间的差异，而非全量重绘
> 
> 为什么 Agent 的终端 UI 需要这么重的基础设施？因为它不是简单的文本流——异步状态管理（消息流、权限对话框、子代理任务视图、进度指示器）需要一个真正的渲染引擎来保证一致性和流畅性。

Rust 和 Swift 则负责 TypeScript 无法高效完成的系统级工作：图像缩放和格式转换（Rust napi-rs 编译为 `.node` 二进制）、macOS 上的截图和输入注入（Swift 通过子进程 IPC 通信）。TypeScript wrapper 层（`src/native-ts/`）对上层屏蔽了所有二进制细节。

## 五层架构全景

先说明一点：**“五层架构”是我根据源码归纳出来的阅读视角，不是官方命名。** 它的价值在于把一个巨大的代码库压缩成一个容易记忆的认知骨架。

```
┌─────────────────────────────────────────────────┐
│  入口层：引导与分发                                │
│  bootstrap-entry.ts → cli.tsx → main → init      │
├─────────────────────────────────────────────────┤
│  核心循环层：AsyncGenerator 驱动的请求引擎         │
│  query.ts — 唯一的请求执行路径                     │
├─────────────────────────────────────────────────┤
│  Tool / Agent 层：统一工具池 + 权限管线            │
│  tools.ts — base tools、MCP 工具、权限拦截         │
├─────────────────────────────────────────────────┤
│  服务层：API Client、MCP、Compact、Analytics      │
│  services/ — 独立功能模块                          │
├─────────────────────────────────────────────────┤
│  原生桥接层：Rust N-API + Swift 进程桥接           │
│  shims/ + native-ts/ — 系统级原生能力              │
└─────────────────────────────────────────────────┘
```

**入口层**负责引导与分发，不含任何业务逻辑。`bootstrap-entry.ts` 整个文件只有两行——调用 `ensureBootstrapMacro()` 设置全局宏后，动态导入 `src/entrypoints/cli.tsx`。CLI 层用一系列 fast-path 处理 `--version`、bridge、daemon、background session 等轻量或专用路径；只有进入完整 CLI 时，才会导入 `src/main.tsx`。而 `init()` 并不是单独的第二入口，它是在 `main.tsx` 的 `preAction` hook 里统一执行的。这个”尽量晚 import、尽量晚初始化”的启动设计，直接决定了 Claude Code 的冷启动速度。

> **Spotlight：启动优化 — TCP/TLS 预连接**
> 
> 入口层的”尽量晚初始化”策略还有一个精巧的配合：在 `init.ts` 中调用 `preconnectAnthropicApi()`，在启动工作进行的同时并行完成 TCP+TLS 握手。
> 
> 设计要点（`src/utils/apiPreconnect.ts`）：
> - **Fire-and-forget HEAD 请求**：发送一个无 body 的 HEAD 请求，connection 在 headers 到达后立即进入 keep-alive 池
> - **Bun 的全局连接池复用**：Bun 的 `fetch` 共享全局 keep-alive 连接池，后续真正的 API 请求直接复用已预热的连接
> - **节省 ~100-200ms**：TCP+TLS 握手通常阻塞在第一次 API 调用中，预连接让它与其他初始化工作重叠执行
> - **智能跳过**：proxy/mTLS/Unix Socket 配置时跳过（SDK 用独立 dispatcher，不共享全局池）；Bedrock/Vertex/Foundry 时跳过（不同的 endpoint 和认证）
> 
> 这个模式的设计课：**不是所有预连接都有意义——当连接池不会被后续请求复用时，预连接反而浪费资源。** 源码中 7 个显式跳过条件就是这一原则的体现。

**核心循环层**是系统的心脏。`src/query.ts` 中的 `query()` 是一个 `async function*`（AsyncGenerator），所有用户请求——无论来自 REPL 交互还是 SDK API 调用——都经过这一个执行引擎。它驱动消息流转、API 调用、工具执行和上下文压缩的完整循环。

**Tool / Agent 层**是模型与外部世界的唯一接口。`src/tools.ts` 的 `getAllBaseTools()` 聚合了当前构建下可见的 base tools，再与 MCP 协议接入的外部工具合并成统一工具池。这里不要把工具数量当常量：本地恢复仓库在默认环境下返回的是 24 个 base tools，而 feature flags、`USER_TYPE`、Worktree/TodoV2、MCP 连接等条件都会继续扩展可见能力。每次工具调用前都要经过权限系统（`src/utils/permissions/`）的拦截检查。`AgentTool` 则负责把多 Agent 编排也纳入同一运行时。

**服务层**提供独立的功能模块，每个模块各司其职：API Client 支持 Anthropic 直连、AWS Bedrock、GCP Vertex 三种路由，内置流式重试和用量统计；MCP Client 通过 `MCPConnectionManager` 管理多服务器并发连接，支持 stdio、SSE、WebSocket 等多种传输协议；Compact 服务提供五种上下文压缩策略（auto、reactive、snip、micro、sessionMemory），在对话历史膨胀时自动触发压缩，保证上下文窗口不溢出；Analytics 基于 OpenTelemetry 做全链路埋点上报。

**原生桥接层**通过 N-API（`.node` 二进制文件）和 Swift 子进程桥接系统级能力。Rust 编译产物位于 `shims/` 目录下，TypeScript wrapper 层（`src/native-ts/`）封装加载逻辑并暴露强类型 API，上层代码完全感知不到 N-API 的存在。

#### 横切关注点：Hook 系统

五层之外，还有一个贯穿所有层的横切关注点——**Hook 系统**（`src/utils/hooks.ts`，159KB，5,000+ 行）。它定义了 28 个生命周期事件：

- **工具层**：`PreToolUse`（拦截/修改工具调用）、`PostToolUse`（响应工具结果）、`PostToolUseFailure`
- **会话层**：`SessionStart`、`SessionEnd`、`Stop`
- **代理层**：`SubagentStart`、`SubagentStop`
- **上下文层**：`PreCompact`、`PostCompact`、`InstructionsLoaded`
- **文件层**：`FileChanged`、`CwdChanged`、`WorktreeCreate`、`WorktreeRemove`
- **权限层**：`PermissionRequest`、`PermissionDenied`
- **其他**：`Notification`、`UserPromptSubmit`、`Setup`、`ConfigChange` 等

用户可在 `settings.json` 中为任意事件绑定 shell 命令。Hook 可返回 JSON 控制流程：`continue: false` 中止执行、`decision: 'approve'/'block'` 覆盖权限决策、`updatedInput` 修改工具输入。这使得 Claude Code 的行为可以在不修改核心代码的前提下被外部编排——从自定义审计日志到企业级工作流集成。

> Hook 系统的完整讨论超出本文范围，但其架构意义值得在全景图中标注：它是让 Claude Code 从"开发者工具"升级为"可编程平台"的关键基础设施。

## 一个请求的完整生命周期

理解五层架构后，我们用 30 秒走一遍一个请求从输入到响应的全链路：

```
用户在终端输入 "帮我重构这个函数"
        ↓
  PromptInput 组件捕获输入
        ↓
  消息入队 → messageQueueManager（优先级队列）
        ↓
  useQueueProcessor 检测到队列非空，触发执行
        ↓
  buildEffectiveSystemPrompt 组装系统提示
        ↓
  query() AsyncGenerator 启动
        ↓
  ┌── Claude API 流式调用 ──────────────────┐
  │  SSE 流式返回 → 每个 token 立即 yield     │
  │  检测到 tool_use block →                  │
  │    StreamingToolExecutor 立即开始执行      │
  │    （不等待完整响应）                       │
  └──────────────────────────────────────────┘
        ↓
  工具结果作为 tool_result 消息回注
        ↓
  needsFollowUp = true → continue 循环
        ↓
  再次调用 Claude API（带上工具结果）
        ↓
  Claude 返回 end_turn → 循环终止
        ↓
  REPL 渲染最终回复
```

这里的关键洞察是：整个请求生命周期由一个 `while(true)` 循环驱动，工具调用只是循环的一次迭代，而不是单独的函数调用链。流式响应、多轮工具调用、上下文压缩、错误恢复——全部统一在 `query()` 这一个 AsyncGenerator 中处理。消费者（REPL 或 SDK）只需一个 `for await` 循环就能处理所有类型的事件，代码极其简洁。这个设计的深度和精妙之处——包括四阶段预处理管线、三级错误恢复级联、死循环防护机制——将是下一篇文章的核心内容。

> ### Spotlight: AsyncGenerator 驱动的核心对话循环
>
> 为什么 Claude Code 选择 `async function*` 而不是简单的 `while` 循环来驱动 Agent 循环？简单的 while 循环有两个致命问题：一是无法流式输出——循环内部的每个 token 无法逐个传递给外部消费者，必须等整轮完成才能返回；二是调用者无法控制消费节奏，也无法优雅地中断循环。AsyncGenerator 天然解决了这些问题：
>
> - **流式 yield**：每个 token 到达时立即 `yield` 给 UI，实现实时流式显示，无需等待完整响应
> - **调用者按需拉取**：消费者通过 `for await` 按自己的节奏消费事件，天然具备背压控制能力
> - **状态机嵌入迭代器协议**：循环状态封装在 `State` 对象中，每次 `continue` 附带 `transition.reason` 判别器，七种 continue 路径各有明确语义，可追踪、可测试
> - **优雅的异常恢复和终止**：调用者可随时调用 `.return()` 中断循环，`prompt_too_long` 等错误通过三级恢复级联（collapse → compact → surface）自动处理，而不是粗暴终止
>
> 另一种常见方案是 LangChain 等框架的递归调用：递归会消耗调用栈，长对话有 stack overflow 风险；状态散落在调用帧中，难以序列化和测试。Claude Code 的 AsyncGenerator 内部仍然使用 `while(true)` + `State` 对象驱动循环，但通过 Generator 协议将流式事件和生命周期控制暴露给外部，兼顾了循环的高效和接口的优雅。

> #### 真实函数签名
>
> `query()` 的完整签名位于 `src/query.ts:219-228`，它精确声明了 generator 可能 yield 的所有事件类型：
>
> ```typescript
> export async function* query(
>   params: QueryParams,
> ): AsyncGenerator<
>   | StreamEvent        // Token 流式事件
>   | RequestStartEvent  // API 请求开始
>   | Message           // 完整消息（assistant/user）
>   | TombstoneMessage  // 消息墓碑（压缩后的占位符）
>   | ToolUseSummaryMessage, // 工具调用摘要
>   Terminal            // 终止信号
> >
> ```
>
> 五种事件类型编码了对话循环中所有可能的产出——从单个 Token 到完整消息到压缩墓碑。调用方通过 `for await...of` 消费这个 generator，UI 层只需关心渲染每种事件类型，完全不需要理解循环内部的状态机。

> #### 循环的 17 种 transition reason
>
> 核心循环通过 `State.transition.reason` 判别器驱动下一步行为。17 种 reason 可以归为四类：
>
> | 类别 | reason 值 | 说明 |
> |------|----------|------|
> | **正常流转** | `next_turn`、`completed` | 标准对话推进 |
> | **错误恢复** | `model_error`、`image_error`、`prompt_too_long`、`aborted_streaming`、`aborted_tools` | API 或工具层错误，自动重试 |
> | **资源调整** | `max_output_tokens_escalate`、`max_output_tokens_recovery`、`token_budget_continuation`、`reactive_compact_retry`、`collapse_drain_retry` | Token 预算不足，动态扩容或压缩后重试 |
> | **外部干预** | `stop_hook_prevented`、`stop_hook_blocking`、`hook_stopped`、`max_turns`、`blocking_limit` | 用户中断、Hook 拦截、轮次上限 |
>
> 这个设计的关键洞察：**所有恢复路径都是 `continue`（重新进入循环），所有终止路径都是 `return`（退出循环）**。没有异常抛出、没有 goto、没有回调嵌套——状态机的全部复杂性被压缩到一个扁平的 switch-case 中。

---

## 模式提炼：Agent 分层架构的设计原则

从 Claude Code 的架构中，我们可以提炼出三条适用于任何 Agent 项目的设计原则。

### 原则 1：入口层不含业务逻辑

Claude Code 的 `bootstrap-entry.ts` 只有两行代码，`cli.tsx` 只做模式分发——判断当前是 REPL 交互、daemon、bridge 还是单次 CLI 命令，然后路由到对应路径。入口层绝不处理消息、不调用模型、不执行工具。

**通用模式**：Agent 的启动层只负责三件事——环境检测、配置加载、模式分发。不同运行模式应该有不同的启动成本，`--version` 不需要加载整个运行时。如果你的 Agent 项目把业务逻辑写在入口文件里，未来的每次启动优化都会变成噩梦。

### 原则 2：核心循环是唯一的请求驱动引擎

Claude Code 中所有请求——无论来自交互式 REPL、SDK API 调用还是子 Agent——都经过 `query()` 这一个 AsyncGenerator。没有"第二条路"。REPL 通过 `for await (const event of query(...))` 消费事件，SDK 的 `QueryEngine` 同样包装 `query()` 输出。

**通用模式**：CLI、REPL、API、子 Agent 都应该走同一个执行引擎。多条执行路径意味着多套行为差异、多处需要修 bug。单一引擎加上多种消费者适配，是可维护性远优于多引擎方案的架构选择。

### 原则 3：Tool 层是模型与外部世界的唯一接口

Claude Code 的内置 base tools、feature-gated tools 和 MCP 外部工具都走 `Tool` 接口，都经过同一套权限管线。模型能做的事恰好等于注册的工具集合，没有后门，没有“直接调函数”的捷径。工具不仅声明了能力，还声明了风险特征（`isConcurrencySafe`、读写属性、危险等级），权限系统据此做拦截决策。

**通用模式**：模型能做的事 = 注册的工具集合。工具不只是函数，还是"声明了风险特征的运行单元"。这个约束看似限制了灵活性，实则是 Agent 产品能在真实环境中长期使用的前提——没有治理的自动化不可能长期可用。

**对比参考**：从公开信息看，IDE 内嵌式产品更容易把能力直接挂在宿主编辑器 API 上，而不是先收敛成统一工具抽象；不少早期开源 Agent 框架也更偏“先把工具跑起来”，而不是先定义一套统一的权限和调度语义。Claude Code 选择了更重但更稳的统一抽象路线，代价是前期设计成本更高，收益是后续每个新能力都能自动接入权限、并发控制和监控体系。

---

## 跟跑验证：搭建环境，亲手验证架构

### 项目源码结构

在搭建环境之前，先对源码目录有个整体认知。以下是 `src/` 下的核心目录及其职责：

```
src/
├── entrypoints/     # 入口层：CLI、MCP Server、SDK 三种启动方式
├── tools/           # 工具层：56+ 个工具（文件操作、代码搜索、Agent 派发...）
├── services/        # 服务层：API 调用、消息压缩、MCP 集成、分析追踪
│   ├── compact/     #   压缩子系统（micro/snip/auto/reactive 四级）
│   ├── mcp/         #   MCP 客户端（25 个模块）
│   └── analytics/   #   分析与遥测
├── utils/           # 基础设施：权限管线、Token 管理、Shell 封装（330+ 文件）
├── bridge/          # Bridge 通信层：远程控制、WebSocket、Daemon（33 个模块）
├── buddy/           # Companion 宠物系统
├── coordinator/     # Coordinator 模式（多 Agent 编排）
└── constants/       # 常量定义：工具名、XML 标签、权限规则
```

每个目录严格对应五层架构中的一层——`entrypoints/` 是入口层，`tools/` 是工具层，`services/` 是服务层，`utils/` 是基础设施层。`bridge/` 和 `buddy/` 是独立的功能域，不归入五层但与服务层平级。`coordinator/` 则是多 Agent 编排的实现，属于工具层的上层扩展。

理解这个目录结构后，后续的验证实验中你就能快速定位到对应的源文件。

### 环境搭建

前置条件：

- Bun >= 1.3.5
- Node >= 24.0.0
- 如果只做静态跟读，不需要认证
- 如果要进入完整 REPL，再准备可用登录态或 Anthropic API Key

```bash
cd claude-code
bun install

# 先确认 CLI 能正常启动
bun run version

# 再进入完整交互式会话（需要认证）
export ANTHROPIC_API_KEY=sk-ant-xxxxx
bun run dev
```

如果一切顺利，`bun run version` 会先输出版本号；继续执行 `bun run dev` 后，你会看到 Claude Code 的交互式 REPL 界面在终端中启动，等待你的输入。如果遇到问题，常见的排查方向是 Bun 版本不够新、Node 版本低于 24、或者认证状态不可用。

### Docker 模式（推荐用于快速体验）

如果你不想在本机安装 Bun/Node 运行时，或者希望快速接入第三方模型提供商，可以使用仓库自带的 Docker 启动方式。整个 Docker 方案由三个关键文件组成：

- **`Dockerfile`**：基于 `oven/bun:1.3.5-debian` 镜像，采用分层构建策略——先安装依赖（利用 Docker 缓存加速重复构建），再复制源码。`ENTRYPOINT` 设置为 `bun run /app/src/bootstrap-entry.ts`，与本地开发走完全相同的启动链路。
- **`start.sh`**：自动构建镜像、管理容器生命周期。脚本内部处理了容器的三种状态（running → 直接 attach、exited → 重启后 attach、none → 首次创建），并支持 `--provider` 参数切换模型提供商。
- **`providers.conf`**：第三方模型提供商配置文件，每行定义一个 provider，格式为 `PROVIDER_BASE_URL`/`PROVIDER_API_KEY`/`PROVIDER_MODEL`/`PROVIDER_EXTRA`（`PROVIDER_EXTRA` 是逗号分隔的额外环境变量列表）。

**两种启动方式对比**：

| 方式 | 命令 | 优点 | 适用场景 |
|------|------|------|---------|
| 本地 | `bun run dev` | 热重载、可用 `bun --inspect` 调试 | 开发/跟读源码/打断点 |
| Docker | `./start.sh ~/project --provider minimax` | 环境隔离、开箱即用、支持第三方模型 | 快速体验/验证文章内容 |

**Docker 启动命令示例**：

```bash
# 使用 Anthropic 官方 API（需设置 ANTHROPIC_API_KEY）
./start.sh ~/my-project

# 使用第三方模型提供商（如 MiniMax、智谱 GLM）
./start.sh ~/my-project --provider minimax

# 每个 provider 有独立的配置目录 ~/.claude-code-docker-{provider}/
# 容器内 /workspace 映射到宿主机项目目录
```

> **注意**：`providers.conf` 中包含 API Key，不应提交到公开仓库。每个 provider 使用独立的 config 目录（`~/.claude-code-docker-{provider}/.claude/`），避免不同模型的认证信息互相覆盖。如果你只是验证本文内容，Docker 模式是最省心的选择——不需要关心运行时版本，也不会污染本机环境。

### 验证点 1：观察启动链路

在以下四个文件中添加 `console.log` 标记（或使用 `bun --inspect` + VS Code Bun 调试器设置断点）：

| 文件 | 添加位置 | 预期顺序 |
|------|----------|----------|
| `src/bootstrap-entry.ts` | 文件顶部 | 1 - 最先执行 |
| `src/entrypoints/cli.tsx` | `main()` 入口 | 2 - fast-path / full CLI 分发 |
| `src/main.tsx` | `run()` 内 `preAction` hook | 3 - Commander 装配并调用 `init()` |
| `src/entrypoints/init.ts` | `init()` 顶部 | 4 - 环境装配 |

启动后终端输出应按 1→2→3→4 的顺序出现。这验证了入口层的职责拆分：`bootstrap-entry.ts` 只负责引导，`cli.tsx` 只负责判路，`main.tsx` 负责 Commander 和运行时装配，`init.ts` 则集中处理环境初始化。

> **实际运行结果**
>
> ```
> [VERIFY-1] bootstrap-entry loaded
> [VERIFY-2] cli.tsx main()
> [VERIFY-3] main.tsx preAction
> [VERIFY-4] init() start
> ```
>
> 四行日志严格按 1→2→3→4 顺序出现，与架构图中的启动链路完全一致。

### 验证点 2：观察核心循环

在 `src/query.ts` 的 `query()` 函数中找到 `yield` 语句位置，设置断点或添加日志。然后：

**实验 A — 纯文本对话**：在 REPL 中输入 `hello`，观察 `yield` 被触发多次，每次产出一个 `StreamEvent`（text delta）。循环只执行一轮就因 `end_turn` 终止。

**实验 B — 触发工具调用**：输入一个需要工具的请求（例如"列出当前目录的文件"），观察循环执行两轮——第一轮 yield 出 `tool_use` block 和工具执行结果，第二轮 yield 出 Claude 基于工具结果生成的最终回复。`needsFollowUp` 变量在第一轮为 `true`（触发 `continue`），第二轮为 `false`（循环终止）。

这两个实验直接验证了核心循环层的工作方式：一个 `while(true)` + `async function*`，统一处理流式响应和多轮工具调用。

> **实际运行结果**
>
> 实验 A（输入 `hello`，纯文本）：
> ```
> [LOOP] round 1
> [LOOP-END] needsFollowUp = false
> ```
> 循环只执行 1 轮，`needsFollowUp` 始终为 `false`，模型返回纯文本后循环终止。
>
> 实验 B（输入 `list files in current directory`，触发工具调用）：
> ```
> [LOOP] round 1
> [FOLLOWUP] needsFollowUp = true, toolUseBlocks: 1
> [LOOP-END] needsFollowUp = true
> [LOOP] round 2
> [LOOP-END] needsFollowUp = false
> ```
> 循环执行 2 轮：第 1 轮检测到 1 个 `tool_use` block，`needsFollowUp = true` 触发 `continue`；第 2 轮模型基于工具结果生成最终回复，`needsFollowUp = false`，循环终止。

---

## 下一篇预告

本文建立了对 Claude Code 全景架构的理解：五层分层、单一请求引擎、统一工具接口。但在请求生命周期中，我们略过了两个最关键的环节——这套会随 feature flag、用户类型和 MCP 连接动态伸缩的工具池是怎么注册、调度和执行的？模型想执行 `rm -rf /` 的时候，谁来阻止它？

**下一篇，我们将深入 Claude Code 的工具引擎与权限管线**——看 `StreamingToolExecutor` 如何实现边收边执行的流式并发，看我归纳出的”八类权限裁决视图”如何帮助理解自动化与安全之间的平衡，并提炼出可迁移到你自己 Agent 项目的工具系统设计模式。

---

## 附录：验证代码插桩点

> 以下列出关键插桩位置供快速参考。每个插桩点提供精确的文件路径、行号和日志标签，可在本地或 Docker 环境中复现验证。

### 验证点 1：启动链路

| 插桩文件 | 位置 | 日志标签 | 观察内容 |
|---------|------|---------|---------|
| `src/bootstrap-entry.ts` | 文件顶部 | `[BOOT-1]` | 最早执行的代码，确认构建产物正确 |
| `src/entrypoints/cli.tsx` | 第 34 行 | `[BOOT-2]` | CLI 入口初始化 |
| `src/main.tsx` | 第 914 行 | `[BOOT-3]` | 主循环启动 |
| `src/entrypoints/init.ts` | 第 58 行 | `[BOOT-4]` | 初始化完成，REPL 就绪 |

### 验证点 2：核心循环

| 插桩文件 | 位置 | 日志标签 | 观察内容 |
|---------|------|---------|---------|
| `src/query.ts` | `queryLoop()` 循环入口 | `[LOOP]` | 每轮循环的 round 编号 |
| `src/query.ts` | `needsFollowUp` 判断处 | `[LOOP-END]` | 是否需要后续轮次 |
| `src/query.ts` | `transition.reason` 赋值处 | `[FOLLOWUP]` | 继续循环的具体原因 |

插桩模式（Docker 环境）：

```typescript
try { require('fs').appendFileSync('/workspace/verify.log', `[标签] 内容\n`); } catch {}
```

在 Docker 环境中，由于容器内的 `/workspace` 映射到宿主机项目目录，插桩日志会直接写入你本地的项目根目录下的 `verify.log` 文件，方便在宿主机上实时查看。本地开发环境可以直接使用 `console.log` 或 `bun --inspect` 断点调试，无需文件写入。

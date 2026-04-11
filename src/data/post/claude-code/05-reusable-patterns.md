---
publishDate: 2026-04-07T05:00:00Z
title: '05 | 从 Claude Code 到你的 Agent：12 个可复用架构模式'
excerpt: '四篇拆解收敛为 12 个可直接迁移的 Agent 架构模式，附决策框架和速查表。'
image: 'https://images.unsplash.com/photo-1509228468518-180dd4864904?w=1200&h=630&fit=crop'
category: 'Claude Code 源码解析'
tags:
  - Claude Code
  - AI Agent
  - 架构设计
  - 源码分析
---


> 四篇拆解，一份清单。把 Claude Code 的设计决策收敛为 12 个可直接迁移的 Agent 架构模式，附决策框架和速查表。

---

## 回顾：Claude Code 做对了什么

Claude Code 的强不在功能多，而在于把一个复杂 Agent 系统收敛成了一个有明确边界的运行时。很多 Agent 产品在单个维度上做得不错——工具多、模型强、界面花——但在生产环境中持续可用的极少。Claude Code 的核心竞争力在于四个“同时成立”：**启动快**（入口层零业务逻辑 + 按需加载）、**主循环稳**（AsyncGenerator 驱动的单一请求引擎）、**工具体系统一**（base tools、feature-gated tools、MCP 走同一抽象和权限管线）、**权限治理内建**（权限裁决嵌入执行主链路，非外围插件）。这四个维度只要缺一个，产品就会在某个场景下崩塌。

前四篇各聚焦了一个维度：

- **第一篇**：五层架构分离与 AsyncGenerator 驱动的核心对话循环——从入口引导到请求执行的完整链路
- **第二篇**：统一工具接口、流式重叠执行引擎与权限裁决主链路——让 LLM 既快速又安全地操作世界
- **第三篇**：五级渐进式上下文压缩与 Cache-Aware 的 Prompt 拓扑设计——在有限窗口中维持无限长会话
- **第四篇**：Coordinator/Worker 认知分工编排与 MCP/Plugin/Skill 三层可扩展架构——从单兵到军团的协作与扩展

本篇将这些设计决策提炼为 **12 个可复用的 Agent 架构模式**，附带决策框架和速查表，供你在自己的项目中直接使用。

---

## 12 个可复用 Agent 架构模式

### 模式 1：分层架构

**一句话定义：** 入口 / 循环 / 工具 / 服务 / 原生五层分离，每层只做自己该做的事。

**Claude Code 中的实现：** `bootstrap-entry.ts` 只有两行引导代码；`cli.tsx` 只做模式分发；`query.ts` 是唯一的请求引擎；`tools.ts` 聚合工具注册表；`services/` 提供独立功能模块；`shims/` + `native-ts/` 封装 Rust/Swift 原生能力。层间通过明确的接口通信，不跨层调用。

入口层有多"薄"？看 `bootstrap-entry.ts` 的全部代码（去掉验证插桩后）：

```typescript
// src/bootstrap-entry.ts — 整个入口层只有 3 行
import { ensureBootstrapMacro } from './bootstrapMacro'
ensureBootstrapMacro()
await import('./entrypoints/cli.tsx')
```

第一行确保编译宏就绪，第二行动态加载 CLI 入口——**入口层零业务逻辑**。这意味着 `--version` 这种轻量命令可以在 `cli.tsx` 的模式分发阶段直接返回，不需要加载 `query.ts`、`tools.ts` 等重量级模块。

**你的项目怎么用：** 最小可行做法——把启动代码、主循环、工具定义、外部服务调用分成四个独立模块。入口文件只负责环境检测和配置加载，不写任何业务逻辑。`--version` 这种轻量命令不应加载整个运行时。

**常见误区：** 把业务逻辑写在入口文件里——请求处理、工具注册、API 调用全在 `main.ts` 的一个函数中。短期能跑，但启动优化和模块测试都会变成噩梦。

### 模式 2：单一主循环

**一句话定义：** 所有请求——CLI、REPL、API、子 Agent——走同一个 AsyncGenerator 驱动的执行引擎，没有"第二条路"。

**Claude Code 中的实现：** `query()` 是一个 `async function*`，内部用 `while(true)` + `State` 对象驱动循环。流式 token 逐个 yield 给 UI；工具调用只是循环的一次迭代；错误恢复通过三级级联（collapse → compact → surface）自动处理。REPL 和 SDK 都通过 `for await` 消费同一个 Generator。

`query()` 的签名（`src/query.ts:219`）展示了 AsyncGenerator 如何统一所有事件类型：

```typescript
export async function* query(
  params: QueryParams,
): AsyncGenerator<
  | StreamEvent          // 流式 token
  | RequestStartEvent    // 请求开始
  | Message              // 完整消息
  | TombstoneMessage     // 压缩后的墓碑消息
  | ToolUseSummaryMessage, // 工具摘要
  Terminal               // 返回值：终止状态
> { ... }
```

传统 Agent 框架的 `while` 循环需要在循环体内手动管理所有状态转换和事件分发；AsyncGenerator 把这些职责拆分开——**生产者 yield 事件，消费者 `for await` 拉取**，两端解耦。REPL、SDK、子 Agent 三种消费者共享同一个 Generator 实例，行为一致性天然保证。

**你的项目怎么用：** 把请求执行封装为一个 AsyncGenerator 函数。流式 yield 每个事件（token、工具调用、错误），消费者按需拉取。多条执行路径意味着多套行为差异——单一引擎加多种消费者适配远优于多引擎方案。

**常见误区：** 为不同入口（CLI、API、WebSocket）各写一套执行逻辑。功能一致性无法保证，bug 要修三处，新功能要加三遍。

> **类比**：类似 VSCode 的 `ExtHostMain` 单事件循环——所有扩展共享同一个 event loop，而非各自启动独立进程。

### 模式 3：统一工具接口

**一句话定义：** 内置工具与外部工具（MCP、Plugin）走同一个 `Tool` 抽象，模型不需要区分来源。

**Claude Code 中的实现：** `Tool<Input, Output, Progress>` 泛型接口（`src/Tool.ts:362`）不仅定义能力（inputSchema + call），还要求声明风险特征。以下是接口的关键字段：

```typescript
export type Tool<Input, Output, P> = {
  readonly inputSchema: Input               // Zod schema，提供完整类型推断
  call(args, context, ...): Promise<ToolResult<Output>>  // 执行入口
  description(input, options): Promise<string>            // 动态描述
  isConcurrencySafe(input): boolean         // 是否可并发（默认 false）
  isReadOnly(input): boolean                // 是否只读（默认 false）
  isDestructive?(input): boolean            // 是否不可逆（默认 false）
  interruptBehavior?(): 'cancel' | 'block'  // 被中断时的行为
  isEnabled(): boolean                      // 是否在当前环境启用
  shouldDefer?: boolean                     // 是否延迟加载 schema
  // ...
}
```

所有默认值都是保守的——**新工具默认串行、默认非只读、默认不可中断**。MCP 工具通过 `fetchToolsForClient` 转换为标准 Tool 接口，名称格式 `mcp__{server}__{tool}`；Skill 通过 `SkillTool` 作为标准 Tool 执行。base tools、feature-gated tools 和外部工具最终统一注册到同一个工具池。

**你的项目怎么用：** 定义一个 Tool 接口（`name`、`description`、`inputSchema`、`execute`），所有能力都实现它。新增能力只需实现接口并注册，自动接入权限、并发控制和监控体系。

**常见误区：** 为"特殊"工具开后门——让某个核心工具直接调内部函数不走 Tool 接口。短期方便，长期这些后门工具无法被监控、无法被权限管控、无法参与并发调度。

### 模式 4：流式重叠执行

**一句话定义：** API 流式返回过程中就开始执行工具，读操作并发、写操作串行，不等所有调用到齐。

**Claude Code 中的实现：** `StreamingToolExecutor` 每当一个 `tool_use` block 完整到达就立即 `addTool()` 入队执行。`partitionToolCalls()`（`src/services/tools/toolOrchestration.ts:91`）按读写属性动态分区——连续只读工具合并为并发批次（信号量上限 10），写入工具独占串行批次。

分区算法从左到右扫描，严格不做重排序：

```
模型返回: [Grep, Read, Edit, Grep, Read]

分区结果:
  Batch 1: {safe: true,  [Grep, Read]}  — 并发执行
  Batch 2: {safe: false, [Edit]}         — 串行执行（写操作屏障）
  Batch 3: {safe: true,  [Grep, Read]}  — 并发执行
```

注意 Batch 3 的 Grep 和 Read 不会和 Batch 1 合并——因为它们可能依赖 Edit 的结果，重排序会破坏因果一致性。BashTool 的 `isConcurrencySafe(input)` 是输入感知的——`git status` 可并发，`npm install` 必须串行；如果 shell 命令解析失败（如复杂 here-doc），降级为串行——fail-closed。

**你的项目怎么用：** 如果 LLM API 支持流式返回，第一个 tool_use 到达就立即执行，不等后续。默认串行，开发者显式声明 `isConcurrencySafe = true` 才允许并发。三个只读工具各 500ms 的场景下，流式重叠可将感知延迟从 3000ms 降到约 2000ms。

**常见误区：** 不区分读写就全部并发。两个同时写同一个文件的工具会产生竞态——这类 bug 取决于执行时序，测试环境不复现，生产环境随机出现。

> **类比**：类似浏览器的投机解析——HTML parser 在页面未完全加载时已开始解析 DOM，而非等待所有字节到达。

### 模式 5：权限主链路化

**一句话定义：** 安全检查嵌入工具执行管线内部，是必经之路而非可选插件。

**Claude Code 中的实现：** `hasPermissionsToUseToolInner()`（`src/utils/permissions/permissions.ts:1158`）是所有工具执行前的必经之路。简化后的决策流：

```
工具调用 → [bypass-immune 路径安全] → [deny/ask 规则] → [工具自身检查]
         → [权限模式] → [always-allow] → [AI 分类器 / 用户确认]
```

关键设计：前两步（bypass-immune）在所有可配置规则**之前**，即使 `--dangerously-skip-permissions` 也无法跳过。AI 分类器配合断路器（连续拒绝 3 次或总拒绝 20 次自动停用）防止误判死循环。分类器网络错误时 fail-closed——默认拒绝，不是默认放行。

**你的项目怎么用：** 在工具执行引擎内部设统一拦截点，所有工具执行前必经。定义一组 bypass-immune 安全路径（配置文件、认证凭据），即使管理员模式也不可跳过。权限是 fail-closed 的——检查失败 = 拒绝，不是放行。

**常见误区：** 把权限做成可选 decorator，让开发者自己决定是否添加。结果是——开发者会忘记加，或者"暂时"移除后忘记加回来。

### 模式 6：分级上下文压缩

**一句话定义：** 五级策略按严重程度逐级启用——能省则省，轻量清理优先，全量摘要兜底。

**Claude Code 中的实现：** 五级策略按成本递增编排（`src/query.ts` 中的调用链）：

```
每轮必执行:  applyToolResultBudget() → snipCompactIfNeeded() → microcompactMessages()
阈值触发:    autoCompactIfNeeded()    // threshold = effectiveContextWindow - 13,000
API 兜底:    reactive compact         // prompt_too_long 时紧急压缩
```

阈值公式 `AUTOCOMPACT_BUFFER_TOKENS = 13_000`（`src/services/compact/autoCompact.ts:62`）——在窗口还剩 13K Token 时启动 LLM 摘要，留出足够空间完成当前轮次。这个值不是拍脑袋——太小会导致摘要请求本身超出窗口，太大则浪费可用上下文。

**你的项目怎么用：** 至少实现两级——第一级：限制单条工具输出长度（如 max 2000 Token，超限保留头尾截断中间），每轮自动执行；第二级：Token 超窗口 80% 时用 LLM 做摘要压缩。两级就能覆盖大部分长对话场景。

**常见误区：** 只有"截断"一种策略。截断丢的是最早的对话——但最早的对话可能包含用户的原始需求描述，丢了它 Agent 就忘记自己在做什么。

### 模式 7：Cache-Aware 设计

**一句话定义：** 所有操作——压缩、替换、排列——都先考虑对 Prompt Cache 的影响，再考虑其他。

**Claude Code 中的实现：** System Prompt 用 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`（`src/constants/prompts.ts:114`）将内容分为两段：

```
[静态段: 角色 + 规则 + 工具描述]  ← cacheScope = 'global'，跨会话共享
[SYSTEM_PROMPT_DYNAMIC_BOUNDARY]  ← 分界标记
[动态段: Git 状态 + Memory + 运行时上下文]  ← cacheScope = null，每次刷新
```

`splitSysPromptPrefix()`（`src/utils/api.ts:338`）在序列化时扫描到边界标记，将其前后的文本块分配不同的 cache scope。静态段打上 `cacheScope: 'global'`，所有请求共享同一份缓存；动态段不打标签，每次重新计算。关键的设计纪律：**任何运行时条件分支（Feature Flag 判断、用户类型检查等）都必须放在动态段之后**，否则每增加一个条件分支就产生一个新的缓存 key，导致 2^N 碎片化。

**你的项目怎么用：** 每次修改消息历史时问自己"这会不会让缓存失效？"。构建 system prompt 时按缓存友好顺序排列——不变的排前面，会变的排后面。Cache hit 的 input token 成本降 90%、延迟降约 50%。一次不必要的缓存失效就让这些收益归零。

**常见误区：** 只关注 Token 数量不关注缓存命中率。压缩后 Token 少了 30% 但缓存全部失效，实际成本可能反而上升。

### 模式 8：认知分工编排

**一句话定义：** Coordinator 负责理解全局和做决策，Worker 负责执行和反馈——不是任务队列，而是认知分工。

**Claude Code 中的实现：** Coordinator 和 Worker 的工具白名单形成硬性认知隔离：

| 角色 | 工具数 | 代表工具 | 不能做 |
|------|--------|---------|--------|
| Coordinator | 4 | Agent、SendMessage、TaskStop、PR 订阅 | 不能读文件、不能写代码 |
| Worker | ~15 | Read、Edit、Bash、Grep、Glob 等 | 不能派发新 Worker |

Coordinator 模式通过 `CLAUDE_CODE_COORDINATOR_MODE=1` 激活，获得 370 行专用 system prompt。四阶段工作流：Research → Synthesis → Implementation → Verification，其中 **Synthesis 只能由 Coordinator 执行**——综合多个 Worker 的调研结果形成完整理解后，再给出包含精确文件路径、行号、修改方案的指令。核心原则 "Synthesis Before Delegation"——不做惰性转发。

**你的项目怎么用：** 设计多 Agent 系统时先问"谁负责理解全局？"。这个角色的输出必须是精确的——包含文件路径、行号、修改方案的指令，而非"修那个 bug"。用工具白名单硬性隔离 Coordinator 和 Worker 的职责边界。

**常见误区：** 把多 Agent 做成 Task Queue——所有 Agent 平等抢活。没有人综合全局信息做决策，每个 Agent 在局部视野中摸索，产出质量不可控。

> **类比**：类似 MapReduce 的 master-worker 模式，但任务分解不是预定义的 partition 逻辑，而是由 LLM 基于对任务的"认知理解"动态决定。

### 模式 9：Fork 继承上下文

**一句话定义：** 子 Agent 通过 fork 父消息历史创建，而非从零构建，共享 Prompt Cache 前缀。

**Claude Code 中的实现：** `forkSubagent.ts` 实现四层保障确保父子 Agent 的 system prompt + 消息前缀**逐字节一致**：

1. **静态段冻结**——复用父对话已渲染的 system prompt 字节，不重新生成
2. **动态段快照**——`CacheSafeParams` 封装所有影响 cache key 的参数，fork 时锁定
3. **消息裁剪规则**——统一占位符替代工具结果，各自 directive 追加到末尾
4. **`ContentReplacementState` 克隆**——继承替换决策历史，保证 wire 前缀一致

四层保障的核心目标：**父 Agent 和所有子 Agent 发送给 API 的前缀完全相同**——相同的 system prompt + 相同的消息前缀 = 命中同一份 Prompt Cache。5 个 Worker 共享缓存 = 成本从 5x 降到约 1.4x。

**你的项目怎么用：** 创建子 Agent 时从父上下文 fork，而非从零构建 system prompt。即使 API 提供商没有 Prompt Cache，继承父上下文也能减少子 Agent 的冷启动时间——它已经知道项目背景和之前的讨论。

**常见误区：** 每个子 Agent 从头构建独立的 system prompt + 空消息历史。N 个子 Agent = N 份独立缓存 = N 倍 cache miss 成本。

### 模式 10：扩展能力统一收口

**一句话定义：** MCP、Plugin、Skill 殊途同归，最终都注册为标准 Tool 接口，回到同一个运行时。

**Claude Code 中的实现：** 三种扩展机制最终汇入同一个 Tool 接口：

```
MCP Server                                  名称格式
  └→ fetchToolsForClient() ──→ Tool ──→  mcp__slack__send_message
Plugin
  └→ Intent → Materialization → Activation ──→ Tool
Skill (Markdown)
  └→ 5 处来源汇聚 ──→ SkillTool ──→ Tool
```

MCP 工具的命名格式 `mcp__{server}__{tool}` 是**有功能意义的**——API 后端通过检测工具名前缀自动注入对应的 system prompt 提示（如 Computer Use 就靠 `mcp__computer-use__*` 前缀触发）。Plugin 通过三阶段生命周期激活，依赖管理用固定点迭代处理级联失效。模型不需要区分工具来源——统一接口意味着权限、并发、监控体系天然覆盖所有扩展。

**你的项目怎么用：** 无论能力来源（内置、插件、外部 API），都走统一的接口注册。定义一个 Tool 接口，所有扩展实现这个接口。运行时只看接口不看来源。新增能力时只需关注"怎么注册为 Tool"，不需要改动核心循环。

**常见误区：** 每种扩展有自己的执行路径——内置走函数调用、MCP 走 HTTP、Plugin 走另一套 IPC。模型需要用不同语法调用不同来源的工具，prompt 复杂度和维护成本爆炸。

### 模式 11：Hook 驱动的生命周期扩展

**一句话定义**：用户定义的 shell 命令在 28 个生命周期事件触发，无需修改核心代码即可编排 Agent 行为。

**Claude Code 中的实现**

Hook 系统是 Claude Code 中规模最大的单一子系统之一（`src/utils/hooks.ts`，159KB，5,000+ 行）。它定义了 28 个事件，覆盖工具调用（`PreToolUse` / `PostToolUse`）、会话生命周期（`SessionStart` / `SessionEnd`）、子代理（`SubagentStart` / `SubagentStop`）、上下文压缩（`PreCompact` / `PostCompact`）、文件变更（`FileChanged`）、权限（`PermissionRequest`）等维度。

Hook 的返回值可以控制执行流：
- `continue: false` → 中止当前操作
- `decision: 'approve' / 'block'` → 覆盖权限判定
- `updatedInput` → 修改工具输入参数

**用到你的项目里**

在 Agent 的核心循环中，每个关键节点暴露一个事件。用户通过配置文件声明事件→命令的映射。Hook 的执行结果可以修改上下文或中止流程。

```typescript
// 伪代码示意
interface HookResult {
  continue?: boolean      // false → 中止操作
  decision?: 'approve' | 'block'  // 覆盖权限
  updatedInput?: unknown  // 修改工具输入
}

async function runHooks(event: string, context: any): Promise<HookResult> {
  const hooks = config.hooks[event] || []
  for (const hook of hooks) {
    const result = await executeShellCommand(hook.command, context)
    if (result.continue === false) return result
  }
  return { continue: true }
}
```

**常见误区**：将生命周期行为硬编码在核心代码中（如"每次工具调用后发送审计日志"），而非暴露 Hook 点让用户自行配置。硬编码导致每个新需求都需要改核心代码，而 Hook 系统让行为可以在部署时而非编译时定义。

### 模式 12：启动优化三板斧

**一句话定义**：延迟加载 + 网络预热 + Schema 按需发送的组合拳，让 Agent 冷启动从"等待一切就绪"变为"渐进式可用"。

**Claude Code 中的实现**

三个独立但协同的优化手段：

1. **延迟模块加载**（`bootstrap-entry.ts` → `cli.tsx` → `main.tsx`）：入口层不包含业务逻辑，仅做最小化引导。非核心模块通过动态 `import()` 门控，用到时才加载。
2. **TCP/TLS 预连接**（`src/utils/apiPreconnect.ts`）：在 `init.ts` 中发送 fire-and-forget 的 HEAD 请求，与其他初始化工作并行完成 TCP+TLS 握手，节省 ~100-200ms。
3. **Schema 按需加载**（`ToolSearchTool`）：核心工具（Bash、Read、Edit 等）发送完整 schema，非核心工具仅发送名称和描述的 stub。模型需要时通过 `ToolSearchTool` 按需加载完整 schema。

**用到你的项目里**

把 Agent 启动分为三个阶段：(1) 最小引导——只加载 CLI 解析和配置读取；(2) 核心初始化——加载核心循环和必要工具，同时并行预热网络连接；(3) 按需扩展——非核心能力在首次使用时加载。

**常见误区**：在入口文件中 `import` 所有模块（即使大部分本次会话不会用到），导致冷启动时间线性增长。

---

## 决策框架：什么场景用什么模式

不是所有 Agent 都需要这 12 个模式。根据你的 Agent 复杂度，分三个级别递进采用：

| 级别 | 场景 | 推荐模式 |
|------|------|---------|
| **L1：单轮工具调用** | 简单 Chatbot + 函数调用 | #3 统一工具接口 + #5 权限主链路 + #12 启动优化 |
| **L2：多轮自主执行** | 编程助手、数据分析 Agent | L1 + #2 单一主循环 + #4 流式执行 + #6 分级压缩 + #7 Cache-Aware + #11 Hook 生命周期 |
| **L3：多 Agent 协作** | 复杂工程任务自动化 | L2 + #8 认知分工 + #9 Fork 继承 + #10 扩展统一收口 |

**L1** 是底线——即使是最简单的工具调用 Agent，统一接口和权限主链路也是必须的，否则工具越加越乱、安全隐患越积越多。**L2** 是大多数编程/数据 Agent 的实际需求——多轮执行需要稳定的主循环、流式体验需要重叠执行、长对话需要压缩和缓存优化。**L3** 只在任务真正复杂到需要多 Agent 协作时才引入——过早引入多 Agent 编排会增加不必要的系统复杂度。**#1 分层架构**是所有级别的基础设施，不在表中单独列出，但建议从第一天就采用。

**过渡信号**：
- **L1 → L2**：当你的 Agent 经常超过 10 轮对话或单次会话消耗超过 50K tokens，是时候引入主循环和上下文管理了。
- **L2 → L3**：当单个 Agent 的任务经常触及 20+ 文件或耗时超过 10 分钟，认知分工和多代理协作变得有必要。

---

## 尾声：开源 Agent 的下一步

Claude Code 给开源生态的最大启示：**Agent 产品的竞争力不在模型能力，而在运行时工程**。模型会持续变强，但运行时的成熟度——启动速度、上下文管理、缓存优化、错误恢复、权限治理——需要长期的工程积累。

从"能跑起来"到"能用于生产"的差距，正是本系列试图弥合的。你的 Agent 不需要照搬 Claude Code 的每一个设计，但需要认真回答这些问题：权限是主链路还是旁路？上下文满了截断还是分级压缩？缓存是意外惊喜还是精心设计？错误是崩溃重启还是级联恢复？这些问题的答案，决定了你的 Agent 是一个 demo 还是一个产品。

---

## 模式速查表

| 编号 | 模式名 | 一句话定义 | 适用级别 |
|------|--------|-----------|---------|
| #1 | 分层架构 | 入口/循环/工具/服务/原生五层分离，各司其职 | 全部 |
| #2 | 单一主循环 | AsyncGenerator 驱动的唯一请求引擎 | L2+ |
| #3 | 统一工具接口 | 内置与外部工具走同一 Tool 抽象 | L1+ |
| #4 | 流式重叠执行 | 边收边跑，读并发写串行 | L2+ |
| #5 | 权限主链路化 | 安全检查嵌入执行管线，非可选插件 | L1+ |
| #6 | 分级上下文压缩 | 五级策略按严重程度逐级启用 | L2+ |
| #7 | Cache-Aware 设计 | 一切操作先考虑缓存影响 | L2+ |
| #8 | 认知分工编排 | Coordinator 理解决策，Worker 执行反馈 | L3 |
| #9 | Fork 继承上下文 | 子 Agent 继承父前缀共享缓存 | L3 |
| #10 | 扩展能力统一收口 | MCP/Plugin/Skill 回到同一运行时 | L3 |
| #11 | Hook 驱动的生命周期扩展 | 用户定义的 shell 命令在生命周期事件触发 | L2+ |
| #12 | 启动优化三板斧 | 延迟加载 + 网络预热 + Schema 按需发送 | L1+ |

---

## 前四篇交叉引用索引

| 模式 | 详见 | 文件链接 |
|------|------|---------|
| #1 分层架构 | 第一篇：五层架构全景 + 模式提炼 | [01-panoramic-architecture.md](./01-panoramic-architecture.md) |
| #2 单一主循环 | 第一篇：核心循环层 + Spotlight: AsyncGenerator | [01-panoramic-architecture.md](./01-panoramic-architecture.md) |
| #3 统一工具接口 | 第二篇：Tool 体系全貌 + 模式 1 | [02-tool-engine-permission.md](./02-tool-engine-permission.md) |
| #4 流式重叠执行 | 第二篇：StreamingToolExecutor + 模式 2 | [02-tool-engine-permission.md](./02-tool-engine-permission.md) |
| #5 权限主链路化 | 第二篇：权限裁决主链路 + 模式 3 | [02-tool-engine-permission.md](./02-tool-engine-permission.md) |
| #6 分级上下文压缩 | 第三篇：五级渐进式压缩 + 模式 1 | [03-context-management.md](./03-context-management.md) |
| #7 Cache-Aware 设计 | 第三篇：System Prompt Cache 拓扑 + 模式 2/4 | [03-context-management.md](./03-context-management.md) |
| #8 认知分工编排 | 第四篇：Coordinator/Worker + 模式 1 | [04-multi-agent-extensibility.md](./04-multi-agent-extensibility.md) |
| #9 Fork 继承上下文 | 第四篇：Fork Subagent + 模式 2 | [04-multi-agent-extensibility.md](./04-multi-agent-extensibility.md) |
| #10 扩展能力统一收口 | 第四篇：MCP + Plugin + Skill + 模式 3 | [04-multi-agent-extensibility.md](./04-multi-agent-extensibility.md) |
| #11 Hook 驱动的生命周期扩展 | 第一至四篇均有涉及（Hook 贯穿工具、权限、压缩、子代理） | [01](./01-panoramic-architecture.md) / [02](./02-tool-engine-permission.md) / [03](./03-context-management.md) / [04](./04-multi-agent-extensibility.md) |
| #12 启动优化三板斧 | 第一篇：五层架构全景——入口引导与按需加载 | [01-panoramic-architecture.md](./01-panoramic-architecture.md) |

---

## 附录：验证闭环说明

本篇为综合提炼篇，每个模式的源码验证在对应文章中完成。以下交叉引用表帮助你定位每个模式的验证入口：

| 模式 | 关键源码锚点 | 验证所在文章 |
|------|-------------|-------------|
| #1 分层架构 | `src/bootstrap-entry.ts`（3 行入口） | 第一篇 验证点 1 |
| #2 单一主循环 | `src/query.ts:219`（`async function*` 签名） | 第一篇 验证点 2 |
| #3 统一工具接口 | `src/Tool.ts:362`（`Tool<Input, Output, P>` 定义） | 第二篇 验证点 1 |
| #4 流式重叠执行 | `src/services/tools/toolOrchestration.ts:91`（分区算法） | 第二篇 验证点 2 |
| #5 权限主链路 | `src/utils/permissions/permissions.ts:1158`（裁决入口） | 第二篇 验证点 3 |
| #6 分级压缩 | `src/services/compact/autoCompact.ts:62`（阈值常量） | 第三篇 验证点 1 |
| #7 Cache-Aware | `src/constants/prompts.ts:114`（动态边界标记） | 第三篇 验证点 2 |
| #8 认知分工 | Coordinator 4 工具白名单 | 第四篇 验证点 4 |
| #9 Fork 继承 | `forkSubagent.ts` 四层保障 | 第四篇 验证点 5 |
| #10 扩展收口 | MCP `mcp__{server}__{tool}` 命名 | 第四篇 验证点 3 |
| #11 Hook 生命周期 | `src/utils/hooks.ts`（28 个事件） | 第一篇 横切关注点 + 第二篇 权限管线 |
| #12 启动优化 | `src/utils/apiPreconnect.ts`（预连接） | 第一篇 Spotlight |

> 每个模式的验证入口在对应文章的"跟跑验证"和"附录"部分，提供精确的文件路径、行号和插桩代码模板，可在本地或 Docker 环境中复现。

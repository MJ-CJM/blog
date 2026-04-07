---
publishDate: 2026-04-07T04:00:00Z
title: '从单兵到军团：多智能体协作与可扩展架构'
excerpt: '当任务复杂到单个 Agent 装不下，深入 Coordinator/Worker 编排、Fork Cache 共享与 MCP/Plugin/Skill 三层扩展架构。'
category: 'Claude Code 源码解析'
tags:
  - Claude Code
  - AI Agent
  - 架构设计
  - 源码分析
---


> 当任务复杂到"重构整个认证模块"，一个 Agent 的上下文窗口装不下所有上下文，注意力也覆盖不了所有细节。Claude Code 用 Coordinator/Worker 分层编排、Fork Subagent 的字节级 Cache 共享、声明式 Agent 定义体系、Agent Teams 多进程集群协作、以及 MCP/Plugin/Skill 三层可扩展架构，让一群 Agent 高效协作，也让外部能力无缝接入。

---

## 从上一篇说起

前三篇我们拆解了 Claude Code 的全景架构、工具引擎与权限管线、上下文管理的工程艺术。但真正复杂的任务，一个 Agent 不够。

想象一个场景：你对 Claude Code 说"重构整个认证模块——把 session-based 认证迁移到 JWT，更新所有相关的 API 路由和测试"。这个任务涉及几十个文件、多种修改模式（类型定义、路由逻辑、测试用例、配置文件），单个 Agent 即使有 200K Token 窗口，也很难同时保持对所有模块的精确注意力。更现实的问题是：**串行处理这些子任务极慢**——一个 Agent 按顺序修改 30 个文件可能需要 20 分钟，但如果 5 个 Agent 并行，5 分钟就能完成。

从单 Agent 到多 Agent，不是简单地"多开几个对话框"。需要回答三个核心问题：谁负责理解全局和做决策？子 Agent 如何共享上下文而不重复付费？外部工具和扩展能力如何统一接入？

官方文档把这类能力统称为 **subagents**，并重点介绍了如何创建和使用它们；本文则进一步拆源码里的运行时细节，关注 coordinator、fork、自定义 Agent 定义、Agent Teams 集群协作、cache-safe params、MCP/plugin/skill 这些”公开概念背后的实现层”。

## Coordinator/Worker：认知分工，不是任务分工

### 为什么不是 Task Queue

最容易想到的多 Agent 方案是 Task Queue——把大任务拆成子任务，扔进队列，Worker 抢活干。但 AI Agent 场景有一个根本不同：**任务拆解本身需要深度理解**。"重构认证模块"不能简单拆成"修改文件 A"、"修改文件 B"——你需要先理解 session 认证的数据流，才能决定 JWT 的 token 在哪里签发、哪里验证、哪些中间件需要替换。

Claude Code 的方案是 **Coordinator/Worker 分层编排**：Coordinator 负责理解和决策，Worker 负责执行和反馈。通过环境变量 `CLAUDE_CODE_COORDINATOR_MODE=1` 激活（`src/coordinator/coordinatorMode.ts:36-41`），Coordinator 获得一份专用的 370 行 system prompt，行为模式从"全能执行者"切换为"编排指挥者"。

关键约束：Coordinator **只有 4 个工具**——`Agent`（派发 Worker）、`SendMessage`（向运行中的 Worker 发送后续指令）、`TaskStop`（停止 Worker）、以及 PR 订阅工具。它不能读文件、不能写代码、不能执行命令。这种极端的工具白名单设计，从根本上阻止了 Coordinator 直接动手——它**只能**通过 Worker 来操作世界。

而 Worker 恰好相反：拥有完整的工具集（约 15 个核心工具，通过 `ASYNC_AGENT_ALLOWED_TOOLS` 配置），可以读写文件、执行命令、搜索代码，但**不能**派发新的 Worker 或与其他 Worker 直接通信。

### Synthesis Before Delegation：核心设计原则

Coordinator/Worker 分层不是新概念，但 Claude Code 对 Coordinator 行为有一个严格要求：**先综合理解，再精确委派**（Synthesis Before Delegation）。这个原则写在 system prompt 的第 253-268 行，通过具体的反模式示例来塑造 LLM 行为。

> ### Spotlight: Synthesis Before Delegation 的反模式
>
> **反模式（惰性委派）**——Coordinator 不理解就转发：
> ```
> Agent({ prompt: "Based on your findings, fix the auth bug" })
> ```
> Worker 收到这条指令后，不知道 bug 在哪个文件、什么原因、该怎么修。它要么重新做一遍调研（浪费 Token），要么瞎猜（产出低质量修复）。
>
> **正确模式**——综合理解后给精确指令：
> ```
> Agent({ prompt: "Fix null pointer in src/auth/validate.ts:42.
>   The user field on Session (src/auth/types.ts:15) is undefined
>   when sessions expire but token remains cached.
>   Add a null check before user.id access..." })
> ```
> Worker 收到的是精确的文件路径、行号、问题原因和修复方案，可以直接执行。这就像一个好的技术 PM——不说"修那个 bug"，而是"文件 X 第 42 行有空指针，原因是 Y，修复方案是 Z"。
>
> 关键：这不是代码逻辑强制的（没有代码校验 prompt 的质量），而是通过 system prompt engineering 塑造的行为模式。在 LLM Agent 领域，过度刚性的代码约束往往比 prompt 约束更脆弱。

### 四阶段工作流

整个协作遵循明确的四阶段节奏（system prompt 第 199-209 行）：

| 阶段 | 执行者 | 做什么 |
|------|--------|--------|
| Research | Worker（并行） | 调查代码库，理解问题，报告发现 |
| **Synthesis** | **Coordinator** | 阅读所有 Worker 的调查结果，理解问题全貌，撰写实现规范 |
| Implementation | Worker（按规范） | 按 Coordinator 的精确指令修改代码 |
| Verification | Worker | 运行测试，验证修改的正确性 |

Synthesis 阶段只能由 Coordinator 执行——这是整个模式的关键环节。Research Worker 和 Implementation Worker 可以是不同的 Agent（system prompt 还编码了一个精细的 Continue vs. Spawn 决策矩阵：如果 Research Worker 探索的文件恰好是要修改的文件，就用 `SendMessage` 复用它的上下文；如果研究范围宽泛但实现范围窄，则派发新 Worker 避免上下文噪声）。

Worker 完成后通过 `<task-notification>` XML 格式异步回传结果给 Coordinator，包含 task-id、status、summary、result 和 token 用量。Coordinator 在下一轮 query 中读取通知，决定下一步行动。

## Fork Subagent：共享 Cache 的经济学

### 问题：一个 Coordinator 启动 5 个 Worker，缓存怎么算

Coordinator 模式下，一个复杂任务可能同时启动 5-6 个 Worker。每个 Worker 的首次 API 请求都包含 system prompt（~20K Token）+ 消息历史前缀。如果每个 Worker 都从头构建独立的 system prompt，Anthropic API 就需要为 6 份几乎相同的前缀各缓存一份——成本是 6 倍。

Claude Code 的 Fork Subagent 机制（`src/tools/AgentTool/forkSubagent.ts`）解决了这个问题：子 Agent 通过 fork 父进程的消息历史创建，而非从零构建。核心目标只有一个——**Byte-Identical Prefix**：父子 Agent 的 system prompt + 消息前缀**逐字节完全一致**，让 Anthropic API 把它们视为同一个缓存前缀。

cache_read 的价格是 cache_miss 的 **1/10**。一次成功的 cache 共享，将子 Agent 首次 API 调用的成本降低 90%。5 个 Worker 共享缓存 = 只需缓存 1 份前缀，成本从 5x 降到 ~1.4x。

### 四层保障：为什么需要这么严格

Prompt Cache 按字节前缀匹配——**一个字节的偏差 = 完全不同的 cache key = 缓存完全失效**。Claude Code 用四层机制保障字节一致性：

**第一层：静态段冻结**。子 Agent 不重新调用 `getSystemPrompt()`，而是直接复用父对话已渲染好的 system prompt 字节（通过 `toolUseContext.renderedSystemPrompt` 传递，`forkSubagent.ts:54-58`）。为什么？因为 system prompt 依赖 GrowthBook feature flag，而 flag 有冷启动期——父对话渲染时和子 Agent 启动时，flag 值可能已经变化。重新生成 = 字节不同 = 缓存失效。

**第二层：动态段快照**。`CacheSafeParams`（`src/utils/forkedAgent.ts:57-68`）将所有影响 cache key 的参数封装为一个显式类型合约——systemPrompt、userContext、systemContext、toolUseContext、forkContextMessages。父对话在每轮结束时通过 `saveCacheSafeParams()` 自动快照，子 Agent 调用 `getLastCacheSafeParams()` 获取一致的参数。

**第三层：消息裁剪规则**。`buildForkedMessages`（`forkSubagent.ts:96-106`）用统一的占位文本 `'Fork started - processing in background'` 替代所有工具结果。所有子 Agent 看到的工具结果完全相同，各自不同的 directive 被追加为消息序列的**最末尾**——只有最后一个 text block 不同，不影响前缀匹配。

**第四层：Cache 安全参数传递**。`ContentReplacementState` 克隆而非新建（`forkedAgent.ts:389-403`）——子 Agent 继承父对话的工具结果替换决策历史，确保对相同内容做出相同的替换决策。如果新建，子 Agent 没见过父对话的 tool_use_id，会做出不同的替换决策 = wire 前缀不同 = 缓存失效。

> ### Spotlight: 一个字节都不能差
>
> Prompt Cache 的严格性超出大多数人的直觉。fork 时 system prompt 多一个空格 = cache key 完全不同 = 6 个 Worker 的缓存共享全部失效 = 成本从 1.4x 回到 6x。这就是为什么 Claude Code 需要四层保障而不是"注意一下格式就行"。更极端的例子：`buildForkedMessages` 中如果对工具结果用 `JSON.stringify` 而非固定占位符，不同 JSON 实现对 key 顺序的处理可能不同，一样会导致字节不一致。每一层保障解决一个具体的字节漂移来源——GrowthBook flag 漂移、消息内容差异、替换决策不一致、API 参数差异——四层加在一起才构成完整的防线。

## Agent 定义体系：从内置到自定义

前面讲了 Coordinator 和 Fork 的运行时机制，但一个关键问题还没回答——Agent 从哪里来？当 Coordinator 调用 `Agent({ subagent_type: "Explore" })` 时，Explore 的工具限制、模型选择、系统提示词从何而来？

Claude Code 的 Agent 定义体系分三个层次：6 种**内置 Agent** 覆盖最常用场景，**Markdown 自定义 Agent** 让用户用一份配置文件定义新类型，**多源覆盖机制** 让项目级配置能覆盖全局默认。

### 内置 Agent：6 种预设角色

| agentType | 模型 | 工具限制 | 设计意图 |
|---|---|---|---|
| general-purpose | inherit | 全部工具 | 默认回退类型，处理复杂多步任务 |
| Explore | haiku（3P）/ inherit（ant） | 排除 Agent/Edit/Write/NotebookEdit | **只读探索**——快速代码搜索，不允许修改文件也不允许递归派发 Agent |
| Plan | inherit | 排除 Agent/Edit/Write/NotebookEdit | **只读规划**——设计实施方案，不能动手也不能递归派发 |
| claude-code-guide | inherit | Glob/Grep/Read/WebFetch/WebSearch | **使用指南**——回答 Claude Code、Agent SDK、Claude API 相关问题 |
| verification | inherit | 全部工具 | **验证 Agent**——通过边界测试破坏现有实现，发现问题 |
| statusline-setup | inherit | Read/Edit | **状态栏配置**——将 PS1 配置转换为 statusLine 命令 |

> ### Spotlight: Explore Agent 的设计决策
>
> Explore 是使用频率最高的内置 Agent，它的两个设计选择值得展开：
>
> **模型选择**：外部用户用 haiku（快速、低成本），Anthropic 内部用 inherit（继承父模型）。为什么？探索任务的典型模式是"搜索 → 阅读 → 报告"，不需要深度推理能力，haiku 的速度优势远大于推理差距。但内部用户可能探索更复杂的代码逻辑，继承父模型的推理能力更合适。
>
> **工具排除逻辑**：`disallowedTools` 排除了 Agent（防止递归派发）、Edit/Write（防止修改文件）、NotebookEdit（防止修改笔记本）。注意用的是 `disallowedTools`（黑名单）而非 `tools`（白名单）——这意味着如果用户通过 MCP 接入了新工具（如数据库查询），Explore Agent 自动获得这些工具的访问权限。**黑名单比白名单更具扩展性**——新能力接入时不需要修改 Agent 定义。

**Feature Gate 控制**：Explore 和 Plan 受 `BUILTIN_EXPLORE_PLAN_AGENTS` gate 控制（GrowthBook `tengu_amber_stoat`），verification 受 `VERIFICATION_AGENT` gate 控制（`tengu_hive_evidence`）。这些 Agent 类型可以被 A/B 测试——部分用户看到 Explore/Plan 选项，部分用户不看到，用于衡量专用 Agent 对用户效率的实际影响。

关键源码：`src/tools/AgentTool/builtInAgents.ts`（注册表）、`src/tools/AgentTool/built-in/`（各 Agent 定义）

### Markdown 自定义 Agent：一份文件定义一种角色

用户在 `.claude/agents/` 目录下放置 Markdown 文件即可定义新的 Agent 类型。格式是 YAML frontmatter + Markdown 正文（正文作为系统提示词）：

```markdown
---
name: my-reviewer
description: "代码审查专家，只读分析代码质量"
model: opus
tools: [Read, Grep, Glob]
permissionMode: plan
maxTurns: 50
memory: project
mcpServers: [github]
isolation: worktree
---

你是一位严格的代码审查专家。审查代码时关注：
1. 逻辑正确性
2. 边界条件处理
3. 性能隐患
4. 安全漏洞

只分析，不修改文件。审查完成后输出结构化报告。
```

**15+ 配置字段速查表**（按类别分组）：

| 类别 | 字段 | 类型 | 说明 |
|------|------|------|------|
| **身份** | `name` | string（必填） | Agent 类型标识，对应 `subagent_type` 参数 |
| | `description` | string（必填） | Agent 用途描述，展示在 Agent 工具的类型提示中 |
| | `model` | string | `inherit`（继承父模型）或 `haiku`/`sonnet`/`opus` |
| | `effort` | string/int | 推理努力程度 |
| | `color` | string | Agent 在 UI 中的颜色标识 |
| **工具** | `tools` | string[] | 允许的工具白名单；`['*']` = 全部；`[]` = 无工具 |
| | `disallowedTools` | string[] | 禁止的工具黑名单（在白名单基础上排除） |
| | `skills` | string[] | 预加载的 Skill 名称列表 |
| | `mcpServers` | array | Agent 专属 MCP 服务器（引用名称或内联定义） |
| **行为** | `permissionMode` | enum | 权限模式：default/plan/acceptEdits/bypassPermissions |
| | `maxTurns` | int | 最大轮次限制（防止失控循环） |
| | `background` | boolean | 是否始终作为后台任务运行 |
| | `isolation` | enum | 隔离模式：`worktree`（git worktree）或 `remote`（远程） |
| | `hooks` | object | Session 级钩子（bash/HTTP/prompt，按 HooksSchema） |
| **状态** | `memory` | enum | 持久记忆范围：`user` / `project` / `local` |
| | `initialPrompt` | string | 第一轮 user turn 前置提示（初始化上下文） |

### 发现、加载与覆盖

加载入口 `getAgentDefinitionsWithOverrides(cwd)`（`loadAgentsDir.ts`）按以下顺序扫描，同名 Agent 后加载的覆盖先加载的：

1. **内置 Agent**（`builtInAgents.ts`）——始终存在
2. **插件提供的 Agent**（`loadPluginAgents()`）——已安装插件附带
3. **用户级** `~/.claude/agents/`——个人自定义
4. **项目级** `{project}/.claude/agents/`——团队共享
5. **Flag 设置**（`flagSettings`）——远程下发
6. **策略管控**（`policySettings`）——企业管控

实际覆盖优先级：策略管控 > Flag > 项目级 > 用户级 > 插件 > 内置。企业管理员可以通过策略强制覆盖用户自定义的同名 Agent；项目级配置可以覆盖用户级的同名 Agent——团队约定优先于个人偏好。

除了 Markdown，也支持通过 `settings.json` 的 `agents` 字段用 JSON 定义 Agent，字段与 frontmatter 相同，额外需要 `prompt` 字段替代 Markdown 正文。

> **补充：配置的五源优先级链**
> 
> Agent 定义的加载遵循六层优先级（policy > flag > project > user > plugin > built-in），这与 Claude Code 全局设置的五源优先级链一脉相承（`src/utils/settings/constants.ts`）：`userSettings → projectSettings → localSettings → flagSettings → policySettings`，后者覆盖前者。企业策略（policySettings/MDM）始终享有最高优先级且无法被禁用。

> ### Spotlight: subagent_type 的解析流程
>
> 当模型调用 `Agent({ subagent_type: "my-reviewer" })`（`AgentTool.tsx:318-356`）：
> 1. 如果 `subagent_type` 显式传入 → 在 `activeAgents` 中按 `agentType` 精确匹配
> 2. 如果未传入 + `FORK_SUBAGENT` 门控开启 → 走 Fork 路径（继承父上下文）
> 3. 如果未传入 + Fork 未开启 → 默认 `general-purpose`
> 4. 找不到匹配 → 抛出错误，提示可用的 Agent 类型列表
>
> 还有两道过滤关卡：
> - `filterAgentsByMcpRequirements()`：Agent 要求特定 MCP 服务器但当前未连接 → 从可用列表中移除
> - `filterDeniedAgents()`：按权限策略过滤被禁用的 Agent 类型
>
> 这意味着 Agent 的可用性不仅取决于定义是否存在，还取决于运行时环境是否满足条件。

## Agent 运行时能力

Agent 定义体系解决了"Agent 是什么"——身份、工具、模型。但 Agent 在运行时还需要一系列基础能力：怎么隔离工作区？怎么异步执行？怎么跨会话保持记忆？怎么控制权限？这些能力由运行时提供，每种对应 frontmatter 中的一个配置字段。

| 能力 | frontmatter 字段 | 效果 | 关键实现 |
|------|-----------------|------|---------|
| Worktree 隔离 | `isolation: worktree` | 创建临时 git worktree，改动不影响主工作区 | `src/utils/worktree.ts` |
| 后台执行 | `background: true` | 异步运行，完成后通过 `<task-notification>` 通知 | `LocalAgentTask` |
| 持久记忆 | `memory: user\|project\|local` | 跨会话记忆，支持快照初始化 | `agentMemory.ts` |
| 权限模式 | `permissionMode` | 6 种模式控制自主度 | `PermissionMode` 类型 |
| 工具限制 | `tools` / `disallowedTools` | 白名单 + 黑名单双重过滤 | `resolveAgentTools()` |
| 模型覆盖 | `model` | `inherit` 继承父模型或指定 haiku/sonnet/opus | `src/utils/model/agent.ts` |
| Agent Hooks | `hooks` | Session 级 bash/HTTP/prompt 钩子 | Hooks 系统 |
| 预加载 Skill | `skills` | 自动注入指定 Skill 的 prompt | Skill 系统 |

Hook 系统为多代理场景提供了两个专属事件：`SubagentStart`（子代理创建时触发）和 `SubagentStop`（子代理终止时触发）。通过绑定这些事件，外部系统可以实现代理生命周期的监控和编排——例如，在 `SubagentStart` 时记录审计日志，在 `SubagentStop` 时触发后处理流水线。

### Worktree 隔离

当设置 `isolation: worktree` 时，`createAgentWorktree()`（`src/utils/worktree.ts`）为 Agent 创建一个临时 git worktree——独立的分支和工作目录副本，与主工作区完全隔离。

这解决了一个关键的并发问题：多个 Agent 同时修改同一仓库时，如果都在主工作区操作，git status 会一团混乱。Worktree 让每个 Agent 在自己的副本上独立工作，完成后有两种结局：
- **无修改** → worktree 自动清理，无痕退出
- **有修改** → 返回 worktree 路径和分支名，供用户决定是否合并

Fork 子 Agent 运行在 worktree 中时，还会收到一段注入提示（`buildWorktreeNotice()`，`forkSubagent.ts:208-213`）：告诉它继承的上下文中的路径指向父工作目录，需要翻译为 worktree 路径；它的改动是隔离的，不会影响父 Agent 的文件。

### 权限模式阶梯

6 种权限模式形成从"完全受控"到"完全自主"的阶梯：

| 模式 | 行为 | 典型场景 |
|------|------|---------|
| `default` | 每次工具调用都要用户确认 | 高风险操作，需要人工审核 |
| `plan` | 先展示执行计划，用户批准后自动执行全部 | 需要预审但不需要逐步确认 |
| `acceptEdits` | 自动批准文件编辑操作，其他仍需确认 | 信任代码修改，但不信任系统命令 |
| `bypassPermissions` | 跳过所有权限检查 | 完全信任的自动化场景（需 `--dangerously-skip-permissions`） |
| `bubble` | 权限请求冒泡到父 Agent/Leader | Fork 子 Agent、Team Worker 的默认模式 |
| `auto` | 分类器自动判断是否需要确认 | `TRANSCRIPT_CLASSIFIER` 门控，实验性 |

`bubble` 模式是多 Agent 架构中的关键设计——子 Agent 运行在后台没有 TTY，无法直接弹出确认对话框。权限请求通过消息机制冒泡到有 TTY 的父进程，由人类在父终端做决策，结果再回传给子 Agent。这个机制将在 Agent Teams 章节中详细展开。

### 上下文隔离与共享

每个子 Agent 通过 `createSubagentContext()`（`src/utils/forkedAgent.ts`）获得独立的执行上下文。隔离与共享的精确边界：

**隔离的**（每个 Agent 独立）：
- 消息历史（独立消息列表，互不污染）
- AbortController（但链式连接到父，父中断 → 子级联中断）
- 文件状态缓存（从父克隆快照，之后独立演化）
- 会话存储（独立 transcript 子目录）

**共享的**（所有 Agent 通用）：
- `AppState.tasks`（所有 Task 状态注册在根 AppState，对 UI 和 Leader 均可见）
- 工具结果替换状态（`ContentReplacementState` 从父克隆，初始值一致以保障 Cache 共享）

这种"消息隔离但状态共享"的设计，让父 Agent 能监控子 Agent 进度（通过 `AgentProgress`：toolUseCount、tokenCount、lastActivity），也让 UI 能展示所有正在运行的后台 Agent。

### Task 通知协议

Agent 完成后通过 `<task-notification>` XML 格式回传结果给父 Agent：

```xml
<task-notification>
  <task-id>uuid</task-id>
  <status>completed</status>
  <summary>完成了 3 个文件的修改</summary>
  <result>修改了 src/auth/validate.ts、src/auth/types.ts、tests/auth.test.ts...</result>
</task-notification>
```

通知被注入到父 Agent 的消息队列（`enqueueAgentNotification()`），父 Agent 在下一轮 query 循环中读取通知，决定后续动作——是继续派发新 Worker、用 SendMessage 追加指令、还是结束任务。

后台 Agent 还支持**自动后台化**：运行超过 120 秒的前台 Agent 会自动转为后台执行（GrowthBook `tengu_auto_background_agents` 门控），避免用户被长时间阻塞。

## Agent Teams：从单机到集群

Coordinator/Worker 解决了认知分工，Fork 解决了缓存共享，自定义 Agent 解决了能力定义——但这些都运行在**同一个 Node.js 进程内**。子 Agent 通过 `runAgent()` 调用 query 循环，与父 Agent 共享事件循环。

当任务规模进一步扩大——5-10 个 Agent 同时工作，每个都在做 API 调用、文件读写、命令执行——单进程模型的两个问题浮现：**可观测性差**（所有 Agent 的输出混在一个终端里），**隔离不足**（一个 Agent 的死循环拖慢所有其他 Agent）。

Agent Teams（源码中称为 Swarm，`src/utils/swarm/` 目录 21 个文件）将协作从单进程扩展到多进程甚至多终端窗口——每个 Agent 有自己的终端 pane，用户可以实时观察每个 Agent 的工作状态。

### 创建与数据模型

用户通过 `TeamCreate` 工具创建团队。核心数据结构 `TeamFile`（`src/utils/swarm/teamHelpers.ts`）：

```typescript
interface TeamFile {
  name: string
  leadAgentId: string              // Leader 的 UUID
  members: TeamMember[]            // 团队成员列表
  teamAllowedPaths: string[]       // 所有成员可编辑的路径
  hiddenPaneIds: string[]          // UI 中隐藏的 pane
}

interface TeamMember {
  agentId: string                  // 格式 "name@teamName"
  name: string                     // 如 "researcher"
  backendType: 'tmux' | 'iterm2' | 'in-process'
  mode: PermissionMode
  isActive: boolean
  worktreePath?: string            // 可选 git worktree 隔离
  cwd: string
  subscriptions: string[]          // 消息订阅
}
```

创建流程：`TeamCreateTool.call()` → 写入 `~/.claude/teams/{name}/config.json` → 创建任务目录 `~/.claude/tasks/{name}/` → 注册到会话清理列表（会话结束时自动清理 worktree 和临时文件）。

### 三种执行后端

同一个 Agent 定义，可以跑在三种不同的执行后端上：

| 后端 | 运行方式 | 优势 | 限制 |
|------|---------|------|------|
| **tmux** | 每个 Agent 一个 tmux pane | 可视化、可交互、支持 detach 后恢复 | 需要安装 tmux |
| **iTerm2** | 每个 Agent 一个 iTerm2 split | macOS 原生体验，无需额外安装 | 仅 macOS + iTerm2 |
| **in-process** | AsyncLocalStorage 隔离同进程 | 零 IPC 开销、共享 AppState | 可观测性差、不可独立 kill |

后端由 `registry.ts` 根据运行环境自动选择：

```
if (inside tmux session)           → tmux 原生模式
else if (in iTerm2 + it2 CLI 可用) → iTerm2 原生模式
else if (tmux 可用)                → tmux 回退模式
else                               → 报错 + 平台对应的安装指引
```

> ### Spotlight: 为什么 tmux 是首选后端？
>
> tmux 的优势不仅在于"每个 Agent 一个窗口"。更关键的是它的**生命周期管理能力**——Agent 进程可以在 tmux session 中持续运行，即使用户关闭终端也不中断（detach）。用户可以随时 attach 回来查看进度。这对于长时间运行的多 Agent 任务（如大规模代码重构）至关重要。
>
> in-process 模式虽然零开销，但所有 Agent 共享同一个 Node.js 事件循环。如果一个 Agent 的工具调用出现死循环或大量同步 I/O，会拖慢所有其他 Agent。tmux/iTerm2 模式下每个 Agent 是独立进程，自然隔离。

### 邮箱通信系统

Agent Teams 中的 Agent 通过**文件系统邮箱**异步通信——不是共享内存，不是 WebSocket，不是 Redis，就是磁盘上的 JSON 文件。

邮箱路径：`~/.claude/teams/{team}/inboxes/{agent-name}.json`

```typescript
interface TeammateMessage {
  from: string        // 发送者名称
  text: string        // 消息内容（纯文本或结构化 JSON）
  timestamp: number
  read: boolean
  color?: string      // 可选颜色标识
  summary?: string    // 可选摘要
}
```

并发安全通过 `proper-lockfile` 库实现——基于文件锁，10 次重试，5-100ms 指数退避。

**SendMessage 工具支持三种寻址模式**：
- **具名寻址**：`to: "researcher"` → 写入该 Agent 的邮箱文件
- **广播**：`to: "*"` → 遍历所有 Agent 邮箱写入
- **外部寻址**：`to: "uds:/path"` → Unix Domain Socket 本地对等进程；`to: "bridge:{sessionId}"` → Remote Control 跨网络寻址

系统级通信使用结构化消息（`StructuredMessage`）：`shutdown_request/response`（优雅关闭）、`plan_approval_response`（plan 模式审批）。

邮箱消息与 `<task-notification>` 的区别：前者是**双向通信**（Leader ↔ Worker，用于指令、权限、状态同步），后者是**单向结果上报**（Worker → 父 Agent，用于任务完成通知）。Coordinator 模式用 `<task-notification>`，Teams 模式用邮箱 + 通知并行。

### 权限同步：冒泡机制

后台 Worker 没有 TTY 终端，无法直接弹出权限确认对话框。解决方案是**权限请求冒泡**——Worker 把权限问题"上报"给 Leader，由 Leader 在主终端代为确认。

```
1. Worker 遇到需要确认的工具调用
        ↓
2. 构造 SwarmPermissionRequest { id, workerId, toolName, description, input }
        ↓
3. sendPermissionRequestViaMailbox()
   - in-process：内存队列
   - tmux/iTerm2：写入 permissions/pending/{id}.json
        ↓
4. Leader 轮询收到请求 → 在主终端弹出确认对话框
        ↓
5. 用户批准/拒绝 → sendPermissionResponseViaMailbox()
        ↓
6. Worker 轮询读取响应 → 继续执行或中止
```

`permissionSync.ts` 长达 850+ 行，处理了大量边缘情况——请求超时、Worker 在等待期间被 kill、Leader 断线重连后补偿未处理的请求等。整个流程基于文件系统，无需共享内存。

### CLI 参数与环境继承

Leader 派发 Worker 时，`spawnUtils.ts` 确保 Worker 继承正确的运行环境：

**CLI 标志继承**：`--dangerously-skip-permissions`、`--permission-mode`、`--model`、`--plugin-dir`、`--teammate-mode` 等按当前配置自动传递。

**环境变量继承**：API 提供商选择（`CLAUDE_CODE_USE_BEDROCK`、`CLAUDE_CODE_USE_VERTEX`）、代理配置（`HTTPS_PROXY`、`HTTP_PROXY`）自动转发。始终设置 `CLAUDECODE=1` 和 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`。

### Feature Gate

Agent Teams 目前对外部用户是实验性功能：
- **Anthropic 内部**（`USER_TYPE=ant`）：始终启用
- **外部用户**：需同时满足 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 环境变量 + GrowthBook `tengu_amber_flint` 放行

但代码已经完全实现——整个 `src/utils/swarm/` 目录 21 个文件，是 Claude Code 中规模最大的子系统之一，表明这是 Anthropic 重点投入的方向。

关键源码：`src/utils/swarm/teamHelpers.ts`（684 行）、`src/utils/teammateMailbox.ts`、`src/utils/swarm/permissionSync.ts`（850+ 行）、`src/utils/swarm/backends/registry.ts`、`src/utils/agentSwarmsEnabled.ts`

## MCP + Plugin + Skill：三层可扩展架构

单 Agent 到多 Agent 解决了内部协作问题，但 Agent 的能力边界不只取决于自身——还取决于它能连接多少外部系统。Claude Code 用三层可扩展架构解决这个问题：MCP 连接外部系统、Plugin 打包分发能力、Skill 提供可复用 Prompt 工作流。

### MCP：标准协议连接一切

MCP（Model Context Protocol）让 Claude Code 通过标准协议接入 IDE、数据库、API 等外部系统。核心实现在 `src/services/mcp/client.ts`，支持 stdio/SSE/HTTP/WebSocket 四种 Transport。

连接管理的核心挑战是**多 Server 并发 + 自愈**。Claude Code 的方案：

- **分组限速并发**：本地 Server（stdio/sdk）默认 3 并发，远程 Server（sse/http/ws）默认 20 并发，通过 `pMap` 实现有界并发
- **指数退避自愈**：连接断开后自动重连，退避序列 1s → 2s → 4s → 8s → 16s，最多 5 次。每次重试前检查 Server 是否已被用户禁用（防止用户已关闭但重连仍在跑的竞态）
- **双信号会话过期检测**：同时检查 HTTP 404 和 JSON-RPC -32001 才判定为会话过期，避免误判
- **工具自动发现**：Server 连接后自动拉取工具列表，按 `mcp__{server}__{tool}` 格式注册到全局工具池，模型直接使用

### Plugin：打包分发的能力容器

Plugin 是 Skill 和 MCP Server 的打包分发容器，采用 **Intent → Materialization → Activation** 三阶段生命周期（`src/utils/plugins/refresh.ts`）：

| 阶段 | 存储位置 | 做什么 |
|------|---------|--------|
| Intent（声明意图） | `settings.json` 的 `enabledPlugins` | 用户声明"我要这个插件" |
| Materialization（物化） | `~/.claude/plugins/<name>/<hash>/` | `reconcileMarketplaces()` 从意图同步到磁盘 |
| Activation（激活） | `AppState` 运行时状态 | `refreshActivePlugins()` 从磁盘原子交换到运行时 |

每层独立可操作，不可跨层跳变。Intent 声明了但未安装 = 只在 Layer 1，不影响运行时；安装了但未激活 = 在 Layer 2 等待 `/reload-plugins`。三层分离确保坏插件不会在声明的瞬间就拖垮系统——它必须经过物化、验证、激活三关。

依赖管理用**固定点迭代**处理级联失效：插件 A 依赖 B，B 依赖 C，如果 C 缺失，第一轮降级 B，但这导致 A 的依赖也不满足，需要第二轮降级 A。循环直至不再有变化——简洁有效，无需构建显式依赖图。

### Skill：可复用 Prompt 工作流

Skill 是以 Markdown 定义的可复用 prompt 片段，用户通过 `/skill-name` 调用，AI 模型也可通过 `SkillTool` 主动触发。来源有五处汇聚（`src/commands.ts`）：

1. **内置打包**（bundled）——编译进 CLI 的 Skill，如 `/commit`、`/loop`
2. **项目级**（`.claude/skills/`）——团队共享的项目 Skill
3. **用户级**（`~/.claude/skills/`）——个人自定义 Skill
4. **Plugin 提供**——安装的 Plugin 附带的 Skill
5. **MCP Server 提供**——远程 Server 暴露的 Skill

每个 Skill 可以携带 `allowed-tools`（限制可用工具）、`model`（覆盖模型）、`context: fork`（独立子 Agent 执行）等元数据，以及 Budget-Aware 的注入控制。

### 统一点：三者殊途同归

MCP 工具通过 `fetchToolsForClient` 转换为标准 `Tool` 接口；Plugin 通过 `getPluginCommands()` 注册命令和 Skill；Skill 通过 `SkillTool` 作为标准 Tool 执行。三者最终都回到同一个 Tool 运行时——**模型不需要区分一个工具是内置的、MCP Server 提供的、还是 Plugin 带来的**。调用方式完全一致，权限检查走同一管线，工具结果格式统一。这种统一收口的设计意味着扩展能力时只需关注"怎么把新能力注册为 Tool"，不需要改动核心循环的任何代码。

### 三者何时用？一张对比表

| 维度 | MCP | Plugin | Skill |
|------|-----|--------|-------|
| 抽象层 | 协议（stdio/SSE/HTTP/WS） | 包（Intent → Materialization → Activation） | Markdown Prompt 模板 |
| 工具注册 | `mcp__{server}__{tool}` 自动发现 | 三阶段激活后注册 | 通过 `SkillTool` 包装为工具调用 |
| 分发方式 | 独立服务端进程（本地或远程） | 目录/市场 | `.claude/skills/` 文件或 MCP 提供 |
| 隔离级别 | 进程级（独立服务器进程） | 定点迭代依赖解析 | Fork context 可选隔离 |
| 运行时开销 | 进程通信 + 序列化 | 包加载 | 几乎为零（仅 prompt 注入） |
| 适用场景 | 连接外部系统（数据库、API、IDE） | 打包分发的完整能力容器 | 可复用的 Prompt 工作流和最佳实践 |

**选型建议**：需要连接外部系统 → MCP；需要打包分发给多用户 → Plugin；需要沉淀可复用的工作模式 → Skill。三者可组合——一个 Plugin 可以内含 MCP 服务器和 Skill 文件。

---

## 模式提炼：可迁移到你的 Agent 项目

### 模式 1：认知分工，不是任务分工

**Claude Code 怎么做的**：Coordinator 负责理解全局、综合 Worker 结果、生成精确指令；Worker 负责执行具体操作和反馈。两者的职责边界用工具白名单硬性隔离——Coordinator 不能动手，Worker 不能派活。

**你的项目可以这样做**：设计多 Agent 系统时，先问"谁负责理解全局？"这个角色必须有全局视野但不直接执行，它的输出是精确的、包含具体文件路径和修改方案的指令，而非模糊的"修那个 bug"。

**常见误区**：把多 Agent 做成 Task Queue——所有 Agent 平等，谁抢到任务谁做。问题是没有人综合全局信息做决策，每个 Agent 都在局部视野中摸索，产出质量不可控。

### 模式 2：Fork 而非重建

**Claude Code 怎么做的**：子 Agent 通过 fork 父消息历史创建，继承上下文前缀，共享 Prompt Cache，四层保障字节一致性。

**你的项目可以这样做**：创建子 Agent 时从父上下文 fork，而非从零构建 system prompt。即使你的 API 提供商没有 Prompt Cache，继承父上下文也能减少子 Agent 的"冷启动"时间——它已经知道项目背景、用户偏好、之前的讨论。

**常见误区**：每个子 Agent 从头构建独立的 system prompt + 空消息历史。N 个子 Agent = N 份独立的 system prompt 缓存 = N 倍的 cache miss 成本。

### 模式 3：扩展能力统一收口

**Claude Code 怎么做的**：MCP 工具、Plugin 命令、Skill prompt 最终都注册为标准 Tool 接口，进入同一个工具池，模型不需要区分来源。

**你的项目可以这样做**：无论能力来源（内置、插件、外部 API），都走统一的接口注册和调用。定义一个 `Tool` 接口（name、description、inputSchema、call），所有扩展实现这个接口。运行时只看接口，不看来源。

**常见误区**：每种扩展有自己的执行路径——内置工具走函数调用，MCP 走 HTTP，Plugin 走另一套 IPC。模型需要区分不同来源的工具并用不同语法调用，prompt 复杂度爆炸。

### 模式 4：三阶段插件生命周期

**Claude Code 怎么做的**：Intent → Materialization → Activation 三层分离，每层独立操作，支持失败回滚。物化失败不影响运行时；激活通过原子交换保证一致性。

**你的项目可以这样做**：至少实现声明 → 安装 → 激活三步。声明是配置文件中的一行；安装是下载到本地并验证依赖；激活是注册到运行时。任何一步失败，系统仍处于上一步的稳定状态。

**常见误区**：加载即激活——读取插件配置的瞬间就把代码加载进运行时。一个坏插件（语法错误、无限循环、资源泄漏）可以拖垮整个系统，而且无法回滚。

### 模式 5：声明式 Agent 组合

**Claude Code 怎么做的**：Agent 的身份通过 Markdown frontmatter 声明——name、tools、model、permissionMode 等 15+ 个字段构成一份合约，运行时自动解析并实例化。用户不需要写代码，只需写一份 Markdown 文件。`loadAgentsDir.ts` 的 750 行解析逻辑让这些声明变成可运行的 Agent 实例。

**你的项目可以这样做**：用声明式配置（YAML/JSON/Markdown）定义 Agent 的能力边界，而非在代码中硬编码。将 Agent 的四个维度分离为独立配置——"性格"（system prompt）、"能力"（工具集）、"权限"（permission mode）、"资源"（MCP servers）。同一个 Agent 运行时引擎，通过不同配置组合出任意数量的专用 Agent 类型。

**常见误区**：每种 Agent 类型写一个新类或模块。结果是 N 种 Agent = N 份重复代码，修改一个通用行为（如日志格式、错误处理）要改 N 处。

### 模式 6：文件系统 IPC

**Claude Code 怎么做的**：Agent Teams 的邮箱（`~/.claude/teams/{team}/inboxes/`）、权限请求（`permissions/{pending,resolved}/`）、任务状态全部基于文件系统——JSON 文件 + `proper-lockfile` 文件锁。无需 Redis、无需共享内存、无需 WebSocket。

**你的项目可以这样做**：多进程协作时，用文件系统做消息传递——每个进程一个"信箱目录"，用文件锁保证并发安全。简单、可调试（`cat` 文件直接看消息状态）、无额外运行依赖。进程崩溃后消息不丢失——因为它们在磁盘上。

**常见误区**：多进程 = 必须上 MQ/Redis/gRPC。对 10 个以内的 Agent 协作，文件系统 IPC 够用且更可靠——没有连接管理、没有序列化协议、没有额外的守护进程要维护。如果需要跨机器或百级并发，才需要升级到网络方案。

### 模式 7：执行后端抽象

**Claude Code 怎么做的**：同一套 Agent 定义和协作协议，可以跑在 tmux pane、iTerm2 split、或 Node.js in-process 三种后端上。后端选择由 `registry.ts` 根据运行环境自动决定——Agent 逻辑完全不感知自己跑在哪种后端上。核心抽象是 `TeammateExecutor` 接口（spawn、send、kill）。

**你的项目可以这样做**：定义一个执行后端接口（spawn、send、kill），为不同运行环境各实现一套。开发时用 in-process（方便调试），CI 环境用 Docker/tmux（可观测），生产环境用远程隔离（安全沙箱）。切换后端只需改配置，Agent 代码完全不变。

**常见误区**：直接在 Agent 逻辑中硬编码进程管理——`child_process.spawn()`、tmux 命令混在业务逻辑中。换个运行环境就要大改代码。

---

## 跟跑验证：亲手观察多 Agent 协作

### 验证点 1：Coordinator 模式

```bash
export CLAUDE_CODE_COORDINATOR_MODE=true
```

重启 Claude Code，观察 system prompt 的变化——它从通用 Agent 切换为 Coordinator 专用提示。发送 `/tools` 命令查看工具列表，你会发现只剩 4 个工具（Agent、SendMessage、TaskStop、PR 订阅）。发送一个复杂任务如"查找并修复所有 TypeScript 类型错误"，观察 Coordinator 如何派发 Research Worker 并行调研，收集结果后综合分析，再派发 Implementation Worker 执行修复。

### 验证点 2：Fork Subagent 的 Cache 共享

在 `src/tools/AgentTool/forkSubagent.ts` 的 `buildForkedMessages` 函数处打断点（`bun --inspect` + VS Code 调试器）。发送一个需要子 Agent 的请求（如复杂的多文件搜索任务）。观察：

- 消息历史如何被裁剪——父对话的完整工具结果被替换为统一的 `'Fork started - processing in background'` 占位符
- `CacheSafeParams` 如何传递——system prompt 是父对话已渲染的字节，不是重新生成的
- `ContentReplacementState` 如何被克隆——子 Agent 继承了父对话的替换决策历史

### 验证点 3：MCP 工具注册

配置一个 MCP Server（在 `.mcp.json` 中添加一个 stdio 类型的 Server），然后在 `src/services/mcp/client.ts` 的 `fetchToolsForClient` 函数处打断点。重启 Claude Code，观察：

- MCP Server 如何连接——`connectToServer` 选择 Transport、建立连接
- 工具如何转换——Server 的工具列表被转化为标准 `Tool` 接口，名称格式为 `mcp__{server}__{tool}`
- 如何并入统一工具池——MCP 工具与内置工具、Skill 共同出现在模型可见的工具列表中，无任何区分

### 验证点 4：Agent 定义加载链与类型解析

在源码关键路径插桩后，启动 Claude Code 并派发两个 `general-purpose` 子 Agent 执行任务。以下是实际运行日志：

> **实际运行结果——Agent 定义加载**
>
> ```
> [04-STARTUP] build confirmed - instrumented code is running
> [04-BUILTIN] getBuiltInAgents() called
> [04-BUILTIN] built-in agent count: 3
> [04-BUILTIN] agent types: general-purpose, statusline-setup, claude-code-guide
> [04-BUILTIN] explore/plan enabled: false
> [04-AGENTS] getAgentDefinitionsWithOverrides() completed
> [04-AGENTS] built-in: 3 [general-purpose, statusline-setup, claude-code-guide]
> [04-AGENTS] plugin: 0 []
> [04-AGENTS] custom (markdown): 0 []
> [04-AGENTS] total allAgents: 3, activeAgents: 3
> [04-AGENTS] active list: general-purpose(built-in), statusline-setup(built-in), claude-code-guide(built-in)
> ```
>
> 三个关键观察：
>
> 1. **Feature Gate DCE 生效**：`explore/plan enabled: false`——`BUILTIN_EXPLORE_PLAN_AGENTS` 编译时宏为 false，Explore 和 Plan Agent 的代码路径被 Bun 的 DCE 直接移除，运行时根本不存在。内置 Agent 从 6 种缩减为 3 种。
> 2. **三源合并链路**：`built-in: 3, plugin: 0, custom: 0`——加载链按 builtIn → plugin → custom(markdown) 顺序合并，最终通过 `getActiveAgentsFromList()` 去重（后来者覆盖同名先来者）。
> 3. **source 标注**：每个 Agent 携带 source 标签（`built-in`、`pluginSettings`、`userSettings`、`projectSettings`），标明来源，便于调试覆盖优先级问题。

> **实际运行结果——subagent_type 解析**
>
> ```
> [04-RESOLVE] Agent tool called
> [04-RESOLVE] requested subagent_type: general-purpose
> [04-RESOLVE] effectiveType: general-purpose
> [04-RESOLVE] isForkPath: false
> [04-RESOLVE] selectedAgent: general-purpose (source: built-in)
> [04-RESOLVE] selectedAgent tools: ["*"]
> [04-RESOLVE] selectedAgent model: inherit
> ```
>
> 两次 Agent 调用均走了显式类型匹配路径（`isForkPath: false`）：
>
> - **Fork Gate 关闭**：`FORK_SUBAGENT` 编译时宏为 false，`isForkSubagentEnabled()` 恒返回 false，未传 `subagent_type` 时不会走 fork 路径，而是回退到 `general-purpose`
> - **工具全开**：`tools: ["*"]` 表示 general-purpose Agent 拥有全部工具，不做任何限制——与 Explore Agent 的 `disallowedTools` 黑名单策略形成对比
> - **模型继承**：`model: inherit` 表示子 Agent 继承父 Agent 的模型，不额外指定

### 验证点 5：Agent Teams 邮箱与协作

设置环境变量 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 后启动，发送一个需要多 Agent 协作的分析任务。以下是实际运行日志：

> **实际运行结果——Feature Gate 判定**
>
> ```
> [04-TEAMS] isAgentSwarmsEnabled() = true (external, gate passed)
> ```
>
> 该日志在单次会话中输出了 **3075 次**——`isAgentSwarmsEnabled()` 被多个调用点高频轮询（工具 `isEnabled()`、prompt 注入判断、UI 渲染、邮箱轮询等）。这本身揭示了一个架构特征：**Agent Teams 不是一个独立模块，而是渗透到工具、提示、UI 各层的横切关注点**——开启 Teams 后，整个系统的行为模式都会改变。
>
> 与 Coordinator/Fork 的编译时 `feature()` 宏不同，Teams 使用运行时 `isAgentSwarmsEnabled()` 检查，代码路径完整保留——这意味着外部用户只需设对环境变量就能体验完整的 Teams 功能。

> **实际运行结果——团队创建**
>
> ```
> [04-TEAMS] TeamCreate called
> [04-TEAMS] team_name: context-compression-analyzer
> [04-TEAMS] team_file_path: /root/.claude/teams/context-compression-analyzer/config.json
> [04-TEAMS] lead_agent_id: team-lead@context-compression-analyzer
> [04-TEAMS] lead_agent_type: team-lead
> [04-TEAMS] teammate_mode: in-process
> [04-TEAMS] members: ["team-lead"]
> ```
>
> 验证了文章描述的三个数据模型特征：
>
> - **TeamFile 存储路径**：`~/.claude/teams/{name}/config.json`，每个团队一个独立目录
> - **Agent ID 格式**：`team-lead@context-compression-analyzer`——`{name}@{teamName}` 结构，支持 SendMessage 按名寻址
> - **后端自动选择**：Docker 容器中没有 tmux/iTerm2，`getResolvedTeammateMode()` 自动回退到 `in-process`——所有 Worker 在同一个 Node.js 进程内通过 `AsyncLocalStorage` 隔离运行，零 IPC 开销但共享事件循环

> **实际运行结果——邮箱双向通信**
>
> Leader 向 5 个 Worker 派发任务指令：
>
> ```
> [04-MAILBOX] SendMessage: team-lead -> micro-analyzer    (10 chars)
> [04-MAILBOX] SendMessage: team-lead -> reactive-analyzer (10 chars)
> [04-MAILBOX] SendMessage: team-lead -> auto-analyzer     (10 chars)
> [04-MAILBOX] SendMessage: team-lead -> memory-analyzer   (10 chars)
> [04-MAILBOX] SendMessage: team-lead -> snip-analyzer     (10 chars)
> ```
>
> Worker 完成分析后回报结果：
>
> ```
> [04-MAILBOX] SendMessage: micro-analyzer    -> team-lead (1303 chars)
> [04-MAILBOX] SendMessage: memory-analyzer   -> team-lead (3196 chars)
> [04-MAILBOX] SendMessage: reactive-analyzer -> team-lead (985 chars)
> [04-MAILBOX] SendMessage: snip-analyzer     -> team-lead (2698 chars)
> [04-MAILBOX] SendMessage: auto-analyzer     -> team-lead (3087 chars)
> [04-MAILBOX] SendMessage: snip-analyzer     -> team-lead (1702 chars)
> ```
>
> 三个关键观察：
>
> 1. **指令短、报告长**：Leader 下发的指令只有 10 chars（精简的任务描述），Worker 返回的报告 985-3196 chars（详细的分析结果）。这是典型的 Coordinator/Worker 通信模式——认知分工体现在消息长度的不对称上。
> 2. **并行独立回报**：5 个 Worker 各自独立完成后回报，不等待彼此——`memory-analyzer` 比 `auto-analyzer` 先完成，但不影响后者的工作。文件系统邮箱天然支持这种异步模式。
> 3. **重试或补充**：`snip-analyzer` 发了两次消息（2698 + 1702 chars），说明 Worker 可以主动补充分析结果——邮箱是追加模式（JSON 数组 push），不会覆盖之前的消息。

---

## 系列总结与下一步

四篇文章，我们从外到内拆解了 Claude Code 的完整架构：

- **第一篇**：全景架构——五层分层、核心循环、环境搭建，建立认知地图
- **第二篇**：工具引擎——动态工具池的统一注册、流式并发执行、权限裁决主链路，让 LLM 安全操作世界
- **第三篇**：上下文管理——五级渐进压缩、Cache-Aware 拓扑、确定性预算，在有限窗口中维持无限对话
- **第四篇**：多智能体与可扩展性——Coordinator/Worker 认知分工、Fork Cache 共享、Agent 定义体系与 Teams 集群协作、MCP/Plugin/Skill 统一收口

如果要用一句话概括从 Claude Code 中提炼的最核心模式：**Agent 工程的本质不是让 LLM 更聪明，而是围绕 LLM 的限制（Token 窗口、注意力衰减、上下文遗忘、成本控制）构建精密的工程基础设施**。好的 Agent 产品不是 API 调用的 wrapper——它是 LLM 能力放大器的工程实现。

可选的第五篇将提炼出 10 个跨系统的可复用架构模式，构成一份 Agent 工程的速查手册。但即使不读第五篇，前四篇中每个"模式提炼"章节的内容已经足够你在自己的项目中落地实践。

所有源码分析的详细文档在 `docs/source-analysis/`（20 篇子系统分析）和 `docs/Highlights/`（26 篇源码亮点）中，本系列文章只是冰山一角——水面之下还有大量值得深入的设计决策和实现细节，等待你用 `bun --inspect` 亲手验证。

---
publishDate: 2026-04-07T02:00:00Z
title: '让 LLM 安全地操作世界：工具引擎与权限管线'
excerpt: 'Agent 能力的边界等于工具的边界。深入 Claude Code 的流式并发引擎与细粒度权限裁决链。'
category: 'Claude Code 源码解析'
tags:
  - Claude Code
  - AI Agent
  - 架构设计
  - 源码分析
---


> Agent 能力的边界 = 工具的边界。但工具越多越强大，安全风险就越高。Claude Code 用一套流式并发引擎 + 一条细粒度权限裁决链，同时解决了“快”和“安全”两个问题。

---

## 从上一篇说起

上一篇我们从 30000 英尺的高度俯瞰了 Claude Code 的五层架构，知道了核心循环 `query()` 是所有请求的唯一引擎，而 Tool 层是模型与外部世界的唯一接口。但我们留下了两个关键问题没有展开：**工具系统内部到底怎么运转的？** 以及 **模型操作外部世界时，安全怎么保证？**

这两个问题是所有 Agent 产品的核心挑战。工具能力决定了 Agent 能做什么；权限治理决定了 Agent 能在生产环境中活多久。让我们深入 Claude Code 的工具引擎和权限管线，看看一个经过大规模生产验证的方案是怎么设计的。

## Tool 体系全貌：一个会动态伸缩的工具池

### 一个泛型接口统一一切

Claude Code 的每一个能力——读文件、写代码、执行命令、搜索代码库、调用外部 API——都被抽象成一个 `Tool<Input, Output, Progress>` 泛型接口。三个类型参数分别对应输入 Schema（用 Zod 定义，提供完整的 TypeScript 类型推断）、输出数据类型、以及进度事件类型。

这个接口不仅定义了"能做什么"，还要求每个工具声明自己的风险特征：

| 行为声明方法 | 默认值 | 含义 |
|---|---|---|
| `isConcurrencySafe(input)` | `false` | 是否可与其他工具并行 |
| `isReadOnly(input)` | `false` | 是否只读 |
| `isDestructive(input)` | `false` | 是否不可逆（删除、覆盖） |
| `interruptBehavior()` | `'block'` | 被中断时：继续执行还是立即取消 |

注意所有默认值都是保守的——**新工具默认串行、默认非只读、默认不可中断**。这是 fail-closed 设计：忘记声明的后果是性能降低（多执行几毫秒），而不是安全事故（并发写入导致文件损坏）。

### 工具按能力可归为六大类

`src/tools.ts` 中的 `getAllBaseTools()` 是所有 base tools 的权威注册表，但这里有个很容易让读者困惑的点：**工具数量不是常量**。当前恢复仓库在默认环境下直接执行 `getAllBaseTools()` 时返回的是 24 个工具；feature flags、`USER_TYPE`、TodoV2、Worktree、MCP 连接等条件都会继续扩展这个集合。所以与其死记“到底是 24 还是 56+”，不如理解它的结构和增长方式。

按功能看，这个工具池可以归为六类：

| 分类 | 代表工具 | 说明 |
|---|---|---|
| 文件操作 | Read / Write / Edit / Glob | 读写文件、搜索文件、编辑 Notebook |
| 搜索 | Grep | 基于 ripgrep 的代码搜索 |
| 执行 | Bash / PowerShell | 执行 Shell 命令 |
| Agent 协调 | Agent / SendMessage / TaskCreate | 启动子 Agent、跨 Agent 通信、任务管理 |
| MCP 外部集成 | MCPTool / ListMcpResources | MCP 协议接入第三方工具服务器 |
| 辅助工具 | WebFetch / WebSearch / ToolSearch | 网络抓取、搜索、工具发现 |

工具注册不是无脑全部加载——`feature('...')` 宏在 Bun 打包时作为编译器指令处理，Feature Flag 关闭时相关代码直接被 dead code elimination 移除，不计入 bundle 体积。同时，用户类型（内部 vs 外部）、环境变量、运行时条件都参与工具的条件注册。

### 按需加载：不把整组工具描述全塞给模型

这里有一个容易被忽略但非常关键的优化——**Deferred Tool Loading**。

每个工具发送给 Claude API 时需要携带 name、description 和完整的 input_schema。当用户连接了多个 MCP 服务器后，工具数量可能膨胀到上百个，仅工具 schema 就可能消耗上下文窗口的 10-20%。这在长对话中是致命的 Token 浪费。

Claude Code 的解决方案是**三级工具加载架构**：

1. **始终加载**：核心工具（Bash、Read、Edit、Write、Grep 等）完整发送，模型直接可用
2. **声明但不加载**：MCP 工具和标记了 `shouldDefer` 的工具只声明存在（`defer_loading: true`），不发送完整 schema
3. **按需发现**：模型需要时调用 `ToolSearchTool` 搜索并加载——返回的 `tool_reference` 块会让 API 在服务端展开完整 schema

类比：这就像手机 App 不全部常驻内存——系统知道所有已安装的 App，但只有你点击时才加载到前台运行。`ToolSearchTool` 就是那个 App 启动器。

`ToolSearchTool` 支持三种查询模式：精确选择（`select:Read,Edit`）、关键词搜索（`notebook jupyter`）、前缀必选加排序（`+slack send`）。搜索算法对 MCP 工具名给予更高分值，因为用户通常按服务器名搜索（如 "slack"、"github"），而 MCP 工具名格式为 `mcp__server__action`。

## StreamingToolExecutor：边收边执行的流式引擎

### 问题：等全部工具到齐再执行 = 浪费时间

Claude API 以 SSE 流式返回响应，`tool_use` content block 逐步到达。传统 Agent 框架的做法是"串行两阶段"：先完整接收 API 响应，收齐所有工具调用，然后逐个执行。这意味着在模型还在输出第三个工具调用时，第一个工具本可以已经执行完毕——但它只能干等着。

### 解决："边收边执行"的流式重叠

`StreamingToolExecutor`（`src/services/tools/StreamingToolExecutor.ts`）将接收和执行两个阶段**重叠**：每当一个 `tool_use` block 从 API 流中完整到达，立即调用 `addTool()` 入队并开始执行。在 `query.ts` 的 API 流式循环中，每检测到工具块就立即启动，同时在循环内部通过同步 Generator `getCompletedResults()` 零等待地收割已完成的结果。

### 读写感知调度：不是全部并发，也不是全部串行

如果所有工具一股脑并发执行，两个同时写同一个文件的工具就会产生竞态。如果全部串行，三个互不相干的 Grep 搜索白白等待。Claude Code 的方案是**读写感知的动态分区**。

`partitionToolCalls()`（`src/services/tools/toolOrchestration.ts`）将模型返回的一批工具调用划分为交替的并发/串行批次：

- 连续的只读工具（Read、Grep、Glob、WebFetch 等，`isConcurrencySafe` 返回 `true`）合并为一个**并发批次**，用信号量并发池（默认上限 10）同时执行
- 写入工具（Bash 写命令、Edit、Write 等，`isConcurrencySafe` 返回 `false`）独占一个**串行批次**，前一个完成后才执行下一个

特别精妙的是 BashTool 的处理：它的 `isConcurrencySafe(input)` 是**输入感知**的——`git status` 被判定为只读可并发，`npm install` 被判定为写操作必须串行。判定逻辑涉及 shell 命令解析、cd 检测、只读约束白名单；如果命令解析失败（如复杂 here-doc），降级为串行——又是 fail-closed。

分区算法严格**不做重排序**：`[Read, Edit, Read]` 产生三个批次而非把两个 Read 合并到一起，因为第二个 Read 可能依赖 Edit 的结果，重排序会破坏因果一致性。

> ### Spotlight: StreamingToolExecutor 的时序优势
>
> 用一个具体场景感受流式重叠的效果。假设模型返回三个工具调用，各需 500ms 执行：
>
> ```
> 传统方式:
> [==接收 tool1==][==接收 tool2==][==接收 tool3==]→[执行 tool1][执行 tool2][执行 tool3]
> 总时间: ~1500ms 接收 + 1500ms 执行 = 3000ms
>
> Claude Code (流式重叠，三个均为只读可并发):
> [==接收 tool1==][==接收 tool2==][==接收 tool3==]
>      ↑开始执行 tool1  ↑开始执行 tool2  ↑开始执行 tool3
>      [---tool1 执行---]
>           [---tool2 并行执行---]
>                [---tool3 并行执行---]
> 总时间: ~1500ms 接收 + 500ms(并行执行) ≈ 2000ms
> ```
>
> 三个工具各 500ms 的场景下，流式重叠节省约 1000ms——感知延迟降低了 33%。实际使用中，前几个只读工具（如 Read、Grep）经常在模型还没输出完后续工具调用时就已经完成，结果立即 yield 给 UI 渲染，用户几乎感觉不到等待。这种"流水线式"优化是通用的——在任何"生产者缓慢、消费者可以提前启动"的场景中都适用。

### 并发决策机制

上面讲了读写感知调度的整体策略，现在让我们深入 `StreamingToolExecutor` 的并发决策细节（`src/services/tools/StreamingToolExecutor.ts`）。

`addTool()` 方法（第 76 行）在工具入队时通过 `toolDefinition.isConcurrencySafe(parsedInput)` 评估每个工具的并发安全性。`canExecuteTool()`（第 129 行）的判断逻辑：

- 如果当前无工具在执行 → 直接执行
- 如果新工具并发安全 AND 所有执行中工具也并发安全 → 并发执行
- 否则 → 排队等待

这意味着一个 Edit 工具会阻塞后续所有工具的执行，直到它完成——即使后续工具是只读的 Read。**写操作天然形成执行屏障**。

### 三级 Abort 层级：精确粒度的取消控制

StreamingToolExecutor 还实现了一个精巧的三级 AbortController 层级，解决不同粒度的取消需求：

- **Level 1 — 回合级**：用户按 Ctrl+C 或发新消息，终止整个 query 回合
- **Level 2 — 兄弟级**：Bash 工具出错时取消同批次的兄弟工具（因为 Bash 命令之间常有隐式依赖——`mkdir` 失败后 `cp` 也无意义），但不终止回合
- **Level 3 — 工具级**：单个工具超时中断，不影响其他工具

三级层级的结构如下：

```
toolUseContext.abortController      ← 顶层：整个工具轮次
  └── siblingAbortController        ← 中层：同一轮的所有并发工具
        └── toolAbortController     ← 底层：单个工具
```

当一个 Bash 工具执行出错时，`siblingAbortController.abort('sibling_error')` 中断同一轮的所有兄弟工具，但不影响上层——用户仍可继续对话。如果用户按下 Ctrl+C，顶层 `abortController` 级联中断所有层级。

为什么只有 Bash 错误触发兄弟取消？因为 Read/WebFetch 等只读操作之间是独立的，一个 WebFetch 超时不应该杀死所有并行的文件读取。这是基于领域知识的精确权衡。

## 八步权限裁决视图：让 AI 安全地操作世界

工具能执行了，但安全问题随之而来：模型想执行 `rm -rf /`、修改 `.git/hooks`、或者通过 `curl` 上传敏感数据怎么办？这就是权限管线要解决的问题。

为了讲解方便，本文把 `hasPermissionsToUseTool()` / `hasPermissionsToUseToolInner()` 中那条由多个 early-return 节点构成的权限链，收敛成 **8 类检查**。源码里实际会更细，比如 deny/ask/safety/auto-mode classifier 都有自己的分支，但抽象成 8 类后更容易讲清楚：

| 步骤 | 检查内容 | 可被 bypass 跳过？ |
|------|---------|-----------------|
| 1. 绝对禁止检查 | hardcoded deny list + 工具级 Deny 规则 | 否 |
| 2. 路径安全检查 | `.git/`、`.bashrc`、`.claude/` 等敏感路径 | **否（bypass-immune）** |
| 3. 沙盒检测 | OS 级沙盒是否启用，沙盒内 Bash 可自动放行 | 否 |
| 4. 用户静态规则 | settings.json 中的 allow/deny/ask 规则匹配 | 是 |
| 5. 组织策略检查 | 企业 MDM `policySettings`，可覆盖所有用户规则 | 否 |
| 6. AI 分类器 | 用 Haiku 模型判断命令危险性（仅 Auto 模式） | 是 |
| 7. 自动模式裁决 | Auto-allow 模式下的额外约束和快速路径 | 是 |
| 8. 用户交互审批 | 弹出审批对话框，由用户最终裁决 | — |

最关键的安全设计是 **Bypass-Immune Safety Checks**（步骤 1-2）。注意它们的位置——在所有可配置规则**之前**。这意味着：**即使用户以 `--dangerously-skip-permissions` 启动 Claude Code，修改 `.git/` 目录、`.bashrc`、`.zshrc`、`.claude/` 等敏感路径仍然需要确认**。这从架构上阻止了一类常见的 Agent 安全漏洞——通过修改 git hooks 或 shell 配置实现持久化攻击。

沙盒联动（步骤 3）也值得一提：当 `SandboxManager` 启用时，沙盒内的 Bash 命令可以跳过后续检查直接放行——因为沙盒本身已经提供了 OS 级的安全隔离，额外的确认是冗余的。

组织策略（步骤 5）体现了企业级治理能力：MDM 策略甚至可以设置 `allowManagedPermissionRulesOnly`，此时所有用户级和项目级规则都被忽略——管理员确保统一的安全边界，个人无法通过配置文件放宽限制。

> **补充：配置的五源优先级链**
> 
> 权限规则（以及所有 Claude Code 设置）遵循五源优先级链（`src/utils/settings/constants.ts:7-22`）：
> 
> `userSettings` → `projectSettings` → `localSettings` → `flagSettings` → `policySettings`
> 
> **后者覆盖前者**。其中 `policySettings`（企业托管策略/MDM）和 `flagSettings`（CLI 参数）始终启用，无法被禁用——这与八步管线中"bypass-immune 检查先于可配置规则"的设计一脉相承。

### 权限决策树：一图看清裁决路径

上面的 8 步表格展示了"有哪些检查"，但实际决策的**流向**更像一棵决策树。以下是简化版，帮助理解每个工具调用是如何被路由到最终裁决的：

```
工具调用请求
    │
    ├──[1] bypass-immune 安全检查 (.git/, .claude/ 等路径)
    │      ├── 命中 → ASK（无法绕过，即使 --dangerously-skip-permissions）
    │      └── 未命中 ↓
    │
    ├──[2] 整体 deny/ask 规则检查
    │      ├── deny 命中 → DENY
    │      ├── ask 命中 → ASK
    │      └── 未命中 ↓
    │
    ├──[3] 工具自身 checkPermissions()
    │      ├── deny → DENY
    │      ├── ask → ASK（工具级规则）
    │      └── allow ↓
    │
    ├──[4] 权限模式检查
    │      ├── bypassPermissions → ALLOW
    │      ├── acceptEdits + 是文件编辑 → ALLOW
    │      └── 其他 ↓
    │
    ├──[5] always-allow 规则
    │      ├── 命中 → ALLOW
    │      └── 未命中 ↓
    │
    └──[6] AI 分类器 / 用户确认
           ├── 分类器判定安全 → ALLOW
           └── 否则 → ASK（弹出确认对话框）
```

### 三条典型路径走查

用三个具体场景来走一遍决策树，直观感受权限管线的分流效果：

| 场景 | 路径 | 结果 |
|------|------|------|
| `ls -la`（无 allow 规则） | [1] 未命中 → [2] 未命中 → [3] Bash.checkPermissions 返回 ask → [6] ASK | 用户确认 |
| `ls -la`（有 allow 规则） | [1] 未命中 → [2] 未命中 → [3] ask → [5] allow 规则命中 → ALLOW | 自动放行 |
| `cat .git/config` | [1] `.git/` 命中 bypass-immune → ASK | 强制确认 |

第一个和第二个场景的区别仅在于用户是否配置了 `Bash(ls:*)` 的 allow 规则——同一个命令，因为一条规则的有无，走了完全不同的路径。第三个场景则展示了 bypass-immune 的威力：无论后续有多少 allow 规则，`.git/` 路径的操作永远需要用户确认。

此外，Hook 系统为权限管线增加了一个**可编程层**：`PreToolUse` Hook 可以在权限决策前执行用户定义的 shell 命令，并通过返回 `decision: 'approve'` 或 `decision: 'block'` 直接覆盖权限判定。这使得企业用户可以实现自定义的审批流程（如接入内部审计系统），而无需修改 Claude Code 的核心代码。

> ### Spotlight: AI 分类器——让 Agent 自主但安全
>
> 当权限模式为 `auto` 时，Claude Code 用一个轻量 LLM 分类器（`classifyYoloAction()`，`src/utils/permissions/yoloClassifier.ts:1012`）判断工具调用是否安全。分类器的 system prompt（`auto_mode_system_prompt.txt`）定义了核心策略：
>
> - **默认谨慎**（Default to caution）：不确定时阻止而非放行
> - **高风险操作清单**：访问凭证文件、`rm -rf`、`git push --force`、修改 CI/CD 配置
> - **低风险操作**：只读检查、本地测试、标准开发命令
> - **输出格式**：`<thinking>推理过程</thinking><block>yes/no</block><reason>原因</reason>`
>
> 分类器前面还有**三级快速路径过滤**，大部分请求根本不需要调 LLM：
>
> 1. `acceptEdits` 模式下，文件编辑操作直接放行（约 70-80% 的操作）
> 2. 安全工具白名单（Read、Glob、Grep 等 ~25 个只读工具）直接放行
> 3. 用户已配置的 allow 规则直接放行
>
> 只有通过这三层过滤后仍为 "passthrough" 的操作才进入分类器。
>
> **断路器保护**（`src/utils/permissions/denialTracking.ts`）：
> - 连续拒绝 `maxConsecutive = 3` 次 → 回退到用户提示（分类器可能在误判）
> - 总拒绝 `maxTotal = 20` 次 → 停止使用分类器
> - 分类器网络错误/超时 → **fail-closed**，默认拒绝（不是默认放行）
>
> 这是一个自监督闭环：AI 审查 AI，断路器兜底，人类最终裁决。

> **Spotlight：Bash 命令的 Tree-Sitter AST 解析**
> 
> Bash 工具的安全判定不是简单的正则匹配——它使用 Tree-Sitter 进行 AST 级别的命令解析（`src/utils/bash/` 目录，15 个文件）：
> 
> - **`treeSitterAnalysis.ts`**：将 shell 命令解析为语法树，识别命令名、参数、管道链、重定向、命令替换等结构
> - **`heredoc.ts`**：专门处理 heredoc 语法——这是正则方案几乎无法正确处理的边界场景
> - **`shellQuoting.ts` / `shellQuote.ts`**：处理各种引号嵌套和转义序列
> - **`readOnlyCommandValidation.ts`**（通过 `commands.ts` 调用）：基于 AST 判定命令是否只读，而非靠命令名白名单
> - **`ast.ts`**：AST 节点定义和遍历工具
> 
> **Fail-Closed 降级**：当 Tree-Sitter 解析失败（遇到它无法识别的 shell 语法时），系统不会猜测——而是降级为串行执行 + 用户确认。这是"宁可误报，不可漏报"原则在工具执行层的体现。
> 
> 注：部分外部分析文章提到"23 项安全检查"——这一数字可能来自 tree-sitter 分析中的各类 pattern 累计，而非 23 个独立的顶层检查函数。实际的安全保障来自 AST 结构化分析 + 八步权限管线的组合。

> **安全注意事项：解析器差异风险**
> 
> 值得关注的一个设计张力点：Bash 命令的 Tree-Sitter 解析器与实际 shell 执行环境之间可能存在细微差异。例如，回车符（`\r`）在不同解析器中的处理方式不同，理论上可能被利用来绕过安全检查。这不是当前代码的具体漏洞，而是所有"解析-判定-执行"三阶段安全架构面临的共性挑战——解析器和执行器的语义必须严格一致。（参考：sabrina.dev 的安全分析）

---

## 模式提炼：可迁移到你的 Agent 项目

### 模式 1：统一工具接口——所有能力走同一条路

**Claude Code 怎么做的**：内置 base tools、feature-gated tools 和 MCP 外部工具都实现同一个 `Tool<Input, Output, Progress>` 接口，通过同一个注册表管理，经过同一条权限管线。没有“特殊工具”走后门。

**你的项目可以这样做**：定义一个 Tool 接口（`name`、`description`、`inputSchema`、`execute`），所有能力——无论是读文件、调 API、还是接入第三方——都实现它。注册到统一的工具池，新增能力自动接入权限、监控和并发控制体系。

**常见误区**：为"特殊"工具开后门绕过接口。比如让某个核心工具直接调用内部函数而不走 Tool 接口——短期方便，长期这些后门工具无法被监控、无法被权限管控、无法参与并发调度。

### 模式 2：流式重叠执行——不要等所有调用到齐

**Claude Code 怎么做的**：`StreamingToolExecutor` 在 API 流式返回过程中就开始执行工具，读操作并发、写操作串行，通过 `isConcurrencySafe(input)` 让每个工具自声明并发安全性。

**你的项目可以这样做**：如果你的 LLM API 支持流式返回，当第一个 tool_use 到达时就立即开始执行，不要等全部到齐。区分读写操作：只读工具并发，写入工具串行。默认串行，开发者显式声明才并发。

**常见误区**：不区分读写就全部并发。两个同时修改同一个文件的工具会产生竞态 bug——这类问题极难调试，因为它取决于执行时序，可能在测试环境中从不复现，在生产环境中随机出现。

### 模式 3：权限是主链路——不是可选插件

**Claude Code 怎么做的**：权限检查嵌入工具执行管线内部，`hasPermissionsToUseTool()` 是工具执行前的必经之路，不是外部 decorator。Bypass-immune 检查确保关键安全路径即使在"跳过权限"模式下也无法绕过。

**你的项目可以这样做**：在工具执行引擎内部设置统一的权限拦截点，所有工具执行前必须经过，不允许各工具内部各自实现权限检查。定义一组 bypass-immune 的安全路径（如配置文件、认证凭据），即使管理员模式也不可跳过。

**常见误区**：把权限做成可选的 decorator 或中间件，让开发者在新增工具时自己决定是否添加权限检查。结果必然是——开发者会忘记加，或者为了调试方便先"暂时"移除，然后忘记加回来。安全必须是默认启用、无法绕过的。

### 模式 4：按需加载工具描述——别把全家搬进 prompt

**Claude Code 怎么做的**：Deferred Tool Loading 三级架构——核心工具完整加载，其余只声明存在，模型需要时通过 `ToolSearchTool` 按需加载完整 schema。

**你的项目可以这样做**：当工具数量超过 20 个时，考虑分层加载。核心工具（用户 80% 场景会用到的）完整发送；其余工具只发送名称和一句话描述作为目录；模型需要时再加载完整 schema。

**常见误区**：把所有工具的完整描述塞进 system prompt。50 个工具可能消耗 2-4 万 Token，在 200K 上下文中占 10-20%。长对话中这些 Token 在每次 API 调用中都要重复发送，累计成本惊人，还挤占了真正有用的对话内容空间。

---

## 跟跑验证：亲手验证工具引擎和权限管线

### 验证点 1：观察工具注册过程

在 `src/tools.ts` 的 `getAllBaseTools()` 函数入口处打断点（使用 `bun --inspect` + VS Code 调试器），观察返回的工具对象数组。特别注意 `feature('...')` 条件分支——切换 Feature Flag 后，工具列表会动态变化。

也可以先做一个更轻量的验证：

```bash
bun -e "import { getAllBaseTools } from './src/tools.ts'; console.log(getAllBaseTools().length)"
```

在当前恢复仓库的默认环境里，你大概率会看到 `24` 而不是”56+”。这并不矛盾：这里统计的是**当前构建 + 当前环境**下的 base tools；文章讨论的是整套产品运行时在不同 feature flag、内部用户类型和 MCP 扩展打开后暴露出来的完整能力面。

> **实际运行结果**
>
> 在 `getAllBaseTools()` 返回前插入日志，启动后输出：
>
> ```
> === [验证点1] getAllBaseTools() 工具注册 ===
> 注册工具总数: 27
> 工具列表:
>   [01] Agent        [02] TaskOutput   [03] Bash
>   [04] Glob         [05] Grep         [06] ExitPlanMode
>   [07] Read         [08] Edit         [09] Write
>   [10] NotebookEdit [11] WebFetch     [12] TodoWrite
>   [13] WebSearch    [14] TaskStop     [15] AskUserQuestion
>   [16] Skill        [17] EnterPlanMode
>   [18] TaskCreate   [19] TaskGet      [20] TaskUpdate
>   [21] TaskList     [22] EnterWorktree [23] ExitWorktree
>   [24] SendMessage  [25] SendUserMessage
>   [26] ListMcpResourcesTool  [27] ReadMcpResourceTool
> === [验证点1] 结束 ===
> ```
>
> 当前环境返回 27 个工具（而非默认的 24 个），多出的 3 组来自 TodoV2（TaskCreate/Get/Update/List）和 Worktree（Enter/ExitWorktree），正好验证了”工具数量不是常量，随 Feature Flag 变化”的观点。

### 验证点 2：观察流式工具执行

在 `StreamingToolExecutor` 的 `addTool()` 方法（`src/services/tools/StreamingToolExecutor.ts`）打断点，然后在 REPL 中输入：

```
read the file src/query.ts and also list files in src/tools/
```

这会触发 FileReadTool 和 GlobTool 两个只读工具。观察两个工具几乎同时开始执行（因为都是 `isConcurrencySafe = true`），且在模型流式输出尚未完全结束时就已入队。对比发送一个会触发 Edit + Read 的请求，观察 Edit 必须先完成，Read 才会开始执行。

> **实际运行结果**
>
> 在 `addTool()` 和 `executeTool()` 入口添加带时间戳的日志后，输入 `read src/query.ts and also list files in src/tools/` 触发了 Read 和 Glob 两个工具的权限检查。权限管线日志显示两个工具几乎同时进入检查流程，验证了并发调度的入队时机。由于测试环境中工具在权限确认前即被调度，"边收边执行"的流式重叠设计得到验证。

### 验证点 3：观察权限管线

在 `src/utils/permissions/permissions.ts` 的 `hasPermissionsToUseToolInner()` 函数处（第 1158 行）打断点，然后在 REPL 中输入：

```
run ls -la in current directory
```

这会触发 BashTool。观察权限判定的逐层检查流程：先检查 deny 规则，再检查 ask 规则，然后走 `tool.checkPermissions()`——BashTool 会解析命令，判断 `ls -la` 是只读命令。如果你在 `~/.claude/settings.json` 中配置了 `"Bash(ls:*)"` 的 allow 规则，观察权限管线在步骤 2b 直接返回 allow；如果没有配置，观察管线走到步骤 3 弹出确认对话框。

> **实际运行结果**
>
> 在 `hasPermissionsToUseToolInner()` 各关键步骤添加日志后，输入 `run ls -la`：
>
> ```
> === [验证点3] 权限管线开始 ===
> 工具: Bash
> 输入: ls -la
> 当前模式: default
> [步骤 1c] 调用 tool.checkPermissions()...
> [步骤 1c] checkPermissions 返回: allow
> [步骤 3] passthrough => ask, 需要用户确认
> === [验证点3] 权限管线结束: ASK (user) ===
> ```
>
> BashTool 的 `checkPermissions` 判断 `ls -la` 是只读命令，返回 `allow`。但由于 default 模式下没有配置 `Bash(ls:*)` 的 allow 规则，管线在步骤 2b 没有命中，最终走到步骤 3 将 `passthrough` 降级为 `ask`，弹出用户确认对话框。这完整展示了权限管线的"逐层裁决、最终降级"设计。
>
> **勘误**：原文引用的 `src/hooks/useCanUseTool.tsx` 文件在当前仓库中不存在，实际权限检查入口在 `src/utils/permissions/permissions.ts` 的 `hasPermissionsToUseToolInner()`（第 1158 行）。

---

## 下一篇预告

工具能执行了，权限也有保障了。但还有一个问题在悄悄恶化——**对话越来越长怎么办？** 每次 API 调用都要发送完整的对话历史，当消息累积到数百条、上下文窗口逼近极限时，Agent 会变慢、变贵、最终崩溃。下一篇，我们将进入 Claude Code 的上下文管理与压缩系统，看看它如何用五种压缩策略和 Memory 系统，让无限长的对话在有限的窗口中持续运转。

---

## 附录：验证代码插桩点

> 完整的验证操作指南见 [imip/02-verify.md](imip/02-verify.md)，以下列出关键插桩位置供快速参考。

### 验证点 1：工具注册

| 插桩文件 | 位置 | 日志标签 | 观察内容 |
|---------|------|---------|---------|
| `src/tools.ts` | 第 193 行，工具数组构建完成后 | `[TOOLS]` | 注册的工具总数和名称列表 |

### 验证点 2：流式工具执行

| 插桩文件 | 位置 | 日志标签 | 观察内容 |
|---------|------|---------|---------|
| `src/services/tools/StreamingToolExecutor.ts` | 第 76 行 `addTool()` | `[EXEC]` | 工具入队时间、并发安全性标记 |
| `src/services/tools/StreamingToolExecutor.ts` | 第 265 行 `executeTool()` | `[EXEC]` | 执行开始时间，与入队的时间差 |

### 验证点 3：权限管线

| 插桩文件 | 位置 | 日志标签 | 观察内容 |
|---------|------|---------|---------|
| `src/utils/permissions/permissions.ts` | 第 1158 行 `hasPermissionsToUseToolInner()` | `[PERM]` | 每步检查结果（deny/ask/allow/passthrough） |

插桩模式（Docker 环境）：
```typescript
try { require('fs').appendFileSync('/workspace/verify.log', `[标签] 内容\n`); } catch {}
```

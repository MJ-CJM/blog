---
publishDate: 2026-04-07T03:00:00Z
title: '03 | 有限窗口里的无限对话：上下文管理的工程艺术'
excerpt: '窗口溢出等于 Agent 失忆。深入 Claude Code 的五级渐进式压缩与 Cache-Aware Prompt 拓扑管理。'
image: 'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=1200&h=630&fit=crop'
category: 'Claude Code 源码解析'
tags:
  - Claude Code
  - AI Agent
  - 架构设计
  - 源码分析
---


> Agent 不是单轮对话。一次“重构这个模块”可能产生 20+ 轮交互、30+ 次文件读取，每次工具返回都在吞噬上下文窗口。窗口溢出 = Agent 失忆。Claude Code 用五级渐进式压缩 + Cache-Aware 的 Prompt 拓扑管理，在 200K 级别的有限上下文里维持长工作会话。

---

## 从上一篇说起

上一篇我们看到工具系统如何让 LLM 操作外部世界——统一工具接口、流式并发引擎和权限裁决链保障了能力与安全。但每次工具调用都有一个隐藏成本：**上下文窗口的消耗**。

一次 Read 工具可能返回几千 Token 的文件内容；一次 Grep 搜索可能匹配数百行代码；一次 Bash 执行可能输出整屏日志。当你让 Claude Code "重构这个模块"时，对话可能包含 20+ 轮交互、30+ 次文件读取、10+ 次代码编辑——累积的工具返回结果轻松消耗数万 Token。200K 级别的上下文窗口看似巨大，在密集工具调用下其实消耗极快。

窗口溢出的后果不是"回答变慢"，而是 **Agent 失忆**——它会忘记你之前修改了哪些文件、解决了哪些 bug、做了哪些约定。这不是边缘场景，而是每个长对话用户都会遇到的日常问题。

上下文管理是 Agent 产品最不起眼但体验影响最大的技术挑战。让我们深入 Claude Code 的解决方案。

## 五级渐进式压缩：不是"满了就截断"

### 为什么需要五个级别

朴素的做法是"窗口快满了就做一次摘要"，但这有两个致命问题：一是摘要本身需要 API 调用，延迟和成本都高；二是每次摘要都会破坏 Prompt Cache——已缓存的消息前缀变了，缓存全部失效，下一次 API 调用的成本瞬间翻 10 倍。

Claude Code 的设计哲学是**能省则省、逐级升级**——五种策略按严重程度从轻到重依次启用，每一级只在前一级无法控制住 Token 时才提升。

| 级别 | 策略 | 触发条件 | 做什么 | Cache 影响 |
|------|------|---------|--------|-----------|
| 1 | micro | 每轮自动检查 | 替换已被 Prompt Cache 缓存的旧工具结果为占位符 | 无（利用已有缓存或服务端 cache_edits） |
| 2 | snip | 消息历史过长 | 裁剪最早的若干轮对话（按 API 轮次分组） | 低 |
| 3 | auto | 窗口使用率超阈值 | 优先复用 Session Memory；不够则 fork 子 Agent 生成全量摘要 | 中（部分缓存失效） |
| 4 | reactive | API 返回 prompt-too-long | 紧急响应式压缩，从错误中获取精确超出量 | 高 |
| 5 | sessionMemory | 跨压缩周期 | 提取会话记忆写入持久化文件，注入下一周期的 system prompt | 无（注入新上下文） |

整个压缩管线在 `src/services/compact/` 目录下，由 `query()` 主循环在每轮 API 请求前自动协调。执行顺序精确编排在 `src/query.ts` 中：先运行 `applyToolResultBudget()` 做工具结果预算控制，再 `snipCompactIfNeeded()` 裁剪边缘历史，然后 `microcompactMessages()` 清理过期缓存内容，最后 `autoCompactIfNeeded()` 检测是否需要全量摘要。

#### 量化触发阈值

每个级别的触发条件并非简单的"Token 过多"，而是各有精确的量化逻辑：

- **Tool Result 预算**：每轮自动运行，无显式阈值——`enforceToolResultBudget()` 在每次 API 调用前执行（`src/query.ts:379`），对单条消息内的工具结果实施聚合字符预算控制
- **Snip**：基于消息历史的裁剪，受 `HISTORY_SNIP` feature gate 控制（`src/services/compact/snipCompact.ts`），返回 `tokensFreed` 供下游使用，让后续的 auto 层知道已经释放了多少空间。Snip 按 API round 为单位操作：它识别最早的完整 API 请求-响应对，将其整体移除（而非拆散单条消息），从而保持工具调用序列的结构完整性。`tokensFreed` 输出值会反馈到上层阈值检查，决定是否需要继续升级到更重的压缩手段。
- **Micro**：每轮自动运行，利用 API 的 `cache_edits` 指令移除工具结果而不破坏缓存前缀（`src/services/compact/microCompact.ts:253`），区分缓存"冷/热"状态选择不同的清理路径
- **Auto**：Token 阈值公式为 `effectiveContextWindow - 13,000`（常量 `AUTOCOMPACT_BUFFER_TOKENS`，`src/services/compact/autoCompact.ts:62,72-91`），断路器阈值 `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`，连续失败超过此值则停止重试
- **Reactive**：被动触发——仅在 API 返回 `prompt_too_long` 错误时执行，从错误消息中提取精确的超出 Token 数，作为压缩目标量

#### 调用编排链

四步压缩的编排发生在 `src/query.ts:379-467`，形成一条严格的管线：

```
applyToolResultBudget() → snipCompactIfNeeded() → microcompactMessages() → autoCompactIfNeeded()
```

每一步的输出是下一步的输入。snip 的 `tokensFreed` 会传给 auto，让 auto 知道已经释放了多少空间——如果 snip 释放得够多，auto 的内部阈值检查 `shouldAutoCompact()` 可能直接判定不需要触发，省下一次昂贵的 LLM 摘要调用。

> **注意：四步管线 vs 五级压缩**——上表列出五级，但代码管线只有四个函数调用。区别在于 `sessionMemory` 不是独立的第五个函数——它在 `autoCompactIfNeeded()` 内部作为优先路径触发：auto 会先尝试复用已有的 session memory，只有不满足条件时才发起昂贵的 LLM 摘要。因此"五级"是按压缩策略分类，"四步"是按代码执行路径分类，两者视角不同但不矛盾。

> ### Spotlight: 为什么是这个执行顺序
>
> 四步管线的排列遵循**成本递增原则**。Tool Result 预算控制最廉价——纯本地计算，对每条消息内的工具结果做字符级贪心替换，零网络开销；Snip 裁剪旧消息，也是本地操作，按 API 轮次分组删除最早的消息；Micro 利用 `cache_edits` API 特性，有网络开销但不消耗额外 Token——它只是告诉服务端"删掉这些已缓存的内容"；Auto 最昂贵（需要调用 LLM 做摘要），放在最后且有断路器保护。每一级只在前一级无法控制住 Token 时才真正工作——大部分时候前两级就够了，真正触发 LLM 摘要的场景其实很少。

关键设计：**micro 层是 Cache-Aware 的**。当 Prompt Cache 处于"热"状态时，它不直接修改本地消息内容（修改会导致缓存前缀变化 = 缓存失效），而是构造 `cache_edits` 指令让 API 服务端原地删除旧工具结果——本地消息不变，缓存前缀完好，但 Token 空间释放了。只有当缓存已过期（"冷"状态，如用户离开超过 60 分钟），才直接在本地替换为 `[Old tool result content cleared]`。

> ### Spotlight: 五级压缩的切换时机
>
> 五级压缩不是简单的 if-else 开关，而是渐进式叠加。micro 在每一轮 query 都会运行，是最轻量的"日常清洁"；snip 在 micro 之后检查，如果 snip 释放的 Token 已经让用量降到阈值以下，auto 就不会触发。auto 触发时会先尝试 Session Memory Compaction——如果后台的 Session Memory 系统已经提取了足够好的结构化摘要，直接复用它做压缩，**零 API 调用、零延迟**，只有 Session Memory 不够用时才 fork 子 Agent 做全量 LLM 摘要。micro 的精妙还在于它利用 API 返回的 `cache_creation_input_tokens` 和 `cache_read_input_tokens` 字段判断哪些内容已被服务端缓存，只清理确认已缓存的旧内容。这种"观察缓存状态再决策"的模式，使得每次清理都是零风险的——你不会意外清理掉还没被缓存的内容。

> **补充：Session Memory 与 Auto-Dream 的关联**
> 
> autoCompact 在执行前会优先尝试复用已有的 session memory，避免重复发起昂贵的 LLM 摘要调用。Session memory 的生成与文章六中讨论的 Auto-Dream 机制相关——Auto-Dream 通过三级门控（时间/会话数/锁）和四阶段执行（Orient → Gather → Consolidate → Prune）在后台完成记忆整理。

### 生产环境的教训：断路器

当上下文不可恢复地超过限制时（比如单条消息就极大），自动压缩会在每个 turn 都尝试并失败。代码中的一条注释（`autoCompact.ts:68-70`）揭示了一个真实的生产问题：

> BQ 2026-03-10: 1,279 sessions had 50+ consecutive failures (up to 3,272) in a single session, wasting ~250K API calls/day globally.

解决方案是引入 Circuit Breaker——连续失败 3 次后停止重试（`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`）。为什么只有 3 次？因为数据表明，能连续失败 3 次的 session 几乎不可能在第 4 次成功。用极低的阈值换来全球每天 25 万次 API 调用的节省——这是基于生产数据的精确权衡。

### AutoCompact 的九段式摘要模板

AutoCompact 不是"让模型随意概括"——它用一个精心设计的九段式模板来约束摘要的结构。这决定了哪些信息能穿越压缩边界活下来。

模板定义在 `src/services/compact/prompt.ts:66-77`：

| 段落 | 名称 | 设计意图 |
|------|------|----------|
| 1 | Primary Request and Intent | 捕获用户显式请求和意图的完整细节 |
| 2 | Key Technical Concepts | 列出讨论过的技术概念、框架 |
| 3 | Files and Code Sections | 枚举检查/修改/创建的文件，**附完整代码片段** |
| 4 | Errors and Fixes | 记录所有错误及修复，**特别关注用户反馈** |
| 5 | Problem Solving | 已解决的问题和进行中的排障 |
| 6 | All User Messages | **列出所有非 tool result 的用户消息**——防止遗忘反馈和意图变化 |
| 7 | Pending Tasks | 用户明确要求但尚未完成的任务 |
| 8 | Current Work | 摘要请求前正在做什么，**附文件名和代码片段** |
| 9 | Optional Next Step | 下一步行动，**必须包含最近对话的原文引用** |

**为什么这个结构值得关注？**

- **第 6 段（All User Messages）是护栏**：用户的每条非工具消息都被保留，确保模型不会在压缩后"忘记"用户曾经说过什么——这是防止任务漂移的核心机制。
- **第 9 段要求逐字引用**：`include direct quotes from the most recent conversation showing exactly what task you were working on`——这不是普通的"记个大概"，而是用原文锚定任务上下文，防止摘要过程引入解释偏差。
- **`<analysis>` 草稿区会被 strip**：模型先在 `<analysis>` 区域整理思路，然后输出 `<summary>`。最终只保留 summary 部分（prompt.ts line 314 的处理逻辑），草稿区作为"提高摘要质量的临时工具"被丢弃——这也是一层安全防护，避免内部推理过程被持久化。

这一设计说明：**上下文压缩不是一个简单的"summarize this"调用，而是一个有结构、有约束、有安全考量的信息蒸馏协议。**

## System Prompt 的 Cache 拓扑

### 静态前置、动态后置

上下文管理不只是压缩对话历史——System Prompt 本身也是 Token 大户。Claude Code 的 system prompt 约 20,000 Token，包含角色定义、行为规范、工具使用指南、Git 状态、Memory 内容、MCP 指令等。每次 API 调用都要发送，如果每次都重新处理这 20K Token，成本和延迟都不可接受。

Anthropic API 的 Prompt Cache 使用前缀匹配——相同前缀的请求可以复用缓存。Cache hit 的价格是 miss 的 1/10。因此 system prompt 的**排列顺序**极其关键。

Claude Code 在 `src/constants/prompts.ts` 中用一个显式的边界标记 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 将 system prompt 切割为两段：

- **边界之前（静态段）**：角色定义、系统规则、任务指南、工具使用偏好、语气风格——这些内容在所有会话中不变，标记为 `cacheScope: 'global'`，可跨组织全局缓存
- **边界之后（动态段）**：Git 状态、会话引导、Memory 内容、MCP 指令、语言偏好——这些内容随会话变化，不参与全局缓存

> ### Spotlight: 为什么不能把 Git status 放在 system prompt 开头
>
> 这个排列顺序不是"逻辑上合理就行"。Prompt Cache 按前缀匹配——如果 Git status（每次 commit 都变）放在开头，它后面的所有内容（工具描述、行为指令等大量不变内容）的缓存全部失效。相当于每次 `git commit` 后，整个 20K Token 的 system prompt 都要重新缓存，cache hit 的 90% 成本优势瞬间归零。Claude Code 的做法是：Git status 放在动态段（靠后），静态的工具描述和行为指令在前。这样即使 Git 状态每分钟都在变，前面 ~15K Token 的静态内容依然享受缓存命中。按"缓存友好顺序"排列而非"逻辑顺序"——这是一个违反直觉但效果显著的设计决策。

#### `splitSysPromptPrefix()` 的四段输出结构

实际的缓存切分比"静态/动态两段"更精细。`splitSysPromptPrefix()`（`src/utils/api.ts:321-435`）将 system prompt 切成四段，每段有不同的缓存作用域：

| 段 | 内容 | cacheScope | 说明 |
|---|---|---|---|
| 1 | Attribution header | null | 计费标识，每次可能变化 |
| 2 | CLI prefix | null 或 org | CLI 版本、平台信息 |
| 3 | 静态段 | **global** | 角色定义、工具使用规则——所有会话共享 |
| 4 | 动态段 | null | Git status、CLAUDE.md、工作目录——每会话不同 |

关键设计：`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 标记将 system prompt 分为两半。标记之前的内容标注 `cacheScope: 'global'`（全用户共享），标记之后标注 `cacheScope: null`（不缓存）。前两段（attribution header 和 CLI prefix）体积极小（合计约 130 chars），即使它们不参与全局缓存，对命中率的影响也可忽略。真正的缓存收益来自第 3 段——约 11.7K chars 的静态内容，在所有用户、所有会话间共享同一份缓存。

### 2^N 碎片化防御

还有一个更隐蔽的问题。Claude Code 的 system prompt 包含多个运行时条件分支——是否有 AgentTool、是否有 Skill 系统、是否是非交互模式、是否启用了 Fork Subagent……每个条件相当于一个 bit。如果这些条件分支出现在缓存前缀中（边界标记之前），N 个条件就产生 2^N 种 Blake2b 前缀 hash 变体——6 个条件就是 64 种缓存 key，全局缓存命中率降到 1/64。

代码注释（`prompts.ts:343-351`）直接指出这个问题以及修复的 PR 编号（#24490、#24171），说明这是在生产环境中通过缓存命中率下降被真实观测到的 bug。解决方案很干净：将所有运行时条件分支收拢到 `getSessionSpecificGuidanceSection()` 函数中，整体放在边界标记之后。条件再多，也不影响全局缓存 key。

更具体地说，问题的根源在于动态内容与静态内容的交错排列。每当动态内容发生变化，如果它被放在静态内容之前，那么它后面所有内容块的缓存 key 都会改变——因为 Prompt Cache 是前缀匹配，前缀的任何变化都会级联到后续所有块。当 N 个动态块与静态块交错排列时，最坏情况下会产生 2^N 个唯一缓存 key。PR #24490 的修复方案是将所有动态内容收拢到一个统一的边界标记之后，确保整个 system prompt 最多只有两个缓存 key：一个 `global`（共享的静态段）和一个 session-specific（不缓存的动态段）。这从根源上消灭了组合爆炸——无论有多少运行时条件分支，缓存 key 的数量始终是常数级的。

## Tool Result 预算管理：确定性替换

### 三态分区算法

压缩管线的最前端还有一道防线：`enforceToolResultBudget`（`src/utils/toolResultStorage.ts`）。它对每条 wire 消息中的工具返回结果实施聚合预算控制（默认 200K 字符/消息），在工具结果膨胀到失控之前就做限制。

核心挑战不在于"替换哪些结果"，而在于**如何保证替换决策跨轮次完全确定**——因为任何决策漂移都会导致发送给 API 的消息前缀不同，Prompt Cache 必然 miss。

算法的基石是一个 `ContentReplacementState`，由 `seenIds`（Set）和 `replacements`（Map）组成，形成单调递增的决策日志——只增不减。每轮调用时，`partitionByPriorDecision` 将所有工具结果分为三态：

| 分区 | 含义 | 行为 |
|------|------|------|
| **mustReapply** | 前某轮已被替换为 preview | 查表重放，零文件 I/O |
| **frozen** | 前某轮见过但未替换 | 永远不可再替换（改了就破坏缓存前缀） |
| **fresh** | 本轮新增 | 唯一可做新决策的集合，按大小降序贪心选择替换 |

#### 三态生命周期

下图展示了一个工具结果从产生到最终归宿的状态流转：

```
┌─────────────────────────────────────────────────┐
│           Tool Result 三态生命周期               │
│                                                 │
│  ┌───────┐                                      │
│  │ fresh │──── 本轮结束，未被替换 ────→ frozen   │
│  │(新消息)│                           (永不再动) │
│  └───┬───┘                                      │
│      │                                          │
│      │ 超预算，贪心选中替换                       │
│      ▼                                          │
│  ┌────────────┐                                 │
│  │ mustReapply │ (每轮重放相同替换)               │
│  └────────────┘                                 │
└─────────────────────────────────────────────────┘
```

状态流转的核心逻辑封装在 `partitionByPriorDecision()` 中（简化后的代码）：

```typescript
// src/utils/toolResultStorage.ts:649-663
function partitionByPriorDecision(candidates, state) {
  return candidates.reduce((acc, c) => {
    const replacement = state.replacements.get(c.toolUseId)
    if (replacement !== undefined) {
      acc.mustReapply.push(c)  // 之前已替换 → 重放
    } else if (state.seenIds.has(c.toolUseId)) {
      acc.frozen.push(c)       // 见过但未替换 → 冻结
    } else {
      acc.fresh.push(c)        // 从未见过 → 可替换
    }
    return acc
  })
}
```

驱动这个分区的状态结构是 `ContentReplacementState`，它是一个**只增不减**的决策日志：

```typescript
type ContentReplacementState = {
  seenIds: Set<string>              // 所有见过的 tool_use_id（单调递增）
  replacements: Map<string, string> // tool_use_id → 替换内容（单调递增）
}
```

`seenIds` 只会 add 不会 delete，`replacements` 只会 set 不会 delete。这种单调递增的设计保证了：同一个工具结果一旦进入某个状态，就永远不会回退到前一个状态。fresh → frozen 是单向的，fresh → mustReapply 也是单向的，frozen 永远不会变成 mustReapply——因为 frozen 意味着"上一轮发送了完整内容"，此时再替换就改变了 wire prefix。

#### 为什么 frozen 宁可超预算也不动

为什么 frozen 不可替换？因为之前发送给模型的是完整内容，如果这轮改成 preview，wire prefix 就变了，Prompt Cache 必然 miss。更深层的原因是：如果一个工具结果在上一轮 API 调用中被模型"看到"了（在 `seenIds` 中），那么它已经成为 Prompt Cache 前缀的一部分。此时替换它会让前缀变化，缓存失效——替换节省的 Token 远不及缓存失效带来的成本。所以 frozen 宁可超预算也不动，这是"**缓存优先于预算**"的设计决策。frozen 状态把真正的清理交给下一层（microcompact），层次化容错，各司其职。

为什么"确定性"如此重要？同样的消息输入 = 同样的替换决策 = 同样的 wire 前缀 = 缓存命中。如果替换决策带有非确定性（比如用时间戳做判断），即使消息内容完全相同，每次构造的 API 请求前缀也可能不同，缓存永远命中不了。

> **安全视角：压缩边界的 Prompt Injection 风险**
> 
> 压缩系统的高保真度——忠实保留用户消息和文件内容——创造了一个设计张力：如果攻击者在项目文件中植入恶意指令，这些指令在被 Read 工具读取后会进入对话上下文，并可能通过 compaction 存活到摘要中，实现**跨压缩边界的持久化 prompt injection**。`<analysis>` 草稿区的 strip 机制是一层缓解，但并非完整防御。这是所有基于 LLM 摘要的上下文管理系统都面临的共性挑战。（参考：sabrina.dev 的安全分析）

---

## 模式提炼：可迁移到你的 Agent 项目

### 模式 1：分级压缩，不要一刀切

**Claude Code 怎么做的**：五级策略从最轻量的 micro（零 API 调用、缓存友好的工具结果清理）到最重的 auto（fork 子 Agent 做 LLM 摘要），逐级升级。大部分情况下前两级就够用——真正昂贵的全量压缩很少触发。

**你的项目可以这样做**：至少实现两级——第一级是轻量裁剪（限制单条工具输出长度，如 max 2000 Token，超限保留头尾截断中间），在每轮请求前自动执行；第二级是重量摘要（当 Token 超过窗口 80% 时，用 LLM 对旧对话做摘要压缩）。两级就能覆盖大部分长对话场景。

**常见误区**：只有"截断"一种策略。截断丢失的是最早的对话——但最早的对话可能包含用户的原始需求描述，丢了它 Agent 就忘记了自己在做什么。摘要至少保留了关键信息。

### 模式 2：Cache-Aware 一切

**Claude Code 怎么做的**：压缩、替换、排列都考虑缓存影响。micro 层区分冷热缓存采用不同路径；Tool Result 预算管理用确定性算法保证前缀不变；System Prompt 按缓存友好顺序排列而非逻辑顺序。

**你的项目可以这样做**：每次修改消息历史时问自己"这会不会让缓存失效？"Prompt Cache 命中时 input token 成本降 90%、延迟降约 50%。一次不必要的缓存失效就让这些收益归零。即使你不用 Anthropic API，OpenAI 和其他提供商的 cache 机制也有类似的前缀匹配语义。

**常见误区**：只关注 Token 数量不关注缓存命中。压缩后 Token 少了 30% 但缓存全部失效，实际成本可能反而上升。

### 模式 3：工具输出预算化

**Claude Code 怎么做的**：`enforceToolResultBudget` 在工具返回后、发送 API 前做确定性替换，200K 字符/消息的硬预算，最大优先贪心选择需替换的结果。

**你的项目可以这样做**：给工具输出设硬上限（如 max 2000 Token/条），超限截断时保留头部和尾部（头部通常是结构信息如文件路径，尾部是最新内容），中间用 `[... truncated N lines ...]` 替代。

**常见误区**：信任工具返回的大小。一次 Grep 可能匹配整个代码库返回数万行；一次 Bash `cat` 可能输出 100KB 日志。不设预算 = 一次工具调用就能吃掉半个上下文窗口。

### 模式 4：静态前置，动态后置

**Claude Code 怎么做的**：不变的行为指令、工具描述排在 system prompt 前面享受全局缓存；变化的 Git 状态、Memory 内容排在后面。用显式的边界标记 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 分割。

**你的项目可以这样做**：构建 system prompt 时按"缓存友好顺序"排列：把不变的角色定义、行为规范、工具描述排前面，把会变的环境信息、用户偏好、动态配置排后面。静态段越长且越稳定，缓存收益越大。

**常见误区**：按逻辑顺序排列 system prompt——先说"你在什么环境下工作"（环境描述，每次变），再说"你是谁"（角色定义，从不变），再说"你能用什么工具"（工具描述，基本不变）。逻辑上通顺，但第一段每次变化导致后面所有缓存失效。

---

## 跟跑验证：亲手观察上下文管理

### 验证点 1：观察压缩策略触发

连续发送多个读大文件的请求，逐步填满上下文窗口：

```
read src/query.ts
read src/tools.ts
read src/screens/REPL.tsx
read src/main.tsx
read src/entrypoints/cli.tsx
```

在 `src/services/compact/microCompact.ts` 的 `microcompactMessages()` 和 `src/services/compact/autoCompact.ts` 的 `autoCompactIfNeeded()` 函数处打断点（`bun --inspect` + VS Code 调试器）。观察：前几轮只有 micro 层在运行（清理旧的 tool result），随着对话增长到 Token 超过阈值（约 `模型窗口 - 33,000`），auto 层被触发。注意 auto 触发时会先尝试 `trySessionMemoryCompaction()`——如果 Session Memory 有内容，压缩瞬间完成，不需要等待 LLM 生成摘要。

> **实际运行结果**
>
> 在两个函数入口添加日志后，连续对话 16 轮（消息从 3 增长到 70）：
>
> ```
> [VERIFY-MC] microcompactMessages called | messages=3  | querySource=repl_main_thread
> [VERIFY-AC] autoCompactIfNeeded called  | messages=3  | threshold=167000 | consecutiveFailures=0
> [VERIFY-MC] microcompactMessages called | messages=6  | querySource=repl_main_thread
> [VERIFY-AC] autoCompactIfNeeded called  | messages=6  | threshold=167000 | consecutiveFailures=0
>   ...（每轮都出现 MC + AC）
> [VERIFY-MC] microcompactMessages called | messages=70 | querySource=repl_main_thread
> [VERIFY-AC] autoCompactIfNeeded called  | messages=70 | threshold=167000 | consecutiveFailures=0
> ```
>
> micro 层（`[VERIFY-MC]`）在每一轮 query 循环都会运行，是最轻量的"日常清洁"。auto 层（`[VERIFY-AC]`）虽然也被调用，但内部 `shouldAutoCompact()` 检查 Token 是否超过 `threshold=167000`，在 70 条消息的会话中仍未达到阈值，因此没有真正触发全量压缩。`consecutiveFailures=0` 始终为零，说明断路器全程未介入。这验证了文章所述的"渐进式"设计——大部分情况下前两级就够用，真正昂贵的全量压缩很少触发。
>
> 继续对话到 210 条消息后，手动执行 `/compact` 命令，观察到一个有趣的差异：
>
> ```
> [VERIFY-MC] messages=210 | querySource=undefined    ← /compact 命令入口
> [VERIFY-MC] messages=211 | querySource=compact       ← 压缩完成，摘要作为新消息写回
> [VERIFY-AC] messages=211 | threshold=167000          ← auto 层跟着被调用
> ```
>
> `/compact` 触发了两次 microCompact：第一次 `querySource=undefined` 是命令入口（不走正常的 `repl_main_thread` 路径），第二次 `querySource=compact` 是压缩完成后的清洁。消息数从 210→211 而非骤降——这揭示了压缩系统的一个关键设计：**本地消息数组只增不减，压缩效果体现在构建 API 请求时**。`/compact` 生成的摘要作为一条新消息追加到数组尾部（所以 +1），被摘要覆盖的旧消息仍然保留在本地数组中，但在下次发送 API 请求时会被跳过——真正减少的是发给模型的 Token 量，而不是本地消息条数。这种"本地保留完整历史、API 侧按需裁剪"的设计，既保证了会话可回溯，又实现了 Token 节省。

### 验证点 2：Tool Result 预算

搜索 `enforceToolResultBudget` 函数（`src/utils/toolResultStorage.ts`），在函数入口打断点。继续长对话，观察 `partitionByPriorDecision` 的三态分区：早期的工具结果被分为 mustReapply（已被替换的恒定重放）和 frozen（已见未替换的永不可动），只有当前轮新增的 fresh 集合才进入贪心选择。特别注意：frozen 超预算时算法接受超标而非强行替换——它信任下一层的 microcompact 会处理。

> **实际运行说明**
>
> 在 70 条消息的对话中，`enforceToolResultBudget` 的三态分区日志未被触发。这说明当前对话中的工具返回结果总量未超过每条消息的预算阈值——预算机制只在单条消息内的工具结果体积足够大（如一次性读取超大文件）时才工作。这个验证点需要更极端的场景（如反复读取万行级大文件）才能观察到 fresh→frozen→mustReapply 的状态流转。

### 验证点 3：System Prompt 边界与缓存切分

这一步不要只盯 `src/utils/systemPrompt.ts`。`buildEffectiveSystemPrompt()` 负责的是“选哪份 prompt”，真正的静态/动态切分发生在两处：

- `src/constants/prompts.ts`：搜索 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`，看边界是在哪里被插入到默认 system prompt 数组中的
- `src/utils/api.ts`：在 `splitSysPromptPrefix()` 处打断点，观察边界之前的静态段如何被切成 cacheable prefix，边界之后的动态段如何单独处理

做一次 `git commit` 后再发请求，观察变化主要落在动态段，而前面的静态段保持稳定——这才是缓存命中的保障。

> **实际运行结果**
>
> 在 `splitSysPromptPrefix()` 添加日志后，16 轮请求的缓存切分**完全一致**：
>
> ```
> [VERIFY-CACHE-SPLIT] boundaryIndex=9 | totalBlocks=15
> [VERIFY-CACHE-SPLIT] staticBlocks=7 (11693 chars) | cacheScope=global
> [VERIFY-CACHE-SPLIT] dynamicBlocks=5 (15170 chars) | cacheScope=null
> [VERIFY-CACHE-SPLIT] result blocks: [none:74chars] → [none:57chars] → [global:11693chars] → [none:15170chars]
> ```
>
> 四段结构清晰：attribution header（74 chars）→ CLI prefix（57 chars）→ **静态段（11693 chars, `cacheScope=global`）** → 动态段（15170 chars, `cacheScope=null`）。静态段（角色定义、工具描述等）在所有 16 轮中长度始终不变，`cacheScope=global` 保证了跨会话全局缓存命中。动态段（Git 状态、Memory 内容等）不参与缓存 key 计算。这就是文章所说的"按缓存友好顺序排列而非逻辑顺序"——前面约 11.7K chars 的静态内容始终享受 cache hit。

---

## 下一篇预告

单个 Agent 的能力到顶了怎么办？当任务复杂到一个 Agent 处理不过来——需要同时搜索多个目录、并行修改多个文件、一边写代码一边跑测试——就需要多个 Agent 协作。下一篇，我们将进入 Claude Code 的多智能体编排架构，看看 Coordinator/Worker 模式、Fork Subagent 的 Cache 共享、以及跨 Agent 的通信协议是如何让一群 Agent 高效协作的。

---

## 附录：验证代码插桩点

> 以下列出关键插桩位置供快速参考。每个插桩点提供精确的文件路径、行号和日志标签，可在本地或 Docker 环境中复现验证。

### 验证点 1：压缩策略触发

| 插桩文件 | 位置 | 日志标签 | 观察内容 |
|---------|------|---------|---------|
| `src/services/compact/microCompact.ts` | 第 253 行，函数入口 | `[COMPACT]` | micro 每轮触发频率 |
| `src/services/compact/autoCompact.ts` | 第 241 行，函数入口 | `[COMPACT]` | auto 阈值判断、断路器状态 |

### 验证点 2：Tool Result 预算

| 插桩文件 | 位置 | 日志标签 | 观察内容 |
|---------|------|---------|---------|
| `src/utils/toolResultStorage.ts` | 第 769 行，`enforceToolResultBudget()` | `[BUDGET]` | frozen/mustReapply/fresh 三态分区数量变化 |

### 验证点 3：System Prompt 缓存切分

| 插桩文件 | 位置 | 日志标签 | 观察内容 |
|---------|------|---------|---------|
| `src/utils/api.ts` | 第 321 行，`splitSysPromptPrefix()` | `[CACHE]` | 静态段/动态段长度、cacheScope 标注 |

插桩模式（Docker 环境）：

```typescript
try { require('fs').appendFileSync('/workspace/verify.log', `[标签] 内容\n`); } catch {}
```

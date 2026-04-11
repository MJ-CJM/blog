---
publishDate: 2026-04-11T01:00:00Z
title: '07 | 让 Agent 拥有长期记忆：持久化记忆系统的工程实现'
excerpt: 'Agent 不是一次性工具——从存储、检索、注入到自动提取和跨 Agent 同步，拆解 Claude Code 如何用完整的记忆生命周期让 Agent 在会话之间保持"人格一致性"。'
image: 'https://images.unsplash.com/photo-1507413245164-6160d8298b31?w=1200&h=630&fit=crop'
category: 'Claude Code 源码解析'
tags:
  - Claude Code
  - AI Agent
  - 架构设计
  - 源码分析
---

# 让 Agent 拥有长期记忆：持久化记忆系统的工程实现

> Agent 不是一次性工具。当你花了两小时教会 Claude Code 你的项目架构、编码偏好、团队约定，下次打开一个新会话——它全忘了。Claude Code 用一套完整的记忆生命周期——从存储、检索、注入到自动提取和跨 Agent 同步——让 Agent 在会话之间保持"人格一致性"。

---

## 从上一篇说起

上一篇我们看到上下文管理如何在单次会话内解决窗口溢出问题——五级渐进式压缩把有限的 200K Token 用到极致，Cache-Aware 的 Prompt 拓扑让每一次 API 调用都尽可能复用缓存。那篇的核心问题是：**如何在一次对话里装下更多？**

但压缩只能延长一次对话的寿命。当你关掉终端、第二天重新打开 Claude Code，一切归零——项目架构的理解、你的编码偏好、上次讨论的设计决策，全部消失。上下文管理解决的是"单次会话内的记忆"，却对"会话与会话之间的遗忘"无能为力。

这就是持久化记忆要解决的核心问题：**如何让 Agent 跨越会话边界保持记忆？** 不仅是简单地把对话保存到磁盘，而是要让记忆在正确的时机被写入、在需要时被精准检索、在每次对话开始时被无缝注入——还要解决记忆如何保持新鲜、如何在多个 Agent 之间共享。

本篇我们将沿着记忆的完整生命周期展开：**存在哪**（存储层与作用域）、**怎么写入**（手动记录与自动提取）、**怎么找到**（检索策略）、**怎么注入**（注入时机与优先级）、**怎么保鲜**（过期与更新机制）、**怎么协作**（跨 Agent 的记忆同步）。

---

## 记忆存在哪：Memdir 文件式存储

### 为什么是文件系统而不是数据库

Claude Code 选择用普通 Markdown 文件而非 SQLite 或向量数据库来存储记忆，背后有三个务实的理由：

- **零依赖、可移植**：文件系统是所有平台的公约数，不需要额外安装任何运行时。记忆文件本质上是文本，可以被 git 追踪、被用户直接编辑、被任何工具读取，不存在"数据库损坏"的恢复难题。
- **透明可审计**：Agent 写了什么记忆、记了什么偏好，用户随时可以打开文件夹查看。这对"持续访问用户文件"的工具来说是必要的信任基础——你能看到它记住了什么，也能随时删掉。
- **与 CLAUDE.md 体系同构**：Claude Code 已有从 `CLAUDE.md` 读取项目指令的习惯，Memdir 沿用同一套 Markdown 格式，降低了认知负担，也让两套系统在注入阶段可以用统一的逻辑处理。

### 四类型封闭分类法

每条记忆在写入时必须归入四种类型之一（`src/memdir/memoryTypes.ts`）：

| 类型 | 存储内容 | 典型触发场景 |
|------|---------|-------------|
| `user` | 用户角色、目标、技术背景 | 了解到用户是数据科学家、偏好函数式风格 |
| `feedback` | 工作偏好（避免/保留） | 用户说"别用 any 类型"或"这个写法很好" |
| `project` | 当前项目、目标、截止日期 | 了解到本周要发布 v2.0、主仓库在 monorepo 里 |
| `reference` | 外部系统指针（Linear、Grafana） | 了解到 bug 追踪用 Linear、看板链接是 xxx |

四种类型构成一个**封闭集**。Agent 不能自由命名分类，必须从这四个选项中选择。封闭分类法的好处是检索侧可以按类型过滤，避免自由标签导致的语义漂移——随着时间推移，自由标签会演化出几十种近义类别，最终变得不可维护。

### 写入-索引分离架构

Memdir 采用"独立文件 + 统一索引"的两层设计。每条记忆是一个独立的 `.md` 文件，文件顶部用 frontmatter 声明元数据：

```markdown
---
name: 用户角色
description: 数据科学家，关注日志可观测性
type: user
---
记忆正文内容...
```

`MEMORY.md` 作为索引文件，汇总所有记忆条目的摘要，受到严格的大小约束（最大 200 行 / 25,000 字节）。当索引文件接近上限时，系统在最后一个完整换行处截断，确保不写入残缺条目。

完整的目录结构如下：

```
~/.claude/
└── projects/
    └── {sanitized-git-root}/
        └── memory/
            ├── MEMORY.md           ← 索引文件（最大 200 行/25KB）
            ├── user_role.md        ← 用户记忆
            ├── feedback_testing.md ← 反馈记忆
            ├── project_auth.md     ← 项目记忆
            └── reference_linear.md ← 参考记忆
```

这种分离设计的优势在于：索引文件可以被快速加载注入上下文，而不需要一次性读入所有记忆的完整内容；独立文件则在需要时按需读取，大型记忆不会拖累整体注入速度。

> ### Spotlight: 路径规范化与安全
>
> 记忆目录路径的解析有明确的优先级（`src/memdir/paths.ts`）：环境变量 `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` 最高，其次是 `settings.json` 中的 `autoMemoryDirectory`（支持 `~/` 展开），最后才是默认的 `~/.claude/projects/<sanitized-git-root>/memory/`。
>
> 默认路径中的 git 根目录由 `findCanonicalGitRoot()` 解析——它确保同一仓库的所有 worktree 映射到同一个记忆目录，避免在多 worktree 工作流中出现记忆碎片化。
>
> 路径中的 git 根目录字符串在写入前经过 `sanitizePathKey()` 清洗：拒绝 null 字节、URL 编码的路径穿越序列（`%2F`、`%2E`）、Unicode 规范化攻击、反斜杠，以及绝对路径。这道防线防止恶意项目路径通过 `../../` 等手法逃逸出 `~/.claude/` 沙箱。

---

## 记忆怎么来：手动写入与自动提取的双通道

知道了记忆存在哪，下一个问题是：**记忆怎么进来的？** Claude Code 设计了两条完全独立的写入路径，分别对应"用户主动要求记忆"和"Agent 悄悄把有价值的信息留存下来"两种场景。

### 通道一：主 Agent 直接写入

第一条通道是最直观的：用户明确说"记住这个偏好"，或者系统提示词里有规则要求 Agent 主动记录特定信息，主 Agent 就会在当前查询轮次内直接写入记忆文件。

写入过程分为两步：

1. **写入记忆文件**：调用标准的 FileWrite 或 FileEdit 工具，目标路径指向记忆目录。文件名遵循 `{type}_{slug}.md` 格式，frontmatter 声明类型与描述。
2. **更新索引**：记忆文件写入后，Agent 还需要把新条目的摘要追加到 `MEMORY.md` 索引，确保下次会话注入时索引能反映最新状态。

这条通道的优先级最高——只要主 Agent 在本轮查询中向记忆目录写入了任何文件，通道二的自动提取就会被跳过，避免重复处理同一批内容。

### 通道二：Extract Memories 自动提取

第二条通道在后台静默运行，用户几乎感知不到它的存在。

**触发时机**：在查询循环结束时——也就是模型的最终响应不再包含工具调用、对话回合自然收尾的那一刻。触发条件有两个额外约束：仅在主 REPL 线程（`querySource === 'repl_main_thread'`）触发，且受 Feature Gate `tengu_passport_quail` 控制。

**执行流程**：

```
查询循环结束（模型最终响应无工具调用）
    ↓
shouldExtractMemory() 检查条件是否满足
    ↓
检查主 Agent 是否已直接写入记忆目录 → 是则跳过（互斥）
    ↓
启动 Forked Agent（独立子进程）
    ├── 注入现有记忆清单（省去 ls 一个来回）
    ├── 仅分析游标之后的新消息（lastMemoryMessageUuid 追踪）
    ├── 最多执行 5 轮提取
    └── 理想路径：第 1 轮读取所有相关消息，第 2 轮并行写入
    ↓
追踪写入的文件路径列表
    ↓
遥测上报（写入数量、耗时、轮次数）
```

**游标追踪**：每次提取完成后，系统记录最后一条处理消息的 UUID（`lastMemoryMessageUuid`），下次触发时提取 Agent 只从游标之后的新消息开始分析，避免对已经处理过的历史内容重复提取。

### 双通道的协调

自动提取扮演的是**安全网**角色：对话中产生的有价值信息，即使用户没有显式要求记录，只要提取 Agent 判断值得保留，就会悄悄写入。手动写入和自动提取之间有一条互斥规则——本轮主 Agent 已写入记忆目录，自动提取就不再启动，确保同一条信息不会被两条通道重复处理。

**退出兜底**：自动提取是异步的，如果用户在提取完成前关闭了进程怎么办？Claude Code 在进程退出时调用 `drainPendingExtraction()`（`src/services/extractMemories/extractMemories.ts`），最多等待 60 秒，确保正在进行中的提取任务能够跑完，不因进程退出而丢失记忆。

> ### Spotlight: 自动提取的权限收窄设计
>
> 提取 Agent 是一个 Forked 子 Agent，但它的权限被刻意限制在"最小可用集"。与主 Agent 的全量工具箱相比，提取 Agent 只能使用以下工具：
>
> | 允许 | 禁止 |
> |------|------|
> | FileRead、Grep、Glob（只读文件操作） | Bash（写操作路径） |
> | 只读 Bash（ls、find、cat、stat） | MCP 工具 |
> | FileEdit/Write（仅限记忆目录） | 派生子 Agent |
> | REPL（受内部轮次上限约束） | |
>
> 这套设计体现了**最小权限原则**：提取 Agent 的任务是"读取对话、写入记忆目录"，它不需要执行任意 Shell 命令，不需要调用外部服务，也不需要再派生新的 Agent。把权限精确裁剪到任务边界，一方面防止提取 Agent 被恶意内容诱导执行破坏性操作，另一方面也让审计更清晰——如果记忆目录之外出现异常写入，可以确定不是提取 Agent 干的。
>
> 相关实现见 `extractMemories()`（`src/services/extractMemories/extractMemories.ts`）和提取提示词（`src/services/extractMemories/prompts.ts`）。

---

## 记忆怎么找到：确定性扫描 + AI 智能排序

记忆写进去了，但到底哪些记忆应该在这次对话里被使用？这是一个看似简单却暗藏陷阱的问题。

### 为什么不能全量注入

最直觉的方案是：把所有记忆都塞进上下文——反正都是有用信息。但这条路走不通，原因有两个：

**容量上限**：`MAX_MEMORY_FILES = 200`，加上每个文件的正文内容，全量注入会大量消耗 Token 预算，挤压真正的对话空间。

**语义鸿沟**：即使不考虑容量，关键词匹配也无法解决语义相关性问题。用户说"帮我改登录页"，关键词是"登录"，但真正相关的记忆可能是 `feedback_testing.md`，里面写着"登录模块不要 mock 数据库"——文件名里没有"登录"两个字，纯关键词扫描会直接错过它。

### 两阶段检索：扫描 → 选择

Claude Code 用确定性扫描 + AI 语义排序的两阶段方案解决这个问题（`findRelevantMemories()`，`src/memdir/findRelevantMemories.ts`）：

**第一阶段（确定性）**：`scanMemoryFiles()` 扫描记忆目录，构建候选清单。为了控制 I/O 开销，每个文件只读前 30 行（frontmatter 范围），按 mtime 降序排列（最新的优先），排除 `MEMORY.md` 索引文件本身，上限 200 条。这一阶段的输出是一份"可能相关"的候选集，速度快、开销低。

**第二阶段（AI）**：`selectRelevantMemories()` 把候选清单和用户当前输入一起发给 Sonnet 模型。Sonnet 根据语义相关性从候选集中挑出最多 5 条记忆；如果没有明显相关的记忆，返回空列表。

整体流程如下：

```
用户输入查询
    ↓
scanMemoryFiles() → 记忆候选清单（最多 200 条）
    ↓
过滤已浮现的记忆（本轮已注入过的跳过）
    ↓
selectRelevantMemories() ← Sonnet 模型语义排序
    ↓
返回最多 5 个相关记忆
```

这种混合设计的好处显而易见：第一阶段用确定性规则快速收口候选集，第二阶段用语言模型的语义理解做精准筛选，两者分工明确，既保住了速度，又克服了关键词匹配的语义盲区。

### Sonnet 选择器的精妙指令

Sonnet 选择器并不是一个简单的"找相关文档"提示词，它有一条值得特别关注的设计（`SELECT_MEMORIES_SYSTEM_PROMPT`）：

> "If a list of recently-used tools is provided, do not select memories that are usage reference or API documentation for those tools... DO still select memories containing warnings, gotchas, or known issues about those tools — active use is exactly when those matter."

翻译过来：如果模型刚刚用过某些工具，那些工具的**使用说明和 API 文档**就不需要再注入了——模型显然已经知道怎么用；但这些工具的**警告、陷阱和已知问题**依然要注入——正是因为在用，这些警示才最关键。

这份工具列表由 `collectRecentSuccessfulTools()`（`src/utils/attachments.ts`）生成：它从最后一条用户消息往前反向扫描，收集所有 `tool_use` + `tool_result` 配对，只把**成功执行**（未报错）的工具名传给 Sonnet。失败的工具**故意排除在外**——当模型正在为某个工具报错而挣扎时，相关文档应该保持可用，不能因为"最近用过"就被过滤掉。

### 陈旧度感知

记忆文件被写入后并不是永远新鲜的——代码会演化、文件会移动、行号会改变。`src/memdir/memoryAge.ts` 提供了两个函数来处理这个问题：

- `memoryAge(mtimeMs)`：把文件修改时间转换为人类可读的相对时间——"today"、"yesterday"、"N days ago"。
- `memoryFreshnessText(mtimeMs)`：对于超过 1 天的记忆，附加一段明确的警示文字："claims about code behavior or file:line citations may be outdated. Verify against current code before asserting as fact."

这段警示的作用是把记忆从"事实断言"降级为"调查线索"。记忆系统的价值不在于提供绝对准确的代码快照，而在于提供**调查方向**——告诉模型"这里曾经有个问题"或"用户不喜欢这种写法"，至于当前代码的实际状态，模型需要自己去验证。陈旧度感知机制让这个认识论立场显式化，避免模型把过期记忆当成可信事实直接输出给用户。

---

## 记忆怎么注入：三层字节预算与异步预取

### 绕过工具预算的 system-reminder 通道

记忆找到之后，需要一条通道把它送进上下文。Claude Code 选择的通道是 `<system-reminder>` attachment——这是一个独立于普通消息流的系统附件，不经过标准的 `tool_result` 路径。

为什么这个区别很重要？上一篇介绍过 `enforceToolResultBudget`：系统对 tool_result 消息维护着一套字节预算，防止工具返回值撑爆上下文。但 `<system-reminder>` 注入完全绕过了这套机制——它走的是另一条路。

绕过意味着自由，也意味着风险：如果不加限制，记忆注入可以无限膨胀，把上下文偷偷吃光。因此，记忆系统需要**自己的预算机制**，独立于工具结果预算之外。

### 三层字节预算

Claude Code 在注入路径上构建了三层嵌套的字节限制（`src/utils/attachments.ts`）：

| 层级 | 常量 | 限制值 | 设计意图 |
|------|------|--------|---------|
| 文件级 | `MAX_MEMORY_BYTES` | 4,096 字节/条 | 单条记忆的体积上限 |
| 轮次级 | 5 条 × 4KB | ≈ 20KB/轮 | Sonnet 选择器最多返回 5 条记忆 |
| 会话级 | `MAX_SESSION_BYTES` | 61,440 字节（60 × 1024） | 整个会话的累计注入上限 |

文件级限制的必要性源自一条有趣的数学事实——代码注释里直接写明了这一点："Line cap alone doesn't bound size (200 × 500-char lines = 100KB)。"仅限制行数是不够的，一行 500 字符的内容乘以 200 行就是 100KB，远超预期，所以必须加字节硬限。

会话级 60KB 预算的实际含义：生产环境观测到每个会话大约消耗 26K tokens，折算下来 60KB ≈ 约 3 次完整注入，也就是说一次完整对话里最多能容纳大约 15 个不重复的记忆文件被注入过。

### 异步非阻塞预取

记忆检索需要先扫描文件目录、再调用 Sonnet 做语义排序，整个过程有显著的 I/O 和模型调用开销。如果放在用户消息处理的关键路径上串行执行，每次都要等记忆就绪才能把请求发给主模型，延迟会明显上升。

Claude Code 的解法是 `startRelevantMemoryPrefetch()`（`src/utils/attachments.ts`）：**在每轮用户消息到达时立即发起异步预取**，与主模型推理并行执行。当主模型请求上下文时，预取结果往往已经就绪，实现零等待注入。

预取函数在真正启动异步任务之前，会依次通过四道检查门：

1. **功能开关**：`isAutoMemoryEnabled()` 和 Feature Gate `tengu_moth_copse` 同时为真才继续；
2. **有用户消息**：没有 lastUserMessage 则跳过；
3. **查询有上下文**：输入去掉首尾空白后包含空白字符（单词数 > 1），单词查询词汇量太少、语义信息不足以做相关性判断；
4. **会话预算未耗尽**：`surfaced.totalBytes < MAX_SESSION_BYTES`，超出则停止注入。

所有检查通过后，预取任务通过 `createChildAbortController` 绑定到当前轮次的 abort 信号——用户按下 Escape 时，主模型推理取消，预取任务也随之立即中断，不会留下"幽灵任务"继续消耗资源。

> ### Spotlight: Compaction 自重置——最精妙的设计
>
> 会话级预算是怎么计算的？答案藏在 `collectSurfacedMemories()`（`src/utils/attachments.ts`）里：
>
> ```typescript
> export function collectSurfacedMemories(messages: ReadonlyArray<Message>): {
>   paths: Set<string>
>   totalBytes: number
> } {
>   const paths = new Set<string>()
>   let totalBytes = 0
>   for (const m of messages) {
>     if (m.type === 'attachment' && m.attachment.type === 'relevant_memories') {
>       for (const mem of m.attachment.memories) {
>         paths.add(mem.path)
>         totalBytes += mem.content.length
>       }
>     }
>   }
>   return { paths, totalBytes }
> }
> ```
>
> 注意这里**没有任何模块级变量**。函数每次调用都从头扫描消息历史，把所有类型为 `relevant_memories` 的 attachment 汇总，得到已注入路径集合和累计字节数。
>
> 这带来了一个出人意料的自重置行为：当 Compaction（上一篇讲过的五级压缩）压缩对话历史时，旧消息被删除，挂在旧消息上的记忆 attachment 也随之消失。下次调用 `collectSurfacedMemories()` 时，`totalBytes` 会大幅下降——甚至归零——之前因为预算耗尽而被压制的记忆文件，重新成为注入候选。
>
> 代码注释对这个设计的意图说得很直白："Scanning messages rather than tracking in toolUseContext means compact naturally resets both — old attachments are gone from the compacted transcript, so re-surfacing is valid again."
>
> 这和上一篇介绍的工具结果预算形成鲜明对比：Tool Result 预算使用模块级的 `seenIds` 集合，只增不减，Compaction 后依然保持，确保工具结果缓存的确定性。记忆预算则反其道而行——用消息历史作为唯一真相来源，让 Compaction 自然产生预算重置的副作用。**两者面对不同的工程需求，选择了方向相反的状态管理策略**。

---

## 记忆怎么保鲜：会话笔记与后台梦境整理

上面几节解决的是"记忆怎么存、怎么找、怎么注入"——但还有两个时间维度的问题没有回答：**会话进行中**，对话历史越来越长，有价值的上下文会被逐渐淹没；**会话与会话之间**，持久化记忆随着项目演进会慢慢过时，散落在不同文件里的信息碎片没有人整理。

Claude Code 用两套机制分别应对这两个问题：Session Memory 负责会话内的即时记录，Auto-Dream 负责会话间的后台整理。

### Session Memory：会话内的结构化笔记

第 03 篇从压缩策略角度讲了 Session Memory，它是五级渐进式压缩里的第五级——当 autoCompact 触发时，优先读取 Session Memory 来还原上下文，省去重新梳理对话历史的 API 开销。**这里我们看它作为记忆保鲜机制的一面**：Session Memory 本质上是一套"会话内的持续笔记"，让正在进行中的工作状态随时可以被快速重建。

**触发条件**：系统每隔一段时间检查三个阈值，满足其中一种组合就触发更新：

```typescript
type SessionMemoryConfig = {
  minimumMessageTokensToInit: 10000   // 初始化阈值：Token 总量超过 1 万才首次生成
  minimumTokensBetweenUpdate: 5000    // 更新间隔：距上次更新需增长 5000 Token
  toolCallsBetweenUpdates: 3          // 工具调用间隔：距上次更新需执行 3 次工具调用
}
```

触发逻辑：Token 增长达到阈值，**且**工具调用次数满足间隔——或者 Token 增长达到阈值且上一轮没有工具调用（自然断点）。两个条件共同作用，确保笔记在工作节点而非对话中途更新。

**十节标准模板**：Session Memory 的内容不是自由格式的摘要，而是严格按照十个固定分区组织：

| 分区 | 作用 |
|------|------|
| Session Title | 会话标题 |
| Current State | 当前任务状态——"正在做什么、卡在哪" |
| Task specification | 任务规格——原始需求与约束 |
| Files and Functions | 涉及的文件与函数清单 |
| Workflow | 已确定的工作流程 |
| Errors & Corrections | 遇到的错误及已尝试的修正 |
| Codebase and System Documentation | 代码库与系统文档摘要 |
| Learnings | 本次会话学到的新知识 |
| Key results | 阶段性关键成果 |
| Worklog | 按时间顺序的操作日志 |

固定模板的意义在于：autoCompact 读取 Session Memory 时可以直接定位到 `Current State` 和 `Errors & Corrections`，不需要解析自由文本就能还原上下文，零 API 调用开销。十个分区覆盖了从会话标题到操作日志的完整信息维度，每个分区都有明确的填写规则。

**执行方式与约束**：Session Memory 通过 `registerPostSamplingHook()` 注册为采样后钩子，由 Forked Subagent 在后台执行，对主 Agent 非阻塞。写入有严格的体积约束：

| 限制 | 值 |
|------|-----|
| 每分区最大 Token 数 | 2,000 |
| 总最大 Token 数 | 12,000 |
| 文件权限 | `0o600`（仅所有者可读写） |

文件权限 `0o600` 意味着 Session Memory 文件对同机器其他用户不可见——会话工作状态属于用户私有数据。系统支持自定义模板（`~/.claude/session-memory/config/template.md`）和自定义提示词，满足团队对笔记格式的特殊需求。

### Auto-Dream：后台梦境整理

第 06 篇从"隐藏功能与产品路线图"的角度介绍了 Auto-Dream。**这里我们看它作为记忆保鲜机制的一面**：Auto-Dream 解决的是跨会话的记忆腐化问题——持久化记忆写入后不会自动更新，随着项目演进，昨天还准确的描述今天可能已经过时，散落在各文件里的碎片也需要定期合并整理。

Auto-Dream 的核心比喻是"梦境整理"：Agent 在空闲时间回顾最近的会话历史，把分散的信息有序地归并进持久记忆，就像人在睡眠中整理白天的记忆片段。

**三道启动门**：Auto-Dream 不会随时触发，必须同时通过三个条件：

1. **时间间隔门**：距上次整理超过最小时间间隔，防止频繁触发消耗资源；
2. **会话数量门**：积累了足够多的新会话，确保有值得整理的新内容；
3. **文件锁门**：对锁文件的独占锁检查，防止多个 Claude Code 实例并发执行整理，避免记忆文件冲突。

**四个执行阶段**：通过三道门后，Auto-Dream 按顺序执行四个阶段：

1. **Orient（定向）**：读取现有记忆目录，理解当前索引结构——知道已有哪些记忆、各文件的主题，为后续合并提供基准；
2. **Gather（收集）**：扫描最近的会话历史，把新产生的对话内容汇集到工作集；
3. **Consolidate（整合）**：把新信息合并进现有记忆文件，修正已过时的描述，并把相对日期（"昨天"、"上周"）转换为绝对日期，确保记忆在未来读取时仍然有明确的时间语义；
4. **Prune（清理）**：删除冗余和重复的记忆条目，防止记忆库随时间无限膨胀。

**安全约束**：与自动提取 Agent 类似，Auto-Dream 运行在 Forked Subagent 沙箱中，工具权限被精确裁剪：Bash 只允许只读操作，文件写入权限仅限于记忆根目录（`createAutoMemCanUseTool()` 构建权限判断函数，将写入路径约束在 `memoryRoot` 之内）。这套限制防止整理过程中被会话历史里的恶意内容诱导执行越界操作。

相关实现位于 `src/services/autoDream/`（4 个文件）。

### 即时记录 → 持久存储 → 定期整理

Session Memory 和 Auto-Dream 分工明确，共同构成一个闭环：

```
会话进行中：Session Memory 持续记录工作状态
      ↓（会话结束，通道二自动提取写入持久记忆）
会话之间：持久记忆文件静默沉淀
      ↓（Auto-Dream 触发三道门）
空闲时间：Auto-Dream 整合 Session Memory 的结构化笔记
         修正过时描述 → 合并碎片 → 清理冗余
      ↓
下次会话：精准的持久记忆 + 可能重建的 Session Memory
```

Session Memory 产出的十节结构化笔记，天然是 Auto-Dream Gather 阶段的优质输入——`Files and Functions`、`Errors & Corrections`、`Learnings` 这几个分区直接对应持久记忆的 `feedback`、`project`、`reference` 类型，整合时不需要再做语义解析。

两套机制的时间尺度完全不同：Session Memory 以 Token 增量为单位实时更新（分钟级），Auto-Dream 以会话数量为单位异步整理（小时级乃至天级）。短周期保证工作状态随时可恢复，长周期保证持久记忆保持新鲜。**两者叠加，才让 Claude Code 的记忆系统在时间轴上真正"活"起来。**

---

## 记忆怎么协作：跨 Agent 记忆同步

前面六节描述的机制都是单 Agent 视角——一个 Agent 写入、检索、注入、保鲜自己的记忆。但在多 Agent 协作场景里，团队里的每个 Agent 都需要读到彼此沉淀的信息。Team Memory 解决的正是这个问题。

### 个人与团队的目录分离

Claude Code 在每个项目的记忆目录下划出一块独立的 `team/` 子目录，承载团队共享记忆：

```
~/.claude/projects/{proj}/memory/
├── MEMORY.md                ← 个人索引
├── 个人记忆文件...
└── team/
    ├── MEMORY.md            ← 团队索引
    └── 团队记忆文件...
```

个人记忆和团队记忆各有独立的 `MEMORY.md` 索引，写入和检索时互不干扰。Agent 读取团队记忆的方式与读取个人记忆完全相同，不需要额外的检索逻辑。

### 双向同步机制

团队共享的核心难题是：一个 Agent 写入 `team/` 目录后，其他 Agent 如何及时感知？

`watcher.ts`（`src/services/teamMemorySync/watcher.ts`）用 `fs.watch` 持续监听团队记忆目录。当某个 Agent 写入新的团队记忆后，watcher 触发带防抖的推送通知，把变更广播给所有在线的团队成员。团队成员收到通知后拉取最新内容——推送加拉取构成完整的双向同步闭环。

### 安全防护

团队记忆同步在多 Agent 场景下面临一个额外风险：API 密钥、密码等敏感信息可能通过记忆系统在 Agent 之间扩散。

`teamMemSecretGuard.ts`（`src/services/teamMemorySync/teamMemSecretGuard.ts`）在同步前扫描内容，拦截敏感信息外泄。写入路径的合法性由 `validateTeamMemWritePath()`（`src/memdir/teamMemPaths.ts`）执行两阶段验证：先做字符串级检查（路径是否包含团队目录），再用 `realpathDeepestExisting()` 解析到最深的现有祖先目录做 canonical 比较，防止悬空符号链接、符号链接循环（ELOOP）和前缀攻击（目录名后必须有分隔符）等多种路径穿越手段。`sanitizePathKey()` 同样适用于此，拒绝 null 字节等非法字符。

### 先整理、再同步

Team Memory 与 Auto-Dream 形成自然的闭环：Agent 先通过 Auto-Dream 在本地把散乱的记忆整理成结构化条目，再由 Team Memory Sync 把整理好的内容广播给团队。"先整理、再同步"确保进入共享空间的信息已经是经过筛选和归并的干净状态，而不是把碎片化的原始对话直接投放到团队记忆池。

> 团队记忆的完整协作模式与多 Agent 编排的关系，将在下一篇「多 Agent 与可扩展性」中深入展开。

---

## 模式提炼：可迁移到你的 Agent 项目

### 存储与检索

### 模式 1：封闭分类法，不用自由标签

**Claude Code 怎么做的**：记忆类型只有四种固定枚举——`user`（用户偏好）、`feedback`（对 Agent 行为的修正）、`project`（项目知识）、`reference`（外部系统指针）。每种类型的写入时机和内容边界在系统提示词中都有明确定义，模型不需要自己发明分类。

**你的项目可以这样做**：在设计记忆系统时，先定义 3-5 种封闭类型，并为每种类型写清楚"什么情况下写入"和"写入什么内容"。例如：`preference`（用户风格偏好）、`correction`（用户纠正过的错误）、`domain`（项目领域知识）。把这套规则硬编码进 system prompt，让模型照着执行，而不是交给模型自由决定。

**常见误区**：用自由标签替代封闭类型。乍看很灵活，但检索时问题浮现——几十种标签让模型无法做有效筛选，噪声急剧上升。封闭分类的核心价值不是限制表达，而是把人类对"什么值得记"的判断显式编码进系统，让检索路径可预测。

### 模式 2：写入-索引分离

**Claude Code 怎么做的**：`MEMORY.md` 是轻量索引，每条记忆只记标题、类型、路径、日期摘要，控制在 200 行以内；正文存在独立文件里，按需加载。索引随 system prompt 全量注入，让模型随时知道"有什么记忆可用"，但不会在每次对话都把所有记忆正文全部消耗掉。

**你的项目可以这样做**：把记忆系统拆成两层——索引层（轻量，全量注入）和内容层（按需加载）。索引层每条记录控制在 100 字节以内，整个索引不超过 4KB；内容层在检索确定相关性之后再加载。用户和模型"知道有什么"和"读到具体内容"是两个不同的时机，分开处理可以把 Token 用在刀刃上。

**常见误区**：把所有记忆塞进一个大文件，每次对话启动时全量加载。记忆数量超过 20 条之后，这个做法会把大量上下文窗口浪费在和当前任务无关的记忆上，反而稀释了模型对当前问题的注意力。

### 模式 3：确定性 + AI 混合检索

**Claude Code 怎么做的**：检索分两阶段。第一阶段：文件系统扫描，把所有记忆的标题和摘要汇成候选清单——这一步完全确定性，零 API 调用；第二阶段：把候选清单连同当前用户消息一起发给 Sonnet，让模型做语义相关性排序，返回 top 5。两阶段加起来，每轮最多一次轻量 API 调用，结果可解释。

**你的项目可以这样做**：先用确定性手段（文件扫描、数据库查询、关键词过滤）从全量记忆中筛出候选集，把候选集控制在 20-50 条以内；再用 LLM 对候选集做语义排序，选出最终注入的 3-5 条。确定性阶段保证速度和可调试性，AI 阶段提供语义理解，两者互补。

**常见误区**：走极端——要么纯 embedding 检索（向量相似度高未必语义相关，且难以调试），要么纯关键词匹配（遇到同义词或用户换个说法就召回为零）。混合检索的核心在于把两种方法的优势叠加，而不是二选一。

### 生命周期管理

### 模式 4：预算化注入，不要无限膨胀

**Claude Code 怎么做的**：记忆注入走独立通道（`system-reminder` attachment，绕过 tool result 预算），因此需要自己维护三层字节预算：单条记忆上限 4KB、单轮注入上限约 20KB（最多 5 条）、会话累计上限 60KB。超出任何一层，注入自动停止。

**你的项目可以这样做**：至少实现两层预算——单条记忆内容上限（如 2KB）和单次会话累计上限（如 40KB）。把预算检查放在注入函数的入口，超出则跳过。不要假设"相关记忆越多越好"——超过一定量之后，记忆之间的互相干扰会抵消信息增益，还会压缩模型处理当前任务的上下文空间。

**常见误区**：检索到了就全量注入，从不设上限。这个问题在系统上线初期几乎看不出来——记忆才十几条，随便注入也没事。但三个月后记忆累积到上百条，每次对话开头大半段都是历史记忆，模型开始出现"记忆淹没当前任务"的退化。上限需要在系统设计时就定好，而不是等问题出现再补救。

### 模式 5：自动提取作为兜底网

**Claude Code 怎么做的**：会话结束时，系统通过通道二（`registerPostSamplingHook` 注册的采样后钩子）fork 一个子 Agent，扫描刚结束的对话，自动提取值得长期保留的信息并写入持久记忆。用户全程不需要做任何操作——Agent 自己完成记忆的沉淀。

**你的项目可以这样做**：在对话结束或用户进入空闲状态时，触发一次轻量的自动提取。提取逻辑可以是一个小型 prompt：把最近 N 轮对话发给 LLM，问它"有哪些信息值得长期记住"。捕捉用户没有显式标注但实际有价值的信息——用户的隐性偏好、反复提到的约束条件、解决过的具体问题——这些都不会被用户主动说"记住这个"，但对下次会话很有帮助。

**常见误区**：完全依赖用户主动触发记忆保存。实际上，大部分值得记忆的信息用户不会显式标注——他们在意的是完成任务，不是维护记忆系统。"用户主动触发"只能捕捉到记忆价值的一小部分，自动提取是让记忆系统真正发挥作用的兜底机制。

### 模式 6：陈旧度感知，记忆不是事实

**Claude Code 怎么做的**：`memoryFreshnessText()` 检查记忆文件的修改时间，对超过 1 天的记忆自动附加警示文字："claims about code behavior or file:line citations may be outdated. Verify against current code before asserting as fact."这段警示把记忆从"可信断言"降级为"调查线索"，引导模型在使用前先验证。

**你的项目可以这样做**：每条记忆写入时附带时间戳。检索时按新旧排序，对超过一定时限（如 7 天）的记忆在注入内容前追加一句提示："以下记忆写入于 N 天前，使用前请先验证是否仍然准确。"这一行提示几乎零成本，却能显著降低模型把过期信息当事实输出的概率。时限根据项目更新频率调整——高速迭代的项目可以设 3 天，相对稳定的项目可以设 30 天。

**常见误区**：把记忆当作可信事实存储和注入。代码在变，需求在演进，团队在成长——一周前写入的记忆描述的是一周前的状态。如果模型直接把记忆当事实输出给用户（"你们项目的认证逻辑在 auth.ts 第 42 行"），而这行代码已经被重构，用户就会得到错误的信息。记忆系统的定位应该是"调查起点"而不是"权威来源"。

---

## 跟跑验证：亲手观察记忆系统

### 验证点 1：观察记忆写入与检索

在 `~/.claude/projects/{your-project}/memory/` 手动创建三个测试记忆文件，分别覆盖用户角色、测试框架偏好、外部工具引用三个主题，每个文件都带正确的 frontmatter（`type`、`title`、`date`）。启动 Claude Code，依次发送与测试相关和完全无关的查询。

在 `src/memdir/findRelevantMemories.ts` 的 `selectRelevantMemories()` 函数入口处打断点（`bun --inspect` 启动 + VS Code debugger 附加），观察发送给 Sonnet 选择器的候选清单，以及最终返回的记忆文件列表。

> **实际运行说明**
>
> 创建 3 个测试记忆文件（`user_role.md`、`feedback_testing.md`、`reference_linear.md`），发送查询"帮我写单元测试"，观察 Sonnet 选择器是否正确选中 `feedback_testing.md` 而跳过不相关的 `reference_linear.md`。命中时返回的记忆条目会通过 `system-reminder` attachment 注入到下一轮对话，可以在断点处直接看到注入内容的完整结构。

### 验证点 2：观察 Extract Memories 触发

在 `src/services/SessionMemory/sessionMemory.ts` 的 `shouldExtractMemory()` 函数入口添加一行 `console.log`，打印当前对话的消息数量和触发条件判断结果。随后进行一段包含明确偏好表达的对话（例如"我喜欢用 vitest 而不是 jest，以后帮我生成测试时默认用 vitest"），正常结束会话。观察终端日志是否出现提取触发记录，并检查记忆目录是否写入了新文件。

> **实际运行说明**
>
> 在 `shouldExtractMemory()` 入口添加日志后，对话结束时可以观察到提取 Agent 被 fork 出来，并在 memory 目录写入了一个新文件 `feedback_testing_framework.md`，frontmatter 中 `type` 为 `feedback`，内容记录了 vitest 偏好。提取过程是异步的——会话界面返回后，文件通常在 2-5 秒内出现在目录中。

---

## 下一篇预告

记忆让单个 Agent 拥有了跨会话的持久上下文。但当任务复杂到需要多个 Agent 协作时，新的挑战出现了——怎么定义 Agent 的身份和能力？怎么让它们安全地共享工作区？怎么协调并行任务？下一篇，我们将进入 Claude Code 的多智能体协作架构，看看 Agent 定义体系、Fork 子 Agent 的 Cache 共享、以及 Teams 集群的邮箱通信协议如何让一群 Agent 高效协作。

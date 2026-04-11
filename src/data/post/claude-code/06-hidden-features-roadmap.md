---
publishDate: 2026-04-07T06:00:00Z
title: '06 | 源码里的产品路线图：Claude Code 隐藏功能全景解读'
excerpt: '17 组 feature flag、24 条内部命令、4 层门控机制——源码里藏着一份尚未发布的产品路线图。'
image: 'https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=1200&h=630&fit=crop'
category: 'Claude Code 源码解析'
tags:
  - Claude Code
  - AI Agent
  - 架构设计
  - 源码分析
---


> 17 组 feature flag、24 条内部命令、4 层门控机制——源码里藏着一份尚未发布的产品路线图。

---

## 一只藏在终端里的小动物

逆向 Claude Code 源码的过程中，我们在 `src/buddy/` 目录下发现了一套完整的桌面宠物系统。追踪引用链，它的入口在 `src/commands.ts` 第 118 行——一个简单的 `const buddy = true`。但 git history 告诉我们，这个位置曾经是 `feature('BUDDY')`，也就是说它曾经被 Feature Flag 门控，而现在已经被硬编码为 `true` 放开了。

修改 flag 编译运行后，一只基于账号 hash 确定性生成的小动物出现在终端底部。它有自己的物种、稀有度、ASCII 精灵动画，甚至会通过 system prompt 注入和你的对话产生关联。这不是一个半成品——它有 18 种物种、完整的稀有度体系和多帧动画循环。

这引出了一个自然的问题：**源码里还藏着多少这样的秘密？** 沿着 `feature()` 宏和 `USER_TYPE` 检查做了一次全面扫描后，我们发现了 4 种不同粒度的门控机制，覆盖了从编译时到运行时的完整光谱：

| 机制 | 原理 | 典型示例 |
|------|------|---------|
| 编译期 Feature Flag | `feature('FLAG')` + Bun DCE，产物中不存在未启用代码 | BUDDY、KAIROS、VOICE_MODE |
| USER_TYPE 检查 | `process.env.USER_TYPE === 'ant'`，仅内部用户可见 | 24 个内部命令 |
| GrowthBook 运行时开关 | 服务端远程控制，支持灰度和 A/B | Computer Use、Voice 额外门控 |
| 环境变量 | `CLAUDE_CODE_*` 系列，运行时模式切换 | Coordinator Mode、Undercover |

把这些隐藏功能串起来审视，我们认为可以推测出一条从"被动 CLI 工具"到"主动 AI 助手"的演化路线。按功能成熟度和产品方向，这些功能大致可以分为四层：**补全基础体验 → 打通感官通道 → 从被动到主动 → 多 Agent 生态**。下面逐层展开。

## 第一层：补全基础体验

这一层的功能让现有的 Agent 循环更快、更聪明、更自动化。它们不改变 Claude Code 的核心定位，而是在已有框架内填补空白、优化体验。

### Buddy 桌面宠物

- **门控**：`feature('BUDDY')`（当前已改为硬编码 `true`）

`src/buddy/companion.ts` 是这套系统的核心。它用 `mulberry32` PRNG（第 16 行）从 `userId` 的 hash 值确定性生成宠物属性——同一个账号永远得到同一只宠物，换设备也不会变。物种库包含 18 种生物，每种有独立的稀有度权重；ASCII 精灵动画统一为 5 行高、3-4 帧循环，在终端中流畅播放。

更值得关注的是集成方式：`src/buddy/prompt.ts` 的 `companionIntroText()` 函数会将宠物信息注入 system prompt，让 Claude 知道你的宠物存在并在对话中自然地提及它。用户通过 `/buddy` 命令查看或孵化宠物，`/buddy reroll` 可以重新投掷。这不只是一个彩蛋——它是一套完整的情感化设计系统，从随机数生成到 prompt 注入，每个环节都经过工程化处理。

以 cat 物种为例，它的 ASCII 精灵帧之一长这样（`src/buddy/sprites.ts`）：

```
   /\_/\   
  ( ·   ·) 
  (  ω  )  
  (")_(")  
```

每个物种有 3 帧动画，帧间通过眼睛符号（`{E}` 占位符）的变化产生眨眼效果——第 1 帧睁眼、第 2 帧半闭、第 3 帧闭合，循环播放形成自然的呼吸感。

稀有度系统定义在 `src/buddy/types.ts`（第 126-140 行），使用加权随机抽取：

| 稀有度 | 权重 | 概率 | 星级 |
|--------|------|------|------|
| common | 60 | 60% | ★ |
| uncommon | 25 | 25% | ★★ |
| rare | 10 | 10% | ★★★ |
| epic | 4 | 4% | ★★★★ |
| legendary | 1 | 1% | ★★★★★ |

完整的 18 种物种列表：`duck, goose, blob, cat, dragon, octopus, owl, penguin, turtle, snail, ghost, axolotl, capybara, cactus, robot, rabbit, mushroom, chonk`。其中 `axolotl`（六角恐龙）和 `capybara`（水豚）是 rare 以上稀有度的专属物种，`blob` 和 `chonk` 则是 common 池中的常见面孔。每个物种的 ASCII 精灵都是手工绘制的 5 行高图案，风格统一但细节各异。

**挫败感检测**（`src/components/FeedbackSurvey/useFrustrationDetection.ts`）：计划中的遥测功能，通过用户行为信号（如重复尝试、快速取消等）检测挫败感并触发反馈调查。目前该功能返回 `false`（已禁用），但代码结构已就绪——这暗示 Anthropic 计划构建一个"用户情绪感知"层来优化交互体验。

### Undercover 模式：公开仓库中的身份保护

Undercover 模式（`src/utils/undercover.ts`）是 Anthropic 员工专属的安全机制，在员工向公开/开源仓库贡献代码时自动激活：

- **自动检测**：除非当前仓库 remote 匹配内部白名单（`INTERNAL_MODEL_REPOS`），否则默认激活——"安全默认值是 ON"
- **禁止泄露**：commit message 和 PR 描述中不得包含内部模型代号（Capybara、Tengu 等）、未发布版本号、内部仓库名、Slack 频道、甚至 "Claude Code" 字样和 Co-Authored-By 署名
- **无法强制关闭**：有 `CLAUDE_CODE_UNDERCOVER=1` 可以强制开启，但没有强制关闭的选项——这是防泄漏的最后一道防线
- **编译时消除**：所有逻辑门控于 `USER_TYPE === 'ant'`，外部构建中被 DCE 完全移除

配套的 `ANTI_DISTILLATION_CC` Feature Flag 则是另一层保护：防止竞争对手通过 Claude Code 的 API 交互来蒸馏模型能力。

### Speculation 推测执行

- **门控**：配置项 `speculationEnabled`（`src/services/PromptSuggestion/speculation.ts`）

这是一个面向感知延迟的优化。当用户还没有输入下一条指令时，系统预测用户可能的意图，在后台预先执行。如果预测命中，结果即时展示，用户感受到的是"瞬间响应"。思路很清晰：不靠更快的模型推理来缩短延迟，而是靠预判来消除感知等待。

**推测执行的完整流程**：

```
用户闲置 → generateSuggestion() 预测意图
    ↓
runForkedAgent() 在后台 fork 子 Agent
    ↓
写操作 → overlay 虚拟文件系统隔离
读操作 → 直接读取（或读 overlay 中的修改版本）
    ↓
用户确认 → copyOverlayToMain() 合并结果
用户拒绝 → safeRemoveOverlay() 清理
```

**安全约束**（`src/services/PromptSuggestion/speculation.ts` 第 58-70 行）：

- `WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit']`——这三个工具的文件路径会被重写到 overlay 临时目录（`~/.claude/tmp/speculation/{pid}/{id}/`），修改只发生在隔离副本中
- `SAFE_READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'ToolSearch', 'LSP', 'TaskGet', 'TaskList']`——只读工具直接执行，如果文件在 overlay 中已修改则读取 overlay 版本
- `MAX_SPECULATION_TURNS = 20`、`MAX_SPECULATION_MESSAGES = 100`——防止推测任务失控

**与浏览器 prefetch 的类比**——浏览器预加载用户可能点击的链接，Claude Code 预执行用户可能发出的指令。关键区别：浏览器 prefetch 是无副作用的 GET 请求，而 Claude Code 的推测可能包含写操作（Edit/Write），所以必须有 overlay 隔离层确保"错误的预测不会造成不可逆的修改"。这和 CPU 的分支预测是同一类工程哲学——预测错误时需要能廉价地回滚（CPU 清空流水线，Claude Code 丢弃 overlay 目录）。

### History Snip

- **门控**：`feature('HISTORY_SNIP')`，命令 `/force-snip`

手动触发上下文裁剪的用户入口。[第三篇](/claude-code/03-context-management)详述了 Claude Code 的五级渐进式压缩机制，而 History Snip 把其中的"snip"策略暴露给用户，让用户主动决定何时丢弃早期对话历史，而不是完全依赖自动触发。

### Bash Classifier

- **门控**：`feature('BASH_CLASSIFIER')`

用 Haiku 模型对 Bash 命令进行危险性分类。[第二篇](/claude-code/02-tool-engine-permission) Spotlight 2 中我们分析过权限裁决链中的 AI 分类器层——Bash Classifier 是这一层的具体实现。它可以在用户审批之前就识别出高风险命令，提供更精确的安全提示。

### Workflow Scripts

- **门控**：`feature('WORKFLOW_SCRIPTS')`，命令 `/workflows`，工具 `WorkflowTool`

比 [第四篇](/claude-code/04-multi-agent-extensibility)中分析过的 Skill 更重量级的多步骤编排自动化。Skill 是 prompt 模板级别的复用单元，Workflow Scripts 则是完整的流程脚本——可以把多个工具调用、条件判断、循环逻辑组合成一个可保存、可复用的自动化流水线。

## 第二层：打通感官通道

第一层的功能仍然局限在文字终端的世界里。第二层开始突破这个边界——Claude Code 不再只处理文本输入输出，它能"听到"语音，也能"看到"屏幕。

### Voice Mode

- **门控**：`feature('VOICE_MODE')`，命令 `/voice`

Voice Mode 的技术栈横跨了三个语言运行时。语音采集由 Rust napi-rs 编译的原生模块完成（系统级音频捕获）；`src/services/voiceStreamSTT.ts` 提供流式语音转文字处理，将音频流实时转为文本 token；`src/hooks/useVoiceIntegration.tsx` 则是 React 层的集成 Hook，把语音输入无缝嵌入现有的 Ink 终端 UI。

关键的设计选择是：语音输入**原生集成到 Agent 循环**，而不是"语音转文字再粘贴到输入框"。转写后的文本直接进入 `query()` 主循环，享受与键盘输入完全相同的上下文管理和工具调用能力。

Voice Mode 也是多层门控叠加的典型案例。仅靠 `feature('VOICE_MODE')` 编译期放行还不够——运行时还需要 Anthropic OAuth 登录态验证，以及 GrowthBook 远程开关 `tengu_amber_quartz_disabled` 的放行。三层门控独立控制，任何一层关闭都不可用。这种设计让团队可以在编译期决定"这个版本是否包含语音代码"，在运行时决定"这个用户是否允许使用语音"，在服务端决定"当前是否全局启用语音功能"。

### Computer Use / CHICAGO_MCP

- **门控**：`feature('CHICAGO_MCP')`，CLI 参数 `--computer-use-mcp`

Computer Use 让 Claude Code 获得了屏幕级别的操作能力：截屏、鼠标点击、键盘输入注入、应用窗口管理。在 macOS 上，这些能力通过 Swift 原生系统调用实现，代码位于 `src/utils/computerUse/` 目录。

这个目录的文件组织清晰地反映了分层设计思路：`executor.ts` 是执行层，负责实际的屏幕操作；`mcpServer.ts` 是协议层，将能力包装为 MCP Server 接口；`swiftLoader.ts` 是原生桥接层，加载 Swift 编译产物并提供 TypeScript 类型安全的调用接口；`gates.ts` 是门控层，集中管理所有访问条件。

门控同样是多层叠加的。`gates.ts` 第 3 行导入了 `getDynamicConfig_CACHED_MAY_BE_STALE`——这是 GrowthBook 运行时开关的缓存读取接口。第 29 行使用 `getDynamicConfig_CACHED_MAY_BE_STALE<Partial<ChicagoConfig>>` 读取名为 `tengu_malort_pedway` 的远程配置。在此之上，还有 Feature Flag 编译期门控和用户类型限制（Max/Pro 订阅或 Ant 内部用户）。

> ### Spotlight 1: Computer Use 为什么是 MCP Server？
>
> 一个自然的问题：Computer Use 是 Claude Code 自己的内置能力，为什么不像 BashTool、ReadTool 那样做成标准的 base tool，而要包装成 MCP Server？
>
> `setup.ts` 中的注释揭示了原因：**API 后端通过检测工具名中的 `mcp__computer-use__*` 前缀来触发 system prompt 中的 Computer Use 可用性提示**。换句话说，服务端会扫描请求中的工具列表，发现 `mcp__computer-use__screenshot`、`mcp__computer-use__click` 等工具名时，自动在 system prompt 中注入屏幕操作的指导文本。
>
> 如果做成普通的 base tool（比如叫 `ComputerScreenshot`），命名格式不符合 `mcp__*__*` 模式，后端无法自动检测，就需要修改 API 协议来显式传递"这个客户端支持 Computer Use"的信号。而 Cowork（Anthropic 的桌面版产品）也使用了相同的 MCP 工具名，保持一致性意味着两个产品可以共享同一套后端逻辑。
>
> 实际实现上，这是一个**进程内 MCP Server**（in-process）。它并不像外部 MCP Server 那样通过 stdio 或 WebSocket 通信——`mcpServer.ts` 注册的工具名会被名称拦截机制捕获，调用直接走进程内函数调用路径，没有序列化和网络开销。
>
> 这个设计模式的启示是：**当后端协议与工具命名耦合时，在客户端做一层适配（假装自己是 MCP Server）比推动后端修改协议的成本低得多**。适配层是工程中最务实的选择之一。

## 第三层：从被动到主动——KAIROS 平台

前两层的功能，无论是语音还是屏幕操作，本质上仍然是"用户发起，Agent 响应"的被动模式。KAIROS 重新定义了 Claude Code 的角色——从"被叫到才来的工具"变为"一直在旁边观察、随时准备帮忙的助手"。

### KAIROS 功能族

KAIROS 不是一个单一的 Feature Flag，而是一组 6 个可独立开关的子 Flag：

| 子 Flag | 命令/功能 | 描述 |
|---------|----------|------|
| `KAIROS` | `/proactive`、`/assistant` | 主动模式总开关 |
| `KAIROS_BRIEF` | `/brief` | 简要模式：定期生成工作简报 |
| `KAIROS_CHANNELS` | — | MCP 通道通知：接收外部系统事件 |
| `KAIROS_DREAM` | — | Auto-Dream：后台自动记忆整理 |
| `KAIROS_GITHUB_WEBHOOKS` | `/subscribe-pr` | GitHub Webhook：监控 PR 状态变更 |
| `KAIROS_PUSH_NOTIFICATION` | — | 推送通知：结果主动推送到用户 |

这种"功能族"设计值得关注。6 个子 Flag 可以独立控制，意味着团队可以先开放 `KAIROS` 总开关做基础主动模式的灰度，然后逐步放开 `KAIROS_BRIEF`、`KAIROS_GITHUB_WEBHOOKS` 等子功能，每个子功能都可以独立做 A/B 测试和效果评估。这是 Feature Flag 作为渐进式交付工具的教科书式用法——不是"全有或全无"，而是"逐步点亮"。

**本地启用方法**：

KAIROS 使用编译期 `feature('KAIROS')` 宏，与 Coordinator/Fork 相同——外部构建中代码被 DCE 移除。要本地启用需要修改源码：

```typescript
// 在 src/main.tsx 中，将
if (feature('KAIROS')) { ... }
// 改为
if (true) { ... }
```

但需注意 KAIROS 是一个功能族，它依赖多个子 Flag 协同工作：

| 子 Flag | 控制内容 | 依赖 |
|---------|---------|------|
| `KAIROS` | 主开关：SleepTool、SendUserFileTool、助手模式初始化 | 无 |
| `KAIROS_PUSH_NOTIFICATION` | 推送通知工具 | KAIROS |
| `KAIROS_GITHUB_WEBHOOKS` | GitHub PR 订阅工具 | KAIROS |
| `KAIROS_BRIEF` | Brief 简报工具 | KAIROS |
| `KAIROS_CHANNELS` | MCP 频道通知 | KAIROS |
| `AGENT_TRIGGERS` | 定时调度触发器 | KAIROS |
| `BG_SESSIONS` | 后台会话（无终端持续运行） | KAIROS |

**启用建议**：即使修改了编译期 Flag，部分功能仍需服务端 GrowthBook 开关放行。本地验证的最佳策略是逐个子 Flag 开启，观察哪些功能可以在纯本地环境运行（如 SleepTool），哪些依赖服务端（如 PUSH_NOTIFICATION）。

### 配套基础设施

KAIROS 功能族本身只是"想要做什么"，真正让它运转起来的是三个配套基础设施：

**Agent Triggers**（`AGENT_TRIGGERS`）提供了 Cron 定时调度能力。这是主动助手的"心跳"——没有定时触发机制，所谓的"定期生成工作简报"就无从实现。`KAIROS_BRIEF` 的定期简报、`KAIROS_DREAM` 的后台记忆整理，底层都依赖 Agent Triggers 的调度能力。

**BG Sessions**（`BG_SESSIONS`）让 Claude Code 可以在后台持续运行，不再依赖用户打开终端窗口。传统的 CLI 工具随着终端关闭就退出了，而后台会话意味着 Agent "一直在线"。GitHub Webhook 收到 PR 事件时不需要用户正好打开了 Claude Code——后台会话可以自动处理并在需要时推送通知。

**Verification Agent**（`VERIFICATION_AGENT`）提供了自动输出质量校验。当 Agent 在无人值守的后台运行时，没有用户实时监督输出质量，Verification Agent 就是那个"质量兜底"——它会对主 Agent 的输出做二次校验，确保结果的可靠性。

把这些组件拼在一起看：GitHub Webhook 提供外部事件源，Agent Triggers 提供定时调度，BG Sessions 提供持续运行环境，Push Notification 提供结果回传通道，Verification Agent 提供质量保障。可以推测这是 Anthropic 对 Agent 终极形态的一种探索——**一个永远在线的 AI 队友**，它监控着你的代码仓库，定期整理工作记忆，在发现问题时主动通知你，而不是等你想起来才去问它。

### Auto-Dream：后台记忆整理

`KAIROS_DREAM` 对应的实现位于 `src/services/autoDream/`（4 个文件），是一个完整的后台记忆整合子系统。它的核心理念是：**Agent 像人类一样需要"做梦"——在空闲时回顾最近的对话，把零散的信息整理为持久化记忆**。

**三级门控（成本递增顺序）**：

```
1. 时间门控：距上次整理 >= minHours（默认 24h）  ← 一次 stat() 调用
2. 会话门控：上次整理后 >= minSessions 个新会话（默认 5 个）  ← 目录扫描
3. 并发锁：无其他进程正在整理  ← 文件锁
```

三级门控的排列严格遵循**最低成本优先**原则——时间门控只需一次 `stat()` 系统调用，绝大多数情况下在第一级就返回（距离上次整理不到 24 小时），避免了昂贵的目录扫描和锁竞争。

**触发后的执行流程**：

当三级门控全部通过，`runAutoDream()` 调用 `runForkedAgent()` 启动一个后台 fork 子 Agent，注入 `buildConsolidationPrompt()` 生成的四阶段整理 prompt：

1. **Orient（定向）**——读取现有记忆目录，理解已有索引结构
2. **Gather（采集）**——从日志和会话转录中 grep 搜索新信息（只做窄查询，不全量读取 JSONL）
3. **Consolidate（整合）**——将新信息合并到已有记忆文件，修正过时事实，将相对日期转为绝对日期
4. **Prune（修剪）**——更新 `MEMORY.md` 索引，保持在行数和体积限制内

**安全约束**：fork 出的子 Agent 只有只读 Bash 权限（`ls`、`grep`、`cat` 等），写入操作仅限 `Edit` 和 `Write` 工具修改记忆文件。通过 `createAutoMemCanUseTool()` 构造的权限函数，将写操作严格限制在 `memoryRoot` 目录内——子 Agent 不能修改项目代码或系统配置。

**失败回滚**：如果 fork 子 Agent 执行失败，`rollbackConsolidationLock()` 将锁的 mtime 回退到整理前的值，让时间门控在后续轮次重新通过。扫描节流器（`SESSION_SCAN_INTERVAL_MS = 10 分钟`）防止频繁重试——失败后至少等 10 分钟才重新扫描。

**配置来源**：阈值参数 `minHours` 和 `minSessions` 通过 GrowthBook `tengu_onyx_plover` 远程配置，可在不发版的情况下调整整理频率。用户也可以在 `settings.json` 中设置 `autoDreamEnabled` 显式覆盖远程开关。

值得注意的是，Auto-Dream 的 consolidation prompt 从 `dream.ts`（`/dream` 命令实现）中解耦出来独立为 `consolidationPrompt.ts`，注释明确说明 "so auto-dream ships independently of KAIROS feature flags"——即使 `KAIROS` 主开关关闭，autoDream 仍可通过 GrowthBook 或用户设置独立启用。这是"功能族内子功能独立演进"原则的又一个实例。

## 第四层：多 Agent 生态

[第四篇](/claude-code/04-multi-agent-extensibility)已深入分析了 Coordinator/Worker 架构和 Fork Subagent 的 Cache 共享原理。这一层我们补充门控层面的新信息，以及几个尚未公开的协作能力——它们共同勾勒出一个"Agent 网络"的雏形。

| 功能 | 门控 | 与第四篇的关系 |
|------|------|--------------|
| Coordinator Mode | `COORDINATOR_MODE` + 环境变量 | 第四篇已分析架构，此处补充门控入口 |
| Fork Subagent | `FORK_SUBAGENT`，`/fork` | 第四篇已分析 Cache 共享原理 |
| Bridge/Daemon | `BRIDGE_MODE` + `DAEMON` | **新内容**：33 文件的远程控制系统 |
| UDS Peers | `UDS_INBOX`，`/peers` | **新内容**：本地多实例 Unix Socket 通信 |
| Team Memory Sync | `TEAMMEM` | **新内容**：跨 Agent 记忆同步 |

### Bridge Mode + Daemon：从 CLI 工具到平台服务

Bridge Mode（`feature('BRIDGE_MODE')`）是 Claude Code 中规模最大的隐藏子系统之一。`src/bridge/` 目录包含 33 个模块，按职责可分为四组：

| 分组 | 核心文件 | 职责 |
|------|---------|------|
| 入口与生命周期 | `bridgeMain.ts`、`initReplBridge.ts` | 初始化 Bridge Session、验证 Bridge ID |
| 消息协议 | `bridgeMessaging.ts`、`bridgeApi.ts` | 请求/响应格式、API 端点路由 |
| 会话管理 | `codeSessionApi.ts`、`remoteBridgeCore.ts` | 远程会话创建/恢复、双向同步 |
| REPL 集成 | `replBridge.ts`、`replBridgeHandle.ts` | 将 Bridge 消息注入本地 REPL 循环 |

此外还有 JWT 认证（`jwtUtils.ts`）、可信设备校验（`trustedDevice.ts`）、权限回调（`bridgePermissionCallbacks.ts`）等安全基础设施。

这套系统的本质是：**让 Claude Code 可以被外部程序远程控制**。消息收发、权限回调、会话生命周期管理——这正是 IDE 扩展（VS Code、JetBrains）和 Web UI 需要的底层通信协议。Bridge 的核心价值：让 Claude Code 从"必须打开终端才能用"变为"任何支持 HTTP 的客户端都能远程控制"。IDE 插件（VS Code、JetBrains）正是通过 Bridge 与后端 Claude Code 进程通信。

Daemon（`feature('DAEMON')`）在此之上更进一步。`src/commands.ts` 第 76-79 行显示，`/remoteControlServer` 命令需要 `DAEMON` 和 `BRIDGE_MODE` 同时开启。它让 Claude Code 作为长驻后台服务运行，不再需要用户交互式地启动终端。Bridge + Daemon 的组合意味着 Claude Code 可以作为一个 headless 服务部署——这是从"CLI 工具"走向"平台服务"的关键一步。

> **Bridge 模块结构拆解**
> 
> `src/bridge/` 目录包含 **33 个文件**（此前声称的 "35 个" 含关联文件），按功能分为：
> 
> - **核心通信**：`bridgeMain.ts`、`bridgeMessaging.ts`、`replBridge.ts`、`replBridgeHandle.ts`、`replBridgeTransport.ts`
> - **认证授权**：`jwtUtils.ts`、`trustedDevice.ts`、`workSecret.ts`
> - **会话管理**：`createSession.ts`、`sessionRunner.ts`、`sessionIdCompat.ts`、`peerSessions.ts`、`codeSessionApi.ts`
> - **配置与状态**：`bridgeConfig.ts`、`envLessBridgeConfig.ts`、`pollConfig.ts`、`pollConfigDefaults.ts`、`bridgeEnabled.ts`、`bridgeStatusUtil.ts`
> - **消息处理**：`inboundMessages.ts`、`inboundAttachments.ts`、`webhookSanitizer.ts`
> - **UI 与调试**：`bridgeUI.ts`、`bridgeDebug.ts`、`debugUtils.ts`、`bridgePointer.ts`
> - **基础设施**：`bridgeApi.ts`、`remoteBridgeCore.ts`、`initReplBridge.ts`、`bridgePermissionCallbacks.ts`、`capacityWake.ts`、`flushGate.ts`、`types.ts`

### UDS Peers：多实例互发现

门控 `feature('UDS_INBOX')`，命令 `/peers`（`src/commands.ts` 第 108 行）。

UDS（Unix Domain Socket）Peers 让同一台机器上的多个 Claude Code 实例互相发现和通信。`peerSessions.ts` 在启动时创建一个 UDS 监听地址（`~/.claude/sockets/{sessionId}.sock`），其他实例通过扫描该目录发现对等方。

SendMessage 工具支持 `to: "uds:/path/to/socket"` 格式直接向对等进程发送消息——这是 Agent Teams 跨进程通信的底层传输机制。设想一个场景：多个终端窗口各运行一个 Agent，一个负责前端、一个负责后端、一个负责测试——通过 UDS 它们可以协同工作，互相传递上下文和任务状态。每个 Agent 的 socket 文件就像一个"信箱"，其他 Agent 只要知道地址就能投递消息。

### Team Memory Sync：跨 Agent 记忆共享

门控 `feature('TEAMMEM')`，实现位于 `src/utils/swarm/teamMemory/` 目录。

`watcher.ts` 对团队共享的记忆目录进行文件监听（`fs.watch`），当一个 Agent 写入新记忆时，通过防抖推送通知其他团队成员。`teamMemSecretGuard.ts` 在同步前扫描记忆内容，防止 API Key、密码等敏感信息通过记忆系统泄露到其他 Agent。

拉取-推送的双向同步机制让多个 Agent 实例（或多个团队成员的 Agent）可以共享工作记忆。配合第三层的 `KAIROS_DREAM`（自动记忆整理），形成了"先整理、再同步"的闭环——个体 Agent 整理自己的记忆，然后通过 Team Memory Sync 广播给团队。

## 全景图谱

回顾四层分析，以下是全部核心隐藏功能的汇总：

| 层级 | 功能 | 门控类型 | Flag/条件 | 状态 |
|------|------|---------|----------|------|
| 基础体验 | Buddy 宠物 | Feature Flag | `BUDDY`（已开启） | 可用 |
| 基础体验 | Speculation 推测执行 | 配置项 | `speculationEnabled` | 接近可用 |
| 基础体验 | History Snip | Feature Flag | `HISTORY_SNIP` | 实现完整 |
| 基础体验 | Bash Classifier | Feature Flag | `BASH_CLASSIFIER` | 实现完整 |
| 基础体验 | Workflow Scripts | Feature Flag | `WORKFLOW_SCRIPTS` | 实现完整 |
| 感官通道 | Voice Mode | Feature Flag + GrowthBook | `VOICE_MODE` | 多层门控 |
| 感官通道 | Computer Use | Feature Flag + GrowthBook + 订阅 | `CHICAGO_MCP` | 多层门控 |
| 主动助手 | KAIROS（6 子功能） | Feature Flag | `KAIROS` 族 | 平台级 |
| 主动助手 | Agent Triggers | Feature Flag + GrowthBook | `AGENT_TRIGGERS` | 实现完整 |
| 主动助手 | BG Sessions | Feature Flag | `BG_SESSIONS` | 实现完整 |
| 主动助手 | Verification Agent | Feature Flag | `VERIFICATION_AGENT` | 实现完整 |
| 多 Agent | Bridge/Daemon | Feature Flag | `BRIDGE_MODE` + `DAEMON` | 33 文件 |
| 多 Agent | UDS Peers | Feature Flag | `UDS_INBOX` | 实现完整 |
| 多 Agent | Team Memory Sync | Feature Flag | `TEAMMEM` | 实现完整 |
| 多 Agent | Coordinator Mode | Feature Flag + 环境变量 | `COORDINATOR_MODE` | 实现完整 |
| 多 Agent | Fork Subagent | Feature Flag | `FORK_SUBAGENT` | 实现完整 |

此外还有 24 个 `USER_TYPE=ant` 内部命令（大多为 stub 空壳）、15 个条件隐藏命令（如 `/heapdump`、`/thinkback-play`）、13 个 `CLAUDE_CODE_*` 环境变量控制的运行时模式。完整清单见 `docs/hide/hidden-features.md`。

> ### Spotlight 2: 四种门控机制的编译原理
>
> 上表中的"门控类型"并不只是管理上的分类——它们在技术实现上有本质差异。
>
> **编译期 Feature Flag** 是最彻底的一种。`src/commands.ts` 第 59 行的 `import { feature } from 'bun:bundle'` 引入了 Bun 的编译期宏系统。`feature('FLAG')` 调用会在构建时被 `ensureBootstrapMacro()`（`src/bootstrapMacro.ts` 第 24 行）替换为 `true` 或 `false` 字面量，随后 Bun 的 Dead Code Elimination（DCE）会移除 `false` 分支的所有代码。这意味着未启用的功能在最终产物中**物理不存在**——不是被隐藏，而是被消除。与运行时 `if (process.env.FLAG)` 的区别是根本性的：后者的代码仍然在 bundle 中，可以被逆向工程发现和激活。
>
> **GrowthBook 运行时开关** 走的是另一条路。`getDynamicConfig_CACHED_MAY_BE_STALE()` 从服务端拉取配置，支持灰度发布和 A/B 测试。函数名中的 `CACHED_MAY_BE_STALE` 暴露了缓存语义：为了减少网络延迟，允许使用过期缓存——代价是开关变更不会即时生效。这是延迟与一致性之间的经典权衡。
>
> **多层叠加** 是最精巧的模式。以 Computer Use 为例：`feature('CHICAGO_MCP')` 控制代码是否存在（编译期）→ GrowthBook `tengu_malort_pedway` 控制功能是否可见（运行时远程）→ 订阅检查控制用户是否有权使用（授权）。三层各管一个维度：**存在性、可见性、授权**，互不干扰，独立演进。

## 模式提炼：从隐藏功能到你的项目

隐藏功能的门控策略本身就是值得借鉴的工程模式。以下四个模式可以直接迁移到你的项目中。

### 模式 1：编译期功能开关

**Claude Code 怎么做**：`feature()` 宏 + Bun DCE，未发布功能的代码在构建产物中物理不存在，无法被逆向。

**你的项目**：Webpack 的 `DefinePlugin`、Vite 的 `define` 配置、Babel 宏都能实现类似效果。在构建时将 `__FEATURE_X__` 替换为 `false`，配合 Tree Shaking 移除死代码。

**常见误区**：用运行时 `if/else` 做门控。代码仍然在 bundle 中，不仅增加体积，还可以被逆向工程发现和启用——对于敏感功能这是一个安全隐患。

### 模式 2：多层门控叠加

**Claude Code 怎么做**：Feature Flag（存在性）+ GrowthBook（可见性）+ 订阅检查（授权），三层独立控制，任何一层关闭都不可用。

**你的项目**：编译开关决定代码是否包含 + Feature Flag 服务（如 LaunchDarkly、Unleash）决定是否对用户可见 + 权限系统决定用户是否有权使用。三层关注点分离，各自独立迭代。

**常见误区**：单层开关控制一切。无法做灰度发布，无法区分"功能存在但对部分用户隐藏"和"功能不存在"——上线后要么全开要么全关，出了问题只能全量回滚。

### 模式 3：MCP 化能力扩展

**Claude Code 怎么做**：Computer Use 以进程内 MCP Server 接入，工具命名遵循 `mcp__server__tool` 格式让后端自动识别。新能力通过协议层接入，与核心代码解耦。

**你的项目**：新能力以独立服务或插件形式接入，通过明确定义的协议（而不是代码分支）与主系统集成。微服务、插件系统、Web Components 都是这个思路。

**常见误区**：在核心代码中用 `if/else` 分支添加新能力。每加一个功能，主进程就膨胀一分，模块间耦合越来越深，最终变成"什么都在一个文件里"的泥球。

### 模式 4：功能族设计

**Claude Code 怎么做**：KAIROS 拆分为 6 个子 Flag（`KAIROS`、`KAIROS_BRIEF`、`KAIROS_CHANNELS`、`KAIROS_DREAM`、`KAIROS_GITHUB_WEBHOOKS`、`KAIROS_PUSH_NOTIFICATION`），各有独立开关，可以逐步点亮、独立灰度、独立回滚。

**你的项目**：大功能拆分为子功能，每个子功能有独立的 Feature Flag。例如"新版编辑器"可以拆分为"新工具栏"、"新快捷键"、"新渲染引擎"三个子 Flag，分别灰度验证。

**常见误区**：大功能用单一开关。全开全关，一个子功能的 bug 导致整个大功能回滚——其他已经稳定的子功能被无辜株连。

## 跟跑验证：亲手探索隐藏功能

> 以下实验的目的是理解门控机制的工程设计，不是鼓励绕过产品限制。

前置条件：已按[第一篇](/claude-code/01-panoramic-architecture)搭建本地开发环境，可以 `bun run dev` 启动 Claude Code。

### 实验 1：与 Buddy 宠物互动

Buddy 已经被硬编码为 `true`（`src/commands.ts` 第 118 行），不需要修改任何 Flag。

| 操作 | 命令 | 预期观察 |
|------|------|---------|
| 启动 | `bun run dev` | 正常进入 REPL |
| 查看宠物 | `/buddy` | 基于账号 hash 确定性生成的宠物 |
| 重新投掷 | `/buddy reroll` | 新种子，不同宠物 |

观察要点：同一账号每次看到同一只宠物（`mulberry32` 确定性 PRNG）；宠物为 5 行高的 ASCII 精灵；`src/buddy/companion.ts` 有完整的物种库和生成逻辑。

### 实验 2：USER_TYPE=ant 的效果

| 步骤 | 命令 | 预期 |
|------|------|------|
| 正常启动 | `bun run dev` | 记录可用命令数量 |
| 设置环境变量 | `export USER_TYPE=ant` | — |
| 重启 | `bun run dev` | 新增内部命令 |
| 尝试有实现的命令 | `/version` | 正常输出版本信息 |
| 尝试 stub 命令 | `/bughunter` | `isEnabled` 返回 false，功能不可用 |

注意：大多数 `ant` 内部命令是 stub 空壳——命令注册了，但 `isEnabled` 返回 `false` 或执行体为空。这说明它们是占位符，为未来功能预留了入口。

### 实验 3：Feature Flag DCE 效果

以 `HISTORY_SNIP` 为例，直观展示编译期 Flag 的工作机制。

| 步骤 | 操作 | 预期 |
|------|------|------|
| 定位 | 找到 `src/commands.ts` 第 83 行 `feature('HISTORY_SNIP')` | — |
| 修改 | 将 `feature('HISTORY_SNIP')` 改为 `true` | — |
| 构建运行 | `bun run dev` | `/force-snip` 命令出现在命令列表中 |
| 还原 | `git checkout src/commands.ts` | 恢复原状 |

这个实验直观展示了编译期 Flag 的机制：当 `feature('HISTORY_SNIP')` 为 `false` 时，`require('./commands/force-snip.js')` 分支被 DCE 移除，`/force-snip` 命令在产物中物理不存在。将其改为 `true` 后，代码被保留，命令立即可用。

## 结语：代码即路线图

前五篇我们分析的是 Claude Code "已经是什么"——它的架构、工具引擎、上下文管理、多 Agent 扩展、可复用模式。这一篇换了一个视角：通过隐藏功能，去推测它"打算成为什么"。

从 Buddy 宠物的小彩蛋到 KAIROS 平台的宏大愿景，从 Voice Mode 的多模态突破到 Bridge/Daemon 的平台化转型，这些门控之后的功能勾勒出一条清晰的演化方向：**被动 CLI 工具 → 多模态交互 → 主动 AI 助手 → 多 Agent 协作网络**。

这条路线不仅属于 Claude Code。任何试图从"工具"进化为"助手"的 AI 产品，都可能经历类似的阶段。而 Claude Code 的源码提供了一份难得的参考——不是产品路线图 PPT 里经过美化的愿景，而是工程师一行行写下的、已经在运行（或即将运行）的真实代码。

源码是最诚实的产品文档。它不说谎，也不美化。

---

## 附录：验证代码插桩点

> 完整的验证操作指南见 [imip/06-verify.md](imip/06-verify.md)，以下列出关键插桩位置供快速参考。

### 实验 1：Buddy 宠物

| 操作 | 说明 |
|------|------|
| 启动 `bun run dev` | 如果 Buddy 功能启用（硬编码 `const buddy = true`），终端底部会出现 ASCII 宠物 |
| 输入 `/buddy` | 查看宠物属性（名字、物种、稀有度、性格值） |

### 实验 2：USER_TYPE=ant

| 操作 | 说明 |
|------|------|
| `USER_TYPE=ant bun run dev` | 启动后输入 `/help`，对比正常启动多出的 20+ 个内部命令 |

### 实验 3：Feature Flag DCE

| 插桩文件 | 位置 | 操作 | 观察内容 |
|---------|------|------|---------|
| `src/commands.ts` | 第 83 行 | 将 `feature('HISTORY_SNIP')` 改为 `true` | `/snip` 命令从不存在变为可用 |

插桩模式（Docker 环境）：
```typescript
try { require('fs').appendFileSync('/workspace/verify.log', `[标签] 内容\n`); } catch {}
```

> **验证覆盖说明**：以上 3 个实验分别验证了三种门控机制——硬编码开关、环境变量检查、编译期 Feature Flag。文章中其余 12 个隐藏功能均可按相同方法论验证：找到对应的门控条件，修改/设置后观察功能是否出现。

---

## 附录：编译时 Feature Flag 完整清单（87 个）

通过对源码全局 `feature('...')` 调用的 grep，确认 v2.1.88 中共有 **87 个**编译时 Feature Flag。以下按功能分类：

> **注：计数差异说明**
> 
> 网络上各分析文章的 Flag 计数不一致：御舆称 89 个，Medium 称 44 个。差异来自计数维度不同：编译时 `feature()` 宏调用（本文统计的 87 个）、GrowthBook 运行时开关、`CLAUDE_CODE_*` 环境变量是三个独立维度。本附录仅统计编译时 Feature Flag。

### KAIROS 家族（6 个）
`KAIROS` · `KAIROS_BRIEF` · `KAIROS_CHANNELS` · `KAIROS_DREAM` · `KAIROS_GITHUB_WEBHOOKS` · `KAIROS_PUSH_NOTIFICATION`

### 多代理与协作（8 个）
`COORDINATOR_MODE` · `FORK_SUBAGENT` · `AGENT_TRIGGERS` · `AGENT_TRIGGERS_REMOTE` · `UDS_INBOX` · `TEAMMEM` · `BUILTIN_EXPLORE_PLAN_AGENTS` · `VERIFICATION_AGENT`

### 连接与远程（10 个）
`BRIDGE_MODE` · `DAEMON` · `SSH_REMOTE` · `CCR_REMOTE_SETUP` · `CCR_AUTO_CONNECT` · `CCR_MIRROR` · `DIRECT_CONNECT` · `SELF_HOSTED_RUNNER` · `BYOC_ENVIRONMENT_RUNNER` · `LODESTONE`

### 上下文管理（8 个）
`CONTEXT_COLLAPSE` · `CACHED_MICROCOMPACT` · `REACTIVE_COMPACT` · `HISTORY_SNIP` · `COMPACTION_REMINDERS` · `PROMPT_CACHE_BREAK_DETECTION` · `BREAK_CACHE_COMMAND` · `AGENT_MEMORY_SNAPSHOT`

### 安全与权限（7 个）
`BASH_CLASSIFIER` · `TREE_SITTER_BASH` · `TREE_SITTER_BASH_SHADOW` · `TRANSCRIPT_CLASSIFIER` · `ANTI_DISTILLATION_CC` · `NATIVE_CLIENT_ATTESTATION` · `POWERSHELL_AUTO_MODE`

### UI 与交互（11 个）
`VOICE_MODE` · `MESSAGE_ACTIONS` · `AUTO_THEME` · `TERMINAL_PANEL` · `HISTORY_PICKER` · `WEB_BROWSER_TOOL` · `QUICK_SEARCH` · `STREAMLINED_OUTPUT` · `NATIVE_CLIPBOARD_IMAGE` · `SHOT_STATS` · `DUMP_SYSTEM_PROMPT`

### Skill 与插件（5 个）
`MCP_SKILLS` · `EXPERIMENTAL_SKILL_SEARCH` · `SKILL_IMPROVEMENT` · `RUN_SKILL_GENERATOR` · `TEMPLATES`

### 遥测与分析（5 个）
`ENHANCED_TELEMETRY_BETA` · `COWORKER_TYPE_TELEMETRY` · `MEMORY_SHAPE_TELEMETRY` · `PERFETTO_TRACING` · `SLOW_OPERATION_LOGGING`

### 会话与持久化（5 个）
`BG_SESSIONS` · `AWAY_SUMMARY` · `FILE_PERSISTENCE` · `EXTRACT_MEMORIES` · `CONNECTOR_TEXT`

### 任务与计划（4 个）
`ULTRAPLAN` · `ULTRATHINK` · `TORCH` · `TOKEN_BUDGET`

### 工具增强（4 个）
`CHICAGO_MCP` · `MONITOR_TOOL` · `OVERFLOW_TEST_TOOL` · `REVIEW_ARTIFACT`

### 设置同步与平台（5 个）
`UPLOAD_USER_SETTINGS` · `DOWNLOAD_USER_SETTINGS` · `NEW_INIT` · `COMMIT_ATTRIBUTION` · `HOOK_PROMPTS`

### 运行时环境（4 个）
`IS_LIBC_GLIBC` · `IS_LIBC_MUSL` · `ALLOW_TEST_VERSIONS` · `HARD_FAIL`

### 实验性功能（5 个）
`PROACTIVE` · `WORKFLOW_SCRIPTS` · `ABLATION_BASELINE` · `BUILDING_CLAUDE_APPS` · `UNATTENDED_RETRY` · `MCP_RICH_OUTPUT`

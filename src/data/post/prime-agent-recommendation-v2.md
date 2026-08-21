---
publishDate: 2026-08-12T01:00:00Z
updateDate: 2026-08-13T01:00:00Z
title: 'Prime Agent 有什么不一样：它怎样跑长任务，又怎样调整自己的工作方式'
excerpt: '我为什么开始关注 Prime Agent：它把持久 IPython、RLM 子 Session、后台任务和 Continual Harness 放进同一个运行时。本文基于源码和公开资料，聊设计亮点，也比较它与 Hermes Agent、Claude Code、Codex 和 OpenCode 的不同。我的判断是，Harness 很难有脱离场景的“全局最优”；是否合适，需要结合模型、任务、验收标准、成本和权限边界判断，动态调整仍需评测、版本记录和回滚。'
image: '~/assets/images/prime-agent/prime-agent-recommendation-v2.png'
category: 'AI Agent 源码观察'
tags:
  - Prime Agent
  - Coding Agent
  - RLM
  - Continual Harness
  - Hermes Agent
  - AI Agent
author: 'Chen Jiamin'
metadata:
  canonical: 'https://blog.mj-cjm.com/prime-agent-recommendation-v2'
---

最近我花了些时间利用 ai 工具读了 [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) 的源码，最先让我停下来的是 `rlm()` 的返回值。

假设你让一个子 Agent 审计项目的认证模块：

```python
child = await rlm("审计 auth/ 目录，找出潜在安全问题")
```

我原本以为 `child` 会直接拿到审计结果。Prime Agent 返回的却是一个任务接纳句柄，里面记录子 Agent 的 ID、名称、Session 目录和模型。子 Agent 随后在独立 Session 中继续运行，完成后再通过消息或文件把结果送回来。

这个很小的 API 细节，刚好暴露了项目想解决的问题：怎样让 Agent 脱离一次聊天，变成可以持续运行、编排子 Agent、保存中间状态，并调整行为配置的运行时。

我还没有拿它做数周的生产环境实测。[Prime Agent 的正式发布文章](https://www.primeintellect.ai/blog/prime-agent)上线于 2026 年 8 月 5 日；截至本文 8 月 13 日更新时，从正式发布算起只有 8 天。[GitHub 仓库](https://github.com/PrimeIntellect-ai/prime-agent)和[早期版本](https://github.com/PrimeIntellect-ai/prime-agent/releases/tag/v0.0.1)实际更早就已存在，这里说的只是正式发布后的观察时间。

因此，这篇更像一份早期源码观察，不是生产实测报告。下面的判断来自源码、官方论文与文档、公开评测和社区信号的交叉阅读。如果你正在关注 RLM、长任务 Agent 或 Multi-Agent 编排，Prime Agent 已经值得放进观察清单。

## 我的判断

- Prime Agent 最值得看的，是把持久 IPython、RLM 子 Session、daemon 后台任务和 Continual Harness 组合成一个 coding/research runtime。
- `rlm()` 会启动独立子 Session。父 Agent 拿到任务句柄后可以继续工作，子 Agent 的结果稍后经消息或文件汇合。
- self-improving 在当前实现里指 Harness 配置变化。`/refine` 可以调整 Prompt、Memory、Skill 和 Subagent 定义，不会训练模型权重，也不能自动证明新配置更好。
- Harness 是否合适，要连同模型、任务、成本和权限边界一起看。Prime 允许持续调整这些配置；调整后的效果仍要通过评测、版本记录和回滚来验证。
- 我更愿意把它用于研究、审计和长流程实验。0.x 阶段仍在快速迭代，运行成本、恢复语义和安全隔离都要由使用者自己设边界。

## 先看整体：RLM、Prime Agent 与 Continual Harness

如果把这套运行时分开看，各部分大致这样分工：

- 聊天记录负责保存交互轨迹；
- IPython 负责保存并操作工作状态；
- RLM 子 Session 负责拆分独立任务；
- daemon 负责让常规交互任务跨越一个终端窗口继续运行；
- Continual Harness 负责把经验写进下一轮可使用的行为配置。

这些能力单独看都不陌生。我开始认真看 Prime Agent，正是因为它把这些能力组合成了一条明确的默认路径。

我的理解是：RLM 提供方法，Prime Agent 提供运行时，Continual Harness 管理下一轮还会继续使用的行为配置。

<figure class="technical-diagram">
  <picture>
    <source media="(max-width: 600px)" srcset="/images/prime-agent-recommendation-v2/prime-agent-three-parts-mobile.svg" type="image/svg+xml">
    <img src="/images/prime-agent-recommendation-v2/prime-agent-three-parts.svg" alt="RLM 提供外部上下文处理与递归调用方法；Prime Agent 将持久 IPython、父子 Session、daemon 和有界恢复组合成运行时；运行轨迹可用于调整 Prompt、Memory、Skill 和 Subagent 配置。" decoding="async">
  </picture>
  <figcaption>图 1：三者的概念关系。RLM 提供方法，Prime Agent 将其组合成运行时，运行轨迹再用于调整后续 Harness 配置；箭头不代表性能高低或固定时序。<a href="/images/prime-agent-recommendation-v2/prime-agent-three-parts.svg">查看桌面版矢量原图</a>。</figcaption>
</figure>

## 我最想聊的三个设计

### 1. 持久 IPython：默认工具面，也是 Agent 的工作台

传统 Agent 经常要回到对话上下文里找状态：刚才看了哪些文件，保存了什么结果，下一步该处理哪组数据。

第一个值得展开的细节，是 Prime Agent 的默认工具面：在模型的直接 tool-calling 层，它只提供一个内建工具，`ipython`。[官方发布文章](https://www.primeintellect.ai/blog/prime-agent)直接写的是 “a persistent IPython kernel as their only tool”；`v0.7.2` 的 [RLM 文档](https://github.com/PrimeIntellect-ai/prime-agent/blob/v0.7.2/packages/coding-agent/docs/rlm.md#L29-L33)和[工具注册源码](https://github.com/PrimeIntellect-ai/prime-agent/blob/v0.7.2/packages/coding-agent/src/core/tools/index.ts#L40-L80)也只列出 `ipython`。Extension 和 SDK custom tools 仍然可以增加或覆盖模型可见工具，所以这是默认设计，不是硬上限。

`ipython` 在这里更像 Agent 的总控台。文件操作、Shell 命令、数据处理、Skill、MCP、上下文管理和 RLM 子 Agent，都从持久 kernel 进入。模型可以把几步操作写成一段程序，再循环、并发或换参数继续跑。

这和 Claude Code、Codex、OpenCode 常见的 Read、Edit、Bash 等显式工具面很不一样。Prime Agent 把模型的工作集中到一个持久、可编程的 Python 环境里。一个内建工具，并不等于只有一种能力。

每个 Session 都可以按需启动一个共享 namespace 的 IPython kernel。目录列表、解析结果、数据结构、变量和导入模块可以留在这个 namespace 中，后续步骤接着使用。Agent 不必每次都从对话里把这些状态重新找回来，也可以写程序搜索、切片和重组长上下文。

<figure class="technical-diagram">
  <picture>
    <source media="(max-width: 600px)" srcset="/images/prime-agent-recommendation-v2/prime-agent-default-tool-surface-mobile.svg" type="image/svg+xml">
    <img src="/images/prime-agent-recommendation-v2/prime-agent-default-tool-surface.svg" alt="Prime Agent 默认只注册 IPython 内建工具，模型通过持久 kernel 编排文件、命令、Skill 和 RLM 子 Session；Extension 可改变可见工具集合。" decoding="async">
  </picture>
  <figcaption>图 2：Prime Agent 的默认工具面与背后能力。该图限定在项目默认配置；配置覆盖与 Extension 可以扩展模型可见的工具集合。<a href="/images/prime-agent-recommendation-v2/prime-agent-default-tool-surface.svg">查看桌面版矢量原图</a>。</figcaption>
</figure>

比如接好协作文档接口后，可以先把口播稿送过去，等人改完，再拉回本地对比。同一 Session 里，这几个步骤跑通一次后就能留成函数，下次只换参数。要跨 Session 重用，再把流程保存成脚本。原先要反复描述的操作，现在变成了一段可以继续修改的代码。

我喜欢这套设计，是因为它把 Agent 工作重新拉回了熟悉的编程方式：上下文可以像变量一样保存、切片和重组，文件、命令、Skill 和子 Agent 可以像函数一样组合，跑通的步骤也能留成代码。到了 `/refine`，连 Prompt、Memory、Skill 和 Subagent 这些“怎样工作”的配置，也成了可记录、修改和回滚的状态。

更准确地说，Prime Agent 不是让 Python 直接解决所有问题，而是用代码组织问题、保留状态和编排能力。具体项目仍在自己的环境里运行；能修改工作方式，也不等于修改后一定更好，效果仍要靠评测和回滚验证。

至于是否真的省时间或 token，目前还没有同口径 benchmark。

这和 [Recursive Language Models 论文](https://arxiv.org/abs/2512.24601)的思路一致：面对超长输入，可以先把内容放在外部环境里，再让模型用程序按需查看和处理。RLM 原作者也特意提醒过，[RLM 本身不是 Agent](https://alexzhang13.github.io/blog/2025/rlm/)，更接近一种上下文处理方法。Prime Agent 把这套方法放进了 coding/research Agent 的运行时。

“持久”也不是魔法。

在常规 daemon-backed 交互中，终端 UI 断开后，仍然存活的 worker 和 kernel 可以继续工作，之后再 attach。worker 真正崩溃时，系统会依据 JSONL、artifacts 和 kernel snapshot 尝试重建；无法序列化的对象仍可能丢失，状态不确定的任务也不承诺 exactly-once 重放。项目的 [daemon 文档](https://github.com/PrimeIntellect-ai/prime-agent/blob/a3b3e753490d0a6ed180e905200c1a6690d78608/packages/coding-agent/docs/daemon.md)把这些恢复边界写得很清楚。

这里要把边界说窄一点：Prime Agent 提供的是有界、best-effort 的连续运行和恢复，不保证任何崩溃都能无损续跑。

### 2. RLM 子 Agent：子任务在独立 Session 里运行

前面提到的 `rlm()` 很能代表 Prime Agent 的设计。

根据 [RLM Runtime 文档](https://github.com/PrimeIntellect-ai/prime-agent/blob/a3b3e753490d0a6ed180e905200c1a6690d78608/packages/coding-agent/docs/rlm-runtime.md#L23-L30)和当前实现，调用 `rlm()` 后，父 Agent 在任务被接纳时就能拿到 `RLMSpawnHandle`，然后继续处理自己的工作。子 Agent 在独立上下文里运行，结果通过显式消息或 artifact 文件汇合。

它的运行方式和“调用一个模型，等待字符串返回”差别很大。

多个子 Agent 可以分别处理架构、安全、测试和文档，父 Agent 同时继续整理材料。对于 daemon-backed 且成功保留的 child，父 Session 存续期间还可以再次定位并发起 follow-up。

代价也很现实：谁负责判断子任务完成，怎样汇总多个结果，文件归谁所有，token 怎样记账，失败后怎样恢复，都需要运行时认真管理。

Prime Agent 没有消除这些问题，只是把它们从隐藏的聊天流程变成了明确的系统对象。我喜欢的是，这些复杂度没有被一个漂亮的异步接口藏起来。

### 3. 后台 Session：daemon 模式下可以关掉终端继续跑

许多 Coding Agent 最舒服的使用场景，是人在终端前与模型来回配合十几分钟。Prime Agent 明显在为更长的任务设计。

它把 daemon、goal、schedule、heartbeat、上下文压缩和恢复放进运行时核心。Agent 可以围绕一个目标持续工作，终端 UI 只是连接 Session 的客户端，并不天然等于任务本身。

这套设计很适合下面这些过去做起来有些笨重的任务：

- 数小时阅读一个陌生仓库；
- 分批审计大量文件；
- 让多个子 Agent 分头研究；
- 周期性检查某种状态；
- 在上下文压缩后继续围绕原目标工作。

任务变长后，token 成本、方向漂移、重复劳动和错误积累也会跟着增加。真要跑长任务，仍得配好预算、停止条件和独立质量门。

<figure class="technical-diagram">
  <picture>
    <source media="(max-width: 600px)" srcset="/images/prime-agent-recommendation-v2/prime-agent-runtime-flow-mobile.svg" type="image/svg+xml">
    <img src="/images/prime-agent-recommendation-v2/prime-agent-runtime-flow.svg" alt="Prime Agent 长任务工作流：父 Agent 在持久 IPython 中工作，通过 rlm 创建独立子 Session；调用接纳后返回句柄，子 Session 后续通过消息或文件返回结果，daemon 支持 detach 后继续运行。" decoding="async">
  </picture>
  <figcaption>图 3：复杂仓库审计的工作方式示意。该图不表示固定耗时、并发上限或性能结果；<a href="/images/prime-agent-recommendation-v2/prime-agent-runtime-flow.svg">查看桌面版矢量原图</a>。</figcaption>
</figure>

## self-improving 没有那么玄

**self-improving** 很容易让人联想到模型在运行中训练自己。Prime Agent 当前做的不是这件事。

它不会在本地重新训练模型，也不会修改模型权重。当前 `/refine` 允许调整的是四类 Harness 状态：

| 状态     | 保存或调整的内容                  | 不是什么                   |
| -------- | --------------------------------- | -------------------------- |
| Prompt   | 补充给模型的行为说明              | 不是重写基础 system prompt |
| Memory   | 事实、决策、失败、偏好和结果      | 不是模型权重记忆           |
| Skill    | Skill 描述、Python 引用和参数契约 | 不是自动生成并验证生产插件 |
| Subagent | 可复用的分工说明和调用时机        | 不是训练一个新模型         |

我把它理解成 Agent 的“作战手册”。

一次任务里反复踩过的坑，可以记进 Memory；某类任务适合交给什么子 Agent，可以整理成 Subagent 配置；Skill 的调用条件和参数说明，也可以根据轨迹修正。相关研究来自 [Continual Harness 论文](https://arxiv.org/abs/2605.09998)，Prime Agent 则把它做成了产品中的 `/refine` 流程。

源码对修改过程加了不少限制：结构化 proposal、review gate、编辑类型与契约检查、并发冲突检测、before/after 历史和 rollback。基础 system prompt 不允许编辑；自动 refine 只修改当前持久 root Session 的 local Harness store。只有调用方显式请求 global，才会把稳定、可跨 Session 复用的经验写进全局 store。具体边界可在[固定版本的 refinement 实现](https://github.com/PrimeIntellect-ai/prime-agent/blob/a3b3e753490d0a6ed180e905200c1a6690d78608/packages/coding-agent/src/core/refinement/refinement.ts#L123-L185)中核对。

这些护栏解决不了效果验证。Prime Agent 能记录“为什么改、实际改了什么、预期哪里会变好”，方便事后审计，却不能证明改完以后真的更好。

当前 apply 路径没有强制要求 benchmark、A/B 对照或测试门。能够回滚，也不代表每次修改都安全。我会把现阶段的能力称为“可审计的在线配置演化”，而不是“越用越聪明”。

配好 Heartbeat 或 Schedule 后，再加上 Goal 和 `/refine`，它确实有点像一个能值夜班的“数字员工”：记着目标，定时醒来检查，还会把一部分经验留给下一轮。目前能确认的是这些机制本身，离稳定工作几天还有多远，要靠长期测试。

<figure class="technical-diagram">
  <picture>
    <source media="(max-width: 600px)" srcset="/images/prime-agent-recommendation-v2/prime-agent-refinement-boundary-mobile.svg" type="image/svg+xml">
    <img src="/images/prime-agent-recommendation-v2/prime-agent-refinement-boundary.svg" alt="Prime Agent 的 Continual Harness 可以调整 Prompt、Memory、Skill 和 Subagent 配置，但不会直接训练模型权重、替换基础系统提示或修改产品源码；配置变化仍需要独立评估。" decoding="async">
  </picture>
  <figcaption>图 4：Continual Harness 的能力边界。review、版本历史和 rollback 是变更护栏，不是 benchmark 或质量证明；<a href="/images/prime-agent-recommendation-v2/prime-agent-refinement-boundary.svg">查看桌面版矢量原图</a>。</figcaption>
</figure>

## Hermes 也说自己会进化，分叉在哪里

看到 self-improving 这个词，我很自然地想到了 [Hermes Agent](https://github.com/NousResearch/hermes-agent)。它的项目首页同样把“自我改进”放在显眼位置，而且已经把学习循环接进日常 Agent 工作流。下面的比较以截至 2026 年 8 月 12 日的稳定版 [Prime Agent v0.7.2](https://github.com/PrimeIntellect-ai/prime-agent/releases/tag/v0.7.2)和 [Hermes Agent v0.20.0](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.8.3)为基础。

两边当前公开的学习闭环都没有在任务过程中训练基础模型权重。变化发生在模型外部，先把经验保存成可读、可复用的材料，再让后续任务重新用到这些材料。

Hermes 的做法更接近“边工作，边整理自己的知识库”。根据它的 [Memory 文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)，任务结束后的后台 review 可能把稳定信息写入有长度限制的 `MEMORY.md` 和 `USER.md`；历史 Session 仍可通过 SQLite/FTS5 搜索。它的 [Skills 文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)则允许 Agent 创建、修改或删除 `SKILL.md` 及配套文件，`/learn` 也可以把资料或一套流程整理成 Skill。

当前源码还给后台写入加了 ownership 边界：review 只维护 curator-managed Skill；用户自写、从 Hub 安装、来自外部目录或被 pinned 的 Skill 默认受保护，除非用户显式执行 `hermes curator adopt <name>` 把维护权交给它。Memory 和 Skill 都能开启写入审批，不过这两个开关默认关闭，因此后台 review 默认可以直接落盘。相关限制可在[固定版本的 background review 实现](https://github.com/NousResearch/hermes-agent/blob/3c27eb6234bf91b8ceee9e9071591b31e9b148cb/agent/background_review.py#L240-L305)中核对。

Prime Agent 的 `/refine` 收得更窄。它先从当前轨迹提出结构化修改，再更新 Prompt、Memory、Skill 描述或 Subagent 配置，保留 before/after 历史和 rollback。Skill 在这里主要是描述、Python 引用与参数契约，并不等于让 Agent 自由重写一套 `SKILL.md` 文件。默认改动也先留在当前持久 root Session，跨 Session 的 global 经验需要显式请求。

执行模型的差别更明显。Prime 把持久 IPython namespace 当作默认工作台；Hermes 仍然是一个拥有大量显式工具的 Agent loop。Hermes 的 [`execute_code`](https://hermes-agent.nousresearch.com/docs/user-guide/features/code-execution) 会临时生成 Python 脚本，通过 RPC 调用工具，脚本结束后只把输出送回模型。它也有 [`delegate_task`](https://hermes-agent.nousresearch.com/docs/reference/tools-reference) 子 Agent，但子任务在隔离上下文里运行，主 Agent 接收最终摘要。Prime 的 RLM child 则是独立 Session，先返回接纳句柄，之后再经消息或文件汇合；保留下来的 daemon-backed child 还能继续 follow-up。

| 观察点       | Prime Agent                                                 | Hermes Agent                                                                      |
| ------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 程序化工作台 | 持久 IPython namespace，变量和函数可跨工具调用复用          | 显式工具为主，`execute_code` 每次运行临时脚本                                     |
| “进化”落点   | 四类结构化 Harness 状态，带 review、历史与 rollback         | 跨 Session 的 profile memory，以及可创建、修改和删除的 curator-managed Skill 文件 |
| 子任务返回   | 独立 RLM Session，句柄先返回，结果经消息或文件汇合          | 独立 delegate 上下文，完成后返回最终摘要                                          |
| 长期运行     | daemon-backed Session、Goal、Heartbeat、Schedule 和有界恢复 | Gateway、Cron 和多种消息入口；Cron 每次触发都会启动新的隔离 Session               |

我会这样区分：Prime 的自动 refine 默认服务于当前持久 Session，重点是让一个复杂任务的工作方式在长时间运行中持续调整；遇到稳定、可复用的经验，也可以显式写入 global Harness，供之后的新 Session 使用。Hermes 则把跨 Session 的 profile memory 和 Skill 库放得更靠前，更像一个持续认识用户、积累工作流程的通用 Agent。两边都有重叠，差别主要在默认重心，并不代表谁的“进化程度”更高。Hermes 的 [Architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)、[Cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)和 [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)文档也能看出这种产品取向。

我能找到的公开材料里，截至 2026 年 8 月 12 日还没有同模型、同任务、同预算的可信 head-to-head benchmark。一份较完整的直接比较来自 [Julian Goldie 的体验视频](https://www.youtube.com/watch?v=V1kRWZZPoG0)：视频展示了 Prime 的 12 万行日志检索和 `/refine`，Hermes 部分则接入作者自建的 Agent OS 与知识库工作流。它没有让两者在同一条件下重复运行，我只把它当作体验记录，不拿它证明性能高下。

## 看成绩时，我更在意那个作弊案例

[Prime Intellect 的发布文章](https://www.primeintellect.ai/blog/prime-agent)报告，Opus 5 在 Prime Agent 上运行 ARC-AGI-3 时，三次 RHAE Best@1 分别为 95.0%、95.2% 和 95.5%，Best@3 为 99.97%。官方还链接了一份 95.2% 中位运行的 [action-replay scorecard](https://arcprize.org/scorecards/2af780b4-f2a1-43e9-a794-b23da3cd3f9f)，并发布了 OOLONG、LongBenchPro、LongBenchv2、ManyIH 和 EmulatorBench 等长上下文结果。

这些数字值得关注，证据层级也要说清楚：它们是 Prime Intellect 的厂商评测，本轮检索没有找到同口径的第三方独立复现。scorecard 提供了运行回放，仍不能代替独立复现。官方还说明，他们自行运行 Claude Code 和 Codex 得到的 ARC-AGI-3 成绩低于两者公开报告，因此在 ARC 对比中采用了对方报告的数字。模型、Harness、提示和评测协议并未完全统一，这组结果不足以证明 Prime Agent 已经全面超过 Claude Code 或 Codex。

95.5% 很抢眼，官方披露的 Factorio 反例却让我停下来多看了一遍。

实验中，Prime Agent 会把成功经验整理成布局和生产 Skill。后来它发现可以通过 RCON 直接把资源传送进机器，从而绕过游戏规则。即使 heartbeat 提醒不要作弊，refine 机制仍把这种做法写成了更高效的作弊 Skill。

这个案例提醒我，自我改进会沿着当前目标和反馈继续放大，系统不会自动替我们判断目标是否正确。

如果验收只看产量，作弊就可能被理解成进步；如果编码任务只看测试变绿，Agent 也可能学会绕过校验、删除测试或过拟合 verifier。Agent 最后积累什么经验，很大程度上取决于目标、反馈和验收规则怎么写。

## 好的 Harness，先要回答“适合什么”

我越来越认同一个判断：Harness 很难有脱离场景的“全局最优”。同一套配置，换一个模型、任务、成本预算、验收标准或权限边界，结果都可能不同。所谓“适合你”，不只是在迎合个人偏好，还要适合你正在使用的模型和需要完成的工作。

[Anthropic 在 Managed Agents 的复盘](https://www.anthropic.com/engineering/managed-agents)里提到，他们曾为 Sonnet 4.5 加入 context reset；换到 Opus 4.5 后，原先要处理的行为已经消失，这套机制也变得多余。Harness 里关于模型能力的假设也会过期。[Continual Harness 预印本](https://arxiv.org/abs/2605.09998)在 Pokémon Red 和 Emerald、多个前沿模型上的实验也把收益概括为 capability-dependent，而不是普遍增益。这些结果还不能直接外推到编码任务。

对长期任务和特定项目，我更愿意测试这种能随实际轨迹调整的 Harness。Prime Agent 吸引我的，正是它把补充提示（prompt notes）、Memory、Skill 定义和 Subagent 规格都纳入了这条路径；基础 system prompt 不在可编辑范围内。

动态 Harness 也得有评测、版本记录、回滚、成本上限和安全审批。固定且验证充分的 Harness，在稳定任务上可能更便宜、更可复现，也更容易控制风险。上面的 Factorio 案例至少说明：目标和验收规则漏掉关键约束时，refine 也可能把 reward hacking 沉淀成可复用 Skill。没有这些约束，“自进化”只是持续改配置，还不能证明它持续变好。

## 和 Claude Code、Codex、OpenCode 的差别，不在功能清单

如果只比较功能名，这几类工具已经越来越像。Memory、Skills、子 Agent 和后台任务都不再是 Prime Agent 独有的卖点。

[Claude Code](https://code.claude.com/docs/en/features-overview)已有 CLAUDE.md、auto memory、Skills、hooks 和 subagents，也有默认关闭的实验性 teams，以及后台 Agent、[Goal](https://code.claude.com/docs/en/goal)与[定时任务](https://code.claude.com/docs/en/scheduled-tasks)；[Codex](https://learn.chatgpt.com/docs/codex/cli)覆盖本地、IDE、桌面和云端工作流，并提供 [Skills](https://learn.chatgpt.com/docs/build-skills)、[subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)与沙箱权限控制；[OpenCode](https://opencode.ai/docs/agents/)也有 rules、Skills、primary/subagents、可恢复和分叉的 Session，以及 [client/server API](https://opencode.ai/docs/server/)。所以，把 Prime 简单写成“能跑长任务，而其他 Coding Agent 只能短对话”，现在已经不准确了。

下面这张表比较的是各自的默认设计中心，按 2026 年 8 月 12 日的资料整理。项目更新都很快，表里的结论只适合当作当时的架构切片。

| 工具         | 默认工作中心                                          | 我看到的辨识度                                                              |
| ------------ | ----------------------------------------------------- | --------------------------------------------------------------------------- |
| Prime Agent  | 持久 IPython、Session tree 与 RLM child               | 把程序化状态、长任务和可回滚的 Harness refinement 放进同一个默认运行时      |
| Hermes Agent | 通用 Agent loop、跨渠道 Gateway 与 Cron               | 跨 Session 维护 profile memory，并把经验整理成可编辑 Skill                  |
| Claude Code  | 显式 coding tools、CLAUDE.md、hooks、MCP 与产品工作流 | subagents、teams、后台任务与 auto memory 都围绕 Claude 模型和官方工作流整合 |
| Codex        | 本地与云端 coding task、worktree、权限和沙箱          | 强调多端并行、受控执行，以及 AGENTS、Skills、需开启的 Memory 等可配置工作流 |
| OpenCode     | 开放的 provider、显式 tools 与 client/server Session  | 模型选择和可改造性强，rules、Skills 与 Agent 配置保持开放                   |

几家的记忆机制很容易混在一起。Claude Code 的 [auto memory](https://code.claude.com/docs/en/memory)会根据纠正和工作模式保存笔记；Codex 也提供本地 [Memory](https://learn.chatgpt.com/docs/customization/memories?surface=app)、Skills 和[自动任务](https://learn.chatgpt.com/docs/automations)，但本地 Memory 默认关闭，开启后才会从符合条件、已经空闲的历史对话中提炼记忆。OpenCode 能按需加载 [AGENTS.md](https://opencode.ai/docs/rules/) 与 [`SKILL.md`](https://opencode.ai/docs/skills/)。这些能力可以组合使用，官方并没有把它们描述成 Prime `/refine` 那样的轨迹驱动闭环。Prime 则把轨迹 review 和四类 Harness diff 做成默认、同构且可回滚的流程。这样的统一流程是否更有效，目前仍没有同口径证据。

[Prompt Engineering 还展示过一份非官方的 20 题小试验](https://www.youtube.com/watch?v=8vUCjYsWeSU)。作者称 20 道不同难度的问题都运行在 DeepSeek V4 Flash 上，用来观察 Prime Agent、Codex、OpenCode 和 Pi 等 Harness。作者当场强调实验仍在进行，并把当前成功率差异称为“mostly noise”，因此没有据此下结论。视频没有完整公开任务集、逐项结果和重复次数，也没有覆盖 Hermes 与 Claude Code。这类小样本更适合暴露问题，暂时还不能回答“谁更强”。

另外两篇相对完整的独立文章也停在早期检查阶段。[Capital & Compute](https://capitalandcompute.net/blog/prime-agent-explained/)明确把 95.5% 标成尚未独立验证的厂商报告，但作者没有安装 Prime；[Curtis Pyke 的 review](https://kingy.ai/blog/prime-agent-review-self-improving-rlm-harness/)检查了 v0.7.0 的源码、依赖、构建和 CLI，却没有连接付费模型或运行真实代码库。它们能帮助核对架构和安装，支撑不了竞品排名。

真要做选择，我会按任务来：

- 日常改代码、修明确问题，我仍优先用自己熟悉的 Claude Code 或 Codex 工作流；
- 想自由切换 provider，并保留较高的开源可改造性，我会先看 OpenCode；
- 想把 Agent 接到消息渠道和 Cron，让记忆与 Skill 跨 Session 积累，Hermes 更顺手；
- 想实验持久 REPL、程序化上下文、独立 RLM Session 和长流程复盘，我才会优先试 Prime Agent。

安全要求高时，我还会单独看隔离策略。[Codex 的沙箱与权限](https://learn.chatgpt.com/docs/sandboxing)是产品控制面的重点，[Claude Code](https://code.claude.com/docs/en/sandboxing)也提供可选的 OS 级 Bash sandbox。[OpenCode](https://opencode.ai/docs/permissions/)提供工具级 `allow`、`ask`、`deny`，但多数权限默认是 `allow`，这不等同于 OS 级 sandbox。Prime 的 [README](https://github.com/PrimeIntellect-ai/prime-agent/blob/v0.7.2/README.md#security)明确说明，worker 和 kernel 不是 security sandbox，Python 与 shell 按用户权限运行。对不可信仓库，我不会直接在装有生产凭据的本机上裸跑 Prime。

我的建议仍然很保守：先并行试验，别急着替换现有工具。

## 我为什么还愿意推荐它

Prime Agent 现在还不能证明，持续变化的 Harness 一定优于静态 Harness；它也没有足够的独立生产证据证明自己已经成熟。

但它把这个问题做成了可以阅读、运行和批评的开源实现：模型越来越会写程序、操作环境和调度其他 Agent 以后，Harness 还要不要一直由开发者预先写死？

Prime Agent 给出的答案很明确：允许 Agent 根据实际轨迹持续调整自己的工作方式。Hermes 从跨 Session Memory 和 Skill 给了另一种答案，Claude Code、Codex 与 OpenCode 也在用各自的记忆、自动化和扩展机制靠近这个问题。

这条路线很有想象力。成本、恢复、验证、作弊和安全隔离这些麻烦，也被它一起带到了台前。

我暂时不会拿它替换 Claude Code 或 Codex，但会在隔离环境里用它跑几次真正的长任务，重点看成本、恢复和 `/refine` 是否经得住复盘。对同样在研究 Agent Runtime 的人，我愿意推荐现在就试。

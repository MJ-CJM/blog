---
publishDate: 2026-08-21T01:00:00Z
title: '同样叫 Agent Harness，Pi 和 DeepSeek Harness 把调度权交给了谁？'
excerpt: '我把同一份七 Agent Workflow 分别跑进 Pi 和 DeepSeek Harness，追踪的不是谁更快，而是调度权落在哪一层：DSH 允许插件向内接管 Agent Loop，同时复用官方 WorkflowEngine；Pi 保留子 Agent 的官方 Loop，由 Extension 在外层自建 Workflow Runtime。'
image: '~/assets/images/same-harness-pi-dsh/pi-vs-dsh-harness-hero.png'
category: 'AI Agent 源码观察'
tags:
  - Pi
  - DeepSeek Harness
  - Agent Harness
  - Agent Loop
  - Workflow Runtime
  - Multi-Agent
author: 'Chen Jiamin'
metadata:
  canonical: 'https://blog.mj-cjm.com/same-harness-pi-dsh'
---

我把同一份 saved workflow 脚本分别跑进 DeepSeek Harness 和 Pi。正常成功路径下，三个 Agent 并行审查代码，三个 Agent 分别挑战前面的审查，最后由第七个 Agent 综合结果。页面上看，两边都完成了一条七 Agent 调用链；我真正想追踪的，却是这条调用链背后的调度权最终落在了哪一层。

这里的“调度权”不只是决定谁先执行、谁后执行。它还包括：谁创建 Agent，谁选择模型，谁限制预算和并发，谁处理超时与取消，谁在部分失败时判断是否达到继续执行所需的最低成功数，以及谁保存状态、结果和失败证据。**谁拥有这些决定，谁就掌握相应执行层的主要控制权，也要为这一层的正确性负责。** 本文把这条边界拆成两层：单个 Agent 内部的执行循环（Agent Loop），以及多个 Agent 之间的 Workflow 编排（Workflow Runtime）。控制权落在哪一层，会直接影响插件能改到多深、能复用多少平台能力，以及开发者最终要维护多少复杂度。

功能表很难回答这个问题。Pi 和 DSH 都能列出 Skill、Tool、Agent 和 Session；只有把插件真正写出来，再让流程经历成功与失败，才能看清平台托管到哪里、插件责任又从哪里开始。

DSH 侧，我开发了 Dynamic Workflow Wrapper、AgentLoop Adapter 和 Full Custom Loop，组成 Stock、Adapter、Full Custom 三种控制深度。Stock 直接组合官方 Agent Loop；Adapter 继承官方 `AgentLoop`，在 Agent 的创建与恢复生命周期中注入约束，但不重写官方 ReAct；Full Custom 不依赖官方 AgentLoop，自行实现模型—工具循环。三种深度都继续复用同一套官方 `WorkflowEngine` 实现。

Pi 侧，我开发了一个 Coding Agent Extension。它没有替换每个子 Agent 的官方 Loop，而是在 Loop 外持有 Workflow Runtime，自己负责 saved workflow 解释、子进程调度、模型 Profile、三层超时、前台进度、取消、状态与结果持久化。

正常完成、固定超时、工具预算耗尽和部分 Agent 失败，都是这次实验的验证探针。它们不是文章要比较的问题本身，而是用来检验调度权是否真的生效：Agent 为什么停止，流程为什么继续，最后又留下了什么证据。

> **实验呈现出一组近乎镜像的实现关系：DSH 允许插件向内接管 Agent Loop，同时复用官方 Workflow Runtime；Pi 的 Coding Agent Extension 则保留子 Agent 的官方 Agent Loop，在外层自建并拥有 Workflow Runtime。**

因此，这不是“谁的功能更多”，也不是模型效果、速度或成本排名。文章要画出的是一张责任地图：平台已经替插件承担了什么，插件接管某一层以后又必须为哪些正确性负责。后文会用插件实现、源码、自动测试和真实运行收据展开这张图，也会明确本次实践尚未证明的能力边界。

## 一、先把比较边界说清：同一份 Workflow 脚本，不同的 Runtime

这不是一次模型横评。为了尽量减少比较变量，我把两边的 saved workflow 保持为逐字节一致：

```text
3 个 independent reviews 并行
  → 至少 2 个成功
  → 对成功 review 分别进行 challenge
  → 至少 2 个 challenge 成功
  → final synthesis
```

正常路径下一共启动七个 Agent：

```text
fast-review + deep-review + review-review
  + 3 × challenge-review
  + final-synthesis
```

固定的是脚本字节、阶段、Agent 标签，以及“至少两个 Review、至少两个 Challenge”的基础成功计数门槛；没有固定的是额外路由门禁、Prompt、模型和结果契约。DSH Wrapper 还把成功路由多样性设为 2，并在完成后复验实际路由；Pi 实跑没有同等的双模型门禁。几次运行处理的都是代码架构审查，任务语义接近，但 Prompt 并非逐字相同。因此这只能算 Workflow 结构控制实验，不能算严格的模型效果基准测试。

<figure class="technical-diagram">
  <picture>
    <source media="(max-width: 600px)" srcset="/images/same-harness-pi-dsh/shared-seven-agent-workflow-mobile.svg" type="image/svg+xml">
    <img src="/images/same-harness-pi-dsh/shared-seven-agent-workflow.svg" alt="实验设计与比较边界：两端固定同一 saved workflow 的脚本字节、正常成功路径下的 3→3→1 流程、Agent 标签和基础成功计数；DSH 另有成功路由多样性门禁，Pi 没有同等双模型门禁；本文只比较控制权、生命周期、失败语义和证据落点，不比较模型质量、速度或成本" decoding="async" loading="lazy">
  </picture>
  <figcaption>图 1：控制变量与比较边界。两端固定 saved workflow 的脚本字节、正常成功路径的流程拓扑、Agent 标签和基础成功计数；DSH 的额外路由门禁、两端 Runtime、模型路由与结果契约如实保留差异。独立 Review 失败时，Challenge 数会降为 2，因此 `3→3→1` 不是所有运行的固定形态。本文不比较模型质量、速度或成本。<a href="/images/same-harness-pi-dsh/shared-seven-agent-workflow.svg">查看桌面版矢量原图</a>。</figcaption>
</figure>

证据也分三层记录：

| 证据         | 能证明什么                                               | 不能证明什么                    |
| ------------ | -------------------------------------------------------- | ------------------------------- |
| 真实模型运行 | 路由、阶段、预算、outcome 和最终契约在真实链路里是否生效 | 平台总体性能、成本与模型智能    |
| 无模型测试   | 生命周期、失败门禁、取消、恢复和结果结构是否符合代码契约 | Provider 在所有网络条件下的表现 |
| 源码审计     | 能力属于哪个 seam，哪些逻辑被继承或复用                  | 未运行分支已经具备生产可靠性    |

还有一个不能回避的限制：DSH 实跑使用 `deepseek-v4-flash` 和 `deepseek-v4-pro` 两个真实模型；Pi 实跑使用同一个 `glm-5.2`，只调整 low、high、medium 三档 thinking。因此下面比较的是 Harness 把责任放在哪里，不是哪个模型回答得更好，也不能拿单次耗时比较平台性能。

## 二、DSH 的控制权阶梯：Stock、Adapter、Full Custom

[DeepSeek Harness 的官方架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)把 LLM、Tool、Session、Agent Loop 等能力放进可组合的插件和服务体系。抽象描述很容易让人误以为“什么都能替换”。我实际做了三次，才把“替换”拆成三层。

### 1. Stock：先证明普通插件已经够用

Stock Profile 没有改 Agent Loop：

- 根 Agent 使用官方 `AgentLoop/ReactLoopAgent`；
- Skill 引导模型调用固定的 `profiled_dynamic_workflow` Tool；
- 本地插件只负责脚本 allowlist、模型 Profile、结果结构规则和遥测；
- 实际的 `parallel`、`pipeline`、Worker 生命周期和子 Agent 管理由官方 WorkflowEngine 完成。

实际运行结果是 7/7 completed，总耗时 522,415 ms，没有模型重试。三个逻辑 Profile 最终解析到 Flash 和 Pro 两条真实路由，route、retry 和 outcome telemetry 都完整。最终结果还通过了自动结构校验：必须恰好返回三项，每项都包含四个必填字段。

这一步证明的事情很朴素：**复杂的七 Agent Workflow 不要求先换 Loop。** 普通 Skill、Tool 和一个很薄的 wrapper，已经可以组合 DSH 的官方 Loop、Subagent、Session、Web 和 WorkflowEngine。

### 2. Adapter：换了 Factory，不等于换了 ReAct

第二个 Profile 禁用了官方 AgentFactory row，启用了本地 `WorkflowAwareAgentLoop`。这个类继承公开的官方 `AgentLoop`，只覆盖 `createAgent()` 和 `resume()`，在 Agent setup 时注入 supervisor、Guard 和回执。

模型请求、ReAct stepping、工具并发、取消、Session 和 teardown 仍然沿用官方实现。

Adapter 的实跑也是 7/7 completed，总耗时 484,039 ms，没有重试。页面、阶段、Tool 卡片和最终报告都和 Stock 很像。

这种相似正是预期结果。它证明 DSH 可以替换 AgentFactory，并把横切策略放进统一的创建和恢复生命周期；同时也证明：

> **“启用了自定义 Loop 插件”与“重写了一套 Agent 算法”是两件事。**

Adapter 更像生命周期适配层。它改变约束注入的位置，没有改变 Agent 怎样思考和调工具。

### 3. Full Custom：这次真的接管执行循环

第三个方案没有继承官方 `AgentLoop`，也没有使用官方 `ReactLoopAgent` 或工具 scheduler。我重新实现了：

- AgentFactory 与 Agent；
- Inbox、Turn 和 Step；
- 根 Agent 的 `Plan → Act → Reflect → Finalize`；
- 严格串行的工具调度；
- 模型调用、工具调用和 Turn 墙钟预算；
- cancel、owner cleanup、dispose；
- 持久 Turn 边界的恢复与重规划；
- 独立 trace 和诊断 Tool。

运行时诊断会明确返回：

```text
implementation = @local/dsh-full-custom-loop
algorithm = budgeted-plan-act-reflect/v1
inheritsOfficialAgentLoop = false
usesOfficialReactLoopAgent = false
toolScheduling = strictly-serial
```

但“完全自写 Loop”不等于把整个 DSH 重写一遍。它仍然复用了官方的 Session、LLM Provider、System Prompt、Tool Registry、Guard、Approval、Web、Subagent 和 WorkflowEngine。被接管的是 Agent 的模型—工具执行循环。Dynamic Workflow 的子 Agent 走的是同一自定义实现提供的 `direct-budgeted` 路径，同样受串行工具和预算约束，但不会逐个完整执行根 Agent 的四阶段流程。

这次真实运行启动了七个 Agent，其中六个完成，一个 Challenge 因 `maxToolCalls=8` 触发 `FULL_CUSTOM_LOOP_BUDGET`。另外两个 Challenge 达到最低成功门槛，Synthesis 正常完成；总耗时 456,020 ms，重试为零，最终结果结构校验通过。

这条预算失败提供了 7/7 结果里看不到的证据：预算不是 Prompt 里的建议，而是自定义 Loop 的执行规则；子 Agent 失败后，WorkflowEngine 仍会根据最低成功门槛判断整轮是否继续。

Full Custom 还有一条必须写清的边界：实现用到了根包可以导入、但标记为 `@internal` 的 `Inbox.claim()`。所以它是一次有效的能力边界探针，还不能当作长期稳定的生产 ABI。

三层实验可以压成一张表：

| 层次        | Loop 所有权                     | WorkflowEngine | 实跑结果                | 它证明了什么                                  |
| ----------- | ------------------------------- | -------------- | ----------------------- | --------------------------------------------- |
| Stock       | 官方                            | 官方           | 7/7                     | 普通插件可以组合平台能力                      |
| Adapter     | 继承官方，替换 Factory 生命周期 | 官方           | 7/7                     | 可以统一注入横切策略                          |
| Full Custom | 插件自写                        | 官方           | 7 started / 6 completed | 可以接管 Agent loop，代价是正确性责任一起转移 |

<figure class="technical-diagram">
  <picture>
    <source media="(max-width: 600px)" srcset="/images/same-harness-pi-dsh/dsh-control-depth-mobile.svg" type="image/svg+xml">
    <img src="/images/same-harness-pi-dsh/dsh-control-depth.svg" alt="DSH 控制权阶梯：Stock 组合官方 Loop，Adapter 继承官方 AgentLoop、通过 Profile 替换 AgentFactory 并在 setup 后注入监督、Guard 与回执，Full Custom 接管 Agent 执行循环；三者继续复用官方 WorkflowEngine" decoding="async">
  </picture>
  <figcaption>图 2：DSH 控制权阶梯。Stock 组合官方 Loop；Adapter 继承官方 AgentLoop，通过 Profile 替换 AgentFactory，并在原 setup 完成后注入 supervisor、Guard 与回执；Full Custom 接管 Agent 执行循环。三者都继续复用官方 WorkflowEngine。控制深度不代表优劣或成熟度。<a href="/images/same-harness-pi-dsh/dsh-control-depth.svg">查看桌面版矢量原图</a>。</figcaption>
</figure>

三种模式改变的是 AgentFactory 与 Agent Loop 的实现，下面这条 Dynamic Workflow 执行链保持一致：根 Agent 通过 Skill 调用 allowlisted Tool；本地 Wrapper 负责解析与准入、模型 Profile、结果契约和遥测；官方 WorkflowEngine 运行 trusted saved workflow，并通过 Subagent 与 Agent Registry，把每个 `agent()` 节点交给当前 Profile 选中的 AgentFactory。

<figure class="technical-diagram">
  <picture>
    <source media="(max-width: 600px)" srcset="/images/same-harness-pi-dsh/dsh-dynamic-workflow-runtime-mobile.svg" type="image/svg+xml">
    <img src="/images/same-harness-pi-dsh/dsh-dynamic-workflow-runtime.svg" alt="DSH Dynamic Workflow 插件实现链：Web 或根 Agent 通过 Skill 调用 allowlisted Tool，本地 Wrapper 负责准入、结果结构校验和 telemetry，官方 WorkerThread WorkflowEngine 运行 trusted saved workflow，agent 节点经 Subagent 与 Agent Registry 交给 Profile 选中的 Stock、Adapter 或 Full Custom AgentFactory；底层继续复用 Session、LLM、Tool Guard、Web、Subagent 与 AbortSignal 生命周期传播接口" decoding="async" loading="lazy">
  </picture>
  <figcaption>图 3：DSH 插件的实际执行链。插件拥有 allowlisted Wrapper、模型 Profile、结果契约与遥测；官方 Runtime 拥有 WorkflowEngine，并经 Subagent 与 Agent Registry 把节点交给当前 Profile 选中的 AgentFactory。Stock、Adapter、Full Custom 改变 Agent Loop，不改变 WorkflowEngine；trusted saved script 与 WorkerThread 也不是敌意代码安全沙箱。<a href="/images/same-harness-pi-dsh/dsh-dynamic-workflow-runtime.svg">查看桌面版矢量原图</a>。</figcaption>
</figure>

## 三、Pi 的实现：Extension 怎样在 Loop 外造出 Workflow Runtime

[Pi 的官方 README](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/README.md)把自己定位为一个小而可扩展的 terminal coding harness，鼓励开发者通过 Extension、Skill、Prompt、Theme 和 Package 适配自己的工作流。[Extension 文档](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/extensions.md)提供 Tool、Command、事件、UI、Provider 和 Session state 等扩展面；在本次审计的 Pi 0.84.2 Coding Agent API 中，公开 Extension 路径没有一套稳定的整 Loop replacement seam。

这里需要一个限定。Pi 较低层的 [`pi-agent-core`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/agent/README.md#low-level-api) 公开了 `Agent`、`agentLoop()` 和 `agentLoopContinue()`，应用可以直接调用低层 Loop。Pi 与 DSH 的区别不是“一个能改 Loop、另一个不能”，而是替换入口位于不同层级：DSH 把 AgentFactory/Loop Provider 放进运行时插件图；Pi 把低层 Loop 暴露为库 API，却没有把它做成 Coding Agent Extension 的热插拔 Provider seam。

这也不代表 Pi 做不了 Dynamic Workflow。它意味着沿着这次采用的 Coding Agent Extension 路径，最自然的实现位置不同。

如果把这套 Pi 插件拆开看，它其实有三层。控制层接收 `/dw-run`、驱动 saved workflow，并决定何时启动下一阶段；执行层把每次 `agent()` 变成一个独立 Pi JSON 子进程，子进程内部仍运行官方 Pi Agent Loop；证据层解析 stdout，把状态写进 `state.json`、`events.jsonl` 和 `result.json`，同时负责前台进度、Esc 取消以及超时后的 `SIGTERM → SIGKILL`。

因此它实现的是一套 **Extension-owned Workflow Runtime**，而不是一个可热替换的 Pi Agent Loop。

<figure class="technical-diagram">
  <picture>
    <source media="(max-width: 600px)" srcset="/images/same-harness-pi-dsh/pi-extension-runtime-mobile.svg" type="image/svg+xml">
    <img src="/images/same-harness-pi-dsh/pi-extension-runtime.svg" alt="Pi Extension Runtime 实现：前台 dw-run 命令进入插件自建 DynamicWorkflowEngine，由 Worker 和 node:vm 解释可信 saved workflow，每个 agent 节点启动独立 Pi JSON 子进程，子进程继续运行官方 Pi Agent Loop；插件负责进度、状态、超时、取消和结果文件" decoding="async" loading="lazy">
  </picture>
  <figcaption>图 4：Pi 插件的实现边界。Extension 拥有外层 Workflow 调度、进程、状态、超时和 UI；每个子进程仍使用官方 Pi Agent Loop。这里的子进程是故障与终止边界，不应被解释成敌意代码安全沙箱。<a href="/images/same-harness-pi-dsh/pi-extension-runtime.svg">查看桌面版矢量原图</a>。</figcaption>
</figure>

为了让这条路径能实际运行，Extension 自己实现了：

- saved-script parser；
- Worker/VM scheduler；
- Agent 与并发数量限制；
- provider、model 和 thinking 路由；
- idle、单 Agent hard、整轮 run 三层 timeout；
- SIGTERM 到 SIGKILL 的收敛；
- `state.json`、`events.jsonl`、`result.json`；
- TUI/RPC 前台进度；
- Esc 取消；
- 结果卡与 `/dw-result` 重放；
- 错误脱敏和 root cause 展示。

这套 Runtime 不是第一次就写对的。比状态文件更早暴露问题的，是一次失败穿过模型服务、Agent 和 Workflow 三层之后，还剩下多少可解释的信息。

早期一次运行中，三个 Reviewer 都遇到模型服务返回的 429：当时的额度窗口已经用尽，旧版仍让每个子进程分别走完三轮默认重试。等错误传到 Workflow 层，屏幕上只剩“至少需要两个成功的独立审查”。这句话准确解释了流程为什么不能继续，却没有说明最先失败的是谁、失败来自模型服务还是本地调度，以及中间究竟发生了多少次重试。另一次运行中，三个仍在读取代码的 Reviewer 又同时撞上固定 120 秒上限，最终收敛为 0/3。

这两次失败把外层 Workflow Runtime 必须承担的责任列得很清楚：它不能只统计成功数，还要保留当前阶段、活动 Agent、模型服务的原始错误、重试过程和终止原因。否则，额度耗尽看起来会像审查逻辑失效，超时也只会留下一个上层门禁错误。后续版本因此把 `/dw-run` 改成前台执行，让进度与根因同时出现在界面和事件文件中；固定 120 秒也被拆成空闲超时、单 Agent 绝对上限和整轮上限，运行中可以直接用 Esc 取消。

完成这些改造后，三次完整落盘的实跑留下了清楚的收据：

| run                             | 结果          | 暴露的问题                                        |
| ------------------------------- | ------------- | ------------------------------------------------- |
| `dw-20260818120218460-fe68d4d7` | 6/7 completed | 一个 Challenge 失败，最低成功门槛仍满足，流程继续 |
| `dw-20260818130946190-3e847d8e` | 0/3 failed    | 三个 Review 命中旧的 120 秒固定上限               |
| `dw-20260818134743536-798e593f` | 7/7 completed | 前台进度、事件与结果文件完整                      |

最新 7/7 run 大约耗时 497,861 ms，共记录 20 条 Workflow 事件，没有模型重试。它证明 Pi Extension 可以拥有一套完整的 Dynamic Workflow Runtime，但没有证明 Pi 替换了每个子 Agent 的官方 Loop，也没有证明三个逻辑 Profile 是三个真实模型——它们仍然是同一个 GLM 的不同 thinking 档位。

## 四、能力差异：不是谁功能更多，而是谁拥有哪一层

把两边放在一起，不能只数 Skill、Tool 或 Extension 的数量。真正影响实现方式的是：平台已经替插件拥有了哪些运行语义，插件又需要对哪些失败负责。下面每一项都同时写能力和边界，因为同一个能力放在平台里与放在插件里，维护成本完全不同。

| 维度                | DSH 本次实验证据                                                                                         | Pi 本次实验证据                                                                                                          | 必须同时写清的边界                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Agent Loop 扩展入口 | Stock 使用官方 Loop；Adapter 继承官方 Loop 并替换 Profile 的 AgentFactory；Full Custom 接管模型—工具循环 | `pi-agent-core` 提供低层 Loop API，但 Coding Agent Extension 没有稳定的热插拔 Loop Provider；本插件保留官方子 Agent Loop | 不能概括成“Pi 完全不能改 Loop”；比较的是本次采用的产品扩展层 |
| Workflow 调度       | 三种模式都复用官方 Worker-thread WorkflowEngine                                                          | Extension 自建 parser、Worker/VM、阶段、并发与最低成功门槛                                                               | 同一份 saved script 不等于同一套 Runtime                     |
| 子 Agent 生命周期   | Agent Registry、Session、Subagent handle 与 signal                                                       | 每个 `agent()` 启动独立 Pi JSON 子进程                                                                                   | 子进程提供故障与终止边界，不是敌意代码安全沙箱               |
| 模型路由            | 实跑验证 Flash 与 Pro 两条实际路由                                                                       | 实跑是同一 `glm-5.2` 的 low/high/medium thinking 档位                                                                    | 不能比较模型质量，也不能把 Pi 实跑写成多模型证明             |
| 状态可观测          | Session、Tool、phase、retry、route 与 outcome telemetry                                                  | `state.json`、`events.jsonl`、`result.json` 加 TUI 前台进度                                                              | 两边证据载体不同，不能用字段多少替代可靠性判断               |
| 失败与继续          | Full Custom 中 1 个 Challenge 预算失败，另外 2 个达到门槛后继续                                          | 旧版本出现 0/3 的 120 秒超时，也有 6/7 与 7/7 完成收据                                                                   | 证明失败策略生效，不是性能排名                               |
| 结果契约            | DSH wrapper 自动检查结果是否恰好包含三项，并要求每项具备四个必填字段                                     | Pi 当前保存并显示 plain-text 结果                                                                                        | 这是本次 wrapper 的能力，不是 DSH 自动替所有 Tool 校验       |
| UI                  | DSH Web 显示 Tool、子 Agent 与结构化结果                                                                 | Pi 前台 `/dw-run`、Esc 取消、结果卡与 `/dw-result`                                                                       | 结论只覆盖本次插件实现，不代表全部 UI 能力                   |
| 恢复                | Full Custom 只验证持久 Turn 边界的恢复与重规划                                                           | 已完成结果可用 `/dw-result` 重放；active run 不支持跨进程 resume/cancel                                                  | 两边都没有证明任意执行点的 durable recovery                  |

这张表最重要的不是哪一列更长，而是责任链的方向。DSH 让插件向 Harness 内部下沉：先组合官方 Loop，再替换 Factory 生命周期，最后接管 Agent 执行循环；这三种实现都没有替换 WorkflowEngine，而是继续使用官方 WorkflowEngine 插件实现。Pi 的 Coding Agent Extension 则向 Loop 外扩张：子 Agent 继续使用官方 Loop，Extension 自己拥有调度、进程、状态、超时与 UI。

所以，“Pi 更简单、DSH 更复杂”不是一个足够准确的结论。Pi 把较多复杂度留给应用和 Extension，DSH 把较多复杂度收进 Runtime 与配置图。两者都没有消灭复杂度，只是选择了不同的默认所有者。

先限定下面这张图的观察范围。[DSH 的架构](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)中，WorkflowEngine、Session、LLM、Tool、Web 和 Agent Loop 都由插件或 Bundle 组合，并不是不可替换的固定内核。本文也不是在绘制 DSH 的完整插件拓扑；为了回答“调度权落在哪里”，图中只展开 Workflow 调度与 Agent 执行循环两层，其余能力统一折叠为本次实验继续复用的插件化服务。

<figure class="technical-diagram">
  <picture>
    <source media="(max-width: 600px)" srcset="/images/same-harness-pi-dsh/loop-vs-runtime-ownership-mobile.svg" type="image/svg+xml">
    <img src="/images/same-harness-pi-dsh/loop-vs-runtime-ownership.svg" alt="调度权切片：DSH 各层都可插件化，本次替换 Agent Loop 插件并复用官方 WorkflowEngine 实现；Pi 保留每个子 Agent 的官方 Loop，由 Extension 自建外层 Workflow Runtime" decoding="async" loading="lazy">
  </picture>
  <figcaption>图 5：调度权切片，而不是 DSH 的完整插件拓扑。DSH 本次替换 Agent Loop 插件，并复用官方 WorkflowEngine 等插件化服务；Pi 保留子 Agent 的官方 Loop，由 Coding Agent Extension 自建外层 Workflow Runtime。图示控制权位置，不是产品优劣比较。<a href="/images/same-harness-pi-dsh/loop-vs-runtime-ownership.svg">查看桌面版矢量原图</a>。</figcaption>
</figure>

## 五、能力边界：这次实验还没有证明什么

能力边界必须和能力结论放在一起。否则一次成功运行很容易被写成平台已经解决了可靠性、安全性和生产化问题。

第一，这不是性能、成本或模型质量测试。两端虽然共享同一 saved workflow，但 Prompt、模型组合和最终结果契约并不相同；DSH 使用 Flash 与 Pro，Pi 使用同一个 GLM 的三档 thinking，单次耗时不能横向比较。

第二，DSH 的 Full Custom 是能力边界探针，不是稳定生产 ABI。它证明第三方可以接管 Agent 的模型—工具循环并继续复用官方 WorkflowEngine，但仍依赖标记为 `@internal` 的 `Inbox.claim()`，恢复也只发生在持久 Turn 边界。

第三，Pi 的实现证明 Extension 可以拥有完整的 Workflow Runtime，却没有替换每个子 Agent 的官方 Loop。`pi-agent-core` 的低层 API 与 Coding Agent Extension 的热插拔 seam 是两个不同层级，不能把本次实现概括成“Pi 没有 Loop API”。

第四，两边都没有完成 active run 的跨进程、跨 Session durable recovery 验证。Pi 的 `/dw-result` 是已完成结果重放；DSH 的 Session 与 trace 也不能自动推出任意执行点恢复。

第五，本实验没有证明任何一侧可以安全执行敌意的同 UID 插件代码。Pi 的 Worker、`node:vm` 与 Node Permission 不是 OS sandbox；DSH 的 Tool/Guard 也不等于 Host 插件隔离。

## 六、业界讨论为什么容易错过这一层

现有 DSH 与 Pi 对比，通常从产品表面展开。[AgentsPulse 的对比文章](https://agentspulse.github.io/tutorials/deepseek-harness-vs-pi-agent/)已经覆盖设计哲学、扩展方式、MCP、安全、Session、UI、部署和运维成本。这样的对比适合帮助读者快速选型，但很难回答 Agent Loop 到底能换多深，也很难看出失败时责任怎样传播。

社区在 [DSH Discussion #1023](https://github.com/deepseek-ai/deepseek-harness/discussions/1023) 里提出过一个有启发性的概括：Pi 与 DSH 都追求小核心和可组合能力，但重心不同——Pi 更接近以 Loop 为中心，DSH 更接近以可替换服务和运行事实为中心。这个判断指出了方向，却没有提供同一 Workflow 脚本在两端的运行证据。

另一类文章关注 Dynamic Workflow 模式本身，例如 [Dynamic Workflows: How Claude Writes Its Own Harness](https://www.sean-weldon.com/blog/2026-06-05-dynamic-workflows-how-claude-writes-its-own-harness)讨论 `agent()`、`parallel()`、`pipeline()`、对抗验证和成本控制。这里的重点是怎样编排 Agent，而不是解释这套 Runtime 应该由平台还是插件拥有。

这次实践补上的，就是中间缺失的一层证据：

1. 同一份 Workflow 脚本，以及语义接近的代码审查任务；
2. DSH 的 Stock、Adapter、Full Custom 控制权阶梯；
3. Pi 的 Extension-owned Runtime；
4. 真实模型路由；
5. 超时、预算与最低成功门槛的失败收据；
6. 机器结果契约和明确的未验证范围。

## 七、怎么选：选择你愿意维护的复杂度

| 需求                                                  | 本次实践中更自然的起点       | 需要承担的代价                                                    |
| ----------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------- |
| 快速组合多 Agent 审查，并统一 Web、Session 与模型路由 | DSH Stock                    | 理解 Profile、Bundle、Provider 与 Runtime 配置契约                |
| 在 Agent create/resume 生命周期统一注入横切策略       | DSH Adapter                  | 跟随官方 AgentLoop 生命周期与版本变化                             |
| 研究新的 reasoning/tool loop、预算或调度算法          | DSH Full Custom              | 自己负责预算、取消、恢复、错误与 teardown；当前还有 internal seam |
| 直接控制终端 UI、子进程、文件结果和三层超时           | Pi Coding Agent Extension    | 自己维护 scheduler、状态、进程与结果协议                          |
| 生产级 durable recovery 或敌意代码隔离                | 本次实验不能直接推荐任何一侧 | 还需要专门的恢复协议、跨进程协调与 OS/容器隔离验证                |

如果目标是个人或小团队工作流，希望直接控制进程、文件产物、UI 和超时，Pi 的路线更自然。它让 Extension 直接拥有外层业务程序，Agent Loop 保持相对稳定；代价是进程管理、状态收敛和结果呈现都落在插件作者手里。

如果目标是组装多个 Provider、Profile 和产品形态，希望 Session、Tool、Web、Subagent 与生命周期由同一个 Runtime 治理，DSH 的路线更自然。它允许插件逐层下沉，甚至接管 Agent Loop；代价是必须接受更强的平台契约，以及[官方仍处于 Developer Preview](https://github.com/deepseek-ai/deepseek-harness#developer-preview)带来的变化风险。

Full Custom 不应成为默认选项。正常业务优先使用 Stock；需要统一注入策略时再考虑 Adapter。只有在研究新的 Agent 算法、特殊工具调度或验证 Harness 边界时，才值得承担 Full Custom 的预算、取消、恢复、事件与 teardown 正确性。

## 结尾：两条路，来自不同的控制权落点

这次实践得到的不是产品排名，而是一张责任分配图。DSH 允许插件沿 AgentFactory 向内下沉，最深接管模型—工具循环，同时继续复用官方 WorkflowEngine、Session 和 Subagent；Pi Coding Agent Extension 则保留子 Agent 的官方 Loop，在外层建立并拥有 Workflow Runtime。复杂度没有消失，只是落在了不同层。

失败场景让这条边界真正可见：DSH Full Custom 的一个 Challenge 用尽工具预算后失败，另外两个 Challenge 仍达到最低成功门槛，流程继续；Pi 旧版的 120 秒上限同时终止三个 Reviewer，工作流以 0/3 失败。它们证明的是预算、终止和继续规则确实生效，不是谁更快、更稳或更聪明。

所以，选型时更值得问的是：“我愿意维护哪一层的正确性？”希望复用统一 Runtime，并按需逐层接管 Agent 行为，可以从 DSH 的 `Stock → Adapter → Full Custom` 阶梯出发；希望直接控制终端、进程、状态和文件结果，Pi Coding Agent Extension 更自然，但也要承担应用级 Runtime 的维护成本。

这仍不是模型、性能或生产成熟度排名。两端的模型、Prompt、路由门禁和结果契约不同；DSH Full Custom 仍依赖 internal seam，两边也都没有证明 active run 的跨进程 durable recovery 或敌意代码隔离。

Harness 的差别，不在于它能装多少插件，而在于一次执行没有按计划结束时，究竟哪一层拥有足够的信息和权力，对“为什么停止、为什么继续、留下什么证据”负责。

---

## 实验收据与发布前边界

| 项目                 | 当前证据                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| 实验版本             | DSH Runtime `0.1.0-rc.6`；Pi `0.84.2`；Node `25.9.0`                                                 |
| DSH 项目全量自动测试 | 10 个 test files，83/83；6 个 Profile dump（包含正文未展开的辅助模块测试）                           |
| Pi 自动测试          | 项目全量 42/42；其中 Dynamic Workflow 26/26                                                          |
| DSH Stock live       | `6690aa5f-1544-4754-b61a-aecbf1f4b267`；7/7 completed                                                |
| DSH Adapter live     | `57e706a5-08c2-45db-9b07-31a50b6840f6`；7/7 completed                                                |
| DSH Full Custom live | `51191adc-2e5b-467f-878f-206954fb6715`；7 started、6 completed、1 budget failure，最低成功门槛仍满足 |
| Pi Dynamic live      | 上文三个完整 runId；7/7、6/7 和 0/3 三类收据                                                         |

发布前禁止外推：

- 不用单次耗时评价平台性能；
- 不把不同模型输出质量归因于 Harness；
- 不把模型生成的源码风险直接写成事实；
- 不把 `outcomeTelemetryComplete=true` 写成所有 Agent 都成功；
- 不把 Full Custom 写成重写了 WorkflowEngine；
- 不把 Pi 的 Worker、`node:vm` 或 Node Permission 写成敌意代码沙箱；
- 不把 DSH 的 Tool/Guard 写成 Host 插件隔离；
- 不把 Pi 写成完全没有底层 Agent API，准确口径是 Coding Agent 的公开 Extension 路径没有稳定 Loop replacement seam。

## 源码附件

为了方便复核和作为博客附件上传，我把两端实现整理成了公开源码快照。压缩包已经排除 `node_modules`、构建产物、运行目录、Session、Profile dump、凭据配置和个人绝对路径；包内的 `ATTACHMENT-README.md` 记录了版本、排除项和运行边界。

- [DSH 实验工程源码快照](/downloads/same-harness-pi-dsh/dsh-harness-experiment-source-2026-08-20.zip)（约 142 KB；SHA-256：`3f757f7b41d1ae7e776b3b633ed47f56e660ae9b77889fb6afaf2cdaf040b051`）
- [Pi 实验工程源码快照](/downloads/same-harness-pi-dsh/pi-harness-experiment-source-2026-08-20.zip)（约 122 KB；SHA-256：`a793bb2fe1ac3e7284d14bca646aec5846663b972f1b6f98a776e1071c5c2bf5`）
- [SHA-256 校验文件](/downloads/same-harness-pi-dsh/SHA256SUMS.txt)

这两份附件是完整实验工程的源码阅读快照，因此也包含正文没有展开的辅助模块。它们不是可直接安装的发布包，不包含真实运行收据，也不替代各自 README 中的版本与单例依赖说明。

附件公开用于阅读与复核；实验目录未附单独的开源许可证，因此下载不构成复用、修改或再分发授权。

## 参考与追溯

### 官方资料

> Pi 链接固定到本次实验使用的 `v0.84.2`。DSH 链接指向发布前于 2026-08-21 再次核对的 `master` 文档；三份引用文档自 2026-08-20 后没有变化，本地运行版本固定为 `0.1.0-rc.6`。

- [DeepSeek Harness Architecture Reference](https://deepseek-harness.github.io/deepseek-harness/en/reference/)
- [DeepSeek Harness Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [DeepSeek Harness Workflow Subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/workflow.md)
- [DeepSeek Harness Worker-thread Workflow Engine](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/workflow/workflow-worker-thread/README.md)
- [Pi Coding Agent README](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/README.md)
- [Pi Agent Core](https://github.com/earendil-works/pi/blob/v0.84.2/packages/agent/README.md#low-level-api)
- [Pi Extensions](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/extensions.md)

### 社区与第三方分析

- [DeepSeek Harness Discussion #1023](https://github.com/deepseek-ai/deepseek-harness/discussions/1023)
- [DeepSeek Harness vs Pi Agent](https://agentspulse.github.io/tutorials/deepseek-harness-vs-pi-agent/)
- [Dynamic Workflows: How Claude Writes Its Own Harness](https://www.sean-weldon.com/blog/2026-06-05-dynamic-workflows-how-claude-writes-its-own-harness)

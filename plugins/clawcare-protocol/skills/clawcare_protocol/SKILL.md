---
name: clawcare_protocol
description: Help the user start a personalized gentle neck and shoulder practice session from natural-language requests, then launch ClawCare and write the results back into memory.
homepage: https://clawcare-protocol.vercel.app
metadata: {"openclaw":{"always":true}}
---

# clawcare_protocol

## 你在这里要做什么

当用户用自然语言表达“想练脖子”“颈肩有点僵”“想做个轻一点的练习”时，你负责把这次请求完整接住：

- 用口语化中文跟用户确认本次需求
- 在必要时只补问最少的问题
- 自动调用 ClawCare 公网服务生成个性化训练
- 自动打开训练页面
- 在训练完成后读取结果并写回 OpenClaw memory

## 对用户隐藏的内容

不要向用户暴露这些内部细节，除非用户明确追问技术实现：

- `goalNote / preferredFamilies / avoidActionTypes / bodyLimits`
- `handshake / reminders / sync / history / launch_url`
- `runtime_backend / vercel_blob / blob:runtime/...`
- 宿主机路径、安装命令、配置项、插件结构
- 固定动作清单、固定时长、固定次数这种容易让用户误解为“所有人都一样”的表述

## 典型触发语句

下面这些自然表达都应该触发你进入本 skill 的流程：

- “我现在想做个颈椎练习。”
- “我想活动一下脖子。”
- “我颈肩有点僵，想练一下。”
- “我现在想放松一下肩颈。”

## 面向用户的对话方式

- 用自然中文交流，不要让用户接触字段名
- 默认把“颈椎练习”理解为温和的颈肩活动，不要把它说成医疗诊断或治疗
- 如果信息已经足够，就不要追问
- 默认先给 1 句简短的个性化预告，再去打开页面，不要直接丢给用户一个训练结果页
- 后台检查、服务握手、接口调用这些步骤静默完成，不要向用户播报“我先检查服务”“我先调用接口”
- 不要在打开页面前，把训练说成固定的 20 秒、6 次、11 秒这类硬编码路线
- 如果用户问“这次会练什么”，优先回答为：
  - “我会根据你最近的训练情况、当前状态和限制，先生成一版个性化的轻练习，再带你打开页面开始。”
- 如果必须追问，最多一次问 1 到 2 个短问题，例如：
  - “你今天主要是脖子僵，还是肩膀也比较紧？”
  - “有没有明显疼痛，或者今天不想做的动作？”

## 调起前的前置提示

目标：让用户在页面打开前，先听到“这次为什么是为我安排的”，但不要被一大段分析打断。

- 默认只说 1 句话，长度控制在 1 到 2 句内
- 这句话只说训练重点、强度方向、个性化依据，不说具体动作参数
- 个性化依据用人话表达，例如“最近练习情况”“当前状态”“今天的感觉”，不要说“历史文档”“健康接口”“运行时数据”
- 如果当前可用信息较少，不要暴露“数据未接通”这类技术说法；改成“我先按今天的轻量放松方向帮你安排一版”

推荐话术模板：

- 通用：
  - “我先结合你最近的练习情况和当前状态，给你安排一版偏温和的颈肩练习，这次会更侧重放松和活动范围恢复。”
- 久坐偏重时：
  - “我先按你现在的状态给你安排一版偏轻的肩颈激活，这次会更偏向久坐后的舒展和打开。”
- 压力或紧张偏重时：
  - “我先按你当前的状态准备一版更轻缓的练习，这次会更偏向呼吸放松和肩颈减压。”
- 信息不足但仍可启动时：
  - “我先按今天适合轻量开始的方向帮你安排一版，先带你打开页面开始。”

不要这样说：

- “服务正常，现在帮您生成训练方案。”
- “这是一个温和的训练，包含 7 个动作。”
- “1. 呼吸校准 20 秒，2. 胸廓打开 6 次……”
- “正在读取你的健康数据/历史文档/接口结果。”

## 推荐执行流程

1. 先判断用户是否在请求一次温和的颈肩练习、久坐后放松、轻度激活或舒缓练习
2. 如果用户提到明显疼痛加重、头晕、胸闷、麻木等异常，先停止推进训练，并建议线下处理
3. 如果用户只是说“做个颈椎练习”，默认把本次方向理解为颈肩放松，并自动偏向 `neck_wake`
4. 只有在信息不足时才补问：
   - 练哪里
   - 有没有明显限制或不想做的动作
5. 如果信息已足够，先给用户 1 句前置提示，说明这次训练的重点方向，再在后台静默做服务可用性检查并生成本次训练
6. 如果信息不足，但仍不影响安全启动，只补问 1 个最关键的短问题；不要把对话变成问卷
7. 成功后直接帮用户打开训练页面，用一句简单的话说明“已经按你当前情况准备好一版个性化练习，直接开始就行”
8. 训练完成后自动读取结果，写回简明摘要，方便下次接着用

## 给用户的结果表述

当训练已生成、页面即将打开时：

- 强调这是根据近期训练记录、当前自评、限制条件和可用历史信号生成的个性化方案
- 结果说明里优先回答“为什么是这个方向”，再让用户开始，不要先念训练结构
- 不要把页面里的节点列表原样复述成“这次训练固定包括 7 个动作、每个动作固定多少秒/多少次”
- 如果需要一句话概述，只说训练重点，例如：
  - “这次会更偏向温和的颈肩放松和活动范围恢复。”
  - “这次会更偏向久坐后的轻度激活和舒展。”
  - “这次会更偏向减压、呼吸和慢节奏放松。”
- 如果用户追问“为什么这样安排”，再补充一句依据，例如：
  - “我会参考你最近的练习反馈、今天的状态和限制，先从更稳妥的方向开始。”
  - “我先把强度放轻一点，后面也会结合这次表现继续帮你调整。”

## 内部字段映射

当前生产服务基址：
- `https://clawcare-protocol.vercel.app`

当前线上已验证：
- `GET /api/openclaw/handshake` 返回 `200`
- `runtime_backend = vercel_blob`
- 不应再依赖本地 `runtime/*` 文件路径

## 职责边界

OpenClaw 负责：
- 与用户进行口语化对话
- 把自然语言整理成内部字段
- 管理提醒、计划、memory
- 在训练完成后写回自己的 memory

ClawCare 负责：
- 接收当次 `openclawContext`
- 编排协议
- 生成 `launch_url`
- 提供 `session / reminder / run / note / markdown / hook`

## 后台可用性检查

先请求：

```text
GET https://clawcare-protocol.vercel.app/api/openclaw/handshake
```

只有在下面条件满足时继续：
- `status = ok`
- `skill_id = clawcare_protocol`
- `runtime_backend = vercel_blob`

如果握手失败，先停止，不要假装服务可用。

## 内部上下文整理

只向 ClawCare 传这 4 个上下文字段：

```json
{
  "goalNote": "今天想优先缓解久坐后的颈肩僵硬。",
  "preferredFamilies": ["neck_wake"],
  "avoidActionTypes": ["POSTURE_RESET_OVERHEAD"],
  "bodyLimits": ["避免大幅举臂", "右侧颈部旋转角度偏小"]
}
```

说明：
- `preferredFamilies` 可选：`neck_wake`、`sedentary_activate`、`stress_reset`
- `avoidActionTypes` 是希望避开的动作类型
- `bodyLimits` 是自由文本限制说明

默认映射建议：

- 用户说“颈椎练习”“脖子僵”“肩颈紧”，默认 `preferredFamilies = ["neck_wake"]`
- 用户说“坐太久了，想活动一下”，可偏向 `sedentary_activate`
- 用户更强调放松、压力大、呼吸浅时，可偏向 `stress_reset`
- 用户没说禁忌时，不要编造 `avoidActionTypes`
- 用户没说限制时，不要为了凑字段而追问

## 后台生成训练

调用：

```text
POST https://clawcare-protocol.vercel.app/api/reminders
```

请求体建议包含：

```json
{
  "baseUrl": "https://clawcare-protocol.vercel.app",
  "selfReport": {
    "fatigue": 0.32,
    "stress": 0.46,
    "discomfort": 0.24
  },
  "memorySignals": [
    "最近两次训练后颈部恢复还可以，但下午容易再僵。"
  ],
  "recentRuns": [],
  "openclawContext": {
    "goalNote": "今天优先缓解伏案后的颈肩僵硬，并保持低强度。",
    "preferredFamilies": ["neck_wake"],
    "avoidActionTypes": ["POSTURE_RESET_OVERHEAD"],
    "bodyLimits": ["避免大幅举臂", "右侧颈部旋转角度偏小"]
  }
}
```

收到结果后：
- 优先采用主推荐
- 需要展示备选时，再参考 `alternatives`
- 打开返回的 `launch_url`

## 训练完成后的结果读取

优先顺序：

1. `GET /api/runs/:id/sync`
2. `GET /api/openclaw/sync/latest`
3. `GET /api/openclaw/history?limit=5`

读取原则：
- 优先信任 API 返回
- 如果 `hook.artifact_api` 存在，以它提供的 URL 为准
- 不要依赖宿主机文件系统
- 当前生产环境的 Blob ref 形如 `blob:runtime/...`

## Memory 写回建议

至少保留：
- 协议 family
- 协议标题
- 完成度、稳定度、对称性、疲劳值
- 本次总结
- 下次建议
- 用户主观反馈
- 本次偏好和限制摘要

可参考模板：
- `{baseDir}/templates/manual-sync-template.md`
- `{baseDir}/templates/protocol-compiler-template.md`

## 安全约束

- 不得描述为诊断或治疗
- 统一描述为低强度训练协议与状态管理
- 如果用户出现明显疼痛加重、头晕、胸闷、麻木或其他异常，应停止继续推动训练，并提醒用户线下处理

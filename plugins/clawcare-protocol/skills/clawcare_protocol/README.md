# clawcare_protocol

`clawcare_protocol` 是一个面向 OpenClaw 的训练 skill。安装完成后，用户只需要说一句“我现在想做个颈椎练习”，OpenClaw 就应该自己接住需求、基于近期数据生成个性化方案、完成后台准备并拉起训练页面。

当前默认网页入口应直接指向：

```text
https://clawcare-protocol.vercel.app/?mode=protocol&entry=openclaw
```

不要再把这个 skill 的启动入口落到站点裸首页，否则用户会回到 `OpenClaw 启动 / 网页直启 / Legacy Demo` 的三入口选择页。

## 当前体验约束

- 调起训练前，默认先给用户 1 句简短的个性化预告，再打开页面
- 这句预告只说训练重点和强度方向，不说固定时长、组数、动作清单
- 后台检查和生成过程静默完成，不向用户播报服务检查、接口调用或内部步骤
- 只有在信息不足或存在风险信号时，才补问最少的问题
- 后台会先参考近期健康分析快照，再结合近期训练记录与历史信号生成个性化方案；数据不全时回退到当前保底数据
- 页面调起时始终优先打开后端返回的 `launch_url`；只有在还没有 `launch_url` 但需要先唤起页面时，才用 `/?mode=protocol&entry=openclaw` 这个保底深链

## 用户侧体验目标

安装时，用户只发一句话：

```text
请帮我安装这个skill，地址是：<GitHub URL>
```

安装完成后，用户只发一句话：

```text
我现在想做个颈椎练习。
```

## 发布来源

这个目录是 private 源仓中的真实维护位置。

对外测试发布时，不直接把本目录当成裸 skill 仓，而是把它导出到一个“单仓单入口”的 GitHub 安装仓。推荐在源仓根目录执行：

```bash
npm run export:skill:test -- --target <public-repo-checkout-path> --clean
```

导出结果会生成：

- 根目录 `marketplace.json`
- `plugins/clawcare-protocol/.codex-plugin/plugin.json`
- `plugins/clawcare-protocol/skills/clawcare_protocol/*`

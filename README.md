# ClawCare OpenClaw 安装仓

这个仓库只提供一个 OpenClaw 安装项，用于一句话安装 ClawCare 练习助手。

发给 OpenClaw 的安装话术：

```text
请帮我安装这个skill，地址是：<这个仓库的 GitHub 地址>
```

安装完成后，直接这样说：

```text
我现在想做个颈椎练习。
```

维护者从 private 源仓导出时，使用：

```bash
npm run export:skill:test -- --target <this-repo-checkout-path> --clean
```

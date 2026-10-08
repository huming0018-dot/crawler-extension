# Crawler Extension

当前迭代入口：[v4/README.md](v4/README.md)。它使用认证后的 `crowd_v4_*` 接口，当前是私有 Mac Chrome/Edge 候选；构建后的版本和摘要见包内 `release.json`。

根目录 `manifest.json` / `src` 是 **Kimi公开源码形态**（tag v1.0.0，提交5b9e327）。与Pages的3.4.14实际产物比较：9个JS中6个AST一致，其余主要为精简及一处风控执行顺序差异；两者主体能力相同，版本数字不能判断先后。保留该canonical源码，不使用根 `publish.sh` 发布 v4，不把两个身份/账本/更新通道混在一起。任务对比同时使用两套代码和线上RPC；证据见crowd-kol/docs/TASK_SCHEDULING.md，复核脚本为tools/compare-kimi.cjs。

扩展源码由本仓管理；服务端与统一口径见 [crowd-kol](https://github.com/huming0018-dot/crowd-kol)，分发构建见 [crowd-pages](https://github.com/huming0018-dot/crowd-pages)。三个仓的当前工作分支为 `codex/v4.0.6-handoff`；分支名不等于发布版本。

参与者明确同意并启动后自动执行，可随时停止。安装包不会绕过浏览器确认；节奏控制不保证平台许可或账号安全。真实验收状态见服务端仓 `docs/V4_ITERATION.md`。

旧安装指南和 v3 契约的完整历史可在 tag v1.0.0 查阅。MIT，见 LICENSE。

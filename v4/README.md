# v4 私有候选

当前版本以本目录 `manifest.json` 为准；构建器强制 core 与 manifest 一致，生成唯一版本的 worker 入口和带摘要的 `release.json`。

最新迭代：已采笔记预过滤；空搜索由服务端延后15分钟到6小时重试并轮转其他任务；同租约续做、新租约清理旧页面状态；页面故障保留租约与已见笔记。有效回执确认和配额等待继续生效。

```sh
node v4/tests/run.cjs
python3 v4/build.py --output /private/crowd-extension.zip
```

完整 Chromium/隔离SQL测试另设 `CROWD_TEST_TOOLS`（Playwright、Chromium、PGlite）和 `CROWD_MIGRATIONS_DIR`（crowd-kol/server/crowd/v4/supabase/migrations）。未配置外部空数据库时完整业务并发测试会明确 SKIP，不能报告成通过。

构建为 Chrome/Edge 未打包形态，供 Mac 私有试点。沿用原浏览器与原 v4 身份，不能卸载重报，不能覆盖根目录历史 v3 身份。本人仍需确认加载/刷新；移动端原生宿主与签名分发不在这个包里。

服务端、Kimi任务对比、部署和实机验收统一见 [crowd-kol/docs](https://github.com/huming0018-dot/crowd-kol/tree/codex/v4.0.6-handoff/docs)。私有安装助手在 [crowd-pages/v4](https://github.com/huming0018-dot/crowd-pages/tree/codex/v4.0.6-handoff/v4)。原始导入来源仅用于审计，见 IMPORTED_FROM.json。

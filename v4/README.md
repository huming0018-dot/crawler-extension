# v4 私有候选

当前版本以本目录 `manifest.json` 为准；构建器强制 core 与 manifest 一致，生成唯一版本的 worker 入口和带摘要的 `release.json`。

当前候选4.1.3：基础笔记先回传；评论跨轮合并后单独追加观察快照；作者ID取自当前笔记公开主页链接，主页粉丝/笔记数补充须参与者另行开启。任务候选按已有校验词匹配标题排序。短正文不再等同加载失败。阅读量不可见保持null；缩略值保留原标签与近似状态。

4.1.2修复：消息接收器在document_start接入，页面解析被同步脚本阻塞时仍能检查已显示内容与验证提示；搜索阶段先保存再导航，进程回收不会重复开搜索；新标签页先登记再导航，重试保留上一轮导航枚举、失败次数和调度时间。诊断只保留当前及上一轮摘要，关闭时清除，不包含URL或正文。

4.1.3在空白主文档的导航等待超时后立即停止，保留工作页、任务与原证据；浏览器跳转 API 失败不再吞错后另开页面。新增自愿诊断固定字段 document_kind / pending_kind，不上传网址。停止状态不再显示“等待调度”。

2026-10-08 Mac 实测：Puppeteer 驱动真实安装的 Chrome for Testing 扩展，拦住主文档响应并注入已过期等待期限，4.1.2仍继续调度，4.1.3停止并保留证据；迟到的页面加载不会自行恢复。真实小红书搜索导航在独立未登录资料中到达登录门，不能代替参与者设备的首次入库。当前包仍是手动刷新候选，没有自动更新能力。

4.1.1已修复明确详情字段优先、嵌套容器定位与平铺正文；登录帮助保留原工作页并区分平台/中台/用户操作；中台凭据刷新合并并发请求，取消、退出和换身份不会覆盖有效会话。

已有机制：已采笔记预过滤；空搜索由服务端延后15分钟到6小时重试并轮转其他任务；同租约续做、新租约清理旧页面状态；页面故障保留租约与已见笔记。有效回执确认和配额等待继续生效。

```sh
node v4/tests/run.cjs
python3 v4/build.py --output /private/crowd-extension.zip
```

完整 Chromium/隔离SQL测试另设 `CROWD_TEST_TOOLS`（Playwright、Chromium、PGlite）和 `CROWD_MIGRATIONS_DIR`（crowd-kol/server/crowd/v4/supabase/migrations）。未配置外部空数据库时完整业务并发测试会明确 SKIP，不能报告成通过。

构建为 Chrome/Edge 未打包形态，供 Mac 私有试点。沿用原浏览器与原 v4 身份，不能卸载重报，不能覆盖根目录历史 v3 身份。本人仍需确认加载/刷新；移动端原生宿主与签名分发不在这个包里。

服务端、Kimi任务对比、部署和实机验收统一见 [crowd-kol/docs](https://github.com/huming0018-dot/crowd-kol/tree/codex/v4.0.6-handoff/docs)。私有安装助手在 [crowd-pages/v4](https://github.com/huming0018-dot/crowd-pages/tree/codex/v4.0.6-handoff/v4)。原始导入来源仅用于审计，见 IMPORTED_FROM.json。

4.1.0服务端能力由guard声明；未具备能力时沿用原回传路径。私有观察数据区与奖励分开。主页只读取当前可见资料和最多12张笔记卡片，不遍历作者全历史，不访问粉丝/关注名单；候选作者不自动成为KOL。

评论无平台ID时采用内容指纹合并并标注identity_uncertain，不能保证不同同文评论不发生合并。真实DOM结构变化、作者昵称/指标的准确率仍须实机验收。

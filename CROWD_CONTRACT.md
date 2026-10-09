# 契约入口

当前 v4 的源代码契约为 `v4/src/core.js`（记录校验与回执）、`v4/src/agent.js`（生命周期）和 crowd-kol 的 `server/crowd/v4/supabase/migrations`（服务端校验）。任务机制见该仓 `docs/TASK_SCHEDULING.md`。

v4 uses `schema_version:4`，每条证据一个稳定 request UUID。有效回执必须匹配 request、gate=received、互补 inserted/duplicate 和非负整数 task_received。received 不是 verified；全局 note_id 唯一；临时 quota 等待保留原内容与原采集时间。

标准字段与非标字段及正文证据一并保存在 `crowd_v4.proofs.record`。公开可见数量缺失时为 null，不补0；评论只代表本次实际加载到的有界集合。数据核验和奖励由服务端管理。

根目录 v1.0 的历史 v3.2-reconcile 文档在 tag v1.0.0 的同名文件中。它不描述 v4，旧版每条2元、换浏览器自动恢复身份等文字不得用于当前参与者说明。

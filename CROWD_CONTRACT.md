# 众包采集插件 · 数据契约 v3.2-reconcile（CROWD-CONTRACT-001）

> PM 窗口独立开发 · 2026-10-02；v3 修订 2026-10-03（独立审计后服务端修复）；**契约 v3.2-reconcile · 2026-10-03**（对齐线上 v3.2 现状原地合并升级）
> 原则：**格式、获取、回传、同步四方一致**——同一份 schema 同时约束插件端采集、HTTP 回传、服务端校验、库表落点。任何一方读到的字段名/类型/枚举都必须与此文档逐字一致。


## ⚡ v3.2-reconcile 服务端变更（2026-10-03 · 对齐线上 v3.2 现状）

**为什么改**：v3.2.3 交接确认线上 Supabase（bdwrhshgdeghgyzwpxnl）已应用 v3.2 迁移且有真实参与者在用（编号如 P-B269XL1K）。上一版"新建后缀提交函数 + 吊销旧函数"的方案会当场断服，废弃；改为在**同一 RPC 名 `crowd_submit_proof` 上 CREATE OR REPLACE 原地合并升级**，函数持续演进、授权不动。

**reconcile 变更点（本节为当前唯一有效口径）**：
1. **提交 RPC 名恒为 `crowd_submit_proof`**：同一函数持续演进，不吊销、不改名、不新建后缀函数。`sync_version >= 2` 即接受（线上 v3.2.3 插件仍为 2），`< 2` 拒 `stale_client`（返回 expected_min/got）。
2. **submission_id 可选但新客户端必传**：信封带 submission_id → 走 crowd_submissions 幂等回执链路（重试重放原始回执）；不带（旧 v3.2.3 插件）→ 服务端生成内部 uuid 占位，幂等兜底退回 `unique(participant_id, task_id, proof_seq, note_id)`，重投判 `duplicate_skipped`。两条链路互不冲突。
3. **任务闸门统一口径（入口与逐条循环内一致）**：`status='open'` 或（`status='in_progress'` 且 `claimed_by=本人`）。open 任务首个 accepted 提交时服务端置 `status='in_progress'`、`claimed_by=本人`（行锁保证只认领一次）。
4. **编号 6–12 位**：参与编号校验口径 `^P-[A-Z0-9]{6,12}$`；**服务端生成固定 8 位**（对齐线上 P-B269XL1K 惯例）。
5. **报名 = 插件内「我要加入」**：调用 `crowd_register_participant(display_name?, contact?, device_salt, source?)`；**device_salt 幂等恢复**——同设备已有 pending/approved 参与者时不报错，返回 `{ok:true, participant_id:<已有>, reused:true}`（解决重装/换浏览器恢复编号）；新注册返回 `reused:false`。
6. **kw_progress 并发安全**：逐条裁决后 `SELECT ... FOR UPDATE` 锁任务行重读，同时维护 crowd_task_keyword_progress 表与 crowd_tasks.kw_progress 镜像；progress 恒为 `progress + n` 原子增量；unique 索引冲突捕获为 `duplicate_skipped`。
7. **store_pack 模式 matched_store=keyword**：`pack_type='store'` 的任务中，items[].matched_store 必须等于该条的 raw_query（关键词即店铺锚定项；服务端进度以 raw_query 为唯一口径）。
8. 沿用不变：逐条裁决落 crowd_proof_verdicts、拒收率只算质量类（duplicate/task/quota/system 不计）、URL↔note_id 一致性静态校验、platform+note_id 去重、每词达标关单（包内每个关键词 accepted ≥ kpi_min → fulfilled）。

SQL 实现见 cloud/sql/crowd_fix_v323_reconcile.sql（单文件、幂等、可重复执行；执行前提与回滚纲要见文件头尾注释）。

## ⚡ v3 服务端修复变更（2026-10-03 · 独立审计后；实现细节以 v3.2-reconcile 为准）

**为什么改**：独立审计确认若干服务端缺陷——报名编号三方格式不一致（插件自生成、协议页、后台互不认）；标题做全局唯一键同时漏重和误杀；拒收事实不落库导致拒收率风控失灵；重试丢失响应后拿不到原始结果；服务端"整包累计达标即关单"与客户端"每个关键词达标"不一致；URL 与 note_id 只分别查形状、不查一致性。

**v3 变更点**：
1. **编号服务端生成**：报名调用 RPC `crowd_register_participant(display_name, contact, device_salt, source)`，服务端生成 `P-`+大写字母数字编号（生成 8 位，校验口径 6–12 位，`^P-[A-Z0-9]{6,12}$`）；quota_day/status 等管理字段一律服务端默认（pending / 20），客户端传入即忽略。anon 对 crowd_participants 的直接 INSERT 策略已撤销。
2. **提交幂等回执**：信封携带 `submission_id`（uuid，客户端每个新信封生成一个，重试必须沿用）。服务端对每个 submission_id 只处理一次，重放直接返回库存原始回执（成功与业务失败都重放原结果）。需要重新裁决的提交必须换新的 submission_id。（v3.2-reconcile 起该字段对新客户端必传、对旧客户端可选，见上节。）
3. **逐条裁决落库**：每条 proof 的 verdict（`accepted`/`duplicate`/`rejected`/`error` + reason）写入 `crowd_proof_verdicts` 事实表；拒收率只统计质量类拒收（重复、任务失效、配额限流、系统故障均不计入参与者责任）。
4. **笔记唯一身份**：去重口径改为 `platform + note_id`（dedupe_key = `platform:note_id`）。标题/正文相似度只作质量参考写入 quality_flags，不再用于拒收。同 note_id 改标题仍是同一篇；不同 note_id 同标题互不干扰。
5. **完成标准统一**：任务关闭条件 = 包内**每个**关键词 accepted ≥ kpi_min（不再整包累计）。提交响应新增 `keyword_progress: [{keyword, accepted}]` 供客户端同步进度。
6. **URL↔ID 一致性**：note_url 内嵌的笔记 ID 必须等于 note_id，不一致拒收（`item_url_note_id_mismatch`，纯静态校验）。
7. **sync_version**：v3.2-reconcile 起 `crowd_submit_proof` 接受 sync_version ≥ 2（线上 v3.2.3 插件仍为 2，新客户端建议 3），< 2 拒 `stale_client`。
8. **raw_query 从严**：必须等于任务包 pack 中某一项，否则拒收（`item_keyword_not_in_pack`）——服务端只认词包成员，客户端标错关键词不能入库。

## ⚡ v2 安全架构变更（2026-10-02 · smoke审计后）

**为什么改**：原方案插件用 anon key 直连表（GET crowd_tasks / POST crowd_proofs），
实测发现 crowd_tasks/proofs 无 anon policy → 插件拉不到任务、回传 42501 被拒；
且 crowd_participants 的 anon SELECT(pending|approved) 会泄漏全部参与者联系方式。

**新架构（v2 起生效；提交函数与报名入口以 v3.2-reconcile 为准）**：
```
参与者浏览器 (Chrome 扩展)
   │ ① RPC crowd_fetch_tasks(participant_id)     — security definer，非黑名单即放行
   │    → 返回 {ok, tasks:[{task_id,pack_type,pack,target,kpi_min,quota_day}]}
   ▼
扩展本地队列 (chrome.storage.local)
   │ ② 按安全线节奏采集 → 组 envelope（格式不变，§2/§3）
   ▼
   │ ③ RPC crowd_submit_proof(participant_id, envelope) — security definer
   │    → 服务端校验：非黑名单 / sync_version≥2 / note_url 含 xiaohongshu.com /
   │      rating∈[1,5] / rating_reason≥8字 / 幂等(unique 四元组 + submission_id 回执)
   │    → 落库 + 回写 crowd_tasks.progress + crowd_participants.total_effective
   │    → 返回 {ok, accepted, rejected[], results[], new_progress, keyword_progress[]}
   ▼
Supabase 表（anon 零权限，报名走 RPC）
```
**安全边界（已实测）**：
- anon 对 crowd_tasks/proofs/reviews/settlements SELECT/INSERT/UPDATE/DELETE 全部 401 ✓
- anon 无法绕过 RPC 伪造回传（直写 proofs 被 42501 拒）✓
- 参与者隐私：crowd_participants 的 anon SELECT 策略已撤销 ✓
- 插件包仅含 anon key（sb_pub_，公开可分发），绝不含 service_role ✓
- SQL 实现见 cloud/sql/crowd_rpc_security.sql（可重复执行，幂等）
- v3 起：报名直插策略亦已撤销，报名/提交分别走 crowd_register_participant / crowd_submit_proof

## 1. 参与方与数据流

```
参与者浏览器 (Chrome 扩展)
   │ ⓪ 插件内「我要加入」→ RPC crowd_register_participant(display_name?, contact?, device_salt)
   │    → 返回 {ok, participant_id:"P-XXXXXXXX", status:"pending", quota_day:20, reused:false}
   │    → 重装/换浏览器：同 device_salt 再调 → {ok, participant_id:<原编号>, reused:true}
   │ ① RPC crowd_fetch_tasks(participant_id)     → open 任务包（契约 §2）
   ▼
扩展本地队列 (chrome.storage.local)  — 离线可排队，重连续传
   │ ② 按安全线节奏执行采集 → 组 envelope（新客户端含 submission_id，格式见 §3）
   ▼
   │ ③ RPC crowd_submit_proof(participant_id, envelope) — security definer
   │    → 服务端校验 + 逐条裁决落库（crowd_proof_verdicts）
   │    → 任务闸门：open 或 (in_progress 且 claimed_by=本人)；open 首个 accepted 即认领
   │    → 回写 keyword 进度 / 拒收率 / 任务完成判定（每词达标）
   │    → 返回并持久化回执 {ok, submission_id, accepted, rejected[], results[],
   │                         new_progress, keyword_progress[]}
   ▼
Supabase 表：crowd_proofs / crowd_reviews / crowd_tasks / crowd_submissions / crowd_proof_verdicts
   │ ④ 状态回写（gate_status / task_status / 结算流水）
   ▼
结算：crowd_settlements（有效条数 × 单价；线上 crowd_settle RPC：note ¥2 / rating ¥1，周一 09:00 触发）

注：task_queue 的 assignee 有 check 约束（仅 dev/collector/qa/pm，众包参与者
不是内部窗口角色），故任务包落独立表 crowd_tasks（契约 §4.1）。
若 crowd_tasks 尚未建表，crowd_pack.py 自动回退发布为 task_queue 中
assignee=pm 且标题带 [CROWD] 前缀的工单，插件拉取端两者都兼容。
```

## 2. 任务包 task_pack（插件从 crowd_fetch_tasks 获取）

字段与 Supabase crowd_tasks 行对齐，插件只读不改：

| 字段 | 类型 | 说明 |
|---|---|---|
| task_id | int | crowd_tasks.task_id（**回传必须原样带还**，用于同步锚定） |
| task_type | enum | `store_pack` / `keyword_pack` |
| pack | array | 词包或店铺包：`["店名A","店名B",...]` 或 `["词1","词2",...]`，5-8 项 |
| target | enum | `notes`（收录笔记）/ `review`（口味评分）/ `both` |
| kpi_min | int | **每个**关键词的最低有效收录条数（默认 5）；任务关闭条件 = 包内每个关键词 accepted ≥ kpi_min，任一未达标不关闭、不计酬 |
| quota_day | int | 该任务单账号日采集上限（默认 20，安全线引擎读取，只降不升） |
| created_at | string(ISO8601) | 任务创建时间 |

## 3. 采集 proof（插件产出 → 回传 payload）

**回传信封**（RPC crowd_submit_proof 的 p_envelope 参数，顶层固定）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| submission_id | string(uuid) | 新客户端必传 | 客户端生成的稳定提交 ID：每个新信封一个；**重试必须沿用同一 ID**，服务端幂等返回原始回执；需要重新裁决的提交必须换新 ID。旧客户端可缺省（v3.2-reconcile 兼容）：服务端生成内部 ID，重投由 unique 四元组兜底判 duplicate_skipped |
| participant_id | string | ✓ | 参与编号 `P-XXXXXXXX`（服务端 crowd_register_participant 发放，插件本地保存；外层参数与信封内必须一致） |
| task_id | int | ✓ | 原样回传（§2 锚定） |
| proof_seq | int | ✓ | 本次回传内记录序号，从 0 递增（断点续传排序用） |
| captured_at | string(ISO8601) | ✓ | 捕获时间（插件本地时钟；服务端拒未来时间 >10min 与 >7 天的旧时间） |
| sync_version | int | ✓ | 契约版本号（服务端接受 ≥ 2；新客户端发 3，<2 拒 stale_client） |
| kw_index | int | 否 | 客户端关键词序号（本地轮转用；服务端以 items[].raw_query 为唯一口径） |
| items | array | ✓ | proof 记录数组，格式见下 |

**proof 记录 items[]（每条一篇笔记或一条评分）**：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| kind | enum | ✓ | `note`（笔记收录）/ `rating`（口味评分） |
| platform | string | 否 | 来源平台，默认 `xiaohongshu`；当前仅支持 `xiaohongshu`，其余拒收 |
| note_id | string | ✓ | 小红书笔记 ID（24 位十六进制；**须与 note_url 内嵌 ID 一致**，不一致拒收） |
| note_url | string(url) | ✓ | 完整 URL（严格匹配 `https://www.xiaohongshu.com/explore/<24hex>` 或 `.../discovery/item/<24hex>`） |
| title | string | note 必填 | 笔记标题（只作质量门槛，**不参与去重**） |
| excerpt | string | 否 | 正文前 200 字摘要（脱敏后） |
| author | string | 否 | 作者昵称（**服务端脱敏存储**，仅保留首尾字符） |
| rating | number(1-5) | rating 必填 | 口味评分 |
| rating_reason | string | rating 必填 | 评分理由（≥8 字，含具体菜品/口感词，防空话） |
| matched_store | string | 否 | 插件侧锚定的店铺名；**store_pack 模式下必须等于该条 raw_query**（关键词即店铺锚定项；服务端进度以 raw_query 为唯一口径） |
| anchor_score | number(0-1) | 否 | 插件侧锚定置信度（服务端复核） |
| raw_query | string | ✓ | 本次采集对应的词包项，**必须等于任务包 pack 中某一项**（服务端据此累计 keyword 进度；不在包内拒收） |
| client_ip_salt | string | ✓ | 客户端设备指纹盐（一机一号辅助风控信号，不传明文 IP） |

## 4. 服务端库表（Supabase，建表 SQL 见 cloud/sql/crowd_tables.sql；v3 新增见 crowd_fix_v323_reconcile.sql）

### 4.0 crowd_participants —— 参与者报名与管控（灵活报名闭环）
| 字段 | 类型 | 说明 |
|---|---|---|
| participant_id | text PK | `P-`+大写字母数字，**服务端 RPC 生成 8 位**（校验口径 `^P-[A-Z0-9]{6,12}$`，对齐线上 P-B269XL1K 惯例），撞号自动重试 |
| display_name / contact | text | 报名信息（可选；contact 回传前脱敏展示） |
| status | enum | `pending` / `approved` / `suspended` / `blacklisted` / `rejected`（服务端默认 pending，客户端不可指定） |
| quota_day | int | 审核时设定日配额（服务端默认 20，客户端不可指定） |
| device_salt | text | 一机一号辅助风控信号（必填，8-64 位字母数字连字符；非设备唯一性证明）；**幂等恢复键**：同 salt 重复报名返回原编号（reused:true） |
| total_effective / reject_rate | int/float | 累计有效条数 / 拒收率（v3 起拒收率=质量类拒收 ÷ (accepted+质量类拒收)，由 verdict 事实表计算） |

**管控闸门（两端双层）**：
- 插件端：`fetchActiveTask` 前先查本表，非黑名单（suspended/blacklisted/rejected）不发任务（popup 显示拦截原因）。
- 服务端：`crowd_submit_proof` 回传时复查，黑名单/暂停/驳回整包拒收（防绕过插件直发）。

### 4.1 crowd_tasks —— 任务包状态（与 task_queue 联动）
| 字段 | 类型 | 说明 |
|---|---|---|
| task_id | bigint PK 自增 | 独立于 task_queue（crowd 不是内部窗口角色） |
| pack_type / pack / target / kpi_min / quota_day | — | 与 §2 一致 |
| progress | int | 有效 proof 累计条数（包内总量；逐词进度见 §4.7），恒为原子增量 |
| status | enum | `open` / `in_progress` / `fulfilled` / `closed`；fulfilled 判定 = 包内每个关键词 accepted ≥ kpi_min |
| claimed_by | text | 认领人编号（v3.2 起）：open 任务首个 accepted 提交时置为本人并转 `in_progress`；任务闸门放行 `open` 或（`in_progress` 且 `claimed_by`=本人） |
| kw_progress | jsonb | 每词 accepted 镜像（与 §4.7 表同步维护；并发安全：锁任务行重读后更新） |

### 4.2 crowd_proofs —— 回传明细（校验后落点）
| 字段 | 类型 | 说明 |
|---|---|---|
| id | bigserial PK | — |
| participant_id / task_id / proof_seq / captured_at / sync_version | — | 信封字段原样 |
| kind / platform / note_id / note_url / title / excerpt / author / rating / rating_reason / matched_store / anchor_score / raw_query / client_ip_salt | — | §3 字段原样 |
| submission_id | uuid | 所属提交（对应 crowd_submissions；旧客户端缺省时为服务端生成的内部 ID） |
| gate_status | enum | `accepted` / `rejected` / `duplicate` / `duplicate_skipped`（兼容值）/ `error`；写路径仅落 `accepted`，其余裁决在 §4.6 事实表 |
| gate_reason | text | 非 accepted 时的原因码（写路径不用，供存量迁移与人工干预） |
| dedupe_key | string | note = `platform:note_id`（全局唯一）；rating = `platform:note_id:rating:participant_id`（每人每笔记一评）。accepted 态部分唯一索引兜底 |
| quality_flags | jsonb | 质量参考信号（如标题/正文相似度），不用于拒收 |
| unique(participant_id, task_id, proof_seq, note_id) | — | 幂等键（信封级 seq + 条目级 note_id）；旧客户端无 submission_id 时的兜底幂等 |

### 4.3 crowd_reviews —— 口味评分（仅 rating 类 accepted 后落此）
| 字段 | 类型 | 说明 |
|---|---|---|
| store_name | text | 锚定店铺名（entity_match 二次解析） |
| participant_id / rating / rating_reason / note_id / captured_at | — | 同上 |
| trust_level | enum | `crowd_single` / `crowd_crossed`（多参与者交叉后升） |

### 4.4 crowd_settlements —— 结算
| 字段 | 类型 | 说明 |
|---|---|---|
| id | bigserial PK | — |
| participant_id | string | — |
| period | string(YYYY-Www) | 结算周期 |
| effective_notes / effective_ratings | int | 有效笔记 / 有效评分（accepted） |
| unit_note / unit_rating | number | 单价（线上 crowd_settle RPC 口径：note ¥2 / rating ¥1，周一 09:00 launchd 触发） |
| amount | number | 合计 |
| unique(participant_id, period) | — | 每周期一条流水 |

### 4.5 crowd_submissions —— 提交幂等回执（v3 新增）
| 字段 | 类型 | 说明 |
|---|---|---|
| submission_id | uuid PK | 客户端稳定提交 ID；每个 ID 只处理一次（旧客户端缺省时为服务端生成 ID） |
| participant_id / task_id / sync_version | — | 提交归属（日志语义，participant 不设外键——闸门失败的未知编号也落回执） |
| item_count / accepted_count | int | 信封条数 / 本次新增 accepted 数 |
| response | jsonb | **原始回执整份存储**；同一 submission_id 重放时逐字节原样返回 |
| created_at | timestamptz | 服务端首处时间 |

### 4.6 crowd_proof_verdicts —— 逐条裁决事实表（v3 新增，拒收率统计唯一数据源）
| 字段 | 类型 | 说明 |
|---|---|---|
| id | bigserial PK | — |
| submission_id | uuid FK | 所属提交 |
| participant_id / task_id | — | 裁决归属 |
| item_index | int | 信封 items[] 内序号（0 起）；unique(submission_id, item_index) |
| note_id | text | 涉及笔记 |
| verdict | enum | `accepted` / `duplicate` / `rejected` / `error` |
| reason | text | 机器可读原因码（如 `item_url_note_id_mismatch`），accepted 为 null |
| reason_category | enum | `none` / `duplicate`（重复）/ `quality`（质量不合格）/ `task`（任务失效）/ `quota`（配额限流）/ `system`（系统故障） |
| counts_for_reject | bool | 仅 `quality`=true 计入参与者拒收率；重复/任务/配额/系统原因不计 |
| detail | text | 系统错误明细（不向客户端返回） |

### 4.7 crowd_task_keyword_progress —— 任务 × 关键词进度（v3 新增，完成标准数据源）
| 字段 | 类型 | 说明 |
|---|---|---|
| task_id / keyword | 复合 PK | pack 内每个关键词一行 |
| accepted | int | 该关键词累计 accepted 数（按 items[].raw_query 归属；on conflict 原子增量） |
| updated_at | timestamptz | 最近更新时间 |

## 5. 同步一致性规则（防漂移，铁律）

1. **task_id 原样回传**：插件领取什么包，回传就必须带同一 task_id；服务端不认"看起来像"的包。
2. **sync_version 门槛**：`crowd_submit_proof` 接受 sync_version ≥ 2（新客户端发 3）；< 2 拒绝并返回 `stale_client` + expected_min/got，插件弹更新提示。同一函数持续演进，RPC 名不变。
3. **submission_id 幂等（新客户端必传）**：每个新信封生成一个新 uuid；同一信封重试（断网、超时、重启）必须沿用同一 submission_id，服务端返回库存原始回执，不重复计酬、不重复裁决。旧客户端缺省 submission_id 时由 `unique(participant_id, task_id, proof_seq, note_id)` 兜底，重投判 `duplicate_skipped`。proof_seq 在同一 participant+task 内仍单调递增，作为信封内排序辅助。
4. **verdict 事实表唯一权威**：计酬只认 crowd_proofs 的 `accepted`；每次提交尝试落 crowd_submissions，每条裁决落 crowd_proof_verdicts，`duplicate`/`rejected`/`error` 带原因码供参与者申诉；拒收率只统计质量类拒收。
5. **一机一号**：device_salt + participant_id 绑定（辅助风控信号）；同 salt 重复报名返回原编号（reused:true）不新建；同 salt 出现多 participant → 触发人工审计。
6. **断点续传**：插件本地队列未确认的信封不删除，重连后按原 submission_id 重传；服务端重放原始回执，客户端按回执逐条确认（成功条清除、永久失败条留申诉记录、临时故障退避重试）。
7. **状态回写**：服务端按 accepted 实时累计 crowd_task_keyword_progress（并镜像 crowd_tasks.kw_progress），包内**每个**关键词达标才置 fulfilled（PM 调度器自动标 done）；提交响应的 `keyword_progress` 供插件同步每词进度，避免重复采集同一包。
8. **去重口径**：笔记唯一身份 = platform + note_id。同 note_id 改标题仍是同一篇（duplicate）；不同 note_id 同标题各自有效。URL 内嵌 ID 与 note_id 不一致一律拒收。
9. **任务认领**：open 任务首个 accepted 提交即被该参与者认领（`in_progress` + `claimed_by`）；此后仅认领人可继续提交（入口与逐条循环同一闸门口径）；任务租约过期回收属下一阶段。

## 6. 提交响应与幂等回执

**crowd_submit_proof 成功响应**：

```json
{
  "ok": true,
  "submission_id": "uuid-原样回显（旧客户端缺省时为服务端生成 ID）",
  "accepted": 3,
  "rejected": ["item_url_note_id_mismatch:abc..."],
  "results": [
    {"note_id": "...", "gate": "accepted"},
    {"note_id": "...", "gate": "duplicate"},
    {"note_id": "...", "gate": "duplicate_skipped"},
    {"note_id": "...", "gate": "rejected", "reason": "item_url_note_id_mismatch"},
    {"note_id": "...", "gate": "error", "reason": "item_insert_error"}
  ],
  "new_progress": 12,
  "keyword_progress": [{"keyword": "新荣记", "accepted": 5}, {"keyword": "外滩法餐", "accepted": 3}]
}
```

**规则**：
- `results[].gate` ∈ `accepted` / `duplicate` / `duplicate_skipped` / `rejected` / `error`，与 crowd_proof_verdicts 逐条对应；`rejected`/`error` 必带 reason。`duplicate_skipped` = unique 约束兜底捕获（旧客户端重投或并发撞 dedupe 索引），不计拒收率。
- 信封级失败（`participant_unavailable` / `stale_client` / `task_not_open` / `quota_exceeded` / `captured_at_*` 等）返回 `{ok:false, reason, submission_id}`，同样持久化、同样重放。
- 缺 submission_id 不再是拒绝项：服务端生成内部 ID 正常处理（兼容旧 v3.2.3 插件）；但新客户端必须传，否则失去跨重启的重试回执能力。
- 系统级异常（数据库故障等）不产生回执：事务整体回滚，重试重新执行。
- `keyword_progress` 覆盖任务包全部关键词（含 0 进度）；任务 fulfilled 的充分必要条件是其中每项 accepted ≥ kpi_min。

**拒收原因分类（reason_category）与拒收率**：

| 分类 | 典型 reason | 计入参与者拒收率 |
|---|---|---|
| duplicate | duplicate_note / duplicate_seq_replay | 否（可能源于调度冲突/重试，与造假分开） |
| quality | item_url_note_id_mismatch / item_keyword_not_in_pack / item_title_too_short / item_rating_* 等 | **是** |
| task | item_task_fulfilled | 否（任务失效不是参与者责任） |
| quota | item_quota_exceeded | 否（限流非造假证据） |
| system | item_insert_error | 否 |

拒收率 = 质量类拒收 ÷（accepted + 质量类拒收），累计 >20 条且 >0.6 自动 suspended（与 v2 阈值一致）。

## 7. 报名与管控（灵活报名闭环）

```
参与者                        PM/服务端
  │ ① 插件内「我要加入」（可选昵称/联系方式 + 自动携带 device_salt）
  ├──────────────────────────▶ RPC crowd_register_participant(...)
  │                              device_salt 已有 active 参与者 → 返回原编号 reused:true
  │                              否则服务端生成编号 P-XXXXXXXX（8 位，校验口径 6–12 位）
  │                              status=pending / quota_day=20 服务端默认
  │◀─────────────────────────── {ok, participant_id, status, quota_day, reused}
  │                             
  │ ② 报名即用（P- 编号）；重装/换浏览器用同 device_salt 恢复原编号；异常时 crowd_admin.py 干预
  │ ③ onboarding 填 P- 编号 → 插件 fetchActiveTask 先查管控闸门
  │ ④ 采集回传 → crowd_submit_proof 复查状态 + 累计 total_effective
  │ ⑤ 违规/异常 → suspend / blacklist → 插件端不再派任务、服务端拒回传
```

- **报名即用**：插件匿名调 RPC（anon key 不可直插表——v3 已撤销 anon INSERT 策略），提交即得 P- 编号立即可用；风控后置（黑名单/暂停/驳回即时拦截）。
- **编号恢复**：device_salt 为幂等恢复键——重装/换浏览器后「我要加入」自动找回原编号（reused:true），不产生重复参与者。
- **编号与凭证分离**：P- 编号仅作业务标识与展示；身份认证绑定（Supabase Auth）属下一阶段，编号本身不是凭证。
- **管控入口**：cloud/crowd_admin.py（list/suspend/blacklist/reject/stats），审核后置为风控抽查。
- **双层拦截**：插件端发任务前查状态；服务端回传时再查（防绕过插件直发）。
- **配额**：quota_day 审核时设定，服务端为上限，安全线引擎只降不升。

## 8. 安全线（插件硬编码，独立于本契约，见 safety_engine.js）

| 动作 | 阈值 |
|---|---|
| 日搜索 | ≤ quota_day（默认 20，max 30） |
| 搜索间隔 | 随机 60-120s（硬下限 60s，不可调） |
| 单次会话 | ≤15min 后强制冷却 30min |
| 浏览停留 | ≥30s/篇 |
| 触发"访问频繁" | 立即停 15min（只读恢复） |
| 一机一号 | 绑定 device salt，禁止多账号切换 |

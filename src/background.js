// 双形态后台：Chrome MV3 service_worker（Worker 上下文）在此 importScripts 四个依赖；
// Firefox MV3 event page（window 上下文）由 manifest background.scripts 按序先行注入，跳过此句。
// 加载顺序不可变：sampler/device_profile 须先于 safety_engine；CONFIG 与 SafetyEngine 都依赖 config.js。
if (typeof importScripts === "function") { importScripts("sampler.js", "device_profile.js", "config.js", "safety_engine.js"); }

/**
 * background.js — 众包采集插件后台 Service Worker（契约见 CROWD_CONTRACT.md；历史沿革见 CHANGELOG.md）
 *  1. 任务拉取：RPC crowd_fetch_tasks → open 任务包（排除本地已完成）
 *  2. 关键词轮转：包内按序采集，每词 accepted >= kpi_min 判 done，全词 done → 归档续领
 *  3. 回传：信封带 submission_id 入队（服务端按它幂等）→ RPC crowd_submit_proof →
 *     逐条 verdict 终态移除 / 临时故障指数退避 / 永久错误死信；连续零有效 → 回流告警
 *  4. 安全模型：只用 Supabase anon key（公开分发），全部读写走 security definer RPC；
 *     队列/死信/进度持久化 chrome.storage.local，SW 休眠重启不丢单
 */
const CONFIG = {
  API_BASE: "https://bdwrhshgdeghgyzwpxnl.supabase.co",
  API_KEY: "sb_publishable_c93XenGzZsoa308e3bTg6A__lfaqQ-B", // publishable anon key（公开分发，RLS 服务端收口）；与 config.js 同源
  HEARTBEAT_MIN: 3,
  UPLOAD_RETRY_MIN: 5,               // 兜底重传 alarm 周期（分钟）
  RETRY_BASE_MS: 60 * 1000,          // 临时故障退避起点（1min）
  RETRY_MAX_MS: 30 * 60 * 1000,      // 退避上限（30min）
  DEAD_LETTER_MAX: 50,               // 死信最多保留信封数（防存储膨胀）
  RETRY_DEAD_AFTER: 8,               // 条目级未知/error gate 重试上限：达到后整封转死信（retry_exhausted），防僵尸信封
  MAX_INLINE_WAIT_MS: 25 * 1000,     // canSearch waitMs 超过此值则推迟到下个心跳；必须低于 MV3 SW 30s 空闲杀死线
  RPC_TIMEOUT_MS: 15 * 1000,         // callRpc 单次 RPC 超时（AbortController 中断挂起的 fetch）
  CONTENT_TIMEOUT_MS: 15 * 1000,     // CROWD_SEARCH content 响应超时（超时按 content_unavailable 处理）
  COLLECT_WATCHDOG_MS: 90 * 1000,    // doCollectOnce 看门狗：超时只返回状态，_running 锁由 inner settle 后释放
  DONE_TASKS_MAX: 200,               // done_task_ids 滚动上限（长期运行防存储膨胀）
  AUTH_FAIL_BREAKER: 3,              // 连续认证失败次数熔断阈值
  SYNC_VERSION: 3,                   // 契约 v3：crowd_submit_proof 要求 sync_version=3
};

const safety = new SafetyEngine(chrome.storage.local);

// ---------------------------------------------------------------- 小工具
// UUIDv4：submission_id 用（入队时生成一次，重试复用）
function uuidv4() {
  if (self.crypto && typeof self.crypto.randomUUID === "function") return self.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 错误持久化到 last_error（popup 经 CROWD_STATUS 可见）
async function logError(where, err) {
  const msg = err && err.message ? err.message : String(err);
  console.warn("[crowd] " + where + ":", msg);
  try {
    await safety._set({ last_error: { at: new Date().toISOString(), where, message: msg } });
  } catch (_) { /* storage 不可用时只保留 console */ }
}

// SW 休眠重启恢复：SafetyEngine 实例的 remote 不随实例持久化，启动时经引擎自身 init()
// 按本地基线重新合成——即使 storage 里的 remote_limits_applied 被篡改也无法放宽基线。
async function restoreSafetyEngine() {
  try {
    if (safety.remote) return;
    await safety.init();
  } catch (e) {
    await logError("restore_safety", e);
  }
}

// ---------------------------------------------------------------- RPC 封装
// 返回约定：{ok:true, data} | {ok:false, http?, reason, temp, auth?}
// temp=true → 网络/5xx/408/429/401/403 临时故障（退避重试，401/403 走熔断）；temp=false → 信封级永久错误（死信）
async function callRpc(fn, body) {
  // 15s 超时：AbortController 中断挂起的 fetch，超时按临时故障退避重试
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.RPC_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(CONFIG.API_BASE + "/rest/v1/rpc/" + fn, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: CONFIG.API_KEY,
        Authorization: "Bearer " + CONFIG.API_KEY,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e && e.name === "AbortError") return { ok: false, reason: "rpc_timeout", temp: true };
    await logError("rpc_network", fn + ": " + (e && e.message ? e.message : String(e))); // 记录真实网络错误（DNS/TLS/CORS）
    return { ok: false, reason: "network_error", temp: true };
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    // 401/403 多为 key 轮换/权限事故的临时症状：退避重试并熔断告警，不直接死信
    // （旧逻辑下配置事故会一次性把整个队列送进死信）
    const auth = resp.status === 401 || resp.status === 403;
    const temp = resp.status >= 500 || resp.status === 408 || resp.status === 429 || auth;
    return { ok: false, http: resp.status, reason: "rpc_" + resp.status, temp, auth };
  }
  try {
    return { ok: true, data: await resp.json() };
  } catch (e) {
    return { ok: false, reason: "bad_json", temp: true };
  }
}

// 风控信号上云（服务端近 48h ≥2 自动降额 30%）
async function reportRiskToServer(signal, detail) {
  try {
    const pid = await safety._get("participant_id", "");
    if (!pid) return;
    await callRpc("crowd_report_risk", {
      p_participant_id: pid,
      p_signal: signal,
      p_detail: String(detail || "").slice(0, 200),
    });
  } catch (e) { await logError("report_risk", e); }
}

// ---------------------------------------------------------------- 参与者管控
// 注册 ≠ 同意：必须同时查 agreed_at——老安装可能只有 participant_id 而无 agreed_at，
// 不在这里拦截则知情同意形同虚设。
async function participantGate() {
  const pid = await safety._get("participant_id", "");
  if (!pid) return { ok: false, reason: "未填写参与编号（请打开插件选项页填写）" };
  if (!/^P-[A-Z0-9]{6,12}$/.test(pid)) return { ok: false, reason: "参与编号格式错误（应为 P-XXXXXX）" };
  const agreed = await safety._get("agreed_at", null);
  if (!agreed) return { ok: false, reason: "未完成知情同意（请打开插件选项页阅读并同意协议）" };
  return { ok: true, pid };
}

// ---------------------------------------------------------------- 关键词进度
async function kwState(taskId) {
  return (await safety._get("kw_state_" + taskId, null)) || {};
}

// 返回当前应采集的关键词索引：第一个未完成的关键词；全完成返回 -1
// done 由回传进度同步置位；这里再用 accepted>=kpi_min 兜底，防止 done 丢失导致卡死在第一个词
async function nextKwIndex(task) {
  const st = await kwState(task.task_id);
  const kpi = task.kpi_min || 5;
  for (let i = 0; i < task.pack.length; i++) {
    const k = st["" + i];
    if (k && (k.done || (k.accepted || 0) >= kpi)) continue;
    return i;
  }
  return -1;
}

// ---------------------------------------------------------------- 任务拉取
async function fetchActiveTask() {
  const q = await safety._get("active_task", null);
  if (q && q.task_id) return q;

  const gate = await participantGate();
  if (!gate.ok) {
    await safety._set({ gate_block_reason: gate.reason });
    return null;
  }
  await safety._set({ gate_block_reason: "" });

  // RPC：服务端校验非黑名单，返回 open 任务包（排除本地已完成的）
  const done = await safety._get("done_task_ids", []);
  const rpc = await callRpc("crowd_fetch_tasks", {
    p_participant_id: gate.pid,
    p_exclude_task_ids: done,
  });
  if (!rpc.ok) {
    await safety._set({ gate_block_reason: "服务端校验失败（" + (rpc.reason || "网络错误") + "）" });
    return null;
  }
  const d = rpc.data || {}; // 服务端返回 JSON null 时不得抛 TypeError（按"暂无任务"收场）
  // 安全线 v2：服务端随任务下发 safety（全局暂停 + 远程限速）；远程限速沿用"只紧不松"合并
  if (d.safety && typeof d.safety === "object") {
    await safety._set({ global_pause: !!d.safety.pause });
    if (d.safety.limits && typeof d.safety.limits === "object" && Object.keys(d.safety.limits).length) {
      try { await safety.applyRemoteLimits(d.safety.limits); } catch (_) {}
    }
  }
  if (!d.ok || !d.tasks || !d.tasks.length) {
    await safety._set({ gate_block_reason: d.reason || "暂无开放任务包" });
    return null;
  }
  const r = d.tasks[0];
  const task = {
    task_id: r.task_id,
    task_type: r.pack_type === "keyword" ? "keyword_pack" : "store_pack",
    pack: r.pack,
    target: r.target || "both",
    kpi_min: r.kpi_min || 5,
    quota_day: r.quota_day || 20,
    progress: 0,
    known_note_ids: r.known_note_ids || [], // 服务端已见库（本包关键词已收录）
  };
  await safety._set({ active_task: task, active_task_claimed_at: Date.now() });
  return task;
}

// ---------------------------------------------------------------- 采集执行
// 并发互斥：alarm 周期触发可能重入（上次采集/回传因网络慢超过 HEARTBEAT_MIN），
// _running 标志在 doCollectOnce 执行期间拒绝再次进入。
let _running = false;

async function doCollectOnce() {
  if (_running) return { status: "busy" }; // 防重入：上次任务未结束
  _running = true;
  // 90s 看门狗：网络挂起时本轮按失败返回；锁的释放挂在 inner 的 finally 上——
  // inner 一天不 settle，锁一天不放（防超时后悬空 inner 与下一心跳并发读写 storage）
  const inner = _collectOnceInner()
    .catch((e) => ({ status: "error", reason: e && e.message ? e.message : String(e) }))
    .finally(() => { _running = false; });
  return await Promise.race([
    inner,
    sleep(CONFIG.COLLECT_WATCHDOG_MS).then(() => {
      console.warn("[crowd] collect watchdog timeout (" + CONFIG.COLLECT_WATCHDOG_MS / 1000 + "s)，inner 仍持锁运行中");
      return { status: "watchdog_timeout" };
    }),
  ]);
}

async function _collectOnceInner() {
  try {
    await restoreSafetyEngine(); // SW 重启后先恢复远程安全配置

    // 门禁/冷却只拦采集，不拦回传——队列有货先回传，每个心跳都尝试排空
    const q0 = await safety._get("proof_queue", []);
    if (q0.length) { try { await uploadProofs(); } catch (e) { await logError("upload_first", e); } }

    // 配额封锁（昨日配额打满 → 午夜前不采集，回传由 upload_first 照常尝试）
    const qb = await safety._get("quota_blocked_until", 0);
    if (qb && qb > Date.now()) return { status: "quota_blocked", until: qb };
    if (qb && qb <= Date.now()) await safety._set({ quota_blocked_until: 0, gate_block_reason: "" });

    // 安全线 v2 闸门（先于一切采集动作）：⓪ 全局暂停（服务端一键熔断，拉任务时下发并持久化）
    if (await safety._get("global_pause", false)) return { status: "global_pause" };
    // ① 时段画像：von Mises 24h 曲线权重过低（深夜）不调度；② 会话调度：冷却/休息/风控当日停止
    const circ = await safety.isCircadianAllowed();
    if (!circ.ok) return { status: "circadian_blocked", weight: circ.weight };
    const sess = await safety.canStartSession();
    if (!sess.ok) return { status: "session_gated", reason: sess.reason, waitMs: sess.waitMs };

    // 队列满（>=100 信封）：先回传；仍满则暂停采集，不再继续堆积
    const wm = await safety.queueWatermark();
    if (wm.full) {
      await uploadProofs();
      const wm2 = await safety.queueWatermark();
      if (wm2.full) return { status: "queue_full", count: wm2.count };
    }

    const task = await fetchActiveTask();
    if (!task) return { status: "no_task" };

    const gate = await safety.canSearch();
    if (!gate.ok) return { status: "gated", reason: gate.reason };
    // 遵守安全线返回的 waitMs——等待相应时间再发搜索动作；超过一个心跳周期则本轮直接推迟
    if (gate.waitMs && gate.waitMs > 0) {
      if (gate.waitMs > CONFIG.MAX_INLINE_WAIT_MS) return { status: "wait", waitMs: gate.waitMs };
      await sleep(gate.waitMs);
    }

    // 轮转：取第一个未完成的关键词；全部完成 → 归档并续领（下个心跳拉新包）
    const idx = await nextKwIndex(task);
    if (idx < 0) {
      await finalizeTask(task);
      return { status: "task_done_rotate", task_id: task.task_id };
    }
    const keyword = task.pack[idx];

    // 自动采集：开专用后台标签页访问搜索页（active:false 不抢焦点），加载完成后让 content.js
    // 提取，用完即关。排序混合（70% 综合 + 30% 最新）：综合拿口碑主体，最新补时效并稀释撞库损耗
    const sortParam = Math.random() < 0.3 ? "&sort=time" : "";
    const searchUrl = "https://www.xiaohongshu.com/search_result?keyword=" +
      encodeURIComponent(keyword) + sortParam + "&xsec_source=pc_crowd";
    let tab = null;
    try {
      tab = await chrome.tabs.create({ url: searchUrl, active: false });
    } catch (e) {
      await logError("open_search_tab", e);
      return { status: "search_failed", reason: "tab_create" };
    }
    // 等页面加载完成（最长 20s；小红书卡片异步渲染再缓 2s）
    let loaded = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      try {
        const t = await chrome.tabs.get(tab.id);
        if (t && t.status === "complete") { loaded = true; break; }
      } catch (_) { break; } // 标签页被用户关掉
      await sleep(1000);
    }
    let search = { ok: false, reason: loaded ? "content_unavailable" : "page_load_timeout" };
    if (loaded) {
      await sleep(2000);
      search = await new Promise((resolve) => {
        // content 15s 超时：页面卡死/回调丢失时按超时收场
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve({ ok: false, reason: "content_unavailable" });
        }, CONFIG.CONTENT_TIMEOUT_MS);
        chrome.tabs.sendMessage(tab.id, { type: "CROWD_SEARCH", keyword, task_id: task.task_id, target: task.target }, (resp) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (chrome.runtime.lastError || !resp) return resolve({ ok: false, reason: "content_unavailable" });
          resolve(resp);
        });
      });
    }
    // SERP 拟态停留：提取完成后不立刻关页——截断 lognormal 停留（中位 10s、下限 5s、上限 30s）
    try {
      if (loaded && self.CROWD_SAMPLER) {
        await sleep(Math.round(self.CROWD_SAMPLER.sampleTruncLognormal(Math.log(10), 0.8, 5, 30) * 1000));
      }
    } catch (_) { /* 采样失败忽略，直接关页 */ }
    // promise 版 API 的 rejection 不能被同步 try/catch 捕获，需挂 .catch 防 SW 未处理拒绝
    try { chrome.tabs.remove(tab.id).catch(() => {}); } catch (_) {}

    // 风控信号优先于解析成败：页面触发「访问频繁」时即使没解析出卡片，
    // 也必须先把 rateLimited 送进风控状态机，否则会顶着风控持续采集
    if (search.rateLimited) {
      await safety.onRateLimited("rate_limited");
      await reportRiskToServer("rate_limited", search.reason || search.error || "");
    }
    if (!search.ok) {
      return { status: "search_failed", reason: search.error || search.reason, rateLimited: !!search.rateLimited };
    }

    await safety.markSearch();
    // 记入会话动作数；动作预算耗尽 → 结束会话并按冷却分布睡（下个心跳起被 canStartSession 拦）
    await safety.markSessionAction();

    const participant = await safety._get("participant_id", null);
    const now = new Date().toISOString();
    const seqBase = await safety._get("proof_seq_" + task.task_id + "_" + idx, 0);

    // 镜像服务端入库口径预检：标题去标点不足 2 字且 excerpt <10 字的条目服务端必拒，
    // 客户端直接丢弃不送上去，避免 selector 脆弱时全量拒收把 reject_rate 打爆触发自动 suspended
    const stripPunct = (s) => String(s || "").replace(/[\p{P}\p{S}\s]/gu, "");
    // 信封榨取率：① 服务端已见库预过滤（跳过已收录，不占槽位）② 槽位 12
    // ——同一页 SERP（同样 25 次浏览）多榨 2-3 倍有效条目，浏览量零增加
    const knownSet = new Set((task.known_note_ids || []).map(String));
    const preItems = (search.items || [])
      .filter((it) => it && it.note_id && !knownSet.has(String(it.note_id)))
      .slice(0, 12);
    const usable = preItems.filter((it) => stripPunct(it.title).length >= 2 || String(it.excerpt || "").trim().length >= 10);
    const droppedBad = (search.items || []).length - usable.length;
    if (droppedBad) console.warn("[crowd] 预检丢弃必拒/已见条目 x" + droppedBad);

    const items = usable.map((it) => ({
      kind: it.kind || "note",
      note_id: it.note_id || "",
      note_url: it.note_url || "",
      title: it.title || "",
      excerpt: (it.excerpt || "").slice(0, 200),
      author: it.author || "",
      rating: it.rating || null,
      rating_reason: it.rating_reason || "",
      // store_pack 模式：pack[idx] 即目标店名，content 未回填时自动回填 matched_store=keyword，
      // 否则笔记无法按店聚合导致作废；keyword_pack 保持空字符串
      matched_store: it.matched_store || (task.task_type === "store_pack" ? keyword : ""),
      anchor_score: it.anchor_score || 0,
      raw_query: keyword,
    }));

    // 空结果不入队（避免空信封占队列水位）；连续 3 次空结果 → 风控状态机暂停会话 + 长冷却
    if (!items.length) {
      const em = await safety.onSearchOutcome(0);
      return { status: em.cooled ? "empty_cooldown" : "empty_search", kw_index: idx, streak: em.streak };
    }
    await safety.onSearchOutcome(items.length); // 有结果：清空连空计数

    const envelope = {
      submission_id: uuidv4(), // 入队时生成一次并随队列持久化，重试必须复用（服务端按它幂等）
      participant_id: participant || "",
      task_id: task.task_id,
      kw_index: idx, // 关键词进度定位（续领/轮转用）
      kpi_min: task.kpi_min || 5, // 随信封持久化：判 done 不依赖 active_task 是否仍在
      proof_seq: seqBase,
      captured_at: now,
      sync_version: CONFIG.SYNC_VERSION,
      retry_count: 0,
      next_retry_at: 0,
      items,
    };
    if (participant) {
      const q = await safety._get("proof_queue", []);
      q.push(envelope);
      const update = { proof_queue: q };
      update["proof_seq_" + task.task_id + "_" + idx] = seqBase + 1;
      await safety._set(update);
      // 每批入队后立即尝试回传；失败留队列，由退避与 5min 兜底 alarm 重试
      try {
        await uploadProofs();
      } catch (e) {
        await logError("upload_after_collect", e);
      }
    }
    return { status: "collected", count: items.length, kw_index: idx, gate };
  } catch (e) {
    await logError("collect", e);
    return { status: "error", reason: e && e.message ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------- 回传（RPC）+ 回流检测 + 进度累计
// 契约#2 响应：{ok, results:[{note_id?, verdict, reason?, temp?}], keyword_progress:[{keyword, accepted}]}
//  - verdict accepted/duplicate/rejected → 终态移出信封；所有条目终态才删除信封
//  - temp=true / 网络 / 5xx → 指数退避重试（1min 起、上限 30min）
//  - 信封级永久错误（task_not_open、participant suspended 等）→ 整封进死信，popup 可见

// 信封级永久错误原因（对齐服务端 v344 词表 crowd_fix_v344_quota_replay.sql；
// quota_exceeded 永不命中本表——走 park 分支）
const PERMANENT_REASON_RE = /task_not_open|not_open|suspend|blacklist|invalid_participant|participant_unknown|participant_unavailable|envelope_parse_error|stale_client|envelope_missing_task_or_seq|participant_id_mismatch|captured_at_future|captured_at_too_old|sync_version|version_mismatch|forbidden/;

function isPermanentReason(reason) {
  return !!reason && PERMANENT_REASON_RE.test(String(reason).toLowerCase());
}

// 死信：永久失败的信封留档（原因+时间），不再重试，popup 可见、可申诉
// 同 submission_id 去重——并发/重复路径下同一信封不重复占死信位
async function deadLetter(envelope, reason) {
  const dl = await safety._get("deadLetter", []);
  const sid = envelope && envelope.submission_id;
  if (sid && dl.some((e) => e && e.envelope && e.envelope.submission_id === sid)) return;
  dl.push({ at: new Date().toISOString(), reason: String(reason || "unknown"), envelope });
  while (dl.length > CONFIG.DEAD_LETTER_MAX) dl.shift();
  await safety._set({ deadLetter: dl });
  await logError("dead_letter", String(reason || "unknown") + " submission=" + (envelope.submission_id || "?"));
}

// 临时故障退避：1min 起、2 倍递增、上限 30min
function markRetry(envelope) {
  const n = (envelope.retry_count || 0) + 1;
  envelope.retry_count = n;
  envelope.next_retry_at = Date.now() + Math.min(CONFIG.RETRY_BASE_MS * Math.pow(2, n - 1), CONFIG.RETRY_MAX_MS);
  return envelope;
}

// 把服务端进度同步进 kw_state_<taskId>，达 kpi_min 置 done=true。
// keyword_progress 为服务端权威口径；缺失时本地累计兜底（并补置 done）。
// 兜底累计按 submission_id 去重（last_sid）——幂等重放返回同一回执时不再重复累加，
// 防本地进度虚高导致提前归档（服务端该词实际未达 kpi）。
async function syncKeywordProgress(body, d) {
  const key = "kw_state_" + body.task_id;
  const st = (await safety._get(key, {})) || {};
  const active = await safety._get("active_task", null);
  const pack = active && active.task_id === body.task_id ? active.pack : null;
  const kpiMin = body.kpi_min || (pack ? active.kpi_min : 0) || 5;

  let acceptedDelta = d.accepted || 0;
  if (Array.isArray(d.results)) {
    acceptedDelta = d.results.filter((r) => String((r && (r.verdict || r.gate)) || "").toLowerCase() === "accepted").length;
  }

  let synced = false;
  if (Array.isArray(d.keyword_progress) && pack) {
    for (const kp of d.keyword_progress) {
      if (!kp || kp.keyword == null) continue;
      const i = pack.indexOf(kp.keyword);
      if (i < 0) continue;
      const acc = kp.accepted || 0;
      const prev = st["" + i] || {};
      // last_sid / anchor_note_ids 跨权威写保留：服务端分支整行覆盖时不得丢去重标记与评分锚点
      st["" + i] = { accepted: acc, done: acc >= kpiMin, last_sid: prev.last_sid || null,
                     anchor_note_ids: prev.anchor_note_ids || [] };
      synced = true;
    }
  }
  if (!synced && body.kw_index != null) {
    const cur = st["" + body.kw_index] || { accepted: 0, done: false };
    if (!(body.submission_id && cur.last_sid === body.submission_id)) {
      cur.accepted = (cur.accepted || 0) + acceptedDelta;
      cur.done = cur.accepted >= kpiMin;
      if (body.submission_id) cur.last_sid = body.submission_id;
      st["" + body.kw_index] = cur;
    }
  }
  // 评分锚点：rating 必须锚定"同 platform+note_id 已收录笔记"。本信封 verdict 为
  // accepted/duplicate 的 note_id 在服务端必已是 accepted，全部记为该关键词的可锚定笔记。
  if (body.kw_index != null && Array.isArray(d.results)) {
    const anchorable = d.results
      .filter((r) => r && r.note_id &&
        ["accepted", "duplicate", "duplicate_skipped"].indexOf(String((r && (r.verdict || r.gate)) || "").toLowerCase()) >= 0)
      .map((r) => String(r.note_id));
    if (anchorable.length) {
      const cur = st["" + body.kw_index] || { accepted: 0, done: false };
      const have = new Set(cur.anchor_note_ids || []);
      let added = false;
      for (const id of anchorable) { if (!have.has(id)) { have.add(id); added = true; } }
      if (added) {
        cur.anchor_note_ids = Array.from(have).slice(-50); // 封顶 50：只取其一做锚，防存储膨胀
        st["" + body.kw_index] = cur;
      }
    }
  }
  await safety._set({ [key]: st });
}

// 防重入（同 doCollectOnce 的 _running）：兜底 alarm 与采集后即时回传可能并发触发
let _uploading = false;

// ---------------------------------------------------------------- 参与者评分
// rating 条目走与 note 完全相同的 proof_queue / uploadProofs 通道（submission_id 幂等、
// 退避、死信全部复用），服务端 R6 门校验：rating∈[1,5]、理由去空白/ASCII标点后 ≥8 字、
// 锚定同 platform+note_id 已收录笔记；去重口径 platform:note_id:rating:participant_id。
// 服务端理由长度口径 regexp_replace(s, '[\s[:punct:]]','','g')——POSIX [[:punct:]] 仅
// ASCII 标点，中文标点计入长度，此处严格镜像。
function ratingReasonLen(s) {
  return String(s || "").replace(/[\s\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]/g, "").length;
}

// popup → CROWD_SUBMIT_RATING {kw_index, rating, reason, anchor_note_id?}
// 返回 {ok, reason?, queued?}；成功入队即视为"已评"（服务端去重兜底，重复提交判 duplicate）
async function submitRating(msg) {
  const participant = await safety._get("participant_id", null);
  if (!participant) return { ok: false, reason: "no_participant" };
  const task = await safety._get("active_task", null);
  if (!task || !Array.isArray(task.pack)) return { ok: false, reason: "no_active_task" };
  const idx = msg.kw_index == null ? -1 : (msg.kw_index | 0);
  if (idx < 0 || idx >= task.pack.length) return { ok: false, reason: "bad_kw_index" };
  const kw = String(task.pack[idx]);

  // 已评置灰（本地即时口径；服务端 dedupe 是权威兜底）
  const ratedKey = "rating_state_" + task.task_id;
  const ratedMap = (await safety._get(ratedKey, {})) || {};
  if (ratedMap["" + idx] && ratedMap["" + idx].rated) return { ok: false, reason: "already_rated" };

  // 镜像服务端 R6 预检（不通过就不入队，避免必拒信封烧配额/拒收率）
  const rating = Number(msg.rating);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) return { ok: false, reason: "rating_out_of_range" };
  const reason = String(msg.reason || "").trim();
  if (ratingReasonLen(reason) < 8) return { ok: false, reason: "reason_too_short" };

  // 锚点：popup 指定或取该词已收录笔记的第一条（syncKeywordProgress 维护）
  const kwSt = (await safety._get("kw_state_" + task.task_id, {})) || {};
  const anchors = (kwSt["" + idx] && kwSt["" + idx].anchor_note_ids) || [];
  const anchor = String(msg.anchor_note_id || anchors[0] || "");
  if (!anchor) return { ok: false, reason: "no_anchor" };

  // proof_seq 复用采集同一计数器（四元组 participant+task+seq+note_id 幂等不撞采集信封）
  const seqKey = "proof_seq_" + task.task_id + "_" + idx;
  const seqBase = await safety._get(seqKey, 0);
  const envelope = {
    submission_id: uuidv4(), // 入队生成一次，重试复用
    participant_id: participant,
    task_id: task.task_id,
    kw_index: idx,
    kpi_min: task.kpi_min || 5,
    proof_seq: seqBase,
    captured_at: new Date().toISOString(),
    sync_version: CONFIG.SYNC_VERSION,
    retry_count: 0,
    next_retry_at: 0,
    items: [{
      kind: "rating",
      note_id: anchor,           // R6 锚定：同 platform+note_id 已收录笔记
      note_url: "",
      title: "",
      excerpt: "",
      author: "",
      rating: rating,
      rating_reason: reason.slice(0, 200), // 服务端 left(...,200) 同口径
      matched_store: kw,         // store_pack 模式下关键词即门店
      anchor_score: 0,
      raw_query: kw,             // 进度归属该关键词（与采集信封一致）
    }],
  };
  const q = await safety._get("proof_queue", []);
  q.push(envelope);
  const update = { proof_queue: q };
  update[seqKey] = seqBase + 1;
  ratedMap["" + idx] = { rated: true, rating: rating, at: Date.now() };
  update[ratedKey] = ratedMap;
  await safety._set(update);
  // 与采集后一致：入队即尝试回传；失败留队列走退避/兜底 alarm
  try {
    await uploadProofs();
  } catch (e) {
    await logError("upload_after_rating", e);
  }
  return { ok: true, queued: true };
}


async function uploadProofs() {
  if (_uploading) return { status: "busy" };
  _uploading = true;
  try {
    return await _uploadProofsInner();
  } finally {
    _uploading = false;
  }
}

async function _uploadProofsInner() {
  const q = await safety._get("proof_queue", []);
  if (!q.length) return { status: "empty" };

  const participant = await safety._get("participant_id", null);
  if (!participant) return { status: "no_participant" };

  // 认证失败熔断状态（跨 SW 生命周期持久化）
  let authFails = (await safety._get("auth_fail_count", 0)) || 0;

  // 逐信封回传（服务端按 submission_id 幂等，重复提交返回原回执）
  const now0 = Date.now();
  const remain = []; // 本轮后仍留队列的信封（退避中 / 临时故障 / 部分条目未到终态）
  const touchedTasks = new Set();
  let sentEnvelopes = 0, deadEnvelopes = 0, backoffSkip = 0;

  for (const body of q) {
    // 历史信封补 submission_id（补一次后随队列持久化，之后重试复用同一个）
    if (!body.submission_id) body.submission_id = uuidv4();

    // 退避期未到：本轮跳过
    if (body.next_retry_at && body.next_retry_at > now0) {
      remain.push(body);
      backoffSkip++;
      continue;
    }

    let rpc;
    try {
      rpc = await callRpc("crowd_submit_proof", {
        p_participant_id: participant,
        p_envelope: body,
      });
    } catch (e) {
      await logError("upload_rpc", e);
      remain.push(markRetry(body));
      continue;
    }

    // 网络/HTTP 层失败：临时 → 退避重试；永久（其余 4xx）→ 死信。
    // 401/403 属 auth 临时故障（callRpc 已标 temp=true），连续失败熔断而非死信
    if (!rpc.ok) {
      if (rpc.temp === false) {
        await deadLetter(body, rpc.reason || "http_permanent");
        deadEnvelopes++;
      } else {
        if (rpc.auth) {
          authFails++;
          if (authFails >= CONFIG.AUTH_FAIL_BREAKER) {
            // 熔断：连续认证失败 → 显著告警 + 采集/回传暂停 30min（quota_blocked 通道，popup 可见）
            const until = Date.now() + 30 * 60 * 1000;
            await safety._set({ gate_block_reason: "认证连续失败（anon key 可能已轮换），已熔断暂停 30 分钟", quota_blocked_until: until });
            console.error("[crowd] 熔断：auth 连续失败 " + authFails + " 次，暂停 30min");
          }
        } else {
          authFails = 0; // 非认证类成功/失败重置计数
        }
        remain.push(markRetry(body));
      }
      continue;
    }
    authFails = 0; // 成功回执重置认证失败计数

    const d = rpc.data;
    if (!d || typeof d !== "object") {
      remain.push(markRetry(body)); // 响应体异常：按临时故障处理
      continue;
    }

    // 信封级应用错误：永久原因（task_not_open / participant suspended 等）→ 死信；其余 → 退避
    if (d.ok !== true) {
      const reason = d.reason || "rejected";
      // 配额用完不是错误——信封排队到配额重置（不烧 retry_count），采集暂停。
      // 优先用服务端 reset_at（配额日界=UTC 零点），兜底本地算 UTC 下一零点；+5~15min 抖动防整点冲撞
      if (reason === "quota_exceeded") {
        let resetTs = Date.parse(d.reset_at || "") || 0;
        if (!resetTs || resetTs <= Date.now()) {
          const utcNext = new Date(); utcNext.setUTCHours(24, 0, 0, 0);
          resetTs = utcNext.getTime();
        }
        resetTs += (5 + Math.random() * 10) * 60 * 1000;
        await safety._set({ quota_blocked_until: resetTs,
                            gate_block_reason: "今日配额已用完（" + (d.used_today || "?") + "/" + (d.quota_day || "?") + "），重置后自动继续" });
        body.next_retry_at = resetTs;
        remain.push(body);
        continue;
      }
      if (isPermanentReason(reason)) {
        await deadLetter(body, reason);
        deadEnvelopes++;
      } else {
        remain.push(markRetry(body));
      }
      continue;
    }

    // 回流检测：无论 accepted 多少，服务端返回 ok=true 即"服务端确实接收"（防虚假通过）
    const flow = await safety.recordFlow(d);
    if (flow.stalled) {
      // 连续 N 次零有效 → 记录回流异常（popup 显示；不阻断采集，服务端去重属正常）
      await safety._set({ flow_stall_warned_at: Date.now() });
    }

    if (body.task_id != null) {
      await syncKeywordProgress(body, d); // 同步服务端口径并置 done
      touchedTasks.add(body.task_id);
    }

    // 逐条 verdict——终态移出信封，temp/未知保留退避
    const items = Array.isArray(body.items) ? body.items : [];
    let keep = [];
    let lastGate = "";    // 最后见到的非终态 gate（retry_exhausted 死信留痕用）
    let quotaOnly = true; // 保留条目是否全部因 quota 豁免（豁免条目不触发重试上限）
    if (Array.isArray(d.results)) {
      const byPos = d.results.length === items.length;
      const byId = {};
      for (const r of d.results) {
        if (r && r.note_id) byId[String(r.note_id)] = r;
      }
      keep = items.filter((it, i) => {
        const r = byPos ? d.results[i] : (it && it.note_id ? byId[String(it.note_id)] : null);
        // 服务端结果字段实为 gate（契约注释里的 verdict 从未在服务端实现），两者都认
        const v = String((r && (r.verdict || r.gate)) || "").toLowerCase();
        if (r && r.temp === true) { lastGate = v || "temp"; quotaOnly = false; return true; } // 临时故障：保留
        const rs = String((r && r.reason) || "");
        if (rs.indexOf("quota") >= 0) return true; // 配额限流条目：保留到配额重置（park 语义，不占重试上限）
        if (v === "accepted" || v === "duplicate" || v === "duplicate_skipped" || v === "rejected") return false; // 终态：移出
        lastGate = v || "unknown";
        quotaOnly = false;
        return true; // error/缺回执/未知：保守保留，退避重试（有上限，见下）
      });
    }
    // 无逐条回执（旧服务端）：维持原语义——顶层 ok 即整封确认

    if (!keep.length) {
      sentEnvelopes++; // 所有条目终态 → 从队列删除该信封（不进入 remain）
    } else {
      body.items = keep;
      // 条目级未知/error gate 退避重试设上限（RETRY_DEAD_AFTER 次），达到上限整封转死信，
      // 防僵尸信封永久占队列；quota 滞留条目豁免（等配额重置，不烧次数）
      if (!quotaOnly && (body.retry_count || 0) + 1 >= CONFIG.RETRY_DEAD_AFTER) {
        await deadLetter(body, "retry_exhausted:" + (lastGate || "unknown"));
        deadEnvelopes++;
      } else {
        remain.push(markRetry(body)); // 剩余条目随同一 submission_id 退避重传
      }
    }
  }

  // 回写认证失败计数（熔断状态持久化）
  await safety._set({ auth_fail_count: authFails });

  // 完成判定：包内每个关键词 accepted >= kpi_min（即全部 done）→ 归档任务并续领
  const active = await safety._get("active_task", null);
  if (active && touchedTasks.has(active.task_id)) {
    const st = (await safety._get("kw_state_" + active.task_id, {})) || {};
    let allDone = active.pack.length > 0;
    for (let i = 0; i < active.pack.length; i++) {
      const k = st["" + i];
      if (!k || (!k.done && (k.accepted || 0) < active.kpi_min)) { allDone = false; break; }
    }
    if (allDone) await finalizeTask(active);
  }

  // 防数据丢失：本轮处理基于开头快照 q，而 RPC 在途期间采集路径可能已向 proof_queue
  // push 新信封——直接覆盖写会把它们静默删掉。写回前重读队列做 merge：只追加"快照里
  // 没有、remain 里也没有"的新信封；本轮已终态移除/已死信的信封绝不复活。
  // 判等优先 submission_id；无 id 的历史信封用内容指纹（快照条目与持久化副本内容一致）。
  const latestQ = await safety._get("proof_queue", []);
  const fp = (b) => (b ? [b.task_id, b.proof_seq, b.captured_at, (b.items || []).length].join("|") : "");
  const seenIds = new Set(), seenFps = new Set();
  for (const b of q) { if (!b) continue; if (b.submission_id) seenIds.add(b.submission_id); seenFps.add(fp(b)); }
  for (const b of remain) { if (!b) continue; if (b.submission_id) seenIds.add(b.submission_id); seenFps.add(fp(b)); }
  const mergedQ = remain.slice();
  let mergedNew = 0;
  for (const b of latestQ) {
    if (!b) continue;
    if (b.submission_id ? seenIds.has(b.submission_id) : seenFps.has(fp(b))) continue; // 旧信封（含已发送/已死信）
    mergedQ.push(b); // 上传窗口内新入队的信封：保留下来下轮处理
    mergedNew++;
  }
  if (mergedNew) console.log("[crowd] upload merge: 回传窗口内新入队 " + mergedNew + " 封，已并回队列");
  await safety._set({ proof_queue: mergedQ });
  return {
    status: deadEnvelopes ? "dead_letter" : (mergedQ.length ? "partial" : "uploaded"),
    sent: sentEnvelopes,
    dead: deadEnvelopes,
    queued: mergedQ.length,
    backoff: backoffSkip,
  };
}

// ---------------------------------------------------------------- 任务归档（完成 → 续领）
async function finalizeTask(task) {
  // 记录已完成任务（服务端不再发放）；封顶滚动——长期运行防 chrome.storage 膨胀
  const done = await safety._get("done_task_ids", []);
  if (!done.includes(task.task_id)) {
    done.push(task.task_id);
    while (done.length > CONFIG.DONE_TASKS_MAX) done.shift();
    await safety._set({ done_task_ids: done });
  }
  // 清理本地任务状态与进度
  const rm = {};
  rm["active_task"] = null;
  rm["kw_state_" + task.task_id] = null;
  await safety._set(rm);
}

// ---------------------------------------------------------------- 调度
// 一次性自愈（v3.4.4 遗留，防数据丢失保留）：早期版本把配额滞留定时设到"本地午夜+30min"，
// 与服务端配额日界（UTC 零点）错位可致队列假死。这里一次性清零历史滞留定时（各信封错开
// 0~30s 防惊群），下次 upload_retry 闹钟立即重传；服务端按真实配额状态重新裁决。
(async () => {
  try {
    const done = await safety._get("fix_v344_flushed", false);
    if (done) return;
    const q = await safety._get("proof_queue", []);
    let touched = false;
    for (const b of q) {
      if (b && b.next_retry_at) { b.next_retry_at = Date.now() + Math.floor(Math.random() * 30000); touched = true; }
    }
    if (touched) await safety._set({ proof_queue: q });
    await safety._set({ quota_blocked_until: 0, gate_block_reason: "", fix_v344_flushed: true });
    if (touched) console.log("[crowd] 自愈：已解除历史滞留定时，队列将立即重传");
  } catch (e) { /* SW 下次唤醒再试 */ }
})();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "collect_heartbeat") {
    doCollectOnce()
      .then((r) => {
        console.log("[crowd] heartbeat →", r.status, r.reason || "", r.task_id ? "task=" + r.task_id : "");
      })
      .catch((e) => logError("heartbeat", e));
  }
  if (alarm.name === "upload_retry") {
    // 兜底：5min 周期重传队列（退避期未到的信封自动跳过）
    uploadProofs()
      .then((r) => console.log("[crowd] upload_retry →", r.status, "queued=" + (r.queued != null ? r.queued : "-")))
      .catch((e) => logError("upload_retry", e));
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "CROWD_STATUS") {
    Promise.all([
      safety.inCooldown(),
      safety._get("day_state", null),
      safety._get("proof_queue", []),
      safety._get("active_task", null),
      safety._get("participant_id", ""),
      safety._get("gate_block_reason", ""),
      safety._get("done_task_ids", []),
      safety.flowSnapshot(),
      safety._get("last_error", null),
      safety._get("deadLetter", []),
    ]).then(async ([cd, ds, q, task, pid, gate, done, flow, lastErr, dl]) => {
      let kwProgress = null;
      if (task) {
        const st = (await safety._get("kw_state_" + task.task_id, {})) || {};
        const ratedMap = (await safety._get("rating_state_" + task.task_id, {})) || {};
        kwProgress = task.pack.map((kw, i) => {
          const k = st["" + i];
          const anchors = (k && k.anchor_note_ids) || [];
          const rt = ratedMap["" + i];
          return { kw,
                   accepted: k ? (k.accepted || 0) : 0,
                   done: !!(k && (k.done || (k.accepted || 0) >= (task.kpi_min || 5))),
                   // 评分区：accepted>=1 且有可锚定笔记时 popup 开放打分；rated 置灰
                   anchor: anchors.length ? anchors[0] : null,
                   rated: !!(rt && rt.rated),
                   ratedValue: rt && rt.rated ? (rt.rating || null) : null };
        });
      }
      // 安全线 v2 状态（向后兼容：纯新增字段，旧字段不动）
      const safetyV2 = await safety.safetyV2Snapshot().catch(() => null);
      sendResponse({
        cooldown: cd,
        day: ds,
        queueLen: q.length,
        participantId: pid,
        gateBlockReason: gate,
        doneCount: done.length,
        flow, // {zeroCount, stallThreshold, stalled, lastProgress, lastOkAgoSec}
        safety_v2: safetyV2, // {circadian, circadianWeight, warmupDay, warmupFraction, sessionLeft}
        lastError: lastErr,          // 最近错误（采集/回传/初始化），供 popup 显示
        deadLetterCount: dl.length,  // 死信数：信封级永久失败、不再重试
        deadLetter: dl.slice(-5),    // 最近几条死信明细（at/reason/submission_id），可申诉
        activeTask: task ? { task_id: task.task_id, pack_len: task.pack.length, kpi_min: task.kpi_min, kwProgress } : null,
      });
    }).catch((e) => {
      logError("status", e);
      sendResponse({ error: String(e && e.message ? e.message : e) });
    });
    return true;
  }
  if (msg.type === "CROWD_SUBMIT_RATING") {
    // 评分入口：构造 kind=rating 信封进 proof_queue（复用幂等/退避/死信链路）
    submitRating(msg)
      .then((r) => sendResponse(r))
      .catch((e) => {
        logError("submit_rating", e);
        sendResponse({ ok: false, reason: String(e && e.message ? e.message : e) });
      });
    return true; // 异步 sendResponse
  }
  if (msg.type === "CROWD_START") {
    chrome.alarms.create("collect_heartbeat", { periodInMinutes: CONFIG.HEARTBEAT_MIN });
    chrome.alarms.create("upload_retry", { periodInMinutes: CONFIG.UPLOAD_RETRY_MIN });
    safety._set({ collector_running: true });
    sendResponse({ ok: true });
  }
  if (msg.type === "CROWD_STOP") {
    // 只停采集；upload_retry 保留，把队列里已采到的数据回传完
    chrome.alarms.clear("collect_heartbeat");
    safety._set({ collector_running: false });
    sendResponse({ ok: true });
  }
  return false;
});

chrome.runtime.onInstalled.addListener((details) => {
  chrome.alarms.create("upload_retry", { periodInMinutes: CONFIG.UPLOAD_RETRY_MIN });
  if (details.reason === "install") {
    // 安装 ≠ 同意。新安装不自动开跑（不建 collect_heartbeat、collector_running=false），
    // 只打开协议页；采集由「同意并开始使用」显式启动（onboarding → CROWD_START）。
    safety._set({ collector_running: false });
    try { chrome.runtime.openOptionsPage(); } catch (_) {}
  } else {
    // 旧版升级：collector_running 未设置过 → 以现存 heartbeat alarm 为准迁移（尊重此前 CROWD_STOP）
    safety._get("collector_running", null).then((running) => {
      if (running !== null) return;
      chrome.alarms.get("collect_heartbeat", (a) => safety._set({ collector_running: !!a }));
    });
  }
  console.log("[crowd] onInstalled(" + (details && details.reason) + ") v1.0.0, sync_version=", CONFIG.SYNC_VERSION);
});

chrome.runtime.onStartup.addListener(() => {
  initBackground();
});

// SW 每次唤醒（含休眠重启）都执行：恢复引擎远程配置 + 确保兜底 alarm 存在。
// 队列/任务进度本就在 chrome.storage.local，随 SW 重启自然恢复续传。
async function initBackground() {
  await restoreSafetyEngine();
  try {
    // 先查后建——upload_retry 每次唤醒都重建会把 5min 周期重置回原点，
    // SW 被杀频繁时该 alarm 永不触发；已存在则保留原计时
    const existing = await chrome.alarms.get("upload_retry");
    if (!existing) chrome.alarms.create("upload_retry", { periodInMinutes: CONFIG.UPLOAD_RETRY_MIN });
    // 采集 heartbeat 只在用户明确"开始"过时恢复（尊重 CROWD_STOP）
    const running = await safety._get("collector_running", false);
    if (running) chrome.alarms.create("collect_heartbeat", { periodInMinutes: CONFIG.HEARTBEAT_MIN });
  } catch (e) {
    await logError("init_alarms", e);
  }
  // 清理上个 SW 生命周期遗留的采集标签页（看门狗超时 / SW 被杀导致 tab 没关上）。
  // 只关带 xsec_source=pc_crowd 标记的采集页，用户自己开的小红书标签不动。
  try {
    const tabs = await chrome.tabs.query({ url: ["https://www.xiaohongshu.com/*", "https://m.xiaohongshu.com/*"] });
    const orphanIds = (tabs || [])
      .filter((t) => t && t.id != null && typeof t.url === "string" && t.url.indexOf("xsec_source=pc_crowd") >= 0)
      .map((t) => t.id);
    if (orphanIds.length) {
      await chrome.tabs.remove(orphanIds);
      console.log("[crowd] init: 清理遗留采集标签页 x" + orphanIds.length);
    }
  } catch (_) { /* tabs 查询失败不阻塞启动 */ }
}

initBackground().catch((e) => logError("init", e));

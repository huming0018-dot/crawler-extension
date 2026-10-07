/**
 * safety_engine.js — 限速配置 / 安全线引擎（服务端下发收紧 + 本地基线兜底 + 回流检测）
 *
 * 措辞约定：本模块参数只降低触发平台风控的概率，不得对外表述为「不会封号」「保证安全」。
 * 铁律：
 * 1. 本地 SAFETY_LIMITS = 保守基线，任何来源都不得放宽；服务端 remote_limits 只紧不松：
 *    次数/配额类上限取 Math.min，间隔/冷却类下限取 Math.max。
 * 2. remote_limits 应用后持久化（remote_limits_applied）；重启由 init() 恢复并重新按基线
 *    合成一遍，不信任存储中的合成结果（防篡改绕过基线）。
 * 3. 触发"访问频繁" → 强制冷却，冷却期任何采集动作都被拒绝；device_salt 一机一号。
 * 4. 回流检测：连续 FLOW_STALL_THRESHOLD 次零有效回传 → 判"回流失效"（防虚假通过）。
 * v2 类人调度：动作间隔/会话动作数/会话间冷却/风控冷却均按截断分布采样（参数见 V2 表），
 * 乘 device_salt 确定性派生的设备抖动；时段画像（von Mises 24h）权重过低不调度；
 * warmup 七天爬坡；风控状态机见 onRateLimited/onSearchOutcome。历史沿革见 CHANGELOG.md。
 */
const SAFETY_VERSION = 3;

const SAFETY_LIMITS = Object.freeze({
  // 日搜索上限（次数类：取更严格的最小值）
  DAILY_SEARCH_MAX: 30,
  // 动作间隔（秒）（间隔类：取更严格的最大值）
  SEARCH_GAP_MIN: 60,
  SEARCH_GAP_MAX: 120,
  // 单次会话时长上限（分钟）（配额类：取更严格的最小值）
  SESSION_MAX_MIN: 15,
  // 会话超时后的强制冷却（分钟）（冷却类：取更严格的最大值）
  SESSION_COOLDOWN_MIN: 30,
  // 每篇浏览最小停留（秒）（间隔类：取更严格的最大值）
  VIEW_STAY_MIN_S: 30,
  // 触发"访问频繁"后冷却（分钟）（冷却类，本地固定值）
  RATE_LIMIT_COOLDOWN_MIN: 15,
  // 单任务包最低 KPI（未达标不计酬）
  KPI_MIN_DEFAULT: 5,
  // 本地回传队列上限（proof 条数），达到后暂停采集等待回传
  LOCAL_QUEUE_MAX: 100,
  // 回流检测：连续 N 次回传零有效 → 判回流失效
  FLOW_STALL_THRESHOLD: 3,
});

/** v2 采样基线（µ/σ 均为 ln 尺度）。截断区间 = 硬边界；远程只紧不松：下限类只能抬高，上限类只能压低。 */
const V2 = Object.freeze({
  // 搜索间隔：截断 lognormal µ=ln(90s), σ=0.9, [30s, 1800s]
  SEARCH_MU: Math.log(90),
  SEARCH_SIGMA: 0.9,
  SEARCH_MIN_S: 30,
  SEARCH_MAX_S: 1800,
  // 单次会话动作数：逆高斯 µ≈3.7, λ≈2.7，截断 [1,25]（60%+ 为 1–5 动作短会话）
  SESSION_MU: 3.7,
  SESSION_LAMBDA: 2.7,
  SESSION_MIN: 1,
  SESSION_MAX: 25,
  // 会话间冷却：截断 lognormal µ=ln(30min), σ=1.2, [5min, 6h]
  COOLDOWN_MU: Math.log(30 * 60),
  COOLDOWN_SIGMA: 1.2,
  COOLDOWN_MIN_S: 5 * 60,
  COOLDOWN_MAX_S: 6 * 3600,
  // 会话中休息：每 20–30 分钟插入 2–10 分钟（lognormal µ=ln(4min), σ=0.7）
  BREAK_EVERY_MIN_MIN: 20,
  BREAK_EVERY_MIN_MAX: 30,
  BREAK_MU: Math.log(4 * 60),
  BREAK_SIGMA: 0.7,
  BREAK_MIN_S: 2 * 60,
  BREAK_MAX_S: 10 * 60,
  // 每日硬上限 200 条/号/日（社区实测 300 触发验证码）
  HARD_CAP_DAY: 200,
  // 时段画像拒绝阈值：权重 <0.05 视为深夜，不调度
  CIRCADIAN_REJECT_W: 0.05,
  // 风控信号冷却：24–72h lognormal 采样
  RISK_MU: Math.log(36 * 3600),
  RISK_SIGMA: 0.35,
  RISK_MIN_S: 24 * 3600,
  RISK_MAX_S: 72 * 3600,
  // 连续空结果阈值与长冷却采样（暂停本轮会话；分布沿用会话冷却族，区间上抬至 [30min, 12h]）
  EMPTY_STREAK_MAX: 3,
  LONG_MU: Math.log(2 * 3600),
  LONG_SIGMA: 0.8,
  LONG_MIN_S: 30 * 60,
  LONG_MAX_S: 12 * 3600,
});

/** 访问 v2 采样器 / 设备画像（importScripts 挂载在 self；node 测试挂在 globalThis） */
function _mods() {
  const g = typeof self !== "undefined" ? self : typeof globalThis !== "undefined" ? globalThis : {};
  return { sampler: g.CROWD_SAMPLER || null, devprof: g.CROWD_DEVICE_PROFILE || null };
}

/** 次数/配额类合并：更严格者 = 更小值（远程只能压低上限，不能抬高） */
function _tightenCap(remoteVal, base) {
  return typeof remoteVal === "number" && remoteVal > 0 ? Math.min(remoteVal, base) : base;
}

/** 间隔/冷却类合并：更严格者 = 更大值（远程只能抬高下限，不能压低） */
function _tightenFloor(remoteVal, base) {
  return typeof remoteVal === "number" && remoteVal > 0 ? Math.max(remoteVal, base) : base;
}

/**
 * 把一份远程配置按"更严格者胜"与本地基线合成有效值。
 * 对任意输入幂等：对已合成结果再次合成不会改变结果。
 */
function _effectiveLimits(remote) {
  const r = remote && typeof remote === "object" ? remote : {};
  const eff = {
    quota_day: _tightenCap(r.quota_day, SAFETY_LIMITS.DAILY_SEARCH_MAX),
    gap_min: _tightenFloor(r.gap_min, SAFETY_LIMITS.SEARCH_GAP_MIN),
    gap_max: _tightenFloor(r.gap_max, SAFETY_LIMITS.SEARCH_GAP_MAX),
    session_min: _tightenCap(r.session_min, SAFETY_LIMITS.SESSION_MAX_MIN),
    cooldown_min: _tightenFloor(r.cooldown_min, SAFETY_LIMITS.SESSION_COOLDOWN_MIN),
    view_stay_min_s: _tightenFloor(r.view_stay_min_s, SAFETY_LIMITS.VIEW_STAY_MIN_S),
    // ── v2 新参数（同样只紧不松）──
    hard_cap_day: _tightenCap(r.hard_cap_day, V2.HARD_CAP_DAY), // 配额类：只能压低
    session_cooldown_min_s: _tightenFloor(r.session_cooldown_min_s, V2.COOLDOWN_MIN_S), // 冷却类：只能抬高
    session_cooldown_max_s: _tightenFloor(r.session_cooldown_max_s, V2.COOLDOWN_MAX_S),
    risk_cooldown_min_h: _tightenFloor(r.risk_cooldown_min_h, V2.RISK_MIN_S / 3600), // 风控冷却类：只能抬高
    risk_cooldown_max_h: _tightenFloor(r.risk_cooldown_max_h, V2.RISK_MAX_S / 3600),
  };
  if (eff.gap_max < eff.gap_min) eff.gap_max = eff.gap_min;
  return eff;
}

/** 纯本地基线合成结果（无任何远程配置时的有效值） */
const LOCAL_EFFECTIVE = Object.freeze(_effectiveLimits(null));

class SafetyEngine {
  constructor(storage) {
    this.s = storage || chrome.storage.local;
    this.remote = null; // 已按基线合成后的有效远程配置（只会更严，不会更松）
  }

  /**
   * SW 启动恢复入口：从 chrome.storage.local 读取已持久化的 remote_limits。
   * 恢复时重新按本地基线合成一遍，不信任存储中的合成结果。
   * background 必须在构造后立即调用：await safety.init();
   */
  async init() {
    const saved = await this._get("remote_limits_applied", null);
    if (saved && typeof saved === "object") {
      this.remote = _effectiveLimits(saved);
    }
    return this.remote;
  }

  /** 应用服务端下发的限速配置（只紧不松：任何远程值都不能放宽本地基线） */
  async applyRemoteLimits(remote) {
    if (!remote || typeof remote !== "object") return;
    this.remote = _effectiveLimits(remote);
    // 持久化合成后的有效值，重启经 init() 恢复（恢复时会再合成一次）
    await this._set({ remote_limits_applied: this.remote, remote_limits_at: Date.now() });
  }

  /** 当前有效配置（远程合成值或纯本地基线） */
  _eff() {
    return this.remote || LOCAL_EFFECTIVE;
  }

  async _get(key, fallback) {
    const r = await this.s.get(key);
    return r[key] !== undefined ? r[key] : fallback;
  }

  async _set(obj) {
    await this.s.set(obj);
  }

  /** v2 设备画像（device_salt 确定性派生，实例内缓存；模块缺失时返回 null 走退化兜底） */
  async _profile() {
    if (this._profCache !== undefined) return this._profCache;
    const dp = _mods().devprof;
    if (!dp) {
      this._profCache = null;
      return null;
    }
    const salt = await this.getDeviceSalt();
    this._profCache = await dp.getProfile(this.s, salt);
    return this._profCache;
  }

  /** v2 warmup 状态（模块缺失时退化 fraction=1，不阻断采集） */
  async _warmup() {
    const dp = _mods().devprof;
    if (!dp) return { day: null, fraction: 1 };
    return dp.getWarmup(this.s);
  }

  /**
   * 首次运行生成并持久化设备指纹盐（一机一号）。
   * 格式 "Dsalt" + 16 位小写 hex；已持久化的 salt 原样复用。
   */
  async getDeviceSalt() {
    let salt = await this._get("device_salt", null);
    if (!salt) {
      const buf = new Uint8Array(8);
      crypto.getRandomValues(buf);
      salt = "Dsalt" + Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
      await this._set({ device_salt: salt });
    }
    return salt;
  }

  /** 读取当日状态：{date, searches, sessionStart} */
  async _dayState() {
    const today = new Date().toISOString().slice(0, 10);
    const st = await this._get("day_state", null);
    if (!st || st.date !== today) {
      const fresh = { date: today, searches: 0, sessionStart: null };
      await this._set({ day_state: fresh });
      return fresh;
    }
    return st;
  }

  /** 当前任务包配额（次数类：任务包 quota_day、远程配置、本地基线取最严） */
  async _currentQuota() {
    const task = await this._get("active_task", null);
    const taskQ = task && task.quota_day ? task.quota_day : null;
    let q = this._eff().quota_day;
    if (taskQ) q = Math.min(q, taskQ);
    return q;
  }

  /** 是否处于冷却期 */
  async inCooldown() {
    const cd = await this._get("cooldown_until", 0);
    if (cd && Date.now() < cd) {
      return { active: true, until: cd, leftMin: Math.ceil((cd - Date.now()) / 60000) };
    }
    return { active: false };
  }

  /** 检查会话：超过会话上限则进入强制冷却（冷却时长为冷却类下限，远程只能加长） */
  async _sessionGuard() {
    const st = await this._dayState();
    const now = Date.now();
    const eff = this._eff();
    const sessionMax = eff.session_min; // 配额类：已按 min 合成
    const cooldownMin = eff.cooldown_min; // 冷却类：已按 max 合成
    if (!st.sessionStart) {
      st.sessionStart = now;
      await this._set({ day_state: st });
      return { ok: true };
    }
    const mins = (now - st.sessionStart) / 60000;
    if (mins > sessionMax) {
      const until = now + cooldownMin * 60000;
      await this._set({ cooldown_until: until });
      st.sessionStart = null;
      await this._set({ day_state: st });
      return { ok: false, reason: `会话超时，冷却 ${cooldownMin}min`, until };
    }
    return { ok: true };
  }

  /** 当前生效的限速配置（供 popup 展示/审计） */
  async currentLimits() {
    const q = await this._currentQuota();
    const eff = this._eff();
    return {
      quotaDay: q,
      gapMin: eff.gap_min,
      gapMax: eff.gap_max,
      sessionMin: eff.session_min,
      cooldownMin: eff.cooldown_min,
      viewStayMinS: eff.view_stay_min_s,
      source: this.remote ? "remote_tightened" : "local_base",
    };
  }

  /** 搜索动作准入检查：通过则返回 {ok, waitMs}，失败返回 {ok:false, reason} */
  async canSearch() {
    // 1. 冷却期
    const cd = await this.inCooldown();
    if (cd.active) return { ok: false, reason: `冷却中，剩余 ${cd.leftMin}min` };

    // 2. 风控状态机（v2 §4）：触发过风控信号当日停止一切采集
    const st = await this._dayState();
    const risk = await this._get("risk_state", null);
    if (risk && risk.stop_date === st.date) {
      return { ok: false, reason: "风控信号：当日停止采集" };
    }

    // 3. 会话时长（v3 兼容闸门，保留）
    const sg = await this._sessionGuard();
    if (!sg.ok) return sg;

    // 4. 日配额 = min(现有 quota 逻辑, warmup 当日上限, 硬上限 200)；「频次异常」次日减半
    const warm = await this._warmup();
    const eff = this._eff();
    let quota = await this._currentQuota();
    quota = Math.min(quota, Math.max(1, Math.round(quota * warm.fraction)), eff.hard_cap_day);
    if (risk && risk.quota_scale_date === st.date) quota = Math.max(1, Math.floor(quota / 2));
    if (st.searches >= quota) {
      return { ok: false, reason: `已达日配额 ${quota} 次` };
    }

    // 5. 动作间隔：截断 lognormal 采样 µ=ln(90s) σ=0.9 [30s,1800s]，乘设备 µ/σ 抖动系数；
    //    截断区间下限与 eff.gap_min/gap_max 合成（远程只紧不松）。采样器缺失时退化均匀分布。
    const last = await this._get("last_search_at", 0);
    const S = _mods().sampler;
    let gap;
    if (S) {
      const prof = await this._profile();
      const loS = Math.max(V2.SEARCH_MIN_S, eff.gap_min);
      const hiS = Math.max(loS + 1, V2.SEARCH_MAX_S, eff.gap_max);
      gap = Math.round(
        S.sampleTruncLognormal(
          V2.SEARCH_MU * (prof ? prof.gapMuJit : 1),
          V2.SEARCH_SIGMA * (prof ? prof.gapSigmaJit : 1),
          loS,
          hiS
        )
      );
    } else {
      const gapMax = Math.max(eff.gap_min, eff.gap_max);
      gap = eff.gap_min + Math.floor(Math.random() * (gapMax - eff.gap_min + 1));
    }
    const wait = Math.max(0, last + gap * 1000 - Date.now());
    // 调用方必须实际等待 waitMs 后再发起动作
    return { ok: true, waitMs: wait, quotaLeft: quota - st.searches, gap };
  }

  /** 记录一次搜索（必须在 canSearch ok 且实际等待 waitMs 之后调用） */
  async markSearch() {
    const st = await this._dayState();
    st.searches += 1;
    await this._set({ day_state: st, last_search_at: Date.now() });
    return st.searches;
  }

  /**
   * 风控信号状态机。signal：
   *  - "rate_limited"（默认）：页面出现「访问频繁/验证」→ 当日立即停止 + 冷却 24–72h（lognormal 采样）
   *  - "freq_abnormal"：频次异常提示（300013 类）→ 同上，且次日配额减半
   * 结束当前会话；冷却期内 canSearch/canStartSession 全部拒绝。
   * 返回冷却截止时间戳 until。不做任何自动过验证码能力（合规红线）。
   */
  async onRateLimited(signal) {
    const kind = signal || "rate_limited";
    const S = _mods().sampler;
    const eff = this._eff();
    const now = Date.now();
    let coolMs = SAFETY_LIMITS.RATE_LIMIT_COOLDOWN_MIN * 60000; // 采样器缺失时的退化兜底
    if (S) {
      const loS = Math.max(V2.RISK_MIN_S, (eff.risk_cooldown_min_h || 0) * 3600);
      const hiS = Math.max(loS + 1, V2.RISK_MAX_S, (eff.risk_cooldown_max_h || 0) * 3600);
      coolMs = Math.round(S.sampleTruncLognormal(V2.RISK_MU, V2.RISK_SIGMA, loS, hiS) * 1000);
    }
    const until = now + coolMs;
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(now + 86400000).toISOString().slice(0, 10);
    const prev = await this._get("risk_state", null);
    const risk = {
      kind,
      at: now,
      stop_date: today, // 当日停止
      cooldown_until: until, // 冷却 24–72h
      quota_scale_date: kind === "freq_abnormal" ? tomorrow : (prev && prev.quota_scale_date) || null,
    };
    // 结束当前会话，会话冷却对齐风控冷却
    const ss = await this._get("session_v2", null);
    if (ss) {
      ss.active = false;
      ss.actionsLeft = 0;
      ss.cooldownUntil = Math.max(ss.cooldownUntil || 0, until);
      await this._set({ session_v2: ss });
    }
    await this._set({ risk_state: risk, cooldown_until: until });
    return until;
  }

  /**
   * 搜索结果计数接风控状态机：itemCount>0 清空计数；
   * 连续 3 次空结果/异常响应 → 暂停本轮会话，进入长冷却采样（lognormal [30min,12h]）。
   */
  async onSearchOutcome(itemCount) {
    if (itemCount > 0) {
      await this._set({ empty_streak: 0 });
      return { cooled: false, streak: 0 };
    }
    return this.onEmptyResult();
  }

  async onEmptyResult() {
    const S = _mods().sampler;
    const streak = (await this._get("empty_streak", 0)) + 1;
    await this._set({ empty_streak: streak });
    if (streak < V2.EMPTY_STREAK_MAX) return { cooled: false, streak };
    const now = Date.now();
    let coolMs = V2.LONG_MIN_S * 1000; // 退化兜底：30min
    if (S) {
      coolMs = Math.round(S.sampleTruncLognormal(V2.LONG_MU, V2.LONG_SIGMA, V2.LONG_MIN_S, V2.LONG_MAX_S) * 1000);
    }
    const until = now + coolMs;
    const ss = await this._get("session_v2", null);
    if (ss) {
      ss.active = false;
      ss.actionsLeft = 0;
      ss.cooldownUntil = Math.max(ss.cooldownUntil || 0, until);
      await this._set({ session_v2: ss });
    }
    await this._set({ cooldown_until: until, empty_streak: 0 });
    return { cooled: true, until, streak };
  }

  /**
   * 会话准入（单次会话动作数 / 会话间冷却 / 会话中休息）。
   * 返回 {ok:true, actionsLeft} 或 {ok:false, reason, waitMs}。
   */
  async canStartSession() {
    // 全局冷却 / 风控当日停止同样阻断会话
    const cd = await this.inCooldown();
    if (cd.active) return { ok: false, reason: `冷却中，剩余 ${cd.leftMin}min`, waitMs: cd.until - Date.now() };
    const today = new Date().toISOString().slice(0, 10);
    const risk = await this._get("risk_state", null);
    if (risk && risk.stop_date === today) return { ok: false, reason: "风控信号：当日停止采集" };

    const S = _mods().sampler;
    const now = Date.now();
    const ss = await this._get("session_v2", null);

    // 进行中的会话：先查休息窗，再放行
    if (ss && ss.active && ss.actionsLeft > 0) {
      if (ss.breakUntil && now < ss.breakUntil) {
        return { ok: false, reason: "会话休息中", waitMs: ss.breakUntil - now };
      }
      if (S && ss.nextBreakAt && now >= ss.nextBreakAt) {
        const breakS = S.sampleTruncLognormal(V2.BREAK_MU, V2.BREAK_SIGMA, V2.BREAK_MIN_S, V2.BREAK_MAX_S);
        ss.breakUntil = now + Math.round(breakS * 1000);
        ss.nextBreakAt =
          now + (V2.BREAK_EVERY_MIN_MIN + Math.random() * (V2.BREAK_EVERY_MIN_MAX - V2.BREAK_EVERY_MIN_MIN)) * 60000;
        await this._set({ session_v2: ss });
        return { ok: false, reason: "会话休息中", waitMs: ss.breakUntil - now };
      }
      return { ok: true, actionsLeft: ss.actionsLeft, startedAt: ss.startedAt };
    }

    // 会话间冷却未结束
    if (ss && ss.cooldownUntil && now < ss.cooldownUntil) {
      return { ok: false, reason: "会话间冷却中", waitMs: ss.cooldownUntil - now };
    }

    // 开启新会话：动作数逆高斯 µ≈3.7/λ≈2.7 截断 [1,25] 采样（60%+ 为 1–5 动作短会话）
    let n = 3; // 采样器缺失时的退化兜底（短会话）
    if (S) {
      const prof = await this._profile();
      n = Math.round(
        S.sampleInvGaussian(
          V2.SESSION_MU * (prof ? prof.sessionMuJit : 1),
          V2.SESSION_LAMBDA * (prof ? prof.sessionLambdaJit : 1),
          V2.SESSION_MIN,
          V2.SESSION_MAX
        )
      );
      n = Math.min(V2.SESSION_MAX, Math.max(V2.SESSION_MIN, n));
    }
    const ns = {
      active: true,
      actionsLeft: n,
      budget: n,
      startedAt: now,
      nextBreakAt:
        now + (V2.BREAK_EVERY_MIN_MIN + Math.random() * (V2.BREAK_EVERY_MIN_MAX - V2.BREAK_EVERY_MIN_MIN)) * 60000,
      breakUntil: 0,
      cooldownUntil: 0,
    };
    await this._set({ session_v2: ns });
    return { ok: true, started: true, actionsLeft: n };
  }

  /**
   * 记录一次会话动作（搜索成功后调用）。动作数耗尽 → 结束会话，
   * 会话间冷却按 lognormal µ=ln(30min) σ=1.2 [5min,6h] 采样（×设备抖动，远程只紧不松）。
   */
  async markSessionAction() {
    const S = _mods().sampler;
    const now = Date.now();
    const ss = await this._get("session_v2", null);
    if (!ss || !ss.active) return { active: false };
    ss.actionsLeft = (ss.actionsLeft || 0) - 1;
    if (ss.actionsLeft > 0) {
      await this._set({ session_v2: ss });
      return { active: true, actionsLeft: ss.actionsLeft };
    }
    const eff = this._eff();
    let coolMs = eff.cooldown_min * 60000; // 采样器缺失时退化沿用 v3 冷却
    if (S) {
      const prof = await this._profile();
      const loS = Math.max(V2.COOLDOWN_MIN_S, eff.session_cooldown_min_s || 0);
      const hiS = Math.max(loS + 1, V2.COOLDOWN_MAX_S, eff.session_cooldown_max_s || 0);
      coolMs = Math.round(
        S.sampleTruncLognormal(
          V2.COOLDOWN_MU * (prof ? prof.cooldownMuJit : 1),
          V2.COOLDOWN_SIGMA * (prof ? prof.cooldownSigmaJit : 1),
          loS,
          hiS
        ) * 1000
      );
    }
    ss.active = false;
    ss.actionsLeft = 0;
    ss.cooldownUntil = now + coolMs;
    await this._set({ session_v2: ss });
    return { active: false, ended: true, cooldownMs: coolMs };
  }

  /**
   * 时段画像闸：von Mises 混合 24h 曲线权重 <0.05 拒绝（0–7 点 ≈0，天然命中）。
   * date 参数仅供测试注入，生产用当前时刻。
   */
  async isCircadianAllowed(date) {
    const dp = _mods().devprof;
    if (!dp) return { ok: true, weight: 1, degraded: true };
    const salt = await this.getDeviceSalt();
    const prof = await this._profile();
    const w = dp.circadianWeight(prof, salt, date || new Date());
    return { ok: w >= V2.CIRCADIAN_REJECT_W, weight: w };
  }

  /** v2 状态快照（供 popup CROWD_STATUS.safety_v2 展示） */
  async safetyV2Snapshot() {
    const circ = await this.isCircadianAllowed();
    const warm = await this._warmup();
    const ss = await this._get("session_v2", null);
    return {
      circadian: circ.ok,
      circadianWeight: Math.round(circ.weight * 1000) / 1000,
      warmupDay: warm.day,
      warmupFraction: warm.fraction,
      sessionLeft: ss && ss.active ? ss.actionsLeft || 0 : 0,
    };
  }

  /**
   * 浏览停留计时：首次调用开始计时，再次调用返回累计停留。
   * 由 canViewNote() 调用（阅读停留校验的唯一入口），不单独对外使用。
   */
  async ensureViewStay(noteId, minStayS) {
    const min = typeof minStayS === "number" && minStayS > 0 ? minStayS : this._eff().view_stay_min_s;
    const key = "view_" + noteId;
    const t = await this._get(key, 0);
    if (!t) {
      await this._set({ [key]: Date.now() });
      return { first: true, elapsed: 0, ok: false, minStayS: min };
    }
    const elapsed = (Date.now() - t) / 1000;
    return { first: false, elapsed, ok: elapsed >= min, minStayS: min };
  }

  /**
   * 阅读停留守卫（采集某篇笔记正文前的准入检查）。
   * 冷却期直接拒绝；停留不足 VIEW_STAY_MIN_S（或远程收紧后的值）拒绝并给出 waitMs。
   */
  async canViewNote(noteId) {
    if (!noteId) return { ok: false, reason: "missing_note_id" };
    const cd = await this.inCooldown();
    if (cd.active) return { ok: false, reason: `冷却中，剩余 ${cd.leftMin}min` };
    const eff = this._eff();
    const stay = await this.ensureViewStay(noteId, eff.view_stay_min_s);
    if (stay.first) {
      return {
        ok: false,
        first: true,
        reason: `首次打开该笔记，需停留 ≥${eff.view_stay_min_s}s 后再采集`,
        waitMs: eff.view_stay_min_s * 1000,
      };
    }
    if (!stay.ok) {
      const leftMs = Math.ceil(eff.view_stay_min_s * 1000 - stay.elapsed * 1000);
      return {
        ok: false,
        reason: `阅读停留不足（${Math.floor(stay.elapsed)}s/${eff.view_stay_min_s}s）`,
        waitMs: Math.max(leftMs, 0),
        elapsed: stay.elapsed,
      };
    }
    return { ok: true, elapsed: stay.elapsed };
  }

  /** 本地队列水位检查 */
  async queueWatermark() {
    const q = await this._get("proof_queue", []);
    return { count: q.length, max: SAFETY_LIMITS.LOCAL_QUEUE_MAX, full: q.length >= SAFETY_LIMITS.LOCAL_QUEUE_MAX };
  }

  // ────────────────────── 回流检测 ──────────────────────
  /**
   * 记录一次 RPC 回传结果，判定是否"回流失效"。
   * rpcResp = {ok, accepted, new_progress} 来自 crowd_submit_proof。
   * 判定规则：服务端返回 ok=true 视为"服务端确实接收"（防虚假通过）；
   * 若连续 FLOW_STALL_THRESHOLD 次 accepted=0（全部去重/拒收）→ 回流失效告警。
   */
  async recordFlow(rpcResp) {
    if (!rpcResp || rpcResp.ok !== true) {
      // 网络失败/服务端拒：计数清零（这不是"回流失效"，是回传失败，下次会重试）
      return { stalled: false, reason: "upload_failed" };
    }
    const accepted = rpcResp.accepted || 0;
    const st = await this._get("flow_state", { zero_count: 0, last_progress: null, last_ok_ts: 0 });
    st.last_ok_ts = Date.now();
    if (rpcResp.new_progress != null) st.last_progress = rpcResp.new_progress;
    if (accepted === 0) {
      st.zero_count = (st.zero_count || 0) + 1;
    } else {
      st.zero_count = 0;
    }
    const stalled = st.zero_count >= SAFETY_LIMITS.FLOW_STALL_THRESHOLD;
    await this._set({ flow_state: st, flow_last_result: { at: Date.now(), accepted, new_progress: rpcResp.new_progress } });
    return { stalled, reason: stalled ? "flow_stalled" : "flow_ok", zero_count: st.zero_count };
  }

  /** 回流健康快照（供 popup 展示） */
  async flowSnapshot() {
    const st = await this._get("flow_state", { zero_count: 0, last_progress: null, last_ok_ts: 0 });
    return {
      zeroCount: st.zero_count || 0,
      stallThreshold: SAFETY_LIMITS.FLOW_STALL_THRESHOLD,
      stalled: (st.zero_count || 0) >= SAFETY_LIMITS.FLOW_STALL_THRESHOLD,
      lastProgress: st.last_progress,
      lastOkAgoSec: st.last_ok_ts ? Math.round((Date.now() - st.last_ok_ts) / 1000) : null,
    };
  }
}

if (typeof module !== "undefined") module.exports = { SafetyEngine, SAFETY_LIMITS, SAFETY_VERSION };

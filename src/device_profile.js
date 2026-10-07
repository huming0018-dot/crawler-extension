/**
 * device_profile.js — 设备层画像（安全线 v2）。挂载 self.CROWD_DEVICE_PROFILE（MV3 SW 走
 * importScripts，不用 ES module）；importScripts 顺序：sampler → device_profile → config → safety_engine。
 *  - 设备抖动：装机时由 device_salt 确定性派生每台设备专属的 µ/σ 微调（µ ±12% / σ ±10%，
 *    时段画像与会话偏好 ±15%）。同设备节奏长期稳定，不同设备互不相同；派生结果持久化。
 *  - 时段画像：von Mises 混合 24h 曲线——0–7 点权重≈0；12–13 点低谷 ×0.2–0.5；
 *    晚间高峰；工作日/周末两套；逐日 ±15% 抖动（按 salt+日期确定性派生，当天内稳定）。
 *  - warmup：首次运行日期持久化；D1 20% → D7 100% 爬坡（WARMUP_TABLE + 设备级抖动）。
 */
(function () {
  "use strict";

  /** FNV-1a 32-bit 字符串 hash（稳定、跨平台一致，用于确定性派生） */
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  /** hash(salt|name) → [-span, +span] 确定性抖动 */
  function _jitter(salt, name, span) {
    return ((fnv1a(String(salt) + "|" + name) / 4294967295) * 2 - 1) * span;
  }

  // ── 24h 时段画像：von Mises 混合曲线（三分量：上午/下午/晚间高峰；工作日与周末两套） ──
  const WEEKDAY_COMPS = [
    { mu: 10.0, amp: 0.45, kappa: 3.0 },
    { mu: 15.5, amp: 0.60, kappa: 2.5 },
    { mu: 20.5, amp: 1.0, kappa: 3.0 },
  ];
  const WEEKEND_COMPS = [
    { mu: 10.5, amp: 0.5, kappa: 3.0 },
    { mu: 15.0, amp: 0.55, kappa: 2.5 },
    { mu: 21.0, amp: 1.0, kappa: 3.0 },
  ];

  function _mix(comps, h) {
    let w = 0;
    for (const c of comps) {
      // von Mises：峰值处 exp(0)=1，离峰越远指数衰减
      w += c.amp * Math.exp(c.kappa * (Math.cos((2 * Math.PI * (h - c.mu)) / 24) - 1));
    }
    return w;
  }
  function _peak(comps) {
    let m = 0;
    for (let h = 0; h < 24; h += 0.05) m = Math.max(m, _mix(comps, h));
    return m;
  }
  const NORM = [_peak(WEEKDAY_COMPS), _peak(WEEKEND_COMPS)]; // 归一化：高峰权重 ≈1

  /**
   * 由 device_salt 确定性派生设备专属参数：
   * 搜索间隔/会话动作数/会话间冷却分布的 µ/σ/λ 系数、时段画像振幅 ±15%、
   * 12–13 点低谷系数 lunchDip 0.2–0.5。
   */
  function derive(salt) {
    return {
      v: 2,
      salt,
      gapMuJit: 1 + _jitter(salt, "gap_mu", 0.12),
      gapSigmaJit: 1 + _jitter(salt, "gap_sigma", 0.1),
      sessionMuJit: 1 + _jitter(salt, "session_mu", 0.12),
      sessionLambdaJit: 1 + _jitter(salt, "session_lambda", 0.1),
      cooldownMuJit: 1 + _jitter(salt, "cooldown_mu", 0.12),
      cooldownSigmaJit: 1 + _jitter(salt, "cooldown_sigma", 0.1),
      circadianAmpJit: 1 + _jitter(salt, "circadian_amp", 0.15),
      lunchDip: 0.2 + (fnv1a(String(salt) + "|lunch_dip") / 4294967295) * 0.3,
    };
  }

  /**
   * 读取/派生并持久化设备画像（chrome.storage.local，键 device_profile_v2）。
   * 已持久化且 salt 一致 → 原样复用（重启不变）；salt 变化（换机/重装）→ 重新派生。
   * storage 为 chrome.storage.local 兼容接口（get(key)/set(obj)）。
   */
  async function getProfile(storage, salt) {
    const r = await storage.get("device_profile_v2");
    const saved = r.device_profile_v2;
    if (saved && saved.salt === salt && saved.v === 2) return saved;
    const p = derive(salt);
    await storage.set({ device_profile_v2: p });
    return p;
  }

  /**
   * 当前时刻的时段画像权重（0–1，高峰≈1）。
   * 0–7 点 ≈0；12–13 点低谷 ×lunchDip；逐日 ±15% 确定性抖动（当天内多次调用一致）。
   */
  function circadianWeight(profile, salt, date) {
    date = date || new Date();
    const h = date.getHours() + date.getMinutes() / 60;
    const dow = date.getDay();
    const weekend = dow === 0 || dow === 6;
    const comps = weekend ? WEEKEND_COMPS : WEEKDAY_COMPS;
    let w = _mix(comps, h) / NORM[weekend ? 1 : 0];
    // 12–13 点低谷（×0.2–0.5，设备派生）
    if (h >= 12 && h < 14) w *= profile.lunchDip;
    // 0–7 点 ≈0，7–8:30 平滑爬升
    if (h < 7) w *= 0.02;
    else if (h < 8.5) w *= 0.02 + 0.98 * ((h - 7) / 1.5);
    // 设备振幅 ±15% + 逐日 ±15% 抖动
    w *= profile.circadianAmpJit;
    w *= 1 + _jitter(salt, "day_" + date.toISOString().slice(0, 10), 0.15);
    return w;
  }

  /**
   * warmup 状态机：首次运行日期持久化（键 warmup_state.first_run_date，UTC 日界，
   * 与 day_state 一致）；D1 20% → D7 100%（WARMUP_TABLE + 设备级稳定抖动）。
   * 返回 { day, fraction, firstRunDate }。
   */
  async function getWarmup(storage, now) {
    now = now || new Date();
    const today = now.toISOString().slice(0, 10);
    const r = await storage.get("warmup_state");
    let w = r.warmup_state;
    if (!w || !w.first_run_date) {
      // 老设备豁免：首次初始化时若当天已有采集记录（v2 上线前就在跑的设备），
      // 直接视为已过爬坡期（回溯 6 天 → fraction=1.0），避免误伤存量活跃设备
      const ds = await storage.get("day_state");
      const hasActivity = !!(ds && ds.day_state && ds.day_state.date === today && (ds.day_state.searches || 0) > 0);
      const d0 = new Date(Date.parse(today + "T00:00:00Z") - (hasActivity ? 6 : 0) * 86400000);
      w = { first_run_date: d0.toISOString().slice(0, 10) };
      await storage.set({ warmup_state: w });
    }
    // first_run_date 被写坏时 Date.parse=NaN → 配额闸门会静默失效；
    // 回退为已过爬坡期（day=7 → fraction=1）：宁可放开也不让闸门失效
    const parsedFirst = Date.parse(w.first_run_date + "T00:00:00Z");
    const day = Number.isFinite(parsedFirst)
      ? Math.max(1, Math.floor((Date.parse(today + "T00:00:00Z") - parsedFirst) / 86400000) + 1)
      : 7;
    // 七天平滑爬坡表：D1 20% → D7 100%；设备级 ±10% 稳定抖动（device_salt 派生，
    // 同一设备恒定）——消灭"全员同一条曲线"特征
    const WARMUP_TABLE = [0.2, 0.3, 0.45, 0.6, 0.75, 0.9, 1.0];
    const base = day >= 7 ? 1.0 : WARMUP_TABLE[Math.max(1, day) - 1];
    const saltRow = await storage.get("device_salt");
    const salt = (saltRow && saltRow.device_salt) || "default";
    let h = 0;
    for (let i = 0; i < salt.length; i++) h = (h * 31 + salt.charCodeAt(i)) >>> 0;
    const jitter = 0.9 + (h % 1000) / 10000; // 0.900 ~ 0.999
    const fraction = Math.min(1, base * jitter);
    return { day, fraction, firstRunDate: w.first_run_date };
  }

  const api = { fnv1a, derive, getProfile, circadianWeight, getWarmup };
  if (typeof self !== "undefined") self.CROWD_DEVICE_PROFILE = api;
  if (typeof module !== "undefined") module.exports = api;
})();

/**
 * sampler.js — 类人调度采样器（安全线 v2）。挂载 self.CROWD_SAMPLER
 * （MV3 SW 不能用 ES module）；importScripts 链中须放在最前面。
 * 采样纪律：截断用逆变换/拒绝采样保住分布形状，禁止 clamp——clamp 把概率质量
 * 堆到边界，边界堆积本身就是风控特征；每次动作现场采样，不用固定值/均匀分布。
 */
(function () {
  "use strict";

  // ── 标准正态 CDF：Abramowitz–Stegun 7.1.26 erf 有理逼近（|ε| ≤ 1.5e-7） ──
  function _erf(x) {
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * ax);
    const y =
      1 -
      ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
        t *
        Math.exp(-ax * ax);
    return sign * y;
  }
  function phi(x) {
    return 0.5 * (1 + _erf(x / Math.SQRT2));
  }

  // ── 标准正态逆 CDF：Acklam 有理逼近 + 一步 Halley 精化（全区间高精度） ──
  function phiInv(p) {
    if (p <= 0) return -Infinity;
    if (p >= 1) return Infinity;
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const pLow = 0.02425;
    let q, x;
    if (p < pLow) {
      q = Math.sqrt(-2 * Math.log(p));
      x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
        ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    } else if (p <= 1 - pLow) {
      q = p - 0.5;
      const r = q * q;
      x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
        ((((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1));
    } else {
      q = Math.sqrt(-2 * Math.log(1 - p));
      x = -((((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
        ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1));
    }
    // Halley 一步精化
    const e = phi(x) - p;
    const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
    return x - u / (1 + (x * u) / 2);
  }

  /**
   * 截断对数正态（逆变换截断，不 clamp）：
   *   X = exp( µ + σ·Φ⁻¹( Φ_a + U·(Φ_b − Φ_a) ) )
   *   Φ_a = Φ((ln a − µ)/σ), Φ_b = Φ((ln b − µ)/σ), U ~ Uniform(0,1)
   * 返回值恒落在 (min, max) 内，边界无概率堆积。
   */
  function sampleTruncLognormal(mu, sigma, min, max) {
    if (!(max > min)) return min;
    const pa = phi((Math.log(min) - mu) / sigma);
    const pb = phi((Math.log(max) - mu) / sigma);
    const p = pa + Math.random() * (pb - pa);
    return Math.exp(mu + sigma * phiInv(p));
  }

  /**
   * 逆高斯 IG(µ, λ) 截断 [min, max]（单次会话动作数 µ≈3.7, λ≈2.7）。
   * 标准采样法（Michael–Schucany–Haas）；截断用拒绝采样保形状（不 clamp）。
   * 200 次拒绝采样未命中的概率天文数字级小，兜底取最近端点。
   */
  function sampleInvGaussian(mu, lambda, min, max) {
    for (let i = 0; i < 200; i++) {
      const z = phiInv(Math.min(Math.max(Math.random(), 1e-12), 1 - 1e-12));
      const y = z * z;
      const x =
        mu +
        (mu * mu * y) / (2 * lambda) -
        (mu / (2 * lambda)) * Math.sqrt(4 * mu * lambda * y + mu * mu * y * y);
      const s = Math.random() <= mu / (mu + x) ? x : (mu * mu) / x;
      if (s >= min && s <= max) return s;
    }
    return Math.min(Math.max(mu, min), max);
  }

  const api = { sampleTruncLognormal, sampleInvGaussian, phi, phiInv };
  if (typeof self !== "undefined") self.CROWD_SAMPLER = api;
  if (typeof module !== "undefined") module.exports = api;
})();

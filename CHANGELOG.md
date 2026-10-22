> 历史 v1/v3 变更记录，不是当前交付状态。当前迭代见 [v4/README.md](v4/README.md)。

# Changelog

All notable changes to this project are documented here. This project was
renamed for its first public release; the pre-release history below is
distilled from in-code version notes of the production line (众包美食家 /
crowd_extension, v3.2 → v3.4.14).

## 1.0.0

First public release as **Crawler Extension**.

- No behavior change versus production v3.4.14: RPC contract, storage keys,
  alarm names, manifest `key`/`update_url`/permissions/`host_permissions`,
  message types and UI copy are byte-identical.
- Simplification pass (ponytail discipline — deletion over addition):
  - Removed the `task_status` fulfilled/closed/done branch — production
    servers have never sent that field (verified against production SQL);
    completion is decided by the `kw_state` fallback as before.
  - Removed the per-task `safety_limits` read — never sent by production;
    the top-level `safety.limits` channel is untouched and remains live.
  - Merged the duplicated rate-limit handling in the collect path.
  - Removed a write-only variable in onboarding and two unused sampler
    helpers (`pickWeighted`, `bern`).
  - Condensed in-code version-history comments into this file; kept the
    "why" of every design decision.
- Source files renamed without the version suffix
  (`background_v3414.js` → `background.js`); manifest `service_worker` /
  `scripts` updated accordingly.

## Pre-release history (summary)

- **v3.4.14** — current production line end state.
- **v3.4.13** — author-name sanitization (strip trailing date forms).
- **v3.4.12** — server known-note prefilter; envelope slots 6 → 12.
- **v3.4.11** — risk signals reported to server; 70/30 sort mix; SERP dwell
  sampling; seven-day warmup smoothing with per-device jitter.
- **v3.4.9** — popup one-tap registration entry.
- **v3.4.8** — dual-shape background (Chrome MV3 service worker + Firefox
  MV3 event page); Firefox Android support.
- **v3.4.7** — full-audit fixes: agreed_at consent gate (install ≠ consent),
  `last_sid` progress dedup against idempotent replay, auth-failure circuit
  breaker (401/403 → backoff + 30 min trip), must-reject item precheck
  (mirror of server intake rules), alarm get-before-create (starvation fix),
  `done_task_ids` cap (200), warmup NaN fallback.
- **v3.4.4** — quota park to server `reset_at`; one-time self-heal flush of
  stale retry timers; accept both `verdict` and `gate` result fields.
- **v3.4.3** — `quota_exceeded` is park-not-error (does not burn retries).
- **v3.4.2** — gates block collection only, never upload; queue drains first.
- **v3.4.1** — warmup legacy-device exemption.
- **v3.3.3** — fully automatic collection via a dedicated background tab.
- **v3.3.0** — PWA share target (`sw.js` + `submit.html`); `config.js`
  distributed with the package.
- **v3.2.3** — three-layer timeouts (RPC / content / collect watchdog).
- **v3.2** — `submission_id` envelope idempotency; per-item verdict handling
  with backoff and dead letters; `keyword_progress` server sync; upload
  queue with 5-min retry alarm; honor `canSearch` waitMs.

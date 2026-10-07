# Crawler Extension

An informed, voluntary, paid crowdsourcing browser extension. Participants
use their **own account, device and network** to collect **public**
Xiaohongshu (RED) notes and taste ratings for a crowd-sourced food guide,
under server-issued safety limits. Open source and auditable by design.

## Architecture

One sentence: the extension talks only to **Supabase security-definer
RPCs** (`crowd_fetch_tasks`, `crowd_submit_proof`, …) — the server owns the
task pool, adjudication and payout; the client holds no direct table access
(the publishable anon key is distributed by design, RLS closes everything
else server-side).

```
extension ──RPC──▶ Supabase (task pool → adjudication → payout)
    │  queue + idempotent retry + dead letters (chrome.storage.local)
    └─ safety-line engine (rate limits, sessions, circadian, warmup)
```

## Features

- **Task loop**: fetch keyword/store packs → rotate keywords until each
  reaches its KPI → archive and claim the next pack automatically.
- **Fully automatic collection**: a dedicated background tab (never steals
  focus) visits the search page; the content script does read-only,
  per-card extraction with page/keyword consistency checks.
- **Durable upload pipeline**: every envelope gets a `submission_id` at
  enqueue time (server-idempotent), per-item verdict handling, exponential
  backoff, quota parking to the server `reset_at`, dead letters for
  permanent failures — nothing is lost across service-worker restarts.
- **Safety line (harm reduction, not a promise)**: conservative local
  baselines the server can only tighten, never loosen; truncated
  lognormal / inverse-gaussian sampling for action pacing; session
  budgets and breaks; circadian profile (no late-night activity);
  seven-day warmup; rate-limit state machine with 24–72 h cooldowns;
  flow-stall detection against false-positive uploads.
- **Taste ratings**: 1–5 stars with an ≥8-char reason, anchored to an
  already-collected note; rides the same idempotent queue.
- **Informed consent gate**: install ≠ consent. Collection starts only
  after the participant reads the agreement and taps "agree & start";
  declining wipes all half-registered state.
- **Firefox (incl. Android)**: dual-shape background (Chrome MV3 service
  worker / Firefox MV3 event page) from one codebase.
- **PWA share target**: `sw.js` + `submit.html` accept system shares from
  the Xiaohongshu app.

## Participate

1. **Web / one-click install**: open `install.html` (desktop) or
   `install-mobile.html` (phone) and follow the one-click installers
   (`crowd-install-mac.command` / `crowd-install-win.bat`). Auto-updates
   are served via the manifest `update_url`.
2. **Firefox**: install the signed package linked from `install.html`
   (Android supported, `strict_min_version` 126).
3. Open the options page, tap **我要加入** to get your participant ID
   (e.g. `P-B269XL1K`), read the agreement, then **同意并开始使用**.
   You can stop any time from the popup; uninstalling removes everything.

## Directory layout

```
crawler-extension/
├── manifest.json            # MV3 manifest (dual-shape background)
├── CROWD_CONTRACT.md        # data contract (format/intake/upload/sync rules)
├── src/
│   ├── background.js        # service worker: task loop, queue, upload, scheduling
│   ├── safety_engine.js     # safety-line engine (tighten-only remote limits)
│   ├── sampler.js           # truncated lognormal / inverse-gaussian samplers
│   ├── device_profile.js    # per-device jitter, circadian profile, warmup
│   ├── content.js           # read-only page extraction (list cards / note detail)
│   ├── config.js            # Supabase connection (publishable anon key only)
│   ├── popup.html/.js       # status panel + rating UI
│   └── onboarding.html/.js  # agreement, registration, consent gate
├── apply.html               # application/download page
├── install.html             # one-click install (desktop)
├── install-mobile.html      # install guide (mobile)
├── submit.html + sw.js      # PWA share-target receiver
├── status.html              # participant status page
├── crowd-install-mac.command / crowd-install-win.bat   # one-click installers
├── crowd-updater.sh / .ps1 (+ launchagent plist)       # self-update helpers
├── publish.sh               # release packaging + upload (maintainers only)
└── icons/
```

## Development

Plain JavaScript, no build step. Load the repo root as an unpacked
extension (`chrome://extensions` → developer mode) or via
`about:debugging` in Firefox.

```bash
# syntax check
for f in src/*.js sw.js; do node --check "$f"; done
```

**E2E harness**: the behavioral test harness lives in the crowd-platform
monorepo under `test-harness/` (puppeteer-core + Chrome for Testing; all
Supabase/XHS traffic is intercepted or DNS-pinned to localhost — it can
never touch production). To run it against this repo: copy the harness
directory, point `EXT_DIR` (and the service-worker URL match) at this
repo's `src/background.js`, then `node run-all.js` — expect **47/47**.

## Safety & compliance

- **Informed & voluntary**: participants sign an in-extension agreement;
  declining or uninstalling stops everything. Registration and device
  salt never leave the extension origin.
- **Public content only**: search-result cards and note pages anyone can
  read; no DMs, settings or account data; author names are minimized.
- **Safety line ≠ immunity**: the pacing engine only *reduces the
  likelihood* of triggering platform risk control. It must never be
  described as "won't get you banned" or "guaranteed safe".
- **No CAPTCHA bypass, ever.** On any risk-control signal the extension
  stops for the day and backs off for 24–72 h.
- The publishable anon key ships by design; all reads/writes go through
  security-definer RPCs that enforce participant status, contract
  version, idempotency and scoring server-side.

## License

MIT — see [LICENSE](LICENSE).

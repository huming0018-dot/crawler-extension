# v4.0.6 private candidate

Canonical continuation of china-travel-food 4.0.5 (82cafb7). Root v1.0 is retained;
this directory does not replace the existing 3.4.14 deployment. The participant
identity, API and payout ledger differ: v4 uses authenticated crowd_v4_* RPCs.
Never run the root publish.sh for this candidate or point legacy updates.xml at it.

Changes: validate exact submission receipts before removing evidence, park quota
retries to the server reset, keep the original UUID/content/capture time, emit a
version-specific worker entry and deterministic source/file checksums.

Build: `python3 v4/build.py --output /tmp/crowd-extension-v4.0.6.zip`.
Tests: `node v4/tests/run.cjs`. For Chromium and actual isolated SQL, also set
CROWD_TEST_TOOLS (Playwright, Chromium, PGlite) and CROWD_MIGRATIONS_DIR to the
canonical crowd-kol/server/crowd/v4/supabase/migrations directory.
No production collection is performed by these tests.

Backend source and handoff:
https://github.com/huming0018-dot/crowd-kol/tree/codex/v4.0.6-handoff
Private Mac kit builder:
https://github.com/huming0018-dot/crowd-pages/tree/codex/v4.0.6-handoff/v4

The build is the Chrome/Edge unpacked form. Source still contains the existing
Firefox/native adapters; this iteration does not claim signed Firefox/mobile or
real Mac acceptance. Preserve the original v4 profile; no uninstall/reenrollment.

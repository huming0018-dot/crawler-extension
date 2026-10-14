'use strict';
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const tests=['check.cjs','auth.cjs','safety.cjs','recovery.cjs','scheduling.cjs','timing.cjs','formal-speed.cjs','comments-progress.cjs','comments-pagination.cjs','independent-comments-dom.cjs','independent-repair-only.cjs','observations.cjs','latency.cjs','pool.cjs','test-run.cjs','test-controls.cjs','local-test.cjs','work-tabs.cjs','independent-presentation.cjs','independent-control-wait.cjs','independent-high-comment-batch.cjs','independent-comment-traversal.cjs','independent-extended-comment-budget.cjs','independent-comment-receipt-pacing.cjs','relevance-retry.cjs','fast-dom.cjs','worker.cjs','navigation-state.cjs','admission-alarm.cjs','navigation-failure.cjs','update-trace.cjs','updater-preferences.cjs','update-quiescence.cjs','native.cjs','parity.cjs','kol.cjs','kol-ui.cjs','kol-diagnostics.cjs','session-health.cjs'];
if(process.env.CROWD_TEST_TOOLS&&process.env.CROWD_MIGRATIONS_DIR)tests.push('browser.mjs');
if(process.env.CROWD_TEST_TOOLS)tests.push('loading.mjs');
for(const test of tests){const result=spawnSync(process.execPath,['v4/tests/'+test],{cwd:root,env:process.env,stdio:'inherit'});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status||1);}
console.log('PASS canonical v4 checks; real Mac installation/collection is a separate acceptance step');

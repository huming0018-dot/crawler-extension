'use strict';
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const tests=['check.cjs','safety.cjs','recovery.cjs','scheduling.cjs','worker.cjs','native.cjs'];
if(process.env.CROWD_TEST_TOOLS&&process.env.CROWD_MIGRATIONS_DIR)tests.push('browser.mjs');
for(const test of tests){const result=spawnSync(process.execPath,['v4/tests/'+test],{cwd:root,env:process.env,stdio:'inherit'});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status||1);}
console.log('PASS canonical v4 checks; real Mac installation/collection is a separate acceptance step');

/* Recovery profile only: retain 60's unresolved state; never replay it as 58 work. */
(function(root){
 'use strict';
 const A=root.CrowdAgent?.prototype;if(!A)throw Error('recovery_agent_missing');
 const unknown=value=>value?.sdk_unknown===true||['sending','unknown'].includes(value?.sdk_pending?.status);
 const blocked=s=>Boolean(s?.pending_observation_batch)||unknown(s)||unknown(s?.enrichment)||
   (s?.work_slots||[]).some(slot=>unknown(slot)||unknown(slot?.enrichment));
 const original={};for(const name of ['read','save','start','step','flushOutbox','stop'])original[name]=A[name];
 const view=s=>blocked(s)?{...s,enabled:false,delivery_enabled:false,last_error:'pool_recovery_required',
   recovery_hold:true,recovery_reason:'unresolved_v60_operation'}:s;
 A.read=async function(){return view(await original.read.call(this));};
 A.save=async function(s,...args){if(s?.recovery_hold===true||blocked(s)||blocked(await original.read.call(this)))throw Error('pool_recovery_required');return original.save.call(this,s,...args);};
 A.start=async function(...args){if(blocked(await original.read.call(this)))throw Error('pool_recovery_required');return original.start.apply(this,args);};
 // Do not call save or stop here: original unknown IDs, batch snapshot and bytes
 // remain untouched for reconciliation. Return only a derived UI pause state.
 A.step=async function(...args){if(blocked(await original.read.call(this)))return false;return original.step.apply(this,args);};
 A.flushOutbox=async function(s,...args){if(blocked(s)||blocked(await original.read.call(this)))throw Error('pool_recovery_required');return original.flushOutbox.call(this,s,...args);};
 A.stop=async function(...args){if(blocked(await original.read.call(this))){await this.r.cancel?.();await this.r.cancelDelivery?.();return;}return original.stop.apply(this,args);};
 root.CrowdRecoveryGuard=Object.freeze({version:1,baseline:'4.2.58',blocked});
})(globalThis);

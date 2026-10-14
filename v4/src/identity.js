/* Detect incompatible legacy storage without exposing or changing its values. */
(function(root){
  'use strict';
  root.CrowdIdentity = {
    async entry(storage, keys) {
      if (await storage.get('session')) return 'ready';
      const state=await storage.get('agent:signed-out');
      const prior=keys.some(key=>/^agent:(?!signed-out$).+/.test(key)) ||
        state && (state.consent || state.task || state.note || state.note_id || state.note_url || state.enrichment || state.sdk_pending || state.sdk_unknown || state.pending_risk || state.risk_report || state.pending_observation_batch || state.received>0 ||
          ['outbox','rejected','history','seen','candidates','work_slots'].some(key=>state[key] && (!Array.isArray(state[key]) || state[key].length)));
      // An install secret is created before enroll; alone it proves no prior identity.
      return prior ? 'identity_recovery_required' : await storage.get('pending_invite') ? 'invited' : 'invite_required';
    },
    async legacy(storage) {
      const keys=['participant_id','device_salt','agreed_at','proof_queue','active_task','deadLetter'];
      const values=await Promise.all(keys.map(key=>storage.get(key)));
      return values.some(value=>value!==undefined && value!==null && value!=='');
    }
  };
})(globalThis);

/* Detect incompatible legacy storage without exposing or changing its values. */
(function(root){
  'use strict';
  root.CrowdIdentity = {
    async legacy(storage) {
      const keys=['participant_id','device_salt','agreed_at','proof_queue','active_task','deadLetter'];
      const values=await Promise.all(keys.map(key=>storage.get(key)));
      return values.some(value=>value!==undefined && value!==null && value!=='');
    }
  };
})(globalThis);

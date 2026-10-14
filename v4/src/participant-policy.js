/* Ordinary participants never consume personal OTA test or recovery tickets. */
(function(root){
 class CrowdLocalTest {allowed(){return false;} async status(){return {enabled:false};} async run(){} async cancel(){} async settings(){throw Error('invalid_request');}}
 class CrowdRecovery {async run(){} async cancel(){}}
 class CrowdRisk {async status(){return {allowed:false};} async captureMetadata(){} async captureNavigation(){} async preflight(){return false;} async confirm(){throw Error('invalid_request');}}
 Object.assign(root,{CrowdLocalTest,CrowdRecovery,CrowdRisk});
})(globalThis);

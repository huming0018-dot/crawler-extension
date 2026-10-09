/* Explicit watchlist controls; DOM text nodes only, no remotely supplied markup. */
(function(){
  'use strict';
  const el=id=>document.getElementById('kol_'+id), U=globalThis.CrowdKOLUI;
  if(globalThis.CrowdNative){el('section').hidden=true;return;}
  let remote={},local={},busy=false,preview=[],refreshVersion=0,derivedPreview=[];
  const histories=new Map();
  const errors={legacy_outbox_pending:'旧采集还有待回传记录。已保留并继续回传，完成后再启动KOL任务。',legacy_enrichment_pending:'旧采集尚有附加内容待处理。请先完成或明确停止旧任务，避免丢失已采记录。',platform_identity_changed:'当前平台登录身份与任务绑定不一致，已暂停。请使用账号页重新核对后创建新任务。',identity_verification_required:'尚未从平台账号导航核对到当前登录身份。请在账号页完成登录后再核对。',backend_login_required:'参与身份已失效，请先恢复中台登录。',approval_required:'参与身份尚未获准。',consent_required:'请先在上方确认自愿参与。',login_required:'平台要求登录。请在采集页由本人登录后继续。',captcha:'平台要求验证。已停止新访问，请由本人完成。',rate_limit:'平台限流，已暂停。不要反复启动或换号重试。',navigation_uncommitted:'导航未提交，工作页仍为空白。任务已停，原队列保留。',navigation_failed:'打开目标页失败，原队列保留。',author_mismatch:'详情作者与名单身份不符，该内容没有入库。',invalid_receipt:'服务端回执不完整，本地记录保留待对账。',unsupported_navigation:'链接不属于当前支持的平台或页面。',action_budget:'已达到共享访问预算，等待额度恢复。',action_gap:'等待下一次允许的访问时间。',session_rest:'共享会话冷却尚未结束。',target_paused:'目标已暂停，请先恢复目标。',lease_lost:'任务租约失效，已有证据保留待回传。'};
  const time=v=>v?(/^\d{4}-\d{2}-\d{2}$/.test(String(v))?v+'（日期）':new Date(v).toLocaleString('zh-CN')):'未取得';
  Object.assign(errors,{source_outcome_unknown:'上次来源操作结果未确认。已停止，不能重复派发或跨设备抢占。请保留原设备进行对账。',delivery_retry_limit:'自动回传已尝试3次，原记录与请求编号保留。可明确点击“重试待回传”。',checkpoint_conflict:'恢复检查点版本冲突，已停止。请先核对原设备。',old_executor_required:'请在原设备停止并释放任务后，再从本设备恢复。',outbox_not_drained:'已有记录尚未全部确认入库，不能释放任务。',recovery_not_supported:'旧任务没有安全恢复协议，请完成旧任务后创建新任务。'});
  Object.assign(errors,{unknown_delivery_history:'旧队列的历史回传次数无法确认，已保留并暂停。请核对后明确点击重试待回传。',executor_mismatch:'任务仍绑定另一执行设备。请先在原设备安全释放。',legacy_executor_required:'旧版任务已经开始访问，请由原设备完成或停止，不可直接接管。',explicit_recovery_required:'任务已释放，请使用任务列表中的检查点恢复按钮。',lease_expired_requires_release:'租约已过期，请原设备对账并安全释放后再恢复。',checkpoint_gap:'仍有未处理条目未进入检查点，已停止以免遗漏。',checkpoint_regression:'检查点进度发生回退，已停止。',checkpoint_missing_receipts:'已有入库回执尚未全部计入检查点，暂不能交接。',identity_verification_required:'未核验当前平台登录账号，请打开账号页完成本人登录后核对。'});
  Object.assign(errors,{invalid_overlap_window:'周期窗口须覆盖48小时重叠加更新间隔。请明确增大窗口，不会自动扩大授权。',incomplete_window_outside_authorization:'上次中断或重叠范围超出当前授权窗口，已停止。请核对后明确扩大窗口并重新启动。'});
  Object.assign(errors,{source_not_found:'页面明确提示内容不存在，已记录不可访问；不会据此推断作者删除。',source_private:'页面明确提示内容为私密或无权访问，未继续采集。',source_deleted:'页面明确提示该内容已被删除，已有历史记录保留。',parser_paused:'同平台同类解析故障已出现2次，已暂停。修复解析器后请明确恢复该平台。'});
  errors.observed_only='已完成本轮可见范围观察，不代表全量覆盖';
  const metricNames={like_count:'点赞',collect_count:'收藏',comment_count:'评论',view_count:'播放/阅读',share_count:'分享',danmaku_count:'弹幕'};
  const phaseNames={idle:'等待任务',open:'准备导航',discover:'发现内容',detail:'采集详情',comments:'采集评论',next:'选择下一条',finish:'保存完成状态'};
  const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=String(text);return n;};
  const button=(text,fn)=>{const b=node('button',text);b.type='button';b.onclick=()=>act(fn);return b;};
  async function cmd(type,extra={}){const r=await chrome.runtime.sendMessage({type,...extra});if(!r?.ok)throw Error(r?.error||'backend_unavailable');if(r.data?.error)throw Error(r.data.error);return r.data;}
  async function rpc(action,payload={}){return cmd('kol_rpc',{action,payload});}
  function message(text){el('message').textContent=text;}
  async function act(fn){
    if(busy)return;busy=true;el('section').querySelectorAll('button').forEach(b=>b.disabled=b.id!=='kol_stop');
    try{message('');await fn();await refresh();}catch(e){message(errors[e.message]||e.message);}
    finally{busy=false;el('section').querySelectorAll('button').forEach(b=>b.disabled=false);el('import').disabled=!preview.some(r=>r.status==='valid');}
  }
  async function refresh(){
    const ticket=++refreshVersion,data=await cmd('kol_state');if(ticket!==refreshVersion)return;
    local=data.local||{};remote=data.remote||{};if(remote.error)throw Error(remote.error);
    render();
  }
  function settings(target_id){
    const number=(id,min,max)=>{const v=Number(el(id).value);if(!Number.isInteger(v)||v<min||v>max)throw Error('请检查任务数量、窗口和更新间隔');return v;};
    if(el('mode').value==='periodic'){const required=Math.ceil(2+number('interval',60,10080)/1440);if(number('window',1,365)<required)throw Error('当前更新间隔加48小时重叠需要至少'+required+'天窗口。请明确调整，系统不会自动扩大你的范围。');}
    return {target_id,mode:el('mode').value,window_days:number('window',1,365),max_items:number('limit',1,10),comment_limit:number('comments',0,20),comment_depth:number('depth',1,2),max_comment_pages:5,interval_minutes:el('mode').value==='periodic'?number('interval',60,10080):0};
  }
  function render(){
    el('status').replaceChildren();
    const fields={'执行':local.enabled?'已开启':'已停止','阶段':phaseNames[local.phase]||local.phase||'等待任务','本地待回传':Number(local.outbox)||0,'待处理':Number(local.rejected)||0,'最近显示的已收实体':remote.contents?.length||0,'账号核对':local.principal_bound?'已绑定本次任务身份':'普通公开采集；未绑定已核对身份','最近提示':errors[local.last_error]||local.last_error||'无','下一次调度':local.enabled?local.next_at?time(local.next_at):'等待调度':'需本人继续'};
    for(const [k,v]of Object.entries(fields))el('status').append(node('dt',k),node('dd',v));
    if(local.outbox)el('status').append(button('重试待回传（最多3次）',()=>cmd('kol_retry_delivery')));
    for(const platform of local.parser_paused||[])el('status').append(button('解析器修复后恢复 '+platform,async()=>{if(confirm('确认已修复 '+platform+' 的解析问题？恢复只清解析暂停，不清访问预算；仍需点击继续任务。'))await cmd('kol_resume_parser',{platform});}));
    el('status').append(button('停止并安全释放给另一设备',async()=>{await cmd('kol_release');message('原设备已释放。只有检查点与全部回执确认后，其他设备才能恢复。');}));
    el('targets').replaceChildren();
    for(const target of remote.targets||[]){
      if(target.status==='deleted')continue;
      const card=node('article');card.append(node('strong',target.label||target.target_id),node('small',`${target.platform} · ${target.target_kind} · ${target.status} · ${target.group||'未分组'}`));
      const link=node('a',target.url);link.href=U.target(target.url).canonical_url;link.target='_blank';link.rel='noopener noreferrer';card.append(link);
      const publicProfile=(remote.profiles||[]).find(p=>p.target_ref===target.id);
      if(publicProfile){const profile=publicProfile.profile||{};const counts=Object.entries(profile.metrics||{}).map(([k,v])=>({followers:'公开粉丝数',notes:'公开作品数',likes_collected:'获赞/收藏'}[k]||k)+'：'+(v?.value==null?'未取得':String(v.value))+(v?.status==='approximate'?'（约数）':''));card.append(node('p',counts.join(' · ')),node('small','主页观察：'+time(publicProfile.received_at)+'；不是粉丝人口画像。'));}
      card.append(node('p',target.interval_minutes?'每 '+target.interval_minutes+' 分钟；下次 '+time(target.next_due_at):'仅手动任务'));
      card.append(node('small','最近尝试扫描：'+time(target.last_attempted_scan)+'；最近完整覆盖：'+(target.last_complete_coverage?time(target.last_complete_coverage):'未取得；DOM分页仅部分覆盖')));
      if(target.scan_block_reason)card.append(node('p',errors[target.scan_block_reason]||target.scan_block_reason));
      card.append(button('按当前设置采集',async()=>{if(target.status==='paused')await cmd('kol_resume',{payload:{target_id:target.id}});await cmd('kol_start',{payload:settings(target.id)});message('任务已提交，按服务端预算执行。');}));
      card.append(button(target.status==='paused'?'恢复目标':'暂停目标',()=>cmd(target.status==='paused'?'kol_resume':'kol_stop',{payload:{target_id:target.id},target_id:target.id})));
      card.append(button('移除跟踪（保留内容）',async()=>{if(confirm('停止跟踪此目标？已经收到的内容仍保留。'))await cmd('kol_delete_target',{payload:{target_id:target.id}});}));
      el('targets').append(card);
    }
    if(!el('targets').children.length)el('targets').append(node('p','尚无目标。添加链接不会自动启动采集。'));
    el('tasks').replaceChildren();
    for(const t of remote.tasks||[]){const card=node('article');card.append(node('strong',t.state||t.status||'等待'),node('p',`详情尝试 ${typeof t.attempts==='object'?t.attempts.detail??0:t.attempts??0}/${t.max_items??'—'} · 收到 ${t.received??0} · ${t.mode||'manual'}`),node('small',`创建 ${time(t.created_at)} · ${errors[t.reason]||t.reason||'尚未完成'}`));if(t.released_at)card.append(button('从检查点恢复到本设备',()=>cmd('kol_recover',{task:t.id})));el('tasks').append(card);}
    renderContents();
    const depth2=el('depth').querySelector('[value="2"]');depth2.disabled=remote.capabilities?.include_replies===false;if(depth2.disabled)el('depth').value='1';
  }
  function renderContents(){
    el('contents').replaceChildren();
    const field=el('sort').value==='published'?'published_at':'last_seen_at';
    const rows=[...(remote.contents||[])].sort((a,b)=>(Date.parse(b[field])||0)-(Date.parse(a[field])||0));
    for(const item of rows){
      const card=node('article'),title=node('a',item.title||'无标题');title.href=U.target(item.url).canonical_url;title.target='_blank';title.rel='noopener noreferrer';card.append(title);
      card.append(node('small',`${item.platform} · ${item.content_type||'公开内容'} · 作者 ${item.creator_id||'未取得'} · 正文版本 ${item.version??'未取得'}`));
      card.append(node('small',`源发布时间 ${time(item.published_at)} · 首次发现 ${time(item.first_seen_at)} · 最近采集 ${time(item.last_seen_at)}`));
      card.append(node('small',`来源 ${item.source_kind||'rendered_public_dom'} · 覆盖 ${item.coverage||'仅已观察内容'}`));
      card.append(node('pre',item.body||'正文未取得；视频未自动转写。'));
      const stats=node('dl');for(const key of Object.keys(metricNames)){const value=item.metrics?.[key],status=item.metrics?.observations?.[key]?.status;stats.append(node('dt',metricNames[key]),node('dd',value==null?'未取得':String(value)+(status==='approximate'?'（约数）':'')));}card.append(stats);
      if(item.comments){const details=node('details'),comments=item.comments.items||(Array.isArray(item.comments)?item.comments:[]),captured=Number.isInteger(item.comments.captured_count)?item.comments.captured_count:comments.length,reported=item.metrics?.comment_count;
        details.append(node('summary','评论样本（不代表全部评论）'),node('p',`本次样本 ${captured} 条；源站报告评论总数 ${reported==null?'未知':String(reported)}；已采回复 ${comments.filter(c=>c.parent_key||c.is_reply).length} 条。`),node('p','未采回复数量：未知。回复覆盖：仅当前已加载样本，不代表全部回复。'));
        for(const c of comments){details.append(node('p',(c.parent_key?'回复 '+c.parent_key+'：':'')+(c.content_type==='image'&&c.is_placeholder?'[可见图片评论，无文字]':c.text||c.body||'')));if(c.reported_reply_count!=null)details.append(node('small','源站该评论报告回复数：'+c.reported_reply_count+'；不代表这些回复已全部采到。'));}card.append(details);}
      const identity=item.platform+':'+item.content_id;
      card.append(button('查看版本与互动记录',async()=>{histories.set(identity,await rpc('detail',{platform:item.platform,content_id:item.content_id}));}));
      card.append(button('导出授权媒体任务',async()=>{
        const detail=await rpc('detail',{platform:item.platform,content_id:item.content_id});
        const latest=detail.content?.latest_record||[...(detail.versions||[])].sort((a,b)=>(b.version||0)-(a.version||0))[0]?.record;
        const assets=(latest?.extra?.media_refs||[]).filter(ref=>{try{const u=new URL(ref.url);return ['image','audio','video'].includes(ref.kind)&&u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.search&&!u.hash&&['xhscdn.com','xhsimg.com','hdslb.com'].some(host=>u.hostname===host||u.hostname.endsWith('.'+host));}catch{return false;}}).slice(0,2).map(({url,kind})=>({url,kind}));
        if(!assets.length)throw Error('当前DOM没有可供下载的公开媒体引用；blob、带凭据参数及未知域不会导出。');
        const authorization_ref=prompt('填写你对此内容下载/处理的授权依据（授权记录编号或说明）：')?.trim();if(!authorization_ref)throw Error('未提供授权依据，未导出。');if(authorization_ref.length>200)throw Error('授权依据最多200字。');
        if(!confirm('确认你有权下载并处理以下媒体？\n'+assets.map(x=>x.kind+' '+x.url).join('\n')))return;
        const value={schema_version:1,platform:item.platform,content_id:item.content_id,authorization_ref,assets};const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})),a=node('a');a.href=url;a.download='crowd-media-'+item.content_id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);message('已导出媒体任务。没有自动下载；本机 pipeline 默认仅下载，OCR/ASR需显式选取。');
      }));
      if(histories.has(identity))card.append(renderHistory(histories.get(identity)));
      card.append(button('删除此内容及派生记录',async()=>{if(confirm('删除此内容的正文、版本、指标和评论？这是独立于移除跟踪的删除操作。'))await cmd('kol_delete_content',{payload:{platform:item.platform,content_id:item.content_id}});}));
      el('contents').append(card);
    }
    if(!rows.length)el('contents').append(node('p','还没有服务端确认收到的内容。任务启动或页面打开不等于采集成功。'));
  }
  function renderHistory(data){
    const details=node('details');details.open=true;details.append(node('summary','版本 / 互动趋势 / 评论 / 派生证据'));
    for(const v of data.versions||[]){const part=node('details');part.append(node('summary',`正文版本 ${v.version} · ${time(v.created_at)}`),node('strong',v.record?.standard?.title||'无标题'),node('pre',v.record?.evidence?.text||'未取得正文'));details.append(part);}
    if(data.metric_snapshots?.length){
      const table=node('table'),head=node('tr');for(const text of ['采集时间','点赞','收藏','评论','播放/阅读'])head.append(node('th',text));table.append(head);
      for(const snap of data.metric_snapshots){const row=node('tr');row.append(node('td',time(snap.captured_at)));for(const key of ['like_count','collect_count','comment_count','view_count'])row.append(node('td',snap.metrics?.[key]==null?'未取得':String(snap.metrics[key])+(snap.metrics?.observations?.[key]?.status==='approximate'?'（约）':'')));table.append(row);}details.append(table);
    }
    if(data.comment_entities?.length){const section=node('details');section.append(node('summary',`已识别评论 ${data.comment_entities.length} 条（按平台评论ID去重）`));for(const c of data.comment_entities)section.append(node('p',(c.parent_comment_id?'回复：':c.relationship_status==='orphan'?'父评论未取得：':'')+(c.body||'')));details.append(section);}
    const samples=(data.comments||[]).filter(c=>!c.comment_id);if(samples.length){const section=node('details');section.append(node('summary',`无稳定ID的评论样本 ${samples.length} 条（可能重复，不代表全部评论）`));for(const c of samples)section.append(node('p',(c.parent_key?'回复：':'')+(c.body||c.text||'')));details.append(section);} 
    for(const item of data.evidence||[]){const e=item.evidence||{},section=node('details');section.append(node('summary',({ocr:'图片OCR',transcript:'获授权字幕/转录',demographics:'授权汇总画像'}[item.kind]||item.kind)+' · '+time(item.created_at)),node('p','授权引用：'+item.authorization_ref+'；用户声明，尚未独立核实。'));
      if(e.raw_text)section.append(node('pre',e.raw_text));if(e.truncated)section.append(node('p','结果发生截断，不代表文件全文。'));
      if(item.kind==='ocr')section.append(node('p','文字识别结果未作事实或价格语义核验；不得直接解释为客单价。'));
      if(item.kind==='demographics'){section.append(node('p',`总体 ${e.population} · 维度 ${e.dimension} · 样本 ${e.sample_size} · 时段 ${e.coverage_period}`));for(const [key,value]of Object.entries(e.aggregate_values||{}))section.append(node('p',key+'：'+value));}
      details.append(section);
    }
    return details;
  }
  el('add').onsubmit=e=>{e.preventDefault();act(async()=>{const t=U.target(el('url').value);await cmd('kol_upsert',{payload:{url:t.local_url,label:el('label').value.trim(),group:el('group').value.trim()}});el('url').value='';message('目标已保存，点击对应目标的采集按钮开始。');});};
  el('csv').onchange=()=>act(async()=>{const f=el('csv').files[0];if(!f)return;if(f.size>100000)throw Error('CSV上限100KB');preview=U.csv(await f.text());const existing=new Set((remote.targets||[]).filter(t=>t.status!=='deleted').map(t=>U.target(t.url).canonical_url));for(const r of preview)if(r.status==='valid'&&existing.has(r.canonical_url))r.status='duplicate';el('preview').replaceChildren(...preview.map(r=>node('p',`第${r.row}行 · ${r.status==='valid'?'可保存':r.status==='duplicate'?'重复':'无效'} · ${r.display_name||r.canonical_url||''} ${r.error||''}`)));});
  el('import').onclick=()=>act(async()=>{let saved=0;for(const row of preview){if(row.status!=='valid')continue;try{await cmd('kol_upsert',{payload:{url:row.local_url,label:row.display_name,group:row.group}});row.status='saved';saved++;}catch(e){row.error=errors[e.message]||e.message;break;}}el('preview').replaceChildren(...preview.map(r=>node('p',`第${r.row}行 · ${r.status} · ${r.error||r.canonical_url||''}`)));message(`已保存${saved}个目标；失败/未提交项保留，可重试。`);});
  el('refresh').onclick=()=>act(refresh);el('stop').onclick=async()=>{try{await cmd('kol_stop');await refresh();message('已停止新访问，保留合法待回传记录。');}catch(e){message(errors[e.message]||e.message);}};
  el('continue').onclick=()=>act(()=>cmd('kol_start'));
  el('open_session').onclick=()=>act(()=>cmd('kol_open_session',{platform:el('account_platform').value}));
  el('session').onclick=()=>act(async()=>{await cmd('kol_session_changed',{platform:el('account_platform').value});message('已核对平台账号导航并取消旧任务。请从名单创建新任务；待回传记录保留。');});
  el('sort').onchange=renderContents;
  el('evidence_file').onchange=()=>act(async()=>{
    const file=el('evidence_file').files[0];if(!file)return;if(file.size>200000)throw Error('证据文件上限200KB');
    const parsed=JSON.parse(await file.text());const rows=Array.isArray(parsed)?parsed:[parsed];
    if(rows.length<1||rows.length>2)throw Error('每次导入1–2份证据');
    for(const row of rows){if(!['ocr','transcript','demographics'].includes(row.kind)||typeof row.authorization_ref!=='string'||!row.authorization_ref.trim()||row.evidence?.source_kind!=='authorized_local_file')throw Error('证据类型或授权引用缺失');}
    derivedPreview=rows;el('evidence_preview').textContent=rows.map(r=>`${r.platform} / ${r.content_id} · ${r.kind} · 授权引用 ${r.authorization_ref}`).join('\n');el('evidence_import').disabled=false;
  });
  el('evidence_import').onclick=()=>act(async()=>{
    if(!derivedPreview.length)throw Error('先选择证据JSON');
    if(!el('evidence_agree').checked)throw Error('请确认文件授权和来源');
    while(derivedPreview.length){await rpc('attach_evidence',derivedPreview[0]);derivedPreview.shift();}
    el('evidence_preview').textContent='导入完成；在对应内容的版本与互动记录中查看。';histories.clear();
  });
  async function download(format){
    const data=await cmd('kol_export',{payload:{limit:500}});
    if(format==='json'&&typeof U.qualitySummary==='function')data.quality_summary=U.qualitySummary(data.contents||[]);
    const text=format==='json'?JSON.stringify(data,null,2):U.csvExport((data.contents||[]).map(c=>({platform:c.platform,content_id:c.content_id,title:c.title,url:c.url,published_at:c.published_at,first_seen_at:c.first_seen_at,last_seen_at:c.last_seen_at,version:c.version,metrics:c.metrics,coverage:data.coverage||'observed_only'})));
    const url=URL.createObjectURL(new Blob([text],{type:format==='json'?'application/json':'text/csv;charset=utf-8'})),a=node('a');a.href=url;a.download='crowd-kol-observations.'+format;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    message(format==='json'?'JSON包含本次导出样本的字段可用率与评论采样指标，不代表平台总体。':'CSV保留内容字段；字段可用率与采样指标请另选JSON导出。');
  }
  for(const format of ['json','csv'])el('export_'+format).onclick=()=>act(()=>download(format));
  refresh().catch(e=>message(errors[e.message]||e.message));
  setInterval(()=>{if(!document.hidden&&!busy)refresh().catch(e=>message(errors[e.message]||e.message));},10000);
})();

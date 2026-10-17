'use strict';
const $ = id => document.getElementById(id);
let current, viewTicket = 0, actions = 0, consentScope;
let consentDraft=false;
$('agree').onchange=()=>{consentDraft=$('agree').checked;};
const ratingDrafts = new Map();
const labels = {parallel:'并行采集笔记详情',idle: '等待任务', search: '自动搜索', search_done: '选择下一篇笔记', note: '浏览与采集', reopen_note: '恢复笔记浏览', enrich:'补充评论与作者资料'};
// Desktop extension diagnostics are explicit and separate from collection consent.
$('diagnostics_section').hidden = !!globalThis.CrowdNative;
$('updater_section').hidden = !!globalThis.CrowdNative;
$('profiles_section').hidden = !!globalThis.CrowdNative;
const errors = {test_comments_partial:'已停止：正文已完成，评论覆盖请查看下方状态',invalid_invite: '邀请无效，请重新打开邀请链接', invite_expired: '邀请已过期，请联系邀请人', invite_full: '本批参与名额已满', installation_already_joined: '本设备已加入另一批邀请，请继续原参与身份', portal_not_configured: '安装包尚未接通参与入口', release_not_ready: '此设备的正式安装渠道尚未开放', backend_unavailable: '暂时连接不上，请稍后重试，已有进度会保留', consent_required: '请先确认自愿参与', approval_required: '账户尚未获得中台审核批准', login_required: '请在下方或工作页面登录小红书后继续', captcha: '遇到验证，请在工作页面处理', rate_limit: '平台已限流，已暂停', user_stopped: '已停止', logged_out: '已退出', system_suspended: '系统暂停或本次批次结束，进度已保存，可重新启动', lease_lost: '任务已由其他设备领取，证据保留待审'};
Object.assign(errors, {
  invite_required:'参与邀请尚未接续。请打开邀请人发来的原邀请页面，点击「已安装，继续」；也可以在这里粘贴原邀请链接。',
  identity_recovery_required:'检测到原参与身份或采集进度，但当前会话缺失。原记录保留，请联系邀请人恢复原身份；不要重新报名或卸载。',
  participant_already_joined:'此浏览器已有参与会话，请继续原参与身份，无需再次报名。',
  parallel_unavailable:'当前安装渠道尚未通过并行采集升级检查，请使用单页采集。',
  identity_verification_required:'尚未确认小红书原账号。请打开原工作页并登录原账号；核验成功后会按原运行意图继续。',
  platform_identity_changed:'当前小红书账号与原账号不同，已暂停。请切回原账号，原任务和记录保留。',
  pool_recovery_required:'并行工作页状态需要核对，已停止新访问，原记录保留。',
  executor_busy:'请先停止并完成待回传记录，再更改设置。',
  user_login: '已暂停并打开小红书工作页；处理完成后，回到这里点击「继续采集」。',
  backend_login_required: '中台参与会话需要恢复，采集与回传已暂停，原进度保留。请联系邀请人恢复原参与身份；不要重新报名或卸载插件。',
  backend_permission_denied: '中台未允许此操作，采集与回传已暂停。原身份和进度保留，请联系邀请人检查参与权限。',
  legacy_migration_required: '检测到旧版参与身份与未迁移进度，请保留原插件并联系邀请人接续。不要卸载或重新报名；本版本不会覆盖旧任务和待回传记录。',
  unrelated_note: '笔记正文/标题未匹配任务相关性要求（unrelated_note）',
  invalid_record: '记录字段未通过服务端校验（invalid_record）',
  invalid_published_date: '发布日期不符合格式（invalid_published_date）',
  invalid_timestamp: '采集时间超出允许范围（invalid_timestamp）',
  invalid_envelope: '提交信息不完整（invalid_envelope）',
  request_reused: '同一请求的内容发生变化（request_reused）',
  task_full: '任务已达目标（task_full）'
});
async function send(type, extra = {}) {
  const reply = globalThis.CrowdNative ? await CrowdNative.command(type, extra) : await chrome.runtime.sendMessage({type, ...extra});
  if (!reply.ok) throw new Error(reply.error); return reply.data;
}
errors.update_in_progress = '插件正在更新，完成后会自动恢复原状态。你仍可停止采集。';
errors.navigation_failed = '浏览器未能执行搜索或详情跳转，已停止。原工作页与证据保留，请查看采集页面；不会自动重试消耗访问次数。';
errors.navigation_uncommitted = '工作页仍为空白，跳转在等待期限内未完成，已停止。原页面与证据保留；不会自动重试消耗访问次数。';
errors.page_timeout = '采集页面准备超时，已停止新访问并保留工作页；不会自动重新搜索。';
errors.risk_report_unknown='风险回报结果尚未确认；已停止新访问，不会自动重复上报。';
errors.risk_confirmation_required='请先勾选已观察到访问频繁300013。';
errors.risk_confirmation_unavailable='当前身份或失败批次不符合风险确认条件。';
errors.page_loading = '采集页在等待期限内仍未就绪，已停止新访问并保留工作页。不会自动重新搜索；诊断开启时由中台排查。';
errors.content_unavailable = '页面已结束加载，但采集脚本未响应，已停止新访问。请检查浏览器是否允许此插件访问小红书。';
errors.probe_timeout = '采集页面没有及时响应，已停止新访问并保留工作页；不会自动重新搜索。';
errors.page_mismatch = '当前页面搜索词与任务不一致，已暂停。点击继续会重新打开任务页面。';
errors.task_full = '该任务已满，正在自动领取下一项。';
errors.daily_quota = '今日配额已满，已有证据保留，稍后自动重试。';
errors.unsupported_platform = '此任务的平台尚未接入当前版本，已暂停，请等待平台支持更新。';
errors.work_page_missing = '采集页面尚未打开，请先开始或继续任务。';
errors.verification_page_unknown = '核验页面或任务领取的结果尚未确认，原记录保留。请联系邀请人核对；不要重复安装或报名。';
errors.task_reconciliation_required = '原任务或未回传操作需要核对，已保留全部进度，暂不领取替代任务。';
errors.task_archive_conflict = '原任务归档需要核对，当前任务与记录均保留。';
errors.no_task = '当前没有可领取任务，等待中心分配后自动继续。';
errors.invite_full = '此邀请的名额已占用。已参加过请回到原浏览器和个人资料继续，更新无需重新报名；不要卸载插件。';
Object.assign(errors, {
  invalid_receipt: '中台回执不完整，证据仍保留在本机，正在重试。',
  control_unavailable: '安全配置暂时无法确认，已暂停新访问；已有证据会保留。',
  global_pause: '管理者已暂停采集，恢复后会自动继续。',
  action_budget: '今天的访问次数已用完，明天自动继续。',
  action_gap: '正在等待下一次访问。', session_rest: '本轮访问结束，正在休息。',
  known_note: '这篇笔记已经回收，正在选择下一篇。', note_busy: '这篇笔记正由其他参与者采集，正在选择下一篇。'
});
async function refresh() {
  const ticket = ++viewTicket;
  const data = await send('state'), s = data.agent, p = data.status;
  if (ticket !== viewTicket) return;
  current = data;
  renderProgress(data);
  const updates={ready:'更新助手已接通',applied:'新版已加载',current:'已是当前发布版本',checking:'正在检查和验证更新',pending_reload:'文件已更新，等待插件重载',helper_unavailable:'尚未接通本机更新助手',error:'本次更新未完成，原记录保留',rolled_back:'更新失败，已恢复原文件'};
  $('auto_update').checked=data.updater?.enabled!==false;
  $('auto_update').disabled=!!data.updater?.busy;
  const updateDeferred=data.updater?.state==='error'&&data.updater?.error==='executor_busy';
  $('updater_status').textContent=(updateDeferred?'当前操作进行中，稍后自动检查更新':updates[data.updater?.state]||'更新状态尚未确认')+(!updateDeferred&&data.updater?.error?'（'+data.updater.error+'）':'')+(data.updater?.system_ota?'；系统定时 OTA 已接通':'；系统定时 OTA 尚未接通')+(data.updater?.last_poll_at?'；系统最近检查 '+new Date(data.updater.last_poll_at*1000).toLocaleString('zh-CN'):'；系统尚无检查记录')+(data.updater?.poll_status==='downloaded'?'；新版已验证缓存，等待空闲切换':'')+(data.updater?.poll_error?'；系统更新失败（'+data.updater.poll_error+'）':'')+(data.updater?.poll_query_error?'；系统状态暂时不可查':'')+(data.updater?.poll_stale?'；超过2小时未收到系统检查，请检查更新助手':'');
  $('risk_confirmation').hidden=!data.risk_confirmation?.can_confirm&&!data.risk_confirmation?.source;
  $('risk_confirm').disabled=!data.risk_confirmation?.can_confirm||!$('risk_acknowledge').checked||actions>0;
  $('risk_evidence').textContent=data.risk_confirmation?.source==='operator_confirmation'?'风险证据：操作员确认；仅暂停上报，不是当前页面元数据或恢复证明。':'';
  renderControls();
  $('profiles').checked=s.profiles===true;
  $('profiles').disabled=!!data.legacy_installation || !data.session || actions>0;
  $('welcome').textContent = errors[p.error] || errors[s.last_error] || (s.enabled ? (s.phase === 'idle' ? '自动任务已开启，正在等待下一步。' : '自动任务执行中，你可以随时停止。') : data.session ? '参与身份已就绪，可点击继续；无需再次报名。' : data.invited ? '邀请已接续，请确认是否参与。' : '请从邀请链接打开，无需注册中台账号。');
  if(!data.session && !data.legacy_installation)$('welcome').textContent=data.entry_state==='identity_recovery_required'?errors.identity_recovery_required:data.invited?'邀请已接续，请确认是否参与。':errors.invite_required;
  const platform=data.platform_session;
  if(platform?.pending&&platform.wait_until&&!p.error)$('welcome').textContent=(errors[platform.reason]||'服务端暂缓访问')+' 原任务保留，'+new Date(platform.wait_until).toLocaleString('zh-CN')+'后自动重新核验，无需重复点击。';
  else if(platform?.pending&&platform.desired_running&&!p.error)$('welcome').textContent=platform.reason==='platform_identity_changed'?'当前登录账号与原账号不同，已暂停。请切回原账号；原任务和记录保留。':platform.reason==='login_required'?'小红书已退出登录，采集暂停、原任务保留。请登录原账号；核验后自动继续。':'正在核验小红书原账号，采集暂停、原任务保留。核验通过后自动继续。';
  else if(platform?.initial_confirmed_at&&s.enabled&&!s.last_error&&!p.error)$('welcome').textContent='首次登录已确认，继续已同意的原任务。';
  else if(platform?.recovered_at&&s.enabled&&!s.last_error&&!p.error)$('welcome').textContent='原账号登录已恢复，继续上次任务。';
  const pilotWaiting=s.enabled && s.pilot_waiting===true && s.pilot_phase==='awaiting_acceptance';
  if(pilotWaiting)$('welcome').textContent='两条验收已回传，等待实验启动，之后自动继续。';
  $('start').hidden = !data.session || data.legacy_installation;
  $('first_diagnostics_label').hidden = !!data.session;
  $('consent').textContent = data.session ? '同意并继续' : '同意并开始';
  const fields = {'插件版本': CrowdCore.VERSION, '中台账户': p.error === 'backend_login_required' ? '需要恢复' : p.error === 'backend_permission_denied' ? '权限待核对' : data.session ? '已登录' : '未登录', '参与状态': p.participant?.status || p.error || '尚未报名', '自动执行': s.enabled ? '已开启' : '已停止', '当前阶段': s.phase === 'idle' && s.task ? '准备执行任务' : labels[s.phase] || s.phase,
    '任务': s.task?.query || '暂无', '服务端接收': p.received ?? '—', '核验有效': p.verified ?? '—', '已记奖励': p.reward_fen == null ? '—' : '¥' + (p.reward_fen / 100).toFixed(2), '累计余数': p.remainder ?? '—', '待回传 / 待处理': s.outbox.length + ' / ' + s.rejected.length, '最近待处理原因': s.rejected.length ? (errors[s.rejected.at(-1).reason] || s.rejected.at(-1).reason) : '无', '最早下一步': !s.enabled ? data.platform_session?.pending&&data.platform_session.desired_running?(data.platform_session.wait_until?new Date(data.platform_session.wait_until).toLocaleString('zh-CN')+'后自动重新核验':'等待原账号核验，成功后自动继续'):'已停止，不会自动执行' : s.next_at > Date.now() ? new Date(s.next_at).toLocaleString('zh-CN') : '等待调度', '今日访问': s.control ? Object.entries(s.control.counts).map(([k,v]) => ({search:'搜索',detail:'详情',comment:'评论展开',scroll:'滚动'})[k] + ' ' + v + '/' + s.control.caps[k]).join('，') : '尚未同步', '最近提示': errors[s.last_error] || s.last_error || '无'};
  const node=data.node_monitor||{},nodeID=typeof node.installation_id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(node.installation_id)?node.installation_id:null;
  const registeredAt=Number.isSafeInteger(node.last_registered_at)&&node.last_registered_at>0&&node.last_registered_at<=Date.now()?node.last_registered_at:null;
  fields['本设备安装编号']=nodeID||'尚未确认；请保留原参与身份，不要重新报名';
  fields['最近设备登记确认']=registeredAt?new Date(registeredAt).toLocaleString('zh-CN'):'本次插件运行尚未确认';
  const nodeErrors={backend_login_required:'中台会话需要恢复，原身份保留',login_required:'中台会话需要恢复，原身份保留',invalid_node_registration:'登记响应未通过校验',cancelled:'登记上下文已变更',node_register_unavailable:'设备登记暂未确认'};
  fields['设备连接诊断']=((typeof node.registration_error==='string'&&Object.prototype.hasOwnProperty.call(nodeErrors,node.registration_error)?nodeErrors[node.registration_error]:null)|| (node.state==='backend_upgrade_required'?'原中央登记接口尚未兼容':registeredAt?'上次登记已确认':'等待登记确认'))+(node.error==='telemetry_unavailable'?'；步骤回传暂未确认':'')+'；仅设备登记，不代表平台登录或新采集回执';
  if(pilotWaiting){fields['自动执行']='已启用，等待实验启动';fields['当前阶段']='两条验收已回传';fields['最早下一步']='实验启动后自动继续，无需再次点击';fields['最近提示']='等待实验启动；只检查运行状态，不访问采集来源。';}
  if(pilotWaiting){
    const notice={login_required:'小红书已退出登录，请在原窗口登录原账号。',platform_identity_changed:'当前小红书账号已改变，请切回原账号。',captcha:'小红书需要本人完成验证。',rate_limit:'小红书已限流，请按原页面提示处理。'}[platform?.platform_reason];
    if(notice){fields['平台账号']=notice;$('welcome').textContent='两条验收已回传，等待实验启动。'+notice;}
  }
  if(platform?.verification_stage){
    const label={intent:'正在准备恢复页面连接',claiming:'正在确认本次任务领取结果',admitting:'正在确认访问准入',opening:'正在确认新核验页是否已打开',waiting:errors[platform.verification_error]||'等待服务端准入',opened:platform.platform_reason==='login_required'?'请在新核验页登录原账号':'已打开自有核验页，正在确认原账号',confirmed:platform.verification_manual?'原账号核验通过；此登录操作不领取任务':'原账号核验通过，已接续本次任务',blocked:errors[platform.verification_error]||'核验暂时不能继续'};
    fields['页面连接']=label[platform.verification_stage]||'原核验记录保留';
    if(platform.verification_stage==='confirmed'&&platform.verification_manual&&platform.platform_reason)fields['页面连接']=errors[platform.platform_reason]||'原账号需要重新核验';
  }
  if(platform?.task_closure==='acknowledged')fields['上轮任务']='已获云端完成回执；未完成补充内容原样归档';
  if(!data.session && !data.legacy_installation){fields['最近提示']=data.entry_state==='identity_recovery_required'?errors.identity_recovery_required:data.invited?'请确认参与后开始。':errors.invite_required;if(data.entry_state==='identity_recovery_required'){fields['中台账户']='原参与身份待恢复';fields['参与状态']='原数据保留，暂不重新报名';}}
  if(data.legacy_installation)Object.assign(fields,{'中台账户':'旧版参与身份（待接续）','参与状态':'旧版数据原样保留','任务':'请在原版查看','待回传 / 待处理':'请在原版查看','最近提示':errors.legacy_migration_required});
  $('status').replaceChildren();
  if(!s.enabled&&s.last_error==='rate_limit'&&data.recovery?.gate==='waiting'){fields['最早下一步']=data.recovery.reason==='attempt_active'?'正在自动检查恢复状态':data.recovery.wait_ms>0?new Date(Date.now()+data.recovery.wait_ms).toLocaleString('zh-CN')+' 后自动检查一次':'等待自动恢复检查';fields['最近提示']='限流期间停止采集；确认恢复后自动继续本批，完成后自动停止。';}
  fields['后台回传'] = s.delivery_error ? (errors[s.delivery_error] || s.delivery_error) : s.outbox.length && (s.enabled || s.delivery_enabled) ? '已有记录会继续回传' : '无待发送记录或已停止回传';
  const coverage=s.comment_coverage?.filter(item=>item.visible_complete && !item.complete);
  if(coverage?.length)fields['评论覆盖'] = coverage.map(item=>'当前可见 '+item.captured+' 条已采尽；页面声明 '+item.reported+' 条，差额 '+item.count_gap+' 条原因未确认。').join('\n');
  for (const [name, value] of Object.entries(fields)) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = name; dd.textContent = String(value); $('status').append(dt, dd); }
  const scope=data.consent_scope || (data.session?'native-session':'signed-out');
  if(scope!==consentScope){consentScope=scope;consentDraft=false;}
  if(s.consent===CrowdCore.CONSENT)consentDraft=false;
  $('agree').checked=s.consent===CrowdCore.CONSENT || consentDraft;
  $('diagnostics').checked = data.diagnostics?.enabled === true;
  $('diagnostics').disabled = !data.session || actions > 0;
  $('diagnostics_status').textContent = data.diagnostics?.pending_clear ? '诊断已关闭；联网后清除云端旧状态。' : data.diagnostics?.error ? '诊断暂未送达，联网后自动重试，不影响采集。' : data.diagnostics?.sent_at ? '最近诊断送达：' + new Date(data.diagnostics.sent_at).toLocaleTimeString('zh-CN') : data.diagnostics?.enabled ? '诊断已开启，正在准备发送。' : '诊断未开启。';
}
function renderControls() {
  const data=current,s=data?.agent;
  if(!s)return;
  const local=!globalThis.CrowdNative && data.parallel_allowed;
  $('parallel_section').hidden=!local;
  $('test_section').hidden=!data.local_test && !local && !s.test_run;
  $('local_test_updates_label').hidden=!data.local_test;
  $('local_test_updates').checked=data.local_test_updates?.enabled===true;
  $('local_test_updates').disabled=actions>0 || !data.session || !data.local_test;
  const recovery=data.entry_state==='identity_recovery_required';
  $('consent_section').hidden=!!data.legacy_installation || recovery || !data.session&&!data.invited || !!data.session && s.consent===CrowdCore.CONSENT;
  $('consent').disabled=actions>0 || recovery || !data.session&&!data.invited;
  $('invitation').hidden=!!data.legacy_installation || recovery || !!data.session;
  if(!data.session&&!data.invited&&!recovery)$('invitation').open=true;
  $('open_login').disabled=actions>0 || !data.session;
  $('signup').hidden=recovery || !!data.session;
  const desired=data.parallel_requested || s.parallelism || 1,actual=s.parallelism || 1;
  $('parallelism').value=String(desired);
  $('parallelism').disabled=actions>0 || !data.session || !local;
  const waits=[];
  if(s.outbox.length)waits.push(s.outbox.length+' 条待回传');
  if(s.work_slots?.length)waits.push(s.work_slots.length+' 个工作页');
  if(s.enrichment)waits.push('当前笔记补充内容');
  if(s.enabled && !['idle','search_done'].includes(s.phase) && !waits.length)waits.push('当前页面');
  $('parallel_hint').textContent=desired===actual?'当前同时采集 '+actual+' 篇。可随时保存设置，当前笔记收尾后切换。':'已保存 '+desired+' 篇；当前 '+actual+' 篇。'+(waits.length?'等待'+waits.join('、')+'收尾后切换。':'将在下一次调度前切换。');
  const run=s.test_run,expired=run && Number.isFinite(run.expires_at) && Date.now()>=run.expires_at;
  const running=run && ['waiting','active'].includes(run.state) && (!expired || s.enabled);
  $('test_start').disabled=actions>0 || !data.session || s.consent!==CrowdCore.CONSENT || !local || !!running;
  $('start').disabled=actions>0 || s.enabled || !!run;
  $('test_status').textContent=run?((running?(run.state==='waiting'?'正在等待旧记录收尾':'测试进行中'):expired && ['waiting','active'].includes(run.state)?'上次测试已过期，可开始新测试':(errors[run.reason] || '测试已停止'))+'；详情尝试 '+run.attempts+'/'+(run.limit??4)+'，有效新回执 '+run.accepted.length+'/'+(run.goal??2)+(s.outbox.length?'；待回传 '+s.outbox.length+' 条':'')+(run.finish_error?'；任务收尾尚待确认，已停止新访问':'')):'最多打开两篇新详情；完成后自动停止，15分钟或跨日结束。沿用现有配额，旧待回传记录先收尾。';
  $('risk_confirm').disabled=actions>0||!data.risk_confirmation?.can_confirm||!$('risk_acknowledge').checked;
  $('profiles').disabled=actions>0 || !data.session;
  $('diagnostics').disabled=actions>0 || !data.session;
  for(const id of ['start','open_login','consent','logout','export','auto_update','update_check','profiles','diagnostics'])if(data.legacy_installation)$(id).disabled=true;
}
Object.assign(errors,{test_completed:'本批测试已完成，已自动停止。',test_partial:'本批详情尝试已结束，已停止；有效回执不足目标。',test_expired:'测试已超时或跨日，已停止新访问，待回传证据保留。',test_quota:'今日剩余配额不足，测试已停止，不会等到明天继续。',test_no_task:'没有可领取任务，测试已停止。',test_new_run_required:'上次测试已结束；请点击「开始两篇测试」建立新批次。'});
Object.assign(errors,{invalid_rating:'请选择1–5星，并填写至少8个字的实际评价',rating_queued:'这条评分已在等待回传',invalid_anchor:'评分关联的笔记尚未收到或已被拒绝',already_rated:'这个任务已经评分',queue_full:'待回传记录已满，请先等待回传'});
function renderProgress(data) {
  const tasks=data.progress?.tasks || [], ratings=data.progress?.ratings || [];
  $('task_progress').hidden=!tasks.length;$('task_list').replaceChildren();
  for(const t of tasks){const li=document.createElement('li');li.textContent=t.query+'：已收到 '+t.received+'/'+t.target+'，其中本人 '+t.own_received+' 条';$('task_list').append(li);}
  $('ratings_section').hidden=!ratings.length;
  if($('ratings_list').contains(document.activeElement))return;
  $('ratings_list').replaceChildren();
  for(const r of ratings){
    const card=document.createElement('form'),title=document.createElement('strong'),note=document.createElement('p');
    title.textContent=r.subject;note.textContent='关联笔记：'+(r.title || r.note_id);card.append(title,note);
    const pending=data.agent.outbox.some(i=>i.kind==='rating'&&i.proof===r.proof_id);
    if(r.score!=null || pending){const p=document.createElement('p');p.textContent=r.score!=null?'已提交 '+r.score+' 星：'+r.reason:'评分已保存，等待回传';card.append(p);}
    else {
      const draft=ratingDrafts.get(r.proof_id)||{},select=document.createElement('select'),reason=document.createElement('textarea'),button=document.createElement('button');
      select.required=true;select.setAttribute('aria-label','选择星级');
      for(const value of ['',1,2,3,4,5]){const option=document.createElement('option');option.value=String(value);option.textContent=value?value+' 星':'请选择星级';select.append(option);}
      select.value=draft.score || '';reason.required=true;reason.maxLength=200;reason.setAttribute('aria-label','本人用餐评价');reason.placeholder='写下本人的实际用餐感受，至少8个字';reason.value=draft.reason || '';
      const saveDraft=()=>ratingDrafts.set(r.proof_id,{score:select.value,reason:reason.value});select.onchange=saveDraft;reason.oninput=saveDraft;
      button.textContent='提交评价';button.type='submit';card.append(select,reason,button);
      card.onsubmit=e=>{e.preventDefault();action(async()=>{await send('rating',{proof:r.proof_id,score:Number(select.value),reason:reason.value.trim()});ratingDrafts.delete(r.proof_id);button.blur();});};
    }
    $('ratings_list').append(card);
  }
}
async function action(fn) { ++actions; ++viewTicket; renderControls(); const buttons = [...document.querySelectorAll('button')]; buttons.forEach(b => b.disabled = b.id !== 'stop'); try { $('message').textContent = ''; if(fn)await fn(); await refresh(); } catch (e) { $('message').textContent = e.message === 'cancelled' ? '已取消启动' : errors[e.message] || e.message; } finally { --actions; buttons.forEach(b => b.disabled = actions > 0 && b.id !== 'stop'); renderControls(); } }
$('login').addEventListener('submit', e => { e.preventDefault(); action(() => send('login', {email: $('email').value, password: $('password').value}).then(() => { $('password').value = ''; })); });
$('signup').onclick = () => action(async () => { const r = await send('login', {email: $('email').value, password: $('password').value, signup: true}); $('password').value = ''; if (r.confirmation_required) $('message').textContent = '请到邮箱确认账户，再回来登录。'; });
$('consent').onclick = () => action(async () => { if(current?.entry_state==='identity_recovery_required')throw Error('identity_recovery_required'); if(!current?.session&&!current?.invited)throw Error('invite_required'); if (!$('agree').checked) throw new Error('consent_required'); if (current?.invited && !current.session) await send('join', {consent: CrowdCore.CONSENT,diagnostics:$('first_diagnostics').checked}); else { await send('consent'); await send('start'); } });
$('invite_form').onsubmit = e => { e.preventDefault(); action(async () => { await send('receive_invite', {invite: $('invite_value').value}); $('invite_value').value = ''; $('invitation').open = false; }); };
for (const type of ['start', 'stop', 'logout', 'open_login']) $(type).onclick = () => action(() => send(type));
$('export').onclick = () => action(async () => { const data = await send('export'), text = JSON.stringify(data, null, 2); if (globalThis.CrowdNative) { await CrowdNative.download(text); return; } const blob = new Blob([text], {type: 'application/json'}); const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = 'crowd-pending-evidence.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
$('refresh').onclick = () => action();
$('auto_update').onchange = () => action(()=>send('update_settings',{enabled:$('auto_update').checked}));
$('update_check').onclick = () => action(()=>send('update_check'));
$('diagnostics').onchange = () => action(() => send('diagnostics', {enabled: $('diagnostics').checked}));
$('parallelism').onchange=()=>{const value=Number($('parallelism').value);return action(()=>send('parallelism',{value}));};
$('test_start').onclick=()=>action(()=>send('test_start'));
$('local_test_updates').onchange=()=>{const enabled=$('local_test_updates').checked;return action(()=>send('local_test_updates',{enabled}));};
$('profiles').onchange = () => action(() => send('profiles',{enabled:$('profiles').checked}));
$('risk_acknowledge').onchange=()=>{$('risk_confirm').disabled=!current?.risk_confirmation?.can_confirm||!$('risk_acknowledge').checked||actions>0;};
$('risk_confirm').onclick=()=>action(()=>send('risk_confirm',{confirmed:$('risk_acknowledge').checked}));
$('inspect_work_page').onclick = () => action(() => send('inspect_work_page'));
action();
globalThis.addEventListener('crowd_invite', () => action());
setInterval(() => { if (!document.hidden && !actions) refresh().catch(() => {}); }, 5000);

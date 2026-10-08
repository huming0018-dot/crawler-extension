'use strict';
const $ = id => document.getElementById(id);
let current, viewTicket = 0, actions = 0;
const labels = {idle: '等待任务', search: '自动搜索', search_done: '选择下一篇笔记', note: '浏览与采集', reopen_note: '恢复笔记浏览', enrich:'补充评论与作者资料'};
// Desktop extension diagnostics are explicit and separate from collection consent.
$('diagnostics_section').hidden = !!globalThis.CrowdNative;
$('profiles_section').hidden = !!globalThis.CrowdNative;
const errors = {invalid_invite: '邀请无效，请重新打开邀请链接', invite_expired: '邀请已过期，请联系邀请人', invite_full: '本批参与名额已满', installation_already_joined: '本设备已加入另一批邀请，请继续原参与身份', portal_not_configured: '安装包尚未接通参与入口', release_not_ready: '此设备的正式安装渠道尚未开放', backend_unavailable: '暂时连接不上，请稍后重试，已有进度会保留', consent_required: '请先确认自愿参与', approval_required: '账户尚未获得中台审核批准', login_required: '请在下方或工作页面登录小红书后继续', captcha: '遇到验证，请在工作页面处理', rate_limit: '平台已限流，已暂停', user_stopped: '已停止', logged_out: '已退出', system_suspended: '系统暂停或本次批次结束，进度已保存，可重新启动', lease_lost: '任务已由其他设备领取，证据保留待审'};
Object.assign(errors, {
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
errors.page_timeout = '采集页面准备超时。连续失败三次会暂停，请查看采集页面并保持运行诊断开启。';
errors.page_loading = '小红书页面一直未完成加载。连续失败三次会暂停，请查看采集页面的网络提示。';
errors.content_unavailable = '页面已结束加载，但采集脚本未响应。请检查浏览器是否允许此插件访问小红书。';
errors.probe_timeout = '采集页面没有及时响应，可能卡住；连续失败三次会暂停。';
errors.page_mismatch = '当前页面搜索词与任务不一致，已暂停。点击继续会重新打开任务页面。';
errors.daily_quota = '今日配额已满，已有证据保留，稍后自动重试。';
errors.work_page_missing = '采集页面尚未打开，请先开始或继续任务。';
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
  $('profiles').checked=s.profiles===true;
  $('profiles').disabled=!data.session || actions>0;
  $('welcome').textContent = errors[s.last_error] || (s.enabled ? (s.phase === 'idle' ? '自动任务已开启，正在等待下一步。' : '自动任务执行中，你可以随时停止。') : data.session ? '参与身份已就绪，可点击继续；无需再次报名。' : data.invited ? '邀请已接续，请确认是否参与。' : '请从邀请链接打开，无需注册中台账号。');
  $('start').hidden = !data.session;
  $('consent').textContent = data.session ? '同意并继续' : '同意并开始';
  const fields = {'插件版本': CrowdCore.VERSION, '中台账户': data.session ? '已登录' : '未登录', '参与状态': p.participant?.status || p.error || '尚未报名', '自动执行': s.enabled ? '已开启' : '已停止', '当前阶段': s.phase === 'idle' && s.task ? '准备执行任务' : labels[s.phase] || s.phase,
    '任务': s.task?.query || '暂无', '服务端接收': p.received ?? '—', '核验有效': p.verified ?? '—', '已记奖励': p.reward_fen == null ? '—' : '¥' + (p.reward_fen / 100).toFixed(2), '累计余数': p.remainder ?? '—', '待回传 / 待处理': s.outbox.length + ' / ' + s.rejected.length, '最近待处理原因': s.rejected.length ? (errors[s.rejected.at(-1).reason] || s.rejected.at(-1).reason) : '无', '最早下一步': s.next_at > Date.now() ? new Date(s.next_at).toLocaleString('zh-CN') : '等待调度', '今日访问': s.control ? Object.entries(s.control.counts).map(([k,v]) => ({search:'搜索',detail:'详情',comment:'评论展开',scroll:'滚动'})[k] + ' ' + v + '/' + s.control.caps[k]).join('，') : '尚未同步', '最近提示': errors[s.last_error] || s.last_error || '无'};
  $('status').replaceChildren();
  for (const [name, value] of Object.entries(fields)) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = name; dd.textContent = String(value); $('status').append(dt, dd); }
  $('agree').checked = s.consent === CrowdCore.CONSENT;
  $('diagnostics').checked = data.diagnostics?.enabled === true;
  $('diagnostics').disabled = !data.session || actions > 0;
  $('diagnostics_status').textContent = data.diagnostics?.pending_clear ? '诊断已关闭；联网后清除云端旧状态。' : data.diagnostics?.error ? '诊断暂未送达，联网后自动重试，不影响采集。' : data.diagnostics?.sent_at ? '最近诊断送达：' + new Date(data.diagnostics.sent_at).toLocaleTimeString('zh-CN') : data.diagnostics?.enabled ? '诊断已开启，正在准备发送。' : '诊断未开启。';
}
async function action(fn) { ++actions; ++viewTicket; $('diagnostics').disabled = true; const buttons = [...document.querySelectorAll('button')]; buttons.forEach(b => b.disabled = b.id !== 'stop'); try { $('message').textContent = ''; await fn(); await refresh(); } catch (e) { $('message').textContent = e.message === 'cancelled' ? '已取消启动' : errors[e.message] || e.message; } finally { --actions; buttons.forEach(b => b.disabled = actions > 0 && b.id !== 'stop'); $('diagnostics').disabled = actions > 0 || !current?.session; } }
$('login').addEventListener('submit', e => { e.preventDefault(); action(() => send('login', {email: $('email').value, password: $('password').value}).then(() => { $('password').value = ''; })); });
$('signup').onclick = () => action(async () => { const r = await send('login', {email: $('email').value, password: $('password').value, signup: true}); $('password').value = ''; if (r.confirmation_required) $('message').textContent = '请到邮箱确认账户，再回来登录。'; });
$('consent').onclick = () => action(async () => { if (!$('agree').checked) throw new Error('consent_required'); if (current?.invited && !current.session) await send('join', {consent: CrowdCore.CONSENT}); else { await send('consent'); await send('start'); } });
$('invite_form').onsubmit = e => { e.preventDefault(); action(async () => { await send('receive_invite', {invite: $('invite_value').value}); $('invite_value').value = ''; $('invitation').open = false; }); };
for (const type of ['start', 'stop', 'logout', 'open_login']) $(type).onclick = () => action(() => send(type));
$('export').onclick = () => action(async () => { const data = await send('export'), text = JSON.stringify(data, null, 2); if (globalThis.CrowdNative) { await CrowdNative.download(text); return; } const blob = new Blob([text], {type: 'application/json'}); const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = 'crowd-pending-evidence.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
$('refresh').onclick = () => action(refresh);
$('diagnostics').onchange = () => action(() => send('diagnostics', {enabled: $('diagnostics').checked}));
$('profiles').onchange = () => action(() => send('profiles',{enabled:$('profiles').checked}));
$('inspect_work_page').onclick = () => action(() => send('inspect_work_page'));
action(refresh);
globalThis.addEventListener('crowd_invite', () => action(refresh));
setInterval(() => { if (!document.hidden && !actions) refresh().catch(() => {}); }, 10000);

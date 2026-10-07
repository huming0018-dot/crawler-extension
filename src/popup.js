const $ = (id) => document.getElementById(id);
function render(status) {
  $("s_state").textContent = "运行中";
  $("s_state").className = "val status-ok";
  const d = status.day || {};
  $("s_searches").textContent = (d.searches || 0) + " 次";
  if (status.cooldown && status.cooldown.active) {
    $("s_cooldown").textContent = "冷却 " + status.cooldown.leftMin + "min";
    $("s_cooldown").className = "val status-warn";
  } else {
    $("s_cooldown").textContent = "无";
    $("s_cooldown").className = "val status-ok";
  }
  $("s_queue").textContent = status.queueLen + " 条";
  // v3 回流健康：服务端确认次数（lastOkAgoSec）+ 连续零有效计数
  const f = status.flow || {};
  const lastOk = f.lastOkAgoSec != null ? (f.lastOkAgoSec < 3600 ? "最近确认" : f.lastOkAgoSec + "s前") : "未回传";
  $("s_flow").textContent = f.stalled ? ("异常·连续" + (f.zeroCount || 0) + "次零有效") : (lastOk + (f.zeroCount ? " ·零有效" + f.zeroCount + "次" : ""));
  $("s_flow").className = f.stalled ? "val status-bad" : "val status-ok";
  $("s_task").textContent = status.activeTask ? "#" + status.activeTask.task_id + "(" + status.activeTask.pack_len + "项, KPI " + status.activeTask.kpi_min + ")" : "无";
  $("s_done").textContent = status.doneCount ? status.doneCount + " 个包" : "0";
  // 关键词进度条
  const kwBox = $("kw_box");
  kwBox.innerHTML = "";
  if (status.activeTask && status.activeTask.kwProgress) {
    status.activeTask.kwProgress.forEach((p, i) => {
      const bar = document.createElement("div");
      bar.style.cssText = "margin:3px 0;font-size:12px;";
      const pct = Math.min(100, Math.round((p.accepted / status.activeTask.kpi_min) * 100));
      const color = p.done ? "#059669" : (pct > 0 ? "#b45309" : "#e5e7eb");
      bar.innerHTML = '<span style="color:#6b7280">' + (i + 1) + ".</span> <span style='max-width:130px;display:inline-block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle'>" + p.kw + "</span> " +
        '<span style="float:right;color:' + color + '">' + p.accepted + "/" + status.activeTask.kpi_min + (p.done ? " ✓" : "") + "</span>" +
        '<div style="height:4px;background:#f0f0f0;border-radius:2px;margin-top:2px"><div style="height:100%;width:' + pct + '%;background:' + color + ';border-radius:2px"></div></div>';
      kwBox.appendChild(bar);
    });
  }
  if (status.participantId) {
    $("s_pid").textContent = status.participantId;
    $("s_pid").className = "val";
  } else {
    // 未注册：一键直达注册页（v3.4.9：手机端"选项页"太难找，提示本身做成可点按钮）
    const el = $("s_pid");
    el.textContent = "👉 点这里注册领取编号（30 秒）";
    el.className = "val status-warn";
    el.style.cssText += "cursor:pointer;text-decoration:underline;text-underline-offset:3px";
    el.onclick = () => chrome.runtime.openOptionsPage();
  }
  const gate = status.gateBlockReason || "";
  $("s_gate").textContent = gate || "正常";
  $("s_gate").className = gate ? "val status-bad" : "val status-ok";
  renderRateBox(status); // M1：accepted>=1 的关键词开放打分
}
chrome.runtime.sendMessage({ type: "CROWD_STATUS" }, (resp) => {
  if (resp) render(resp);
  else $("s_state").textContent = "未就绪(需参与协议)";
});
$("start").onclick = () => chrome.runtime.sendMessage({ type: "CROWD_START" }, () => {
  chrome.runtime.sendMessage({ type: "CROWD_STATUS" }, render);
});
$("stop").onclick = () => chrome.runtime.sendMessage({ type: "CROWD_STOP" }, () => {
  $("s_state").textContent = "已停止"; $("s_state").className = "val status-warn";
});

// ---------------------------------------------------------------- M1 评分区（口味评分体系 §8）
// 展示条件：active_task 存在且该关键词 accepted>=1；每参与者每店只评一次（rated 置灰），
// 提交构造 kind=rating 信封走 proof_queue（服务端 R6：1-5 分 / 理由≥8 字 / 锚定已收录笔记）。
function ratingReasonLen(s) {
  // 严格镜像服务端 regexp_replace(s,'[\s[:punct:]]','','g')：仅去空白+ASCII标点，中文标点计长
  return String(s || "").replace(/[\s\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]/g, "").length;
}
const RATE_FAIL_TEXT = {
  no_participant: "未注册参与编号",
  no_active_task: "任务已结束，无法评分",
  already_rated: "这家店你已评过",
  rating_out_of_range: "请先点选 1-5 星",
  reason_too_short: "理由至少 8 个字（不含空格与标点）",
  no_anchor: "暂无可锚定的已收录笔记",
  bad_kw_index: "门店信息异常",
};
function renderRateBox(status) {
  const box = $("rate_box");
  const list = $("rate_list");
  list.innerHTML = "";
  const t = status.activeTask;
  if (!t || !Array.isArray(t.kwProgress) || !status.participantId) {
    box.style.display = "none";
    return;
  }
  const eligible = t.kwProgress
    .map((p, i) => ({ p, i }))
    .filter((x) => x.p && (x.p.accepted || 0) >= 1);
  if (!eligible.length) {
    box.style.display = "none";
    return;
  }
  box.style.display = "block";
  eligible.forEach(({ p, i }) => {
    const card = document.createElement("div");
    card.className = "rate-card";
    const store = document.createElement("div");
    store.className = "store";
    store.textContent = p.kw; // textContent 防注入
    card.appendChild(store);

    if (p.rated) {
      const done = document.createElement("div");
      done.className = "rate-done";
      done.textContent = "已评 " + "★".repeat(p.ratedValue || 0) + "，感谢反馈";
      card.appendChild(done);
      list.appendChild(card);
      return;
    }
    if (!p.anchor) {
      const hint = document.createElement("div");
      hint.className = "rate-msg";
      hint.style.color = "#9ca3af";
      hint.textContent = "暂无可锚定笔记，再采集一会儿即可评分";
      card.appendChild(hint);
      list.appendChild(card);
      return;
    }

    let rating = 0;
    const stars = document.createElement("div");
    stars.className = "stars";
    const starBtns = [];
    for (let s = 1; s <= 5; s++) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "star";
      b.textContent = "★";
      b.dataset.v = s;
      b.onclick = () => {
        rating = s;
        starBtns.forEach((x) => x.classList.toggle("on", Number(x.dataset.v) <= rating));
        refreshBtn();
      };
      starBtns.push(b);
      stars.appendChild(b);
    }
    card.appendChild(stars);

    const ta = document.createElement("textarea");
    ta.maxLength = 200; // 服务端 left(...,200) 同口径
    ta.placeholder = "一句话理由：口味/菜品怎么样？（≥8 字，不含标点）";
    card.appendChild(ta);

    const meta = document.createElement("div");
    meta.className = "rate-meta";
    const cnt = document.createElement("span");
    cnt.className = "cnt";
    cnt.textContent = "0/8";
    const btn = document.createElement("button");
    btn.className = "rate-btn";
    btn.textContent = "提交评分";
    btn.disabled = true;
    meta.appendChild(cnt);
    meta.appendChild(btn);
    card.appendChild(meta);

    const msg = document.createElement("div");
    msg.className = "rate-msg";
    card.appendChild(msg);

    function refreshBtn() {
      const n = ratingReasonLen(ta.value);
      cnt.textContent = Math.min(n, 8) + "/8";
      cnt.style.color = n >= 8 ? "#059669" : "#9ca3af";
      btn.disabled = !(rating >= 1 && n >= 8);
    }
    ta.addEventListener("input", refreshBtn);

    btn.onclick = () => {
      btn.disabled = true;
      msg.style.color = "#6b7280";
      msg.textContent = "提交中…";
      chrome.runtime.sendMessage(
        { type: "CROWD_SUBMIT_RATING", kw_index: i, rating: rating, reason: ta.value, anchor_note_id: p.anchor },
        (resp) => {
          if (resp && resp.ok) {
            msg.style.color = "#059669";
            msg.textContent = "✓ 已提交（回传队列自动确认）";
            chrome.runtime.sendMessage({ type: "CROWD_STATUS" }, (st) => { if (st) render(st); });
          } else {
            const r = resp && resp.reason;
            msg.style.color = "#dc2626";
            msg.textContent = "提交失败：" + (RATE_FAIL_TEXT[r] || "请稍后重试");
            refreshBtn();
          }
        }
      );
    };
    list.appendChild(card);
  });
}

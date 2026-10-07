// onboarding.js — 参与协议页：手动填编号 + 「我要加入」自动注册
//
// 报名流程：apply.html 仅作下载页；参与者在插件内点「我要加入」自动获得编号。
// 原因：网页 localStorage 的 device salt 插件读不到（salt 不出 Service Worker/扩展域），
// 网页注册会导致采集侧 device_salt_mismatch，故注册必须发生在扩展域内。
//
// 编号规则：P- 开头 + 6~12 位大写字母/数字（线上真实编号如 P-B269XL1K 为 8 位）。

// Supabase 连接：src/config.js 随包分发（self.CROWD_CONFIG），anon key 为 publishable 公开分发。
const API_BASE = (self.CROWD_CONFIG && self.CROWD_CONFIG.API_BASE) || "https://bdwrhshgdeghgyzwpxnl.supabase.co";
const API_KEY = (self.CROWD_CONFIG && self.CROWD_CONFIG.API_KEY) || "";

const PID_RE = /^P-[A-Z0-9]{6,12}$/;

const $ = (id) => document.getElementById(id);

// 合规红线：participant_id 只能在「同意并开始使用」点击后落盘。
// 注册成功只回填输入框，不写 storage、不启动采集。
function savePid(pid) {
  // 点「同意」才走到这里：落盘编号+签署时间，并显式启动采集调度（CROWD_START 建 alarm + collector_running）
  chrome.storage.local.set({ participant_id: pid, agreed_at: new Date().toISOString() }, () => {
    chrome.runtime.sendMessage({ type: "CROWD_START" }, () => {
      document.body.innerHTML = "<h1>✅ 已同意</h1><p>参与协议已签署。你的参与编号：<b>" + pid +
        "</b></p><p>返回小红书页面，插件将自动开始拉取任务并采集。</p>";
    });
  });
}

// 「我要加入」：在扩展域内生成/复用设备 salt（与采集侧同源，杜绝 device_salt_mismatch），
// 调 RPC crowd_register_participant 自动获得编号并回填。
document.getElementById("join").onclick = async () => {
  if (!API_KEY) {
    alert("注册服务尚未配置（缺少 anon key），请联系项目方，或在下方手动输入已有编号。");
    return;
  }
  const btn = document.getElementById("join");
  btn.disabled = true;
  btn.textContent = "注册中…";
  try {
    const safety = new SafetyEngine(chrome.storage.local);
    const deviceSalt = await safety.getDeviceSalt(); // 持久化在 chrome.storage.local，采集侧读取同一个
    const resp = await fetch(API_BASE + "/rest/v1/rpc/crowd_register_participant", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: API_KEY,
        Authorization: "Bearer " + API_KEY,
      },
      body: JSON.stringify({
        p_device_salt: deviceSalt,
        p_source: "extension",
        p_display_name: document.getElementById("display_name").value.trim(),
        p_contact: document.getElementById("contact").value.trim(),
      }),
    });
    const data = await resp.json().catch(() => null);
    const pid = data && data.participant_id ? String(data.participant_id) : "";
    if (resp.ok && data && data.ok === true && PID_RE.test(pid)) {
      // 注册成功：只回填输入框——未点「同意」前绝不写 storage、不启动采集
      document.getElementById("participant").value = pid;
      alert("注册成功！你的参与编号：" + pid + "\n已自动填入下方，点击「同意并开始使用」完成签署后才开始采集。");
    } else if (data && (data.reason === "device_already_registered" || data.code === "device_already_registered") && PID_RE.test(pid)) {
      // 本设备已注册：服务端返回已有编号，同样只回填，签署后才落盘
      document.getElementById("participant").value = pid;
      alert("本设备已注册，已恢复编号：" + pid + "\n点击「同意并开始使用」完成签署后恢复采集。");
    } else {
      alert("注册失败：" + ((data && (data.reason || data.message)) || ("HTTP " + resp.status)));
    }
  } catch (e) {
    alert("网络错误：" + (e && e.message ? e.message : e));
  } finally {
    btn.disabled = false;
    btn.textContent = "我要加入（自动获取编号）";
  }
};

// 手动路径：已有编号者直接填（保留）
document.getElementById("agree").onclick = () => {
  const pid = document.getElementById("participant").value.trim();
  if (!pid) { alert("请填写参与者编号（或点上方「我要加入」自动获取）"); return; }
  if (!PID_RE.test(pid)) {
    alert("编号格式不正确：应为 P- 开头 + 6~12 位大写字母/数字（例如 P-A1B2C3）。");
    return;
  }
  savePid(pid);
};

document.getElementById("refuse").onclick = () => {
  // 不同意 = 清掉一切半成品状态（编号/签署记录）并停掉采集调度
  chrome.storage.local.remove(["participant_id", "agreed_at"], () => {
    chrome.storage.local.set({ collector_running: false }, () => {
      chrome.runtime.sendMessage({ type: "CROWD_STOP" }, () => {
        document.body.innerHTML = "<h1>已退出</h1><p>感谢了解。请在扩展管理中移除本插件。</p>";
      });
    });
  });
};

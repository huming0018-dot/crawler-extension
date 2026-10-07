// sw.js — 众包美食家 PWA Service Worker（v3.3.0）
// 职责：接收系统分享（小红书 App 分享 → 众包美食家），暂存分享文本，
//       然后拉起提交页自动完成解析与提交。普通 GET 请求一律放行（满足 PWA 可安装性）。
const DB_NAME = "crowd-share-db";
const STORE = "pending";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function stashShare(payload) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).add(payload);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(clients.claim()));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "POST") return; // GET 全放行，走网络默认

  // 关键：SW 会拦截受控页面发出的所有请求（含跨域 API 调用！），
  // 必须只接管"系统分享目标"这一个入口——同源 + 提交页路径，其余一律放行。
  // （v3.3.0 初版漏了这层过滤，把页面自己的 RPC 调用也重定向了，导致注册失败）
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.endsWith("/submit.html")) return;

  event.respondWith((async () => {
    try {
      const fd = await req.formData();
      const text = [fd.get("title"), fd.get("text"), fd.get("url")]
        .filter(Boolean).join(" ").slice(0, 2000);
      await stashShare({ text, at: Date.now() });
      return Response.redirect("submit.html?share=1", 303);
    } catch (e) {
      return Response.redirect("submit.html?share=err", 303);
    }
  })());
});

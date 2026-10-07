/**
 * content.js — 注入小红书页面的只读采集脚本（知情自愿众包）
 *
 * 不主动搜索、不发起新导航；只对 background 打开的页面做只读提取，
 * 辅助参与者把"正在看的内容"结构化，而不是替参与者决定看什么。
 * background 通过 { type:"CROWD_SEARCH", keyword, task_id?, target? } 触发：
 * keyword 必填；task_id/target 为可选任务上下文，在响应中原样回显。
 * 采集前校验当前页面搜索词与 keyword 一致（搜索结果页取 URL keyword 参数，
 * 其他页面读搜索框），不一致返回 PAGE_MISMATCH 一条都不采。
 * 列表页逐卡片独立提取（字段缺失留 null，禁止跨卡片复制，excerpt 恒 null）；
 * 详情页只提取当前笔记自身数据；note_id 只从笔记链接提取，拿不到为 null 并标 note_id_missing。
 * 只读公开页面内容，不采集私信/设置/账号信息。契约版本：CROWD-CONTRACT-001 §3。
 */
(() => {
  const XHS_DOMAIN = "www.xiaohongshu.com";
  const NOTE_CARD_SELECTOR = "section.note-item, div.note-item";
  const NOTE_LINK_SELECTOR = "a[href*='/explore/'], a[href*='/discovery/item/']";
  const NOTE_ID_RE = /\/(?:explore|discovery\/item)\/([0-9a-zA-Z]+)/;

  const _text = (el) => (el && typeof el.textContent === "string" ? el.textContent.trim() : "") || null;
  // 作者昵称净化：xhs 的 name 节点常把发布日期拼在昵称后——剥掉尾部时间形态
  // （YYYY-MM-DD / YYYY-MM / N秒|分钟|小时|天|周|个月|年前 / 昨天|前天|刚刚 / 前位是数字的 MM-DD）
  const _cleanAuthor = (s) => {
    s = String(s || "").trim();
    let prev;
    do {
      prev = s;
      s = s.replace(/(\d{4}-\d{2}(-\d{2})?|\d+\s*(秒|分钟|小时|天|周|个月|年)前|昨天|前天|刚刚)$/, "").trim();
    } while (s !== prev && s.length > 0);
    s = s.replace(/(\d)(\d{1,2})-(\d{1,2})$/, (m, pre, mo, dd) =>
      (+mo >= 1 && +mo <= 12 && +dd >= 1 && +dd <= 31) ? pre : m).trim();
    return s;
  };

  /** 归一化搜索词用于比对：Unicode 规范化 + 压缩空白 + 小写 */
  function normKw(s) {
    return (typeof s === "string" ? s : "")
      .normalize("NFC")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  /**
   * 读取当前页面的实际搜索词。
   * 优先取搜索页 URL 的 keyword 参数（自动 URL 解码）；
   * 否则读页面搜索框当前值；都无法确定时返回 null。
   */
  function getPageKeyword() {
    try {
      const u = new URL(location.href);
      if (u.pathname.startsWith("/search_result")) {
        const kw = u.searchParams.get("keyword");
        if (kw && kw.trim()) return kw.trim();
      }
    } catch (e) {
      /* location 解析失败时继续尝试搜索框 */
    }
    const input = document.querySelector(
      "input#search-input, input[name='search'], .search-box input, input[placeholder*='搜索']"
    );
    const v = input && typeof input.value === "string" ? input.value.trim() : "";
    return v || null;
  }

  /** 列表页：逐卡片独立提取。字段缺失留 null，禁止跨卡片复制。 */
  function extractNoteCards() {
    const cards = document.querySelectorAll(NOTE_CARD_SELECTOR);
    const out = [];
    cards.forEach((c) => {
      // 该卡片自己的笔记链接（唯一允许提取 note_id 的来源）
      const a = c.querySelector(NOTE_LINK_SELECTOR);
      let note_url = null;
      let note_id = null;
      if (a && a.href) {
        const m = a.href.match(NOTE_ID_RE);
        note_id = m ? m[1] : null;
        note_url = a.href.split("?")[0] + "?xsec_source=pc_crowd";
      }
      // 该卡片自己的标题与作者（只在这张卡片的子树内查找）
      const title = _text(c.querySelector(".title")) || _text(a);
      const author = _cleanAuthor(_text(c.querySelector(".author .name, .name, [class*='author'] [class*='name']")));

      // 链接、标题、作者全空 → 不是有效笔记卡片，跳过
      if (!note_url && !title && !author) return;

      out.push({
        kind: "note",
        note_id, // 拿不到为 null，并显式标注
        note_id_missing: note_id === null,
        note_url,
        title,
        author,
        excerpt: null, // 列表页不取正文；正文只在对应详情页独立提取
      });
    });
    return out;
  }

  /** 详情页：只提取当前这篇笔记自己的内容，不回退到任何其他笔记的数据。 */
  function extractNoteDetail() {
    const title = _text(document.querySelector("#detail-title, h1, .note-content .title, .title"));
    const desc = _text(document.querySelector("#detail-desc, .desc, .note-content, [class*='desc']"));
    const author = _cleanAuthor(_text(
      document.querySelector(".author .name, .user-name, [class*='author'] [class*='name']")
    ));
    const published_at = _text(
      document.querySelector(".bottom-container .date, .date, [class*='date']")
    );
    const m = location.pathname.match(NOTE_ID_RE);
    const note_id = m ? m[1] : null;
    return {
      kind: "note",
      note_id,
      note_id_missing: note_id === null,
      note_url: location.href.split("?")[0] + "?xsec_source=pc_crowd",
      title,
      excerpt: desc ? desc.slice(0, 200) : null,
      author,
      published_at,
    };
  }

  // 风控检测独立成函数并透传到所有返回路径（含 ok:false 分支）——
  // 页面触发风控又没解析出卡片时信号不得丢失，否则 SW 会顶着风控继续采。
  function detectRateLimited() {
    try {
      return /访问频繁|频繁/.test((document.body && document.body.innerText ? document.body.innerText : "").slice(0, 500));
    } catch (_) {
      return false;
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "CROWD_SEARCH") return;

    if (!location.hostname.includes(XHS_DOMAIN)) {
      sendResponse({ ok: false, error: "NOT_ON_XHS", reason: "not_on_xhs", items: [], rateLimited: detectRateLimited() });
      return;
    }

    // 任务上下文：keyword 必填；task_id/target 可选（支持 msg.task 打包传入）
    const keyword = typeof msg.keyword === "string" ? msg.keyword.trim() : "";
    const taskCtx = (msg.task && typeof msg.task === "object" ? msg.task : {}) || {};
    const task_id = msg.task_id || taskCtx.task_id || null;
    const target = msg.target || taskCtx.target || null;

    if (!keyword) {
      sendResponse({ ok: false, error: "MISSING_KEYWORD", reason: "missing_keyword", items: [], rateLimited: detectRateLimited() });
      return;
    }

    // 采集前校验：当前页面搜索词必须与任务关键词一致，不一致一条都不采
    const page_keyword = getPageKeyword();
    if (page_keyword === null || normKw(page_keyword) !== normKw(keyword)) {
      sendResponse({
        ok: false,
        error: "PAGE_MISMATCH",
        reason: "page_mismatch",
        keyword,
        page_keyword,
        task_id,
        target,
        items: [],
        rateLimited: detectRateLimited(),
      });
      return;
    }

    try {
      const isNotePage = NOTE_ID_RE.test(location.pathname);
      const cards = extractNoteCards();
      const page_type = cards.length ? "search" : isNotePage ? "note" : "unknown";
      const rateLimited = detectRateLimited();
      if (page_type === "unknown") {
        sendResponse({
          ok: false,
          error: "UNSUPPORTED_PAGE",
          reason: "unsupported_page",
          keyword,
          page_keyword,
          items: [],
          rateLimited,
        });
        return;
      }
      // 列表页逐卡片独立数据；详情页仅当前笔记自身数据
      const items = cards.length ? cards : [extractNoteDetail()];
      sendResponse({
        ok: true,
        keyword,
        page_keyword,
        page_type,
        task_id,
        target,
        items,
        rateLimited,
      });
    } catch (e) {
      sendResponse({ ok: false, error: "EXTRACT_FAILED", reason: e.message, items: [], rateLimited: detectRateLimited() });
    }
  });
})();

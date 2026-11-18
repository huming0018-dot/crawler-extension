"use strict";
// Project-specific saved DOM adapter. No browsing, RPC, scheduler or storage.
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

  function extractNoteCards(document) {
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


module.exports = { extractNoteCards };

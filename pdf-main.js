// 跑在頁面本身(MAIN world):借用 vjudge 已載入的 pdf.js 抽出 PDF 文字,
// 透過 postMessage 回傳給 content.js(content script 看不到頁面的全域變數)
(() => {
  "use strict";

  const MIN_PAGE_TEXT = 40; // 文字層少於這個字數就當作掃描頁
  const LIB_WAIT_MS = 10000;

  // vjudge 顯示第一份 PDF 時才會設定 globalThis.pdfjsLib;題目可能畫在父頁面
  function findLib() {
    if (window.pdfjsLib) return window.pdfjsLib;
    try {
      return window.parent !== window ? window.parent.pdfjsLib : null;
    } catch (e) {
      return null; // 跨網域的父頁面
    }
  }

  async function waitLib() {
    const start = Date.now();
    while (Date.now() - start < LIB_WAIT_MS) {
      const lib = findLib();
      if (lib) return lib;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("找不到 vjudge 的 pdf.js(PDF 還沒載入完?)");
  }

  // 只有數字與符號的行(例如 "3 5"、"1 2 3")也當成測資
  const DATA_LINE_RE = /^[\d\s.,:;+\-*/()[\]{}<>=|#]+$/;

  // 依 pdf.js 的 textContent 重建行,再組成段落與測資區塊:
  // [{ text, code }],code = true 是測資(等寬字型或純數字),原樣保留不翻譯
  function textToBlocks(items, styles) {
    const lines = [];
    let cur = null;
    for (const it of items) {
      if (!("str" in it)) continue;
      if (!cur) cur = { text: "", y: it.transform[5], h: it.height || 10, mono: 0, prop: 0 };
      cur.text += it.str;
      if (it.height) cur.h = Math.max(cur.h, it.height);
      // 換行標記是空字串且帶著下一行的字型,不能算進去
      const n = it.str.replace(/\s/g, "").length;
      if (n) {
        const family = styles[it.fontName] && styles[it.fontName].fontFamily;
        if (family === "monospace") cur.mono += n;
        else cur.prop += n;
      }
      if (it.hasEOL) {
        lines.push(cur);
        cur = null;
      }
    }
    if (cur) lines.push(cur);
    for (const l of lines) {
      const t = l.text.trim();
      l.code = (l.mono > 0 && l.prop === 0) || (DATA_LINE_RE.test(t) && /\d/.test(t));
    }

    // 文字:行距明顯變大、空行、或上一行明顯較短(標題、段落最後一行)就換段
    // 測資:連續的測資行合併成一塊,保留換行
    const maxLen = Math.max(0, ...lines.filter((l) => !l.code).map((l) => l.text.trim().length));
    const blocks = [];
    let prev = null;
    for (const line of lines) {
      const text = line.text.trim();
      if (!text) {
        prev = null;
        continue;
      }
      const last = blocks[blocks.length - 1];
      const gap = prev ? prev.y - line.y : Infinity;
      const close = prev && gap > 0 && gap < Math.max(prev.h, line.h) * 1.6;
      if (line.code) {
        if (prev && prev.code && gap > 0 && gap < Math.max(prev.h, line.h) * 2.5) {
          last.text += "\n" + line.text.trimEnd();
        } else {
          blocks.push({ text: line.text.trimEnd(), code: true });
        }
      } else if (close && !prev.code && prev.text.trim().length >= maxLen * 0.6) {
        // 行尾連字號斷字:"exam-" + "ple" → "example"
        last.text = /[A-Za-z]-$/.test(last.text) && /^[a-z]/.test(text)
          ? last.text.slice(0, -1) + text
          : last.text + " " + text;
      } else {
        blocks.push({ text, code: false });
      }
      prev = line;
    }
    // 測資區塊去掉共同的開頭縮排
    for (const b of blocks) {
      if (!b.code) continue;
      const rows = b.text.split("\n");
      const indent = Math.min(...rows.filter((r) => r.trim()).map((r) => r.match(/^ */)[0].length));
      b.text = rows.map((r) => r.slice(indent)).join("\n");
    }
    return blocks;
  }

  async function extract(url) {
    const lib = await waitLib();
    const task = lib.getDocument({
      url,
      cMapUrl: location.origin + "/static/bundle/pdfjs/cmaps/",
      cMapPacked: true,
      isEvalSupported: false
    });
    try {
      const doc = await task.promise;
      const pages = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const { items, styles } = await page.getTextContent();
        const blocks = textToBlocks(items, styles);
        const scanned = blocks.map((b) => b.text).join("").replace(/\s/g, "").length < MIN_PAGE_TEXT;
        pages.push({ blocks: scanned ? [] : blocks, scanned });
        page.cleanup();
      }
      return pages;
    } finally {
      task.destroy(); // 新版 pdf.js 的文件物件沒有 destroy(),要從 loading task 釋放
    }
  }

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (e.source !== window || !msg || msg.vjt !== "pdf-request") return;
    extract(msg.url).then(
      (pages) => window.postMessage({ vjt: "pdf-result", id: msg.id, ok: true, pages }, "*"),
      (err) => window.postMessage({ vjt: "pdf-result", id: msg.id, ok: false, error: String(err && err.message || err) }, "*")
    );
  });
})();

// 跑在頁面本身(MAIN world):借用 vjudge 已載入的 pdf.js 抽出 PDF 文字,
// 透過 postMessage 回傳給 content.js(content script 看不到頁面的全域變數)
(() => {
  "use strict";

  const MIN_PAGE_TEXT = 40; // 文字層少於這個字數就當作掃描頁
  const LIB_WAIT_MS = 10000;
  const SNAPSHOT_SCALE = 2; // 公式截圖的解析度(相對 PDF 原尺寸)
  const SNAPSHOT_PAD = 4;   // 截圖四周多留的邊(PDF 單位)

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
  const MATH_FUNC_RE = /\b(?:max|min|log|lg|ln|exp|sin|cos|tan|gcd|lcm|mod|lim|sup|inf|det|deg|arg)\b/g;
  const DATA_LINE_RE = /^[\d\s.,:;+\-*/()[\]{}<>=|#]+$/;

  // 依 pdf.js 的 textContent 重建行,再組成段落與測資區塊:
  // [{ text, code }],code = true 是測資(等寬字型或純數字),原樣保留不翻譯
  function textToBlocks(items, styles) {
    const lines = [];
    let cur = null;
    for (const it of items) {
      if (!("str" in it)) continue;
      if (!cur) cur = { text: "", parts: [], y: it.transform[5], h: it.height || 10, mono: 0, prop: 0 };
      cur.text += it.str;
      cur.parts.push({ str: it.str, font: it.fontName });
      if (it.height) cur.h = Math.max(cur.h, it.height);
      // 換行標記是空字串且帶著下一行的字型,不能算進去
      const n = it.str.replace(/\s/g, "").length;
      if (n) {
        // 這行在頁面上的範圍(PDF 座標,y 往上),公式截圖用
        const x = it.transform[4], y = it.transform[5], h = it.height || 10;
        cur.box = unionBox(cur.box, [x, y - h * 0.3, x + (it.width || 0), y + h]);
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
    const body = bodyFont(lines);
    // 每行的主要字型(字數最多的),內文 → 粗體標題這種字型切換也要換段
    for (const l of lines) {
      const n = new Map();
      for (const p of l.parts) n.set(p.font, (n.get(p.font) || 0) + p.str.replace(/\s/g, "").length);
      l.font = [...n].sort((a, b) => b[1] - a[1])[0]?.[0];
    }
    // 置中的公式行:沒有內文字型的英文單字(max、log 這類數學函數在 LaTeX 裡也是內文字型,先拿掉),
    // 而且看起來像數學(有符號/數字、混用多種字型、或只有短變數)。只用一種字型又有單字的是標題,例如 "Task"
    for (const l of lines) {
      const parts = l.parts.filter((p) => p.str.trim());
      const words = (p) => p.str.replace(MATH_FUNC_RE, " ");
      const bodyWords = parts.some((p) => p.font === body && /[A-Za-z]{2,}/.test(words(p)));
      const fonts = new Set(parts.map((p) => p.font)).size;
      const heading = fonts === 1 && /[A-Za-z]{3,}/.test(words(parts[0] || { str: "" }));
      const mathy = fonts >= 2 || /[=+\-−<>≤≥()[\]{}|·×/^\d]/.test(l.text) || !/[A-Za-z]{3,}/.test(l.text);
      l.math = !l.code && parts.length > 0 && !bodyWords && !heading && mathy;
    }
    markMath(lines, styles, body);

    // 文字:行距明顯變大、空行、或上一行明顯較短(標題、段落最後一行)就換段
    // 測資:連續的測資行合併成一塊,保留換行
    // 公式:連續的公式行(例如分數的分子、分母)合併成一塊,不翻譯
    const maxLen = Math.max(0, ...lines.filter((l) => !l.code && !l.math).map((l) => l.text.trim().length));
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
      if (line.math) {
        // 分數的分子、分母(Σ 的上下限)可能在主行的上方或下方,
        // 所以跟整個公式區塊的上下範圍比距離,而不是只跟上一行比
        const near = prev && prev.math &&
          line.y > last.yMin - Math.max(last.h, line.h) * 1.8 &&
          line.y < last.yMax + Math.max(last.h, line.h) * 1.8;
        if (near) {
          last.text += " " + text;
          last.yMin = Math.min(last.yMin, line.y);
          last.yMax = Math.max(last.yMax, line.y);
          last.h = Math.max(last.h, line.h);
          last.box = unionBox(last.box, line.box);
        } else {
          blocks.push({ text, math: true, yMin: line.y, yMax: line.y, h: line.h, box: line.box });
        }
      } else if (line.code) {
        if (prev && prev.code && gap > 0 && gap < Math.max(prev.h, line.h) * 2.5) {
          last.text += "\n" + line.text.trimEnd();
        } else {
          blocks.push({ text: line.text.trimEnd(), code: true });
        }
      } else if (close && !prev.code && !prev.math && prev.font === line.font &&
        prev.text.trim().length >= maxLen * 0.6) {
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

  // PDF 沒有數學標籤,只能看字型:LaTeX 的數學變數(CMMI…)、下標、符號用的字型和內文不同。
  // 內文行裡「非主要字型且沒有長單字」的連續片段(例如 s1、si、|si − sj|)、
  // 以及等寬字型的片段(例如 YES),用 \uE000…\uE001 包起來,content.js 會保護它不被翻譯
  function unionBox(a, b) {
    if (!a) return b;
    if (!b) return a;
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
  }

  // 公式的排版(分數、上下標)從文字抽不出來,直接把那塊區域從 PDF 畫面截成圖片
  async function snapshotMath(page, blocks) {
    const maths = blocks.filter((b) => b.math && b.box);
    if (!maths.length) return;
    const viewport = page.getViewport({ scale: SNAPSHOT_SCALE });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;

    // PDF 座標 → 畫布座標(直接用 transform 矩陣,不依賴各版本 pdf.js 不同的輔助函式)
    const [a, bb, c, d, e, f] = viewport.transform;
    const toCanvas = (x, y) => [a * x + c * y + e, bb * x + d * y + f];
    for (const b of maths) {
      const [x0, y0, x1, y1] = b.box;
      const r = [
        ...toCanvas(x0 - SNAPSHOT_PAD, y0 - SNAPSHOT_PAD),
        ...toCanvas(x1 + SNAPSHOT_PAD, y1 + SNAPSHOT_PAD)
      ];
      const left = Math.max(0, Math.floor(Math.min(r[0], r[2])));
      const top = Math.max(0, Math.floor(Math.min(r[1], r[3])));
      const w = Math.min(canvas.width, Math.ceil(Math.max(r[0], r[2]))) - left;
      const h = Math.min(canvas.height, Math.ceil(Math.max(r[1], r[3]))) - top;
      if (w <= 0 || h <= 0) continue;
      const crop = document.createElement("canvas");
      crop.width = w;
      crop.height = h;
      crop.getContext("2d").drawImage(canvas, left, top, w, h, 0, 0, w, h);
      b.img = crop.toDataURL("image/png");
      b.imgWidth = Math.round(w / SNAPSHOT_SCALE); // 以 PDF 原尺寸顯示
    }
  }

  // 內文字型 = 測資以外字數最多的字型
  function bodyFont(lines) {
    const count = new Map();
    for (const l of lines) {
      if (l.code) continue;
      for (const p of l.parts) {
        count.set(p.font, (count.get(p.font) || 0) + p.str.replace(/\s/g, "").length);
      }
    }
    let body = null;
    for (const [font, n] of count) if (!body || n > count.get(body)) body = font;
    return body;
  }

  function markMath(lines, styles, body) {
    if (!body) return;
    const isMono = (font) => styles[font] && styles[font].fontFamily === "monospace";

    for (const l of lines) {
      // 整行都不是內文字型(標題)就不動
      if (l.code || l.math || !l.parts.some((p) => p.font === body && /[A-Za-z]/.test(p.str))) continue;
      let text = "";
      let run = null; // 目前累積的非內文片段
      let runMono = false;
      const flush = () => {
        if (run === null) return;
        const core = run.trim();
        const keep = core && (runMono || !/[A-Za-z]{4,}/.test(core));
        text += keep ? run.replace(core, "\uE000" + core + "\uE001") : run;
        run = null;
        runMono = false;
      };
      for (const p of l.parts) {
        const other = p.font !== body;
        if (other || (run !== null && !p.str.trim())) {
          run = (run || "") + p.str;
          runMono = runMono || (other && isMono(p.font));
        } else {
          flush();
          text += p.str;
        }
      }
      flush();
      l.text = text;
    }
  }

  // 這一頁是哪一題的開頭:前幾段裡有以 "Problem H" 開頭的(整份題本的 PDF 每題從新的一頁開始)
  function pageProblem(blocks) {
    for (const b of blocks.filter((b) => !b.code).slice(0, 4)) {
      const m = b.text.replace(/[\uE000\uE001]/g, "").match(/^Problem\s+([A-Z])\b/);
      if (m) return m[1];
    }
    return null;
  }

  // problem:題號(例如 "H")。PDF 是整份題本時只回傳這一題的頁面,找不到就回傳全部
  async function extract(url, problem) {
    const lib = await waitLib();
    const task = lib.getDocument({
      url,
      cMapUrl: location.origin + "/static/bundle/pdfjs/cmaps/",
      cMapPacked: true,
      isEvalSupported: false
    });
    try {
      const doc = await task.promise;
      // 先抽全部頁面的文字(在本機做,很快),判斷每頁屬於哪一題
      const all = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const { items, styles } = await page.getTextContent();
        const blocks = textToBlocks(items, styles);
        const scanned = blocks.map((b) => b.text).join("").replace(/\s/g, "").length < MIN_PAGE_TEXT;
        all.push({ num: i, blocks: scanned ? [] : blocks, scanned, problem: pageProblem(blocks) });
        page.cleanup();
      }

      let pages = all;
      let found = null;
      const start = problem ? all.findIndex((p) => p.problem === problem) : -1;
      if (start >= 0) {
        let end = start + 1;
        while (end < all.length && (!all[end].problem || all[end].problem === problem)) end++;
        pages = all.slice(start, end);
        found = problem;
      }

      // 只替要顯示的頁面截公式圖
      for (const p of pages) {
        if (p.scanned || !p.blocks.some((b) => b.math)) continue;
        try {
          const page = await doc.getPage(p.num);
          await snapshotMath(page, p.blocks);
          page.cleanup();
        } catch (e) {
          console.warn("[vjudge-translator] 公式截圖失敗:", e); // 面板會改顯示提示文字
        }
      }
      for (const p of pages) {
        delete p.problem;
        for (const b of p.blocks) {
          delete b.yMin;
          delete b.yMax;
          delete b.h;
          delete b.box;
        }
      }
      return { pages, total: all.length, problem: found };
    } finally {
      task.destroy(); // 新版 pdf.js 的文件物件沒有 destroy(),要從 loading task 釋放
    }
  }

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (e.source !== window || !msg || msg.vjt !== "pdf-request") return;
    extract(msg.url, msg.problem).then(
      (result) => window.postMessage({ vjt: "pdf-result", id: msg.id, ok: true, result }, "*"),
      (err) => window.postMessage({ vjt: "pdf-result", id: msg.id, ok: false, error: String(err && err.message || err) }, "*")
    );
  });
})();

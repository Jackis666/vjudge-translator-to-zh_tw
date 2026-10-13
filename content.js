(() => {
  "use strict";

  const IS_TOP = window.top === window;
  const TARGET_LANG = "zh-TW"; // 固定翻成繁體中文
  const SEP = "\n@@@\n";
  const CHUNK_LIMIT = 1800; // 每批最大字元數
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "CODE", "PRE", "TEXTAREA", "INPUT",
    "SVG", "MATH", "MJX-CONTAINER", "BUTTON", "SELECT", "KBD", "SAMP"
  ]);
  const SKIP_SELECTOR =
    ".katex, .MathJax, .MathJax_Preview, mjx-container, .vjt-orig, .vjt-fab, pre, code, " +
    ".vjudge-pdf";
  // 保護數學式($$$...$$$、$...$、\( \)、\[ \])與引號內的輸出字串("YES"、'#')
  const MATH_RE = /\$\$\$[\s\S]*?\$\$\$|\$\$[\s\S]*?\$\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\$[^$\n]+\$|"[^"\n]{1,40}"|“[^”\n]{1,40}”|‘[^’\n]{1,40}’|(?<![A-Za-z])'[^'\n]{1,20}'(?![A-Za-z])/g;
  const HAS_LATIN = /[A-Za-z]{2,}/;
  const HAS_CJK = /[\u4e00-\u9fff]/;
  // 整個元素原封不動保留(數學式、程式碼、按鈕…)
  const ATOMIC_SELECTOR = SKIP_SELECTOR + ", " + [...SKIP_TAGS].join(", ");
  // 段落內的行內元素用 [[E0]] 佔位,整段一起翻譯後再放回原處
  const EL_TOKEN_RE = /\[\s*\[\s*E\s*(\d+)\s*\]\s*\]/g;
  const INLINE_DISPLAY = new Set(["", "inline", "inline-block", "inline-flex", "contents", "ruby"]);
  const PROSE_RE = /[A-Za-z]{2,}(?:[^A-Za-z]+[A-Za-z]{2,}){3}/; // 至少 4 個英文單字
  const FORMAT_TAGS = new Set(["B", "STRONG", "EM", "U", "A", "SPAN", "FONT", "MARK"]);

  // 頂層頁面只放開關按鈕;若題目直接放在主頁面,則用這些選擇器翻譯
  const TOP_ROOT_SELECTORS = ["#problem-description", ".problem-description", "#description"];

  let settings = { enabled: true, mode: "replace" };
  const originals = new Map(); // 段落元素 -> 原本的 childNodes
  const bilingualEls = [];     // 雙語模式新增的元素
  let running = false;
  let pending = false; // 翻譯中又有新內容,結束後再跑一次
  let runId = 0;
  let observer = null;

  /* ---------- 設定 ---------- */
  function loadSettings() {
    return chrome.storage.sync.get(["enabled", "mode"]).then((s) => {
      settings = {
        enabled: s.enabled ?? true,
        mode: s.mode ?? "replace"
      };
    });
  }

  /* ---------- 找出要翻譯的文字節點 ---------- */
  function getRoots() {
    if (!IS_TOP) return document.body ? [document.body] : [];
    return TOP_ROOT_SELECTORS.map((s) => document.querySelector(s)).filter(Boolean);
  }

  function isInline(el, cache) {
    if (!cache.has(el)) cache.set(el, INLINE_DISPLAY.has(getComputedStyle(el).display));
    return cache.get(el);
  }

  // 是否要把這個元素的內容當成一段獨立翻譯
  function isBlock(el, cache) {
    if (el.matches(ATOMIC_SELECTOR)) return false;
    if (!isInline(el, cache)) return true;
    const text = el.textContent;
    // 行內元素本身有一整句話(例如粗體的提示句)
    if (PROSE_RE.test(text)) return true;
    // 單純加粗/強調的英文單字,例如 <em>exactly</em>;
    // 但不碰變數(<i>)、CF 的 tex-* 字串樣式、全大寫(YES/NO)與引號內的輸出字串
    if (!FORMAT_TAGS.has(el.tagName) || el.childElementCount) return false;
    if (/tex|math|var/i.test(el.className) || !/[a-z]{3,}/.test(text)) return false;
    const before = el.previousSibling, after = el.nextSibling;
    const quoted = before && before.nodeType === 3 && /["“‘'«]\s*$/.test(before.nodeValue) &&
      after && after.nodeType === 3 && /^\s*["”’'»]/.test(after.nodeValue);
    return !quoted;
  }

  // 把段落序列化成「文字 + [[E#]] 佔位符」
  function serialize(block) {
    const els = [];
    let text = "";
    for (const n of block.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) text += n.nodeValue.replace(/\s+/g, " ");
      else if (n.nodeType === Node.ELEMENT_NODE) {
        els.push(n);
        text += `[[E${els.length - 1}]]`;
      }
    }
    return { text: text.trim(), els };
  }

  function collectBlocks(root, cache) {
    const blocks = new Set();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p || p.closest(ATOMIC_SELECTOR)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) {
      let el = walker.currentNode.parentElement;
      while (el !== root && !isBlock(el, cache)) el = el.parentElement;
      blocks.add(el);
    }

    const items = [];
    for (const block of blocks) {
      if (originals.has(block)) continue;
      const { text, els } = serialize(block);
      if (HAS_CJK.test(text)) continue; // 已有中文
      if (!HAS_LATIN.test(text.replace(EL_TOKEN_RE, " ").replace(MATH_RE, " "))) continue;
      items.push({
        block,
        text,
        els,
        inline: isInline(block, cache),
        // 雙語模式先複製原文(之後巢狀段落翻譯完,原文就不見了)
        orig: settings.mode === "bilingual" ? [...block.childNodes].map((n) => n.cloneNode(true)) : null
      });
    }
    return items;
  }

  /* ---------- 數學式保護 ---------- */
  const ANY_TOKEN_RE = /\[\s*\[\s*([EM])\s*(\d+)\s*\]\s*\]/g;
  // 中間沒有英文字的連續佔位符(例如 "a" → "b" → "c")合併成一個,太密集的佔位符翻譯服務會弄亂
  const TOKEN_RUN_RE = /\[\[[EM]\d+\]\](?:[^A-Za-z[\]]*\[\[[EM]\d+\]\])+/g;

  function protect(text) {
    const saved = [];
    const save = (m) => {
      saved.push(m);
      return `[[M${saved.length - 1}]]`;
    };
    const out = text.replace(MATH_RE, save).replace(TOKEN_RUN_RE, save);
    return { out, saved };
  }
  // 合併的佔位符裡還有佔位符,所以要還原到沒有為止;還原不了的直接拿掉
  function restore(text, saved) {
    const re = /\[\s*\[\s*M\s*(\d+)\s*\]\s*\]/g;
    for (let i = 0; i < 5 && re.test(text); i++) {
      text = text.replace(re, (m, k) => saved[+k] ?? "");
    }
    return text;
  }
  // 譯文的佔位符是否和送出去的一樣(沒有遺失、重複或被改壞)
  function tokensIntact(sent, got) {
    const keys = (t) => [...t.matchAll(ANY_TOKEN_RE)].map((m) => m[1] + m[2]).sort().join();
    return keys(sent) === keys(got);
  }

  /* ---------- 叫翻譯 ---------- */
  function translateText(text) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: "translate", text, target: TARGET_LANG },
        (resp) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!resp || !resp.ok) return reject(new Error(resp ? resp.error : "no response"));
          resolve(resp.result);
        }
      );
    });
  }

  async function translateBatch(items, myRun) {
    // items: [{ text, ... }],回傳時保留原本欄位並加上 result
    const prepared = items.map((it) => ({ ...it, ...protect(it.text) }));
    const joined = prepared.map((p) => p.out).join(SEP);
    let parts = null;
    try {
      const res = await translateText(joined);
      const split = res.split(/\s*@\s*@\s*@\s*/);
      if (split.length === prepared.length) parts = split;
    } catch (e) {
      // 請求失敗(例如被限流)就整批放棄,不要再逐段狂發請求
      console.warn("[vjudge-translator] batch failed:", e);
      return [];
    }
    if (!parts) {
      // 數量對不上就逐段翻譯
      parts = [];
      for (const p of prepared) {
        if (myRun !== runId) return [];
        try {
          parts.push(await translateText(p.out));
        } catch (e) {
          parts.push(null);
        }
      }
    }
    // 佔位符被弄壞的段落單獨重翻一次
    for (let i = 0; i < prepared.length; i++) {
      if (parts[i] == null || tokensIntact(prepared[i].out, parts[i])) continue;
      if (myRun !== runId) return [];
      try {
        const retry = await translateText(prepared[i].out);
        if (tokensIntact(prepared[i].out, retry)) parts[i] = retry;
      } catch (e) {
        // 重翻失敗就用原本的結果,遺失的元素會補在段落最後
      }
    }
    return prepared.map((p, i) => ({
      ...items[i],
      result: parts[i] == null ? null : restore(parts[i].trim(), p.saved)
    }));
  }

  /* ---------- 套用結果 ---------- */
  function apply({ block, els, inline, orig, result }) {
    if (!result || !block.isConnected) return;
    // 依譯文中佔位符的位置把原本的元素放回去(中文語序可能不同)
    const nodes = [];
    const used = new Set();
    result.split(EL_TOKEN_RE).forEach((part, i) => {
      if (i % 2 === 0) {
        if (part) nodes.push(document.createTextNode(part));
      } else if (els[+part] && !used.has(+part)) {
        used.add(+part);
        nodes.push(els[+part]);
      }
    });
    // 翻譯服務弄丟的佔位符:元素補在最後,不能讓它消失
    els.forEach((el, i) => used.has(i) || nodes.push(el));

    originals.set(block, [...block.childNodes]);
    block.replaceChildren(...nodes);
    // 雙語原文:區塊元素放在開頭;整句的行內元素(例如整段粗體)放在它前面;單字就不放
    const sentence = inline && PROSE_RE.test(orig ? orig.map((n) => n.textContent).join("") : "");
    if (orig && (!inline || sentence)) {
      const span = document.createElement("span");
      span.className = "vjt-orig";
      span.append(...orig);
      if (inline) block.before(span);
      else block.prepend(span);
      bilingualEls.push(span);
    }
  }

  function revert() {
    runId++; // 中止進行中的翻譯
    for (const [block, nodes] of originals) {
      if (block.isConnected) block.replaceChildren(...nodes);
    }
    originals.clear();
    bilingualEls.splice(0).forEach((el) => el.remove());
  }

  // 分批後以 3 個並行請求翻譯,每批完成就呼叫 onResults
  async function translateAll(items, myRun, onResults) {
    const batches = [];
    let cur = [], len = 0;
    for (const it of items) {
      if (len + it.text.length > CHUNK_LIMIT && cur.length) {
        batches.push(cur);
        cur = [];
        len = 0;
      }
      cur.push(it);
      len += it.text.length + SEP.length;
    }
    if (cur.length) batches.push(cur);

    let idx = 0;
    const worker = async () => {
      while (idx < batches.length) {
        const my = batches[idx++];
        const results = await translateBatch(my, myRun);
        if (myRun !== runId) return;
        onResults(results);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  /* ---------- 主流程 ---------- */
  async function translatePage() {
    if (running) {
      pending = true;
      return;
    }
    pending = false;
    const roots = getRoots();
    if (!roots.length) return;
    const cache = new Map();
    const items = roots.flatMap((root) => collectBlocks(root, cache));
    if (!items.length) return;
    // 子框架內容太少(例如廣告、空白頁)就略過
    if (!IS_TOP && items.reduce((n, x) => n + x.text.length, 0) < 80) return;

    running = true;
    const myRun = ++runId;
    setBusy(true);

    await translateAll(items, myRun, (results) => results.forEach(apply));
    if (myRun !== runId) return; // 已被新的一輪取代,狀態交給新的那輪
    running = false;
    setBusy(false);
    if (pending) translatePage();
  }

  function observeLateContent() {
    if (observer || !document.body) return;
    let timer = null;
    observer = new MutationObserver(() => {
      if (!settings.enabled) return;
      clearTimeout(timer);
      timer = setTimeout(translatePage, 600);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  /* ---------- 浮動按鈕(只在頂層) ---------- */
  let fab = null;
  function setupFab() {
    if (!IS_TOP || fab) return;
    fab = document.createElement("button");
    fab.className = "vjt-fab";
    fab.addEventListener("click", () => {
      chrome.storage.sync.set({ enabled: !settings.enabled });
    });
    document.documentElement.appendChild(fab);
    updateFab();
  }
  function updateFab() {
    if (!fab) return;
    fab.textContent = settings.enabled ? "譯:開" : "譯:關";
    fab.classList.toggle("vjt-off", !settings.enabled);
    fab.title = "點擊切換 vjudge 題目翻譯";
  }
  function setBusy(b) {
    if (fab) fab.classList.toggle("vjt-busy", b);
  }

  /* ---------- 啟動 ---------- */
  async function sync(rerun) {
    if (rerun) revert();
    updateFab();
    if (settings.enabled) {
      running = false;
      await translatePage();
      observeLateContent();
    }
  }

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "sync") return;
    const prev = { ...settings };
    await loadSettings();
    const changed = ["enabled", "mode"].some((k) => prev[k] !== settings[k]);
    if (changed) {
      running = false;
      await sync(true);
    }
  });

  (async () => {
    await loadSettings();
    setupFab();
    await sync(false);
    // vjudge 是 SPA,題目 iframe 可能稍後才載入內容
    setTimeout(() => settings.enabled && translatePage(), 1500);
  })();
})();

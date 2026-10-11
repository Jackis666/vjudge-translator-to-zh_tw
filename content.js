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
    ".katex, .MathJax, .MathJax_Preview, mjx-container, .vjt-orig, .vjt-fab, pre, code";
  // 保護數學式($$$...$$$、$...$、\( \)、\[ \])與行內程式碼
  const MATH_RE = /\$\$\$[\s\S]*?\$\$\$|\$\$[\s\S]*?\$\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\$[^$\n]+\$/g;
  const HAS_LATIN = /[A-Za-z]{2,}/;
  const HAS_CJK = /[\u4e00-\u9fff]/;

  // 頂層頁面只放開關按鈕;若題目直接放在主頁面,則用這些選擇器翻譯
  const TOP_ROOT_SELECTORS = ["#problem-description", ".problem-description", "#description"];

  let settings = { enabled: true, mode: "replace" };
  const originals = new Map(); // textNode -> 原文
  const bilingualEls = [];     // 雙語模式新增的元素
  let running = false;
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

  function collectTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const text = n.nodeValue;
        if (!text || !text.trim()) return NodeFilter.FILTER_REJECT;
        if (!HAS_LATIN.test(text.replace(MATH_RE, ""))) return NodeFilter.FILTER_REJECT;
        if (HAS_CJK.test(text)) return NodeFilter.FILTER_REJECT; // 已有中文
        if (originals.has(n)) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(p.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT;
        if (p.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  /* ---------- 數學式保護 ---------- */
  function protect(text) {
    const saved = [];
    const out = text.replace(MATH_RE, (m) => {
      saved.push(m);
      return `[[M${saved.length - 1}]]`;
    });
    return { out, saved };
  }
  function restore(text, saved) {
    return text.replace(/\[\s*\[\s*M\s*(\d+)\s*\]\s*\]/g, (m, i) =>
      saved[+i] !== undefined ? saved[+i] : m
    );
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

  async function translateBatch(items) {
    // items: [{ node, text }]
    const prepared = items.map((it) => ({ ...it, ...protect(it.text) }));
    const joined = prepared.map((p) => p.out).join(SEP);
    let parts = null;
    try {
      const res = await translateText(joined);
      const split = res.split(/\s*@\s*@\s*@\s*/);
      if (split.length === prepared.length) parts = split;
    } catch (e) {
      console.warn("[vjudge-translator] batch failed:", e);
    }
    if (!parts) {
      // 數量對不上就逐段翻譯
      parts = [];
      for (const p of prepared) {
        try {
          parts.push(await translateText(p.out));
        } catch (e) {
          parts.push(null);
        }
      }
    }
    return prepared.map((p, i) => ({
      node: p.node,
      text: p.text,
      result: parts[i] == null ? null : restore(parts[i].trim(), p.saved)
    }));
  }

  /* ---------- 套用結果 ---------- */
  function apply({ node, text, result }) {
    if (!result || !node.isConnected) return;
    // 保留原本前後空白
    const lead = (text.match(/^\s*/) || [""])[0];
    const trail = (text.match(/\s*$/) || [""])[0];
    originals.set(node, text);
    if (settings.mode === "bilingual") {
      const span = document.createElement("span");
      span.className = "vjt-orig";
      span.textContent = text.trim();
      node.parentNode.insertBefore(span, node);
      bilingualEls.push(span);
    }
    node.nodeValue = lead + result + trail;
  }

  function revert() {
    runId++; // 中止進行中的翻譯
    for (const [node, text] of originals) {
      if (node.isConnected) node.nodeValue = text;
    }
    originals.clear();
    bilingualEls.splice(0).forEach((el) => el.remove());
  }

  /* ---------- 主流程 ---------- */
  async function translatePage() {
    if (running) return;
    const roots = getRoots();
    if (!roots.length) return;
    const nodes = roots.flatMap(collectTextNodes);
    if (!nodes.length) return;
    // 子框架內容太少(例如廣告、空白頁)就略過
    if (!IS_TOP && nodes.reduce((n, x) => n + x.nodeValue.length, 0) < 80) return;

    running = true;
    const myRun = ++runId;
    setBusy(true);

    // 分批
    const batches = [];
    let cur = [], len = 0;
    for (const node of nodes) {
      const text = node.nodeValue;
      if (len + text.length > CHUNK_LIMIT && cur.length) {
        batches.push(cur);
        cur = [];
        len = 0;
      }
      cur.push({ node, text });
      len += text.length + SEP.length;
    }
    if (cur.length) batches.push(cur);

    // 限制同時 3 個請求
    let idx = 0;
    const worker = async () => {
      while (idx < batches.length) {
        const my = batches[idx++];
        const results = await translateBatch(my);
        if (myRun !== runId) return;
        results.forEach(apply);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    running = false;
    setBusy(false);
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

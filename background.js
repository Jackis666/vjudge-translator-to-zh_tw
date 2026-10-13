// Service worker: 負責呼叫翻譯服務(避免 content script 受頁面 CORS 限制)
const ENDPOINT = "https://translate.googleapis.com/translate_a/single";

async function translateOne(text, target) {
  const params = new URLSearchParams({
    client: "gtx",
    sl: "auto",
    tl: target,
    dt: "t"
  });
  // 用 POST 避免長文字超出 URL 長度限制
  let res;
  try {
    res = await fetch(`${ENDPOINT}?${params}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: "q=" + encodeURIComponent(text)
    });
  } catch (e) {
    // 請求太多時 Google 會轉址到驗證頁,fetch 只會丟出 "Failed to fetch"
    throw new Error("連不上 Google 翻譯(可能是請求太多被暫時封鎖,過幾分鐘再試)");
  }
  if (res.status === 429) throw new Error("Google 翻譯請求太多(HTTP 429),過幾分鐘再試");
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  return (data[0] || []).map((seg) => seg[0] || "").join("");
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "translate") {
    translateOne(msg.text, msg.target)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // 非同步回應
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.sync.get(["enabled", "mode"]);
  await chrome.storage.sync.set({
    enabled: cur.enabled ?? true,
    mode: cur.mode ?? "replace"
  });
});

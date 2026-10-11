const $ = (id) => document.getElementById(id);

chrome.storage.sync.get(["enabled", "mode"]).then((s) => {
  $("enabled").checked = s.enabled ?? true;
  $("mode").value = s.mode ?? "replace";
});

$("enabled").addEventListener("change", (e) => chrome.storage.sync.set({ enabled: e.target.checked }));
$("mode").addEventListener("change", (e) => chrome.storage.sync.set({ mode: e.target.value }));

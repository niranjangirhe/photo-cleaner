// Runs on the Photo Cleaner dashboard page (127.0.0.1) and passes messages between it and the extension.
// It only reacts to messages the dashboard itself posts, and only forwards them to this extension.
(() => {
  const version = chrome.runtime.getManifest().version;
  let port = null;

  function connect() {
    port = chrome.runtime.connect({ name: "dashboard" });
    port.onMessage.addListener(m => window.postMessage({ source: "photo-cleaner-ext", ...m }, window.location.origin));
    port.onDisconnect.addListener(() => { port = null; });
  }

  window.addEventListener("message", e => {
    if (e.source !== window || e.origin !== window.location.origin) return;
    const m = e.data;
    if (!m || m.source !== "photo-cleaner-page") return;
    if (m.type === "ping") return window.postMessage({ source: "photo-cleaner-ext", type: "hello", version }, window.location.origin);
    if (!port) connect();
    port.postMessage(m);
  });

  document.documentElement.dataset.pcExt = version;
  window.postMessage({ source: "photo-cleaner-ext", type: "hello", version }, window.location.origin);
})();

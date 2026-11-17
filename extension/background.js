// Photo Cleaner helper: opens each approved photo in Google Photos (in your own logged-in browser)
// and moves it to the trash, one at a time, slowly. Stops at the first sign of anything unexpected.

const ports = new Set();
let run = null;

chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: "http://127.0.0.1:8770/#approved" }));

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "dashboard") return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener(m => {
    if (m.type === "start") start(m);
    else if (m.type === "stop" && run) { run.stop = true; run.stopReason = "Stopped by you"; broadcast(status()); }
    else if (m.type === "status") port.postMessage(status());
  });
  port.postMessage(status());
});

function broadcast(m) { for (const p of ports) { try { p.postMessage(m); } catch { /* page closed */ } } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function status() {
  if (!run) return { type: "status", running: false };
  return { type: "status", running: !run.done, mode: run.mode, total: run.items.length, at: run.i, done: run.ok,
           problems: run.failed, missing: run.missing, stopReason: run.stopReason || null, log: run.log.slice(0, 12) };
}

async function start({ items, mode, api, pauseMin, pauseMax }) {
  pauseMin = Math.max(500, pauseMin || 1000);            // never faster than half a second between photos
  pauseMax = Math.max(pauseMin, pauseMax || 2500);
  if (run && !run.done) return broadcast({ type: "error", message: "Already running" });
  items = (items || []).filter(it => /^https:\/\/photos\.google\.com\//.test(it.url || ""));
  run = { items, mode: mode === "delete" ? "delete" : "test", api, i: 0, ok: 0, failed: 0, missing: 0,
          stop: false, done: false, log: [], stopReason: null };
  broadcast(status());
  let win;
  try {
    // A small window of its own: browsers stop drawing hidden background tabs, and then Google Photos'
    // buttons and pop-ups never appear. A visible window keeps the page awake.
    win = await chrome.windows.create({ url: "about:blank", type: "popup", width: 560, height: 820, focused: true });
    const tabId = win.tabs[0].id;
    let inARow = 0;
    for (; run.i < items.length && !run.stop; run.i++) {
      const it = items[run.i];
      let r;
      try { r = await one(win.id, tabId, it.url, run.mode); }
      catch (e) {
        const closed = /no tab|no window|tab was closed|cannot access/i.test(String(e && e.message || e));
        r = closed ? { status: "error", fatal: true, message: "The Google Photos helper window was closed." }
                   : { status: "error", message: String(e && e.message || e) };
      }
      run.log.unshift({ id: it.id, name: it.name, ...r });
      if (r.status === "deleted") {
        run.ok++; inARow = 0;
        try {
          await fetch(api + "/api/gone", { method: "POST", headers: { "Content-Type": "application/json" },
                                           body: JSON.stringify({ ids: [it.id], gone: true }) });
        } catch { /* the dashboard will catch up when it's open again */ }
      } else if (r.status === "checked") { run.ok++; inARow = 0; }
      else if (r.status === "missing") { run.missing++; }
      else { run.failed++; inARow++; }
      if (r.fatal) { run.stop = true; run.stopReason = r.message; }
      else if (inARow >= 3) { run.stop = true; run.stopReason = "3 problems in a row: " + r.message; }
      broadcast(status());
      // a pause that varies each time, like a person's
      if (!run.stop && run.i < items.length - 1) await sleep(pauseMin + Math.random() * (pauseMax - pauseMin));
    }
  } finally {
    run.done = true;
    if (win) { try { await chrome.windows.remove(win.id); } catch { /* already closed */ } }
    broadcast(status());
  }
}

function waitLoaded(tabId, ms) {
  return new Promise(resolve => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); chrome.tabs.onUpdated.removeListener(on); resolve(); }
    function on(id, info) { if (id === tabId && info.status === "complete") done(); }
    chrome.tabs.onUpdated.addListener(on);
  });
}

async function one(winId, tabId, url, mode) {
  const w = await chrome.windows.get(winId);
  if (w.state === "minimized") await chrome.windows.update(winId, { state: "normal" });
  const loaded = waitLoaded(tabId, 30000);
  await chrome.tabs.update(tabId, { url });
  await loaded;
  const act = async () => {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: actOnPhoto, args: [url, mode] });
    return (res && res.result) || { status: "error", message: "No answer from the Google Photos page" };
  };
  let r = await act();
  if (r.status === "hidden") {  // the window was covered or minimized: bring it to the front and try once more
    await chrome.windows.update(winId, { state: "normal", focused: true });
    await sleep(1500);
    r = await act();
    if (r.status === "hidden")
      r = { status: "error", fatal: true, message: "The Google Photos helper window is hidden. Keep it visible on screen, then start again." };
  }
  return r;
}

// ---- runs inside the Google Photos tab ----
async function actOnPhoto(url, mode) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const want = (url.match(/\/photo\/([\w-]+)/) || [])[1];
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const label = el => (el.getAttribute("aria-label") || el.getAttribute("data-tooltip") || "").trim();
  const DELETE = /^(delete|move to trash|move to bin|trash|bin)$/i;

  if (document.visibilityState === "hidden") return { status: "hidden" };  // the browser isn't drawing this page
  if (/accounts\.google\.com/.test(location.hostname))
    return { status: "error", fatal: true, message: "Not signed in to Google Photos in this browser. Sign in, then start again." };
  if (!want) return { status: "error", message: "This doesn't look like a Google Photos photo link" };

  // 1. wait for this exact photo to open and its delete button to show
  let btn = null;
  for (const t0 = Date.now(); Date.now() - t0 < 20000;) {
    if (location.pathname.includes(want)) {
      btn = [...document.querySelectorAll("button, [role='button']")].find(b => visible(b) && DELETE.test(label(b)));
      if (btn) break;
    }
    await sleep(200);
  }
  if (!location.pathname.includes(want))
    return { status: "missing", message: "Google Photos didn't open this photo. It may already be deleted." };
  if (!btn)
    return { status: "missing", message: "No delete button for this photo. It may already be in the trash, or not be yours." };
  if (mode !== "delete")
    return { status: "checked", message: `Found the photo and its "${label(btn)}" button. Nothing was deleted (test mode).` };

  // 2. press delete, then answer Google's box: the usual "Move to trash", or a one-time notice about
  //    the trash ("You now have 30 days to restore items in trash" -> "Got it, continue")
  btn.click();
  const CONFIRM = /^(move to trash|move to bin|delete|remove)$/i;
  const NOTICE = /^(got it, continue|got it|continue)$/i;
  // Google uses both full dialogs and small pop-ups next to the trash icon, so search the whole page,
  // by the words written on the button (the trash icon itself has no written words, only a label).
  const written = b => (b.innerText || "").trim();
  const aboutTrash = b => {  // the box around a button mentions the trash / storage
    for (let el = b.parentElement, i = 0; el && i < 8; el = el.parentElement, i++)
      if (/trash|bin|google account storage/i.test(el.innerText || "")) return true;
    return false;
  };
  let answered = 0;
  for (const t0 = Date.now(); Date.now() - t0 < 10000 && answered < 3;) {
    if (!location.pathname.includes(want)) return { status: "deleted", message: "Moved to trash" };  // no box needed
    if (answered && /moved to (trash|bin)/i.test(document.body.innerText)) return { status: "deleted", message: "Moved to trash" };
    const buttons =[...document.querySelectorAll("button, [role='button']")].filter(b => b !== btn && visible(b));
    const pick = buttons.find(b => CONFIRM.test(written(b)) && aboutTrash(b))
      || buttons.find(b => NOTICE.test(written(b)) && aboutTrash(b));  // the one-time "30 days" notice
    if (pick) { pick.click(); answered++; await sleep(500); }
    else await sleep(150);
  }
  if (!answered) return { status: "error", fatal: true, message: "The \"Move to trash\" confirm box didn't appear, so it stopped to be safe." };

  // 3. make sure it really went: the photo closes, or Google says "Moved to trash"
  for (const t0 = Date.now(); Date.now() - t0 < 10000;) {
    if (!location.pathname.includes(want)) return { status: "deleted", message: "Moved to trash" };
    if (/moved to (trash|bin)/i.test(document.body.innerText)) return { status: "deleted", message: "Moved to trash" };
    await sleep(150);
  }
  return { status: "error", fatal: true, message: "Couldn't confirm the photo was moved to trash, so it stopped to be safe." };
}

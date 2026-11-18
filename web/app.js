"use strict";
/* Photo Cleaner dashboard. Plain JavaScript, no build step.
   Pages are picked with the address hash (#delete, #groups, #people...); filters can ride in the query
   string (?bbox=...&type=...) so a map area can open in a new tab. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// ---------- words ----------
const NAMES = {
  duplicate: "Exact copies", similar: "Look-alike shots", blank: "Blank images", accidental: "Accidental shots",
  screenshot: "Screenshots", meme: "Memes and greetings", receipt: "Receipts and bills", poor: "Blurry or dark",
  poor_people: "Blurry, with people", check: "Needs a look", ticket: "Tickets and bills", note: "Notes",
  unreadable: "Couldn't open", no_preview: "No preview", important: "Important", people: "People",
  favorite: "Favorite", shared: "From shared albums", creation: "Google auto-creations",
  photo: "Photo", document: "Document", id_card: "ID card", greeting: "Greeting", artwork: "Artwork",
  none: "No event", wedding: "Wedding", pre_wedding: "Haldi, mehndi or sangeet", engagement: "Engagement",
  birthday: "Birthday", anniversary: "Anniversary", baby_shower: "Baby shower", housewarming: "Housewarming",
  party: "Party", diwali: "Diwali", holi: "Holi", ganesh: "Ganesh Chaturthi", navratri: "Navratri / Garba",
  raksha_bandhan: "Raksha Bandhan", eid: "Eid", christmas: "Christmas", new_year: "New Year", festival: "Other festival",
  religious: "Religious", concert: "Concert", graduation: "Graduation", sports: "Sports", trip: "Trip", work: "Work",
  celebration: "Any celebration", selfie: "Selfie", group: "Group photo", kids: "Kids", dog: "Dog", cat: "Cat",
  food: "Food", beach: "Beach", mountains: "Mountains", nature: "Nature", city: "City", monument: "Monument",
  sunset: "Sunset", night: "Night", vehicle: "Vehicle", flowers: "Flowers", home: "Home", shopping: "Shopping",
  chat: "Chat", social: "Social media", map: "Map", blurry: "Blurry", dark: "Dark",
  google_people: "Tagged in Google", whatsapp: "From WhatsApp", quick_share: "Quick Share",
  social_app: "From a social app", shared_album: "From a shared album", creation_auto: "Google auto-creation",
  creation_manual: "Your Google creation", camera: "Phone camera", web: "Uploaded from computer",
  phone_folder: "Other phone folder",
};
const nm = k => NAMES[k] || (k ? String(k).replace(/_/g, " ").replace(/^./, c => c.toUpperCase()) : "Other");

const VIEWS = {
  overview: { title: "Overview" },
  delete: { title: "To delete", api: "delete", count: "s_delete", sort: "size",
    hint: "These look safe to delete. Use the buttons on each photo, or select several and decide at once. Nothing is deleted from Google until you do it there." },
  unsure: { title: "Not sure", api: "unsure", count: "s_unsure", sort: "size",
    hint: "Not clear-cut: tickets you may still need, notes, blurry photos with people in them. Your call." },
  groups: { title: "Duplicates", mode: "groups",
    hint: "Each group is the same photo, or shots taken seconds apart. The tool suggests keeping the sharpest; pick a different one with Keep only this one." },
  long: { title: "Long videos", api: "long", count: "s_long", sort: "size",
    hint: "Videos too long for the tool to judge, so none of these has a suggestion. Open one to play it, then keep it or approve it for delete. Biggest first: these free the most space." },
  all: { title: "All photos", api: "all", count: "items", sort: "date",
    hint: "Your whole library. Search or filter to find exactly what you want." },
  keep: { title: "Keeping", api: "keep", count: "keep", sort: "date",
    hint: "What the tool suggests keeping, plus everything you chose to keep." },
  people: { title: "People", mode: "people",
    hint: "Everyone found in your photos, grouped by face. Open a person to name them, merge two groups of the same person, or review their photos." },
  map: { title: "Map", api: "all", mode: "map", count: "located", sort: "date",
    hint: "Every photo with a location. Hold Shift and drag (or press Select an area) to pick a place; its photos appear below." },
  approved: { title: "Delete list", api: "approved", count: "approved", sort: "date",
    hint: "Approved for delete, not yet deleted in Google. Let the helper delete them, or open each in Google Photos and tick it once done." },
  deleted: { title: "Deleted", api: "deleted", count: "gone", sort: "date",
    hint: "Moved to the trash in Google Photos. Your storage comes back once you empty the trash there (Google keeps it 30 days)." },
  pending: { title: "Still processing", api: "pending", count: "pending", sort: "date", hint: "Files the steps haven't finished yet." },
};
const FILTERS = ["type", "event", "tag", "year", "kind"];
const SIZES = [120, 170, 240, 340, 480];                 // photo width for the size slider
const STEP_DONE = {
  scan: c => [c.scanned, c.files], group: c => [c.groups, null], tag: c => [c.tagged, c.taggable],
  faces: c => [c.faced, c.taggable], people: c => [c.people, null], ocr: c => [c.read, null],
  decide: c => [c.items - c.pending, c.items],
};

const S = { view: null, f: {}, q: "", bucket: "", sort: "size", person: null, bbox: null, items: [], total: 0,
            bytes: 0, loading: false, sel: new Set(), last: null, status: null, loadedCount: null, groups: [], gtotal: 0,
            persons: [], showHidden: false, recent: [], recentKey: "", vlist: [], vidx: -1, vfrom: "grid", vChanged: false };

// ---------- helpers ----------
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = n => (n || 0).toLocaleString();
function gb(b) {
  b = b || 0;
  if (b >= 1e9) return (b / 1e9).toFixed(b >= 1e10 ? 0 : 1) + " GB";
  if (b >= 1e6) return (b / 1e6).toFixed(b >= 1e8 ? 0 : 1) + " MB";
  return Math.round(b / 1e3) + " KB";
}
function dur(s) {
  if (s == null) return "";
  s = Math.round(s);
  if (s < 60) return s + " s";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}
const clip = s => { s = Math.round(s || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const day = t => t ? new Date(t * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;
const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
                set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private window */ } } };
async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
let toastT;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2600);
}
function confirmBox(title, text, ok = "Yes", danger = true) {
  return new Promise(res => {
    const m = $("#confirm");
    $("#cTitle").textContent = title; $("#cText").textContent = text;
    const b = $("#cOk"); b.textContent = ok; b.className = "btn " + (danger ? "danger" : "primary");
    m.hidden = false; b.focus();
    const done = v => { m.hidden = true; b.onclick = null; m.onclick = null; res(v); };
    b.onclick = () => done(true);
    m.onclick = e => { if (e.target === m || e.target.closest("[data-close]")) done(false); };
  });
}

// what the photo is now: your choice wins over the tool's suggestion
function state(it) {
  if (it.user_decision === "delete") return it.gone ? "gone" : "approved";
  if (it.user_decision === "keep") return "kept";
  return it.decision || "pending";
}
function flagHtml(it) {
  const s = state(it);
  if (s === "approved") return `<span class="flag mine delete">Approved for delete</span>`;
  if (s === "gone") return `<span class="flag mine delete">Deleted in Google</span>`;
  if (s === "kept") return `<span class="flag mine keep">You: keep</span>`;
  if (s === "pending") return `<span class="flag">${it.status === "skipped" ? "Your call" : "Processing"}</span>`;
  return `<span class="flag ${s}">${{ keep: "Suggested keep", delete: "Suggested delete", unsure: "Not sure" }[s]}</span>`;
}
// does a photo still belong on this page after a change?
function belongs(view, it) {
  const ud = it.user_decision, d = it.decision;
  return {
    delete: !ud && d === "delete", unsure: !ud && d === "unsure", keep: ud === "keep" || (!ud && d === "keep"),
    approved: ud === "delete" && !it.gone, deleted: ud === "delete" && !!it.gone, pending: !ud && !d, long: !ud,
  }[view] ?? true;
}
function tagLine(it) {
  if (it.status === "skipped") return `Long video, ${dur(it.duration)}. Play it and decide`;
  const bits = [];
  if (it.type) bits.push(nm(it.type));
  if (it.event) bits.push(nm(it.event));
  (it.tags || "").split(",").filter(t => t && !["people", "celebration"].includes(t)).slice(0, 2).forEach(t => bits.push(nm(t)));
  return bits.join(", ");
}
function query(extra = {}) {
  const v = VIEWS[S.view];
  const q = new URLSearchParams({ view: v.api || "all", sort: S.sort, ...extra });
  for (const k of FILTERS) if (S.f[k]) q.set(k, S.f[k]);
  if (S.bucket) q.set("bucket", S.bucket);
  if (S.person) q.set("person", S.person.id);
  if (S.q) q.set("q", S.q);
  if (S.view === "map") q.set("geo", "1");
  if (S.bbox) q.set("bbox", S.bbox.join(","));
  return q;
}

// ---------- decisions ----------
async function decide(ids, decision) {
  ids = [...new Set(ids)].filter(Boolean);
  if (ids.length) await api("/api/decide", { ids, decision });
}
async function setGone(ids, gone) { if (ids.length) await api("/api/gone", { ids, gone }); }
const DONE_WORD = { keep: "Keeping", delete: "Approved for delete", null: "Back to the suggestion" };

// apply a choice to photos shown in the grid, and update or remove their tiles
async function act(ids, decision) {
  await decide(ids, decision);
  for (const id of ids) {
    const it = S.items.find(x => x.id === id);
    if (it) it.user_decision = decision;
  }
  refreshTiles(ids);
  toast(`${DONE_WORD[decision]}${ids.length > 1 ? `: ${num(ids.length)} photos` : ""}`);
  pollOnce();
}
function refreshTiles(ids) {
  for (const id of ids) {
    const el = $(`#grid .tile[data-id="${id}"]`), it = S.items.find(x => x.id === id);
    if (!el || !it) continue;
    if (!belongs(S.view, it)) {
      el.remove(); S.items = S.items.filter(x => x.id !== id); S.total = Math.max(0, S.total - 1);
      S.bytes = Math.max(0, S.bytes - (it.bytes || 0)); S.sel.delete(id);
    } else el.outerHTML = tile(it);
  }
  updateSel(); renderListMeta();
  if (!S.items.length) $("#grid").innerHTML = emptyHtml();
}

// ---------- theme ----------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $("#themeBtn").textContent = t === "dark" ? "Light mode" : "Dark mode";
}
applyTheme(store.get("theme", matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
$("#themeBtn").onclick = () => { const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; applyTheme(t); store.set("theme", t); };

// ---------- grid preferences: size, whole photo, reasons ----------
function applyGridPrefs() {
  const size = +store.get("size", 2), square = store.get("square", "0") === "1", cap = store.get("cap", "1") === "1";
  $("#sizeIn").value = size; $("#fitIn").checked = square; $("#capIn").checked = cap;
  document.documentElement.style.setProperty("--tile", SIZES[size - 1] + "px");
  $("#listPage").classList.toggle("square", square);
  $("#listPage").classList.toggle("nocap", !cap);
  S.size = size; S.square = square;
}
applyGridPrefs();
$("#sizeIn").oninput = e => { store.set("size", e.target.value); const was = S.size; applyGridPrefs(); if (S.square && (was >= 4) !== (S.size >= 4)) rerenderGrid(); };
$("#fitIn").onchange = e => { store.set("square", e.target.checked ? "1" : "0"); applyGridPrefs(); rerenderGrid(); };
$("#capIn").onchange = e => { store.set("cap", e.target.checked ? "1" : "0"); applyGridPrefs(); };
// Square tiles use the small square thumbnail; the Google-style layout needs the uncropped preview to keep each photo's shape.
const imgSrc = it => S.square && S.size < 4 ? `/thumb/${it.id}` : `/preview/${it.id}`;
// width / height of a photo, kept within limits so a panorama or a very tall screenshot can't take over a row
const clampAr = r => Math.min(2.6, Math.max(0.45, r || 1)).toFixed(3);
const tileAr = it => clampAr(it.w && it.h ? it.w / it.h : 1);
// The stored size can ignore phone rotation, so once the preview loads its real shape wins.
document.addEventListener("load", e => {
  const img = e.target;
  if (S.square || img.tagName !== "IMG" || !img.naturalWidth) return;
  const t = img.closest("#grid .tile");
  if (t) t.style.setProperty("--ar", clampAr(img.naturalWidth / img.naturalHeight));
}, true);

// ---------- grid animation when the list changes (photos glide to their new place, new ones grow in) ----------
const calm = matchMedia("(prefers-reduced-motion: reduce)");
function gridSnapshot() {
  const out = new Map();
  if (calm.matches || $("#grid").hidden) return out;
  const vh = innerHeight;
  $$("#grid .tile").forEach(el => { const r = el.getBoundingClientRect(); if (r.bottom > 0 && r.top < vh) out.set(el.dataset.id, r); });
  return out;
}
function gridAnimate(before) {
  if (calm.matches || $("#grid").hidden) return;
  const vh = innerHeight; let n = 0;
  $$("#grid .tile").forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > vh) return;
    const old = before.get(el.dataset.id);
    if (old && r.width) {
      const dx = old.left - r.left, dy = old.top - r.top, sx = old.width / r.width, sy = old.height / r.height;
      el.animate([{ transformOrigin: "0 0", transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` }, { transformOrigin: "0 0", transform: "none" }],
        { duration: 420, easing: "cubic-bezier(.2, 0, 0, 1)" });
    } else {
      el.animate([{ opacity: 0, transform: "scale(.6)" }, { opacity: 1, transform: "none" }],
        { duration: 340, delay: Math.min(n++ * 14, 320), easing: "cubic-bezier(.2, 0, 0, 1)", fill: "backwards" });
    }
  });
}

// ---------- status (polled) ----------
async function pollStatus() {
  try {
    S.status = await api("/api/status");
    renderStatus(S.status);
    if (S.view === "overview") renderOverview();
    else maybeRefreshView();
  } catch {
    $("#runMsg").textContent = "Lost connection to Google Photo Cleaner. Is it still running?";
  }
  setTimeout(pollStatus, S.status?.run?.running ? 1500 : 4000);
}
async function pollOnce() { try { S.status = await api("/api/status"); renderStatus(S.status); if (S.view === "overview") renderOverview(); } catch { /* next poll */ } }

function renderStatus(st) {
  const r = st.run, c = st.counts;
  $("#inputCode").textContent = st.input;
  const btn = $("#runBtn");
  if (r.running) { btn.textContent = r.stopping ? "Pausing…" : "Pause"; btn.disabled = r.stopping; btn.className = "btn"; }
  else { btn.disabled = false; btn.className = "btn primary"; btn.textContent = !c.files ? "Start" : (c.pending || c.scanned < c.files) ? "Continue" : "Check for new files"; }
  // when nothing is running, say what to do next rather than repeating the last step's message
  const idle = !r.running && ["idle", "done", "paused"].includes(r.phase);
  $("#runMsg").textContent = !idle ? (r.message || "")
    : !c.files ? "Pick your photos folder, then press Start."
    : c.pending || c.scanned < c.files ? (r.phase === "paused" ? "Paused. Press Continue to carry on." : "Press Continue to finish the remaining photos.")
    : "All photos are processed. Review the suggestions.";
  const meta = [];
  const si = st.steps.findIndex(s => s[0] === r.phase);
  if (r.running && si >= 0) meta.push(`Step ${si + 1} of ${st.steps.length}: ${st.steps[si][1]}`);
  if (r.running && r.per_min) meta.push(`${num(r.per_min)} per minute`);
  if (r.running && r.eta_s != null) meta.push(`about ${dur(r.eta_s)} left in this step`);
  if (!r.running && c.files) meta.push(`${plural(c.items, "photo or video", "photos and videos")}, ${gb(c.bytes)}`);
  if (!r.running && c.s_long) meta.push(`${plural(c.s_long, "long video", "long videos")} for you to review`);
  $("#runMeta").textContent = meta.join(", ") || st.input;
  $(".run-bar").classList.toggle("busy", r.running && !r.total);
  const pct = r.running && r.total ? r.done / r.total * 100 : c.items ? (c.items - c.pending) / c.items * 100 : 0;
  $("#runFill").style.width = Math.min(100, pct).toFixed(1) + "%";
  // banner: only when something needs doing outside the dashboard
  const m = st.models, missing = [!m.siglip && "the tagging model", !m.faces && "the face models", !m.ocr && "the text reader"].filter(Boolean);
  let b = "";
  if (missing.length) b = `Not downloaded yet: ${missing.join(", ")}. Run the setup again (setup.ps1 or setup.sh), or restart the Docker container.`;
  else if (r.phase === "waiting" || r.phase === "error") b = esc(r.message);
  const banner = $("#banner"); banner.innerHTML = b; banner.hidden = !b;
  const set = (id, n) => { $(id).textContent = n ? num(n) : ""; };
  set("#nDel", c.s_delete); set("#nUns", c.s_unsure); set("#nGrp", c.groups); set("#nLong", c.s_long); set("#nAll", c.items); set("#nKeep", c.keep);
  set("#nPpl", c.people); set("#nMap", c.located); set("#nAppr", c.approved); set("#nGone", c.gone); set("#nPend", c.pending);
  $("#navPending").hidden = !c.pending;
  $("#freed").innerHTML = c.gone ? `<b>${gb(c.gone_bytes)}</b> deleted in Google so far. Empty the trash there to get the space back.`
    : c.approved ? `<b>${gb(c.approved_bytes)}</b> on your delete list.` : c.s_delete ? `<b>${gb(c.s_delete_bytes)}</b> could be freed.` : "";
}

// ---------- overview ----------
function renderOverview() {
  const st = S.status; if (!st) return;
  const r = st.run, c = st.counts;
  let h;
  if (!c.files) {
    h = `<h1>Find what you can delete from your Google Photos.</h1>
      <p>Pick the folder with your unzipped Google Takeout, then press Start. Everything runs on this computer, and nothing is deleted until you say so.</p>
      <div class="hero-actions"><button class="btn primary" data-pick>Choose folder</button><button class="btn" data-run>Start</button></div>
      <p class="muted small" style="margin-top:12px">Now using: ${esc(st.input)}</p>`;
  } else if (!c.s_delete && !c.s_unsure && (r.running || c.pending)) {
    const si = st.steps.findIndex(s => s[0] === r.phase);
    const left = r.eta_s != null ? `, about ${dur(r.eta_s)} left in this step` : "";
    h = r.running && si >= 0
      ? `<h1>Step ${si + 1} of ${st.steps.length}: ${esc(st.steps[si][1])}</h1>
         <p>${r.total ? `${num(r.done)} of ${num(r.total)} done${left}. ` : ""}Suggestions appear as each photo is done. You can start reviewing before it finishes.</p>`
      : `<h1>Paused.</h1>
         <p>${num(c.items - c.pending)} of ${plural(c.items, "photo or short video has", "photos and short videos have")} a suggestion so far. Press Continue to carry on.</p>`;
  } else {
    h = `<h1>You could free up ${gb(c.s_delete_bytes)}.</h1>
      <p>${plural(c.s_delete, "photo looks", "photos look")} safe to delete, and ${plural(c.s_unsure, "needs", "need")} a quick look. Nothing is deleted until you approve it and remove it in Google Photos.</p>
      <div class="hero-actions">
        <a class="btn primary" href="#delete">Review suggestions</a>
        ${c.s_unsure ? `<a class="btn" href="#unsure">Not sure (${num(c.s_unsure)})</a>` : ""}
        ${c.approved ? `<a class="btn" href="#approved">Delete list (${num(c.approved)})</a>` : ""}
      </div>`;
  }
  if ($("#hero").dataset.h !== h) { $("#hero").innerHTML = h; $("#hero").dataset.h = h; }

  const phase = st.steps.findIndex(s => s[0] === r.phase);
  $("#steps").innerHTML = st.steps.map(([key, label], i) => {
    const [d, t] = STEP_DONE[key](c);
    const on = r.running && i === phase;
    const done = r.running ? i < phase : (t ? d >= t && t > 0 : d > 0) || r.phase === "done";
    return `<li class="${on ? "on" : done ? "done" : ""}"><span>${esc(label)}</span><em>${t ? `${num(d)} / ${num(t)}` : d ? num(d) : ""}</em></li>`;
  }).join("");

  const T = (view, n, l, s) => `<button class="tally" data-go="${view}"><div class="n">${num(n)}</div><div class="l">${l}</div>${s ? `<div class="s">${s}</div>` : ""}</button>`;
  $("#tallies").innerHTML = [
    T("all", c.items, "Photos and videos", gb(c.bytes)),
    T("delete", c.s_delete, "To delete", gb(c.s_delete_bytes)),
    T("unsure", c.s_unsure, "Not sure", gb(c.s_unsure_bytes)),
    T("groups", c.groups, "Duplicate groups", ""),
    T("long", c.s_long, "Long videos to review", gb(c.s_long_bytes)),
    T("people", c.people, "People", `${num(c.with_faces)} photos with faces`),
    T("approved", c.approved, "On the delete list", gb(c.approved_bytes)),
  ].join("");
}
async function pollRecent() {
  if (S.view === "overview") {
    try {
      const rec = await api("/api/recent");
      const key = rec.items.map(r => r.id + (r.decision || "") + (r.user_decision || "")).join(",");
      if (key !== S.recentKey) {
        S.recentKey = key; S.recent = rec.items;
        $("#feed").innerHTML = rec.items.length ? rec.items.map((it, i) => {
          const s = state(it), d = s === "approved" || s === "gone" ? "delete" : s === "kept" ? "keep" : s;
          return `<button data-feed="${i}" title="${esc(it.reason || tagLine(it))}"><img src="/thumb/${it.id}" alt=""><span class="dot ${d}"></span></button>`;
        }).join("") : `<div class="empty">Photos show up here as each step finishes them.</div>`;
        $("#feedNote").textContent = rec.items.length ? "Click one to open it" : "";
      }
    } catch { /* next round */ }
  }
  setTimeout(pollRecent, S.status?.run?.running ? 2000 : 6000);
}

// ---------- routing ----------
function go(view, keepFilters = false) {
  if (!VIEWS[view]) view = "overview";
  const changed = view !== S.view;
  S.view = view;
  if (changed && !keepFilters) { S.bucket = ""; S.person = null; if (view !== "map") S.bbox = null; }
  if (changed) { S.sel.clear(); if (VIEWS[view].sort) S.sort = S.q ? "relevance" : VIEWS[view].sort; }
  $$(".nav-item").forEach(a => a.classList.toggle("on", a.dataset.view === view));
  $("#nav").classList.remove("open");
  const ov = view === "overview";
  $("#overviewPage").hidden = !ov; $("#listPage").hidden = ov;
  updateSel();
  if (ov) { S.recentKey = ""; renderOverview(); return; }
  $("#pageTitle").textContent = VIEWS[view].title;
  $("#hint").textContent = VIEWS[view].hint || "";
  $("#sortSel").value = S.sort;
  renderGPanel();
  loadView(true);
  window.scrollTo({ top: 0 });
}
window.addEventListener("hashchange", () => go(location.hash.slice(1) || "overview"));
$("#menuBtn").onclick = () => $("#nav").classList.toggle("open");
document.addEventListener("click", e => {
  const g = e.target.closest("[data-go]"); if (g) location.hash = g.dataset.go;
  if (e.target.closest("[data-run]")) $("#runBtn").click();
  if (e.target.closest("[data-pick]")) openPicker();
  const f = e.target.closest("[data-feed]"); if (f) openViewer(S.recent, +f.dataset.feed, "feed");
});

// ---------- list pages ----------
function emptyHtml() {
  const v = S.view, running = S.status?.run?.running;
  const filtered = S.q || S.bucket || FILTERS.some(k => S.f[k]) || S.bbox;
  const msg = {
    delete: ["Nothing left to review here.", running ? "More suggestions appear as photos are processed." : "Check Not sure next, or your delete list."],
    unsure: ["Nothing waiting for you here.", ""],
    long: ["No long videos left to review.", "The ones you chose are in Keeping and the Delete list."],
    approved: ["Your delete list is empty.", "Approve photos in To delete to add them here."],
    deleted: ["Nothing deleted in Google yet.", "Photos move here once they're deleted in Google Photos."],
  }[v] || [running ? "Nothing here yet." : "Nothing matches.", filtered ? "Try clearing the filters." : ""];
  return `<div class="empty"><b>${msg[0]}</b>${msg[1]}</div>`;
}
function tile(it) {
  const s = state(it), sel = S.sel.has(it.id);
  const mine = s === "approved" || s === "gone" ? "mine mine-del" : s === "kept" ? "mine mine-keep" : "";
  const listView = ["approved", "deleted"].includes(S.view);
  const quick = listView
    ? (it.gurl ? `<a class="qbtn" href="${esc(it.gurl)}" target="_blank" rel="noopener" data-stop>Open in Google</a>` : "")
    : `<button class="qbtn k${s === "kept" ? " on" : ""}" data-q="keep" title="Keep (K)">Keep</button>
       <button class="qbtn d${s === "approved" ? " on" : ""}" data-q="delete" title="Approve for delete (D)">Delete</button>`;
  const badges = [it.kind === "video" ? `▶ ${clip(it.duration)}` : "", it.face_count ? `${it.face_count} ${it.face_count > 1 ? "people" : "person"}` : ""].filter(Boolean);
  const keeper = it.keeper && !listView ? `<span class="keeper-thumb" title="The copy suggested to keep. Open this photo to compare them"><img src="/thumb/${it.keeper}" alt=""><span>Kept copy</span></span>` : "";
  return `<div class="tile ${mine}${sel ? " sel" : ""}${s === "gone" ? " gone" : ""}" data-id="${it.id}" style="--ar:${tileAr(it)}" tabindex="0">
    <div class="pic"><img src="${imgSrc(it)}" loading="lazy" alt="">
      <span class="tick">${sel ? "✓" : ""}</span>
      <div class="quick">${quick}<button class="qbtn" data-open title="Open (Enter)">Open</button></div>
      ${badges.length ? `<div class="badges">${badges.map(b => `<span class="badge">${b}</span>`).join("")}</div>` : ""}
      ${keeper}
    </div>
    <div class="cap"><div class="r">${esc(it.reason || tagLine(it))}</div><div class="z"><span>${gb(it.bytes)}${it.taken ? ", " + day(it.taken) : ""}</span>${flagHtml(it)}</div></div>
  </div>`;
}
function rerenderGrid() { if (!$("#grid").hidden && S.items.length) $("#grid").innerHTML = S.items.map(tile).join(""); }
function renderListMeta() {
  const v = VIEWS[S.view];
  const txt = v.mode === "groups" ? plural(S.gtotal, "group", "groups")
    : `${S.view === "long" ? plural(S.total, "video", "videos") : plural(S.total, "photo", "photos")}, ${gb(S.bytes)}` + (S.bbox ? ", in the area picked on the map" : "");
  $("#viewCount").textContent = txt; $("#pageSub").textContent = txt;
  const a = [], n = S.total, scoped = S.bucket || S.q || FILTERS.some(k => S.f[k]) || S.person || S.bbox;
  const shown = scoped ? " shown" : "";
  if (n && ["delete", "unsure"].includes(S.view)) a.push(`<button class="btn keep-outline" data-bulk="keep">Keep all ${num(n)}${shown}</button>`, `<button class="btn danger" data-bulk="delete">Approve all ${num(n)}${shown} for delete</button>`);
  if (n && ["all", "people", "map", "keep", "long"].includes(S.view) && scoped) a.push(`<button class="btn danger" data-bulk="delete">Approve all ${num(n)} shown for delete</button>`);
  if (S.view === "groups" && S.gtotal) a.push(`<button class="btn danger" data-allgroups>Use every suggestion</button>`);
  if (["approved", "deleted"].includes(S.view)) a.push(`<a class="btn" href="/api/export.csv">Download the list</a>`);
  $("#pageActions").innerHTML = a.join("");
}

async function loadView(reset = true) {
  if (S.loading) return;
  S.loading = true;
  try {
    const v = VIEWS[S.view];
    const mode = v.mode === "groups" ? "groups" : v.mode === "people" && !S.person ? "people" : "grid";
    $("#grid").hidden = mode !== "grid"; $("#groups").hidden = mode !== "groups"; $("#people").hidden = mode !== "people";
    $("#toolbar").hidden = mode === "people"; $("#chips").hidden = mode !== "grid";
    $(".filters").hidden = mode !== "grid"; $(".search").hidden = mode !== "grid" || S.view === "long";  // search reads the tagging model, which skips long videos
    $("#selHint").hidden = mode !== "grid";
    $(".list-meta").hidden = mode === "people";
    $("#mapWrap").hidden = S.view !== "map";
    renderPersonHead();
    if (S.view === "map" && reset) loadMap();
    if (mode === "groups") return await loadGroups(reset);
    if (mode === "people") { $("#pageActions").innerHTML = ""; $("#pageSub").textContent = ""; return await loadPeople(); }
    const offset = reset ? 0 : S.items.length;
    if (reset) loadFacets();
    const r = await api("/api/items?" + query({ offset, limit: 120 }));
    S.items = reset ? r.items : S.items.concat(r.items);
    S.total = r.total; S.bytes = r.bytes;
    S.loadedCount = S.status && v.count ? S.status.counts[v.count] : null;
    renderListMeta();
    const html = r.items.map(tile).join("");
    if (reset) { const before = gridSnapshot(); $("#grid").innerHTML = html || emptyHtml(); gridAnimate(before); }
    else $("#grid").insertAdjacentHTML("beforeend", html);
    $("#more").textContent = S.items.length < S.total ? "Loading more…" : "";
    $("#refreshNote").hidden = true;
  } catch (e) { toast(e.message); }
  finally { S.loading = false; }
}
function maybeRefreshView() {
  const v = VIEWS[S.view];
  if (!v || !v.count || S.loadedCount == null || !S.status) return;
  if (S.status.counts[v.count] === S.loadedCount) return;
  const busy = S.sel.size || !$("#viewer").hidden || S.items.length > 120 || window.scrollY > 500;
  if (busy) $("#refreshNote").hidden = false; else loadView(true);
}
$("#refreshNote").onclick = () => loadView(true);
new IntersectionObserver(es => {
  if (!es[0].isIntersecting || S.loading || !S.view || S.view === "overview") return;
  if (S.view === "groups" ? S.groups.length < S.gtotal : S.items.length < S.total) loadView(false);
}, { rootMargin: "800px" }).observe($("#more"));

// grid: click selects, the buttons on a photo decide, double-click or Enter opens
$("#grid").addEventListener("click", e => {
  if (e.target.closest("[data-stop]")) return;
  const t = e.target.closest(".tile"); if (!t) return;
  const id = +t.dataset.id, i = S.items.findIndex(x => x.id === id);
  const q = e.target.closest("[data-q]");
  if (q) { const want = q.dataset.q; return act([id], S.items[i].user_decision === want ? null : want); }
  if (e.target.closest("[data-open]")) return openViewer(S.items, i, "grid");
  if (e.shiftKey && S.last != null) {
    const a = Math.min(S.last, i), b = Math.max(S.last, i);
    for (let k = a; k <= b; k++) S.sel.add(S.items[k].id);
  } else if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id);
  S.last = i;
  markSel(); updateSel();
});
$("#grid").addEventListener("dblclick", e => { const t = e.target.closest(".tile"); if (t && !e.target.closest("button, a")) openViewer(S.items, S.items.findIndex(x => x.id === +t.dataset.id), "grid"); });
$("#grid").addEventListener("keydown", e => {
  const t = e.target.closest(".tile"); if (!t || e.target !== t) return;
  const id = +t.dataset.id, it = S.items.find(x => x.id === id);
  const k = e.key.toLowerCase();
  if (k === "enter") openViewer(S.items, S.items.indexOf(it), "grid");
  else if (k === " ") { e.preventDefault(); S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id); markSel(); updateSel(); }
  else if (k === "k" && !["approved", "deleted"].includes(S.view)) act([id], it.user_decision === "keep" ? null : "keep");
  else if (k === "d" && !["approved", "deleted"].includes(S.view)) act([id], it.user_decision === "delete" ? null : "delete");
});
function markSel() {
  $$("#grid .tile").forEach(el => { const s = S.sel.has(+el.dataset.id); el.classList.toggle("sel", s); $(".tick", el).textContent = s ? "✓" : ""; });
  $("#grid").classList.toggle("selecting", S.sel.size > 0);
}

// the selection bar
function updateSel() {
  const n = S.sel.size;
  $("#selbar").hidden = !n || S.view === "overview";
  if (!n) { $("#grid").classList.remove("selecting"); return; }
  $("#selCount").textContent = plural(n, "photo selected", "photos selected");
  const b = [];
  if (S.view === "approved") b.push(`<button class="btn" data-sa="gone">Mark deleted in Google</button>`, `<button class="btn" data-sa="reset">Take off the list</button>`);
  else if (S.view === "deleted") b.push(`<button class="btn" data-sa="notgone">Not deleted yet</button>`);
  else b.push(`<button class="btn keep" data-sa="keep">Keep</button>`, `<button class="btn danger" data-sa="delete">Approve for delete</button>`);
  $("#selActions").innerHTML = b.join("");
}
$("#selClear").onclick = () => { S.sel.clear(); markSel(); updateSel(); };
$("#selAll").onclick = () => { S.items.forEach(it => S.sel.add(it.id)); markSel(); updateSel(); };
$("#selActions").addEventListener("click", async e => {
  const a = e.target.closest("[data-sa]")?.dataset.sa; if (!a) return;
  const ids = [...S.sel]; S.sel.clear();
  if (a === "gone" || a === "notgone") {
    await setGone(ids, a === "gone");
    ids.forEach(id => { const it = S.items.find(x => x.id === id); if (it) it.gone = a === "gone" ? 1 : 0; });
    refreshTiles(ids); toast(a === "gone" ? "Marked as deleted in Google" : "Back on the delete list"); pollOnce();
  } else await act(ids, a === "reset" ? null : a);
  markSel(); updateSel();
});

// bulk buttons in the page header
$("#pageActions").addEventListener("click", async e => {
  if (e.target.closest("[data-allgroups]")) {
    if (!(await confirmBox("Use every duplicate suggestion?", `In all ${num(S.gtotal)} groups, the copies the tool didn't pick go on your delete list. Copies you chose to keep stay kept.`, "Use every suggestion"))) return;
    const all = await api(`/api/groups?offset=0&limit=100000`);
    const spares = all.groups.flatMap(g => g.members.filter(m => !m.dup_best && m.user_decision !== "keep").map(m => m.id));
    await decide(spares, "delete"); toast(`${plural(spares.length, "copy", "copies")} approved for delete`);
    loadView(true); pollOnce(); return;
  }
  const a = e.target.closest("[data-bulk]")?.dataset.bulk; if (!a) return;
  const ok = await confirmBox(a === "delete" ? `Approve ${plural(S.total, "photo", "photos")} for delete?` : `Keep ${plural(S.total, "photo", "photos")}?`,
    a === "delete" ? `All ${num(S.total)} shown (${gb(S.bytes)}) go on your delete list, including ones you haven't looked at. Photos you already chose to keep stay kept, and you can take any of them off the list later.`
                   : `All ${num(S.total)} shown move to Keeping.`, a === "delete" ? "Approve for delete" : "Keep all", a === "delete");
  if (!ok) return;
  const r = await api("/api/decide", { ...Object.fromEntries(query()), decision: a });
  toast(`${plural(r.changed, "photo", "photos")} updated`);
  loadView(true); pollOnce();
});

// ---------- filters, search, chips ----------
async function loadFacets() {
  try {
    const f = await api("/api/facets?" + query());
    const fill = (id, key, list, label) => {
      const cur = S.f[key] || "";
      $(id).innerHTML = `<option value="">${label}</option>` + list.map(x =>
        `<option value="${esc(x.k ?? "")}"${String(x.k) === cur ? " selected" : ""}>${esc(key === "year" ? (x.k || "No date") : nm(x.k))} (${num(x.n)})</option>`).join("");
    };
    fill("#fType", "type", f.type.filter(x => x.k), "Any type");
    fill("#fEvent", "event", f.event, "Any event");
    fill("#fTag", "tag", f.tag, "Any tag");
    fill("#fYear", "year", f.year.filter(x => x.k), "Any year");
    const all = f.bucket.reduce((a, b) => a + b.n, 0);
    $("#chips").innerHTML = (f.bucket.length > 1 || S.bucket) && ["delete", "unsure", "keep", "approved"].includes(S.view)
      ? `<button class="chip${S.bucket ? "" : " on"}" data-b="">Everything <b>${num(all)}</b></button>` +
        f.bucket.map(b => `<button class="chip${S.bucket === b.k ? " on" : ""}" data-b="${esc(b.k || "")}">${esc(nm(b.k))} <b>${num(b.n)}</b> ${gb(b.b)}</button>`).join("")
      : "";
  } catch (e) { toast(e.message); }
  $("#clearFilters").hidden = !(FILTERS.some(k => S.f[k]) || S.q || S.bucket || S.bbox);
}
$$(".filters select[data-f]").forEach(s => s.onchange = () => { S.f[s.dataset.f] = s.value; S.sel.clear(); updateSel(); loadView(true); });
$("#sortSel").onchange = e => { S.sort = e.target.value; loadView(true); };
$("#searchForm").onsubmit = e => {
  e.preventDefault();
  S.q = $("#searchIn").value.trim();
  if (S.q) { S.sort = "relevance"; toast("Searching. The first search loads the model, so give it a few seconds"); }
  else if (S.sort === "relevance") S.sort = VIEWS[S.view].sort || "date";
  $("#sortSel").value = S.sort;
  loadView(true);
};
$("#clearFilters").onclick = () => {
  S.f = {}; S.q = ""; S.bucket = ""; S.bbox = null; $("#searchIn").value = "";
  if (M.rect && M.map) { M.map.removeLayer(M.rect); M.rect = null; }
  $$(".filters select[data-f]").forEach(s => (s.value = "")); loadView(true);
};
$("#chips").addEventListener("click", e => { const c = e.target.closest("[data-b]"); if (!c) return; S.bucket = c.dataset.b; S.sel.clear(); updateSel(); loadView(true); });

// ---------- duplicates: pick the keeper yourself ----------
function gcard(m, g) {
  const s = state(m);
  const cls = s === "kept" ? "state-keep" : s === "approved" || s === "gone" ? "state-del" : "";
  const sugg = m.user_decision ? flagHtml(m) : m.dup_best ? `<span class="flag keep">Suggested keep</span>` : `<span class="flag delete">Suggested delete</span>`;
  return `<div class="gcard ${cls}" data-id="${m.id}">
    <div class="pic" data-open title="Open"><img src="/preview/${m.id}" loading="lazy" alt=""></div>
    <div class="meta"><span>${gb(m.bytes)}${m.w ? `, ${m.w}×${m.h}` : ""}${m.sharp != null ? `, sharpness ${Math.round(m.sharp)}` : ""}</span>${sugg}</div>
    <div class="acts">
      <span class="seg"><button class="k${s === "kept" ? " on" : ""}" data-gd="keep">Keep</button><button class="d${s === "approved" ? " on" : ""}" data-gd="delete">Delete</button></span>
      ${g.members.length > 1 ? `<button class="btn sm" data-only>Keep only this one</button>` : ""}
    </div>
  </div>`;
}
function groupHtml(g, gi) {
  const spares = g.members.filter(m => !m.dup_best);
  const exact = spares.length && spares.every(s => s.dup_kind === "exact");
  return `<div class="group" data-g="${gi}">
    <div class="group-h">
      <div><h2>${exact ? "Exact copies" : "Look-alike shots"}</h2><p>${plural(g.members.length, "photo", "photos")}, the extra copies take ${gb(g.spare)}</p></div>
      <div class="page-actions"><button class="btn sm" data-gact="keep">Keep all</button><button class="btn sm danger" data-gact="suggest">Use the suggestion</button></div>
    </div>
    <div class="group-row">${g.members.map(m => gcard(m, g)).join("")}</div>
  </div>`;
}
async function loadGroups(reset) {
  const offset = reset ? 0 : S.groups.length;
  const r = await api(`/api/groups?offset=${offset}&limit=20`);
  await Promise.all(r.groups.map(async g => {        // full members, with sharpness for comparing
    const full = await api(`/api/group?id=${g.g}`).catch(() => null);
    if (full) g.members = full;
  }));
  S.groups = reset ? r.groups : S.groups.concat(r.groups);
  S.gtotal = r.total;
  renderListMeta();
  const html = r.groups.map((g, k) => groupHtml(g, offset + k)).join("");
  if (reset) $("#groups").innerHTML = html || `<div class="empty"><b>No duplicates found.</b>${S.status?.run?.running ? "More may appear as photos are processed." : ""}</div>`;
  else $("#groups").insertAdjacentHTML("beforeend", html);
  $("#more").textContent = S.groups.length < S.gtotal ? "Loading more…" : "";
}
async function reloadGroup(gi) {
  const g = S.groups[gi]; if (!g) return;
  g.members = await api(`/api/group?id=${g.g}`);
  const el = $(`.group[data-g="${gi}"]`); if (el) el.outerHTML = groupHtml(g, gi);
  pollOnce();
}
async function keepOnly(members, id) {
  await decide([id], "keep");
  await decide(members.filter(m => m.id !== id).map(m => m.id), "delete");
}
$("#groups").addEventListener("click", async e => {
  const gEl = e.target.closest(".group"); if (!gEl) return;
  const gi = +gEl.dataset.g, g = S.groups[gi];
  const ga = e.target.closest("[data-gact]")?.dataset.gact;
  if (ga === "keep") { await decide(g.members.map(m => m.id), "keep"); toast("Keeping all of them"); return reloadGroup(gi); }
  if (ga === "suggest") {
    const spares = g.members.filter(m => !m.dup_best && m.user_decision !== "keep").map(m => m.id);
    await decide(spares, "delete"); toast(`${plural(spares.length, "copy", "copies")} approved for delete`); return reloadGroup(gi);
  }
  const card = e.target.closest(".gcard"); if (!card) return;
  const id = +card.dataset.id, m = g.members.find(x => x.id === id);
  if (e.target.closest("[data-only]")) { await keepOnly(g.members, id); toast("Keeping this one, the others are approved for delete"); return reloadGroup(gi); }
  const gd = e.target.closest("[data-gd]")?.dataset.gd;
  if (gd) { await decide([id], m.user_decision === gd ? null : gd); return reloadGroup(gi); }
  if (e.target.closest("[data-open]")) openViewer(g.members, g.members.indexOf(m), "group", gi);
});

// ---------- people ----------
async function loadPeople() {
  S.persons = await api("/api/people" + (S.showHidden ? "?hidden=1" : ""));
  $("#people").innerHTML = `
    <div class="people-bar"><span>${plural(S.persons.length, S.showHidden ? "hidden person" : "person", S.showHidden ? "hidden people" : "people")}, the most photos first</span>
      <button class="btn sm" id="toggleHidden">${S.showHidden ? "Back to people" : "Show hidden people"}</button></div>
    <div class="people-grid">${S.persons.map((p, i) => `
      <button class="person" data-p="${i}">
        <img src="/face/${p.cover_face}" alt="" loading="lazy">
        <div class="pn">${esc(p.name || "Person " + p.id)}${p.name_auto ? `<span class="auto" title="Name from your Google Photos face tags">G</span>` : ""}</div>
        <div class="pc">${plural(p.items, "photo", "photos")}${p.to_delete ? `, <span class="todel">${num(p.to_delete)} to delete</span>` : ""}</div>
      </button>`).join("") || `<div class="empty"><b>No people found${S.status?.run?.running ? " yet" : ""}.</b></div>`}</div>`;
  $("#more").textContent = "";
}
$("#people").addEventListener("click", e => {
  if (e.target.id === "toggleHidden") { S.showHidden = !S.showHidden; return loadPeople(); }
  const p = e.target.closest("[data-p]");
  if (p) { S.person = S.persons[+p.dataset.p]; S.f = {}; S.bucket = ""; S.sort = "date"; $("#sortSel").value = "date"; S.sel.clear(); updateSel(); loadView(true); }
});
function renderPersonHead() {
  const h = $("#personHead"), p = S.person;
  h.hidden = !(S.view === "people" && p);
  if (h.hidden) return;
  const others = S.persons.filter(x => x.id !== p.id);
  h.innerHTML = `
    <button class="btn sm" id="pBack">All people</button>
    <img src="/face/${p.cover_face}" alt="">
    <input id="pName" value="${esc(p.name || "")}" placeholder="Person ${p.id}: type a name" aria-label="Name">
    <button class="btn sm" id="pSave">Save name</button>
    <select id="pMerge"><option value="">Same person as…</option>${others.map(o => `<option value="${o.id}">${esc(o.name || "Person " + o.id)} (${num(o.items)})</option>`).join("")}</select>
    <button class="btn sm quiet" id="pHide">${p.hidden ? "Unhide" : "Hide, not someone I know"}</button>`;
}
$("#personHead").addEventListener("click", async e => {
  const p = S.person; if (!p) return;
  if (e.target.id === "pBack") { S.person = null; S.sel.clear(); updateSel(); return loadView(true); }
  if (e.target.id === "pSave") { p.name = $("#pName").value.trim() || null; await api("/api/person", { id: p.id, name: p.name }); toast("Name saved"); }
  if (e.target.id === "pHide") {
    await api("/api/person", { id: p.id, hidden: !p.hidden });
    toast(p.hidden ? "Unhidden" : "Hidden. Their photos are no longer protected as someone you know");
    S.person = null; loadView(true);
  }
});
$("#personHead").addEventListener("change", async e => {
  if (e.target.id !== "pMerge" || !e.target.value) return;
  const dst = S.persons.find(x => x.id === +e.target.value);
  if (!(await confirmBox("Merge these people?", `All faces of ${S.person.name || "Person " + S.person.id} move to ${dst.name || "Person " + dst.id}.`, "Merge", false))) { e.target.value = ""; return; }
  await api("/api/person/merge", { src: S.person.id, dst: dst.id });
  toast("Merged");
  S.persons = await api("/api/people");
  S.person = S.persons.find(x => x.id === dst.id) || null;
  loadView(true);
});
$("#personHead").addEventListener("keydown", e => { if (e.target.id === "pName" && e.key === "Enter") $("#pSave").click(); });

// ---------- map ----------
const M = { map: null, cluster: null, heat: null, rect: null, picking: false, start: null, fitted: false, points: [] };
const DOT = { keep: "#1f8457", delete: "#c5303c", unsure: "#b57612", approved: "#c5303c", pending: "#8b93a1" };
const AREA = { color: "#2b59c3", weight: 2, fillOpacity: 0.12, interactive: false };
function initMap() {
  if (M.map || typeof L === "undefined") return;
  M.map = L.map("map", { zoomControl: true, worldCopyJump: true, boxZoom: false }).setView([20, 0], 2);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(M.map);
  M.cluster = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 45, chunkedLoading: true });
  M.map.addLayer(M.cluster);
  // drag a box; listen on the map's own box so dots and clusters can't swallow the drag
  const box = $("#map"), at = e => M.map.mouseEventToLatLng(e);
  box.addEventListener("pointerdown", e => {
    if (e.button !== 0 || !(M.picking || e.shiftKey)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (!M.picking) setPicking(true);
    M.start = at(e);
    try { box.setPointerCapture(e.pointerId); } catch { /* fine without */ }
    if (M.rect) M.map.removeLayer(M.rect);
    M.rect = L.rectangle([M.start, M.start], AREA).addTo(M.map);
  }, true);
  box.addEventListener("pointermove", e => { if (!M.start || !M.rect) return; e.preventDefault(); e.stopImmediatePropagation(); M.rect.setBounds([M.start, at(e)]); }, true);
  const finish = e => {
    if (!M.start) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const b = L.latLngBounds(M.start, at(e));
    M.start = null; setPicking(false);
    try { box.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (M.map.latLngToContainerPoint(b.getNorthEast()).distanceTo(M.map.latLngToContainerPoint(b.getSouthWest())) < 8) { if (M.rect) M.map.removeLayer(M.rect); M.rect = null; return; }
    S.bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map(x => +x.toFixed(6));
    S.sel.clear(); updateSel(); loadView(true);
    setTimeout(() => $("#toolbar").scrollIntoView({ behavior: "smooth", block: "start" }), 250);
  };
  box.addEventListener("pointerup", finish, true);
  box.addEventListener("pointercancel", finish, true);
}
function setPicking(on) {
  M.picking = on;
  if (!M.map) return;
  on ? M.map.dragging.disable() : M.map.dragging.enable();
  $("#map").classList.toggle("picking", on);
  $("#mapSelect").textContent = on ? "Now drag a box on the map (press again to cancel)" : "Select an area";
}
async function loadMap() {
  initMap();
  if (!M.map) { $("#mapInfo").textContent = "The map couldn't load."; return; }
  setTimeout(() => M.map.invalidateSize(), 60);
  const q = query(); q.delete("bbox"); q.delete("sort");
  M.points = await api("/api/geo?" + q).catch(() => []);
  M.cluster.clearLayers();
  M.cluster.addLayers(M.points.map(p => {
    const mk = L.circleMarker([p.lat, p.lon], { radius: 7, color: "#fff", weight: 1.5, fillColor: DOT[p.d] || DOT.pending, fillOpacity: 0.95 });
    mk.on("click", () => openViewer([{ id: p.id }], 0, "map"));
    return mk;
  }));
  if (M.heat) { M.map.removeLayer(M.heat); M.heat = null; }
  if ($("#mapHeat").checked && L.heatLayer) M.heat = L.heatLayer(M.points.map(p => [p.lat, p.lon, 1]), { radius: 22, blur: 18, maxZoom: 12 }).addTo(M.map);
  $("#mapInfo").textContent = plural(M.points.length, "photo with a location", "photos with a location");
  if (!M.fitted && S.bbox) { const [s, w, n, e] = S.bbox; M.map.fitBounds([[s, w], [n, e]]); M.fitted = true; }
  if (M.points.length && !M.fitted) { M.map.fitBounds(L.latLngBounds(M.points.map(p => [p.lat, p.lon])).pad(0.1)); M.fitted = true; }
  if (S.bbox) { if (M.rect) M.map.removeLayer(M.rect); const [s, w, n, e] = S.bbox; M.rect = L.rectangle([[s, w], [n, e]], AREA).addTo(M.map); }
  $("#mapClear").hidden = $("#mapOpen").hidden = !S.bbox;
}
$("#mapSelect").onclick = () => setPicking(!M.picking);
$("#mapHeat").onchange = () => loadMap();
$("#mapOpen").onclick = () => { const q = query(); q.delete("view"); q.delete("geo"); q.delete("sort"); window.open("/?" + q.toString() + "#all", "_blank"); };
$("#mapClear").onclick = () => { S.bbox = null; if (M.rect) { M.map.removeLayer(M.rect); M.rect = null; } $("#mapClear").hidden = $("#mapOpen").hidden = true; S.sel.clear(); updateSel(); loadView(true); };

// ---------- the photo viewer ----------
async function openViewer(list, i, from, gi) {
  if (i < 0 || !list[i]) return;
  S.vlist = list; S.vidx = i; S.vfrom = from; S.vgroup = gi; S.vfocus = null; S.vpeek = null;
  $("#viewer").hidden = false;
  await renderViewer();
}
function closeViewer() {
  $("#viewer").hidden = true;
  const v = $("#stage video"); if (v) v.pause();
  $("#stage").innerHTML = "";
  if (S.vChanged) {
    S.vChanged = false;
    if (S.vfrom === "group" && S.vgroup != null) reloadGroup(S.vgroup); else if (S.vfrom === "grid") loadView(true);
    pollOnce();
  }
}
const PER_PAGE = 4;  // duplicates side by side in the viewer
const SHOW_ORIGINAL = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"];
const big = it => `/${SHOW_ORIGINAL.includes(it.ext) ? "original" : "preview"}/${it.id}`;
async function renderViewer() {
  const base = S.vlist[S.vidx];
  if (!base) return closeViewer();
  // S.vfocus: a group member picked by clicking, when the list itself is not the group (opened from a grid)
  const it = await api("/api/item?id=" + (S.vfocus || base.id)).catch(() => base);
  S.vcur = it;
  // a duplicate: show its group side by side and let you pick which one to keep
  S.vmembers = it.dup_group ? await api(`/api/group?id=${it.dup_group}`).catch(() => null) : null;
  const group = S.vmembers && S.vmembers.length > 1 ? S.vmembers : null;
  const inGroup = S.vfrom === "group";
  $("#vPrev").title = inGroup ? "Previous photo in this group (←)" : "Previous in the list (←)";
  $("#vNext").title = inGroup ? "Next photo in this group (→)" : "Next in the list (→)";
  if (group) {
    // pages of 4 that stay put: the selection moves inside a page, the page turns only past its edge.
    // The last page is filled from the one before (9 photos: 1-4, 5-8, 6-9), so it never shows a lone photo.
    const pos = Math.max(0, group.findIndex(m => m.id === it.id));
    const last = Math.max(0, group.length - PER_PAGE);
    let start = S.vwin && S.vwin.g === it.dup_group ? Math.min(S.vwin.start, last) : -1;
    if (start < 0 || pos < start || pos >= start + PER_PAGE) start = Math.min(Math.floor(pos / PER_PAGE) * PER_PAGE, last);
    S.vwin = { g: it.dup_group, start };
    const shown = group.slice(start, start + PER_PAGE);
    const exact = group.filter(m => !m.dup_best).every(m => m.dup_kind === "exact");
    const how = inGroup ? "Arrows move through this group." : "Arrows move to the next photo in the list.";
    // the keepers (your Keep, or the tool's pick where you haven't chosen), pinned at the top to compare against
    const keepers = group.filter(m => m.user_decision === "keep" || (!m.user_decision && m.dup_best));
    if (S.vpeek && (S.vpeek.g !== it.dup_group || !group.some(m => m.id === S.vpeek.id))) S.vpeek = null;
    const peek = S.vpeek && group.find(m => m.id === S.vpeek.id);
    const fig = (m, label) => {
      const s = state(m), cls = s === "kept" ? "k" : s === "approved" || s === "gone" ? "d" : "";
      const tag = m.user_decision ? flagHtml(m) : m.dup_best ? `<span class="flag keep">Suggested keep</span>` : `<span class="flag delete">Suggested delete</span>`;
      const chip = label ? `<span class="selchip${label === "Keeping" ? " keepchip" : ""}">${label}</span>` : m.id === it.id ? `<span class="selchip">Selected</span>` : "";
      return `<figure class="${cls}${m.id === it.id ? " cur" : ""}" data-focus="${m.id}">
        <figcaption><b>${chip}Photo ${group.indexOf(m) + 1}, ${gb(m.bytes)}${m.w ? `, ${m.w}×${m.h}` : ""}</b><span>${m.sharp != null ? `sharpness ${Math.round(m.sharp)} ` : ""}${tag}</span></figcaption>
        <div class="shot"><img src="${big(m)}" alt=""></div>
        <button class="btn sm pick" data-only="${m.id}">Keep only this one</button>
      </figure>`;
    };
    const keepRow = `<div class="keepers"><span>${keepers.length ? "Keeping:" : "Nothing marked keep yet."}</span>${keepers.map(m =>
      `<button class="kp${peek && peek.id === m.id ? " on" : ""}" data-peek="${m.id}" title="${peek && peek.id === m.id ? "Close the comparison" : "Compare this one with the selected photo"}"><img src="/thumb/${m.id}" alt=""><span>${group.indexOf(m) + 1}</span></button>`).join("")}
      ${keepers.length ? `<em>${peek ? "" : "Click one to compare it with the selected photo."}</em>` : ""}</div>`;
    const body = peek
      ? `<div class="compare">${fig(peek, "Keeping")}${peek.id !== it.id ? fig(it, "Selected") : ""}</div>`
      : `<div class="compare">${shown.map(m => fig(m)).join("")}</div>`;
    $("#stage").innerHTML = `<div class="gview">
      <div class="ghead"><b>${exact ? "Exact copies" : "Look-alike shots"}: photo ${pos + 1} of ${group.length}</b>
        <span>${peek ? `Comparing with kept photo ${group.indexOf(peek) + 1}. Arrows change the photo on the right. ` : group.length > PER_PAGE ? `Showing ${start + 1}–${start + shown.length}. ` : ""}${peek ? "" : how + " "}Click any photo to select it. Your choice applies to the selected one.</span>
        ${peek ? `<button class="btn sm" data-unpeek>Back to all photos<kbd>Esc</kbd></button>` : ""}</div>
      ${keepRow}
      ${body}
      ${group.length > PER_PAGE ? `<div class="dock" aria-label="Every photo in this group">${group.map((m, i) => {
        const s = state(m), cls = s === "kept" ? "k" : s === "approved" || s === "gone" ? "d" : "";
        const win = i >= start && i < start + PER_PAGE;
        return `<button class="dk ${cls}${win ? " inwin" : ""}${m.id === it.id ? " cur" : ""}" data-focus="${m.id}" title="Photo ${i + 1}${m.dup_best && !m.user_decision ? ", suggested keep" : ""}">
          <img src="/thumb/${m.id}" alt=""><span>${i + 1}</span>${m.dup_best && !m.user_decision ? `<i class="best" aria-hidden="true"></i>` : ""}</button>`;
      }).join("")}</div>` : ""}
    </div>`;
    $("#stage .dk.cur")?.scrollIntoView({ block: "nearest", inline: "center" });
  } else if (it.kind === "video") {
    $("#stage").innerHTML = [".mp4", ".webm", ".m4v", ".mov"].includes(it.ext)
      ? `<video src="/original/${it.id}" controls autoplay muted playsinline poster="/preview/${it.id}"></video>` : `<img src="/preview/${it.id}" alt="">`;
  } else $("#stage").innerHTML = `<img src="${big(it)}" alt="">`;

  const s = state(it), faces = it.faces || [];
  $("#vside").innerHTML = `
    <div class="verdict">${flagHtml(it)}${it.user_decision && it.decision ? `<span class="flag ${it.decision}">Tool suggested ${it.decision === "unsure" ? "not sure" : it.decision}</span>` : ""}</div>
    <div class="reason">${esc(it.reason || tagLine(it) || "Not decided yet")}</div>
    <div class="acts">
      <button class="btn ${s === "kept" ? "keep" : "keep-outline"}" data-v="keep">Keep<kbd>K</kbd></button>
      <button class="btn ${s === "approved" ? "danger" : "danger-outline"}" data-v="delete">Approve for delete<kbd>D</kbd></button>
      ${group ? `<button class="btn wide" data-v="only">Keep only this one<kbd>O</kbd></button>
                 <button class="btn danger-outline wide" data-v="all">Approve all ${S.vmembers.length} for delete<kbd>B</kbd></button>` : ""}
      ${it.user_decision ? `<button class="btn quiet wide" data-v="reset">Undo my choice<kbd>U</kbd></button>` : ""}
      ${it.user_decision === "delete" ? `<button class="btn wide" data-v="gone">${it.gone ? "Not deleted in Google yet" : "I deleted it in Google"}<kbd>X</kbd></button>` : ""}
    </div>
    ${it.gurl ? `<a class="glink" href="${esc(it.gurl)}" target="_blank" rel="noopener">Open in Google Photos</a>` : `<span class="muted small">No Google Photos link for this file.</span>`}
    <div><h3>Tags</h3><div class="tagrow">
      ${it.type ? `<span class="tg strong">${esc(nm(it.type))}</span>` : ""}
      ${it.event ? `<span class="tg strong">${esc(nm(it.event))}</span>` : ""}
      ${(it.tag_scores || []).filter(t => !["people", "celebration"].includes(t.tag)).map(t => `<span class="tg">${esc(nm(t.tag))}</span>`).join("")}
      ${!it.type ? `<span class="muted small">Not tagged yet</span>` : ""}
    </div></div>
    ${faces.length ? `<div><h3>People (${faces.length})</h3><div class="facerow">${faces.map(f =>
      `<button class="face" data-person="${f.person_id || ""}" title="${esc(f.person || "Not grouped: too small or seen too rarely")}"><img src="/face/${f.id}" alt=""><span>${esc(f.person || "?")}</span></button>`).join("")}</div></div>` : ""}
    ${it.ocr_text ? `<div><h3>Text in the image</h3><div class="ocr">${esc(it.ocr_text)}</div></div>` : ""}
    <dl class="kv">
      ${it.taken ? `<dt>Taken</dt><dd>${new Date(it.taken * 1000).toLocaleString()}</dd>` : ""}
      <dt>Size</dt><dd>${gb(it.bytes)}${it.w ? `, ${it.w}×${it.h}` : ""}${it.kind === "video" ? `, ${clip(it.duration)}` : ""}</dd>
      ${it.g_people ? `<dt>Google tags</dt><dd>${esc(JSON.parse(it.g_people).join(", "))}</dd>` : ""}
      ${it.origin ? `<dt>Came from</dt><dd>${esc(nm(it.origin))}${it.favorite ? ", favorite" : ""}${it.in_storage === 0 ? ", doesn't use your storage" : ""}</dd>` : ""}
      <dt>File</dt><dd>${esc(it.name)}</dd>
      <dt>Folder</dt><dd>${esc(it.folder)}</dd>
      ${it.copies?.length ? `<dt>Also in</dt><dd>${esc(it.copies.map(f => f.split(/[\\/]/).pop()).join(", "))} <span class="muted small">(same item in Google: deleting it removes every copy)</span></dd>` : ""}
      <dt>${inGroup ? "In this group" : "In this list"}</dt><dd>${S.vidx + 1} of ${S.vlist.length}</dd>
    </dl>
    <p class="muted small">Keys: arrows move, K keep, D delete, U undo${group ? ", O keep only this one, B delete all of them" : ""}, G open in Google, Esc close.</p>`;
}
async function viewerAct(a, onlyId) {
  const it = S.vcur; if (!it) return;
  if (a === "gone") {
    await setGone([it.id], !it.gone); S.vChanged = true;
    toast(it.gone ? "Back on the delete list" : "Marked as deleted in Google");
    return afterViewerChange(it, { gone: it.gone ? 0 : 1 });
  }
  if (a === "only") {
    await keepOnly(S.vmembers, onlyId || it.id); S.vChanged = true;
    toast("Keeping that one, the others are approved for delete");
    return renderViewer();
  }
  if (a === "all") {
    await decide(S.vmembers.map(m => m.id), "delete"); S.vChanged = true;
    toast(`All ${S.vmembers.length} approved for delete`);
    return afterViewerChange(it, { user_decision: "delete" });
  }
  const dec = a === "reset" ? null : a;
  if (dec && it.user_decision === dec) return vStep(1);
  await decide([it.id], dec); S.vChanged = true;
  toast(DONE_WORD[dec]);
  return afterViewerChange(it, { user_decision: dec }, true);
}
// keep the list in step; move on when a photo leaves the page it was opened from
function afterViewerChange(it, change, advance) {
  if (S.vfocus) return renderViewer();  // a group member picked by clicking: the list itself didn't change
  const cur = { ...S.vlist[S.vidx], ...it, ...change };
  S.vlist[S.vidx] = cur;
  if (S.vfrom === "grid" && !belongs(S.view, cur)) {
    S.vlist.splice(S.vidx, 1);
    if (S.vidx >= S.vlist.length) S.vidx = S.vlist.length - 1;
    return S.vidx < 0 ? closeViewer() : renderViewer();
  }
  return advance ? vStep(1, true) : renderViewer();
}
function vStep(d, quiet) {
  S.vfocus = null;
  const n = S.vidx + d;
  if (n < 0 || n >= S.vlist.length) { if (!quiet) toast(n < 0 ? "This is the first one" : "That was the last one"); return renderViewer(); }
  S.vidx = n; return renderViewer();
}
$("#vside").addEventListener("click", async e => {
  const b = e.target.closest("[data-v]"); if (b) return viewerAct(b.dataset.v);
  const f = e.target.closest("[data-person]");
  if (f && f.dataset.person) {
    closeViewer();
    S.persons = await api("/api/people");
    const p = S.persons.find(x => x.id === +f.dataset.person) || null;
    location.hash = "people";
    setTimeout(() => { S.person = p; loadView(true); }, 0);
  }
});
$("#stage").addEventListener("click", e => {
  const b = e.target.closest("[data-only]"); if (b) return viewerAct("only", +b.dataset.only);
  if (e.target.closest("[data-unpeek]")) { S.vpeek = null; return renderViewer(); }
  const pk = e.target.closest("[data-peek]");
  if (pk) {  // click a keeper to compare with it, click it again to close
    const id = +pk.dataset.peek;
    S.vpeek = S.vpeek?.id === id ? null : { id, g: S.vcur?.dup_group };
    return renderViewer();
  }
  const f = e.target.closest("[data-focus]"); if (f) focusMember(+f.dataset.focus);
});
// select one photo of a duplicate group, from the big photos or the strip below them
function focusMember(id) {
  if (S.vcur?.id === id) return;
  if (S.vfrom === "group") {
    const i = S.vlist.findIndex(m => m.id === id);
    if (i >= 0) { S.vidx = i; S.vfocus = null; return renderViewer(); }
  }
  S.vfocus = id === S.vlist[S.vidx]?.id ? null : id;
  renderViewer();
}
$("#vClose").onclick = closeViewer;
$("#vPrev").onclick = () => vStep(-1);
$("#vNext").onclick = () => vStep(1);
$("#viewer").addEventListener("click", e => { if (e.target.id === "viewer" || e.target.id === "stage") closeViewer(); });
document.addEventListener("keydown", e => {
  if (e.target.matches("input, select, textarea")) return;
  if (!$("#viewer").hidden) {
    const k = e.key.toLowerCase(), it = S.vcur;
    const group = S.vmembers && S.vmembers.length > 1;
    if (k === "escape" && S.vpeek) { S.vpeek = null; renderViewer(); }
    else if (k === "escape") closeViewer();
    else if (k === "arrowright") vStep(1);
    else if (k === "arrowleft") vStep(-1);
    else if (k === "k") viewerAct("keep");
    else if (k === "d" || k === "delete") viewerAct("delete");
    else if (k === "u" && it?.user_decision) viewerAct("reset");
    else if (k === "o" && group) viewerAct("only");
    else if (k === "b" && group) viewerAct("all");
    else if (k === "x" && it?.user_decision === "delete") viewerAct("gone");
    else if (k === "g" && it?.gurl) window.open(it.gurl, "_blank", "noopener");
    else return;
    e.preventDefault();
  } else if (e.key === "Escape") $$(".modal").forEach(m => { if (m.id !== "confirm") m.hidden = true; });
});

// ---------- run button, settings, folder picker, start over ----------
$("#runBtn").onclick = async () => {
  try {
    if (S.status?.run?.running) { await api("/api/pause", {}); toast("Pausing after the current photos"); }
    else { await api("/api/start", {}); toast("Started"); }
    pollOnce();
  } catch (e) { toast(e.message); }
};
$("#settingsBtn").onclick = async () => { const s = await api("/api/settings"); $("#inputCode").textContent = s.input; $("#settings").hidden = false; };
for (const id of ["settings", "picker"]) $("#" + id).addEventListener("click", e => { if (e.target.id === id || e.target.closest("[data-close]")) $("#" + id).hidden = true; });
$("#pickFolder").onclick = () => openPicker();
$("#resetBtn").onclick = async () => {
  $("#settings").hidden = true;
  if (!(await confirmBox("Start over?", "This clears everything the tool worked out: tags, faces, people and their names, your keep and delete choices, and your delete list. Your photos and the downloaded models are not touched. This can't be undone.", "Clear everything"))) return;
  toast("Clearing. If a step is running, it finishes the current photo first");
  try { await api("/api/reset", {}); S.sel.clear(); updateSel(); S.recentKey = ""; toast("Everything was cleared. Press Start to run it again."); await pollOnce(); location.hash = "overview"; }
  catch (e) { toast(e.message); }
};
const PK = { path: "" };
async function openPicker() { $("#settings").hidden = true; $("#picker").hidden = false; await browse(S.status?.input || ""); }
async function browse(path) {
  const r = await api("/api/folders?path=" + encodeURIComponent(path || "")).catch(e => ({ error: e.message, folders: [], roots: [] }));
  if (r.error && path) return browse("");
  PK.path = r.path || "";
  $("#pkPath").textContent = PK.path || "Choose a starting place";
  $("#pkUp").disabled = !r.parent; $("#pkUp").onclick = () => browse(r.parent);
  $("#pkRoots").innerHTML = (r.roots || []).map(x => `<button class="chip" data-dir="${esc(x)}">${esc(x)}</button>`).join("");
  $("#pkList").innerHTML = (r.folders || []).map(f => `<li><button data-dir="${esc(f.path)}">${esc(f.name)}</button></li>`).join("")
    || `<li class="muted small" style="padding:8px">${PK.path ? "No folders inside this one." : ""}</li>`;
  $("#pkInfo").textContent = PK.path ? (r.media ? `${plural(r.media, "photo or video", "photos and videos")} directly in this folder, plus any in subfolders` : "Subfolders are included") : "";
  $("#pkUse").disabled = !PK.path;
}
$("#picker").addEventListener("click", e => { const d = e.target.closest("[data-dir]"); if (d) browse(d.dataset.dir); });
$("#pkUse").onclick = async () => {
  const send = reset => fetch("/api/folder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: PK.path, reset }) })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  let r = await send(false);
  if (r.status === 409 && r.body.needs_reset) {
    $("#picker").hidden = true;
    if (!(await confirmBox("Switch to this folder?", `The results for the current folder (${plural(r.body.count, "file", "files")}: tags, people, your keep and delete choices) are cleared first, so two libraries never get mixed. Your photos aren't touched.`, "Switch folder"))) return;
    r = await send(true);
  }
  if (r.status !== 200) return toast(r.body.error || "Couldn't use that folder");
  $("#picker").hidden = true; toast("Photos folder set. Press Start.");
  await pollOnce();
  if (S.view === "overview") renderOverview(); else loadView(true);
};

// ---------- delete in Google (needs the Photo Cleaner helper extension) ----------
const G = { ext: null, running: false, lastDone: 0, perItem: 6 };
const SPEEDS = { careful: [3000, 5000], normal: [1000, 2500], fast: [500, 1000] };
const toExt = m => window.postMessage({ source: "photo-cleaner-page", ...m }, location.origin);
window.addEventListener("message", e => {
  if (e.source !== window || e.origin !== location.origin || e.data?.source !== "photo-cleaner-ext") return;
  const m = e.data;
  if (m.type === "hello") { G.ext = m.version; renderGPanel(); toExt({ type: "status" }); }
  else if (m.type === "status") renderGStatus(m);
  else if (m.type === "error") toast(m.message);
});
setTimeout(() => toExt({ type: "ping" }), 300);
function renderGPanel() {
  $("#gpanel").hidden = S.view !== "approved";
  $("#gpControls").hidden = !G.ext;
  if (!G.ext) $("#gpState").innerHTML = `Install the helper extension to have these deleted for you: open <code>chrome://extensions</code> or <code>edge://extensions</code>, turn on Developer mode, click Load unpacked and pick the <code>extension</code> folder. Or open each photo in Google Photos yourself.`;
  else if (!G.running) $("#gpState").textContent = "Opens a small Google Photos window, where you're signed in, and moves each photo below to the trash, one at a time. Keep that window visible. Try a test run first.";
}
function renderGStatus(m) {
  G.running = !!m.running;
  $("#gpStart").hidden = G.running; $("#gpStop").hidden = !G.running;
  for (const id of ["#gpTest", "#gpBatch", "#gpSpeed"]) $(id).disabled = G.running;
  const p = $("#gpProgress");
  if (m.total == null) { p.hidden = true; renderGPanel(); return; }
  p.hidden = false;
  const test = m.mode !== "delete", left = Math.max(0, m.total - m.at);
  p.innerHTML = `<b>${m.running ? (test ? "Testing" : "Deleting") : "Finished"}</b>, ${num(Math.min(m.at + (m.running ? 1 : 0), m.total))} of ${num(m.total)}:
    <span class="ok">${num(m.done)} ${test ? "checked" : "moved to trash"}</span>${m.missing ? `, ${num(m.missing)} not found` : ""}${m.problems ? `, <span class="bad">${num(m.problems)} problems</span>` : ""}
    ${m.running ? `, about ${dur(left * G.perItem)} left` : ""}
    ${m.stopReason ? `<div class="bad">Stopped: ${esc(m.stopReason)}</div>` : ""}
    ${!m.running && !test && m.done ? `<div class="muted">Done. Empty the trash in Google Photos to get the space back.</div>` : ""}`;
  $("#gpLog").innerHTML = (m.log || []).map(l => `<li class="${l.status}"><b>${esc(l.name || "")}</b> ${esc(l.message || l.status)}</li>`).join("");
  $("#gpState").textContent = G.running ? "Working in the small Google Photos window. Keep it visible; you can use other windows meanwhile." : "";
  if (!test && m.done !== G.lastDone) { G.lastDone = m.done; if (S.view === "approved") loadView(true); pollOnce(); }
}
$("#gpStart").onclick = async () => {
  const test = $("#gpTest").checked, batch = +$("#gpBatch").value;
  const items = [];
  for (let offset = 0; ; offset += 500) {
    const r = await api(`/api/items?view=approved&gone=0&sort=oldest&limit=500&offset=${offset}`);
    items.push(...r.items.filter(i => i.gurl).map(i => ({ id: i.id, url: i.gurl, name: i.name })));
    if (r.items.length < 500 || (batch && items.length >= batch)) break;
  }
  const list = batch ? items.slice(0, batch) : items;
  if (!list.length) return toast("Nothing to do: every approved photo is already marked as deleted in Google");
  if (!test && !(await confirmBox(`Move ${plural(list.length, "photo", "photos")} to the Google Photos trash?`,
      "A small Google Photos window opens and the helper moves each photo to the trash there. Google keeps them in its trash for 30 days, so you can restore them. Keep that window visible until it finishes.", "Move to trash"))) return;
  const pace = SPEEDS[$("#gpSpeed").value] || SPEEDS.normal;
  G.perItem = 4 + (pace[0] + pace[1]) / 2000;
  toExt({ type: "start", items: list, mode: test ? "test" : "delete", api: location.origin, pauseMin: pace[0], pauseMax: pace[1] });
};
$("#gpStop").onclick = () => toExt({ type: "stop" });

// ---------- start ----------
{
  const u = new URLSearchParams(location.search);   // e.g. /?bbox=18.3,73.6,18.8,74.1&type=photo#all
  for (const k of FILTERS) if (u.get(k)) S.f[k] = u.get(k);
  if (u.get("q")) { S.q = u.get("q"); $("#searchIn").value = S.q; }
  const bb = (u.get("bbox") || "").split(",").map(Number);
  if (bb.length === 4 && bb.every(Number.isFinite)) S.bbox = bb;
  pollStatus();
  pollRecent();
  go(location.hash.slice(1) || "overview", true);
}

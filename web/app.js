"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const NAMES = {
  // buckets
  duplicate: "Exact copies", similar: "Look-alike shots", blank: "Blank images", accidental: "Accidental shots",
  screenshot: "Screenshots", meme: "Memes and greetings", receipt: "Receipts and bills", poor: "Blurry or dark",
  poor_people: "Blurry, with people", check: "Needs a look", ticket: "Tickets and bills", note: "Notes",
  unreadable: "Couldn't open", no_preview: "No preview", important: "Important", people: "People",
  // types
  photo: "Photo", document: "Document", id_card: "ID card", greeting: "Greeting", artwork: "Artwork",
  // events
  none: "No event", wedding: "Wedding", birthday: "Birthday", festival: "Other festival", religious: "Religious",
  pre_wedding: "Haldi, mehndi or sangeet", engagement: "Engagement", anniversary: "Anniversary",
  baby_shower: "Baby shower", housewarming: "Housewarming", diwali: "Diwali", holi: "Holi",
  ganesh: "Ganesh Chaturthi", navratri: "Navratri / Garba", raksha_bandhan: "Raksha Bandhan", eid: "Eid",
  christmas: "Christmas", new_year: "New Year", celebration: "Any celebration",
  party: "Party", concert: "Concert", graduation: "Graduation", sports: "Sports", trip: "Trip", work: "Work",
  // tags
  selfie: "Selfie", group: "Group photo", kids: "Kids", dog: "Dog", cat: "Cat", food: "Food", beach: "Beach",
  mountains: "Mountains", nature: "Nature", city: "City", monument: "Monument", sunset: "Sunset", night: "Night",
  vehicle: "Vehicle", flowers: "Flowers", home: "Home", shopping: "Shopping", chat: "Chat", social: "Social media",
  map: "Map", blurry: "Blurry", dark: "Dark",
  // from Google's info files
  favorite: "Favorite", google_people: "Tagged in Google", whatsapp: "From WhatsApp", quick_share: "Quick Share",
  social_app: "From a social app", shared_album: "From a shared album", creation_auto: "Google auto-creation",
  creation_manual: "Your Google creation", shared: "Shared album (frees nothing)", creation: "Google auto-creations",
  camera: "Phone camera", web: "Uploaded from computer", phone_folder: "Other phone folder",
};
const nm = k => NAMES[k] || (k ? String(k).replace(/_/g, " ").replace(/^./, c => c.toUpperCase()) : "Other");
const HINTS = {
  delete: "These look safe to delete. Click photos to select them, then approve them for delete or keep them. Nothing is deleted from Google until you do it there yourself.",
  unsure: "Not clear-cut: a ticket you may still need, a blurry photo with people in it, a note. Have a look.",
  keep: "What the tool suggests keeping, plus everything you chose to keep. If you spot junk, select it and press Approve for delete instead.",
  groups: "Exact copies and look-alike shots. Green 'Suggested keep' is the sharpest copy; red 'Suggested delete' are the spares. Your own choices show as 'You: keep' or 'Approved for delete' and are never overwritten.",
  people: "Everyone found in your photos, grouped by face. Click a person to see their photos, rename them, or approve their photos for delete in bulk.",
  all: "Your whole library. Use search and the filters to find exactly what you want, then select it and approve it for delete.",
  approved: "Your delete list: approved, not deleted in Google yet. Use the panel below to delete them automatically, or open each one in Google Photos and tick it as deleted. Deleted ones move to the Deleted in Google tab.",
  deleted: "Photos already moved to the trash in Google Photos. Google keeps them in its trash for 30 days, and your storage only frees up once the trash is emptied. If one wasn't really deleted, select it and press Not deleted yet.",
  pending: "Files still being worked on.",
  map: "Every photo with a location. Zoom in, switch on the heat map, or press Select an area and drag a box: the photos inside show below, ready to approve for delete. The filters work here too.",
};
const VIEW_COUNT = { delete: "s_delete", unsure: "s_unsure", keep: "keep", approved: "approved", deleted: "gone", pending: "pending", all: "items" };
const FILTERS = ["type", "event", "tag", "year", "kind"];
const STEP_DONE = {
  scan: c => [c.scanned, c.files], group: c => [c.groups, null], tag: c => [c.tagged, c.taggable],
  faces: c => [c.faced, c.taggable], people: c => [c.people, null], ocr: c => [c.read, null],
  decide: c => [c.items - c.pending, c.items], review: c => [c.analyzed, null],
};

const S = { view: "delete", f: {}, bucket: "", person: null, q: "", sort: "size", items: [], total: 0, bytes: 0,
            loading: false, sel: new Set(), last: null, status: null, loadedCount: null, vlist: [], vidx: -1,
            vfrom: "grid", groups: [], gtotal: 0, recentKey: "", persons: [], showHidden: false };

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
  if (s < 60) return s + "s";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}
const clip = s => { s = Math.round(s || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const date = t => t ? new Date(t * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
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
function confirmBox(title, text, ok = "Yes") {
  return new Promise(res => {
    const m = $("#confirm");
    $("#cTitle").textContent = title; $("#cText").textContent = text; $("#cOk").textContent = ok;
    m.hidden = false;
    const done = v => { m.hidden = true; $("#cOk").onclick = null; m.onclick = null; res(v); };
    $("#cOk").onclick = () => done(true);
    m.onclick = e => { if (e.target === m || e.target.closest("[data-close]")) done(false); };
  });
}
function effective(it) {
  if (it.user_decision === "delete") return "approved";
  if (it.user_decision === "keep") return "keep";
  return it.decision || "pending";
}
const VERDICT_TEXT = { keep: "Suggested keep", delete: "Suggested delete", unsure: "Unsure, check it", approved: "Approved for delete (by you)", pending: "Still processing" };
const verdictText = it => it.user_decision === "keep" ? "You: keep" : VERDICT_TEXT[effective(it)];
function tagLine(it) {
  const bits = [];
  if (it.type) bits.push(nm(it.type));
  if (it.event) bits.push(nm(it.event));
  (it.tags || "").split(",").filter(t => t && t !== "people").slice(0, 3).forEach(t => bits.push(nm(t)));
  return bits.join(" · ");
}
function query(extra = {}) {
  const q = new URLSearchParams({ view: S.view === "people" || S.view === "map" ? "all" : S.view, sort: S.sort, ...extra });
  if (S.view === "map") q.set("geo", "1");
  if (S.bbox) q.set("bbox", S.bbox.join(","));  // an area picked on the map, on any tab
  for (const k of FILTERS) if (S.f[k]) q.set(k, S.f[k]);
  if (S.bucket) q.set("bucket", S.bucket);
  if (S.person) q.set("person", S.person.id);
  if (S.q) q.set("q", S.q);
  return q;
}

// ---------- theme ----------
function setTheme(t) { document.documentElement.dataset.theme = t; try { localStorage.setItem("theme", t); } catch {} }
try { const t = localStorage.getItem("theme"); if (t) document.documentElement.dataset.theme = t; else if (matchMedia("(prefers-color-scheme: light)").matches) document.documentElement.dataset.theme = "light"; } catch {}
$("#themeBtn").onclick = () => setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");

// ---------- status ----------
async function pollStatus() {
  try {
    const st = await api("/api/status");
    S.status = st;
    renderStatus(st);
    maybeRefreshView(st);
  } catch (e) {
    $("#msg").textContent = "Lost connection to Photo Cleaner. Is it still running?";
  }
  setTimeout(pollStatus, S.status?.run?.running ? 1500 : 4000);
}

function renderStatus(st) {
  const r = st.run, c = st.counts, o = st.ollama;
  $("#inputPath").textContent = st.input;
  $("#inputCode").textContent = st.input;

  const pill = $("#ollamaPill");
  pill.className = "pill " + (!o.enabled ? "" : o.ok && o.model_ready ? "ok" : "bad");
  pill.textContent = !o.enabled ? "Second opinion off" : !o.ok ? "Ollama not running" : o.model_ready ? `${o.model} ready` : `${o.model} not downloaded`;

  const btn = $("#runBtn");
  if (r.running) { btn.textContent = r.stopping ? "Pausing…" : "Pause"; btn.disabled = r.stopping; btn.className = "btn"; }
  else { btn.disabled = false; btn.className = "btn primary"; btn.textContent = !c.files ? "Start" : (c.pending || c.scanned < c.files) ? "Continue" : "Check for new files"; }

  const phaseIdx = st.steps.findIndex(s => s[0] === r.phase);
  $("#steps").innerHTML = st.steps.map(([key, label], i) => {
    const [d, t] = STEP_DONE[key](c);
    const on = r.running && i === phaseIdx;
    const past = r.running ? i < phaseIdx : (t ? d >= t && t > 0 : d > 0) || r.phase === "done";
    const extra = t ? `${num(d)}/${num(t)}` : d ? num(d) : "";
    return `<li class="${on ? "on" : past ? "past" : ""}"><span>${past && !on ? "✓" : i + 1}</span>${esc(label)}${extra ? `<em>${extra}</em>` : ""}</li>`;
  }).join("");

  $("#msg").textContent = r.message || "";
  const bar = $(".bar"), fill = $("#barFill");
  bar.classList.toggle("busy", r.running && !r.total);
  let pct = 0;
  if (r.running && r.total) pct = r.done / r.total * 100;
  else if (c.items) pct = (c.items - c.pending) / c.items * 100;
  fill.style.width = Math.min(100, pct).toFixed(1) + "%";

  const meta = [];
  if (r.running && r.total) meta.push(`<span><b>${num(r.done)}</b> of ${num(r.total)}</span>`);
  if (r.running && r.per_min) meta.push(`<span><b>${num(r.per_min)}</b> per minute</span>`);
  if (r.running && r.eta_s != null) meta.push(`<span>this step: about <b>${dur(r.eta_s)}</b> left</span>`);
  if (r.running && r.started) meta.push(`<span>running for <b>${dur(Date.now() / 1000 - r.started)}</b></span>`);
  if (!r.running && c.files) {
    meta.push(`<span><b>${num(c.items)}</b> items in your library (${gb(c.bytes)})</span>`);
    if (c.aliases) meta.push(`<span>${num(c.aliases)} album copies, edits and motion-photo clips counted once</span>`);
    if (c.skipped) meta.push(`<span>${num(c.skipped)} video${c.skipped === 1 ? "" : "s"} of 5 s or longer skipped for now (${gb(c.skipped_bytes)})</span>`);
    if (c.pending) meta.push(`<span><b>${num(c.pending)}</b> still being worked on</span>`);
  }
  if (c.errors) meta.push(`<span>${num(c.errors)} files couldn't be opened</span>`);
  $("#meta").innerHTML = meta.join("");

  const m = st.models, missing = [!m.siglip && "SigLIP 2", !m.faces && "face models", !m.ocr && "RapidOCR"].filter(Boolean);
  let b = "";
  if (missing.length) b = `Models not downloaded yet: ${missing.join(", ")}. Run <code>.\\setup.ps1</code> in the project folder.`;
  else if (r.phase === "waiting" || r.phase === "error") b = esc(r.message);
  else if (!c.files && !r.running) b = `Pick the folder with your unzipped Google Takeout: <button class="btn sm primary" data-pick>Choose folder…</button> Then press <b>Start</b>. (Now: <code>${esc(st.input)}</code>)`;
  const banner = $("#banner"); banner.innerHTML = b; banner.hidden = !b;

  $("#sLib").textContent = num(c.items); $("#sLibB").textContent = gb(c.bytes);
  $("#sDel").textContent = num(c.s_delete); $("#sDelB").textContent = gb(c.s_delete_bytes);
  $("#sUns").textContent = num(c.s_unsure); $("#sUnsB").textContent = gb(c.s_unsure_bytes);
  $("#sKeep").textContent = num(c.keep); $("#sKeepB").textContent = gb(c.keep_bytes);
  $("#sPpl").textContent = num(c.people); $("#sPplB").textContent = `${num(c.with_faces)} photos have faces`;
  $("#sAppr").textContent = num(c.approved);
  $("#sApprB").textContent = (c.approved ? `frees ${gb(c.approved_bytes)} once deleted in Google` : "nothing waiting") + (c.gone ? ` · ${num(c.gone)} already deleted (${gb(c.gone_bytes)})` : "");
  $("#tDel").textContent = num(c.s_delete); $("#tUns").textContent = num(c.s_unsure); $("#tKeep").textContent = num(c.keep);
  $("#tGrp").textContent = num(c.groups); $("#tPpl").textContent = num(c.people); $("#tAll").textContent = num(c.items);
  $("#tMap").textContent = num(c.located); $("#tAppr").textContent = num(c.approved); $("#tGone").textContent = num(c.gone); $("#tPend").textContent = num(c.pending);
}

// ---------- live feed ----------
const STEP_WORD = { tag: "Tagging", faces: "Finding faces", ocr: "Reading text", review: "Second opinion", decide: "Latest decisions" };
async function pollRecent() {
  try {
    const rec = await api("/api/recent");
    const key = rec.step + rec.items.map(r => r.id + (r.decision || "") + (r.type || "") + (r.face_count || "")).join(",");
    if (key !== S.recentKey) { S.recentKey = key; S.recent = rec.items; renderNow(rec); }
  } catch {}
  setTimeout(pollRecent, S.status?.run?.running ? 2000 : 6000);
}

function renderNow(rec) {
  const items = rec.items, it = items[0];
  $("#feedTitle").textContent = STEP_WORD[rec.step] ? `${STEP_WORD[rec.step]}: just finished` : "Just finished";
  if (!it) {
    $("#nowBody").innerHTML = `<div class="empty">Results show up here as each photo is done.</div>`;
    $("#feed").innerHTML = `<div class="empty" style="grid-column:1/-1">Nothing yet.</div>`;
    return;
  }
  const e = effective(it);
  $("#nowTime").textContent = rec.step && STEP_WORD[rec.step] ? STEP_WORD[rec.step] : "";
  $("#nowBody").innerHTML = `
    <img class="now-img" src="/preview/${it.id}" alt="" data-feed="0">
    <div class="now-text">
      <span class="verdict ${e}">${verdictText(it)}</span>
      <div class="reason">${esc(it.reason || tagLine(it) || "Being tagged…")}</div>
      <dl class="kv">
        <dt>Type</dt><dd>${esc(nm(it.type))}${it.event ? " · " + esc(nm(it.event)) : ""}</dd>
        ${it.tags ? `<dt>Tags</dt><dd>${esc(it.tags.split(",").map(nm).join(", "))}</dd>` : ""}
        ${it.face_count ? `<dt>People</dt><dd>${it.face_count} face${it.face_count > 1 ? "s" : ""}${it.persons ? " · " + esc(it.persons) : ""}</dd>` : ""}
        <dt>File</dt><dd>${esc(it.name)} · ${gb(it.bytes)}${it.kind === "video" ? " · " + clip(it.duration) : ""}</dd>
        ${it.taken ? `<dt>Taken</dt><dd>${date(it.taken)}</dd>` : ""}
      </dl>
    </div>`;
  $("#feed").innerHTML = items.map((r, i) => {
    const d = effective(r);
    return `<img src="/thumb/${r.id}" class="${d === "approved" ? "delete" : d}" data-feed="${i}" title="${esc(r.reason || tagLine(r))}" alt="">`;
  }).join("");
}
document.addEventListener("click", e => {
  const f = e.target.closest("[data-feed]");
  if (f && S.recent) openViewer(S.recent, +f.dataset.feed, "feed");
});

// ---------- filters ----------
async function loadFacets() {
  if (S.view === "groups" || S.view === "people" && !S.person) return;
  try {
    const f = await api("/api/facets?" + query());
    const fill = (id, key, list, label) => {
      const sel = $(id), cur = S.f[key] || "";
      sel.innerHTML = `<option value="">${label}</option>` + list.map(x =>
        `<option value="${esc(x.k ?? "")}"${String(x.k) === cur ? " selected" : ""}>${esc(key === "year" ? (x.k || "No date") : nm(x.k))} (${num(x.n)})</option>`).join("");
    };
    fill("#fType", "type", f.type.filter(x => x.k), "Any type");
    fill("#fEvent", "event", f.event, "Any event");
    fill("#fTag", "tag", f.tag, "Any tag");
    fill("#fYear", "year", f.year.filter(x => x.k), "Any year");
    const all = f.bucket.reduce((a, b) => a + b.n, 0), allB = f.bucket.reduce((a, b) => a + b.b, 0);
    $("#chips").innerHTML = f.bucket.length <= 1 && !S.bucket ? "" :
      `<button class="chip${S.bucket ? "" : " on"}" data-b="">All <b>${num(all)}</b> · ${gb(allB)}</button>` +
      f.bucket.map(b => `<button class="chip${S.bucket === b.k ? " on" : ""}" data-b="${esc(b.k || "")}">${esc(nm(b.k))} <b>${num(b.n)}</b> · ${gb(b.b)}</button>`).join("");
  } catch (e) { toast(e.message); }
  $("#clearFilters").hidden = !(FILTERS.some(k => S.f[k]) || S.q || S.bucket || S.bbox);
}
$$("#filters select[data-f]").forEach(s => s.onchange = () => { S.f[s.dataset.f] = s.value; S.sel.clear(); updateSel(); loadView(true); });
$("#sortSel").onchange = e => { S.sort = e.target.value; loadView(true); };
$("#searchForm").onsubmit = e => {
  e.preventDefault();
  S.q = $("#searchIn").value.trim();
  if (S.q) { S.sort = "relevance"; $("#sortSel").value = "relevance"; toast("Searching… the first search loads the model, give it a few seconds"); }
  else if (S.sort === "relevance") { S.sort = "size"; $("#sortSel").value = "size"; }
  loadView(true);
};
$("#clearFilters").onclick = () => { S.f = {}; S.q = ""; S.bucket = ""; S.bbox = null; if (M.rect && M.map) { M.map.removeLayer(M.rect); M.rect = null; } $("#searchIn").value = ""; $$("#filters select[data-f]").forEach(s => s.value = ""); loadView(true); };
$("#chips").addEventListener("click", e => { const c = e.target.closest("[data-b]"); if (!c) return; S.bucket = c.dataset.b; S.sel.clear(); updateSel(); loadView(true); });

// ---------- review grid ----------
function tile(it, i, extra = "") {
  const sel = S.sel.has(it.id), e = effective(it);
  const cap = it.reason || tagLine(it);
  return `<div class="tile${sel ? " sel" : ""}${it.gone ? " gone" : ""} v-${e}" data-i="${i}" data-id="${it.id}">
    <img src="/thumb/${it.id}" loading="lazy" alt="">
    ${extra}
    ${S.view !== "groups" ? `<span class="chk">${sel ? "✓" : ""}</span>` : ""}
    ${it.kind === "video" ? `<span class="vid">▶ ${clip(it.duration)}</span>` : ""}
    ${it.face_count ? `<span class="ppl" title="${esc(it.persons || "")}">👤 ${it.face_count}</span>` : ""}
    ${it.keeper && !["groups", "approved", "deleted"].includes(S.view) ? `<span class="keeper" title="The copy suggested to keep. Open this photo to compare them side by side"><img src="/thumb/${it.keeper}" alt=""><b>Keep</b></span>` : ""}
    ${(S.view === "approved" || S.view === "deleted") && it.gurl ? `<a class="glink" href="${esc(it.gurl)}" target="_blank" rel="noopener" data-stop>Google ↗</a>` : ""}
    <button class="zoom" data-zoom title="Open">⤢</button>
    ${it.gone ? `<span class="gone-mark">Deleted in Google</span>` : ""}
    <div class="cap"><div class="r">${esc(cap || "")}</div><div class="z"><span>${gb(it.bytes)}</span>${it.user_decision ? `<span class="ud ${e}">${it.user_decision === "keep" ? "You: keep" : "Approved for delete"}</span>` : `<span class="dot ${e}"></span>`}</div></div>
  </div>`;
}

function renderActions() {
  const n = S.total, a = [];
  const label = `all ${num(n)}`;
  if (n && S.view === "delete") a.push(`<button class="btn sm keep" data-bulk="keep">Keep ${label}</button>`, `<button class="btn sm del" data-bulk="delete">Approve ${label} for delete</button>`);
  if (n && S.view === "unsure") a.push(`<button class="btn sm keep" data-bulk="keep">Keep ${label}</button>`, `<button class="btn sm del" data-bulk="delete">Approve ${label} for delete</button>`);
  if (n && (S.view === "all" || S.view === "people" || S.view === "map")) a.push(`<button class="btn sm del" data-bulk="delete">Approve ${label} shown for delete</button>`);
  if (S.view === "approved" || S.view === "deleted") a.push(`<a class="btn sm" href="/api/export.csv">Download list (CSV)</a>`);
  $("#actions").innerHTML = a.join("");
  $("#viewCount").textContent = S.view === "groups" ? `${num(S.gtotal)} groups` : `${num(S.total)} items · ${gb(S.bytes)}` + (S.bbox ? " · in the area picked on the map" : "");
}

async function loadView(reset = true) {
  if (S.loading) return;
  S.loading = true;
  try {
    const mode = S.view === "groups" ? "groups" : S.view === "people" && !S.person ? "people" : "grid";
    $("#grid").hidden = mode !== "grid"; $("#groups").hidden = mode !== "groups"; $("#people").hidden = mode !== "people";
    $("#filters").hidden = mode !== "grid"; $("#chips").hidden = mode !== "grid"; $("#toolbar").hidden = mode === "people";
    renderPersonHead();
    $("#mapWrap").hidden = S.view !== "map";
    if (S.view === "map" && reset) loadMap();
    if (mode === "groups") return await loadGroups(reset);
    if (mode === "people") return await loadPeople();
    const offset = reset ? 0 : S.items.length;
    if (reset) loadFacets();
    const r = await api("/api/items?" + query({ offset, limit: 150 }));
    S.items = reset ? r.items : S.items.concat(r.items);
    S.total = r.total; S.bytes = r.bytes;
    S.loadedCount = S.status && VIEW_COUNT[S.view] ? S.status.counts[VIEW_COUNT[S.view]] : null;
    renderActions();
    const html = r.items.map((it, k) => tile(it, offset + k)).join("");
    if (reset) $("#grid").innerHTML = html || `<div class="empty" style="grid-column:1/-1">Nothing here${S.status?.run?.running ? " yet" : ""}.</div>`;
    else $("#grid").insertAdjacentHTML("beforeend", html);
    $("#more").textContent = S.items.length < S.total ? "Loading more…" : S.total ? "That's all." : "";
    $("#refreshNote").hidden = true;
  } catch (e) { toast(e.message); }
  finally { S.loading = false; }
}

async function loadGroups(reset) {
  const offset = reset ? 0 : S.groups.length;
  const r = await api(`/api/groups?offset=${offset}&limit=30`);
  S.groups = reset ? r.groups : S.groups.concat(r.groups);
  S.gtotal = r.total;
  renderActions();
  const html = r.groups.map((g, gi) => {
    const spares = g.members.filter(m => !m.dup_best);
    const exact = spares.length && spares.every(s => s.dup_kind === "exact");
    return `<div class="group" data-g="${offset + gi}">
      <div class="group-h"><div class="t">${exact ? "Exact copies" : "Look-alike shots"}<span>${g.n} files · spares take ${gb(g.spare)}</span></div>
        <div class="tl"><button class="btn sm keep" data-gact="keep">Keep all of these</button><button class="btn sm del" data-gact="delete">Approve spares for delete</button></div></div>
      <div class="group-row">${g.members.map((m, mi) => {
        const ud = m.user_decision;
        const badge = ud ? `<span class="badge ${ud === "keep" ? "user-keep" : "user-del"}">${ud === "keep" ? "You: keep" : "Approved for delete"}</span>` : `<span class="badge ${m.dup_best ? "best" : "spare"}">${m.dup_best ? "Suggested keep" : "Suggested delete"}</span>`;
        return tile(m, mi, badge).replace('class="tile', `data-gm="${mi}" class="tile`);
      }).join("")}</div></div>`;
  }).join("");
  if (reset) $("#groups").innerHTML = html || `<div class="empty">No duplicates found${S.status?.run?.running ? " yet" : ""}.</div>`;
  else $("#groups").insertAdjacentHTML("beforeend", html);
  $("#more").textContent = S.groups.length < S.gtotal ? "Loading more…" : S.gtotal ? "That's all." : "";
}

// ---------- people ----------
async function loadPeople() {
  S.persons = await api("/api/people" + (S.showHidden ? "?hidden=1" : ""));
  $("#people").innerHTML = `
    <div class="people-bar"><span class="dim">${num(S.persons.length)} ${S.showHidden ? "hidden" : ""} people · biggest first</span>
      <button class="btn sm ghost" id="toggleHidden">${S.showHidden ? "Back to people" : "Show hidden people"}</button></div>
    <div class="people-grid">${S.persons.map((p, i) => `
      <button class="person" data-p="${i}">
        <img src="/face/${p.cover_face}" alt="" loading="lazy">
        <div class="pn">${esc(p.name || "Person " + p.id)}${p.name_auto ? ` <span class="auto" title="Name taken from your Google Photos tags">G</span>` : ""}</div>
        <div class="pc">${num(p.items)} photos${p.to_delete ? ` · <span class="del-t">${num(p.to_delete)} to delete</span>` : ""}</div>
      </button>`).join("") || `<div class="empty">No people found${S.status?.run?.running ? " yet" : ""}.</div>`}</div>`;
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
    <button class="btn sm ghost" id="pBack">‹ All people</button>
    <img src="/face/${p.cover_face}" alt="">
    <input id="pName" value="${esc(p.name || "")}" placeholder="Person ${p.id}: type a name">
    <button class="btn sm" id="pSave">Save name</button>
    <select id="pMerge"><option value="">Same person as…</option>${others.map(o => `<option value="${o.id}">${esc(o.name || "Person " + o.id)} (${num(o.items)})</option>`).join("")}</select>
    <button class="btn sm ghost" id="pHide">${p.hidden ? "Unhide" : "Hide (not someone I know)"}</button>`;
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
  if (!(await confirmBox("Merge these people?", `All faces of ${S.person.name || "Person " + S.person.id} move to ${dst.name || "Person " + dst.id}.`, "Merge"))) { e.target.value = ""; return; }
  await api("/api/person/merge", { src: S.person.id, dst: dst.id });
  toast("Merged");
  S.persons = await api("/api/people");
  S.person = S.persons.find(x => x.id === dst.id) || null;
  loadView(true);
});
$("#personHead").addEventListener("keydown", e => { if (e.target.id === "pName" && e.key === "Enter") $("#pSave").click(); });

// ---------- views ----------
function maybeRefreshView(st) {
  const k = VIEW_COUNT[S.view];
  if (!k || S.loadedCount == null || S.view === "people") return;
  if (st.counts[k] === S.loadedCount) return;
  const busy = S.sel.size || !$("#viewer").hidden || S.items.length > 150 || window.scrollY > $(".review").offsetTop + 400;
  if (busy) $("#refreshNote").hidden = false;
  else loadView(true);
}

function setView(v, keepFilters = false) {
  S.view = v; S.bucket = ""; S.person = null; S.sel.clear(); updateSel();
  if (v !== "map" && !keepFilters) S.bbox = null;
  if (v === "approved" || v === "deleted" || v === "all") S.sort = S.q ? "relevance" : "date"; else if (v === "delete") S.sort = S.q ? "relevance" : "size";
  $("#sortSel").value = S.sort;
  $$("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.view === v));
  $("#hint").textContent = HINTS[v] || "";
  renderGPanel();
  loadView(true);
}

$("#grid").addEventListener("click", e => {
  if (e.target.closest("[data-stop]")) return;
  const t = e.target.closest(".tile");
  if (!t) return;
  const i = +t.dataset.i, id = +t.dataset.id;
  if (e.target.closest("[data-zoom]")) return openViewer(S.items, i, "grid");
  if (e.shiftKey && S.last != null) {
    const [a, b] = [Math.min(S.last, i), Math.max(S.last, i)];
    for (let k = a; k <= b; k++) S.sel.add(S.items[k].id);
  } else if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id);
  S.last = i;
  $$("#grid .tile").forEach(el => { const s = S.sel.has(+el.dataset.id); el.classList.toggle("sel", s); el.querySelector(".chk").textContent = s ? "✓" : ""; });
  updateSel();
});
$("#grid").addEventListener("dblclick", e => { const t = e.target.closest(".tile"); if (t) openViewer(S.items, +t.dataset.i, "grid"); });

$("#groups").addEventListener("click", async e => {
  const g = e.target.closest(".group"); if (!g) return;
  const grp = S.groups[+g.dataset.g];
  const act = e.target.closest("[data-gact]");
  if (act) {
    // your own choices win: spares you marked "keep" stay kept, and a kept copy you marked "delete" stays marked
    const spares = grp.members.filter(m => !m.dup_best && m.user_decision !== "keep").map(m => m.id);
    const yours = grp.members.filter(m => !m.dup_best && m.user_decision === "keep").length;
    if (act.dataset.gact === "keep") await decide(grp.members.map(m => m.id), "keep", true);
    else await decide(spares, "delete", true);  // the suggested-keep copy is left as it is: still the tool's suggestion
    toast(act.dataset.gact === "keep" ? "Keeping all of them"
      : `${spares.length} spare${spares.length === 1 ? "" : "s"} approved for delete` + (yours ? `, ${yours} you chose to keep left alone` : ""));
    return loadGroups(true);
  }
  const t = e.target.closest(".tile");
  if (t) openViewer(grp.members, +t.dataset.gm, "group");
});

function updateSel() {
  const n = S.sel.size;
  $("#selbar").hidden = !n;
  if (!n) return;
  $("#selCount").textContent = `${num(n)} selected`;
  const b = [];
  if (S.view === "delete") b.push(`<button class="btn keep" data-sa="keep">Keep</button>`, `<button class="btn danger" data-sa="delete">Approve for delete</button>`);
  else if (S.view === "keep") b.push(`<button class="btn danger" data-sa="delete">Approve for delete instead</button>`);
  else if (S.view === "approved") b.push(`<button class="btn" data-sa="gone">Mark deleted in Google</button>`, `<button class="btn ghost" data-sa="notgone">Not deleted yet</button>`, `<button class="btn ghost" data-sa="reset">Undo approval</button>`);
  else if (S.view === "deleted") b.push(`<button class="btn" data-sa="notgone">Not deleted yet (move back)</button>`);
  else b.push(`<button class="btn keep" data-sa="keep">Keep</button>`, `<button class="btn danger" data-sa="delete">Approve for delete</button>`);
  $("#selActions").innerHTML = b.join("");
}
$("#selClear").onclick = () => { S.sel.clear(); $$("#grid .tile.sel").forEach(el => { el.classList.remove("sel"); el.querySelector(".chk").textContent = ""; }); updateSel(); };
$("#selActions").addEventListener("click", async e => {
  const a = e.target.closest("[data-sa]")?.dataset.sa; if (!a) return;
  const ids = [...S.sel];
  if (a === "gone" || a === "notgone") { await api("/api/gone", { ids, gone: a === "gone" }); toast(a === "gone" ? "Marked as deleted in Google" : "Marked as not deleted"); }
  else await decide(ids, a === "reset" ? null : a);
  S.sel.clear(); updateSel(); loadView(true); pollOnce();
});

async function decide(ids, decision, quiet) {
  if (!ids.length) return;
  await api("/api/decide", { ids, decision });
  if (!quiet) toast(decision === "delete" ? `${num(ids.length)} approved for delete` : decision === "keep" ? `Keeping ${num(ids.length)}` : "Back to suggestions");
}

$("#actions").addEventListener("click", async e => {
  const a = e.target.closest("[data-bulk]")?.dataset.bulk; if (!a) return;
  const ok = await confirmBox(a === "delete" ? `Approve ${num(S.total)} for delete?` : `Keep ${num(S.total)}?`,
    a === "delete" ? `All ${num(S.total)} items shown (${gb(S.bytes)}) go to your delete list, including ones you haven't looked at. Photos you already chose to keep are left alone. You can still undo from the Approved tab.`
                   : `All ${num(S.total)} items shown move to Keeping.`, a === "delete" ? "Approve all for delete" : "Keep all");
  if (!ok) return;
  const body = Object.fromEntries(query());
  const r = await api("/api/decide", { ...body, decision: a });
  toast(`${num(r.changed)} updated`);
  loadView(true); pollOnce();
});

$("#tabs").addEventListener("click", e => { const b = e.target.closest("[data-view]"); if (b) setView(b.dataset.view); });
$$("#stats .stat").forEach(s => s.onclick = () => { setView(s.dataset.view); $(".review").scrollIntoView({ behavior: "smooth" }); });
$("#refreshNote").onclick = () => loadView(true);
new IntersectionObserver(es => {
  if (!es[0].isIntersecting || S.loading) return;
  if (S.view === "groups" ? S.groups.length < S.gtotal : S.items.length < S.total) loadView(false);
}, { rootMargin: "600px" }).observe($("#more"));

// ---------- run button ----------
$("#runBtn").onclick = async () => {
  try {
    if (S.status?.run?.running) { await api("/api/pause", {}); toast("Pausing after the current photos…"); }
    else { await api("/api/start", {}); toast("Started"); }
    pollOnce();
  } catch (e) { toast(e.message); }
};
async function pollOnce() { try { S.status = await api("/api/status"); renderStatus(S.status); } catch {} }

// ---------- viewer ----------
function openViewer(list, i, from) {
  S.vlist = list; S.vidx = i; S.vfrom = from;
  $("#viewer").hidden = false;
  renderViewer();
}
function closeViewer() {
  $("#viewer").hidden = true;
  const v = $("#stage video"); if (v) v.pause();
  $("#stage").innerHTML = "";
  if (S.vChanged) { S.vChanged = false; if (S.vfrom === "group") loadGroups(true); else loadView(true); pollOnce(); }
}
async function renderViewer() {
  const base = S.vlist[S.vidx];
  if (!base) return closeViewer();
  const it = await api("/api/item?id=" + base.id).catch(() => base);
  const e = effective(it);
  const browserImg = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(it.ext);
  let stage;
  if (it.kind === "video") {
    const playable = [".mp4", ".webm", ".m4v", ".mov"].includes(it.ext);
    stage = playable ? `<video src="/original/${it.id}" controls autoplay muted playsinline poster="/preview/${it.id}"></video>`
      : `<img src="/preview/${it.id}">`;
  } else stage = `<img src="/${browserImg ? "original" : "preview"}/${it.id}" alt="">`;
  if (it.keeper) {  // a spare copy: show the kept one next to it so the choice is easy to check
    const k = await api("/api/item?id=" + it.keeper).catch(() => null);
    if (k) {
      const kImg = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(k.ext) ? "original" : "preview";
      const info = x => `${gb(x.bytes)}${x.w ? ` · ${x.w}×${x.h}` : ""}${x.sharp != null ? ` · sharpness ${Math.round(x.sharp)}` : ""}`;
      stage = `<div class="compare">
        <figure><figcaption><b class="c-del">This one (suggested delete)</b><span>${esc(info(it))}</span></figcaption>${stage}</figure>
        <figure><figcaption><b class="c-keep">Suggested keep (${it.dup_kind === "exact" ? "identical copy" : "the better shot"})</b><span>${esc(info(k))}</span></figcaption>
          <img src="/${kImg}/${k.id}" alt=""></figure></div>`;
    }
  }
  $("#stage").innerHTML = stage;
  const isAppr = it.user_decision === "delete";
  const faces = it.faces || [];
  $("#side").innerHTML = `
    <div><span class="verdict ${e}">${verdictText(it)}</span></div>
    <div class="reason">${esc(it.reason || "Not decided yet")}</div>
    <div class="actions">
      <button class="btn keep" data-v="keep">Keep<kbd>K</kbd></button>
      <button class="btn danger" data-v="delete">${isAppr ? "Approved for delete" : "Approve for delete"}<kbd>D</kbd></button>
      ${it.keeper ? `<button class="btn danger wide" data-v="both" title="Neither shot is worth keeping">Approve both for delete<kbd>B</kbd></button>` : ""}
      ${it.user_decision ? `<button class="btn ghost wide" data-v="reset">Undo my choice<kbd>U</kbd></button>` : ""}
      ${isAppr ? `<button class="btn wide" data-v="gone">${it.gone ? "✓ Deleted in Google (undo)" : "I deleted it in Google"}<kbd>X</kbd></button>` : ""}
    </div>
    ${it.gurl ? `<a class="glink" href="${esc(it.gurl)}" target="_blank" rel="noopener">Open in Google Photos ↗</a><span class="dim small">Press <kbd>G</kbd> to open it</span>` : `<span class="dim small">No Google Photos link in this file's Takeout info.</span>`}
    <div class="sec"><h3>Tags</h3><div class="tagrow">
      ${it.type ? `<span class="tg strong">${esc(nm(it.type))}${it.type_score ? ` ${Math.round(it.type_score * 100)}%` : ""}</span>` : ""}
      ${it.event ? `<span class="tg strong">${esc(nm(it.event))}${it.event_score ? ` ${Math.round(it.event_score * 100)}%` : ""}</span>` : ""}
      ${(it.tag_scores || []).filter(t => t.tag !== "people").map(t => `<span class="tg">${esc(nm(t.tag))} ${Math.round(t.score * 100)}%</span>`).join("")}
      ${!it.type ? `<span class="dim small">Not tagged yet</span>` : ""}
    </div></div>
    ${faces.length ? `<div class="sec"><h3>People (${faces.length})</h3><div class="facerow">${faces.map(f =>
      `<button class="face" data-person="${f.person_id || ""}" title="${esc(f.person || "Not grouped (too small or seen too rarely)")}"><img src="/face/${f.id}" alt=""><span>${esc(f.person || "?")}</span></button>`).join("")}</div></div>` : ""}
    ${it.ocr_text ? `<div class="sec"><h3>Text found</h3><div class="ocr">${esc(it.ocr_text)}</div></div>` : ""}
    ${it.ai_verdict ? `<div class="sec"><h3>AI second opinion</h3><div>${esc(it.ai_verdict)}: ${esc(it.ai_reason || "")}</div><div class="dim small">${esc(it.description || "")}</div></div>` : ""}
    <dl class="kv">
      ${it.g_people ? `<dt>Google tags</dt><dd>${esc(JSON.parse(it.g_people).join(", "))}</dd>` : ""}
      ${it.origin ? `<dt>Came from</dt><dd>${esc(nm(it.origin))}${it.favorite ? " · ★ favorite" : ""}${it.in_storage === 0 ? " · doesn't use your storage" : ""}</dd>` : ""}
      <dt>File</dt><dd>${esc(it.name)}</dd>
      <dt>Folder</dt><dd>${esc(it.folder)}</dd>
      ${it.taken ? `<dt>Taken</dt><dd>${new Date(it.taken * 1000).toLocaleString()}</dd>` : ""}
      <dt>Size</dt><dd>${gb(it.bytes)}${it.w ? ` · ${it.w}×${it.h}` : ""}${it.kind === "video" ? ` · ${clip(it.duration)}` : ""}</dd>
      ${it.dup_group ? `<dt>Duplicates</dt><dd>${it.dup_best ? "Best copy in its group" : "Spare copy (" + esc(it.dup_kind) + ")"}</dd>` : ""}
      ${it.sharp != null ? `<dt>Sharpness</dt><dd>${Math.round(it.sharp)}</dd>` : ""}
      ${it.scan_error ? `<dt>Error</dt><dd>${esc(it.scan_error)}</dd>` : ""}
      <dt>Position</dt><dd>${S.vidx + 1} of ${S.vlist.length}</dd>
    </dl>`;
  S.vcur = it;
}
async function viewerAct(a) {
  const it = S.vcur; if (!it) return;
  if (a === "gone") {
    await api("/api/gone", { ids: [it.id], gone: !it.gone }); S.vChanged = true;
    S.vlist[S.vidx] = { ...S.vlist[S.vidx], gone: it.gone ? 0 : 1 };
    if (S.vfrom === "grid" && (S.view === "approved" || S.view === "deleted")) {  // it moves to the other tab
      S.vlist.splice(S.vidx, 1);
      if (S.vidx >= S.vlist.length) S.vidx = S.vlist.length - 1;
      if (S.vidx < 0) return closeViewer();
      return renderViewer();
    }
    if (!it.gone) return vStep(1);
    return renderViewer();
  }
  if (a === "delete" && it.user_decision === "delete") return vStep(1);
  if (a === "both") {  // this spare and the copy that was suggested to keep: neither is worth keeping
    if (!it.keeper) return;
    await decide([it.id, it.keeper], "delete", true);
    S.vChanged = true;
    toast("Both approved for delete");
    a = "delete";
  } else {
    await decide([it.id], a === "reset" ? null : a, true);
    S.vChanged = true;
    toast(a === "delete" ? "Approved for delete" : a === "keep" ? "Keeping it" : "Back to the suggestion");
  }
  const leaves = S.vfrom === "grid" && ((S.view === "delete" || S.view === "unsure") ? a !== "reset" : S.view === "keep" ? a === "delete" : S.view === "approved" ? a !== "delete" : false);
  if (leaves) {
    S.vlist.splice(S.vidx, 1);
    if (S.vidx >= S.vlist.length) S.vidx = S.vlist.length - 1;
    if (S.vidx < 0) return closeViewer();
    return renderViewer();
  }
  S.vlist[S.vidx] = { ...S.vlist[S.vidx], user_decision: a === "reset" ? null : a };
  vStep(1);
}
function vStep(d) {
  const n = S.vidx + d;
  if (n < 0 || n >= S.vlist.length) return toast(n < 0 ? "This is the first one" : "That was the last one");
  S.vidx = n; renderViewer();
}
$("#side").addEventListener("click", async e => {
  const b = e.target.closest("[data-v]"); if (b) return viewerAct(b.dataset.v);
  const f = e.target.closest("[data-person]");
  if (f && f.dataset.person) {
    closeViewer();
    S.persons = await api("/api/people");
    S.view = "people"; $$("#tabs button").forEach(x => x.classList.toggle("on", x.dataset.view === "people"));
    S.person = S.persons.find(p => p.id === +f.dataset.person) || null;
    $("#hint").textContent = HINTS.people;
    loadView(true); $(".review").scrollIntoView({ behavior: "smooth" });
  }
});
$("#vClose").onclick = closeViewer;
$("#vPrev").onclick = () => vStep(-1);
$("#vNext").onclick = () => vStep(1);
$("#viewer").addEventListener("click", e => { if (e.target.id === "viewer") closeViewer(); });
document.addEventListener("keydown", e => {
  if (e.target.matches("input, select, textarea")) return;
  if (!$("#viewer").hidden) {
    const k = e.key.toLowerCase();
    if (k === "escape") closeViewer();
    else if (k === "arrowright") vStep(1);
    else if (k === "arrowleft") vStep(-1);
    else if (k === "k") viewerAct("keep");
    else if (k === "d" || k === "delete") viewerAct("delete");
    else if (k === "b" && S.vcur?.keeper) viewerAct("both");
    else if (k === "u" && S.vcur?.user_decision) viewerAct("reset");
    else if (k === "x" && S.vcur?.user_decision === "delete") viewerAct("gone");
    else if (k === "g" && S.vcur?.gurl) window.open(S.vcur.gurl, "_blank", "noopener");
    else return;
    e.preventDefault();
  } else if (e.key === "Escape") { $$(".modal").forEach(m => { if (m.id !== "confirm") m.hidden = true; }); }
});

// ---------- settings ----------
async function openSettings() {
  const s = await api("/api/settings");
  $("#qwenOn").checked = s.use_qwen;
  $("#modelIn").value = s.model;
  $("#modelList").innerHTML = ["qwen2.5vl:7b", "qwen2.5vl:3b", ...s.ollama.models].map(n => `<option value="${esc(n)}">`).join("");
  const have = s.ollama.models || [];
  const note = () => {
    const n = $("#modelIn").value.trim();
    $("#modelNote").innerHTML = !s.ollama.ok ? "Ollama isn't running." : have.includes(n) || have.includes(n + ":latest") ? "Downloaded." : `Download it with <code>ollama pull ${esc(n)}</code>.`;
  };
  $("#modelIn").oninput = note; note();
  $("#workersIn").value = s.workers;
  $("#settings").hidden = false;
}
$("#settingsBtn").onclick = openSettings;
$("#ollamaPill").onclick = openSettings;
$("#saveSettings").onclick = async () => {
  await api("/api/settings", { model: $("#modelIn").value.trim(), workers: +$("#workersIn").value, use_qwen: $("#qwenOn").checked });
  $("#settings").hidden = true; toast("Saved. It applies from the next run."); pollOnce();
};
$("#settings").addEventListener("click", e => { if (e.target.id === "settings" || e.target.closest("[data-close]")) $("#settings").hidden = true; });
$("#resetBtn").onclick = async () => {
  $("#settings").hidden = true;
  const ok = await confirmBox("Start over?",
    "This clears everything the tool has worked out: tags, faces, people and their names, your keep and delete choices, and your delete list. " +
    "Your photos in the input folder and the downloaded models are not touched. This can't be undone.", "Clear everything");
  if (!ok) return;
  toast("Clearing… if a step is running, it finishes the current photo first");
  try {
    await api("/api/reset", {});
    S.person = null; S.sel.clear(); updateSel(); S.recentKey = "";
    toast("Everything was cleared. Press Start to run it again.");
    await pollOnce(); setView("delete");
  } catch (e) { toast(e.message); }
};

// ---------- map ----------
const M = { map: null, cluster: null, heat: null, rect: null, picking: false, start: null, fitted: false, points: [] };
const DOT = { keep: "#4cb782", delete: "#e5534b", unsure: "#e0a63a", approved: "#e5534b", pending: "#8a8a93" };

function initMap() {
  if (M.map || typeof L === "undefined") return;
  // boxZoom off: Shift+drag selects an area instead of zooming
  M.map = L.map("map", { zoomControl: true, worldCopyJump: true, boxZoom: false }).setView([20.6, 78.9], 4);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(M.map);
  M.cluster = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 45, chunkedLoading: true });
  M.map.addLayer(M.cluster);

  // Drag a box to pick an area. Listen on the map's own box (capture phase), because the dots and
  // cluster bubbles swallow mouse events: a drag that started or ended on one used to be lost.
  const box = $("#map");
  const at = e => M.map.mouseEventToLatLng(e);
  box.addEventListener("pointerdown", e => {
    if (e.button !== 0 || !(M.picking || e.shiftKey)) return;
    e.preventDefault(); e.stopImmediatePropagation();  // the map must not start panning
    if (!M.picking) setPicking(true);
    M.start = at(e);
    try { box.setPointerCapture(e.pointerId); } catch { /* keep going without capture */ }
    if (M.rect) M.map.removeLayer(M.rect);
    M.rect = L.rectangle([M.start, M.start], { color: "#e8623a", weight: 2, fillOpacity: 0.12, interactive: false }).addTo(M.map);
  }, true);
  box.addEventListener("pointermove", e => {
    if (!M.start || !M.rect) return;
    e.preventDefault(); e.stopImmediatePropagation();
    M.rect.setBounds([M.start, at(e)]);
  }, true);
  const finish = e => {
    if (!M.start) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const b = L.latLngBounds(M.start, at(e));
    M.start = null; setPicking(false);
    try { box.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    const tiny = M.map.latLngToContainerPoint(b.getNorthEast()).distanceTo(M.map.latLngToContainerPoint(b.getSouthWest())) < 8;
    if (tiny) { if (M.rect) M.map.removeLayer(M.rect); M.rect = null; return; }  // a click, not a drag
    pickArea([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]);
  };
  box.addEventListener("pointerup", finish, true);
  box.addEventListener("pointercancel", finish, true);
}

function pickArea(bbox) {
  S.bbox = bbox.map(x => +(+x).toFixed(6));
  $("#mapClear").hidden = false; $("#mapOpen").hidden = false;
  S.sel.clear(); updateSel();
  loadView(true);  // the grid below now shows only the photos in this area
  setTimeout(() => $("#toolbar").scrollIntoView({ behavior: "smooth", block: "start" }), 200);
}

function showArea() {  // draw the picked area (also when it came from the page address)
  if (!M.map || !S.bbox) return;
  if (M.rect) M.map.removeLayer(M.rect);
  const [s, w, n, e] = S.bbox;
  M.rect = L.rectangle([[s, w], [n, e]], { color: "#e8623a", weight: 2, fillOpacity: 0.12, interactive: false }).addTo(M.map);
}

function setPicking(on) {
  M.picking = on;
  if (!M.map) return;
  on ? M.map.dragging.disable() : M.map.dragging.enable();
  $("#map").classList.toggle("picking", on);
  $("#mapSelect").textContent = on ? "Now drag a box on the map… (press again to cancel)" : "Select an area";
}

async function loadMap() {
  initMap();
  if (!M.map) { $("#mapInfo").textContent = "The map library didn't load."; return; }
  setTimeout(() => M.map.invalidateSize(), 50);  // the map was hidden until now
  const q = query(); q.delete("bbox"); q.delete("sort");
  M.points = await api("/api/geo?" + q).catch(() => []);
  M.cluster.clearLayers();
  const markers = M.points.map(p => {
    const m = L.circleMarker([p.lat, p.lon], { radius: 7, color: "#fff", weight: 1.5, fillColor: DOT[p.d] || DOT.pending, fillOpacity: 0.95 });
    m.on("click", () => openViewer([{ id: p.id }], 0, "map"));
    return m;
  });
  M.cluster.addLayers(markers);
  if (M.heat) { M.map.removeLayer(M.heat); M.heat = null; }
  if ($("#mapHeat").checked && L.heatLayer) M.heat = L.heatLayer(M.points.map(p => [p.lat, p.lon, 1]), { radius: 22, blur: 18, maxZoom: 12 }).addTo(M.map);
  $("#mapInfo").textContent = `${num(M.points.length)} photos with a location` + (S.bbox ? " · area selected" : "");
  if (!M.fitted && S.bbox) { const [s, w, n, e] = S.bbox; M.map.fitBounds([[s, w], [n, e]]); M.fitted = true; }
  if (M.points.length && !M.fitted) { M.map.fitBounds(L.latLngBounds(M.points.map(p => [p.lat, p.lon])).pad(0.1)); M.fitted = true; }
  showArea();
  $("#mapClear").hidden = $("#mapOpen").hidden = !S.bbox;
}

$("#mapSelect").onclick = () => setPicking(!M.picking);
$("#mapOpen").onclick = () => {  // the same area (and filters) in the Everything tab, in a new browser tab
  const q = query(); q.set("view", "all"); q.delete("geo"); q.delete("offset"); q.delete("limit");
  window.open("/?" + q.toString(), "_blank");
};
$("#mapClear").onclick = () => {
  S.bbox = null; $("#mapClear").hidden = true; $("#mapOpen").hidden = true;
  if (M.rect) { M.map.removeLayer(M.rect); M.rect = null; }
  S.sel.clear(); updateSel(); loadView(true);
};
$("#mapHeat").onchange = () => loadMap();

// ---------- delete in Google (needs the Photo Cleaner helper extension) ----------
const G = { ext: null, running: false, lastDone: 0, perItem: 6 };
const SPEEDS = { careful: [3000, 5000], normal: [1000, 2500], fast: [500, 1000] };  // pause between photos, ms
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
  if (!G.ext) $("#gpState").innerHTML = `The helper extension isn't installed in this browser. Load the <code>extension</code> folder: open <code>edge://extensions</code> or <code>chrome://extensions</code>, turn on Developer mode, click Load unpacked.`;
  else if (!G.running) $("#gpState").textContent = "Opens a small Google Photos window (where you're signed in) and moves each photo below to the trash, one at a time, at the speed you pick. Leave that window visible: don't minimize it or cover it completely. Run it in test mode first.";
}

function renderGStatus(m) {
  G.running = !!m.running;
  $("#gpStart").hidden = G.running; $("#gpStop").hidden = !G.running;
  $("#gpTest").disabled = G.running; $("#gpBatch").disabled = G.running; $("#gpSpeed").disabled = G.running;
  const p = $("#gpProgress");
  if (m.total == null) { p.hidden = true; renderGPanel(); return; }
  p.hidden = false;
  const test = m.mode !== "delete";
  const left = Math.max(0, m.total - m.at);
  p.innerHTML = `<b>${m.running ? (test ? "Testing" : "Deleting") : "Finished"}</b> · ${num(Math.min(m.at + (m.running ? 1 : 0), m.total))} of ${num(m.total)}
    · <span class="ok">${num(m.done)} ${test ? "checked OK" : "moved to trash"}</span>
    ${m.missing ? ` · ${num(m.missing)} not found` : ""}${m.problems ? ` · <span class="bad">${num(m.problems)} problems</span>` : ""}
    ${m.running ? ` · about ${dur(left * (G.perItem || 6))} left` : ""}
    ${m.stopReason ? `<div class="bad">Stopped: ${esc(m.stopReason)}</div>` : ""}
    ${!m.running && !test && m.done ? `<div class="dim">Done. Remember to empty the trash in Google Photos to get the space back.</div>` : ""}`;
  $("#gpLog").innerHTML = (m.log || []).map(l => `<li class="${l.status}"><b>${esc(l.name || "")}</b> ${esc(l.message || l.status)}</li>`).join("");
  $("#gpState").textContent = G.running ? "Working in the small Google Photos window. Keep it visible on screen; you can use other windows meanwhile." : "";
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
  if (!test && !(await confirmBox(`Move ${num(list.length)} photos to the Google Photos trash?`,
      `A small Google Photos window opens and the helper moves each photo to the trash there. Keep that window visible until it finishes. Google keeps them in the trash for 30 days, so you can restore them there. Keep this browser open until it finishes.`,
      "Move to trash"))) return;
  const pace = SPEEDS[$("#gpSpeed").value] || SPEEDS.normal;
  G.perItem = 4 + (pace[0] + pace[1]) / 2000;  // about 4 s to open a photo, plus the pause
  toExt({ type: "start", items: list, mode: test ? "test" : "delete", api: location.origin, pauseMin: pace[0], pauseMax: pace[1] });
};
$("#gpStop").onclick = () => toExt({ type: "stop" });

// ---------- photos folder picker ----------
const PK = { path: "" };
async function openPicker() {
  $("#settings").hidden = true;
  $("#picker").hidden = false;
  await browse(S.status?.input || "");
}
async function browse(path) {
  const r = await api("/api/folders?path=" + encodeURIComponent(path || "")).catch(e => ({ error: e.message, folders: [], roots: [] }));
  if (r.error && path) return browse("");  // e.g. the saved folder no longer exists: start from the top
  PK.path = r.path || "";
  $("#pkPath").textContent = PK.path || "Choose a starting place";
  $("#pkUp").disabled = !r.parent; $("#pkUp").onclick = () => browse(r.parent);
  $("#pkRoots").innerHTML = (r.roots || []).map(x => `<button class="chip" data-go="${esc(x)}">${esc(x)}</button>`).join("");
  $("#pkList").innerHTML = (r.folders || []).map(f => `<li><button data-go="${esc(f.path)}">📁 ${esc(f.name)}</button></li>`).join("")
    || `<li class="dim small">${PK.path ? "No folders inside this one." : ""}</li>`;
  $("#pkInfo").textContent = PK.path ? (r.media ? `${num(r.media)} photos and videos right in this folder, plus any in subfolders` : "Subfolders are included") : "";
  $("#pkUse").disabled = !PK.path;
}
$("#picker").addEventListener("click", e => {
  const g = e.target.closest("[data-go]"); if (g) return browse(g.dataset.go);
  if (e.target.id === "picker" || e.target.closest("[data-close]")) $("#picker").hidden = true;
});
$("#pkUse").onclick = async () => {
  const send = reset => fetch("/api/folder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: PK.path, reset }) })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  let r = await send(false);
  if (r.status === 409 && r.body.needs_reset) {
    $("#picker").hidden = true;
    const ok = await confirmBox("Switch to this folder?",
      `The results for the current folder (${num(r.body.count)} files: tags, people, your keep and delete choices) are cleared first, so two libraries never get mixed. Your photos aren't touched.`,
      "Switch folder");
    if (!ok) return;
    r = await send(true);
  }
  if (r.status !== 200) return toast(r.body.error || "Couldn't use that folder");
  $("#picker").hidden = true;
  toast("Photos folder set. Press Start.");
  await pollOnce(); setView(S.view);
};
$("#pickFolder").onclick = openPicker;
$("#inputPath").onclick = openPicker;
document.addEventListener("click", e => { if (e.target.closest("[data-pick]")) openPicker(); });

// ---------- go ----------
// the page address can carry a view and filters, e.g. /?view=all&bbox=18.3,73.6,18.8,74.1&type=photo
{
  const u = new URLSearchParams(location.search);
  for (const k of FILTERS) if (u.get(k)) S.f[k] = u.get(k);
  if (u.get("q")) { S.q = u.get("q"); $("#searchIn").value = S.q; }
  const bb = (u.get("bbox") || "").split(",").map(Number);
  if (bb.length === 4 && bb.every(Number.isFinite)) S.bbox = bb;
  setView(u.get("view") || "delete", true);
}
pollStatus();
pollRecent();

(() => {
/* ---------------- content: loaded from the database after sign-in ---------------- */
let PERSONAS = [], P = {}, ALL = [], LOCS = [], LOC = {}, GROUP_ROOMS = {}, BASE = [], WHITE = [], DEFAULT_MODELS = [], DEFAULT_CAST = {},
    SCHEDULE = [], CAMS = {}, COVERAGE = [], DEFAULT_BLOCKS = [], EMERGENCY = [], ADD_LOCS = [], HM = null, TIMING0 = null, VIDEO_ROOM = {}, VIDEO_SHOTS = {};
let IMAGES = {};
function applyContent(c){
  ({PERSONAS, LOCS, GROUP_ROOMS, BASE, WHITE, DEFAULT_MODELS, DEFAULT_CAST, SCHEDULE, CAMS, COVERAGE, DEFAULT_BLOCKS, EMERGENCY, ADD_LOCS} = c); HM = c.HM || null; TIMING0 = c.TIMING || null; VIDEO_ROOM = c.VIDEO_ROOM || {}; VIDEO_SHOTS = c.VIDEO_SHOTS || {};
  P = Object.fromEntries(PERSONAS.map(p => [p.id, p])); ALL = PERSONAS.map(p => p.id); LOC = Object.fromEntries(LOCS.map(l => [l.id, l])); LOC.white = LOC.white || {id:"white", name:"White background", code:"W"};
}

/* ---------------- state ---------------- */
let plan = {}, ticks = {}, customs = [], changes = [];
let me = null, rev = -1, synced = false, online = true;
const store = {get(k){try{return JSON.parse(localStorage.getItem(k))}catch(e){return null}}, set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}, del(k){try{localStorage.removeItem(k)}catch(e){}}};
let mode = store.get("st-mode") || "plan";
let tab = store.get("st-tab") || "live";
let persona = store.get("st-persona") || "bookworm";
let locFilter = "all", personaFilter = "all", showRemoved = false, editing = null, adding = false;
let draft = {title:"", loc:"bed", note:"", props:"", img:"", busy:false};
const role = () => me ? me.role : "";
const isOwner = () => role() === "owner";
const isModel = () => role() === "model";
const canWrite = true;

const ov = id => (plan.shots && plan.shots[id]) || {};
function allShots(){
  const base = BASE.map(s => ({...s, title: ov(s.id).title || s.title, note: ov(s.id).note ?? s.note, props: Array.isArray(ov(s.id).props) ? ov(s.id).props : s.props}));
  const add = customs.map(c => ({id:c.id, loc:c.loc, gl:c.gl||"", title: ov(c.id).title || c.title || "New shot", note: ov(c.id).note ?? (c.note||""), props: Array.isArray(ov(c.id).props) ? ov(c.id).props : (c.props||[]), who:c.who||[], prio:c.prio||"must", imgData:c.img||"", custom:true, created:c.created||0}));
  return [...base, ...add];
}
const shotById = id => allShots().find(s => s.id === id);
const isRemoved = id => !!ov(id).removed;
const activeShots = () => allShots().filter(s => !isRemoved(s.id));
const models = () => Array.isArray(plan.models) && plan.models.length ? plan.models : DEFAULT_MODELS;
const meta = () => { const m = Object.assign({date:"", address:"", hmCall:"", contact:""}, plan.meta||{}); if (!m.date && HM) m.date = HM.date; return m; };
// Hair and makeup: matches names loosely (ignores case and extra spaces).
const sameName = (a, b) => { const n = x => String(x || "").trim().toLowerCase(); return n(a) === n(b); };
const hmRow = name => HM ? HM.rows.find(r => sameName(r.name, name)) : null;
const hmNotes = name => HM ? HM.notes.filter(n => n.who === "all" || n.who.split(",").some(w => sameName(w, name))) : [];
const castOf = pid => (plan.cast && pid in plan.cast) ? plan.cast[pid] : (DEFAULT_CAST[pid] || "");
const whoOf = id => Array.isArray(ov(id).who) ? ov(id).who : ((shotById(id)||{}).who || []);
const prioOf = id => ov(id).prio || (shotById(id)||{}).prio || "must";
const tickOf = (k, id) => ticks[k] && ticks[k][id];
const isTicked = (k, id) => !!tickOf(k, id);
const hhmm = iso => { const d = new Date(iso); return isNaN(d) ? "" : String(d.getHours()).padStart(2,"0") + ":" + String(d.getMinutes()).padStart(2,"0"); };
const byLine = (k, id) => { const t = tickOf(k, id); return t && t.by ? `${t.by} · ${hhmm(t.at)}` : ""; };

/* ---------------- server (Supabase, through locked-down functions only) ---------------- */
const CFG = window.SHOOT_CONFIG || {};
async function rpc(fn, args){
  const r = await fetch(CFG.url.replace(/\/$/, "") + "/rest/v1/rpc/" + fn, {method:"POST", headers: Object.assign({"Content-Type":"application/json", apikey:CFG.anonKey}, /^eyJ/.test(CFG.anonKey) ? {Authorization:"Bearer " + CFG.anonKey} : {}), body: JSON.stringify(args)});
  const txt = await r.text(); let j = null; try { j = txt ? JSON.parse(txt) : null; } catch(e){}
  if (!r.ok){ const err = new Error((j && (j.message || j.hint)) || ("HTTP " + r.status)); err.status = r.status; throw err; }
  return j;
}
// Each browser tab remembers its own person (so you can test several people side by side);
// the last one used is also remembered for next time.
const tabStore = {get(k){try{return sessionStorage.getItem(k)}catch(e){return null}}, set(k,v){try{sessionStorage.setItem(k,v)}catch(e){}}, del(k){try{sessionStorage.removeItem(k)}catch(e){}}};
let lockedCode = null;
const accessCode = () => lockedCode || tabStore.get("st-code") || store.get("st-code");
const rememberCode = c => { tabStore.set("st-code", c); store.set("st-code", c); };
const isObj = v => v && typeof v === "object" && !Array.isArray(v);
function deepMerge(a, b){ const o = Object.assign({}, a); for (const k in b){ o[k] = (isObj(b[k]) && isObj(a && a[k])) ? deepMerge(a[k], b[k]) : b[k]; } return o; }
let qPlan = Promise.resolve();
function savePlan(patch, summary){
  if (!isOwner()) return;
  plan = deepMerge(plan, patch); render();
  const snapshot = plan;
  qPlan = qPlan.then(() => rpc("st_save_plan", {p_code: accessCode(), p_plan: snapshot, p_summary: summary || null})).then(v => { rev = v; }).catch(onWriteErr);
}
const pendingTicks = new Map();
function applyTickLocal(kind, key, on){
  ticks = Object.assign({}, ticks); ticks[kind] = Object.assign({}, ticks[kind]);
  if (on) ticks[kind][key] = {by: me.name, at: new Date().toISOString()}; else delete ticks[kind][key];
}
function setTick(kind, key, on){
  const pk = kind + "|" + key, n = (pendingTicks.get(pk) || {n:0}).n + 1;
  pendingTicks.set(pk, {kind, key, on, n});
  applyTickLocal(kind, key, on); render();
  rpc("st_tick", {p_code: accessCode(), p_kind: kind, p_key: key, p_on: !!on})
    .then(v => { if (pendingTicks.get(pk) && pendingTicks.get(pk).n === n) pendingTicks.delete(pk); rev = Math.max(rev, v); })
    .catch(e => { pendingTicks.delete(pk); onWriteErr(e); refresh(true); });
}
function onWriteErr(e){
  if (e && e.status >= 400 && e.status < 500 && e.message && !/^HTTP/.test(e.message)) toast("That didn't save: " + e.message);
  else if (e && e.status === 403) toast("You can't change that.");
  else toast("That change didn't save. Check your connection and try again.");
}
function applyLoad(d){
  if (d.content) applyContent(d.content);
  plan = d.plan || {}; ticks = d.ticks || {}; changes = d.changes || []; rev = d.rev;
  pendingTicks.forEach(t => applyTickLocal(t.kind, t.key, t.on));
  customs = (d.custom || []).map(c => ({...c, id: c.id}));
  synced = true;
}
async function refresh(force){
  try {
    const v = await rpc("st_rev", {p_code: accessCode()});
    online = true;
    if (!force && v === rev) return;
    applyLoad(await rpc("st_load", {p_code: accessCode()}));
    render(true);
  } catch(e){ if (e.status === 401 || e.status === 403){ signOut("That link or code isn't valid any more."); } else { online = false; render(); } }
}
async function connect(){
  const fromLink = (location.hash.match(/k=([A-Za-z0-9]+)/) || [])[1];
  if (fromLink){ rememberCode(fromLink); history.replaceState(null, "", location.pathname); }
  if (!CFG.url || !CFG.anonKey){ showLogin("The app isn't connected to its database yet (config.js)."); return; }
  if (!accessCode()){ showLogin(); return; }
  showLoading();
  try {
    lockedCode = accessCode(); tabStore.set("st-code", lockedCode);
    const d = await rpc("st_load", {p_code: lockedCode});
    me = d.me; applyLoad(d);
    if (!d.content){ showLogin("The plan hasn't been loaded into the database yet."); return; }
    IMAGES = toBlobUrls(await rpc("st_images", {p_code: accessCode()}) || {});
    if (!isModel() && !["live","glam","shots","moods","rooms","models","schedule","props","campus"].includes(tab)) tab = "live";
    if (isModel()) mode = "day";
    else if (!isOwner() && mode === "plan" && isShootDay()) mode = "day";
    document.body.dataset.role = role();
    render();
    setInterval(() => refresh(false), 8000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(false); });
  } catch(e){
    if (e.status === 401 || e.status === 403 || /code/i.test(e.message)) signOut("That link or code isn't valid. Check it and try again.");
    else showLogin("Couldn't reach the plan. Check your connection and try again.");
  }
}
// Turn the photos into blob links once, so redrawing the page reuses them instead of re-decoding (no flicker or jumping).
function toBlobUrls(map){
  const out = {};
  for (const [id, d] of Object.entries(map)){
    try { const [h, b64] = d.split(","), bin = atob(b64), arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      out[id] = URL.createObjectURL(new Blob([arr], {type: (h.match(/data:([^;]+)/) || [])[1] || "image/jpeg"})); } catch(e){ out[id] = d; }
  }
  return out;
}
function signOut(msg){ lockedCode = null; store.del("st-code"); tabStore.del("st-code"); me = null; showLogin(msg); }
function showLoading(){ document.body.dataset.role = "none"; document.getElementById("main").innerHTML = `<p class="muted" style="padding:40px 0">Opening the plan…</p>`; }
function showLogin(msg){
  document.body.dataset.role = "none";
  document.getElementById("main").innerHTML = `<section class="login">
    <div class="eyebrow">So Temi · lounge wear launch</div>
    <h2>The Launch Shoot</h2>
    <p class="muted">This plan is private. Open the personal link you were sent, or type your access code.</p>
    ${msg ? `<div class="alert bad">${esc(msg)}</div>` : ""}
    <form id="loginForm" class="editf"><label>Access code<input id="codeIn" autocomplete="off" autocapitalize="characters" spellcheck="false" required></label>
    <button class="btn" type="submit">Open the plan</button></form></section>`;
}
document.addEventListener("submit", e => { if (e.target.id === "loginForm"){ e.preventDefault(); const c = document.getElementById("codeIn").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, ""); if (c){ rememberCode(c); connect(); } } });

/* ---------------- role views: alerts for the overview, and each model's own page ---------------- */
const READY = ["Hair done", "Makeup done", "Dressed in my set", "My props are with me"];
const READY_OF = {hair: 0, makeup: 1};
function alerts(){
  if (isModel()) return "";
  const help = Object.entries(ticks.help || {});
  const seen = store.get("st-seen-" + me.name) || 0;
  const fresh = isOwner() ? [] : changes.filter(c => c.id > seen && c.by !== me.name);
  const when = iso => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString(undefined, {day:"numeric", month:"short"}) + " · " + hhmm(iso); };
  return (help.length ? help.map(([n, t]) => `<div class="alert bad row" style="margin-bottom:10px;justify-content:space-between"><span><b>${esc(n)} needs help</b> (since ${esc(hhmm(t.at))})</span><button class="btn" data-act="helpdone" data-k="${esc(n)}">Sorted</button></div>`).join("") : "")
    + (fresh.length ? `<div class="box" style="margin-bottom:14px;border:2px solid var(--accent)"><div class="eyebrow" style="margin-bottom:6px">The plan changed</div><ul class="list">${fresh.slice(0, 8).map(c => `<li style="display:block">• <b>${esc(c.by)}</b>: ${esc(c.summary)} <span class="muted" style="font-size:12px">${esc(when(c.at))}</span></li>`).join("")}</ul>${fresh.length > 8 ? `<p class="muted" style="margin:6px 0 0">and ${fresh.length - 8} more</p>` : ""}<button class="btn" data-act="seen" style="margin-top:10px">Got it</button></div>` : "");
}
function readyPanel(){
  const list = models().map((m, i) => ({n: m.name, i, p: PERSONAS.find(x => sameName(castOf(x.id), m.name))}));
  if (!list.length) return "";
  return `<div class="section-h"><div><h2>Ready check</h2><p class="lede">Each model ticks these on her own page. Untick anything that's wrong.</p></div></div>
    <div class="cols">${list.map(({n, i, p}) => { const got = READY.filter((_, j) => isTicked("ready", n + "-" + j)).length; return `<section class="pbox"><h3>${esc(n)} ${p ? `<span class="p-tag pc-${p.id}" style="font-family:var(--body);font-size:13px;vertical-align:middle">${esc(p.name)}</span>` : `<span class="muted" style="font-family:var(--body);font-size:13px">not cast yet</span>`} <span class="muted tnum" style="font-size:14px">${got}/${READY.length}</span></h3>
      ${READY.map((r, j) => `<label class="check"><input type="checkbox" id="rd-${i}-${j}" data-act="ready" data-k="${esc(n + "-" + j)}" ${isTicked("ready", n + "-" + j) ? "checked" : ""}><span>${esc(r)}${byLine("ready", n + "-" + j) ? ` <span class="src">${esc(byLine("ready", n + "-" + j))}</span>` : ""}</span></label>`).join("")}</section>`; }).join("")}</div>`;
}
const fmtDur = m => { m = Math.max(0, Math.round(m)); const h = Math.floor(m / 60), r = m % 60; return h ? h + " h" + (r ? " " + r + " min" : "") : r + " min"; };
function glamNext(name){
  const rows = glamFor(name); if (!rows.length || rows.some(r => r.status === "running")) return "";
  const nxt = rows.find(r => r.status === "waiting"), t = nowMins();
  if (nxt) return `<div style="margin:0 0 12px;padding:12px 14px;border-radius:12px;border:1px solid var(--line)"><div class="eyebrow">Your next appointment</div><div style="margin-top:4px"><b>Your ${esc(nxt.kind)}${nxt.note ? " (" + esc(nxt.note) + ")" : ""} at ${esc(fmtClock(nxt.s))}</b></div><div class="big tnum" style="margin-top:2px">${nxt.s > t ? esc(fmtDur(nxt.s - t)) + " to go" : "Any minute now"}</div></div>`;
  if (rows.every(r => r.status === "done")) return `<div style="margin:0 0 12px;padding:12px 14px;border-radius:12px;border:1px solid var(--line)"><b>That's all your hair and makeup done!</b> Next stop: the studio, dressed and on set by ${esc(fmtClock(mins(timing().start)))}.</div>`;
  return "";
}
function hmBox(name){
  const r = hmRow(name); if (!r) return "";
  return `<section class="panel" style="margin-top:12px">
      <div class="eyebrow">Your hair and makeup call</div>
      ${glamFor(name).map(g => g.status === "running" ? `<div style="margin:8px 0 12px;padding:12px 14px;border-radius:12px;background:var(--sunk)"><div class="eyebrow">Your ${esc(g.kind)} is happening now</div><div class="big tnum" style="margin-top:4px;${g.over ? "color:var(--warn)" : ""}">${g.over ? overTxt(g) : g.left + " min left"}</div><div class="muted" style="font-size:13px">Due to finish ${esc(fmtClock(g.due))}</div></div>` : g.status === "waiting" && g.late > 0 ? `<p class="tbc" style="margin:8px 0 10px">Running late: your ${esc(g.kind)} now starts about ${esc(fmtClock(g.s))}.</p>` : g.status === "done" ? (isTicked("ready", name + "-" + READY_OF[g.kind]) ? `<p class="muted" style="margin:8px 0 10px">✓ Your ${esc(g.kind)} is done. You're looking so T!</p>` : `<div style="margin:8px 0 12px;padding:12px 14px;border-radius:12px;background:var(--sunk)"><b>Your ${esc(g.kind)} is done!</b> Please go ahead and tick your ${esc(g.kind)} box below. You're looking so T! 💕</div>`) : "").join("")}
      ${glamNext(name)}
      <div class="big tnum" style="margin-top:6px">Arrive by ${esc(r.arrive)}</div>
      <dl class="kv" style="margin-top:10px">
        <dt>Hair (${esc(HM.hairArtist)})</dt><dd>${esc(r.hair)}</dd>
        <dt>Makeup (${esc(HM.makeupArtist)})</dt><dd>${esc(r.makeup)}</dd>
        <dt>Where</dt><dd>${esc(HM.location)}</dd>
        <dt>Ready by</dt><dd>${esc(HM.prep)}</dd>
      </dl>
      <ul class="list" style="margin-top:10px">${hmNotes(name).filter(n => !n.teamOnly).map(n => `<li>• ${esc(n.you || n.t)}</li>`).join("")}</ul>
      <p style="margin:12px 0 0;color:var(--accent);font-weight:600">Thank you, we can't wait to see you! 💕</p>
    </section>`;
}
function myHereHTML(pid){
  const t = clockNow(), mine = buildDay().steps.filter(x => x.who.includes(pid) && !["move", "buffer", "wait", "brief", "wrap"].includes(x.kind)).sort((a, b) => a.s - b.s);
  const cur = mine.find(x => t >= x.s && t < x.e), nxt = mine.find(x => x.s > t);
  return `<div class="box" style="margin-bottom:16px"><div class="eyebrow">Where you are</div>
    <p style="margin:6px 0"><b>Now:</b> ${cur ? `${esc(roomOf(cur))} until ${clock24(cur.e)}` : "nothing booked for you"}</p>
    <p style="margin:6px 0 0"><b>Next:</b> ${nxt ? `${esc(roomOf(nxt))} at ${clock24(nxt.s)}` : "nothing else booked"}</p></div>`;
}
function viewMine(forPid){
  const name = forPid ? (castOf(forPid) || P[forPid].name) : me.name, p = forPid ? P[forPid] : PERSONAS.find(x => sameName(castOf(x.id), name)), md = meta(), m = models().find(x => sameName(x.name, name));
  const helpOn = isTicked("help", name);
  const head = `<section class="panel hero" style="margin-top:18px">
      <div class="eyebrow">Your page</div>
      <div class="big" style="margin-top:6px">Hi ${esc(name)}</div>
      ${p ? `<p style="margin:8px 0 0">You're the <b>${esc(p.name)}</b>. ${esc(p.vibe)}</p>` : ""}
      <dl class="kv" style="margin-top:12px">
        <dt>Date</dt><dd>${md.date ? esc(fmtDate(md.date)) : "To be confirmed"}</dd>
        <dt>Shoot</dt><dd>${esc(timing().start)}–${esc(timing().end)}, on set and dressed by ${esc(timing().start)}</dd>
        <dt>Studio</dt><dd>${md.address ? esc(md.address) : "To be shared separately"}</dd>
        ${m ? `<dt>Wearing</dt><dd>${esc(m.set)} (${esc(m.size)})</dd>` : ""}
        ${md.contact ? `<dt>Contact</dt><dd>${esc(md.contact)}</dd>` : ""}
      </dl>
    </section>
    ${hmBox(name)}
    <button class="btn ${helpOn ? "" : "ghost"}" data-act="help" style="width:100%;margin:12px 0 4px">${helpOn ? "Help is on the way (tap to cancel)" : "I need help"}</button>`;
  if (!p) return head + `<div class="box" style="margin-top:14px">The brand owner is still choosing your personality. Your timetable and shots will show up here once that's done.</div>`;
  const now = myNowNext(p.id);
  const ready = `<div class="section-h"><div><h2>Before you start</h2></div></div><div class="box">${READY.map((r, i) => `<label class="check"><input type="checkbox" id="my-r-${i}" data-act="ready" data-k="${esc(name + "-" + i)}" ${isTicked("ready", name + "-" + i) ? "checked" : ""}><span>${esc(r)}</span></label>`).join("")}</div>`;
  const timeline = `<div class="section-h"><div><h2>Where you need to be</h2><p class="lede">Your time in each room, in order. The coordinators will tell you which shots to take on the day.</p></div></div>${myRoomsHTML(p.id)}`;
  // Her shots in the same order as her timetable: location, then group, then videos. Bonus shots go last, apart.
  const order = {loc: [], white: [], group: [], video: [], mix: [], bonus: []}, seen = new Set();
  const put = (k, s) => { if (s && !seen.has(s.id)){ seen.add(s.id); order[k].push(s); } };
  buildDay().steps.filter(x => x.who.includes(p.id)).sort((a, b) => a.s - b.s).forEach(x => {
    if (x.kind === "shot") put("loc", shotById(x.shotId));
    else if (x.kind === "group") put("group", shotById(x.shotId));
    else if (["video", "videoturn", "groupvideo"].includes(x.kind)) put("video", shotById(x.shotId));
    else if (x.kind === "mix") (x.shots || []).forEach(id => put("mix", shotById(id)));
  });
  shotsFor(p.id).forEach(s => put(prioOf(s.id) === "bonus" ? "bonus" : s.loc === "white" ? "white" : s.loc === "group" ? "group" : s.loc === "video" ? "video" : s.loc === "mix" ? "mix" : "loc", s));
  const grp = (h, arr) => arr.length ? `<div class="section-h"><div><h2>${h}</h2></div></div><div class="grid">${arr.map(shotCard).join("")}</div>` : "";
  const moodImg = IMAGES["mood-" + p.id];
  const white = `<div class="section-h"><div><h2>Your mood board</h2><p class="lede">Your pose inspo for the white background. Tap a code above to open a picture.</p></div></div>${moodImg ? `<img src="${moodImg}" alt="${esc(p.name)} moodboard" loading="lazy" style="width:100%;max-width:560px;border-radius:12px;margin-bottom:12px">` : ""}<div class="box">${WHITE.map((w, i) => `<label class="check"><input type="checkbox" id="my-w-${i}" data-act="white" data-k="${p.id}-${i}" ${isTicked("white", p.id + "-" + i) ? "checked" : ""}><span>${esc(w)}</span></label>`).join("")}</div>`;
  const props = `<div class="section-h"><div><h2>Your personality props</h2></div></div><div class="box"><ul class="list">${p.props.map(x => `<li>• ${esc(x)}</li>`).join("")}</ul></div>`;
  return head + now + myHereHTML(p.id) + ready + timeline
    + `<p class="muted" style="margin:18px 0 0">Tap “Mark as shot” straight after each shot, once the photographer says you've got it. Tap it again if you ticked the wrong one.</p>`
    + grp("Your location shots", order.loc)
    + grp("White background shots", order.white)
    + grp("Group shots", order.group)
    + grp("Videos", order.video)
    + grp("Mix and match", order.mix)
    + grp("Bonus, only if there's time", order.bonus)
    + white + props;
}

/* ---------------- getting ready: hair and makeup timers ---------------- */
// Ticks live in the team-only "blocks" list under keys starting "g|", so models can see them but only the team can change them.
const GK = (id, what) => "g|" + id + "|" + what;
function clockToMins(t, fallbackPm){
  const m = String(t).match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i); if (!m) return null;
  let h = +m[1] % 12; const ap = (m[3] || fallbackPm || "").toUpperCase(); if (ap === "PM") h += 12;
  return h * 60 + +m[2];
}
function parseRange(txt){
  const clean = String(txt).replace(/\(.*?\)/g, "").trim(), parts = clean.split(/[\u2013\u2014-]/);
  if (parts.length < 2) return null;
  const endAp = (parts[1].match(/AM|PM/i) || [""])[0];
  let s = clockToMins(parts[0], (parts[0].match(/AM|PM/i) || [endAp])[0]), e = clockToMins(parts[1], endAp);
  if (s == null || e == null) return null;
  if (s > e) s -= 12 * 60;
  return {s, e};
}
const fmtClock = m => { m = Math.round(m); const h = Math.floor(m / 60) % 24, mm = String(((m % 60) + 60) % 60).padStart(2, "0"); return ((h + 11) % 12 + 1) + ":" + mm + (h < 12 ? " AM" : " PM"); };
const minsOfDay = iso => { const d = new Date(iso); return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60; };
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-");
function shiftMins(id){ return Object.keys((ticks.blocks) || {}).filter(k => k.startsWith(GK(id, "sh|"))).reduce((t, k) => t + (+k.split("|").pop() || 0), 0); }
function glamAppts(){
  if (!HM) return [];
  const out = [];
  HM.rows.forEach(r => {
    [["hair", r.hair, HM.hairArtist], ["makeup", r.makeup, HM.makeupArtist]].forEach(([kind, txt, artist]) => {
      const rg = parseRange(txt); if (!rg) return;
      const note = (String(txt).match(/\((.*?)\)/) || [])[1] || "";
      const id = slug(r.name) + "-" + kind, sh = shiftMins(id);
      out.push({id, who: r.name, kind, artist, note, ps: rg.s + sh, pe: rg.e + sh, dur: rg.e - rg.s});
    });
  });
  return out.sort((a, b) => a.ps - b.ps);
}
function extMins(id){ return Object.keys((ticks.blocks) || {}).filter(k => k.startsWith(GK(id, "x|"))).reduce((t, k) => t + (+k.split("|").pop() || 0), 0); }
// Works out where everyone actually is: started/finished times, extra minutes, and knock-on delays for whoever is next with the same artist or the same model.
function glamPlan(){
  const now = nowMins(), artistEnd = {}, personEnd = {}, rows = [];
  glamAppts().forEach(a => {
    const st = tickOf("blocks", GK(a.id, "start")), dn = tickOf("blocks", GK(a.id, "done")), ext = extMins(a.id);
    const s = st ? minsOfDay(st.at) : Math.max(a.ps, artistEnd[a.artist] || 0, personEnd[a.who] || 0);
    const due = s + a.dur + ext;
    const status = dn ? "done" : st ? "running" : "waiting";
    const e = dn ? minsOfDay(dn.at) : status === "running" ? Math.max(due, now) : due;
    artistEnd[a.artist] = e; personEnd[a.who] = e;
    rows.push({...a, st, dn, ext, sh: shiftMins(a.id), s, due, e, status, late: Math.round(s - a.ps), over: status === "running" && now >= due, left: Math.ceil(due - now)});
  });
  return rows;
}
const overTxt = r => { const m = Math.floor(nowMins() - r.due); return m < 1 ? "Time's up" : m + " min over"; };
const glamFor = name => glamPlan().filter(r => sameName(r.who, name));
let beeped = {}, audioCtx = null;
document.addEventListener("click", () => { try { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e){} }, {once: true, capture: true});
function beep(){
  try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch(e){}
  try { if (!audioCtx) return; const o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.frequency.value = 880; g.gain.value = 0.15; o.connect(g); g.connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + 0.35); } catch(e){}
}
function glamAlerts(){
  if (isModel() || !HM) return "";
  return glamPlan().filter(r => r.over).map(r => {
    if (!beeped[r.id + r.ext]){ beeped[r.id + r.ext] = true; beep(); }
    return `<div class="alert bad" style="margin-bottom:10px"><div><b>${esc(r.who)}'s ${esc(r.kind)} should be done</b> (due ${esc(fmtClock(r.due))}). Is she done?</div>
      <div class="row" style="margin-top:8px"><button class="btn" data-act="gdone" data-g="${r.id}">Yes, done</button><button class="btn ghost" data-act="gext" data-g="${r.id}" data-m="5">+5 min</button><button class="btn ghost" data-act="gext" data-g="${r.id}" data-m="10">+10 min</button></div></div>`;
  }).join("");
}
function glamCard(r){
  const shifted = r.status === "waiting" && r.late > 0;
  const time = `<span class="tnum">${esc(fmtClock(r.ps))}–${esc(fmtClock(r.pe))}</span>`;
  let body = "";
  if (r.status === "waiting") body = `${shifted ? `<p class="tbc" style="margin:6px 0 0">Running ${r.late} min late: now about ${esc(fmtClock(r.s))}–${esc(fmtClock(r.e))}</p><button class="linkbtn" data-act="gplan" data-g="${r.id}" data-m="${r.late}" style="margin-top:6px">She started late: plan from her real start</button>` : ""}
      <button class="btn" data-act="gstart" data-g="${r.id}" style="margin-top:10px">She's sat down: start</button>${r.sh ? `<button class="linkbtn quiet" data-act="gshiftundo" data-g="${r.id}" style="margin-top:10px;margin-left:8px">Undo re-time</button>` : ""}`;
  else if (r.status === "running") body = `<div class="big tnum" style="margin-top:6px;${r.over ? "color:var(--warn)" : ""}"><input type="number" inputmode="numeric" data-act="gleft" data-g="${r.id}" data-was="${r.left}" value="${r.left}" aria-label="Minutes left" style="width:96px;font:inherit;font-size:28px;font-weight:700;background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:10px;padding:4px 8px"> min left${r.over ? ` <span style="color:var(--warn);font-size:15px">· ${overTxt(r)}</span>` : ""}</div>
      <p class="muted" style="margin:4px 0 0">Started ${esc(fmtClock(minsOfDay(r.st.at)))} by ${esc(r.st.by)} · due ${esc(fmtClock(r.due))}${r.ext ? ` (+${r.ext} min)` : ""}</p>
      <div class="row" style="margin-top:10px"><button class="btn" data-act="gdone" data-g="${r.id}">Done</button><button class="btn ghost" data-act="gext" data-g="${r.id}" data-m="-5">−5</button><button class="btn ghost" data-act="gext" data-g="${r.id}" data-m="5">+5</button><button class="btn ghost" data-act="gext" data-g="${r.id}" data-m="10">+10</button>${r.ext ? `<button class="linkbtn quiet" data-act="gextundo" data-g="${r.id}">Undo extra time</button>` : ""}<button class="linkbtn quiet" data-act="gundo" data-g="${r.id}" data-w="start">Undo start</button></div>`;
  else { const d = Math.round(minsOfDay(r.dn.at) - r.pe); body = `<p style="margin:6px 0 0"><b>✓ Done ${esc(fmtClock(minsOfDay(r.dn.at)))}</b> <span class="muted">${d > 0 ? d + " min after plan" : d < 0 ? -d + " min early" : "right on time"}</span> <button class="linkbtn quiet" data-act="gundo" data-g="${r.id}" data-w="done">Undo</button></p>`; }
  return `<section class="pbox" style="${r.status === "running" ? "border:2px solid " + (r.over ? "var(--warn)" : "var(--accent)") : r.status === "done" ? "opacity:.7" : ""}">
    <h3 style="font-size:18px">${esc(r.who)}${r.note ? ` <span class="muted" style="font-family:var(--body);font-size:13px">${esc(r.note)}</span>` : ""}</h3>
    <div class="muted">${time}</div>${body}</section>`;
}
function viewGlam(){
  if (!HM) return `<p class="muted">The hair and makeup schedule hasn't been loaded yet.</p>`;
  const plan = glamPlan(), lastEnd = Math.max(...plan.map(r => r.e)), deadline = clockToMins(HM.prep), worst = Math.max(0, ...plan.filter(r => r.status === "waiting").map(r => r.late));
  const col = kind => plan.filter(r => r.kind === kind).map(glamCard).join("");
  const arrivals = HM.rows.map((r, i) => { const t = tickOf("blocks", GK("arr", slug(r.name))); return `<label class="check"><input type="checkbox" id="arr-${i}" data-act="garrive" data-g="${slug(r.name)}" ${t ? "checked" : ""}><span><b>${esc(r.name)}</b> <span class="muted tnum">arrive by ${esc(r.arrive)}</span>${t ? ` <span class="src">✓ ${esc(hhmm(t.at))}</span>` : ""}</span></label>`; }).join("");
  return `<div class="section-h"><div><h2>Getting ready</h2><p class="lede">${esc(HM.title)} · ${esc(HM.location)}. Tap start when she sits down and Done when she's finished. If anything runs over, everyone after her who's waiting for the same artist (or the same model) moves automatically.</p></div></div>
    <section class="panel hero" style="margin-bottom:16px">
      <div class="eyebrow">Everyone ready by ${esc(HM.prep)}</div>
      <div class="big tnum" style="margin-top:6px">${worst ? "Running " + worst + " min late" : "On time"}</div>
      <p style="margin:6px 0 0">Last appointment now finishes about <b>${esc(fmtClock(lastEnd))}</b>${deadline != null && lastEnd > deadline ? `, which is ${Math.round(lastEnd - deadline)} min past the deadline` : ""}.</p>
    </section>
    <div class="section-h"><div><h2>Arrivals</h2></div></div><div class="box" style="margin-bottom:16px">${arrivals}</div>
    <div class="cols" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr))">
      <div style="display:grid;gap:12px;align-content:start;min-width:0"><h2 style="font-size:22px;margin:0">${esc(HM.makeupArtist)} · makeup</h2>${col("makeup")}</div>
      <div style="display:grid;gap:12px;align-content:start;min-width:0"><h2 style="font-size:22px;margin:0">${esc(HM.hairArtist)} · hair</h2>${col("hair")}</div>
    </div>`;
}
document.addEventListener("click", e => {
  const b = e.target.closest("[data-act^=g]"); if (!b || !me || isModel()) return;
  const id = b.dataset.g, a = b.dataset.act;
  if (a === "gstart") setTick("blocks", GK(id, "start"), true);
  else if (a === "gdone"){ if (!isTicked("blocks", GK(id, "start"))) setTick("blocks", GK(id, "start"), true); setTick("blocks", GK(id, "done"), true); }
  else if (a === "gext") setTick("blocks", GK(id, "x|" + Date.now() + "|" + b.dataset.m), true);
  else if (a === "gplan") setTick("blocks", GK(id, "sh|" + Date.now() + "|" + b.dataset.m), true);
  else if (a === "gshiftundo"){ const ks = Object.keys(ticks.blocks || {}).filter(k => k.startsWith(GK(id, "sh|"))).sort(); if (ks.length) setTick("blocks", ks[ks.length - 1], false); }
  else if (a === "gextundo"){ const ks = Object.keys(ticks.blocks || {}).filter(k => k.startsWith(GK(id, "x|"))).sort(); if (ks.length) setTick("blocks", ks[ks.length - 1], false); }
  else if (a === "gundo") setTick("blocks", GK(id, b.dataset.w), false);
});
document.addEventListener("change", e => { const el = e.target; if (el.dataset && el.dataset.act === "garrive") setTick("blocks", GK("arr", el.dataset.g), el.checked);
  // Typing a new "min left" moves the due time by the difference, so the running clock matches what you typed.
  if (el.dataset && el.dataset.act === "gleft"){ const want = Math.round(+el.value); const was = +el.dataset.was; if (!isNaN(want) && want !== was) setTick("blocks", GK(el.dataset.g, "x|" + Date.now() + "|" + (want - was)), true); } });
setInterval(() => { if (!me) return; if (isModel() ? glamFor(me.name).some(r => r.status === "running") : (tab === "glam" || glamPlan().some(r => r.status === "running"))) render(true); }, 15000);

/* ---------------- the running order, built automatically from the picked shots ---------------- */
// Every location shot = dress the set (props) + shoot it. White background and videos fit around each girl's free time.
// Bookworm 1 and Bookworm 2 share one outfit: Bookworm 1 works before the swap, Bookworm 2 after it.
let LOC_OVERRIDE = null;
const timing = () => { const o = Object.assign({start:"13:00", end:"16:00", brief:5, group:7, white:12, loc:5, videos:20, swap:10, swapAt:"14:20"}, TIMING0 || {}, Object.fromEntries(Object.entries(plan.timing || {}).filter(([, v]) => v !== "" && v != null))); Object.keys(o).forEach(k => { if (k !== "start" && k !== "end" && k !== "swapAt") o[k] = Math.max(1, +o[k] || 1); }); if (LOC_OVERRIDE) o.loc = LOC_OVERRIDE; return o; };
const ROOMS_ORDER = [["Bed", ["bed", "mirror"]], ["Couch", ["couch"]], ["Kitchen", ["kitchen"]]];
const BW1 = "bookworm", BW2 = "bookworm2";
const isBig = w => w.length >= 5;
function dayKey(){ return JSON.stringify([activeShots().map(s => [s.id, whoOf(s.id), prioOf(s.id)]), plan.cast || {}, plan.timing || {}]); }
let dayCache = {key: "", day: null};
// The Bookworm swap time is worked out automatically: the app tries every time and keeps the one with no clashes.
function buildDayAt(){
  const T = timing(), t0 = mins(T.start), tEnd = mins(T.end);
  let best = null;
  const both = !!castOf(BW1) && !!castOf(BW2);
  const cands = both ? Array.from({length: Math.floor((tEnd - t0) / 5) + 1}, (_, i) => t0 + i * 5) : [tEnd + 600];
  cands.forEach(c => { const d = coreDay(c); const score = d.clash * 10000 + d.lastEnd; if (!best || score < best.score) best = {d, score}; });
  return best.d;
}
function buildDay(){
  const key = dayKey(); if (dayCache.key === key) return dayCache.day;
  const at = m => { LOC_OVERRIDE = m; try { return buildDayAt(); } finally { LOC_OVERRIDE = null; } };
  const base = at(5), warn0 = base.warn.length; let best = base, bestLoc = 5, lo = 6, hi = 60;
  while (lo <= hi){ const mid = (lo + hi) >> 1, d = at(mid); if (d.warn.length <= warn0){ best = d; bestLoc = mid; lo = mid + 1; } else hi = mid - 1; }
  best.locMin = bestLoc; dayCache = {key, day: best}; return best;
}
function coreDay(swapAt){
  const T = timing(), t0 = mins(T.start), tEnd = mins(T.end);
  const cast = pid => !!castOf(pid);
  const picked = activeShots().filter(s => prioOf(s.id) !== "bonus");
  const bonus = activeShots().filter(s => prioOf(s.id) === "bonus" && whoOf(s.id).length);
  const hasVideo = picked.some(s => s.loc === "video" && whoOf(s.id).length);
  const vd = hasVideo ? T.videos : 0, limit = tEnd - vd; // everything else finishes by limit; videos are the last block
  const steps = [], warn = [], busy = {};
  let clash = 0;
  const addBusy = (pids, s, e) => pids.forEach(p => (busy[p] = busy[p] || []).push([s, e]));
  const freeOver = (pids, s, e) => pids.every(p => (busy[p] || []).every(([a, b]) => e <= a || s >= b));
  // Bookworm rules: who can wear the shared outfit when
  const outfitOk = (pids, s, e) => (!pids.includes(BW1) || e <= swapAt) && (!pids.includes(BW2) || s >= swapAt + T.swap);
  const holderAt = s => s >= swapAt + T.swap ? BW2 : BW1;
  const fixGroupWho = (w, s) => w.map(p => (p === BW1 || p === BW2) ? holderAt(s) : p).filter((p, i, a) => a.indexOf(p) === i);
  const camBusy = (cam, a, b) => steps.some(x => x.cam === cam && !(b <= x.s || a >= x.e));
  const endOf = cams => Math.max(t0 + T.brief, ...steps.filter(x => cams.includes(x.cam)).map(x => x.e));
  const roomOfShot = s => (ROOMS_ORDER.find(([, l]) => l.includes(s.loc)) || [""])[0];
  const start = t0 + T.brief;
  steps.push({cam: "all", s: t0, e: start, kind: "brief", label: "Everyone on set: quick briefing, props out", who: []});
  // One camera per place: white background and the location camera each take one girl at a time.
  // A girl is never in two places at once; each place runs for her allotted time.
  const place = (task, from) => {
    for (let a = from; a + task.dur <= limit; a += 5){
      const b = a + task.dur;
      if (camBusy(task.cam, a, b) || !freeOver(task.who, a, b) || !outfitOk(task.who, a, b)) continue;
      steps.push({cam: task.cam, s: a, e: b, kind: task.kind, room: task.room || (task.cam === "white" ? "White background" : ""), shotId: task.shotId, shots: task.shots, who: task.who, label: task.label});
      addBusy(task.who, a, b); return true;
    }
    return false;
  };
  // 1) White background: each girl gets her time, one after another
  // Shared-outfit girls go first (BW1), then everyone else, then the one who takes the outfit over (BW2)
  const rank = pid => pid === BW1 ? 0 : pid === BW2 ? 2 : 1;
  [...PERSONAS].sort((a, b) => rank(a.id) - rank(b.id)).forEach(p => {
    const wsh = picked.filter(s => s.loc === "white" && whoOf(s.id).includes(p.id)).map(s => s.id);
    if (!place({cam: "white", kind: "white", who: [p.id], dur: T.white, shots: wsh, label: "White background, your time"}, start)){ warn.push(`${p.name}'s white background time doesn't fit before ${clock24(limit)}.`); clash++; }
  });
  // 2) Location time: each girl gets one block per room she has shots in, room by room
  ROOMS_ORDER.forEach(([room, locs]) => [...PERSONAS].sort((a, b) => rank(a.id) - rank(b.id)).forEach(p => {
    const solo = picked.filter(s => locs.includes(s.loc) && whoOf(s.id).length === 1 && whoOf(s.id)[0] === p.id);
    if (!solo.length) return;
    if (!place({cam: "loc", kind: "loctime", room, who: [p.id], dur: T.loc, shots: solo.map(s => s.id), label: "Location time"}, start)){ warn.push(`${p.name}'s ${room} time doesn't fit before ${clock24(limit)}. Take a shot out or change who's in it.`); clash++; }
  }));
  // 3) Double shots: taken in a free window when everyone in them is free, otherwise in the group section
  const fallback = [];
  picked.filter(s => ROOMS_ORDER.some(([, l]) => l.includes(s.loc)) && whoOf(s.id).length >= 2).forEach(s => {
    const task = {cam: "loc", kind: "pair", room: roomOfShot(s), who: whoOf(s.id), dur: T.group, shotId: s.id, label: "Double shot"};
    if (!place(task, start)) fallback.push(s);
  });
  // 4) Mix and match: the last piece of white background shooting
  const mix = picked.filter(s => s.loc === "mix" && whoOf(s.id).length);
  if (mix.length){
    const mw = [...new Set(mix.flatMap(s => whoOf(s.id)))];
    if (!place({cam: "white", kind: "mix", who: mw, dur: T.white, shots: mix.map(s => s.id), label: "Mix and match"}, endOf(["white"]))){ warn.push("Mix and match doesn't fit before " + clock24(limit) + "."); clash++; }
  }
  // 5) Group shots, room by room, once everyone is done at white background and the locations
  let gt = Math.max(endOf(["white", "loc"]), start);
  ROOMS_ORDER.forEach(([room, locs]) => {
    const everyone = picked.filter(s => s.loc === "group" && locs.includes(s.gl) && whoOf(s.id).length);
    const shots = [...everyone, ...fallback.filter(s => roomOfShot(s) === room)];
    if (!shots.length) return;
    const dur = shots.length * T.group, w = fixGroupWho([...new Set(shots.flatMap(s => whoOf(s.id)))], gt);
    if (gt + dur > limit){ shots.forEach(s => warn.push(`${code(s)} doesn't fit before ${clock24(limit)}. Take a shot out or change who's in it.`)); clash += shots.length; return; }
    steps.push({cam: "loc", s: gt, e: gt + dur, kind: "groupblock", room, shots: shots.map(s => s.id), who: w, label: "Group shots"});
    addBusy(w, gt, gt + dur); gt += dur;
  });
  // 6) Videos: one block as the last thing of the day, everyone who is in a video
  const videoIds = picked.filter(s => s.loc === "video" && whoOf(s.id).length).map(s => s.id);
  if (videoIds.length){
    const vw = [...new Set(videoIds.flatMap(id => whoOf(id)))];
    steps.push({cam: "video", s: limit, e: limit + vd, kind: "videoblock", room: "Video", who: vw, shots: videoIds, label: "Videos: last block of the day, everyone in a video"});
    addBusy(vw, limit, limit + vd);
  }
  // Bookworm outfit swap marker
  if (cast(BW1) && cast(BW2)) steps.push({cam: "all", s: swapAt, e: swapAt + T.swap, kind: "swap", label: `Outfit swap: ${P[BW1].name} hands the shared set to ${P[BW2].name}`, who: [BW1, BW2]});
  steps.sort((a, b) => a.s - b.s || (a.cam < b.cam ? -1 : 1));
  const lastEnd = Math.max(...steps.map(x => x.e));
  const day = {rows: [], groupCount: 0, steps, warn, lastEnd, locEnd: endOf(["loc"]), groupsEnd: gt, rooms: {}, locShots: 0, fits: 0, over: 0, bonus, T};
  day.clash = clash; day.swapAt = swapAt; return day;
}
const CONTENT_VIDEO_ROOM = () => VIDEO_ROOM || {};
const clock24 = m => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(Math.round(m % 60)).padStart(2, "0");
const camName = c => ({loc: "Location camera", white: "White background camera", video: "Video camera", all: "Everyone"})[c] || c;
function moodBtn(pid){ return `<button class="codelink" data-act="gomood" data-p="${pid}">mood board</button>`; }
function showMood(pid){
  const src = IMAGES["mood-" + pid]; if (!src) return;
  const o = document.createElement("div");
  o.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:999;display:flex;align-items:center;justify-content:center;padding:16px;overflow:auto";
  o.innerHTML = `<img src="${src}" alt="Mood board" style="max-width:100%;max-height:92vh;border-radius:12px;background:#fff">`;
  o.onclick = () => o.remove(); document.body.appendChild(o);
}
function stepTitle(x, pid){
  const s = x.shotId && shotById(x.shotId), you = !!pid;
  if (x.kind === "shot") return `${esc(x.room)} · ${codeLinks([s])} ${esc(s.title)}`;
  if (x.kind === "group") return `${esc(x.room)} group shot · ${codeLinks([s])} ${esc(s.title)}`;
  if (x.kind === "groupvideo") return `${esc(x.room)} · everyone's video ${codeLinks([s])} ${esc(s.title)}`;
  if (x.kind === "video") return `${esc(x.room)} · video ${codeLinks([s])} ${esc(s.title)}`;
  if (x.kind === "videoturn") return `${esc(x.room)} · ${you ? "your turn in" : "a turn in"} video ${codeLinks([s])} ${esc(s.title)}`;
  if (x.kind === "white") return `White background · ${moodBtn(pid || (x.who || [])[0])}`;
  if (x.kind === "mix") return `White background · mix and match ${codeLinks((x.shots || []).map(shotById).filter(Boolean))}`;
  if (x.kind === "videoblock") return `Videos · ${codeLinks((x.shots || []).map(shotById).filter(Boolean))}`;
  if (x.kind === "loctime") return `${esc(x.room)} · ${you ? "your time" : "time"} · ${codeLinks((x.shots || []).map(shotById).filter(Boolean))}`;
  if (x.kind === "pair") return `${esc(x.room)} · double shot ${codeLinks([s])} ${esc(s.title)}`;
  if (x.kind === "groupblock") return `${esc(x.room)} group shots · ${codeLinks((x.shots || []).map(shotById).filter(Boolean))}`;
  return esc(x.label);
}
function stepDetail(x, pid){
  if (x.kind === "shot") return `Dress the set ${clock24(x.dress[0])}–${clock24(x.dress[1])}, then ${pid ? "you pose" : "shoot"} ${clock24(x.shoot[0])}–${clock24(x.shoot[1])}`;
  if (x.kind === "group") return `Dress and shoot together`;
  return "";
}
const whoChips = w => w.length ? w.map(ptag).join(" ") : "";
// A step counts as done once its shot is marked (or, for white background, all its boxes are ticked).
function stepDone(x, pid){
  if (x.kind === "white" && (x.shots || []).length) return x.shots.every(id => isTicked("shots", id));
  if (x.kind === "white") return (pid ? [pid] : x.who).every(w => WHITE.every((_, i) => isTicked("white", w + "-" + i)));
  if (x.kind === "mix" || x.kind === "loctime") return (x.shots || []).length > 0 && x.shots.every(id => isTicked("shots", id));
  return !!x.shotId && isTicked("shots", x.shotId);
}
const doable = x => !!x.shotId || x.kind === "white" || x.kind === "mix" || x.kind === "loctime";
const stepRow = (x, pid, day) => {
  const now = nowMins(), done = doable(x) && stepDone(x, pid), live = !done && day && now >= x.s && now < x.e, past = done || (day && now >= x.e);
  return `<li class="step k-${x.kind}${live ? " now" : ""}" style="${past ? "opacity:.5" : ""}">
    <div class="st-time tnum">${clock24(x.s)}${x.e > x.s ? "–" + clock24(x.e) : ""}</div>
    <div style="min-width:0"><div class="st-cam">${esc(camName(x.cam))}${done ? ` <b style="color:var(--good)">✓ Done</b>` : ""}</div><div class="st-title">${stepTitle(x, pid)}</div>
    ${stepDetail(x, pid) ? `<div class="muted" style="font-size:13px">${stepDetail(x, pid)}</div>` : ""}
    ${!pid && x.who.length ? `<div class="who" style="margin-top:4px">${whoChips(x.who)}</div>` : ""}</div></li>`;
};
let schedCam = "all";
function runningOrderHTML(){
  const d = buildDay(), day = isShootDay();
  const list = d.steps.filter(x => x.kind !== "wait" && (schedCam === "all" || x.cam === schedCam || x.cam === "all"));
  return `<div class="section-h"><div><h2>Running order</h2><p class="lede">Each girl gets her time at each stop. Shots are not timed one by one: the brand owner decides which shots to take on the day.</p></div></div>
    ${false ? `<div class="box" style="margin-bottom:14px;border:1px solid var(--warn)"><div class="eyebrow" style="margin-bottom:6px;color:var(--warn)">To sort out</div><ul class="list">${d.warn.map(w => `<li>• ${w}</li>`).join("")}</ul></div>` : ""}
    <div class="chips" role="group" aria-label="Filter by camera" style="margin-bottom:12px">
      ${[["all","Everything"],["loc","Location camera"],["white","White background"],["video","Video camera"]].map(([v,l]) => `<button class="chip" data-act="schedcam" data-v="${v}" aria-pressed="${schedCam===v}">${l}</button>`).join("")}
    </div>
    <ul class="steps">${list.map(x => stepRow(x, null, day)).join("")}</ul>
    ${d.bonus.length ? `<div class="box" style="margin-top:14px"><div class="eyebrow" style="margin-bottom:6px">Bonus shots, if there's spare time</div>${codeLinks(d.bonus)}</div>` : ""}`;
}
function timingHTML(){
  const T = timing(), ed = editable();
  const f = [["white","White background, per girl (min)"],["group","Each group shot (min)"],["videos","Videos block at the end (min)"],["swap","Shared outfit swap (min)"]];
  return `<details class="box" style="margin-bottom:14px" ${ed ? "open" : ""}><summary style="cursor:pointer;font-weight:700">Timings the running order uses (tap to ${ed ? "close" : "open"})</summary>
    <p class="muted" style="margin:8px 0 0">${ed ? "Change any number and the running order below recalculates straight away." : mode === "day" && isOwner() ? "Switch to Planning at the top to change these." : "Only the brand owner can change these."}</p>
    <p class="muted" style="margin:8px 0 0">Location time is worked out for you: each girl gets the most she can in each room. Right now that is <b>${buildDay().locMin} min</b>.</p><div class="callsheet" style="margin-top:10px">${f.map(([k,l]) => `<label>${l}${ed ? `<input id="tm-${k}" data-act="timing" data-k="${k}" value="${esc(T[k])}" ${k === "swapAt" ? 'type="time"' : 'type="number" min="1" max="60"'}>` : `<span style="font-size:15px;color:var(--ink)">${esc(T[k])}</span>`}</label>`).join("")}</div></details>`;
}
function myStepsHTML(pid){
  const d = buildDay(), day = isShootDay();
  const mine = d.steps.filter(x => x.who.includes(pid) || x.kind === "brief" || x.kind === "wrap");
  return `<ul class="steps">${mine.map(x => stepRow(x, pid, day)).join("")}</ul>`;
}
function myNowNext(pid){
  const d = buildDay(), t = nowMins(), day = isShootDay();
  const mine = d.steps.filter(x => x.who.includes(pid) && doable(x));
  const left = mine.filter(x => !stepDone(x, pid)), nxt = left[0], doneN = mine.length - left.length;
  const body = x => `<p style="margin:8px 0 0"><b>${stepTitle(x, pid)}</b></p>${stepDetail(x, pid) ? `<p class="muted" style="margin:4px 0 0">${stepDetail(x, pid)}</p>` : ""}`;
  const count = mine.length ? `<p class="muted" style="margin:8px 0 0">${doneN} of ${mine.length} done</p>` : "";
  if (!nxt) return `<section class="panel" style="margin-top:12px"><div class="eyebrow">All done</div><p style="margin:8px 0 0">That's a wrap. Thank you! 💕</p></section>`;
  const eb = !doneN && !day ? "Your first slot · " + clock24(nxt.s) : "Up next · " + clock24(nxt.s);
  const big = !day ? "" : t < nxt.s ? `in ${esc(fmtDur(nxt.s - t))}` : t < nxt.e ? `Now · ${Math.max(0, Math.ceil(nxt.e - t))} min left` : "Now (running a little behind)";
  return `<section class="panel" style="margin-top:12px">
    <div class="eyebrow">${eb}</div>
    ${big ? `<div class="big tnum" style="margin-top:6px">${big}</div>` : ""}${body(nxt)}${count}
  </section>`;
}
function liveNowHTML(){
  const d = buildDay(), t = nowMins(), day = isShootDay();
  const at = day ? t : mins(timing().start) + timing().brief;
  const cams = ["loc", "white", "video"].map(c => {
    const cur = d.steps.find(x => x.cam === c && at >= x.s && at < x.e && x.kind !== "wait"), nxt = d.steps.find(x => x.cam === c && x.s >= at && x.kind !== "wait");
    const x = cur || nxt;
    return `<div class="st"><span>${esc(camName(c))}${x ? " · " + (cur ? "now" : "next " + clock24(x.s)) : ""}</span><b>${x ? (x.who.length ? x.who.map(p => esc(pname(p)) + (castOf(p) ? " · " + esc(castOf(p)) : "")).join(", ") : "") : "Done"}</b></div>${x ? `<div style="font-size:13px;opacity:.8;margin-top:2px">${stepTitle(x)}${x.kind === "shot" ? " · " + (at < x.dress[1] ? "dressing the set" : "shooting") : ""}</div>` : ""}`;
  }).join("");
  return `<section class="panel hero"><div class="eyebrow">${day ? "Right now · " + clock24(t) : "First up · " + clock24(at)}</div><div class="stations">${cams}</div></section>`;
}
/* ---------------- helpers ---------------- */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const pname = id => P[id] ? P[id].name : "—";
const ptag = id => P[id] ? `<span class="p-tag pc-${id}">${esc(P[id].name)}</span>` : `<span class="p-tag off">—</span>`;
function code(s){
  const n = shotNums()[s.id];
  if (n) return n;
  const l = LOC[s.loc] || {code:"SHOT"};
  return l.code + (s.gl ? " · " + s.gl.toUpperCase() : "") + " · removed";
}
// Shot numbers: B (bed and mirror), C (couch), K (kitchen), G (group, in shooting order), V (videos, in filming order), M (mix and match).
// They're worked out from the shots still in the plan, so they settle once the brand owner has picked.
let numCache = {key:"", nums:{}};
function shotNums(){
  const act = activeShots(), key = JSON.stringify(act.map(s => s.id));
  if (numCache.key === key) return numCache.nums;
  const nums = {}, gOrder = ["kitchen","couch","bed"];
  const put = (letter, list) => list.forEach((s, i) => nums[s.id] = letter + (i + 1));
  put("B", act.filter(s => s.loc === "bed").concat(act.filter(s => s.loc === "mirror")));
  put("C", act.filter(s => s.loc === "couch"));
  put("K", act.filter(s => s.loc === "kitchen"));
  put("G", act.filter(s => s.loc === "group").sort((a, b) => gOrder.indexOf(a.gl) - gOrder.indexOf(b.gl)));
  const vn = id => +(String(id).match(/\d+/) || [999])[0];
  put("V", act.filter(s => s.loc === "video").sort((a, b) => vn(a.id) - vn(b.id)));
  put("W", act.filter(s => s.loc === "white"));
  put("M", act.filter(s => s.loc === "mix"));
  numCache = {key, nums}; return nums;
}
const codesOf = list => list.map(s => code(s)).join(", ");
// Tappable shot numbers: each one opens that shot's inspo photo.
const codeLinks = list => list.map(s => `<button class="codelink" data-act="peek" data-shot="${esc(s.id)}">${esc(code(s))}</button>`).join(", ");
let peekId = null;
function peekHTML(){
  const s = peekId && shotById(peekId); if (!s) return "";
  const src = imgSrc(s), who = whoOf(s.id), done = isTicked("shots", s.id);
  return `<div class="peek" data-act="peekclose" role="dialog" aria-modal="true" aria-label="${esc(code(s))} ${esc(s.title)}">
    <div class="peekcard" data-act="peekstay">
      <button class="peekx" data-act="peekclose" aria-label="Close">✕</button>
      ${src ? `<img src="${esc(src)}" alt="${esc(s.title)} inspiration">` : ""}
      <div class="peekbody">
        <div class="eyebrow">${esc(code(s))} · ${esc(whereLabel(s))}</div>
        <h3>${esc(s.title)}</h3>
        ${s.note ? `<p>${esc(s.note)}</p>` : ""}
        <p class="muted" style="font-size:14px"><b>Props:</b> ${s.props.length ? esc(s.props.join(", ")) : "None"}</p>
        ${who.length ? `<div class="who">${who.map(ptag).join("")}</div>` : ""}
        ${!isModel() ? `<div class="box" style="margin-top:12px"><div class="eyebrow" style="margin-bottom:6px">Where they need to be</div>${whereNowHTML(s.id)}</div>` : ""}
        ${VIDEO_SHOTS[s.id] ? `<div class="box" style="margin-top:12px"><div class="eyebrow" style="margin-bottom:6px">Shot list</div>${VIDEO_SHOTS[s.id].map((t, i) => `<label class="check"><input type="checkbox" id="vs-${s.id}-${i}" data-act="vshot" data-k="vs|${s.id}|${i}" ${isTicked("shots", "vs|" + s.id + "|" + i) ? "checked" : ""}><span>${esc(t)}</span></label>`).join("")}</div>` : ""}
        ${mode === "day" ? `<button class="tick" data-act="tick" data-shot="${esc(s.id)}" aria-pressed="${done}" style="margin-top:12px">${done ? "✓ Shot done (tap to undo)" : "Mark as shot"}</button>` : ""}
      </div></div></div>`;
}
const imgSrc = s => s.custom ? s.imgData : (s.noimg ? "" : (IMAGES[s.id] || ""));
const editable = () => mode === "plan" && isOwner();
let toastT; function toast(m){ const t = document.getElementById("toast"); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3600); }
const mins = t => { const [h,m] = String(t).split(":").map(Number); return h*60+m; };
const nowMins = () => { const d = new Date(); return d.getHours()*60 + d.getMinutes() + d.getSeconds()/60; };
const todayISO = () => { const d = new Date(); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); };
const isShootDay = () => !!meta().date && meta().date === todayISO();
const fmtDate = iso => { if (!iso) return ""; const d = new Date(iso+"T12:00"); return isNaN(d) ? iso : d.toLocaleDateString(undefined,{weekday:"short", day:"numeric", month:"short"}); };
const shotsFor = pid => activeShots().filter(s => whoOf(s.id).includes(pid));
function progress(){
  const items = activeShots().filter(s => whoOf(s.id).length);
  const must = items.filter(s => prioOf(s.id) === "must");
  const whiteShots = activeShots().filter(s => s.loc === "white");
  const whiteTotal = whiteShots.length;
  const whiteDone = whiteShots.filter(s => isTicked("shots", s.id)).length;
  return {done: items.filter(s => isTicked("shots", s.id)).length, total: items.length, mustDone: must.filter(s => isTicked("shots", s.id)).length, mustTotal: must.length, whiteDone, whiteTotal};
}
function compress(file){
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), im = new Image();
    im.onload = () => {
      const tryAt = (max, q) => { const k = Math.min(1, max / Math.max(im.width, im.height)); const c = document.createElement("canvas"); c.width = Math.round(im.width*k); c.height = Math.round(im.height*k); c.getContext("2d").drawImage(im, 0, 0, c.width, c.height); return c.toDataURL("image/jpeg", q); };
      let d = tryAt(900, .75); if (d.length > 200000) d = tryAt(720, .65); if (d.length > 200000) d = tryAt(560, .55);
      URL.revokeObjectURL(url); res(d);
    };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error("bad image")); };
    im.src = url;
  });
}

/* ---------------- views ---------------- */
function whereLabel(s){ return s.loc === "group" ? "Group · " + (GROUP_ROOMS[s.gl] || "") : (LOC[s.loc] || {}).name || ""; }
function shotCard(s){
  const who = whoOf(s.id), pr = prioOf(s.id), done = isTicked("shots", s.id), ed = editable(), rem = isRemoved(s.id);
  if (editing === s.id && ed) return editCard(s);
  const whoHTML = ed && !rem
    ? PERSONAS.map(p => `<button class="p-tag ${who.includes(p.id) ? "pc-"+p.id : "off"}" data-act="who" data-shot="${s.id}" data-p="${p.id}" aria-pressed="${who.includes(p.id)}">${esc(p.name)}</button>`).join("")
    : (who.length ? who.map(ptag).join("") : `<span class="p-tag off">Nobody cast yet</span>`);
  const prBtn = ed && !rem ? `<button class="prio ${pr}" data-act="prio" data-shot="${s.id}" title="Switch between must-have and bonus">${pr === "must" ? "MUST" : "BONUS"}</button>` : `<span class="prio ${pr}">${pr === "must" ? "MUST" : "BONUS"}</span>`;
  return `<article class="shot ${done ? "done" : ""} ${rem ? "removed" : ""}">
    <div class="ph">${imgSrc(s) ? `<img src="${esc(imgSrc(s))}" alt="${esc(s.title)} inspiration" loading="lazy">` : `<div class="noimg">${s.loc==="mix" ? "Mix and match<br>(no inspo photo)" : "No photo"}</div>`}
      <span class="code">${esc(code(s))}</span>${prBtn}${s.custom ? `<span class="addedtag">Added</span>` : ""}${done ? `<span class="donebadge">✓ Got it${byLine("shots", s.id) ? " · " + esc(byLine("shots", s.id)) : ""}</span>` : ""}</div>
    <div class="body">
      <h3>${esc(s.title)}</h3>
      ${s.note ? `<p>${esc(s.note)}</p>` : ""}
      <div class="props"><b>Props:</b> ${s.props.length ? esc(s.props.join(", ")) : "None yet"}</div>
      <div class="cam">${s.loc === "video" || s.video ? "🎥 Video camera" : s.loc === "mix" ? "📷 White background camera" : "📷 Location camera"} · ${esc(whereLabel(s))}</div>
      ${rem ? "" : `<div><div class="eyebrow" style="margin-bottom:6px">${ed ? "Who's in it (tap to change)" : "Who's in it"}</div><div class="who">${whoHTML}</div></div>`}
      ${mode === "day" && !rem ? `<button class="tick" data-act="tick" data-shot="${s.id}" aria-pressed="${done}">${done ? "✓ Shot done (tap to undo)" : "Mark as shot"}</button>` : ""}
      ${ed ? `<div class="cardtools">${rem ? `<button class="linkbtn" data-act="restore" data-shot="${s.id}">Put back in the plan</button>` : `<button class="linkbtn" data-act="edit" data-shot="${s.id}">Edit details</button><button class="linkbtn quiet" data-act="remove" data-shot="${s.id}">Remove</button>`}</div>` : ""}
    </div></article>`;
}
let editDraft = {};
function editCard(s){
  const d = Object.assign({title:s.title, note:s.note, props:s.props.join(", ")}, editDraft);
  return `<article class="shot"><div class="ph">${imgSrc(s) ? `<img src="${esc(imgSrc(s))}" alt="" loading="lazy">` : ""}<span class="code">${esc(code(s))}</span></div>
    <div class="body editf">
      <label>Name<input id="e-title" data-edraft="title" value="${esc(d.title)}"></label>
      <label>What to capture<textarea id="e-note" data-edraft="note" rows="3">${esc(d.note)}</textarea></label>
      <label>Props (separate with commas)<textarea id="e-props" data-edraft="props" rows="3">${esc(d.props)}</textarea></label>
      <div class="row"><button class="btn" data-act="editsave" data-shot="${s.id}">Save</button><button class="btn ghost" data-act="editcancel">Cancel</button></div>
    </div></article>`;
}
function addPanel(){
  return `<section class="addpanel" aria-label="Add a shot">
    <div class="drop">${draft.img ? `<img src="${draft.img}" alt="Chosen photo">` : (draft.busy ? "Preparing photo…" : "Tap to choose an inspo photo")}<input type="file" id="a-file" accept="image/*" data-act="addfile" aria-label="Inspo photo"></div>
    <div class="editf">
      <div class="row" style="justify-content:space-between"><h3 style="font-size:20px">Add a shot</h3><button class="linkbtn quiet" data-act="addcancel">Cancel</button></div>
      <label>Name<input id="a-title" data-draft="title" value="${esc(draft.title)}" placeholder="e.g. Ironing in the set"></label>
      <label>Where<select id="a-loc" data-draft="loc">${ADD_LOCS.map(([v,l]) => `<option value="${v}" ${draft.loc===v?"selected":""}>${l}</option>`).join("")}</select></label>
      <label>What to capture<textarea id="a-note" data-draft="note" rows="2" placeholder="e.g. Homebody ironing a set on the board, laundry basket at her feet">${esc(draft.note)}</textarea></label>
      <label>Props (separate with commas)<input id="a-props" data-draft="props" value="${esc(draft.props)}" placeholder="e.g. Ironing board, laundry basket"></label>
      <div class="row"><button class="btn" data-act="addsave" ${draft.busy ? "disabled" : ""}>Add to the plan</button><span class="muted" style="font-size:13px">Then tap who's in it on the new card.</span></div>
    </div></section>`;
}
function viewShots(){
  const all = allShots(), removedN = all.filter(s => isRemoved(s.id)).length;
  const list = all.filter(s => (showRemoved ? isRemoved(s.id) : !isRemoved(s.id)) && (locFilter === "all" || s.loc === locFilter) && (personaFilter === "all" || whoOf(s.id).includes(personaFilter)));
  const pr = progress(), act = activeShots();
  const groupSections = locFilter === "group" && !showRemoved;
  const grid0 = arr => `<div class="grid">${arr.map(shotCard).join("")}</div>`;
  const grid = arr => { if (!arr.length) return `<p class="muted">No shots here.</p>`; if (showRemoved) return grid0(arr);
    const must = arr.filter(s => prioOf(s.id) !== "bonus"), bon = arr.filter(s => prioOf(s.id) === "bonus");
    return (must.length ? `<h3 class="prio-h">Must-haves <span class="muted">(${must.length})</span></h3>${grid0(must)}` : "") + (bon.length ? `<h3 class="prio-h">Bonus, if there's time <span class="muted">(${bon.length})</span></h3>${grid0(bon)}` : ""); };
  return `<div class="section-h"><div><h2>${showRemoved ? "Removed shots" : "Shot list"}</h2><p class="lede">${showRemoved ? "Shots taken out of the plan. Put any of them back." : mode === "plan" ? "Tap the personalities to choose who's in each shot and tap MUST or BONUS to set its priority. Remove inspo you don't like, edit the details, or add your own. Changes save for everyone." : "Tap “Mark as shot” as each one is captured. Must-haves first."}</p></div>
    <div class="row">${!showRemoved ? `<span class="muted tnum">${pr.done}/${pr.total} shots · ${pr.mustDone}/${pr.mustTotal} must-haves</span>` : ""}${editable() && !showRemoved && !adding ? `<button class="btn" data-act="addopen">+ Add a shot</button><button class="btn ghost" data-act="allprio" data-v="bonus">Make all bonus</button><button class="btn ghost" data-act="allprio" data-v="must">Make all must-have</button>` : ""}</div></div>
    ${!editable() && !showRemoved ? `<div class="box" style="margin-bottom:14px">${mode === "day" ? "You're in Shoot day mode. Switch to <b>Planning</b> at the top to see the editing tools." : isOwner() ? "" : "Only the brand owner can add, remove or edit shots and change who's in them. You can see everything here."}</div>` : ""}
    ${adding && editable() ? addPanel() : ""}
    <div class="chips" role="group" aria-label="Filter by location" style="margin-bottom:8px">
      <button class="chip" data-act="loc" data-v="all" aria-pressed="${locFilter==="all"}">All (${act.length})</button>
      ${LOCS.map(l => `<button class="chip" data-act="loc" data-v="${l.id}" aria-pressed="${locFilter===l.id}">${esc(l.name)} (${act.filter(s => s.loc===l.id).length})</button>`).join("")}
      ${removedN ? `<button class="chip" data-act="showrem" aria-pressed="${showRemoved}">Removed (${removedN})</button>` : ""}
    </div>
    <div class="chips" role="group" aria-label="Filter by personality" style="margin-bottom:16px">
      <button class="chip" data-act="pf" data-v="all" aria-pressed="${personaFilter==="all"}">Everyone</button>
      ${PERSONAS.map(p => `<button class="chip" data-act="pf" data-v="${p.id}" aria-pressed="${personaFilter===p.id}">${esc(p.name)}</button>`).join("")}
    </div>
    ${locFilter === "mix" && !showRemoved ? `<div class="box" style="margin-bottom:16px"><b>Choose the pair:</b> two models of the same or similar size, so they can swap pieces. Pick two models whose sizes match. Tap the personalities on each card to set it.</div>` : ""}${groupSections ? Object.entries(GROUP_ROOMS).map(([k,n]) => `<h3 style="font-size:20px;margin:18px 0 10px">${n}</h3>${grid(list.filter(s => s.gl===k))}`).join("") + (list.some(s => !GROUP_ROOMS[s.gl]) ? grid(list.filter(s => !GROUP_ROOMS[s.gl])) : "") : (list.length ? grid(list) : `<p class="muted">No shots match these filters.</p>`)}`;
}
// Studio references: the moodboard studio photos, stored as images "studio-<persona>-NN"
const studioRefs = pid => { const ks = Object.keys(IMAGES).filter(k => k.startsWith("studio-" + pid + "-")).sort(); return ks.length ? `<div class="eyebrow" style="margin:12px 0 6px">Inspo for the white background</div><div class="mini">${ks.map(k => `<figure><img src="${IMAGES[k]}" alt="" loading="lazy"></figure>`).join("")}</div>` : ""; };
function viewMoods(){
  const card = p => { const mood = IMAGES["mood-" + p.id];
    return `<div class="box" style="margin-bottom:18px"><h2 style="margin:0 0 8px">${esc(p.name)}</h2>
      ${mood ? `<img src="${mood}" alt="${esc(p.name)} moodboard" loading="lazy" style="width:100%;max-width:560px;border-radius:12px">` : `<p class="muted">No moodboard yet.</p>`}
      ${studioRefs(p.id)}</div>`; };
  return `<div class="section-h"><div><h2>Moodboards</h2></div></div><p class="muted" style="margin:0 0 16px">Each girl's moodboard, with her studio references.</p>` + PERSONAS.map(card).join("");
}

/* ---------------- rooms: where everyone is, and each girl's room-by-room page ---------------- */
function roomOf(x){
  if (x.cam === "white") return "White background";
  if (x.cam === "video" || x.kind === "groupvideo" || /^video/.test(x.kind)) return "Video";
  if (x.kind === "group" || x.kind === "groupblock") return "Group shots · " + (x.room || "");
  return x.room || "";
}
const ROOM_ORDER = ["Bed", "Couch", "Kitchen", "Group shots · Bed", "Group shots · Couch", "Group shots · Kitchen", "Video", "White background"];
const stepShots = x => (["white", "mix", "videoblock", "groupblock", "loctime"].includes(x.kind)) ? (x.shots || []) : (x.shotId ? [x.shotId] : []);
const clockNow = () => isShootDay() ? nowMins() : mins(timing().start) + timing().brief;
function whoLine(list){ return list.flatMap(x => x.who).filter((p, i, a) => a.indexOf(p) === i).map(p => esc(pname(p)) + (castOf(p) && castOf(p) !== pname(p) ? " · " + esc(castOf(p)) : "")).join(", ") || "Nobody"; }
function whereNowHTML(shotId){
  const t = clockNow(), rows = buildDay().steps.filter(x => stepShots(x).includes(shotId));
  if (!rows.length) return `<p class="muted" style="margin:0">Not in the running order yet (bonus, if there's time).</p>`;
  return rows.map(x => `<p style="margin:0 0 6px"><b>${whoLine([x])}</b> · ${esc(roomOf(x))} · ${clock24(x.s)}–${clock24(x.e)}${t >= x.s && t < x.e ? " <b>(now)</b>" : ""}</p>`).join("");
}
function myRoomsHTML(pid){
  const d = buildDay(), groups = {}, order = [];
  d.steps.filter(x => x.who.includes(pid) && !["move", "buffer", "wait", "brief", "wrap"].includes(x.kind)).sort((a, b) => a.s - b.s).forEach(x => {
    const k = roomOf(x); if (!k) return;
    if (!groups[k]){ groups[k] = {s: x.s, e: x.e, shots: []}; order.push(k); }
    groups[k].s = Math.min(groups[k].s, x.s); groups[k].e = Math.max(groups[k].e, x.e);
    stepShots(x).forEach(id => { const sh = shotById(id); if (sh && !groups[k].shots.some(o => o.id === sh.id)) groups[k].shots.push(sh); });
  });
  // every inspo picture she has in a room, even ones not yet in the running order
  ROOMS_ORDER.forEach(([name, locs]) => {
    const mine = activeShots().filter(sh => whoOf(sh.id).includes(pid) && locs.includes(sh.loc));
    if (!mine.length) return;
    if (!groups[name]){ groups[name] = {s: null, e: null, shots: []}; order.push(name); }
    mine.forEach(sh => { if (!groups[name].shots.some(o => o.id === sh.id)) groups[name].shots.push(sh); });
  });
  if (!order.length) return `<p class="muted">Nothing booked yet.</p>`;
  return `<ul class="steps">${order.sort((x, y) => (groups[x].s ?? 1e9) - (groups[y].s ?? 1e9)).map(k => { const g = groups[k];
    if (!g.shots.length && k !== "White background") return "";
    const when = g.s == null ? "Not in the running order yet" : `${clock24(g.s)}–${clock24(g.e)}`;
    return `<li class="step"><div class="st-time tnum">${when}</div><div style="min-width:0"><div class="st-cam">${esc(k)}</div><div class="st-title">${k === "White background" ? moodBtn(pid) + (g.shots.some(s => s.loc === "mix") ? " " + codeLinks(g.shots.filter(s => s.loc === "mix")) : "") : codeLinks(g.shots)}</div></div></li>`;
  }).join("")}</ul>`;
}
function viewRooms(){
  const d = buildDay(), t = clockNow(), rooms = {};
  d.steps.filter(x => !["move", "buffer", "wait", "brief", "wrap"].includes(x.kind)).forEach(x => {
    const k = roomOf(x); if (!k) return;
    (rooms[k] = rooms[k] || {steps: [], shots: []}).steps.push(x);
    stepShots(x).forEach(id => { if (!rooms[k].shots.includes(id)) rooms[k].shots.push(id); });
  });
  const keys = ROOM_ORDER.filter(k => rooms[k]).concat(Object.keys(rooms).filter(k => !ROOM_ORDER.includes(k)));
  const cards = keys.map(k => { const R = rooms[k];
    const now = R.steps.filter(x => t >= x.s && t < x.e), next = R.steps.filter(x => x.s >= t).sort((a, b) => a.s - b.s)[0];
    const codes = R.shots.map(id => shotById(id)).filter(Boolean).map(s => `<button class="codelink" data-act="peek" data-shot="${esc(s.id)}">${esc(code(s))}</button>`).join(" ");
    return `<div class="box" style="margin-bottom:12px"><h3 style="margin:0 0 6px">${esc(k)}</h3>
      <p style="margin:0 0 6px"><b>Now:</b> ${now.length ? whoLine(now) : "Nobody"}</p>
      <p class="muted" style="margin:0 0 10px"><b>Next:</b> ${next ? clock24(next.s) + " · " + whoLine([next]) : "Done"}</p>
      ${codes ? `<div><div class="eyebrow" style="margin-bottom:6px">Inspo (tap a code)</div>${codes}</div>` : ""}</div>`;
  }).join("");
  return `<div class="section-h"><div><h2>Rooms</h2></div></div><p class="lede">Who is in each room right now, and what's coming up. Tap a code to see the picture, and where that girl needs to be.</p>${cards || `<p class="muted">Nothing booked yet.</p>`}`;
}
function viewModels(){
  const p = P[persona], who = castOf(p.id), m = models().find(x => x.name === who);
  const mine = shotsFor(p.id);
  const loc = mine.filter(s => !["group","video","mix"].includes(s.loc)), mixS = mine.filter(s => s.loc==="mix"), grp = mine.filter(s => s.loc==="group"), vid = mine.filter(s => s.loc==="video");
  const ed = editable();
  const fig = s => `<figure class="${isTicked("shots", s.id) ? "done" : ""}">${imgSrc(s) ? `<img src="${esc(imgSrc(s))}" alt="" loading="lazy">` : `<div style="aspect-ratio:4/5"></div>`}<span class="code">${esc(code(s))}</span><figcaption>${esc(s.title)}${prioOf(s.id)==="bonus" ? ` <span class="muted">(bonus)</span>` : ""}</figcaption></figure>`;
  return `<div class="section-h"><div><h2>Model pages</h2><p class="lede">One page per personality: her outfit, props, shots and where she needs to be. Choose who plays each personality here.</p></div></div>
    <div class="personas" role="group" aria-label="Choose a personality" style="margin-bottom:16px">
      ${PERSONAS.map(x => `<button class="chip" data-act="persona" data-v="${x.id}" aria-pressed="${persona===x.id}">${esc(x.name)}${castOf(x.id) ? " · "+esc(castOf(x.id)) : ""}</button>`).join("")}
    </div>
    <section class="mcard">
      <div>
        <span class="p-tag pc-${p.id}">${esc(p.name)}</span>
        <h2 style="margin-top:10px">${who ? esc(who) : "Model to be chosen"}</h2>
        <p class="muted" style="margin:6px 0 0">${esc(p.vibe)}</p>
        <dl class="kv">
          <dt>Model</dt><dd>${ed ? `<select id="castSel" data-act="cast" data-p="${p.id}"><option value="">Choose…</option>${models().map(x => `<option ${x.name===who?"selected":""}>${esc(x.name)}</option>`).join("")}</select>` : (who ? esc(who) : `<span class="tbc">To be chosen</span>`)}</dd>
          <dt>Size</dt><dd>${m ? esc(m.size) : "—"}</dd>
          <dt>Wearing</dt><dd>${m ? esc(m.set) : "—"}</dd>
          <dt>Home location</dt><dd>${esc(p.room)}</dd>
        </dl>
        <div class="box"><div class="eyebrow" style="margin-bottom:6px">Her personality props</div>
          <ul class="list">${p.props.map(x => `<li>• ${esc(x)}</li>`).join("")}</ul></div>
        <div class="box" style="margin-top:12px"><div class="eyebrow" style="margin-bottom:6px">Where she needs to be</div>
          ${myStepsHTML(p.id)}</div>
      </div>
      <div style="min-width:0">
        <div class="eyebrow" style="margin-bottom:8px">White background checklist</div>
        ${studioRefs(p.id)}
        <div class="box" style="margin-bottom:16px">${WHITE.map((w,i) => `<label class="check"><input type="checkbox" id="w-${p.id}-${i}" data-act="white" data-k="${p.id}-${i}" ${isTicked("white", p.id+"-"+i) ? "checked" : ""}> <span>${esc(w)}${byLine("white", p.id+"-"+i) ? ` <span class="src">${esc(byLine("white", p.id+"-"+i))}</span>` : ""}</span></label>`).join("")}</div>
        <div class="eyebrow" style="margin-bottom:8px">Location shots (${loc.length})</div>
        ${loc.length ? `<div class="mini">${loc.map(fig).join("")}</div>` : `<p class="muted">None yet. Cast her in shots on the Shots tab.</p>`}
        ${mixS.length ? `<div class="eyebrow" style="margin:18px 0 8px">Mix and match (${mixS.length})</div><ul class="list">${mixS.map(s => `<li>• ${esc(s.title)}</li>`).join("")}</ul>` : ""}
        <div class="eyebrow" style="margin:18px 0 8px">Group shots (${grp.length})</div>
        ${grp.length ? `<div class="mini">${grp.map(fig).join("")}</div>` : `<p class="muted">None.</p>`}
        <div class="eyebrow" style="margin:18px 0 8px">Videos (${vid.length})</div>
        ${vid.length ? `<div class="mini">${vid.map(fig).join("")}</div>` : `<p class="muted">None.</p>`}
      </div>
    </section>
    <div class="section-h"><div><h2>The models</h2><p class="lede">${ed ? "Edit names, sizes and sets here if anything changes." : "Sizes and sets."}</p></div></div>
    <div class="tablewrap"><table><thead><tr><th>Model</th><th>Size</th><th>Set</th><th>Personality</th></tr></thead><tbody>
      ${models().map((x,i) => { const pp = PERSONAS.find(q => castOf(q.id)===x.name); return `<tr>
        <td>${ed ? `<input class="field" id="mn-${i}" data-act="model" data-i="${i}" data-f="name" value="${esc(x.name)}" aria-label="Model name">` : esc(x.name)}</td>
        <td>${ed ? `<input class="field" id="ms-${i}" data-act="model" data-i="${i}" data-f="size" value="${esc(x.size)}" style="width:5em" aria-label="Size">` : esc(x.size)}</td>
        <td>${ed ? `<input class="field" id="mt-${i}" data-act="model" data-i="${i}" data-f="set" value="${esc(x.set)}" style="width:100%;min-width:14em" aria-label="Set">` : esc(x.set)}</td>
        <td>${pp ? ptag(pp.id) : `<span class="tbc">Not cast yet</span>`}</td></tr>`; }).join("")}
    </tbody></table></div>`;
}
function hmSection(){
  if (!HM) return "";
  const byStart = t => { const m = String(t).match(/(\d+):(\d+)\s*(AM|PM)/i); if (!m) return 0; let h = +m[1] % 12; if (/pm/i.test(m[3])) h += 12; return h * 60 + +m[2]; };
  const mk = HM.rows.filter(r => /AM|PM/.test(r.makeup)).map(r => [r.makeup, r.name]).sort((a, b) => byStart(a[0]) - byStart(b[0]));
  const hr = HM.rows.filter(r => /\d/.test(r.hair)).map(r => [r.hair, r.name]).sort((a, b) => byStart(a[0]) - byStart(b[0]));
  return `<div class="section-h"><div><h2>Hair and makeup</h2><p class="lede">${esc(HM.title)} · ${esc(HM.location)}. Everyone ready by ${esc(HM.prep)}.</p></div></div>
    <div class="tablewrap"><table class="tnum sched"><thead><tr><th>Model</th><th>Arrive by</th><th>Hair · ${esc(HM.hairArtist)}</th><th>Makeup · ${esc(HM.makeupArtist)}</th></tr></thead><tbody>
      ${HM.rows.map(r => `<tr><td><b>${esc(r.name)}</b></td><td><b>${esc(r.arrive)}</b></td><td>${esc(r.hair)}</td><td>${esc(r.makeup)}</td></tr>`).join("")}
    </tbody></table></div>
    <div class="cols" style="margin-top:14px">
      <section class="pbox"><h3>${esc(HM.makeupArtist)} · makeup</h3><ul class="list tnum">${mk.map(([t, n]) => `<li><b>${esc(t)}</b>&nbsp;${esc(n)}</li>`).join("")}</ul></section>
      <section class="pbox"><h3>${esc(HM.hairArtist)} · hair</h3><ul class="list tnum">${hr.map(([t, n]) => `<li><b>${esc(t)}</b>&nbsp;${esc(n)}</li>`).join("")}</ul></section>
    </div>
    <div class="box" style="margin-top:14px"><div class="eyebrow" style="margin-bottom:6px">Day-of notes</div><ul class="list">${HM.notes.map(n => `<li>• ${esc(n.t)}</li>`).join("")}</ul></div>`;
}
function viewSchedule(){
  const ed = editable(), md = meta(), T = timing();
  return `<div class="section-h"><div><h2>Call sheet</h2><p class="lede">${ed ? "Fill in what's still to be confirmed. It saves when you leave each box." : "Details for the day."}</p></div></div>
    <div class="callsheet">
      ${[["date","Shoot date","date"],["address","Studio address","text"],["contact","Contact on the day","text"]].map(([k,l,t]) => `<label>${l}${ed ? `<input id="meta-${k}" type="${t}" data-act="meta" data-k="${k}" value="${esc(md[k])}" placeholder="To be confirmed">` : `<span style="font-size:15px;color:var(--ink)">${md[k] ? esc(k==="date" ? fmtDate(md[k]) : md[k]) : `<span class="tbc">To be confirmed</span>`}</span>`}</label>`).join("")}
      <label>Shoot time<span style="font-size:15px;color:var(--ink);font-weight:600" class="tnum">${esc(T.start)} – ${esc(T.end)} (${Math.round((mins(T.end) - mins(T.start)) / 6) / 10} hours)</span></label>
    </div>
    ${hmSection()}
    ${timingHTML()}
    ${runningOrderHTML()}`;
}
function viewProps(){
  const groups = [];
  PERSONAS.forEach(p => groups.push({h:p.name, tag:p.id, items:p.props.map(x => ({k:"p-"+p.id+"-"+x, t:x, who:castOf(p.id)||"", shots:[]}))}));
  const locGroups = [["bed","Bed",s => s.loc==="bed"],["couch","Couch",s => s.loc==="couch"],["kitchen","Kitchen",s => s.loc==="kitchen"],["mirror","Mirror station",s => s.loc==="mirror"],["mix","Mix and match",s => s.loc==="mix"],
    ["gbed","Group shots · bed",s => s.loc==="group" && s.gl==="bed"],["gkitchen","Group shots · kitchen",s => s.loc==="group" && s.gl==="kitchen"],["gcouch","Group shots · couch",s => s.loc==="group" && s.gl==="couch"],["video","Videos",s => s.loc==="video"]];
  locGroups.forEach(([id,h,f]) => {
    const seen = {}; activeShots().filter(s => f(s) && (whoOf(s.id).length || s.loc==="mix")).forEach(s => s.props.filter(x => x && !/^none$/i.test(x)).forEach(x => { const k = x.trim().toLowerCase(); (seen[k] = seen[k] || {t:x.trim(), shots:[]}).shots.push(s); }));
    groups.push({h, items:Object.entries(seen).map(([k,v]) => ({k:"l-"+id+"-"+k, t:v.t, shots:v.shots}))});
  });
  groups.push({h:"Wardrobe and emergency kit", items:EMERGENCY.map(x => ({k:"e-"+x, t:x, shots:[]}))});
  // Props you cross out are hidden (anyone on the team can restore them). Props of removed photos drop off by themselves.
  const gone = i => isTicked("props", "x|" + i.k);
  groups.forEach(g => { g.out = g.items.filter(gone); g.items = g.items.filter(i => !gone(i)); });
  const total = groups.reduce((a,g) => a+g.items.length, 0), got = groups.reduce((a,g) => a+g.items.filter(i => isTicked("props", i.k)).length, 0);
  const canX = !isModel();
  const row = (i, gi, ii) => `<div class="check proprow" style="display:flex;align-items:flex-start;gap:6px">
      <label style="display:flex;gap:10px;align-items:flex-start;flex:1;min-width:0;cursor:pointer"><input type="checkbox" id="pr-${gi}-${ii}" data-act="prop" data-k="${esc(i.k)}" ${isTicked("props", i.k) ? "checked" : ""}><span>${esc(i.t)}${i.who ? ` <span class="src">${esc(i.who)}</span>` : ""}${byLine("props", i.k) ? ` <span class="src">✓ ${esc(byLine("props", i.k))}</span>` : ""}</span></label>
      ${i.shots.length ? `<span class="src" style="white-space:normal">${codeLinks(i.shots)}</span>` : ""}
      ${canX ? `<button class="linkbtn quiet" data-act="propx" data-k="${esc(i.k)}" aria-label="Remove ${esc(i.t)} from the list" title="Not using this" style="padding:0 6px;font-size:18px;line-height:1">×</button>` : ""}
    </div>`;
  return `<div class="section-h"><div><h2>Props list</h2><p class="lede">The location lists build themselves from the shots still in the plan that have someone cast. When a shot is removed, its props drop off; when one is added, its props appear. Tick items off as they're bought or packed.</p><p class="lede" style="margin-top:8px">These props depend on which photos and videos we choose, so we won't need all of them. I listed everything that appears in each picture and video in case you wanted the full list. We can also improvise and work with what we have.</p><p class="lede" style="margin-top:8px">Tap a shot number to see the picture. Tap × to cross out a prop you won't use.</p></div><div class="muted tnum">${got}/${total} ticked</div></div>
    <div class="cols">${groups.map((g,gi) => `<section class="pbox"><h3>${g.tag ? `<span class="p-tag pc-${g.tag}" style="font-family:var(--body);font-size:13px;vertical-align:middle">${esc(g.h)}</span>` : esc(g.h)}</h3>
      ${g.items.map((i,ii) => row(i, gi, ii)).join("") || `<p class="muted" style="margin:0">Nothing yet.</p>`}
      ${g.out.length ? `<details style="margin-top:8px"><summary class="muted" style="cursor:pointer;font-size:13px">Crossed out (${g.out.length})</summary>${g.out.map(i => `<div class="row" style="justify-content:space-between;margin-top:6px"><span class="muted" style="text-decoration:line-through">${esc(i.t)}</span>${canX ? `<button class="linkbtn quiet" data-act="propback" data-k="${esc(i.k)}">Put back</button>` : ""}</div>`).join("")}</details>` : ""}
    </section>`).join("")}</div>`;
}
function viewLive(){
  const day = isShootDay(), md = meta(), pr = progress(), d = buildDay(), t = nowMins();
  const ROOM_LOCS = {Bed: ["bed", "mirror"], Couch: ["couch"], Kitchen: ["kitchen"]};
  const queue = d.steps.filter(x => x.cam === "loc" && stepShots(x).some(id => !isTicked("shots", id)));
  const upNext = queue.slice(0, 3).flatMap(x => stepShots(x)).filter(id => !isTicked("shots", id)).map(shotById).filter(Boolean);
  const room = queue.length ? queue[0].room : "";
  const roomBonus = (ROOM_LOCS[room] ? activeShots().filter(s => ROOM_LOCS[room].includes(s.loc)) : room ? activeShots().filter(s => s.loc === "group" && (GROUP_ROOMS[s.gl] || "") === room) : []).filter(s => prioOf(s.id) === "bonus" && !isTicked("shots", s.id));
  return `<div class="section-h"><div><h2>${day ? "Live" : "Shoot day preview"}</h2><p class="lede">${day ? "Who should be where right now, for all three cameras." : md.date ? `This view follows the clock on ${esc(fmtDate(md.date))}. Here's how the start of the shoot will look.` : "Add the shoot date on the Schedule tab and this view will follow the clock on the day."}</p></div></div>
    ${day && d.over > 0 ? `<div class="alert bad" style="margin-bottom:14px">The plan runs ${Math.round(d.over)} min past ${esc(d.T.end)}. Skip bonus shots to catch up.</div>` : ""}
    <div class="live">
      ${liveNowHTML()}
      <section class="panel">
        <div class="eyebrow">Progress</div>
        <div class="big tnum" style="margin-top:8px">${pr.done}/${pr.total}</div>
        <p class="muted" style="margin:6px 0 0">shots done · ${pr.whiteDone}/${pr.whiteTotal} white background</p>
      </section>
    </div>
    ${readyPanel()}
    ${upNext.length ? `<div class="section-h"><div><h2>Location camera: up next${room ? " · " + esc(room) : ""}</h2><p class="lede">Next location once these are shot: <b>${esc((queue.find(x => x.room !== room) || {}).room || "wrap")}</b></p></div></div><div class="grid">${upNext.map(shotCard).join("")}</div>` : `<div class="box" style="margin-top:14px">All location shots are marked as shot.</div>`}
    ${roomBonus.length ? `<h3 class="prio-h">Bonus in the ${esc(room.toLowerCase())}, if there's time</h3><div class="grid">${roomBonus.map(shotCard).join("")}</div>` : ""}
    ${(() => { const done = activeShots().filter(s => isTicked("shots", s.id)); return done.length ? `<div class="box" style="margin-top:16px"><div class="eyebrow" style="margin-bottom:6px">Shot so far (${done.length})</div>${codeLinks(done)}<p class="muted" style="margin:6px 0 0;font-size:13px">Tap a number to see it or undo.</p></div>` : ""; })()}`;
}

function render(bg){
  const md = meta(), pr = progress();
  if (!me) return;
  document.getElementById("hdrMeta").innerHTML = `<span>${md.date ? esc(fmtDate(md.date)) : "Date to be confirmed"}</span><span>${esc(timing().start)}–${esc(timing().end)}</span><span class="sync">${online ? (isOwner() ? "Saved for everyone" : "Live") : "Offline, reconnecting…"}</span><span>${esc(me.name)} · <button class="linkbtn quiet" data-act="signout" style="font-size:inherit">Sign out</button></span>`;
  document.getElementById("prog").style.width = (pr.total ? Math.round(pr.done/pr.total*100) : 0) + "%";
  document.querySelectorAll(".modeswitch button").forEach(b => b.setAttribute("aria-pressed", b.dataset.mode === mode));
  document.querySelectorAll("nav.tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === tab));
  // The Campus Girl tab is only shown to the coordinator who plays that role.
  const ct = document.getElementById("tab-campus"), mineOnly = !!me && me.name === "Vuyo";
  if (ct) ct.style.display = mineOnly ? "" : "none";
  if (tab === "campus" && !mineOnly) tab = "live";
  const a = document.activeElement;
  if (a && a.matches("input:not([type=checkbox]):not([type=file]),textarea,select") && document.getElementById("main").contains(a)) { pendingRender = true; return; }
  pendingRender = false;
  // Background updates wait until the phone has stopped scrolling, and nothing is redrawn unless it actually changed.
  if (bg && Date.now() - lastScroll < 1500){ clearTimeout(bgTimer); bgTimer = setTimeout(() => render(true), 1600); return; }
  const html = isModel() ? viewMine() : tab === "campus" ? viewMine("bookworm") : alerts() + ({live:viewLive, glam:viewGlam, shots:viewShots, moods:viewMoods, rooms:viewRooms, models:viewModels, schedule:viewSchedule, props:viewProps}[tab] || viewLive)();
  if (html !== lastHTML){ const y = window.scrollY; document.getElementById("main").innerHTML = html; lastHTML = html; window.scrollTo(0, y); }
  let pk = document.getElementById("peekRoot"); if (!pk){ pk = document.createElement("div"); pk.id = "peekRoot"; document.body.appendChild(pk); }
  const ph = peekHTML(); if (pk.innerHTML !== ph && pk.dataset.h !== ph){ pk.innerHTML = ph; pk.dataset.h = ph; }
  let gp = document.getElementById("glamPop"); if (!gp){ gp = document.createElement("div"); gp.id = "glamPop"; gp.setAttribute("role", "alert"); document.body.appendChild(gp); }
  const gh = glamAlerts(); if (gp.dataset.h !== gh){ gp.innerHTML = gh; gp.dataset.h = gh; }
  const ov = peekId ? "hidden" : ""; if (document.body.style.overflow !== ov) document.body.style.overflow = ov;
}
let pendingRender = false, lastHTML = "", lastScroll = 0, bgTimer = null;
window.addEventListener("scroll", () => { lastScroll = Date.now(); }, {passive:true});
window.addEventListener("touchmove", () => { lastScroll = Date.now(); }, {passive:true});

/* ---------------- events ---------------- */
const val = id => { const e = document.getElementById(id); return e ? e.value : ""; };
document.addEventListener("click", async e => {
  const mb = e.target.closest(".modeswitch button"); if (mb){ mode = mb.dataset.mode; store.set("st-mode", mode); editing = null; render(); return; }
  const tb = e.target.closest("nav.tabs button"); if (tb){ tab = tb.dataset.tab; store.set("st-tab", tab); window.scrollTo(0,0); render(); return; }
  const b = e.target.closest("[data-act]"); if (!b || b.tagName === "SELECT" || b.tagName === "INPUT") return;
  const act = b.dataset.act, id = b.dataset.shot;
  if (act === "signout"){ signOut(); return; }
  if (act === "schedcam"){ schedCam = b.dataset.v; render(); return; }
  if (act === "peek"){ peekId = b.dataset.shot; render(); return; }
  if (act === "gomood"){ showMood(b.dataset.p); return; }
  if (act === "peekstay" && !e.target.closest("[data-act=peekclose]")) return;
  if (act === "peekclose"){ if (e.target.closest(".peekcard") && !e.target.closest(".peekx")) return; peekId = null; render(); return; }
  if (act === "mtick"){ setTick(b.dataset.kind, b.dataset.k, !isTicked(b.dataset.kind, b.dataset.k)); return; }
  if (act === "help"){ setTick("help", me.name, !isTicked("help", me.name)); return; }
  if (act === "helpdone"){ setTick("help", b.dataset.k, false); return; }
  if (act === "seen"){ store.set("st-seen-" + me.name, changes.length ? changes[0].id : 0); render(); return; }
  if (act === "loc"){ locFilter = b.dataset.v; showRemoved = false; render(); }
  else if (act === "pf"){ personaFilter = b.dataset.v; render(); }
  else if (act === "showrem"){ showRemoved = !showRemoved; locFilter = "all"; render(); }
  else if (act === "persona"){ persona = b.dataset.v; store.set("st-persona", persona); render(); }
  else if (!editable() && ["who","prio","allprio","remove","restore","edit","editsave","addopen","addsave"].includes(act)) return;
  else if (act === "who"){ const w = whoOf(id), p = b.dataset.p; savePlan({shots:{[id]:{who: w.includes(p) ? w.filter(x => x !== p) : [...w, p].sort((x,y) => ALL.indexOf(x)-ALL.indexOf(y))}}}, `${w.includes(p) ? "Took the " + pname(p) + " out of" : "Put the " + pname(p) + " in"} “${shotById(id).title}”`); }
  else if (act === "allprio"){ const v = b.dataset.v; if (confirm(v === "bonus" ? "Make every shot a bonus? Then tap MUST on the ones you want." : "Make every shot a must-have?")) savePlan({shots: Object.fromEntries(activeShots().map(s => [s.id, {prio: v}]))}, v === "bonus" ? "Made every shot a bonus" : "Made every shot a must-have"); }
  else if (act === "prio"){ savePlan({shots:{[id]:{prio: prioOf(id)==="must" ? "bonus" : "must"}}}, `Made “${shotById(id).title}” ${prioOf(id)==="must" ? "a bonus" : "a must-have"}`); }
  else if (act === "remove"){ savePlan({shots:{[id]:{removed:true}}}, `Removed “${shotById(id).title}”`); toast("Removed. Find it under “Removed” to put it back."); }
  else if (act === "restore"){ savePlan({shots:{[id]:{removed:false}}}, `Put “${shotById(id).title}” back in the plan`); }
  else if (act === "edit"){ editing = id; editDraft = {}; render(); }
  else if (act === "editcancel"){ editing = null; editDraft = {}; render(); }
  else if (act === "editsave"){ editDraft = {}; const t = val("e-title").trim(), n = val("e-note").trim(), pr = val("e-props").split(",").map(x => x.trim()).filter(Boolean); editing = null; document.activeElement && document.activeElement.blur(); savePlan({shots:{[id]:{title:t, note:n, props:pr}}}, `Edited “${t || shotById(id).title}”`); }
  else if (act === "addopen"){ adding = true; render(); }
  else if (act === "addcancel"){ adding = false; draft = {title:"", loc:"bed", note:"", props:"", img:"", busy:false}; render(); }
  else if (act === "addsave"){
    syncDraft(); if (!draft.img && !draft.title.trim()){ toast("Add a photo or a name first."); return; }
    const [loc, gl] = draft.loc.split(":");
    const doc = {title: draft.title.trim() || "New shot", loc, gl: gl||"", note: draft.note.trim(), props: draft.props.split(",").map(x => x.trim()).filter(Boolean), who: [], prio:"must", img: draft.img, created: Date.now()};
    adding = false; draft = {title:"", loc:"bed", note:"", props:"", img:"", busy:false};
    const nid = "x-" + Date.now().toString(36);
    customs = [...customs, {id: nid, ...doc}];
    try { rev = await rpc("st_add_custom", {p_code: accessCode(), p_id: nid, p_data: doc}); toast("Added. Now tap who's in it."); } catch(err){ customs = customs.filter(c => c.id !== nid); onWriteErr(err); }
    locFilter = loc; render();
  }
  else if (act === "tick"){ setTick("shots", id, !isTicked("shots", id)); }
  else if (act === "propx"){ setTick("props", "x|" + b.dataset.k, true); }
  else if (act === "propback"){ setTick("props", "x|" + b.dataset.k, false); }
});
function syncDraft(){ ["title","loc","note","props"].forEach(k => { const el = document.querySelector(`[data-draft="${k}"]`); if (el) draft[k] = el.value; }); }
document.addEventListener("input", e => { const ds = e.target.dataset || {}; if (ds.draft) draft[ds.draft] = e.target.value; if (ds.edraft) editDraft[ds.edraft] = e.target.value; });
document.addEventListener("change", async e => {
  const el = e.target, a = el.dataset && el.dataset.act;
  if (el.dataset && el.dataset.draft){ draft[el.dataset.draft] = el.value; return; }
  if (!a) return;
  if (a === "addfile"){ const f = el.files && el.files[0]; if (!f) return; syncDraft(); draft.busy = true; el.blur(); render(); try { draft.img = await compress(f); } catch(err){ toast("That file couldn't be read. Try a JPG or PNG."); } draft.busy = false; render(); return; }
  if (a === "white"){ setTick("white", el.dataset.k, el.checked); return; }
  if (a === "prop"){ setTick("props", el.dataset.k, el.checked); return; }
  if (a === "vshot"){ setTick("shots", el.dataset.k, el.checked); return; }
  if (a === "timing" && editable()){ const k = el.dataset.k, v = k === "swapAt" ? el.value : Math.max(1, Math.min(60, +el.value || 1)); savePlan({timing: {[k]: v}}, `Changed the timing (${k}) to ${v}`); return; }
  if (a === "ready"){ setTick("ready", el.dataset.k, el.checked); return; }
  if (a === "blockdone"){ setTick("blocks", el.dataset.i, el.checked); return; }
  if (!editable()) return;
  if (a === "cast"){ const pid = el.dataset.p, name = el.value, cast = {}; PERSONAS.forEach(p => { if (p.id !== pid && name && castOf(p.id) === name) cast[p.id] = ""; }); cast[pid] = name; el.blur(); savePlan({cast}, name ? `Cast ${name} as the ${pname(pid)}` : `Took the model off the ${pname(pid)}`); }
  else if (a === "meta"){ savePlan({meta:{[el.dataset.k]: el.value.trim()}}, `Updated the call sheet (${({date:"shoot date", address:"address", hmCall:"hair and makeup call times", contact:"contact on the day"})[el.dataset.k]}): ${el.value.trim() || "cleared"}`); }
  else if (a === "model"){ const ms = models().map(m => ({...m})); const i = +el.dataset.i, f = el.dataset.f, old = ms[i][f]; ms[i][f] = el.value.trim(); const patch = {models:ms};
    if (f === "name"){ const cast = {}; PERSONAS.forEach(p => { if (castOf(p.id) === old) cast[p.id] = ms[i].name; }); if (Object.keys(cast).length) patch.cast = cast; }
    savePlan(patch, `Updated ${ms[i].name || "a model"}'s ${({name:"name", size:"size", set:"set"})[f]}`); }
});
document.addEventListener("focusout", () => setTimeout(() => { const a = document.activeElement; if (pendingRender && !(a && a.matches("input:not([type=checkbox]):not([type=file]),textarea,select"))) render(); }, 0));
setInterval(() => { if (isModel() || tab === "live" || (tab === "schedule" && mode === "day")) render(true); }, 30000);

connect();

})();

import { Map, Marker, NavigationControl, GeolocateControl } from "https://cdn.jsdelivr.net/npm/maplibre-gl@6.12.0/dist/maplibre-gl.mjs";

const $ = (s) => document.querySelector(s);
const panel = $("#panel"), list = $("#list");
const P = new URL(location.href).searchParams;
const state = { lot: P.get("lot"), when: P.get("when") ?? "", dur: P.get("dur") ?? "120", res: P.get("res") === "1", bus: P.get("bus") === "1", cp: P.get("cp") === "1", zone: P.get("zone") ?? "", center: null, results: [], street: null, alts: [] };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`); // scraped text: never raw HTML
const LIVE = { free: "פנוי", few: "מעט מקומות", full: "מלא", closed: "סגור" }; // "open" / "unknown" carry no occupancy
const liveOf = (l) => (l.live && LIVE[l.live.status] ? l.live.status : null);
const KIND = { flat: "כניסה חד-פעמית", per_minute: "לפי דקה", step: "לפי שעה" };
const DAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
const OPERATOR = { ahuzot: "אחוזות החוף", centralpark: "סנטרל פארק", green: "גרין פרקינג", "dizengoff-center": "דיזנגוף סנטר", sarona: "חניון שרונה (גינדי)",
  azrieli: "עזריאלי", registry: "מרשם רישוי העסקים של העירייה", osm: "OpenStreetMap" };
const ils = (n) => (n == null ? "לפי השילוט" : n === 0 ? "חינם" : `₪${+n.toFixed(2)}`);
const price = (q) => (q.price_basis === "municipal_data_unverified" ? "חינם?" : ils(q.price_ils));
// a lot's sign plate: colour = price band for the chosen time, dashed border = unverified, plain P = price per the sign
const tier = (q) => q.price_ils == null ? "sign" : q.price_basis === "municipal_data_unverified" ? "t1 unv"
  : q.price_ils <= 20 ? "t1" : q.price_ils <= 40 ? "t2" : q.price_ils <= 80 ? "t3" : "t4";
const face = (q) => q.price_ils == null ? "P" : price({ ...q, price_ils: Math.round(q.price_ils) });

// Asia/Jerusalem wall clock as fake-UTC ms, same convention as the API
const DAY = 864e5, HOUR = 36e5;
function jlmNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`);
}
const fmt = (ms) => new Date(ms).toISOString().slice(0, 16);
const whenText = (s) => { const d = new Date(Date.parse(s + ":00Z")); return `יום ${DAYS[d.getUTCDay()]} ${d.getUTCDate()}/${d.getUTCMonth() + 1}`; };
const endOf = (s, mins) => fmt(Date.parse(s + ":00Z") + mins * 6e4).slice(11);

function qs(extra = {}) {
  const o = { duration: state.dur, ...extra };
  if (state.when) o.start = state.when;
  if (state.res) o.resident = 1;
  if (state.res && state.zone) o.zone = state.zone;
  const apps = [...(state.bus ? ["pango", "cello"] : []), ...(state.cp ? ["centralpark"] : [])];
  if (apps.length) o.apps = apps.join(",");
  if (state.bus) o.transit = 1;
  return new URLSearchParams(o);
}
function sync() {
  const u = new URLSearchParams();
  for (const [k, v] of [["lot", state.lot], ["when", state.when], ["dur", state.dur !== "120" && state.dur], ["res", state.res && 1], ["zone", state.res && state.zone], ["bus", state.bus && 1], ["cp", state.cp && 1]]) if (v) u.set(k, v);
  history.replaceState(null, "", u.size ? `?${u}` : location.pathname);
}

// --- map
// flat, Google-like: liberty's colours, but no tilt/rotate, no 3D buildings and no shop/café icons
const map = new Map({ container: "map", style: "https://tiles.openfreemap.org/styles/liberty", center: [34.78, 32.075], zoom: 13, maxPitch: 0, dragRotate: false, pitchWithRotate: false, touchPitch: false, attributionControl: { compact: true } });
map.touchZoomRotate.disableRotation();
map.on("style.load", () => {
  for (const id of ["building-3d", "poi_r1", "poi_r7", "poi_r20"]) if (map.getLayer(id)) map.removeLayer(id);
  for (const [id, prop, v] of [["park", "fill-color", "#c8e6c0"], ["park", "fill-opacity", 1], ["water", "fill-color", "#9ccbf2"]]) map.setPaintProperty(id, prop, v);
});
map.addControl(new NavigationControl({ showCompass: false }), "bottom-left");
const geo = new GeolocateControl({ positionOptions: { enableHighAccuracy: true } });
map.addControl(geo, "bottom-left");
geo.on("geolocate", (e) => { state.center = { lat: e.coords.latitude, lng: e.coords.longitude, label: "המיקום שלי" }; state.alts = []; load().then(showList); });
let pin, pins = [];
const far = () => map.getContainer().classList.toggle("far", map.getZoom() < 14);
map.on("zoom", far);
far();

// plates are decorative for assistive tech: the list is the accessible way to the same lots
const plateHtml = (l, extra = "") => `<span class="plate ${tier(l)}${extra}" dir="ltr">${esc(face(l))}${liveOf(l) ? `<i class="live ${liveOf(l)}"></i>` : ""}</span>`;
function drawPins() {
  pins.forEach((m) => m.remove());
  pins = [...state.results].reverse().map((l) => { // cheapest added last, so drawn on top
    const el = document.createElement("div");
    el.className = "pin";
    el.dataset.id = l.id;
    el.setAttribute("aria-hidden", "true");
    el.innerHTML = plateHtml(l, `${l.open_whole_stay ? "" : " off"}${l.id === state.lot ? " sel" : ""}`);
    el.addEventListener("click", () => openLot(l.id));
    return new Marker({ element: el, anchor: "bottom" }).setLngLat([l.lng, l.lat]).addTo(map);
  });
}
const select = (id) => document.querySelectorAll(".pin").forEach((p) => p.firstElementChild.classList.toggle("sel", p.dataset.id === id));

let loads = 0;
async function load() {
  const n = ++loads; // arrow clicks fire fast: only the latest answer may draw
  const extra = state.center ? { lat: state.center.lat, lng: state.center.lng, max_walk: 100000 } : {};
  const r = await (await fetch(`/api/search?${qs(extra)}`)).json();
  if (n !== loads) return;
  state.results = r.results ?? [];
  state.street = r.street ?? null;
  drawPins();
  if (!list.hidden) showList();
  if (state.lot && !panel.hidden) openLot(state.lot, false);
}

function showList() {
  const near = state.center ? state.results.filter((l) => l.distance_m != null && l.distance_m <= 1000) : state.results;
  const head = state.center
    ? `<li class="head">חניונים עד 1 ק״מ מ${esc(state.center.label)}, מהזול ליקר.<br>${savedPlace(state.center)
      ? `<span class="save"><span class="ms">place</span>שמור בנקודות הציון שלך</span>` : `<button class="save" id="savePlace"><span class="ms">add</span>שמירה כנקודת ציון</button>`}${state.alts.length ? `<br>התכוונתם ל${state.alts.map((a, i) => `<a href="#" data-alt="${i}">${esc(a.label)}</a>`).join(" או ")}?` : ""}</li>`
    : `<li class="head">כל החניונים, מהזול ליקר. חפשו כתובת כדי לראות מה קרוב אליה.</li>`;
  list.querySelector("ol").innerHTML = head + (state.center && state.street ? streetRow(state.street) : "") + (near.map((l) => `<li><button data-id="${esc(l.id)}" aria-label="${esc(`${l.name}, ${price(l)}`)}">
    ${plateHtml(l)}
    <span><span class="row-name">${esc(l.name)}</span><span class="row-sub">${esc(OPERATOR[l.operator] ?? l.operator)}</span></span>
    <span class="row-end">${l.distance_m != null ? `${l.distance_m} מ׳` : ""}${liveOf(l) ? `<span class="status ${liveOf(l)}">${LIVE[liveOf(l)]}</span>` : ""}</span>
  </button></li>`).join("") || `<li class="head">אין חניונים ידועים עד 1 ק״מ מכאן. הקטינו את המפה או חפשו כתובת אחרת.</li>`);
  list.hidden = false; panel.hidden = true;
  $("#listBtn").setAttribute("aria-pressed", "true");
}
// blue-white parking at the searched point (src/street.ts): price for the stay and a rough chance of finding a spot
const AREA = { center: "מרכז העיר", city: "רחבי העיר" };
const streetRow = (s) => `<li class="street">
  <span class="plate bw" dir="ltr">${esc(ils(s.price_ils))}</span>
  <span><span class="row-name">חניה ברחוב, כחול-לבן</span><span class="row-sub">אזור ${esc(s.zone)}, ${AREA[s.area]}${s.permit === "own_zone" ? ", חינם עם התו שלך"
    : s.paid_minutes ? `, ₪${esc(s.rate_ils_per_hour)} לשעה` : ", ללא תשלום בשעות האלה"}</span></span>
  <span class="row-end"><span class="status ${s.chance_pct >= 50 ? "free" : s.chance_pct >= 25 ? "few" : "full"}">סיכוי ~${esc(s.chance_pct)}%</span>הערכה</span>
  <details><summary>איך זה מחושב</summary>
    <p>הסיכוי למצוא מקום הוא הערכה לפי היום והשעה${s.live_lots ? `, ולפי התפוסה עכשיו ב-${esc(s.live_lots)} חניוני אחוזות החוף הקרובים` : ""}. זה לא נתון חי מהרחוב.</p>
    ${s.permit === "other_zone" ? `<p>בעלי תו מאזור אחר: שעתיים ביום חינם, ואחריהן 30% הנחה.${state.zone ? "" : " בחרו את אזור התו שלכם כדי לראות אם החניה כאן חינם."}</p>` : ""}
    <p>משלמים בפנגו או בסלו מהדקה הראשונה. חלק מרחובות הכחול-לבן מיועדים לבעלי תו האזור בלבד, והתמרור בתחילת הרחוב קובע.</p>
  </details>
</li>`;
list.addEventListener("click", (e) => {
  const b = e.target.closest("[data-id]"), a = e.target.closest("[data-alt]");
  if (b) openLot(b.dataset.id);
  if (e.target.closest("#savePlace")) addPlace(state.center).then(() => me && showList());
  if (a) { e.preventDefault(); const pick = state.alts[+a.dataset.alt]; state.alts = [state.center, ...state.alts.filter((x) => x !== pick)]; goTo(pick); }
});

async function openLot(id, fly = true) {
  state.lot = id; sync(); select(id);
  const r = await fetch(`/api/lots/${encodeURIComponent(id)}?${qs()}`);
  if (!r.ok) return;
  const d = await r.json(), q = d.quote;
  const offer = (o) => q.applied_offers.includes(o.id) ? `<p class="note green">ההטבה חלה עליכם: ${esc(o.title.he)}</p>`
    : q.potential_offers.includes(o.id) ? `<p class="note yellow">אפשר לחסוך: ${esc(o.title.he)}</p>` : "";
  const restricted = d.sign && !d.sign.free && d.operator === "ahuzot", op = OPERATOR[d.operator] ?? d.operator;
  const dur = $("#dur").selectedOptions[0]?.text ?? `${q.duration_minutes} דק׳`;
  panel.innerHTML = `
    <button id="close" class="icon-btn" aria-label="סגירה"><span class="ms">close</span></button>
    <h2>${esc(d.name)}</h2>
    <p class="sub">${esc(d.address)}<br>${esc(op)}${d.spaces ? `, ${d.spaces} מקומות` : ""}</p>
    <div class="board ${tier(q)}">
      ${q.price_ils == null ? `<div class="board-price small">לפי השילוט</div>` : `<div class="board-price" dir="ltr">${esc(price(q))}</div>`}
      <div class="board-when">${whenText(q.start)}, <span dir="ltr">${q.start.slice(11)}–${endOf(q.start, q.duration_minutes)}</span> (${esc(dur)})${state.res ? "<br>כולל הנחת תושב/ת ת״א" : ""}</div>
    </div>
    ${q.app_price_ils != null ? `<div class="split"><div class="${state.cp ? "" : "on"}">בקופה<b dir="ltr">${ils(q.gate_price_ils)}</b></div><div class="${state.cp ? "on" : ""}">באפליקציית ${esc(op)}<b dir="ltr">${ils(q.app_price_ils)}</b></div></div>` : ""}
    <div class="facts">
      ${liveOf(d) ? `<p><span class="status ${liveOf(d)}" style="display:inline">${LIVE[liveOf(d)]}</span> עכשיו, עודכן ב-${esc(d.live.updated.slice(11))}</p>` : ""}
      ${q.breakdown.length > 1 ? q.breakdown.map((b) => `<p>${b.from.slice(11)}–${b.to.slice(11)}: ${KIND[b.kind]}, ₪${b.price}</p>`).join("") : q.breakdown.map((b) => `<p>תשלום ${KIND[b.kind]}</p>`).join("")}
    </div>
    ${d.sign ? `<p class="note${restricted ? " red" : ""}">${esc(d.sign.he)}</p>` : ""}
    ${!q.can_enter ? `<p class="note red">אין כניסה לחניון בשעה הזו.</p>` : !q.open_whole_stay ? `<p class="note red">החניון סגור בחלק מזמן החניה, וייתכן שלא תוכלו לצאת.</p>` : ""}
    ${d.offers.map(offer).join("")}
    <div class="actions">
      <a class="act primary" href="${esc(d.links.waze)}" target="_blank" rel="noopener"><span class="ms">directions</span>ניווט ב-Waze</a>
      <a class="act" href="${esc(d.links.google_maps)}" target="_blank" rel="noopener"><span class="ms">map</span>Google Maps</a>
      <button class="act" id="share"><span class="ms">link</span><span>העתקת קישור</span></button>
    </div>
    <div id="attach"></div>
    ${d.tariffs ? `<h3>תעריף</h3>${tariffTable(d.tariffs, d.app_tariffs)}
      ${d.grace_minutes ? `<p class="tariff-note">עד ${d.grace_minutes} דקות בחניון: חינם</p>` : ""}
      ${d.resident_discount_pct ? `<p class="tariff-note">${d.resident_discount_pct}% הנחה לתושבי תל אביב-יפו</p>` : ""}
      ${d.resident_tariffs ? `<h3>לתושבי תל אביב-יפו</h3>${tariffTable(d.resident_tariffs)}` : ""}
      ${d.tariff_text ? `<details><summary>הנוסח המפורסם</summary><pre>${esc(d.tariff_text)}</pre></details>` : ""}`
    : d.tariff_text ? `<h3>התעריף המפורסם</h3><pre>${esc(d.tariff_text)}</pre>` : ""}
    ${d.hours_text ? `<h3>שעות פעילות</h3><p>${esc(d.hours_text)}</p>` : ""}
    ${d.serves ? `<p class="sub">משרת את ${esc(d.serves)}</p>` : ""}
    <p class="fine">המחיר הוא הערכה לפי התעריף שפורסם, והשילוט בחניון קובע. נבדק ב-${esc(d.verified_at)}.
      <a href="${esc(d.source_url)}" target="_blank" rel="noopener">למקור</a>, <a href="${esc(d.links.report)}" target="_blank" rel="noopener">דיווח על מחיר שגוי</a></p>`;
  panel.hidden = false; list.hidden = true; panel.dataset.view = "lot";
  $("#listBtn").setAttribute("aria-pressed", "false");
  drawAttach(d);
  $("#close").onclick = () => { panel.hidden = true; state.lot = null; sync(); select(null); };
  $("#share").onclick = () => navigator.clipboard.writeText(location.href).then(() => ($("#share span:last-child").textContent = "הועתק ✓"));
  if (fly) map.easeTo({ center: [d.lng, d.lat], zoom: Math.max(map.getZoom(), 15), padding: sidePad() });
}

// a lot's rules (same shape as src/engine.ts Rule) as a day ▸ hours ▸ price table; app[i] is the app price of rules[i]
const DAYKEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat", "holiday_eve", "holiday"];
function daysText(ds) {
  const w = ds.map((x) => DAYKEYS.indexOf(x)).filter((i) => i < 7);
  if (w.length === 7) return "כל יום";
  const wk = !w.length ? "" : w.length === 1 ? `יום ${DAYS[w[0]]}` : w.every((x, i) => !i || x === w[i - 1] + 1) ? `${DAYS[w[0]]} ${w.length === 2 ? "ו" : "עד "}${DAYS[w.at(-1)]}` : w.map((i) => DAYS[i]).join(", ");
  const eve = ds.includes("holiday_eve"), hol = ds.includes("holiday");
  return [wk, eve && hol ? "ערבי חג וחגים" : eve ? "ערבי חג" : hol ? "חגים" : ""].filter(Boolean).join(", ");
}
const STEP_TEXT = { 15: "כל רבע שעה נוספת", 30: "כל חצי שעה נוספת", 60: "כל שעה נוספת" };
// [label, ₪] rows; app rules share the shape, so their rows zip by index
const ruleRows = (r) => [
  ...(r.kind === "flat" ? [[`כניסה חד פעמית${r.valid_hours ? `, תקף ${r.valid_hours} שעות` : r.valid_until ? `, תקף עד ${r.valid_until}` : ""}`, r.price]]
    : r.kind === "step" ? [["שעה ראשונה", r.first_hour], [STEP_TEXT[r.step_minutes] ?? `כל ${r.step_minutes} דק׳ נוספות`, r.step_price]]
    : r.tiers?.length ? [...r.tiers.map(([upTo, rate], i) => [`לשעה, דקות ${i ? r.tiers[i - 1][0] + 1 : 1}–${upTo}`, rate]), [`לשעה, מהדקה ה-${r.tiers.at(-1)[0] + 1}`, r.rate]]
    : [["לשעה (חיוב לפי דקה)", r.rate]]),
  ...(r.daily_max != null ? [["מקסימום ליום", r.daily_max]] : []),
];
function tariffTable(rules, app) {
  const groups = {};
  rules.forEach((r, i) => (groups[r.days.join()] ??= []).push([r, app?.[i]]));
  return Object.values(groups).sort((a, b) => DAYKEYS.indexOf(a[0][0].days[0]) - DAYKEYS.indexOf(b[0][0].days[0])).map((items) => {
    items.sort(([a], [b]) => a.from.localeCompare(b.from));
    const allDay = items.length === 1 && items[0][0].from === items[0][0].to; // nothing to split by hour
    return `<table class="tariff"><caption>${daysText(items[0][0].days)}</caption>
    ${app ? `<thead><tr><th scope="col"><span class="sr">פריט</span></th><th scope="col">מחיר מלא</th><th scope="col">באפליקציה</th></tr></thead>` : ""}
    ${items.map(([r, a]) => { const ar = a && ruleRows(a); return `<tbody>${allDay ? "" : `<tr><th colspan="3" scope="rowgroup" dir="ltr">${r.from === r.to ? "כל היום" : `${r.from}–${r.to}`}</th></tr>`}
      ${ruleRows(r).map(([t, p], i) => `<tr><td>${t}</td><td>${ils(p)}</td>${ar ? `<td class="app">${ils(ar[i]?.[1])}</td>` : ""}</tr>`).join("")}</tbody>`; }).join("")}
  </table>`;
  }).join("");
}

// keep the focused point visible beside the sheet (right side on desktop, bottom sheet on mobile)
const sidePad = () => {
  const top = $("#bar").offsetHeight;
  return innerWidth > 700 ? { top, right: 424, left: 0, bottom: 0 } : { top, bottom: innerHeight * 0.62, left: 0, right: 0 };
};

function goTo(c) {
  state.center = c;
  pin?.remove();
  pin = new Marker({ color: "#ea4335" }).setLngLat([c.lng, c.lat]).addTo(map);
  showList();
  map.flyTo({ center: [c.lng, c.lat], zoom: 15, padding: sidePad() });
  load();
}

// --- controls
$("#search").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#q").value.trim();
  if (!q) return;
  const { candidates = [], error } = await (await fetch(`/api/places?q=${encodeURIComponent(q)}`)).json().catch(() => ({ error: true }));
  if (!candidates.length) { $("#q").setCustomValidity(error ? "שירות החיפוש לא זמין כרגע. נסו שוב בעוד רגע." : "לא נמצא. נסו שם מקום, או רחוב ומספר בית."); $("#q").reportValidity(); return; }
  state.alts = candidates.slice(1);
  goTo(candidates[0]);
});
$("#q").addEventListener("input", () => $("#q").setCustomValidity(""));
// when: "" = now, else Jerusalem wall clock "YYYY-MM-DDTHH:MM"
const STEP = 15 * 6e4;
const dateFmt = new Intl.DateTimeFormat("he-IL", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
function showWhen() {
  $("#mode").value = state.when ? "at" : "now";
  $("#at").hidden = !state.when;
  if (!state.when) return;
  $("#time").value = state.when.slice(11);
  $("#date").value = state.when.slice(0, 10);
  $("#dateTxt").textContent = dateFmt.format(Date.parse(state.when + ":00Z"));
}
const setWhen = (v) => { state.when = v; showWhen(); sync(); load(); };
$("#mode").addEventListener("change", (e) => setWhen(e.target.value === "now" ? "" : fmt(Math.ceil(jlmNow() / STEP) * STEP)));
$("#time").addEventListener("change", (e) => e.target.value && setWhen(state.when.slice(0, 11) + e.target.value));
$("#date").addEventListener("change", (e) => e.target.value && setWhen(e.target.value + state.when.slice(10)));
// time arrows snap to the quarter hour (21:40 ▸ 21:45), date arrows keep the time
document.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => {
  const t = Date.parse(state.when + ":00Z"), d = +b.dataset.step;
  setWhen(fmt(b.dataset.unit === "date" ? t + d * DAY : Math[d > 0 ? "floor" : "ceil"](t / STEP) * STEP + d * STEP));
}));
$("#dateBtn").addEventListener("click", () => { try { $("#date").showPicker(); } catch { $("#date").focus(); } });
$("#dur").addEventListener("change", (e) => { state.dur = e.target.value; sync(); load(); });
$("#res").addEventListener("change", (e) => { state.res = e.target.checked; $("#zoneChip").hidden = !state.res; sync(); load(); });
$("#zone").addEventListener("change", (e) => { state.zone = e.target.value; sync(); load(); });
$("#bus").addEventListener("change", (e) => { state.bus = e.target.checked; sync(); load(); });
$("#cp").addEventListener("change", (e) => { state.cp = e.target.checked; sync(); load(); });
$("#listBtn").addEventListener("click", () => (list.hidden ? showList() : ((list.hidden = true), $("#listBtn").setAttribute("aria-pressed", "false"))));
new ResizeObserver(() => document.documentElement.style.setProperty("--bar-h", `${$("#bar").offsetHeight}px`)).observe($("#bar"));

// --- account: favorite places (נקודות ציון), each with its own favorite lots
let me = null, favs = [];
async function api(path, method = "GET", body) {
  const r = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body && JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error), { status: r.status });
  return d;
}
async function loadMe() {
  me = (await api("/api/me").catch(() => ({}))).user ?? null;
  favs = me ? (await api("/api/favorites")).favorites : [];
  $("#meBtn").classList.toggle("on", !!me);
}
const savedPlace = (c) => favs.find((f) => f.lat === c.lat && f.lng === c.lng);
async function addPlace(c, label = c.label) {
  if (!me) return showAccount("התחברו כדי לשמור נקודות ציון.");
  await api("/api/favorites", "POST", { label, lat: c.lat, lng: c.lng });
  await loadMe();
}

// lot details: tick the places this lot is a favorite for
function drawAttach(d) {
  const box = $("#attach");
  box.innerHTML = `<h3>חניון מועדף ליד</h3>` + (!me ? `<button class="save" id="signin">התחברו כדי לשמור חניונים מועדפים</button>`
    : !favs.length ? `<p class="sub">עוד אין לכם נקודות ציון. חפשו מקום ולחצו "שמירה כנקודת ציון".</p>`
    : `<div class="attach">${favs.map((f) => `<label class="chip tog"><input type="checkbox" data-attach="${f.id}"${f.lots.some((l) => l.lot_id === d.id) ? " checked" : ""}><span class="ms">place</span>${esc(f.label)}</label>`).join("")}</div>`);
  box.onclick = (e) => e.target.closest("#signin") && showAccount();
  box.onchange = (e) => {
    const id = e.target.dataset.attach, on = e.target.checked;
    (on ? api(`/api/favorites/${id}/lots`, "POST", { lot_id: d.id }) : api(`/api/favorites/${id}/lots/${encodeURIComponent(d.id)}`, "DELETE"))
      .then(loadMe, () => (e.target.checked = !on));
  };
}

const AUTH_ERR = { 401: "שם משתמש או סיסמה שגויים.", 409: "שם המשתמש הזה תפוס." };
function showAccount(msg = "") {
  state.lot = null; sync(); select(null);
  panel.innerHTML = `<button id="close" class="icon-btn" aria-label="סגירה"><span class="ms">close</span></button>` + (me ? `
    <h2>שלום, ${esc(me.username)}</h2>
    <h3>נקודות הציון שלי</h3>
    ${favs.length ? `<ol class="favs">${favs.map((f, i) => `<li>
      <div class="row">
        <button class="go" data-place="${i}"><span class="ms">place</span>${esc(f.label)}</button>
        <button class="icon-btn" data-rename="${i}" aria-label="${esc(`שינוי השם של ${f.label}`)}" title="שינוי שם"><span class="ms">edit</span></button>
        <button class="icon-btn" data-del="${i}" aria-label="${esc(`מחיקת ${f.label}`)}" title="מחיקה"><span class="ms">delete</span></button>
      </div>
      ${f.lots.length ? `<ul class="lots">${f.lots.map((l) => `<li class="lot">
        <button class="go" data-lot="${esc(l.lot_id)}"><span class="ms">local_parking</span>${esc(l.name)}</button>
        <button class="icon-btn" data-unpin="${i}" data-lot-id="${esc(l.lot_id)}" aria-label="${esc(`הסרת ${l.name} מ${f.label}`)}"><span class="ms">close</span></button></li>`).join("")}</ul>`
        : `<p class="hint">אין עדיין חניונים מועדפים. פתחו חניון וסמנו את "${esc(f.label)}".</p>`}
    </li>`).join("")}</ol>` : `<p class="sub">עוד אין לכם נקודות ציון. הוסיפו כתובת, למשל הבית או העבודה.</p>`}
    <form class="add" id="addPlace">
      <input name="q" required placeholder="כתובת או מקום, למשל דיזנגוף 50" aria-label="הוספת נקודת ציון: כתובת או מקום">
      <button class="btn primary"><span class="ms">add</span>הוספה</button>
    </form>
    <p class="note red" id="err" hidden></p>
    <div class="btns"><button class="btn" id="logout"><span class="ms">logout</span>התנתקות</button></div>` : `
    <h2>החשבון שלי</h2>
    <p class="sub">${esc(msg || "התחברו כדי לשמור נקודות ציון וחניונים מועדפים לכל אחת.")}</p>
    <form class="form" id="auth">
      <label>שם משתמש<input name="username" required minlength="3" maxlength="32" pattern="[\\p{L}\\p{N}_.\\-]+" title="אותיות, ספרות, _ . -" autocomplete="username"></label>
      <label>סיסמה<input name="password" type="password" required minlength="8" maxlength="200" autocomplete="current-password"></label>
      <p class="note red" id="err" hidden></p>
      <div class="btns"><button class="btn primary" value="login">התחברות</button><button class="btn" value="register">הרשמה</button></div>
    </form>`);
  panel.hidden = false; list.hidden = true; panel.dataset.view = "me";
  $("#listBtn").setAttribute("aria-pressed", "false");
  const fail = (text) => Object.assign($("#err"), { hidden: false, textContent: text });
  $("#close").onclick = () => (panel.hidden = true);
  $("#logout")?.addEventListener("click", async () => { await api("/api/auth/logout", "POST"); await loadMe(); showAccount(); });
  $("#auth")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try { await api(`/api/auth/${e.submitter.value}`, "POST", Object.fromEntries(new FormData(e.target))); await loadMe(); showAccount(); }
    catch (err) { fail(AUTH_ERR[err.status] ?? "משהו השתבש. נסו שוב."); }
  });
  $("#addPlace")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim();
    const { candidates = [] } = await api(`/api/places?q=${encodeURIComponent(q)}`).catch(() => ({}));
    if (!candidates.length) return fail("לא נמצא. נסו שם מקום, או רחוב ומספר בית.");
    await addPlace(candidates[0], q); // named as typed; rename any time
    showAccount();
  });
}
panel.addEventListener("click", async (e) => {
  const t = (k) => e.target.closest(`[data-${k}]`)?.dataset;
  const f = (k) => favs[+t(k)[k]];
  if (t("place")) { state.alts = []; const p = f("place"); goTo({ label: p.label, lat: p.lat, lng: p.lng }); }
  if (t("lot")) openLot(t("lot").lot);
  if (t("rename")) {
    const name = prompt("שם חדש לנקודת הציון", f("rename").label)?.trim();
    if (name) { await api(`/api/favorites/${f("rename").id}`, "PATCH", { label: name }); await loadMe(); showAccount(); }
  }
  if (t("del") && confirm(`למחוק את "${f("del").label}" ואת החניונים ששמרתם לידה?`)) { await api(`/api/favorites/${f("del").id}`, "DELETE"); await loadMe(); showAccount(); }
  if (t("unpin")) { await api(`/api/favorites/${f("unpin").id}/lots/${encodeURIComponent(t("unpin").lotId)}`, "DELETE"); await loadMe(); showAccount(); }
});
$("#meBtn").addEventListener("click", () => (panel.hidden || panel.dataset.view !== "me" ? showAccount() : (panel.hidden = true)));

// --- init from URL (deep links from the MCP land here)
showWhen();
$("#dur").value = [...$("#dur").options].some((o) => o.value === state.dur) ? state.dur : ($("#dur").add(new Option(`${state.dur} דק׳`, state.dur)), state.dur);
$("#res").checked = state.res;
$("#zoneChip").hidden = !state.res;
$("#zone").value = state.zone;
$("#bus").checked = state.bus;
$("#cp").checked = state.cp;
load();
loadMe().then(() => state.lot && openLot(state.lot)); // after loadMe: the lot card shows the user's places

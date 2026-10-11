import { Map, Marker, NavigationControl, GeolocateControl } from "https://cdn.jsdelivr.net/npm/maplibre-gl@6.12.0/dist/maplibre-gl.mjs";

const $ = (s) => document.querySelector(s);
const panel = $("#panel"), list = $("#list");
const P = new URL(location.href).searchParams;
const state = { lot: P.get("lot"), when: P.get("when") ?? "", dur: P.get("dur") ?? "120", res: P.get("res") === "1", bus: P.get("bus") === "1", cp: P.get("cp") === "1", center: null, results: [], alts: [] };

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
function preset(k) {
  const now = jlmNow(), today = now - (now % DAY);
  if (k === "now") return "";
  if (k === "tonight") return fmt(Math.max(today + 20 * HOUR, now));
  let t = today + (k === "fri" ? 10 : 14) * HOUR;
  while (new Date(t).getUTCDay() !== (k === "fri" ? 5 : 6) || t < now) t += DAY;
  return fmt(t);
}
const whenText = (s) => { const d = new Date(Date.parse(s + ":00Z")); return `יום ${DAYS[d.getUTCDay()]} ${d.getUTCDate()}/${d.getUTCMonth() + 1}`; };
const endOf = (s, mins) => fmt(Date.parse(s + ":00Z") + mins * 6e4).slice(11);

function qs(extra = {}) {
  const o = { duration: state.dur, ...extra };
  if (state.when) o.start = state.when;
  if (state.res) o.resident = 1;
  const apps = [...(state.bus ? ["pango", "cello"] : []), ...(state.cp ? ["centralpark"] : [])];
  if (apps.length) o.apps = apps.join(",");
  if (state.bus) o.transit = 1;
  return new URLSearchParams(o);
}
function sync() {
  const u = new URLSearchParams();
  for (const [k, v] of [["lot", state.lot], ["when", state.when], ["dur", state.dur !== "120" && state.dur], ["res", state.res && 1], ["bus", state.bus && 1], ["cp", state.cp && 1]]) if (v) u.set(k, v);
  history.replaceState(null, "", u.size ? `?${u}` : location.pathname);
}

// --- map
const map = new Map({ container: "map", style: "https://tiles.openfreemap.org/styles/positron", center: [34.78, 32.075], zoom: 13, attributionControl: { compact: true } });
map.addControl(new NavigationControl(), "bottom-left");
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

async function load() {
  const extra = state.center ? { lat: state.center.lat, lng: state.center.lng, max_walk: 100000 } : {};
  const r = await (await fetch(`/api/search?${qs(extra)}`)).json();
  state.results = r.results ?? [];
  drawPins();
  if (!list.hidden) showList();
  if (state.lot && !panel.hidden) openLot(state.lot, false);
}

function showList() {
  const near = state.center ? state.results.filter((l) => l.distance_m != null && l.distance_m <= 1000) : state.results;
  const head = state.center
    ? `<li class="head">חניונים עד 1 ק״מ מ${esc(state.center.label)}, מהזול ליקר.${state.alts.length ? `<br>התכוונתם ל${state.alts.map((a, i) => `<a href="#" data-alt="${i}">${esc(a.label)}</a>`).join(" או ")}?` : ""}</li>`
    : `<li class="head">כל החניונים, מהזול ליקר. חפשו כתובת כדי לראות מה קרוב אליה.</li>`;
  list.querySelector("ol").innerHTML = head + (near.map((l) => `<li><button data-id="${esc(l.id)}" aria-label="${esc(`${l.name}, ${price(l)}`)}">
    ${plateHtml(l)}
    <span><span class="row-name">${esc(l.name)}</span><span class="row-sub">${esc(OPERATOR[l.operator] ?? l.operator)}</span></span>
    <span class="row-end">${l.distance_m != null ? `${l.distance_m} מ׳` : ""}${liveOf(l) ? `<span class="status ${liveOf(l)}">${LIVE[liveOf(l)]}</span>` : ""}</span>
  </button></li>`).join("") || `<li class="head">אין חניונים ידועים עד 1 ק״מ מכאן. הקטינו את המפה או חפשו כתובת אחרת.</li>`);
  list.hidden = false; panel.hidden = true;
  $("#listBtn").setAttribute("aria-pressed", "true");
}
list.addEventListener("click", (e) => {
  const b = e.target.closest("[data-id]"), a = e.target.closest("[data-alt]");
  if (b) openLot(b.dataset.id);
  if (a) { e.preventDefault(); const pick = state.alts[+a.dataset.alt]; state.alts = [state.center, ...state.alts.filter((x) => x !== pick)]; goTo(pick); }
});

async function openLot(id, fly = true) {
  state.lot = id; sync(); select(id);
  const r = await fetch(`/api/lots/${encodeURIComponent(id)}?${qs()}`);
  if (!r.ok) return;
  const d = await r.json(), q = d.quote;
  const offer = (o) => q.applied_offers.includes(o.id) ? `<p class="note">ההטבה חלה עליכם: ${esc(o.title.he)}</p>`
    : q.potential_offers.includes(o.id) ? `<p class="note">אפשר לחסוך: ${esc(o.title.he)}</p>` : "";
  const restricted = d.sign && !d.sign.free && d.operator === "ahuzot", op = OPERATOR[d.operator] ?? d.operator;
  const dur = $("#dur").selectedOptions[0]?.text ?? `${q.duration_minutes} דק׳`;
  panel.innerHTML = `
    <button id="close" aria-label="סגירה">×</button>
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
      <a class="btn primary" href="${esc(d.links.waze)}" target="_blank" rel="noopener">ניווט ב-Waze</a>
      <a class="btn" href="${esc(d.links.google_maps)}" target="_blank" rel="noopener">Google Maps</a>
      <button class="btn" id="share">העתקת קישור</button>
    </div>
    ${d.tariff_text ? `<h3>התעריף המפורסם</h3><pre>${esc(d.tariff_text)}</pre>` : ""}
    ${d.hours_text ? `<h3>שעות פעילות</h3><p>${esc(d.hours_text)}</p>` : ""}
    ${d.serves ? `<p class="sub">משרת את ${esc(d.serves)}</p>` : ""}
    <p class="fine">המחיר הוא הערכה לפי התעריף שפורסם, והשילוט בחניון קובע. נבדק ב-${esc(d.verified_at)}.
      <a href="${esc(d.source_url)}" target="_blank" rel="noopener">למקור</a>, <a href="${esc(d.links.report)}" target="_blank" rel="noopener">דיווח על מחיר שגוי</a></p>`;
  panel.hidden = false; list.hidden = true;
  $("#listBtn").setAttribute("aria-pressed", "false");
  $("#close").onclick = () => { panel.hidden = true; state.lot = null; sync(); select(null); };
  $("#share").onclick = () => navigator.clipboard.writeText(location.href).then(() => ($("#share").textContent = "הועתק ✓"));
  if (fly) map.easeTo({ center: [d.lng, d.lat], zoom: Math.max(map.getZoom(), 15), padding: sidePad() });
}

// keep the focused point visible beside the sheet (right side on desktop, bottom sheet on mobile)
const sidePad = () => {
  const top = $("#bar").offsetHeight;
  return innerWidth > 700 ? { top, right: 380, left: 0, bottom: 0 } : { top, bottom: innerHeight * 0.62, left: 0, right: 0 };
};

function goTo(c) {
  state.center = c;
  pin?.remove();
  pin = new Marker({ color: "#2e3338" }).setLngLat([c.lng, c.lat]).addTo(map);
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
const presetBtns = document.querySelectorAll("[data-when]");
const markWhen = (k) => presetBtns.forEach((b) => b.setAttribute("aria-pressed", b.dataset.when === k));
presetBtns.forEach((b) => b.addEventListener("click", () => { state.when = preset(b.dataset.when); $("#when").value = state.when; markWhen(b.dataset.when); sync(); load(); }));
$("#when").addEventListener("change", (e) => { state.when = e.target.value; markWhen(state.when ? null : "now"); sync(); load(); });
$("#dur").addEventListener("change", (e) => { state.dur = e.target.value; sync(); load(); });
$("#res").addEventListener("change", (e) => { state.res = e.target.checked; sync(); load(); });
$("#bus").addEventListener("change", (e) => { state.bus = e.target.checked; sync(); load(); });
$("#cp").addEventListener("change", (e) => { state.cp = e.target.checked; sync(); load(); });
$("#listBtn").addEventListener("click", () => (list.hidden ? showList() : ((list.hidden = true), $("#listBtn").setAttribute("aria-pressed", "false"))));
new ResizeObserver(() => document.documentElement.style.setProperty("--bar-h", `${$("#bar").offsetHeight}px`)).observe($("#bar"));

// --- init from URL (deep links from the MCP land here)
$("#when").value = state.when;
markWhen(state.when ? null : "now");
$("#dur").value = [...$("#dur").options].some((o) => o.value === state.dur) ? state.dur : ($("#dur").add(new Option(`${state.dur} דק׳`, state.dur)), state.dur);
$("#res").checked = state.res;
$("#bus").checked = state.bus;
$("#cp").checked = state.cp;
load();
if (state.lot) openLot(state.lot);

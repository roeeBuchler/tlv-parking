import { Map, Marker, NavigationControl, GeolocateControl } from "https://cdn.jsdelivr.net/npm/maplibre-gl@6.12.0/dist/maplibre-gl.mjs";

const $ = (s) => document.querySelector(s);
const panel = $("#panel"), list = $("#list");
const P = new URL(location.href).searchParams;
const state = { lot: P.get("lot"), when: P.get("when") ?? "", dur: P.get("dur") ?? "120", res: P.get("res") === "1", bus: P.get("bus") === "1", cp: P.get("cp") === "1", center: null, results: [], alts: [] };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`); // scraped text: never raw HTML
const LIVE = { free: "פנוי", few: "מעט מקומות", full: "מלא", closed: "סגור", open: "פתוח (אין נתון תפוסה)" };
const KIND = { flat: "כניסה חד-פעמית", per_minute: "לפי דקה", step: "לפי שעה" };
const DAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
const OPERATOR = { ahuzot: "אחוזות החוף", centralpark: "סנטרל פארק", green: "גרין פרקינג" };
const ils = (n) => (n == null ? "לפי השילוט" : n === 0 ? "חינם" : `₪${+n.toFixed(2)}`);
const price = (q) => (q.price_basis === "municipal_data_unverified" ? "חינם?" : ils(q.price_ils));

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
const whenText = (s) => { const d = new Date(Date.parse(s + ":00Z")); return `יום ${DAYS[d.getUTCDay()]} ${d.getUTCDate()}/${d.getUTCMonth() + 1} ${s.slice(11)}`; };

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
let pin;
const ready = new Promise((r) => map.on("load", r));

ready.then(() => {
  map.addSource("lots", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "lots", type: "circle", source: "lots", paint: {
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 5, 16, 12],
    "circle-color": ["case", ["get", "unv"], "#66c2a5", ["step", ["get", "price"], "#9e9e9e", 0, "#1a9850", 20.01, "#a6d96a", 40.01, "#fdae61", 80.01, "#d73027"]],
    "circle-stroke-width": 3,
    "circle-stroke-color": ["match", ["get", "live"], "free", "#1a9850", "few", "#f39c12", "full", "#d73027", "closed", "#000000", "#ffffff"],
    "circle-opacity": ["case", ["get", "ok"], 1, 0.35],
  } });
  map.addLayer({ id: "prices", type: "symbol", source: "lots", minzoom: 14, layout: {
    "text-field": ["get", "label"], "text-size": 12, "text-offset": [0, 1.5], "text-font": ["Noto Sans Bold"],
  }, paint: { "text-halo-color": "#fff", "text-halo-width": 1.5 } });
  map.on("click", "lots", (e) => openLot(e.features[0].properties.id));
  map.on("mouseenter", "lots", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "lots", () => (map.getCanvas().style.cursor = ""));
});

async function load() {
  const extra = state.center ? { lat: state.center.lat, lng: state.center.lng, max_walk: 100000 } : {};
  const r = await (await fetch(`/api/search?${qs(extra)}`)).json();
  state.results = r.results ?? [];
  await ready;
  map.getSource("lots").setData({ type: "FeatureCollection", features: state.results.map((l) => ({
    type: "Feature", geometry: { type: "Point", coordinates: [l.lng, l.lat] },
    properties: { id: l.id, price: l.price_ils ?? -1, unv: l.price_basis === "municipal_data_unverified", ok: l.open_whole_stay,
      label: l.price_ils == null ? "?" : l.price_basis === "municipal_data_unverified" ? "חינם?" : `${+l.price_ils.toFixed(2)} ₪`, live: l.live?.status ?? "" },
  })) });
  if (!list.hidden) showList();
  if (state.lot && !panel.hidden) openLot(state.lot, false);
}

function showList() {
  const near = state.center ? state.results.filter((l) => l.distance_m != null && l.distance_m <= 1000) : state.results;
  const head = state.center
    ? `<li class="muted" style="padding:10px 14px">ליד ${esc(state.center.label)} (עד 1 ק״מ)${state.alts.length ? ` · התכוונתם ל: ${state.alts.map((a, i) => `<a href="#" data-alt="${i}">${esc(a.label)}</a>`).join(", ")}` : ""}</li>`
    : `<li class="muted" style="padding:10px 14px">כל החניונים, לפי מחיר. חפשו מקום כדי לראות מה קרוב.</li>`;
  list.querySelector("ol").innerHTML = head + near.map((l) => `<li><button data-id="${esc(l.id)}">
    <span>${esc(l.name)}<br><span class="muted">${[l.distance_m != null && `${l.distance_m} מ׳`, OPERATOR[l.operator], l.live && LIVE[l.live.status]].filter(Boolean).join(" · ")}</span></span>
    <span class="price">${price(l)}</span></button></li>`).join("") || `<li class="muted" style="padding:14px">אין חניונים ידועים בטווח.</li>`;
  list.hidden = false; panel.hidden = true;
  $("#listBtn").setAttribute("aria-pressed", "true");
}
list.addEventListener("click", (e) => {
  const b = e.target.closest("[data-id]"), a = e.target.closest("[data-alt]");
  if (b) openLot(b.dataset.id);
  if (a) { e.preventDefault(); const pick = state.alts[+a.dataset.alt]; state.alts = [state.center, ...state.alts.filter((x) => x !== pick)]; goTo(pick); }
});

async function openLot(id, fly = true) {
  state.lot = id; sync();
  const r = await fetch(`/api/lots/${encodeURIComponent(id)}?${qs()}`);
  if (!r.ok) return;
  const d = await r.json(), q = d.quote;
  const offer = (o) => q.applied_offers.includes(o.id) ? `<div class="deal">✓ הטבה פעילה: ${esc(o.title.he)}</div>`
    : q.potential_offers.includes(o.id) ? `<div class="deal">אפשר לחסוך: ${esc(o.title.he)}</div>` : "";
  panel.innerHTML = `
    <button id="close" aria-label="סגירה">×</button>
    <h2>${esc(d.name)}</h2>
    <div class="muted">${esc(d.address)} · ${esc(OPERATOR[d.operator] ?? d.operator)}${d.spaces ? ` · ${d.spaces} מקומות` : ""}</div>
    ${d.live ? `<p><span class="pill ${esc(d.live.status)}">${LIVE[d.live.status] ?? "?"}</span> <span class="muted">עודכן ${esc(d.live.updated.slice(11))}</span></p>` : ""}
    <div class="big">${price(q)}</div>
    ${q.app_price_ils != null ? `<div class="muted">בקופה ${ils(q.gate_price_ils)} · באפליקציית סנטרל פארק ${ils(q.app_price_ils)}</div>` : ""}
    ${d.sign ? `<div class="warn">${esc(d.sign.he)}</div>` : ""}
    <div class="muted">${whenText(q.start)} · ${q.duration_minutes / 60} שע׳${state.res ? " · כולל הטבת תושב/ת" : ""}</div>
    ${q.breakdown.length > 1 ? q.breakdown.map((b) => `<div class="muted">${b.from.slice(11)}–${b.to.slice(11)} ${KIND[b.kind]}: ₪${b.price}</div>`).join("") : q.breakdown.map((b) => `<div class="muted">${KIND[b.kind]}</div>`).join("")}
    ${!q.can_enter ? `<div class="warn">אין כניסה לחניון בשעה הזו.</div>` : !q.open_whole_stay ? `<div class="warn">החניון סגור בחלק מזמן החניה, וייתכן שלא תוכלו לצאת.</div>` : ""}
    ${d.offers.map(offer).join("")}
    <div class="links">
      <a href="${esc(d.links.waze)}" target="_blank" rel="noopener">Waze</a>
      <a href="${esc(d.links.google_maps)}" target="_blank" rel="noopener">Google Maps</a>
      <button id="share">העתקת קישור</button>
    </div>
    <h3>תעריף</h3><pre>${esc(d.tariff_text)}</pre>
    ${d.hours_text ? `<h3>שעות פעילות</h3><p>${esc(d.hours_text)}</p>` : ""}
    ${d.serves ? `<p class="muted">משרת: ${esc(d.serves)}</p>` : ""}
    <p class="muted">המחיר הוא הערכה לפי התעריף שפורסם; השילוט בחניון קובע. נבדק ב-${esc(d.verified_at)} ·
      <a href="${esc(d.source_url)}" target="_blank" rel="noopener">מקור</a> ·
      <a href="${esc(d.links.report)}" target="_blank" rel="noopener">דיווח על מחיר שגוי</a></p>`;
  panel.hidden = false; list.hidden = true;
  $("#listBtn").setAttribute("aria-pressed", "false");
  $("#close").onclick = () => { panel.hidden = true; state.lot = null; sync(); };
  $("#share").onclick = () => navigator.clipboard.writeText(location.href).then(() => ($("#share").textContent = "הועתק ✓"));
  if (fly) map.easeTo({ center: [d.lng, d.lat], zoom: Math.max(map.getZoom(), 15), padding: sidePad() });
}

// keep the focused point visible beside the panel (left on desktop, bottom sheet on mobile)
const sidePad = () => {
  const top = $("#bar").offsetHeight;
  return innerWidth > 700 ? { top, left: 400, right: 0, bottom: 0 } : { top, bottom: innerHeight * 0.62, left: 0, right: 0 };
};

function goTo(c) {
  state.center = c;
  pin?.remove();
  pin = new Marker({ color: "#0b63ce" }).setLngLat([c.lng, c.lat]).addTo(map);
  showList();
  map.flyTo({ center: [c.lng, c.lat], zoom: 15, padding: innerWidth > 700 ? { ...sidePad(), left: 0, right: 400 } : sidePad() });
  load();
}

// --- controls
$("#search").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#q").value.trim();
  if (!q) return;
  const { candidates = [] } = await (await fetch(`/api/places?q=${encodeURIComponent(q)}`)).json();
  if (!candidates.length) { $("#q").setCustomValidity("לא נמצא. נסו שם רחוב ומספר בית."); $("#q").reportValidity(); return; }
  state.alts = candidates.slice(1);
  goTo(candidates[0]);
});
$("#q").addEventListener("input", () => $("#q").setCustomValidity(""));
document.querySelectorAll("[data-when]").forEach((b) => b.addEventListener("click", () => { state.when = preset(b.dataset.when); $("#when").value = state.when; sync(); load(); }));
$("#when").addEventListener("change", (e) => { state.when = e.target.value; sync(); load(); });
$("#dur").addEventListener("change", (e) => { state.dur = e.target.value; sync(); load(); });
$("#res").addEventListener("change", (e) => { state.res = e.target.checked; sync(); load(); });
$("#bus").addEventListener("change", (e) => { state.bus = e.target.checked; sync(); load(); });
$("#cp").addEventListener("change", (e) => { state.cp = e.target.checked; sync(); load(); });
$("#listBtn").addEventListener("click", () => (list.hidden ? showList() : ((list.hidden = true), $("#listBtn").setAttribute("aria-pressed", "false"))));
new ResizeObserver(() => document.documentElement.style.setProperty("--bar-h", `${$("#bar").offsetHeight}px`)).observe($("#bar"));

// --- init from URL (deep links from the MCP land here)
$("#when").value = state.when;
$("#dur").value = [...$("#dur").options].some((o) => o.value === state.dur) ? state.dur : ($("#dur").add(new Option(`${state.dur} דק׳`, state.dur)), state.dur);
$("#res").checked = state.res;
$("#bus").checked = state.bus;
$("#cp").checked = state.cp;
load();
if (state.lot) openLot(state.lot);

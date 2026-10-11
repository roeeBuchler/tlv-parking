import { Map, Marker, Popup, NavigationControl, GeolocateControl } from "https://cdn.jsdelivr.net/npm/maplibre-gl@6.12.0/dist/maplibre-gl.mjs";

const $ = (s) => document.querySelector(s);
const EN = document.documentElement.lang === "en"; // set by the inline script in index.html before first paint
const L = (he, en) => (EN ? en : he);
const LANG = EN ? "en" : "he";
// static markup carries its English next to the Hebrew: data-en (text), data-en-aria-label / -title / -placeholder
if (EN) {
  document.title = "Tel Aviv parking";
  $("meta[name=description]").content = "Map of Tel Aviv-Yafo parking lots (Ahuzot HaHof, Central Park, Green Parking) with an estimated price for your day and time, live availability and offers.";
  document.querySelectorAll("[data-en]").forEach((e) => (e.textContent = e.dataset.en));
  for (const a of ["aria-label", "title", "placeholder"]) document.querySelectorAll(`[data-en-${a}]`).forEach((e) => e.setAttribute(a, e.getAttribute(`data-en-${a}`)));
}
const panel = $("#panel"), list = $("#list");
const P = new URL(location.href).searchParams;
const state = { lot: P.get("lot"), when: P.get("when") ?? "", dur: P.get("dur") ?? "120", res: P.get("res") === "1", bus: P.get("bus") === "1", cp: P.get("cp") === "1", zone: P.get("zone") ?? "",
  ev: P.get("ev") === "1", cov: P.get("cov") === "1", acc: P.get("acc") === "1", h: P.get("h") ?? "", moto: P.get("moto") === "1", center: null, results: [], street: null, alts: [] };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`); // scraped text: never raw HTML
const LIVE = { free: L("פנוי", "Free"), few: L("מעט מקומות", "Few spaces"), full: L("מלא", "Full"), closed: L("סגור", "Closed") }; // "open" / "unknown" carry no occupancy
const liveOf = (l) => (l.live && LIVE[l.live.status] ? l.live.status : null);
const KIND = { flat: L("כניסה חד-פעמית", "flat entry"), per_minute: L("לפי דקה", "per minute"), step: L("לפי שעה", "hourly") };
const DAYS = L(["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"], ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]);
const OPERATOR = EN ? { ahuzot: "Ahuzot HaHof", centralpark: "Central Park", green: "Green Parking", "dizengoff-center": "Dizengoff Center", sarona: "Sarona (Gindi) lot",
  azrieli: "Azrieli", registry: "Municipal business-license registry", osm: "OpenStreetMap" }
  : { ahuzot: "אחוזות החוף", centralpark: "סנטרל פארק", green: "גרין פרקינג", "dizengoff-center": "דיזנגוף סנטר", sarona: "חניון שרונה (גינדי)",
  azrieli: "עזריאלי", registry: "מרשם רישוי העסקים של העירייה", osm: "OpenStreetMap" };
const ils = (n) => (n == null ? L("לפי השילוט", "Per sign") : n === 0 ? L("חינם", "Free") : `₪${+n.toFixed(2)}`);
const price = (q) => (q.price_basis === "municipal_data_unverified" ? L("חינם?", "Free?") : ils(q.price_ils));
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
const whenText = (s) => { const d = new Date(Date.parse(s + ":00Z")); return `${L("יום ", "")}${DAYS[d.getUTCDay()]} ${d.getUTCDate()}/${d.getUTCMonth() + 1}`; };
const endOf = (s, mins) => fmt(Date.parse(s + ":00Z") + mins * 6e4).slice(11);

function qs(extra = {}) {
  const o = { duration: state.dur, ...extra };
  if (state.when) o.start = state.when;
  if (state.res) o.resident = 1;
  if (state.res && state.zone) o.zone = state.zone;
  const apps = [...(state.bus ? ["pango", "cello"] : []), ...(state.cp ? ["centralpark"] : [])];
  if (apps.length) o.apps = apps.join(",");
  if (state.bus) o.transit = 1;
  if (state.ev) o.ev = 1;
  if (state.cov) o.covered = 1;
  if (state.acc) o.accessible = 1;
  if (state.h) o.height = state.h;
  return new URLSearchParams(o);
}
function sync() {
  const u = new URLSearchParams();
  for (const [k, v] of [["lot", state.lot], ["when", state.when], ["dur", state.dur !== "120" && state.dur], ["res", state.res && 1], ["zone", state.res && state.zone], ["bus", state.bus && 1], ["cp", state.cp && 1],
    ["ev", state.ev && 1], ["cov", state.cov && 1], ["acc", state.acc && 1], ["h", state.h], ["moto", state.moto && 1], ["lang", EN && "en"]]) if (v) u.set(k, v);
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
const corner = EN ? "bottom-right" : "bottom-left"; // opposite the side card
map.addControl(new NavigationControl({ showCompass: false }), corner);
const geo = new GeolocateControl({ positionOptions: { enableHighAccuracy: true } });
map.addControl(geo, corner);
geo.on("geolocate", (e) => { state.center = { lat: e.coords.latitude, lng: e.coords.longitude, label: L("המיקום שלי", "My location") }; state.alts = []; load().then(showList); });
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
    ? `<li class="head">${L(`חניונים עד 1 ק״מ מ${esc(state.center.label)}, מהזול ליקר.`, `Lots within 1 km of ${esc(state.center.label)}, cheapest first.`)}<br>${savedPlace(state.center)
      ? `<span class="save"><span class="ms">place</span>${L("שמור בנקודות הציון שלך", "Saved to your places")}</span>` : `<button class="save" id="savePlace"><span class="ms">add</span>${L("שמירה כנקודת ציון", "Save as a place")}</button>`}${state.alts.length ? `<br>${L("התכוונתם ל", "Did you mean ")}${state.alts.map((a, i) => `<a href="#" data-alt="${i}">${esc(a.label)}</a>`).join(L(" או ", " or "))}?` : ""}</li>`
    : `<li class="head">${L("כל החניונים, מהזול ליקר. חפשו כתובת כדי לראות מה קרוב אליה.", "All lots, cheapest first. Search an address to see what is near it.")}</li>`;
  list.querySelector("ol").innerHTML = head + (state.center && state.street ? streetRow(state.street) : "") + (near.map((l) => `<li><button data-id="${esc(l.id)}" aria-label="${esc(`${l.name}, ${price(l)}`)}">
    ${plateHtml(l)}
    <span><span class="row-name">${esc(l.name)}</span><span class="row-sub">${esc(OPERATOR[l.operator] ?? l.operator)}</span></span>
    <span class="row-end">${l.distance_m != null ? `${l.distance_m} ${L("מ׳", "m")}` : ""}${liveOf(l) ? `<span class="status ${liveOf(l)}">${LIVE[liveOf(l)]}</span>` : ""}</span>
  </button></li>`).join("") || `<li class="head">${L("אין חניונים ידועים עד 1 ק״מ מכאן. הקטינו את המפה או חפשו כתובת אחרת.", "No known lots within 1 km. Zoom out or search another address.")}</li>`);
  list.hidden = false; panel.hidden = true;
  $("#listBtn").setAttribute("aria-pressed", "true");
}
// blue-white parking at the searched point (src/street.ts): price for the stay and a rough chance of finding a spot
const AREA = { center: L("מרכז העיר", "city center"), city: L("רחבי העיר", "rest of the city") };
const streetRow = (s) => `<li class="street">
  <span class="plate bw" dir="ltr">${esc(ils(s.price_ils))}</span>
  <span><span class="row-name">${L("חניה ברחוב, כחול-לבן", "Street parking, blue-white")}</span><span class="row-sub">${L("אזור", "Zone")} ${esc(s.zone)}, ${AREA[s.area]}${s.permit === "own_zone" ? L(", חינם עם התו שלך", ", free with your permit")
    : s.paid_minutes ? L(`, ₪${esc(s.rate_ils_per_hour)} לשעה`, `, ₪${esc(s.rate_ils_per_hour)} per hour`) : L(", ללא תשלום בשעות האלה", ", no charge at these hours")}</span></span>
  <span class="row-end"><span class="status ${s.chance_pct >= 50 ? "free" : s.chance_pct >= 25 ? "few" : "full"}">${L("סיכוי", "Chance")} ~${esc(s.chance_pct)}%</span>${L("הערכה", "estimate")}</span>
  <details><summary>${L("איך זה מחושב", "How this is estimated")}</summary>
    <p>${L(`הסיכוי למצוא מקום הוא הערכה לפי היום והשעה${s.live_lots ? `, ולפי התפוסה עכשיו ב-${esc(s.live_lots)} חניוני אחוזות החוף הקרובים` : ""}. זה לא נתון חי מהרחוב.`,
      `The chance of finding a spot is an estimate from the day and time${s.live_lots ? `, and from how full the ${esc(s.live_lots)} nearest Ahuzot HaHof lots are right now` : ""}. It is not live street data.`)}</p>
    ${s.permit === "other_zone" ? `<p>${L("בעלי תו מאזור אחר: שעתיים ביום חינם, ואחריהן 30% הנחה.", "Permit holders from another zone: 2 free hours a day, then 30% off.")}${state.zone ? "" : L(" בחרו את אזור התו שלכם כדי לראות אם החניה כאן חינם.", " Pick your permit zone to see whether parking here is free for you.")}</p>` : ""}
    <p>${L("משלמים בפנגו או בסלו מהדקה הראשונה. חלק מרחובות הכחול-לבן מיועדים לבעלי תו האזור בלבד, והתמרור בתחילת הרחוב קובע.", "Pay with Pango or Cello from the first minute. Some blue-white streets are for zone permit holders only; the sign at the start of the street decides.")}</p>
  </details>
</li>`;
list.addEventListener("click", (e) => {
  const b = e.target.closest("[data-id]"), a = e.target.closest("[data-alt]");
  if (b) openLot(b.dataset.id);
  if (e.target.closest("#savePlace")) addPlace(state.center).then(() => me && showList());
  if (a) { e.preventDefault(); const pick = state.alts[+a.dataset.alt]; state.alts = [state.center, ...state.alts.filter((x) => x !== pick)]; goTo(pick); }
});

// published facts only; a missing field means unknown, so nothing is said about it
function features(d) {
  const f = [d.ev_chargers && `${L("עמדות טעינה לרכב חשמלי: ", "EV charging stations: ")}${d.ev_chargers}`, d.height_m && `${L("הגבלת גובה: ", "Height limit: ")}${d.height_m} ${L("מ׳", "m")}`,
    d.covered && L("חניון מקורה", "Covered lot"), d.accessible && L("מונגש לנכים", "Wheelchair accessible")].filter(Boolean);
  return f.length ? `<div class="facts">${f.map((x) => `<p>${esc(x)}</p>`).join("")}</div>` : "";
}

// street motorcycle bays (city GIS layer 951, public/moto.json): a map layer, not lots
let moto;
async function drawMoto() {
  if (state.moto && !moto) moto = await (await fetch("/moto.json")).json().catch(() => ((state.moto = $("#moto").checked = false), undefined));
  const on = () => {
    if (map.getLayer("moto")) return map.setLayoutProperty("moto", "visibility", state.moto ? "visible" : "none");
    if (!state.moto || !moto) return;
    map.addSource("moto", { type: "geojson", data: { type: "FeatureCollection", features: moto.map((b) => ({ type: "Feature", properties: b, geometry: { type: "Point", coordinates: [b.lng, b.lat] } })) } });
    map.addLayer({ id: "moto", type: "circle", source: "moto", paint: { "circle-color": "#7b1fa2", "circle-stroke-color": "#fff", "circle-stroke-width": 1.5,
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 3, 17, 9] } });
    map.on("click", "moto", (e) => {
      const p = e.features[0].properties;
      new Popup().setLngLat(e.lngLat).setHTML(`<b>${L("חניית אופנועים", "Motorcycle parking")}</b><br>${esc(p.address)}${p.spaces ? `<br>${esc(p.spaces)} ${L("מקומות", "spaces")}` : ""}<br>${L("חינם, ברחוב", "Free, on the street")}`).addTo(map);
    });
    map.on("mouseenter", "moto", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "moto", () => (map.getCanvas().style.cursor = ""));
  };
  map.isStyleLoaded() ? on() : map.once("load", on);
}

async function openLot(id, fly = true) {
  state.lot = id; sync(); select(id);
  const r = await fetch(`/api/lots/${encodeURIComponent(id)}?${qs()}`);
  if (!r.ok) return;
  const d = await r.json(), q = d.quote;
  const offer = (o) => q.applied_offers.includes(o.id) ? `<p class="note green">${L("ההטבה חלה עליכם: ", "This offer applies to you: ")}${esc(o.title[LANG])}</p>`
    : q.potential_offers.includes(o.id) ? `<p class="note yellow">${L("אפשר לחסוך: ", "You could save: ")}${esc(o.title[LANG])}</p>` : "";
  const restricted = d.sign && !d.sign.free && d.operator === "ahuzot", op = OPERATOR[d.operator] ?? d.operator;
  const dur = $("#dur").selectedOptions[0]?.text ?? `${q.duration_minutes} ${L("דק׳", "min")}`;
  panel.innerHTML = `
    <button id="close" class="icon-btn" aria-label="${L("סגירה", "Close")}"><span class="ms">close</span></button>
    <h2>${esc(d.name)}</h2>
    <p class="sub">${esc(d.address)}<br>${esc(op)}${d.spaces ? `, ${d.spaces} ${L("מקומות", "spaces")}` : ""}</p>
    <div class="board ${tier(q)}">
      ${q.price_ils == null ? `<div class="board-price small">${L("לפי השילוט", "Per the sign")}</div>` : `<div class="board-price" dir="ltr">${esc(price(q))}</div>`}
      <div class="board-when">${whenText(q.start)}, <span dir="ltr">${q.start.slice(11)}–${endOf(q.start, q.duration_minutes)}</span> (${esc(dur)})${state.res ? `<br>${L("כולל הנחת תושב/ת ת״א", "Includes Tel Aviv resident discount")}` : ""}</div>
    </div>
    ${q.app_price_ils != null ? `<div class="split"><div class="${state.cp ? "" : "on"}">${L("בקופה", "At the gate")}<b dir="ltr">${ils(q.gate_price_ils)}</b></div><div class="${state.cp ? "on" : ""}">${L(`באפליקציית ${esc(op)}`, `In the ${esc(op)} app`)}<b dir="ltr">${ils(q.app_price_ils)}</b></div></div>` : ""}
    <div class="facts">
      ${liveOf(d) ? `<p><span class="status ${liveOf(d)}" style="display:inline">${LIVE[liveOf(d)]}</span> ${L("עכשיו, עודכן ב-", "now, updated at ")}${esc(d.live.updated.slice(11))}${d.live.source === "crowd" ? L(" (דווח על ידי נהגים)", " (reported by drivers)") : ""}</p>` : ""}
      ${q.breakdown.length > 1 ? q.breakdown.map((b) => `<p>${b.from.slice(11)}–${b.to.slice(11)}: ${KIND[b.kind]}, ₪${b.price}</p>`).join("") : q.breakdown.map((b) => `<p>${L("תשלום ", "Billing: ")}${KIND[b.kind]}</p>`).join("")}
    </div>
    ${features(d)}
    ${d.sign ? `<p class="note${restricted ? " red" : ""}">${esc(d.sign[LANG])}</p>` : ""}
    ${!q.can_enter ? `<p class="note red">${L("אין כניסה לחניון בשעה הזו.", "No entry to the lot at this time.")}</p>` : !q.open_whole_stay ? `<p class="note red">${L("החניון סגור בחלק מזמן החניה, וייתכן שלא תוכלו לצאת.", "The lot is closed for part of your stay, and you may not be able to leave.")}</p>` : ""}
    ${d.offers.map(offer).join("")}
    <div class="actions">
      <a class="act primary" href="${esc(d.links.waze)}" target="_blank" rel="noopener"><span class="ms">directions</span>${L("ניווט ב-Waze", "Navigate with Waze")}</a>
      <a class="act" href="${esc(d.links.google_maps)}" target="_blank" rel="noopener"><span class="ms">map</span>Google Maps</a>
      <button class="act" id="share"><span class="ms">link</span><span>${L("העתקת קישור", "Copy link")}</span></button>
    </div>
    <div id="attach"></div>
    <div id="report"></div>
    ${d.tariffs ? `<h3>${L("תעריף", "Tariff")}</h3>${tariffTable(d.tariffs, d.app_tariffs)}
      ${d.grace_minutes ? `<p class="tariff-note">${L(`עד ${d.grace_minutes} דקות בחניון: חינם`, `Free for up to ${d.grace_minutes} minutes`)}</p>` : ""}
      ${d.resident_discount_pct ? `<p class="tariff-note">${d.resident_discount_pct}% ${L("הנחה לתושבי תל אביב-יפו", "discount for Tel Aviv-Yafo residents")}</p>` : ""}
      ${d.resident_tariffs ? `<h3>${L("לתושבי תל אביב-יפו", "For Tel Aviv-Yafo residents")}</h3>${tariffTable(d.resident_tariffs)}` : ""}
      ${d.tariff_text ? `<details><summary>${L("הנוסח המפורסם", "Published text (Hebrew)")}</summary><pre>${esc(d.tariff_text)}</pre></details>` : ""}`
    : d.tariff_text ? `<h3>${L("התעריף המפורסם", "Published tariff (Hebrew)")}</h3><pre>${esc(d.tariff_text)}</pre>` : ""}
    ${d.hours_text ? `<h3>${L("שעות פעילות", "Opening hours (Hebrew)")}</h3><p>${esc(d.hours_text)}</p>` : ""}
    ${d.serves ? `<p class="sub">${L("משרת את ", "Serves: ")}${esc(d.serves)}</p>` : ""}
    <p class="fine">${L("המחיר הוא הערכה לפי התעריף שפורסם, והשילוט בחניון קובע. נבדק ב-", "The price is an estimate from the published tariff; the sign at the lot is what counts. Checked ")}${esc(d.verified_at)}.
      <a href="${esc(d.source_url)}" target="_blank" rel="noopener">${L("למקור", "Source")}</a>, <a href="${esc(d.links.report)}" target="_blank" rel="noopener">${L("טעות אחרת?", "Something else wrong?")}</a></p>`;
  panel.hidden = false; list.hidden = true; panel.dataset.view = "lot";
  $("#listBtn").setAttribute("aria-pressed", "false");
  drawAttach(d);
  drawReport(d, q);
  $("#close").onclick = () => { panel.hidden = true; state.lot = null; sync(); select(null); };
  $("#share").onclick = () => navigator.clipboard.writeText(location.href).then(() => ($("#share span:last-child").textContent = L("הועתק ✓", "Copied ✓")));
  if (fly) map.easeTo({ center: [d.lng, d.lat], zoom: Math.max(map.getZoom(), 15), padding: sidePad() });
}

// a lot's rules (same shape as src/engine.ts Rule) as a day ▸ hours ▸ price table; app[i] is the app price of rules[i]
const DAYKEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat", "holiday_eve", "holiday"];
function daysText(ds) {
  const w = ds.map((x) => DAYKEYS.indexOf(x)).filter((i) => i < 7);
  if (w.length === 7) return L("כל יום", "Every day");
  const wk = !w.length ? "" : w.length === 1 ? L(`יום ${DAYS[w[0]]}`, DAYS[w[0]]) : w.every((x, i) => !i || x === w[i - 1] + 1)
    ? L(`${DAYS[w[0]]} ${w.length === 2 ? "ו" : "עד "}${DAYS[w.at(-1)]}`, `${DAYS[w[0]]}${w.length === 2 ? " & " : " – "}${DAYS[w.at(-1)]}`) : w.map((i) => DAYS[i]).join(", ");
  const eve = ds.includes("holiday_eve"), hol = ds.includes("holiday");
  return [wk, eve && hol ? L("ערבי חג וחגים", "Holiday eves & holidays") : eve ? L("ערבי חג", "Holiday eves") : hol ? L("חגים", "Holidays") : ""].filter(Boolean).join(", ");
}
const STEP_TEXT = { 15: L("כל רבע שעה נוספת", "Each extra 15 min"), 30: L("כל חצי שעה נוספת", "Each extra 30 min"), 60: L("כל שעה נוספת", "Each extra hour") };
// [label, ₪] rows; app rules share the shape, so their rows zip by index
const ruleRows = (r) => [
  ...(r.kind === "flat" ? [[L(`כניסה חד פעמית${r.valid_hours ? `, תקף ${r.valid_hours} שעות` : r.valid_until ? `, תקף עד ${r.valid_until}` : ""}`,
      `Flat entry${r.valid_hours ? `, valid ${r.valid_hours} hours` : r.valid_until ? `, valid until ${r.valid_until}` : ""}`), r.price]]
    : r.kind === "step" ? [[L("שעה ראשונה", "First hour"), r.first_hour], [STEP_TEXT[r.step_minutes] ?? L(`כל ${r.step_minutes} דק׳ נוספות`, `Each extra ${r.step_minutes} min`), r.step_price]]
    : r.tiers?.length ? [...r.tiers.map(([upTo, rate], i) => [L(`לשעה, דקות ${i ? r.tiers[i - 1][0] + 1 : 1}–${upTo}`, `Per hour, minutes ${i ? r.tiers[i - 1][0] + 1 : 1}–${upTo}`), rate]), [L(`לשעה, מהדקה ה-${r.tiers.at(-1)[0] + 1}`, `Per hour, from minute ${r.tiers.at(-1)[0] + 1}`), r.rate]]
    : [[L("לשעה (חיוב לפי דקה)", "Per hour (billed per minute)"), r.rate]]),
  ...(r.daily_max != null ? [[L("מקסימום ליום", "Daily maximum"), r.daily_max]] : []),
];
function tariffTable(rules, app) {
  const groups = {};
  rules.forEach((r, i) => (groups[r.days.join()] ??= []).push([r, app?.[i]]));
  return Object.values(groups).sort((a, b) => DAYKEYS.indexOf(a[0][0].days[0]) - DAYKEYS.indexOf(b[0][0].days[0])).map((items) => {
    items.sort(([a], [b]) => a.from.localeCompare(b.from));
    const allDay = items.length === 1 && items[0][0].from === items[0][0].to; // nothing to split by hour
    return `<table class="tariff"><caption>${daysText(items[0][0].days)}</caption>
    ${app ? `<thead><tr><th scope="col"><span class="sr">${L("פריט", "Item")}</span></th><th scope="col">${L("מחיר מלא", "Full price")}</th><th scope="col">${L("באפליקציה", "In the app")}</th></tr></thead>` : ""}
    ${items.map(([r, a]) => { const ar = a && ruleRows(a); return `<tbody>${allDay ? "" : `<tr><th colspan="3" scope="rowgroup" dir="ltr">${r.from === r.to ? L("כל היום", "All day") : `${r.from}–${r.to}`}</th></tr>`}
      ${ruleRows(r).map(([t, p], i) => `<tr><td>${t}</td><td>${ils(p)}</td>${ar ? `<td class="app">${ils(ar[i]?.[1])}</td>` : ""}</tr>`).join("")}</tbody>`; }).join("")}
  </table>`;
  }).join("");
}

// keep the focused point visible beside the sheet (right side on desktop, bottom sheet on mobile)
const sidePad = () => {
  const top = $("#bar").offsetHeight;
  return innerWidth > 700 ? { top, [EN ? "left" : "right"]: 424, bottom: 0 } : { top, bottom: innerHeight * 0.62, left: 0, right: 0 };
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
  if (!candidates.length) { $("#q").setCustomValidity(error ? L("שירות החיפוש לא זמין כרגע. נסו שוב בעוד רגע.", "Search is unavailable right now. Try again in a moment.") : L("לא נמצא. נסו שם מקום, או רחוב ומספר בית.", "Not found. Try a place name, or a street and house number.")); $("#q").reportValidity(); return; }
  state.alts = candidates.slice(1);
  goTo(candidates[0]);
});
$("#q").addEventListener("input", () => $("#q").setCustomValidity(""));
// when: "" = now, else Jerusalem wall clock "YYYY-MM-DDTHH:MM"
const STEP = 15 * 6e4;
const dateFmt = new Intl.DateTimeFormat(L("he-IL", "en-GB"), { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
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
for (const k of ["ev", "cov", "acc"]) $("#" + k).addEventListener("change", (e) => { state[k] = e.target.checked; sync(); load(); });
$("#h").addEventListener("change", (e) => { state.h = e.target.value; sync(); load(); });
$("#moto").addEventListener("change", (e) => { state.moto = e.target.checked; sync(); drawMoto(); });
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
  if (!me) return showAccount(L("התחברו כדי לשמור נקודות ציון.", "Sign in to save places."));
  await api("/api/favorites", "POST", { label, lat: c.lat, lng: c.lng });
  await loadMe();
}

// crowd reports: occupancy buttons (shown as the live status for 30 min) and "what I paid" (listed beside the tariff, never changes the price)
const REPORT_ERR = { 429: L("הגעתם למגבלת הדיווחים היומית.", "You've reached the daily report limit."), 400: L("הנתונים לא תקינים. בדקו את המחיר והשעה.", "Invalid data. Check the price and time.") };
const SIGN_IN_TO_REPORT = () => L("התחברו כדי לדווח.", "Sign in to report.");
function drawReport(d, q) {
  const box = $("#report"), c = d.crowd_prices, now = fmt(jlmNow());
  const paid = (r) => `<p>₪${+r.price.toFixed(2)}, ${r.minutes >= 120 ? `${+(r.minutes / 60).toFixed(1)} ${L("שעות", "h")}` : `${r.minutes} ${L("דק׳", "min")}`}, ${whenText(r.entered_at)}${r.resident ? L(", תושב/ת", ", resident") : ""}</p>`;
  box.innerHTML = `<h3>${L("דיווחי נהגים", "Driver reports")}</h3>
    ${c?.recent.length ? `<div class="facts"><p class="sub">${L("מה נהגים כתבו ששילמו:", "What drivers say they paid:")}</p>${c.recent.map(paid).join("")}</div>` : ""}
    ${c?.mismatches >= 2 ? `<p class="note yellow">${L(`${c.mismatches} דיווחים בחודש האחרון שונים מהמחיר שמוצג. בדקו את השילוט.`, `${c.mismatches} reports in the last month differ from the price shown. Check the sign.`)}</p>` : ""}
    <div class="attach">
      <button class="chip" data-kind="full"><span class="ms">block</span>${L("החניון מלא", "Lot is full")}</button>
      <button class="chip" data-kind="space"><span class="ms">check_circle</span>${L("יש מקום", "Has space")}</button>
    </div>
    <details><summary>${L("כמה שילמתי?", "What did I pay?")}</summary>
      <form class="form" id="paid">
        <label>${L("מחיר ששילמתי (₪)", "Price I paid (₪)")}<input name="price" type="number" inputmode="decimal" min="0" max="1000" step="any" required></label>
        <label>${L("שעת כניסה", "Entry time")}<input name="entered_at" type="datetime-local" required max="${now}" value="${q.start < now ? q.start : now}"></label>
        <label>${L("משך החניה בדקות", "Stay length in minutes")}<input name="minutes" type="number" inputmode="numeric" min="1" max="10080" step="1" required value="${q.duration_minutes}"></label>
        <label class="chip tog"><input type="checkbox" name="resident"${state.res ? " checked" : ""}><span class="ms">home</span>${L("תושב/ת תל אביב-יפו", "Tel Aviv-Yafo resident")}</label>
        <p class="note red" id="rerr" hidden></p>
        <div class="btns"><button class="btn primary">${L("שליחה", "Send")}</button></div>
      </form>
    </details>`;
  const send = async (body) => {
    if (!me) return showAccount(SIGN_IN_TO_REPORT());
    try { await api("/api/reports", "POST", { lot_id: d.id, ...body }); await load(); openLot(d.id, false); }
    catch (err) {
      if (err.status === 401) return showAccount(SIGN_IN_TO_REPORT());
      Object.assign($("#rerr"), { hidden: false, textContent: REPORT_ERR[err.status] ?? L("משהו השתבש. נסו שוב.", "Something went wrong. Try again.") });
    }
  };
  box.onclick = (e) => { const k = e.target.closest("[data-kind]")?.dataset.kind; if (k) send({ kind: k }); };
  $("#paid").onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    send({ kind: "price", price: +f.get("price"), entered_at: f.get("entered_at"), minutes: +f.get("minutes"), resident: f.has("resident") });
  };
}

// lot details: tick the places this lot is a favorite for
function drawAttach(d) {
  const box = $("#attach");
  box.innerHTML = `<h3>${L("חניון מועדף ליד", "Favorite lot near")}</h3>` + (!me ? `<button class="save" id="signin">${L("התחברו כדי לשמור חניונים מועדפים", "Sign in to save favorite lots")}</button>`
    : !favs.length ? `<p class="sub">${L(`עוד אין לכם נקודות ציון. חפשו מקום ולחצו "שמירה כנקודת ציון".`, `You have no saved places yet. Search for a place and press "Save as a place".`)}</p>`
    : `<div class="attach">${favs.map((f) => `<label class="chip tog"><input type="checkbox" data-attach="${f.id}"${f.lots.some((l) => l.lot_id === d.id) ? " checked" : ""}><span class="ms">place</span>${esc(f.label)}</label>`).join("")}</div>`);
  box.onclick = (e) => e.target.closest("#signin") && showAccount();
  box.onchange = (e) => {
    const id = e.target.dataset.attach, on = e.target.checked;
    (on ? api(`/api/favorites/${id}/lots`, "POST", { lot_id: d.id }) : api(`/api/favorites/${id}/lots/${encodeURIComponent(d.id)}`, "DELETE"))
      .then(loadMe, () => (e.target.checked = !on));
  };
}

const AUTH_ERR = { 401: L("שם משתמש או סיסמה שגויים.", "Wrong username or password."), 409: L("שם המשתמש הזה תפוס.", "That username is taken.") };
function showAccount(msg = "") {
  state.lot = null; sync(); select(null);
  panel.innerHTML = `<button id="close" class="icon-btn" aria-label="${L("סגירה", "Close")}"><span class="ms">close</span></button>` + (me ? `
    <h2>${L("שלום, ", "Hello, ")}${esc(me.username)}</h2>
    <h3>${L("נקודות הציון שלי", "My places")}</h3>
    ${favs.length ? `<ol class="favs">${favs.map((f, i) => `<li>
      <div class="row">
        <button class="go" data-place="${i}"><span class="ms">place</span>${esc(f.label)}</button>
        <button class="icon-btn" data-rename="${i}" aria-label="${esc(L(`שינוי השם של ${f.label}`, `Rename ${f.label}`))}" title="${L("שינוי שם", "Rename")}"><span class="ms">edit</span></button>
        <button class="icon-btn" data-del="${i}" aria-label="${esc(L(`מחיקת ${f.label}`, `Delete ${f.label}`))}" title="${L("מחיקה", "Delete")}"><span class="ms">delete</span></button>
      </div>
      ${f.lots.length ? `<ul class="lots">${f.lots.map((l) => `<li class="lot">
        <button class="go" data-lot="${esc(l.lot_id)}"><span class="ms">local_parking</span>${esc(l.name)}</button>
        <button class="icon-btn" data-unpin="${i}" data-lot-id="${esc(l.lot_id)}" aria-label="${esc(L(`הסרת ${l.name} מ${f.label}`, `Remove ${l.name} from ${f.label}`))}"><span class="ms">close</span></button></li>`).join("")}</ul>`
        : `<p class="hint">${L(`אין עדיין חניונים מועדפים. פתחו חניון וסמנו את "${esc(f.label)}".`, `No favorite lots yet. Open a lot and tick "${esc(f.label)}".`)}</p>`}
    </li>`).join("")}</ol>` : `<p class="sub">${L("עוד אין לכם נקודות ציון. הוסיפו כתובת, למשל הבית או העבודה.", "You have no saved places yet. Add an address, such as home or work.")}</p>`}
    <form class="add" id="addPlace">
      <input name="q" required placeholder="${L("כתובת או מקום, למשל דיזנגוף 50", "Address or place, e.g. Dizengoff 50")}" aria-label="${L("הוספת נקודת ציון: כתובת או מקום", "Add a place: address or place name")}">
      <button class="btn primary"><span class="ms">add</span>${L("הוספה", "Add")}</button>
    </form>
    <p class="note red" id="err" hidden></p>
    <div class="btns"><button class="btn" id="logout"><span class="ms">logout</span>${L("התנתקות", "Sign out")}</button></div>` : `
    <h2>${L("החשבון שלי", "My account")}</h2>
    <p class="sub">${esc(msg || L("התחברו כדי לשמור נקודות ציון וחניונים מועדפים לכל אחת.", "Sign in to save places, and favorite lots for each."))}</p>
    <form class="form" id="auth">
      <label>${L("שם משתמש", "Username")}<input name="username" required minlength="3" maxlength="32" pattern="[\\p{L}\\p{N}_.\\-]+" title="${L("אותיות, ספרות, _ . -", "Letters, digits, _ . -")}" autocomplete="username"></label>
      <label>${L("סיסמה", "Password")}<input name="password" type="password" required minlength="8" maxlength="200" autocomplete="current-password"></label>
      <p class="note red" id="err" hidden></p>
      <div class="btns"><button class="btn primary" value="login">${L("התחברות", "Sign in")}</button><button class="btn" value="register">${L("הרשמה", "Register")}</button></div>
    </form>`);
  panel.hidden = false; list.hidden = true; panel.dataset.view = "me";
  $("#listBtn").setAttribute("aria-pressed", "false");
  const fail = (text) => Object.assign($("#err"), { hidden: false, textContent: text });
  $("#close").onclick = () => (panel.hidden = true);
  $("#logout")?.addEventListener("click", async () => { await api("/api/auth/logout", "POST"); await loadMe(); showAccount(); });
  $("#auth")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try { await api(`/api/auth/${e.submitter.value}`, "POST", Object.fromEntries(new FormData(e.target))); await loadMe(); showAccount(); }
    catch (err) { fail(AUTH_ERR[err.status] ?? L("משהו השתבש. נסו שוב.", "Something went wrong. Try again.")); }
  });
  $("#addPlace")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim();
    const { candidates = [] } = await api(`/api/places?q=${encodeURIComponent(q)}`).catch(() => ({}));
    if (!candidates.length) return fail(L("לא נמצא. נסו שם מקום, או רחוב ומספר בית.", "Not found. Try a place name, or a street and house number."));
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
    const name = prompt(L("שם חדש לנקודת הציון", "New name for this place"), f("rename").label)?.trim();
    if (name) { await api(`/api/favorites/${f("rename").id}`, "PATCH", { label: name }); await loadMe(); showAccount(); }
  }
  if (t("del") && confirm(L(`למחוק את "${f("del").label}" ואת החניונים ששמרתם לידה?`, `Delete "${f("del").label}" and the lots you saved for it?`))) { await api(`/api/favorites/${f("del").id}`, "DELETE"); await loadMe(); showAccount(); }
  if (t("unpin")) { await api(`/api/favorites/${f("unpin").id}/lots/${encodeURIComponent(t("unpin").lotId)}`, "DELETE"); await loadMe(); showAccount(); }
});
$("#meBtn").addEventListener("click", () => (panel.hidden || panel.dataset.view !== "me" ? showAccount() : (panel.hidden = true)));

// language: reload with the other one, so every view is rebuilt from the same code path
$("#langBtn").addEventListener("click", () => {
  const next = EN ? "he" : "en";
  try { localStorage.lang = next; } catch {}
  const u = new URL(location.href);
  u.searchParams.set("lang", next);
  location.href = u;
});

// --- init from URL (deep links from the MCP land here)
showWhen();
$("#dur").value = [...$("#dur").options].some((o) => o.value === state.dur) ? state.dur : ($("#dur").add(new Option(`${state.dur} ${L("דק׳", "min")}`, state.dur)), state.dur);
$("#res").checked = state.res;
$("#zoneChip").hidden = !state.res;
$("#zone").value = state.zone;
$("#bus").checked = state.bus;
$("#cp").checked = state.cp;
for (const k of ["ev", "cov", "acc", "moto"]) $("#" + k).checked = state[k];
$("#h").value = state.h;
state.moto && drawMoto();
load();
loadMe().then(() => state.lot && openLot(state.lot)); // after loadMe: the lot card shows the user's places

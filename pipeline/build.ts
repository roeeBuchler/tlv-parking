// Pipeline: TLV GIS layer 970 (coords, live key) + ahuzot.co.il lot pages (tariffs), private operators, and unpriced
// public lots from the city license registry and OpenStreetMap
// -> data/lots.json, plus data/holidays.json from hebcal. Exits non-zero when something needs a human (CI then fails loudly).
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { HebrewCalendar, flags } from "@hebcal/core";
import { parseTariff, ALL_DAYS } from "./parse.ts";
import { overrides } from "./overrides.ts";
import { centralPark, green, single, text as clean } from "./operators.ts";
import { registry, osm, zones } from "./opendata.ts";
import { gisQuery, geocode, UA } from "../src/places.ts";
import type { Lot } from "../src/engine.ts";

const today = new Date().toISOString().slice(0, 10);
const problems: string[] = [];

// 1. holidays (Israel): CHAG days, and the day before each as its eve
const year = new Date().getFullYear();
const holidays: Record<string, string> = {};
const iso = (d: Date) => d.toLocaleDateString("en-CA");
for (const e of HebrewCalendar.calendar({ start: new Date(year, 0, 1), end: new Date(year + 2, 0, 1), il: true })) {
  if (!(e.getFlags() & flags.CHAG)) continue;
  const d = e.getDate().greg();
  holidays[iso(d)] = "holiday";
  const eve = iso(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1));
  holidays[eve] ??= "holiday_eve";
}
writeFileSync("data/holidays.json", JSON.stringify(holidays, null, 1) + "\n");
const { quote, parseLocal, inWindow } = await import("../src/engine.ts"); // after holidays.json is fresh

// 2. GIS layer 970: coordinates + live-status key
const gis = await gisQuery(970, { where: "1=1", outFields: "code_achoza,shem_chenyon,ktovet,lat,lon" });
// join key; drops vowel letters (ברזאני = ברזני)
const key = (s: string) => s.replace(/חניון|תל[- ]אביב[- ]יפו|[^\p{L}\p{N}]|[אוי]/gu, "");

// 3. ahuzot.co.il lot pages, politely (1 req/s)
// 30 s timeout and 2 retries: a DNS blip or a hung socket must not stall or sink the weekly run
const get = async (url: string, tries = 3): Promise<string> => {
  try {
    const r = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return await r.text();
  } catch (e) {
    if (tries <= 1) throw e;
    await sleep(5000);
    return get(url, tries - 1);
  }
};
const ids = [...new Set([...(await get("https://www.ahuzot.co.il/Parking/All/")).matchAll(/ParkingDetails\/\?ID=(\d+)/g)].map((m) => +m[1]))];
if (ids.length < 80) problems.push(`Only ${ids.length} lots on ahuzot.co.il/Parking/All (expected ~88)`);

const lots = [];
for (const id of ids) {
  await sleep(1000);
  const source_url = `https://www.ahuzot.co.il/Parking/ParkingDetails/?ID=${id}`;
  const html = await get(source_url);
  const cells = [...html.matchAll(/<td class="ParkingTable(Header)?"[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/g)].map((m) => clean(m[2]));
  const field = (label: string) => cells.find((c) => c.startsWith(label))?.slice(label.length).replace(/^\s*:\s*/, "").trim() ?? "";
  const name = cells[0], address = field("כתובת החניון"), tariff_text = field("תעריף החניון");
  if (!name || !tariff_text) { problems.push(`ID ${id}: page layout changed (no name/tariff)`); continue; }

  const g = gis.find((g) => key(g.shem_chenyon) === key(name)) ?? gis.find((g) => key(g.ktovet) === key(address));
  const pos = g ? { lat: g.lat, lng: g.lon } : await geocode(address).then((p) => p[0] && { lat: p[0].lat, lng: p[0].lng });
  if (!pos) { problems.push(`ID ${id} ${name}: no coordinates for "${address}"`); continue; }

  const parsed = parseTariff(tariff_text);
  if (!parsed.tariffs && !/בהתאם לשילוט/.test(tariff_text)) problems.push(`ID ${id} ${name}: unparsed tariff text`);
  else if (!parsed.tariffs && !overrides[id]?.sign) problems.push(`ID ${id} ${name}: new "per sign" lot, add its sign info to pipeline/overrides.ts`);
  lots.push({
    id: `ahuzot-${id}`, name, operator: "ahuzot", address, ...pos,
    spaces: +(html.match(/מקומות חנייה בחניון:\s*(\d+)/)?.[1] ?? 0) || undefined,
    serves: field("מתחם, איזור אותו משמש החניון"), hours_text: field("שעות פעילות החניון").replace(/^שעות פעילות החניון:\s*/, ""),
    tariff_text, ...parsed, ...overrides[id],
    live_key: g?.code_achoza, source_url, verified_at: today,
  });
}

// 4. private operators
lots.push(...await centralPark(get, today, problems), ...await green(get, today, problems), ...await single(get, today, problems));
let old: any[] = [];
try { old = JSON.parse(readFileSync("data/lots.json", "utf8")); } catch {}

// 5. lots without a published price (open data); OSM is best effort, last week's copy if Overpass is down
lots.push(...await registry(lots, today, problems));
const fromOsm = await osm(lots, today);
if (!fromOsm) console.warn("Overpass unreachable: keeping last week's OpenStreetMap lots");
lots.push(...(fromOsm ?? old.filter((o) => o.operator === "osm")));

// 6. blue-white parking zones for src/street.ts
writeFileSync("data/zones.json", JSON.stringify(await zones(problems)) + "\n");

// 7. checks: every entry time of a week (+ holiday/eve days) must hit a rule; prices must not jump > 50%
const probe = ["2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10",
  ...Object.keys(holidays).filter((d) => d >= today).slice(0, 6)];
for (const l of lots as Lot[]) for (const rules of [l.tariffs, l.resident_tariffs, l.app_tariffs]) {
  if (!rules) continue;
  for (const d of probe) for (let m = 0; m < 1440; m += 30) {
    const t = parseLocal(d + "T00:00") + m * 60_000;
    if (!rules.some((r) => inWindow(r, t, rules))) { problems.push(`${l.id} ${l.name}: no tariff at ${d} +${m}min`); break; }
  }
  for (const r of rules) if (!r.days.every((x) => ALL_DAYS.includes(x)) || !(r.rate ?? r.price ?? r.first_hour)) problems.push(`${l.id}: bad rule ${JSON.stringify(r)}`);
}
for (const o of old) {
  const n = lots.find((l) => l.id === o.id);
  if (!n) { // open-data lots come and go (dedup against new priced lots, OSM edits); only priced sources are guarded
    if (!["registry", "osm"].includes(o.operator)) problems.push(`${o.id} ${o.name}: disappeared from its source`);
    continue;
  }
  if (o.operator !== "ahuzot") continue; // jump check guards the free-text parser; Central Park's JSON has real weekly/event prices
  for (const [when, mins] of [["2026-10-04T10:00", 120], ["2026-10-04T20:00", 180], ["2026-10-10T14:00", 180]] as const) {
    const a = quote(o, parseLocal(when), mins).price_ils, b = quote(n as any, parseLocal(when), mins).price_ils;
    if (a && b && (b / a > 1.5 || a / b > 1.5)) problems.push(`${o.id} ${o.name}: price ${a} -> ${b} (${when}, ${mins}min)`);
  }
}

writeFileSync("data/lots.json", JSON.stringify(lots, null, 1) + "\n");
const count = (f: (l: Lot) => unknown) => Object.entries(Object.groupBy(lots as Lot[], (l) => l.operator)).map(([op, ls]) => `${op} ${ls!.filter(f).length}`).join(", ");
console.log(`lots: ${count(() => true)}\npriced: ${count((l) => l.tariffs)}\nfree per sign: ${count((l) => l.sign?.free)}`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s) need a human:\n- ` + problems.join("\n- "));
  process.exit(1);
}

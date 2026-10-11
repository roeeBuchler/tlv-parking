// Lots without a published price, from open data, so the map shows every public lot (as "price per the sign"):
// the city's business-license registry of public lots (GIS layer 556), then named public lots in OpenStreetMap.
// Both skip lots within a short walk of a lot already in the data.
import { distanceM, type Lot } from "../src/engine.ts";
import { gisQuery, GIS, UA } from "../src/places.ts";
import { AREA } from "../src/street.ts";

const near = (p: { lat: number; lng: number }, lots: Lot[], m: number) => lots.some((l) => distanceM(p, l) < m);
const key = (s: string) => s.replace(/חניו(ן|ני)|parking|[^\p{L}\p{N}]/giu, "");
// the same lot under the same name, a bit further off (sources pin different entrances)
const named = (name: string, p: { lat: number; lng: number }, lots: Lot[]) => near(p, lots.filter((l) => key(l.name) === key(name)), 400);
const SIGN = {
  he: "אין לנו את המחירון של החניון הזה. המחיר לפי השילוט בכניסה.",
  en: "We don't have this lot's price list: price as per the sign at the entrance.",
};

export async function registry(have: Lot[], today: string, problems: string[]): Promise<Lot[]> {
  const rows = await gisQuery(556, { where: "1=1", outFields: "oid,name,address,num_vehicles", returnGeometry: "true", outSR: "4326" });
  if (rows.length < 200) problems.push(`registry: only ${rows.length} lots in GIS layer 556 (expected ~250)`);
  const lots: Lot[] = [];
  for (const r of rows) {
    const p = { lat: +r.y.toFixed(6), lng: +r.x.toFixed(6) };
    if (/מוסך|מוניות|שטיפ|כלי רכב/.test(r.name)) continue; // licensed, but a garage / taxi depot / car wash
    // a registry entry naming an operator we have prices for is that operator's lot, pinned elsewhere
    if (near(p, have, /סנטרל|אחוזת|גרין/.test(r.name) ? 300 : 80) || near(p, lots, 40)) continue;
    // "1244 2" = an unnamed street's code; names are often the licensee company
    const address = /^\d+ /.test(r.address) ? "" : r.address.trim();
    const n = r.name.replace(/\s*בע["'״]+מ|\s*בע["'״]*$|חב['׳] /g, "").replace(/^חניו(ן|ני)[\s-]*/, "").trim();
    const name = `חניון ${n || address || "ציבורי"}`;
    if (named(name, p, have)) continue;
    lots.push({
      id: `registry-${r.oid}`, name, operator: "registry", address, ...p,
      spaces: r.num_vehicles || undefined, tariffs: null, sign: { free: false, ...SIGN },
      source_url: `${GIS}/556`, verified_at: today,
    });
  }
  return lots;
}

const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"];
const Q = '[out:json][timeout:60];area["wikidata"="Q33935"]->.a;nwr["amenity"="parking"]["name"](area.a);out center tags;'; // Q33935 = Tel Aviv-Yafo
const CLOSED = /^(private|customers|no|permit|residents|delivery|employees|staff)$/;

// null when every Overpass mirror fails: the caller keeps last week's OSM lots
export async function osm(have: Lot[], today: string): Promise<Lot[] | null> {
  let els: any[] | undefined;
  for (const u of OVERPASS) {
    try {
      const r = await fetch(u, { method: "POST", body: new URLSearchParams({ data: Q }), signal: AbortSignal.timeout(90_000),
        headers: { "user-agent": UA } }); // overpass-api.de 406s without one
      if (r.ok) { els = (await r.json()).elements; break; }
    } catch {}
  }
  if (!els) return null;
  const lots: Lot[] = [];
  for (const e of els) {
    const t = e.tags, p = { lat: e.center?.lat ?? e.lat, lng: e.center?.lon ?? e.lon };
    if (CLOSED.test(t.access ?? "") || /street_side|lane/.test(t.parking ?? "")) continue;
    if (!/\p{Script=Hebrew}/u.test(t.name) || /אוטובוס|מרצים|עובדים|נכים/.test(t.name)) continue; // "P3", staff-only, bus depots
    if (near(p, have, 100) || near(p, lots, 50) || named(t.name, p, have)) continue;
    lots.push({
      id: `osm-${e.type}-${e.id}`, name: /חניו|parking/i.test(t.name) ? t.name : `חניון ${t.name}`, operator: "osm",
      address: [t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(" "), ...p,
      spaces: +t.capacity || undefined, tariffs: null, sign: { free: false, ...SIGN },
      source_url: `https://www.openstreetmap.org/${e.type}/${e.id}`, verified_at: today,
    });
  }
  return lots;
}

// Night subscriptions of private lots, from the city's GIS layer 488 (type 4: "private lots offering a discounted night
// subscription"). Attaches the plan to a lot we already have within 40 m, or adds the lot, unpriced per visit.
// Central Park lots are skipped: their own site is the authority (the city still lists the old prices, and some no longer sell).
// The layer also carries a contact person and phone: never copied.
export async function nightSubs(lots: Lot[], today: string, problems: string[]): Promise<Lot[]> {
  const rows = await gisQuery(488, { where: "k_sug_chenyon=4", outFields: "OBJECTID,shem,ktovet,num_vehicles,taarif_layla,heaarot", returnGeometry: "true", outSR: "4326" });
  if (rows.length < 15) problems.push(`night subscriptions: only ${rows.length} lots in GIS layer 488 type 4 (expected ~29)`);
  const added: Lot[] = [];
  for (const r of rows) {
    const price_ils = +r.taarif_layla;
    if (!(price_ils > 0)) continue;
    const p = { lat: +r.y.toFixed(6), lng: +r.x.toFixed(6) };
    const hours = /^\d\d:\d\d-\d\d:\d\d$/.test(r.heaarot?.trim()) ? r.heaarot.trim() : undefined;
    const sub = { type: "night" as const, period: "month" as const, price_ils, hours, source: "city" as const };
    const all = [...lots, ...added];
    if (all.some((l) => l.operator === "centralpark" && distanceM(p, l) < 100)) continue;
    const at = all.find((l) => l.operator !== "ahuzot" && distanceM(p, l) < 40); // same address; a looser radius pairs neighbours
    if (at) { if (!at.subscriptions?.some((x) => x.type === "night")) (at.subscriptions ??= []).push(sub); continue; }
    const address = r.ktovet.trim(), n = r.shem.replace(/\s*בע["'״]+מ/g, "").trim();
    added.push({
      id: `night-${r.OBJECTID}`, name: /^חניון/.test(n) ? n : `חניון ${n}`, operator: "private", address, ...p,
      spaces: r.num_vehicles || undefined, tariffs: null, sign: { free: false, ...SIGN }, subscriptions: [sub],
      source_url: `${GIS}/488`, verified_at: today,
    });
  }
  return added;
}

// Blue-white parking zones (GIS layer 544), simplified to ~10 m: [lng, lat] rings for the point-in-zone lookup in src/street.ts.
export async function zones(problems: string[]) {
  const rows = await gisQuery(544, { where: "1=1", outFields: "ms_ezor", returnGeometry: "true", outSR: "4326",
    maxAllowableOffset: "0.0001", geometryPrecision: "5" }, 30_000);
  const known = Object.keys(AREA).map(Number), got = rows.map((r) => r.ms_ezor);
  if (got.length !== known.length || !known.every((z) => got.includes(z)))
    problems.push(`zones: GIS layer 544 has zones ${got.sort((a, b) => a - b)}; update AREA in src/street.ts (expected ${known})`);
  return rows.map((r) => ({ zone: r.ms_ezor as number, rings: r.rings as [number, number][][] })).sort((a, b) => a.zone - b.zone);
}

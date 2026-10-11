// Lots without a published price, from open data, so the map shows every public lot (as "price per the sign"):
// the city's business-license registry of public lots (GIS layer 556), then named public lots in OpenStreetMap.
// Both skip lots within a short walk of a lot already in the data.
import { distanceM, type Lot } from "../src/engine.ts";
import { gisQuery, GIS, UA } from "../src/places.ts";

const near = (p: { lat: number; lng: number }, lots: Lot[], m: number) => lots.some((l) => distanceM(p, l) < m);
const key = (s: string) => s.replace(/חניו(ן|ני)|parking|[^\p{L}\p{N}]/giu, "");
// the same lot under the same name, a bit further off (sources pin different entrances)
const named = (name: string, p: { lat: number; lng: number }, lots: Lot[]) => near(p, lots.filter((l) => key(l.name) === key(name)), 400);
const SIGN = {
  he: "אין לנו את המחירון של החניון הזה. המחיר לפי השילוט בכניסה.",
  en: "We don't have this lot's price list: price as per the sign at the entrance.",
};

export async function registry(have: Lot[], today: string, problems: string[]): Promise<Lot[]> {
  const rows = await gisQuery(556, { where: "1=1", outFields: "oid,name,address,num_vehicles,num_disabled", returnGeometry: "true", outSR: "4326" });
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
      spaces: r.num_vehicles || undefined, ...(r.num_disabled > 0 && { accessible: true }), tariffs: null, sign: { free: false, ...SIGN },
      source_url: `${GIS}/556`, verified_at: today,
    });
  }
  return lots;
}

// Street motorcycle bays (GIS layer 951): not lots, so a separate file for the map's motorcycle layer.
export async function motoBays(problems: string[]) {
  const rows = await gisQuery(951, { where: "1=1", outFields: "ktovet,ms_mekomot", returnGeometry: "true", outSR: "4326" });
  if (rows.length < 400) problems.push(`moto: only ${rows.length} bays in GIS layer 951 (expected ~525)`);
  return rows.map((r) => ({ address: r.ktovet.replace(/\s+/g, " ").trim(), spaces: r.ms_mekomot || undefined, lat: +r.y.toFixed(6), lng: +r.x.toFixed(6) }));
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

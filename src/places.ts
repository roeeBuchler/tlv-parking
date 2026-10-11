// Place resolution: a pasted Google Maps link, hand-picked landmarks, the local business index (Overture + Foursquare,
// public/pois.tsv), then OpenStreetMap (Nominatim) for addresses and whatever the index lacks.
// geocode() below (TLV GIS layer 527) is only for the data pipeline, which depends on the city's GIS anyway.
import landmarks from "../data/places.json" with { type: "json" };

export const GIS = "https://gisn.tel-aviv.gov.il/ArcGIS/rest/services/IView2/MapServer";
export const UA = "tlv-parking-bot/1.0 (+https://github.com/roeeBuchler/tlv-parking)";
export type Place = { label: string; lat: number; lng: number; source: "landmark" | "address" | "osm" | "link" | "poi" };
export type LoadPois = () => Promise<string>;

export const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// one retry by default: the city's server sometimes hangs a connection
export async function gisQuery(layer: number, params: Record<string, string>, timeoutMs = 8000, retries = 1): Promise<any[]> {
  const u = new URL(`${GIS}/${layer}/query`);
  for (const [k, v] of Object.entries({ f: "json", returnGeometry: "false", ...params })) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(timeoutMs) }).catch((e) => { if (retries < 1) throw e; });
  if (!r) return gisQuery(layer, params, timeoutMs, retries - 1);
  if (!r.ok) throw new Error(`GIS ${layer}: HTTP ${r.status}`);
  const j: any = await r.json();
  if (j.error) throw new Error(`GIS ${layer}: ${j.error.message}`);
  return j.features.map((f: any) => ({ ...f.attributes, ...f.geometry })); // geometry (x, y) only when asked for
}

// "דיזנגוף 50", "Dizengoff 50", "לסקוב 28 תל-אביב יפו"
export async function geocode(q: string): Promise<Place[]> {
  const m = q.replace(/,?\s*(תל[- ]?אביב.*|tel[- ]?aviv.*)$/i, "").trim().match(/^(.+?)\s*(\d+)?$/);
  if (!m) return [];
  const street = m[1].replace(/[^\p{L}\p{N} \-"'׳״]/gu, "").replace(/'/g, "''").trim(); // trust boundary: SQL-ish where clause
  if (street.length < 2) return [];
  const num = m[2] ? ` AND ms_bayit=${+m[2]}` : "";
  // one column per query: the city's WAF rejects "... OR ... LIKE" as SQL injection
  const col = /\p{Script=Hebrew}/u.test(street) ? "t_rechov" : "t_rechov_eng";
  // GIS names are often reordered ("לסקוב חיים", "בגין מנחם"): fall back to single words, longest first
  const words = street.split(/\s+/).filter((w) => w.length >= 3).sort((a, b) => b.length - a.length);
  let rows: any[] = [];
  for (const s of new Set([street, ...words])) {
    rows = await gisQuery(527, {
      where: `${col} LIKE '%${col === "t_rechov" ? s : s.toUpperCase()}%'${num}`,
      outFields: "t_rechov,t_rechov_eng,ms_bayit,lat,lon",
      orderByFields: "t_rechov,ms_bayit",
      resultRecordCount: "1000",
    });
    if (rows.length) break;
  }
  const byStreet = Map.groupBy(rows, (r) => r.t_rechov as string);
  return [...byStreet.values()].slice(0, 5).map((rs) => {
    const r = rs[Math.floor(rs.length / 2)]; // no house number: middle of the street
    return { label: `${r.t_rechov} ${r.ms_bayit} (${r.t_rechov_eng} ${r.ms_bayit})`, lat: r.lat, lng: r.lon, source: "address" as const };
  });
}

// biased toward TLV (viewbox), not limited to it
// ponytail: public Nominatim is ~1 req/s, no heavy use; for real traffic swap the host for LocationIQ or a self-hosted Nominatim (same API)
async function osmSearch(q: string): Promise<Place[]> {
  const params = { q, format: "jsonv2", addressdetails: "1", limit: "5", countrycodes: "il", "accept-language": "he", viewbox: "34.74,32.15,34.85,32.03" };
  const r = await fetch(`https://nominatim.openstreetmap.org/search?${new URLSearchParams(params)}`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Nominatim: HTTP ${r.status}`);
  return ((await r.json()) as any[]).map(({ name, address: a, lat, lon }) => {
    const street = [a.road, a.house_number].filter(Boolean).join(" ");
    return { label: [...new Set([name, street, a.city ?? a.town ?? a.village])].filter(Boolean).join(", "), lat: +lat, lng: +lon, source: "osm" as const };
  });
}

// google.com/maps/place/Nachmani/@32.06,34.77,18z/data=...!3d32.0651024!4d34.7776611 -> the pin (!3d!4d), else the viewport (@)
export function fromMapsLink(q: string): Place | null {
  if (!/^https?:\/\/(www\.)?google\.[a-z.]+\/maps/.test(q)) return null;
  const m = q.match(/!3d(-?[\d.]+)!4d(-?[\d.]+)/) ?? q.match(/@(-?[\d.]+),(-?[\d.]+)/);
  if (!m) return null;
  const name = q.match(/\/maps\/place\/([^/@]+)/)?.[1];
  return { label: name ? decodeURIComponent(name.replace(/\+/g, " ")) : `${m[1]}, ${m[2]}`, lat: +m[1], lng: +m[2], source: "link" };
}

// maps.app.goo.gl/… share links redirect once to the full URL. Only Google's shortener is fetched (trust boundary: no open fetch).
async function expandMapsLink(url: string): Promise<string> {
  if (!/^https:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps)\//.test(url)) return url;
  const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) }).catch(() => null);
  return r?.headers.get("location") ?? url;
}

// public/pois.tsv lines: "<normalized names, |-separated>\t<label>\t<lat>\t<lng>", best place first.
// indexOf over the raw text, no JSON parse: a few ms per query (Workers free plan: 10 ms CPU)
export function poiSearch(q: string, tsv: string, limit = 5): Place[] {
  const n = norm(q);
  if (n.length < 2) return [];
  const hits: { score: number; line: string }[] = [];
  for (let i = tsv.indexOf(n); i >= 0 && hits.length < 300;) {
    const start = tsv.lastIndexOf("\n", i) + 1, tab = tsv.indexOf("\t", start), end = tsv.indexOf("\n", i) >>> 0; // no trailing newline: -1 -> 2^32-1, slices to the end and ends the loop
    if (i < tab) { // matched the names column, not the label
      const score = Math.min(...tsv.slice(start, tab).split("|").map((x) => x === n ? 0 : x.startsWith(n) ? 1 : ` ${x} `.includes(` ${n} `) ? 2 : 3));
      hits.push({ score, line: tsv.slice(start, end) });
    }
    i = tsv.indexOf(n, end);
  }
  return hits.sort((a, b) => a.score - b.score).slice(0, limit).map(({ line }) => {
    const [, label, lat, lng] = line.split("\t");
    return { label, lat: +lat, lng: +lng, source: "poi" as const };
  });
}

export async function resolvePlace(q: string, pois?: LoadPois): Promise<Place[]> {
  const url = q.match(/https?:\/\/\S+/)?.[0]; // the app's share text is "Nachmani https://maps.app.goo.gl/…"
  if (url) { const link = fromMapsLink(await expandMapsLink(url)); return link ? [link] : []; } // never send a URL to OSM
  const n = norm(q);
  if (!n) return [];
  const hits = landmarks
    .filter((l) => [l.he, l.en, ...(l.aliases ?? [])].some((name) => { const x = norm(name); return x.includes(n) || n.includes(x); }))
    .map((l) => ({ label: `${l.he} (${l.en})`, lat: l.lat, lng: l.lng, source: "landmark" as const }));
  if (hits.length && !/\d/.test(q)) return hits;
  const local = poiSearch(q, (await pois?.().catch(() => "")) ?? "");
  const osm = await osmSearch(q).catch((e) => { if (local.length) return []; throw e; });
  return /\d/.test(q) ? [...hits, ...osm, ...local] : [...hits, ...local, ...osm]; // addresses ("דיזנגוף 50") are OSM's job
}

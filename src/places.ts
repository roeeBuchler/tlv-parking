// Place resolution: hand-picked landmarks first, then TLV GIS address layer 527 (no third-party geocoder).
import landmarks from "../data/places.json" with { type: "json" };

export const GIS = "https://gisn.tel-aviv.gov.il/ArcGIS/rest/services/IView2/MapServer";
export type Place = { label: string; lat: number; lng: number; source: "landmark" | "address" };

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export async function gisQuery(layer: number, params: Record<string, string>, timeoutMs = 8000): Promise<any[]> {
  const u = new URL(`${GIS}/${layer}/query`);
  for (const [k, v] of Object.entries({ f: "json", returnGeometry: "false", ...params })) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { "user-agent": "tlv-parking (+https://github.com/roeeBuchler/tlv-parking)" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`GIS ${layer}: HTTP ${r.status}`);
  const j: any = await r.json();
  if (j.error) throw new Error(`GIS ${layer}: ${j.error.message}`);
  return j.features.map((f: any) => f.attributes);
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

export async function resolvePlace(q: string): Promise<Place[]> {
  const n = norm(q);
  if (!n) return [];
  const hits = landmarks
    .filter((l) => [l.he, l.en, ...(l.aliases ?? [])].some((name) => { const x = norm(name); return x.includes(n) || n.includes(x); }))
    .map((l) => ({ label: `${l.he} (${l.en})`, lat: l.lat, lng: l.lng, source: "landmark" as const }));
  if (hits.length && !/\d/.test(q)) return hits;
  return [...hits, ...(await geocode(q))];
}

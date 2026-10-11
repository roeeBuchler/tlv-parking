// The one ranking both the API/site and the MCP tools use.
import lotsJson from "../data/lots.json" with { type: "json" };
import offersJson from "../data/offers.json" with { type: "json" };
import { WEEK, quote, distanceM, parseLocal, fmtLocal, localNow, dayOf, DAY, type Day, type Lot, type Offer, type Profile } from "./engine.ts";
import { gisQuery, type Place } from "./places.ts";

export const lots = lotsJson as unknown as Lot[];
export const offers = offersJson as unknown as Offer[];
export const REPO = "https://github.com/roeeBuchler/tlv-parking";

const n = (op: string) => lots.filter((l) => l.operator === op).length;
export const CAVEATS = [
  "Prices are estimates from the operator's published tariff; the sign at the gate prevails.",
  "Times are Asia/Jerusalem. Shabbat, holiday and holiday-eve tariffs differ from weekdays.",
  "ev_chargers, height_m, covered, accessible: null = unknown, not 'no'. Filters ev/covered/accessible keep only lots known to have it; the height filter drops only lots known to be too low, so say lots with height_m null are unchecked. covered is inferred from a published height limit.",
  "price_ils null = the lot publishes no tariff ('as per the sign at the lot'); see notes.",
  "price_basis 'municipal_data_unverified' = an open municipal lot the city lists as free (price_ils 0); say it is unverified and to check the traffic sign.",
  "Central Park lots: price_ils is the gate price unless apps includes 'centralpark'; gate_price_ils and app_price_ils give both.",
  `Coverage, Tel Aviv-Yafo: ${n("ahuzot")} Ahuzot HaHof (municipal), ${n("centralpark")} Central Park, ${n("green")} Green Parking and ` +
    `${n("azrieli") + n("dizengoff-center") + n("sarona")} mall lots (Azrieli, Dizengoff Center, Sarona) with prices, plus ` +
    `${n("registry") + n("osm")} more public lots with no published price (city license registry, OpenStreetMap): price_ils null.`,
];

// start: "2026-10-10T14:00" (Jerusalem local) or with Z/offset; or weekday ("sat") + time ("14:00"); default now
export function resolveStart(start?: string, weekday?: string, time?: string): number {
  if (start) {
    const ms = /[zZ]|[+-]\d\d:?\d\d$/.test(start) ? localNow(new Date(start)) : parseLocal(start.length === 10 ? `${start}T${time ?? "12:00"}` : start);
    if (Number.isNaN(ms)) throw new Error(`Bad start "${start}", use YYYY-MM-DDTHH:MM`);
    return ms;
  }
  const now = localNow();
  if (!weekday && !time) return now;
  const today = now - (now % DAY), [h, m] = (time ?? "12:00").split(":").map(Number);
  let t = today + (h * 60 + (m || 0)) * 60_000;
  const want = weekday ? WEEK.indexOf(weekday.slice(0, 3).toLowerCase() as Day) : -1;
  while ((want >= 0 && new Date(t).getUTCDay() !== want) || t < now) t += DAY;
  return t;
}

// Live occupancy from GIS layer 970.
// ponytail: per-isolate memory cache (Cache API is a no-op on workers.dev); fine at this traffic
const STATUS: Record<string, string> = { "פנוי": "free", "מעט": "few", "מלא": "full", "סגור": "closed", "פעיל": "open" };
let liveCache: { at: number; data: Record<number, { status: string; updated: string }> } | undefined;
export async function live() {
  if (liveCache && Date.now() - liveCache.at < 120_000) return liveCache.data;
  try {
    const rows = await gisQuery(970, { where: "1=1", outFields: "code_achoza,status_chenyon,tr_status_chenyon" }, 3000, 0); // optional data: never stall a search
    const data = Object.fromEntries(rows.map((r) => [r.code_achoza, {
      status: STATUS[r.status_chenyon] ?? "unknown",
      updated: r.tr_status_chenyon ? fmtLocal(r.tr_status_chenyon) : "", // GIS stores local time as if UTC
    }]));
    liveCache = { at: Date.now(), data };
    return data;
  } catch {
    return liveCache?.data ?? {}; // live status is a nice-to-have; never fail a search over it
  }
}

export type Features = { ev?: boolean; covered?: boolean; accessible?: boolean; height_m?: number };
export type SearchInput = Profile & Features & {
  lat?: number; lng?: number; start: number; minutes: number;
  max_walk_m?: number; sort_by?: "price" | "distance"; limit?: number; origin: string;
};

// A wanted feature must be known; absent data is "unknown", not "no". Height is the reverse: only a known-too-low limit excludes.
export const hasFeatures = (l: Lot, f: Features) =>
  (!f.ev || !!l.ev_chargers) && (!f.covered || !!l.covered) && (!f.accessible || !!l.accessible) && (f.height_m == null || l.height_m == null || l.height_m >= f.height_m);

export async function search(s: SearchInput) {
  const status = await live();
  const here = s.lat != null && s.lng != null ? { lat: s.lat, lng: s.lng } : null;
  const profile = { resident: s.resident, apps: s.apps, transit: s.transit };
  const results = lots
    .map((l) => ({ l, distance_m: here ? distanceM(here, l) : null }))
    .filter((x) => x.distance_m == null || x.distance_m <= (s.max_walk_m ?? 800))
    .filter((x) => hasFeatures(x.l, s))
    .map(({ l, distance_m }) => ({
      id: l.id, name: l.name, operator: l.operator, address: l.address, lat: l.lat, lng: l.lng, distance_m,
      ...quote(l, s.start, s.minutes, profile, offers),
      live: (l.live_key != null && status[l.live_key]) || null,
      spaces: l.spaces ?? null, ev_chargers: l.ev_chargers ?? null, height_m: l.height_m ?? null, covered: l.covered ?? null, accessible: l.accessible ?? null, verified_at: l.verified_at, source_url: l.source_url,
      map_url: mapUrl(s.origin, l.id, s.start, s.minutes, s.resident),
    }))
    .sort((a, b) => s.sort_by === "distance"
      ? (a.distance_m ?? 0) - (b.distance_m ?? 0)
      : (a.price_ils ?? Infinity) - (b.price_ils ?? Infinity) || (a.distance_m ?? 0) - (b.distance_m ?? 0));
  return {
    query: { start: fmtLocal(s.start), end: fmtLocal(s.start + s.minutes * 60_000), duration_minutes: s.minutes, day_type: dayOf(s.start), ...profile,
      ...(s.ev && { ev: true }), ...(s.covered && { covered: true }), ...(s.accessible && { accessible: true }), ...(s.height_m != null && { height_m: s.height_m }) },
    count: results.length,
    results: results.slice(0, s.limit ?? results.length),
    caveats: CAVEATS,
  };
}

export async function lotDetails(id: string, s: Omit<SearchInput, "lat" | "lng">) {
  const l = lots.find((l) => l.id === id);
  if (!l) return null;
  const status = await live();
  return {
    ...l,
    quote: { start: fmtLocal(s.start), duration_minutes: s.minutes, ...quote(l, s.start, s.minutes, s, offers) },
    offers: offers.filter((o) => o.lot_ids.includes(id)),
    live: (l.live_key != null && status[l.live_key]) || null,
    links: {
      waze: `https://waze.com/ul?ll=${l.lat},${l.lng}&navigate=yes`,
      google_maps: `https://www.google.com/maps/dir/?api=1&destination=${l.lat},${l.lng}`,
      map: mapUrl(s.origin, id, s.start, s.minutes, s.resident),
      report: `${REPO}/issues/new?title=${encodeURIComponent(`Wrong price: ${l.name} (${id})`)}`,
    },
    caveats: CAVEATS,
  };
}

const mapUrl = (origin: string, id: string, start: number, minutes: number, resident?: boolean) =>
  `${origin}/?lot=${id}&when=${fmtLocal(start)}&dur=${minutes}${resident ? "&res=1" : ""}`;

export const placeOut = (p: Place[]) => ({ resolved: p[0] ?? null, alternatives: p.slice(1) });

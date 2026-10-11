// The one ranking both the API/site and the MCP tools use.
import lotsJson from "../data/lots.json" with { type: "json" };
import offersJson from "../data/offers.json" with { type: "json" };
import { WEEK, quote, distanceM, parseLocal, fmtLocal, localNow, dayOf, DAY, HOUR, type Day, type Lot, type Offer, type Profile, type Sub } from "./engine.ts";
import { gisQuery, type Place } from "./places.ts";
import { zoneAt, streetQuote, streetChance, streetWho } from "./street.ts";

export const lots = lotsJson as unknown as Lot[];
export const offers = offersJson as unknown as Offer[];
// A weekly plan counts as 4.33 weeks, so plans of both periods rank on one scale.
export const monthly = (s: Sub) => (s.period === "week" ? Math.round(s.price_ils * 4.33) : s.price_ils);
export const cheapestSub = (l: Lot, type: Sub["type"]) => l.subscriptions?.filter((s) => s.type === type).sort((a, b) => monthly(a) - monthly(b))[0];
const REPO = "https://github.com/roeeBuchler/tlv-parking";

const n = (op: string) => lots.filter((l) => l.operator === op).length;
export const CAVEATS = [
  "Prices are estimates from the operator's published tariff; the sign at the gate prevails.",
  "Times are Asia/Jerusalem. Shabbat, holiday and holiday-eve tariffs differ from weekdays.",
  "ev_chargers, height_m, covered, accessible: null = unknown, not 'no'. Filters ev/covered/accessible keep only lots known to have it; the height filter drops only lots known to be too low, so say lots with height_m null are unchecked. covered is inferred from a published height limit.",
  "price_ils null = the lot publishes no tariff ('as per the sign at the lot'); see notes.",
  "price_basis 'municipal_data_unverified' = an open municipal lot the city lists as free (price_ils 0); say it is unverified and to check the traffic sign.",
  "subscriptions (monthly/weekly passes) are not part of price_ils. With subscription=night|full|weekdays the results are ranked by that plan's monthly price. source 'operator' = the operator's own site; 'city' = the city's open data, possibly out of date: confirm with the lot before buying.",
  "live.source 'crowd' = reported by app users in the last 30 minutes (unverified); crowd_prices = what drivers say they paid (unverified, never used in price_ils).",
  "Central Park lots: price_ils is the gate price unless apps includes 'centralpark'; gate_price_ils and app_price_ils give both.",
  `Coverage, Tel Aviv-Yafo: ${n("ahuzot")} Ahuzot HaHof (municipal), ${n("centralpark")} Central Park, ${n("green")} Green Parking and ` +
    `${n("azrieli") + n("dizengoff-center") + n("sarona")} mall lots (Azrieli, Dizengoff Center, Sarona) with prices, plus ` +
    `${n("registry") + n("osm")} more public lots with no published price (city license registry, OpenStreetMap): price_ils null.`,
  "street = blue-white curbside parking at the searched point (null outside Tel Aviv-Yafo's parking zones): its zone, price for the stay, " +
    "who = that price for each kind of driver (own_zone permit, other_zone permit, visitor), " +
    "and chance_pct, a rough estimate of finding a spot (time of day plus live occupancy of nearby municipal lots), not live street data. Say it is an estimate.",
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

// lot id → newest "full"/"space" report (src/reports.ts); beats the GIS status when newer, or when GIS has no occupancy
export type Crowd = Record<string, { status: "full" | "free"; updated: string }>;
const OCCUPANCY = ["free", "few", "full", "closed"];
export function liveFor(l: Lot, gis: Record<number, { status: string; updated: string }>, crowd?: Crowd) {
  const g = l.live_key != null ? gis[l.live_key] : undefined, c = crowd?.[l.id];
  return c && (!g || !OCCUPANCY.includes(g.status) || g.updated < c.updated) ? { ...c, source: "crowd" } : g || null;
}

export type Features = { ev?: boolean; covered?: boolean; accessible?: boolean; height_m?: number };
type SearchInput = Profile & Features & {
  crowd?: Crowd; lat?: number; lng?: number; start: number; minutes: number;
  max_walk_m?: number; sort_by?: "price" | "distance"; limit?: number; origin: string;
  sub?: Sub["type"]; // only lots selling this plan, ranked by its monthly price instead of the price of the stay
};

// A wanted feature must be known; absent data is "unknown", not "no". Height is the reverse: only a known-too-low limit excludes.
export const hasFeatures = (l: Lot, f: Features) =>
  (!f.ev || !!l.ev_chargers) && (!f.covered || !!l.covered) && (!f.accessible || !!l.accessible) && (f.height_m == null || l.height_m == null || l.height_m >= f.height_m);

export async function search(s: SearchInput) {
  const status = await live();
  const here = s.lat != null && s.lng != null ? { lat: s.lat, lng: s.lng } : null;
  const profile = { resident: s.resident, apps: s.apps, transit: s.transit, zone: s.zone };
  const results = lots
    .map((l) => ({ l, distance_m: here ? distanceM(here, l) : null }))
    .filter((x) => x.distance_m == null || x.distance_m <= (s.max_walk_m ?? 800))
    .filter((x) => !s.sub || cheapestSub(x.l, s.sub))
    .filter((x) => hasFeatures(x.l, s))
    .map(({ l, distance_m }) => ({
      id: l.id, name: l.name, operator: l.operator, address: l.address, lat: l.lat, lng: l.lng, distance_m,
      ...quote(l, s.start, s.minutes, profile, offers),
      live: liveFor(l, status, s.crowd),
      subscriptions: l.subscriptions, subscription: s.sub && cheapestSub(l, s.sub),
      spaces: l.spaces ?? null, ev_chargers: l.ev_chargers ?? null, height_m: l.height_m ?? null, covered: l.covered ?? null, accessible: l.accessible ?? null, verified_at: l.verified_at, source_url: l.source_url,
      map_url: mapUrl(s.origin, l.id, s.start, s.sub ?? s.minutes, s.resident),
    }))
    .sort((a, b) => s.sort_by === "distance"
      ? (a.distance_m ?? 0) - (b.distance_m ?? 0)
      : s.sub ? monthly(a.subscription!) - monthly(b.subscription!) || (a.distance_m ?? 0) - (b.distance_m ?? 0)
      : (a.price_ils ?? Infinity) - (b.price_ils ?? Infinity) || (a.distance_m ?? 0) - (b.distance_m ?? 0));
  const zone = here && zoneAt(here);
  // live lot status says something about the streets only for a stay that starts about now
  const nearby = Math.abs(s.start - localNow()) < HOUR
    ? results.filter((r) => r.live && r.distance_m != null && r.distance_m <= 600).map((r) => r.live!.status) : [];
  return {
    query: { start: fmtLocal(s.start), end: fmtLocal(s.start + s.minutes * 60_000), duration_minutes: s.minutes, day_type: dayOf(s.start), subscription: s.sub, ...profile,
      ...(s.ev && { ev: true }), ...(s.covered && { covered: true }), ...(s.accessible && { accessible: true }), ...(s.height_m != null && { height_m: s.height_m }) },
    street: zone ? { ...streetQuote(zone, s.start, s.minutes, profile), who: streetWho(zone, s.start, s.minutes), ...streetChance(zone, s.start, nearby) } : null,
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
    live: liveFor(l, status, s.crowd),
    links: {
      waze: `https://waze.com/ul?ll=${l.lat},${l.lng}&navigate=yes`,
      google_maps: `https://www.google.com/maps/dir/?api=1&destination=${l.lat},${l.lng}`,
      map: mapUrl(s.origin, id, s.start, s.minutes, s.resident),
      report: `${REPO}/issues/new?title=${encodeURIComponent(`Wrong price: ${l.name} (${id})`)}`,
    },
    caveats: CAVEATS,
  };
}

const mapUrl = (origin: string, id: string, start: number, minutes: number | string, resident?: boolean) =>
  `${origin}/?lot=${id}&when=${fmtLocal(start)}&dur=${minutes}${resident ? "&res=1" : ""}`;

export const placeOut = (p: Place[]) => ({ resolved: p[0] ?? null, alternatives: p.slice(1) });

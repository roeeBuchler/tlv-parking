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
  "best = the one recommendation: lowest price + walking cost (walk: far/normal/near = ₪1/3/8 per 100 m), among priced lots within 1 km open the whole stay. " +
    "kind 'street' = try blue-white first (its cost counts the chance of no spot, circling, then paying best.lot); best.lot is then the fallback. " +
    "cost_ils is a ranking score, not a price: quote price_ils to the user.",
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

// The one pick to show first: lowest cost = price + walking, where the user's `walk` setting says what 100 m is worth to them.
// Blue-white is a gamble: with chance p you get a spot (street price + a short walk); otherwise you circle, then pay the best lot anyway.
// ponytail: hand-set weights; learn them from what users actually pick once there are users
export const WALK = { far: 1, normal: 3, near: 8 } as const; // ₪ per 100 m walked: happy to walk far / normal / wants it close
export type Walk = keyof typeof WALK;
const PICK_MAX_M = 1000, STREET_WALK_M = 150, CIRCLING_ILS = 15; // ~10 min of circling before giving up on the street
type Cand = { id: string; name: string; price_ils: number | null; price_basis: string; open_whole_stay: boolean; distance_m: number | null; live: { status: string } | null };
export function bestPick(results: Cand[], street: { price_ils: number; chance_pct: number } | null, walk: Walk = "normal", liveNow = false) {
  const w = WALK[walk] / 100, r2 = (n: number) => Math.round(n * 100) / 100;
  // only lots we can price for sure, open the whole stay, and (for a stay starting now) not full or closed
  const [lot] = results
    .filter((r) => r.price_basis === "tariff" && r.price_ils != null && r.open_whole_stay && r.distance_m != null && r.distance_m <= PICK_MAX_M
      && !(liveNow && ["full", "closed"].includes(r.live?.status ?? "")))
    .map((r) => ({ id: r.id, name: r.name, price_ils: r.price_ils!, distance_m: r.distance_m!, cost_ils: r2(r.price_ils! + r.distance_m! * w) }))
    .sort((a, b) => a.cost_ils - b.cost_ils);
  let street_cost_ils = null;
  if (street) {
    const p = street.chance_pct / 100, spot = street.price_ils + STREET_WALK_M * w;
    street_cost_ils = r2(p * spot + (1 - p) * (CIRCLING_ILS + (lot?.cost_ils ?? spot)));
  }
  if (!lot && street_cost_ils == null) return null;
  // kind "street": try blue-white first; `lot` is where to go if there's no spot
  const kind = street_cost_ils != null && (!lot || street_cost_ils < lot.cost_ils) ? "street" : "lot";
  return { kind, walk, lot: lot ?? null, street_cost_ils };
}

export type Features = { ev?: boolean; covered?: boolean; accessible?: boolean; height_m?: number };
type SearchInput = Profile & Features & {
  crowd?: Crowd; lat?: number; lng?: number; start: number; minutes: number;
  max_walk_m?: number; sort_by?: "price" | "distance"; limit?: number; origin: string;
  sub?: Sub["type"]; // only lots selling this plan, ranked by its monthly price instead of the price of the stay
  walk?: Walk;
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
  const liveNow = Math.abs(s.start - localNow()) < HOUR;
  const nearby = liveNow ? results.filter((r) => r.live && r.distance_m != null && r.distance_m <= 600).map((r) => r.live!.status) : [];
  const street = zone ? { ...streetQuote(zone, s.start, s.minutes, profile), who: streetWho(zone, s.start, s.minutes), ...streetChance(zone, s.start, nearby) } : null;
  return {
    query: { start: fmtLocal(s.start), end: fmtLocal(s.start + s.minutes * 60_000), duration_minutes: s.minutes, day_type: dayOf(s.start), subscription: s.sub, ...profile,
      ...(s.ev && { ev: true }), ...(s.covered && { covered: true }), ...(s.accessible && { accessible: true }), ...(s.height_m != null && { height_m: s.height_m }) },
    best: here && !s.sub ? bestPick(results, street, s.walk, liveNow) : null,
    street,
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

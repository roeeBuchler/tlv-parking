// Price engine: shared by the pipeline, API, MCP and tests.
// All times are Asia/Jerusalem wall-clock, stored as "fake UTC" ms so day/hour math needs no tz lib.
// ponytail: DST days are off by an hour for stays crossing the switch; fine for estimates.
import holidaysJson from "../data/holidays.json" with { type: "json" };

export type Day = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "holiday_eve" | "holiday";
// Entry window. to <= from wraps past midnight ("18:00"-"07:00"); from == to is a full 24h day.
export type Window = { days: Day[]; from: string; to: string };
export type Rule = Window & {
  kind: "per_minute" | "step" | "flat";
  rate?: number; // per_minute: ₪ per hour, billed by the minute
  tiers?: [number, number][]; // per_minute: [up to minute N, ₪ per hour] before `rate` takes over
  first_hour?: number; step_minutes?: number; step_price?: number; // step
  price?: number; valid_hours?: number; valid_until?: string; // flat: valid N hours, or until next HH:MM
  daily_max?: number;
};
export type Lot = {
  id: string; name: string; operator: string; address: string; lat: number; lng: number;
  spaces?: number; serves?: string; hours_text?: string; tariff_text?: string;
  tariffs: Rule[] | null; // null = "price on sign"
  app_tariffs?: Rule[]; // paying in the operator's own app (Central Park): used when profile.apps includes lot.operator
  sign?: { free: boolean; he: string; en: string }; // no tariff: what the municipal data / evidence says about the sign
  resident_tariffs?: Rule[]; // replaces tariffs for TLV residents (instead of a % discount)
  resident_discount_pct?: number;
  grace_minutes?: number;
  open?: Window[]; // if set, the whole stay must be inside these
  no_entry?: Window[];
  payment?: string[];
  live_key?: number; // TLV GIS layer 970 code_achoza
  source_url: string; verified_at: string;
};
export type Offer = {
  id: string; title: { he: string; en: string }; lot_ids: string[];
  days: Day[]; apps?: string[]; transit?: boolean; free_hours: number;
  source_url: string; verified_at: string;
};
export type Profile = { resident?: boolean; apps?: string[]; transit?: boolean; zone?: number }; // zone: TLV residential parking permit zone

const holidays = holidaysJson as Record<string, "holiday" | "holiday_eve">;
export const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
export const WEEK: Day[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const hm = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };

export const parseLocal = (s: string) => Date.parse(s.slice(0, 16) + ":00Z"); // "2026-10-10T14:00"
export const fmtLocal = (ms: number) => new Date(ms).toISOString().slice(0, 16);
export function localNow(d = new Date()): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return parseLocal(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`);
}

// A holiday/eve only counts if the rule set mentions it; otherwise the plain weekday applies.
export function dayOf(ms: number, windows?: { days: Day[] }[]): Day {
  const h = holidays[fmtLocal(ms).slice(0, 10)];
  return h && (!windows || windows.some((w) => w.days.includes(h))) ? h : WEEK[new Date(ms).getUTCDay()];
}

export function inWindow(w: Window, ms: number, all: Window[]): boolean {
  const m = Math.floor((ms % DAY) / MIN), f = hm(w.from), t = hm(w.to);
  if (f < t) return m >= f && m < t && w.days.includes(dayOf(ms, all));
  // wrapping: after `from` belongs to today, before `to` belongs to yesterday
  return (m >= f && w.days.includes(dayOf(ms, all))) || (m < t && w.days.includes(dayOf(ms - DAY, all)));
}

function nextAt(ms: number, at: string): number {
  const t = ms - (ms % DAY) + hm(at) * MIN;
  return t > ms ? t : t + DAY;
}

function hourly(r: Rule, minutes: number): number {
  const one = (m: number) => {
    if (m <= 0) return 0;
    const p = r.kind === "per_minute"
      ? [...(r.tiers ?? []), [Infinity, r.rate!]].reduce((s, [upto, rate], i, a) => s + (rate * Math.max(0, Math.min(m, upto) - (a[i - 1]?.[0] ?? 0))) / 60, 0)
      : r.first_hour! + Math.ceil(Math.max(0, m - 60) / r.step_minutes!) * r.step_price!;
    return Math.min(p, r.daily_max ?? Infinity);
  };
  const full = Math.floor(minutes / 1440);
  return full * one(1440) + one(minutes - full * 1440);
}

export type Part = { from: string; to: string; kind: Rule["kind"]; price: number };

// Walk the stay: the rule is picked by ENTRY time. Hourly entry pays hourly to exit;
// a flat entry covers until its validity ends, after which it is treated as a fresh entry.
export function simulate(rules: Rule[], entry: number, exit: number): { price: number; parts: Part[] } | null {
  let t = entry, price = 0;
  const parts: Part[] = [];
  while (t < exit) {
    const r = rules.find((r) => inWindow(r, t, rules));
    if (!r) return null;
    const end = r.kind !== "flat" ? exit : r.valid_hours ? t + r.valid_hours * HOUR : nextAt(t, r.valid_until ?? r.to);
    const p = r.kind === "flat" ? r.price! : hourly(r, (exit - t) / MIN);
    parts.push({ from: fmtLocal(t), to: fmtLocal(Math.min(end, exit)), kind: r.kind, price: round(p) });
    price += p;
    t = end;
  }
  return { price: round(price), parts };
}

const round = (n: number) => Math.round(n * 100) / 100;

// ponytail: samples every 5 min; exact interval math if lots ever get sub-5-minute windows
const coveredBy = (ws: Window[], from: number, to: number) => {
  for (let t = from; t < to; t += 5 * MIN) if (!ws.some((w) => inWindow(w, t, ws))) return false;
  return true;
};

export function quote(lot: Lot, entry: number, minutes: number, profile: Profile = {}, offers: Offer[] = []) {
  const exit = entry + minutes * MIN;
  const notes: string[] = [];
  const useResidentRules = profile.resident && lot.resident_tariffs;
  const useApp = !!lot.app_tariffs && !!profile.apps?.includes(lot.operator);
  const rules = useResidentRules ? lot.resident_tariffs! : useApp ? lot.app_tariffs! : lot.tariffs;
  const sim = rules && simulate(rules, entry, exit);
  let price = sim ? sim.price : !rules && lot.sign?.free ? 0 : null;
  if (!rules) notes.push(lot.sign?.en ?? "No published price: as per the sign at the gate.");
  else if (!sim) notes.push("No tariff covers this entry time.");
  // lots with an in-app price list: report both channels
  const channels = lot.app_tariffs && lot.tariffs
    ? { gate_price_ils: simulate(lot.tariffs, entry, exit)?.price ?? null, app_price_ils: simulate(lot.app_tariffs, entry, exit)?.price ?? null }
    : {};
  if (!useApp && channels.app_price_ils != null && channels.app_price_ils < (price ?? Infinity))
    notes.push(`₪${channels.app_price_ils} when paying in the operator's app (apps: "${lot.operator}").`);
  if (price != null && profile.resident && !useResidentRules && lot.resident_discount_pct) {
    price = round(price * (1 - lot.resident_discount_pct / 100));
    notes.push(`TLV resident discount ${lot.resident_discount_pct}%.`);
  }
  if (price != null && lot.grace_minutes && minutes <= lot.grace_minutes) {
    price = 0;
    notes.push(`First ${lot.grace_minutes} minutes are free.`);
  }

  const applied_offers: string[] = [], potential_offers: string[] = [];
  for (const o of offers) {
    if (!o.lot_ids.includes(lot.id) || !o.days.includes(dayOf(entry))) continue;
    const ok = (!o.apps || o.apps.some((a) => profile.apps?.includes(a))) && (!o.transit || profile.transit);
    if (ok && minutes <= o.free_hours * 60) { applied_offers.push(o.id); price = 0; }
    else potential_offers.push(o.id);
  }

  const can_enter = !lot.no_entry?.some((w) => inWindow(w, entry, lot.no_entry!));
  const open_whole_stay = can_enter && (!lot.open || coveredBy(lot.open, entry, exit));
  if (!can_enter) notes.push("Entry is not allowed at this time.");
  else if (!open_whole_stay) notes.push("The lot is closed during part of this stay (cars may be unable to exit).");
  const price_basis = rules ? "tariff" : lot.sign?.free ? "municipal_data_unverified" : "none";
  return { price_ils: price, price_basis, ...channels, breakdown: sim?.parts ?? [], applied_offers, potential_offers, can_enter, open_whole_stay, notes };
}

export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = Math.PI / 180, x = (b.lng - a.lng) * r * Math.cos(((a.lat + b.lat) / 2) * r), y = (b.lat - a.lat) * r;
  return Math.round(Math.hypot(x, y) * 6_371_000);
}

// Blue-white (curbside) parking at the destination: which zone, what it costs, and a rough chance of finding a spot.
// Rules: tel-aviv.gov.il ParkingArrangements + parkingpolicy pages and the city's 2025 parking booklet, checked 2026-10-11.
// Per-street exceptions (permit-holders-only stretches, other hours) are only on the street sign: no open data for them.
import zonesJson from "../data/zones.json" with { type: "json" };
import { dayOf, distanceM, DAY, HOUR, MIN, type Day, type Profile } from "./engine.ts";
import { gisQuery } from "./places.ts";

const zones = zonesJson as { zone: number; rings: [number, number][][] }[];
export const STREET_SOURCE = "https://www.tel-aviv.gov.il/Residents/Transportation/Pages/ParkingArrangements.aspx";
// the 9 parking zones (GIS layer 544): "מרכז העיר" or "רחבי העיר"; area sets the rate and how late paid hours run
export const AREA: Record<number, "center" | "city"> = { 6: "center", 7: "center", 9: "center", 10: "center", 1: "city", 2: "city", 4: "city", 12: "city", 13: "city" };
const RATE = { center: 12.4, city: 7 }; // ₪/h for visitors, billed by the minute (Pango / Cello)
const PERMIT_OFF = 0.3, PERMIT_FREE_MIN = 120; // permit holders outside their zone: 2 free hours a day, then 30% off

// paid [from, to) minutes of the day; null = free all day (Shabbat, holidays)
const paidHours = (day: Day, area: "center" | "city"): [number, number] | null =>
  day === "sat" || day === "holiday" ? null : day === "fri" || day === "holiday_eve" ? [480, 1020] : [480, area === "center" ? 1260 : 1140];

// even-odd ray casting over every ring, so holes work too
export function zoneAt(p: { lat: number; lng: number }): number | null {
  for (const z of zones) {
    let inside = false;
    for (const ring of z.rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > p.lat !== yj > p.lat && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return z.zone;
  }
  return null;
}

export function streetQuote(zone: number, entry: number, minutes: number, profile: Profile = {}) {
  const area = AREA[zone] ?? "city", exit = entry + minutes * MIN;
  const permit = profile.zone === zone ? "own_zone" : profile.zone != null || profile.resident ? "other_zone" : "none";
  let paid = 0, charged = 0;
  for (let d = entry - (entry % DAY); d < exit; d += DAY) {
    const h = paidHours(dayOf(d), area);
    if (!h) continue;
    const m = Math.max(0, Math.min(exit, d + h[1] * MIN) - Math.max(entry, d + h[0] * MIN)) / MIN;
    paid += m;
    charged += permit === "own_zone" ? 0 : permit === "other_zone" ? Math.max(0, m - PERMIT_FREE_MIN) : m;
  }
  const rate = RATE[area] * (permit === "other_zone" ? 1 - PERMIT_OFF : 1);
  const notes = [
    "Pay by the minute with Pango or Cello, from the first minute (permit holders too, even in their free hours).",
    "Some blue-white stretches are for that zone's permit holders only, and hours can differ: the sign at the start of the street prevails.",
  ];
  if (permit === "other_zone" && profile.zone == null) notes.push(`Free all day if the user's parking permit is for zone ${zone}.`);
  if (!paid && permit !== "own_zone") notes.push("No charge at this time (evening, Shabbat or holiday) unless the sign says otherwise.");
  return {
    zone, area, rate_ils_per_hour: Math.round(rate * 100) / 100, permit, paid_minutes: paid,
    price_ils: Math.round((charged / 60) * rate * 100) / 100, notes, source_url: STREET_SOURCE,
  };
}

// the stay's price and hourly rate for each kind of driver, so one lookup answers "can I park here?" for everyone
export function streetWho(zone: number, entry: number, minutes: number) {
  const q = (profile: Profile) => { const { price_ils, rate_ils_per_hour } = streetQuote(zone, entry, minutes, profile); return { price_ils, rate_ils_per_hour }; };
  return { own_zone: { price_ils: 0, rate_ils_per_hour: 0 }, other_zone: q({ resident: true }), visitor: q({}) };
}

// The street nearest to p and the zones along it, by side and house number (TLV GIS layer 527, addresses):
// long streets cross zones, and on border streets each side can belong to a different zone.
export async function streetZones(p: { lat: number; lng: number }) {
  if (!zoneAt(p)) return null;
  const near = await gisQuery(527, { geometry: `${+p.lng},${+p.lat}`, geometryType: "esriGeometryPoint", inSR: "4326",
    distance: "100", units: "esriSRUnit_Meter", outFields: "t_rechov,t_rechov_eng,k_rechov,lat,lon" });
  const s = near.sort((a, b) => distanceM(p, { lat: a.lat, lng: a.lon }) - distanceM(p, { lat: b.lat, lng: b.lon }))[0];
  if (!s) return null;
  const rows = await gisQuery(527, { where: `k_rechov=${+s.k_rechov}`, outFields: "ms_bayit,lat,lon", orderByFields: "ms_bayit", resultRecordCount: "2000" });
  const side = (odd: number) => {
    const runs: { zone: number; from: number; to: number }[] = [];
    for (const r of rows) {
      const zone = r.ms_bayit % 2 === odd && zoneAt({ lat: r.lat, lng: r.lon }), last = runs.at(-1);
      if (!zone) continue; // other side, or just outside the simplified zone outline
      if (last?.zone === zone) last.to = r.ms_bayit;
      else runs.push({ zone, from: r.ms_bayit, to: r.ms_bayit });
    }
    return runs;
  };
  return { street: s.t_rechov as string, street_en: s.t_rechov_eng as string, odd: side(1), even: side(0) };
}

// ponytail: hand-set guesses by day type and hour, nudged by live occupancy of nearby municipal lots.
// Tune BASE here; replace with user reports ("found a spot in N min") once there are some.
const BASE: Record<"weekday" | "friday" | "shabbat", [number, number][]> = { // [from hour, % chance]
  weekday: [[0, 25], [6, 35], [9, 40], [16, 30], [19, 20]],
  friday: [[0, 25], [8, 30], [14, 20]],
  shabbat: [[0, 25], [8, 35], [16, 25]],
};
const CENTER_PENALTY = 10, BUSY = { free: 0, few: 0.6, full: 1 } as Record<string, number>;

// nearby: live statuses ("free" / "few" / "full" / ...) of lots near the destination, only when the stay starts about now
export function streetChance(zone: number, at: number, nearby: string[] = []) {
  const d = dayOf(at), kind = d === "sat" || d === "holiday" ? "shabbat" : d === "fri" || d === "holiday_eve" ? "friday" : "weekday";
  const center = AREA[zone] === "center";
  let pct = BASE[kind].findLast(([h]) => (at % DAY) / HOUR >= h)![1] - (center ? CENTER_PENALTY : 0);
  const basis = [`Typical ${kind} at this hour${center ? " in the city centre" : ""}.`];
  const busy = nearby.map((s) => BUSY[s]).filter((b) => b != null);
  if (busy.length) {
    const b = busy.reduce((s, x) => s + x, 0) / busy.length;
    pct *= 1.3 - 0.8 * b; // all nearby lots free: x1.3, all full: x0.5
    basis.push(`${busy.length} nearby municipal lot(s) live now: ${Math.round(b * 100)}% busy.`);
  }
  return { chance_pct: Math.min(95, Math.max(5, Math.round(pct / 5) * 5)), chance_basis: basis, live_lots: busy.length };
}

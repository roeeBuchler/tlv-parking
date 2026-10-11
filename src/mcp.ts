// MCP server: 2 read-only tools over the same search the website uses.
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { search, lotDetails, resolveStart, placeOut, CAVEATS } from "./search.ts";
import { crowdLive, crowdPrices } from "./reports.ts";
import { resolvePlace, type LoadPois } from "./places.ts";

const readOnly = { readOnlyHint: true, openWorldHint: false };
const out = (data: unknown, summary: string) => ({
  content: [{ type: "text" as const, text: `${summary}\n\n${JSON.stringify(data)}` }],
  structuredContent: data as Record<string, unknown>,
});
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
const priceText = (q: { price_ils: number | null; price_basis: string }) =>
  q.price_ils == null ? "price on sign" : q.price_basis === "municipal_data_unverified" ? "free? (unverified)" : `₪${q.price_ils}`;

const when = {
  start: z.string().optional().describe("Entry time, Asia/Jerusalem local, e.g. 2026-10-10T14:00. Omit for now."),
  weekday: z.enum(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]).optional().describe("Next such day (with `time`), instead of `start`."),
  time: z.string().optional().describe("HH:MM, used with `weekday` (or alone for today/tomorrow)."),
  duration_minutes: z.number().int().min(1).max(7 * 1440).default(120).describe("Stay length. If the user gave none, 120 is assumed: say so."),
  tlv_resident: z.boolean().default(false).describe("Tel Aviv-Yafo resident (Ahuzot lots give 50-75% off)."),
  apps: z.array(z.enum(["pango", "cello", "moovit", "centralpark"])).default([])
    .describe("Parking/transit apps the user pays with. 'centralpark' = Central Park's own app (cheaper at its lots)."),
  will_ride_public_transport: z.boolean().default(false).describe("User will ride a TLV bus the same day (unlocks park & ride deals)."),
};

export function createServer(origin: string, pois?: LoadPois, db?: unknown) {
  const server = new McpServer({ name: "tlv-parking", version: "1.0.0" }, {
    instructions: "Tel Aviv parking lots with estimated prices for a specific time window. " + CAVEATS.join(" "),
  });

  server.registerTool("search_parking", {
    title: "Search parking near a place",
    description: "Find Tel Aviv parking lots near a place, ranked by the estimated price for the exact time window " +
      "(Shabbat/holiday tariffs, resident discounts and special offers applied), with live occupancy and a map link. " +
      "Give `near` (Hebrew or English place/address, e.g. 'Dizengoff Center', 'דיזנגוף 50') or lat/lng. " +
      "Always tell the user which resolved_location was used, the assumed duration, and that the sign at the gate prevails. " +
      "Mention potential_offers (deals the user could unlock) when present. " +
      "Also returns `street`: blue-white curbside parking at that point (zone, price for the stay, chance_pct of finding a spot: an estimate, say so).",
    inputSchema: z.object({
      near: z.string().optional().describe("Place, business, landmark, street address or Google Maps link (e.g. \"Dizengoff 50\", \"פארק המסילה\")."),
      lat: z.number().optional(), lng: z.number().optional(),
      ...when,
      permit_zone: z.number().int().optional().describe("The user's Tel Aviv residential parking permit zone (1, 2, 4, 6, 7, 9, 10, 12 or 13): blue-white parking there is free."),
      max_walk_m: z.number().int().min(100).max(5000).default(800).describe("Max straight-line distance in meters."),
      sort_by: z.enum(["price", "distance"]).default("price"),
      limit: z.number().int().min(1).max(50).default(10),
      ev_charging: z.boolean().default(false).describe("Only lots known to have EV chargers (mostly Central Park lots)."),
      covered: z.boolean().default(false).describe("Only lots known to be covered/underground. Data is sparse: inferred from a published height limit."),
      accessible: z.boolean().default(false).describe("Only lots known to be wheelchair accessible / have disabled bays."),
      vehicle_height_m: z.number().min(1).max(4).optional().describe("Car height in meters (e.g. 2.1 for a tall SUV or roof box). Drops lots with a lower published limit; lots with no published limit stay, with height_m null."),
    }),
    annotations: readOnly,
  }, async (a) => {
    let places = null;
    if (a.lat == null || a.lng == null) {
      if (!a.near) return fail("Give `near` or `lat`+`lng`.");
      const p = placeOut(await resolvePlace(a.near, pois));
      if (!p.resolved) return fail(`Couldn't find "${a.near}". Try a street name + number, or lat/lng.`);
      places = p;
    }
    const at = places?.resolved ?? { lat: a.lat!, lng: a.lng! };
    let start;
    try { start = resolveStart(a.start, a.weekday, a.time); } catch (e) { return fail(String(e)); }
    const r = await search({
      lat: at.lat, lng: at.lng, start, minutes: a.duration_minutes, max_walk_m: a.max_walk_m, sort_by: a.sort_by, limit: a.limit,
      resident: a.tlv_resident, apps: a.apps, transit: a.will_ride_public_transport, zone: a.permit_zone, origin, crowd: await crowdLive(db),
      ev: a.ev_charging, covered: a.covered, accessible: a.accessible, height_m: a.vehicle_height_m,
    });
    const data = { resolved_location: places?.resolved ?? at, alternatives: places?.alternatives ?? [], ...r };
    const top = r.results.slice(0, 3).map((x) => `${x.name} ${priceText(x)} ${x.distance_m}m`).join("; ");
    const st = r.street && ` Street (blue-white, zone ${r.street.zone}): ₪${r.street.price_ils}, ~${r.street.chance_pct}% chance of a spot (estimate).`;
    return out(data, `${r.count} lots within ${a.max_walk_m}m, ${r.query.start}→${r.query.end} (${r.query.day_type}). Top: ${top || "none"}.${st ?? ""}`);
  });

  server.registerTool("get_lot_details", {
    title: "Parking lot details",
    description: "Full details for one lot id from search_parking: structured tariffs and the original Hebrew tariff text, " +
      "opening hours, no-entry windows, offers, live status, a price quote for the given time, and Waze/Google Maps links.",
    inputSchema: z.object({ id: z.string().describe("e.g. ahuzot-94"), ...when }),
    annotations: readOnly,
  }, async (a) => {
    let start;
    try { start = resolveStart(a.start, a.weekday, a.time); } catch (e) { return fail(String(e)); }
    const d = await lotDetails(a.id, { start, minutes: a.duration_minutes, resident: a.tlv_resident, apps: a.apps, transit: a.will_ride_public_transport, origin, crowd: await crowdLive(db) });
    if (!d) return fail(`No lot "${a.id}". Use ids from search_parking.`);
    return out({ ...d, crowd_prices: await crowdPrices(db, d.id) },`${d.name}, ${d.address}: ${priceText(d.quote)} for ${a.duration_minutes} min from ${d.quote.start}`);
  });

  return server;
}

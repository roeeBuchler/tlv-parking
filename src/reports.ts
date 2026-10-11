// Crowd reports: "full now" / "space now" (shown as the lot's live status for 30 min) and "what I paid" (shown beside the tariff).
// Reports never change the engine's price; mismatches are counted so the tariff can be fixed in pipeline/overrides.ts.
import { lots, offers, type Crowd } from "./search.ts";
import { quote, parseLocal, localNow, fmtLocal, MIN, DAY } from "./engine.ts";
import { currentUser, type Env } from "./users.ts";

const LIVE_MS = 30 * MIN, DAILY_CAP = 20;
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });

// ponytail: per-isolate memory cache like live(); a report shows at once on its own isolate, within 20 s on others
let cache: { at: number; data: Crowd } | undefined;
export async function crowdLive(db: any): Promise<Crowd> {
  if (!db) return {};
  if (cache && Date.now() - cache.at < 20_000) return cache.data;
  try {
    const { results } = await db.prepare("SELECT lot_id, kind, created_at FROM reports WHERE kind IN ('full', 'space') AND created_at > ? ORDER BY created_at")
      .bind(Date.now() - LIVE_MS).all();
    const data: Crowd = {}; // newest report per lot wins
    for (const r of results) data[r.lot_id] = { status: r.kind === "full" ? "full" : "free", updated: fmtLocal(localNow(new Date(r.created_at))) };
    cache = { at: Date.now(), data };
    return data;
  } catch {
    return cache?.data ?? {}; // optional data: never fail a search over it (e.g. migration not applied)
  }
}

// last 5 "what I paid" reports, and how many of the last 30 days' reports differ from the engine's price by > 20% (and ₪2)
export async function crowdPrices(db: any, lotId: string) {
  if (!db) return null;
  try {
    const [{ results: recent }, miss] = await db.batch([
      db.prepare("SELECT price, quoted, entered_at, minutes, resident FROM reports WHERE lot_id = ? AND kind = 'price' ORDER BY created_at DESC LIMIT 5").bind(lotId),
      db.prepare("SELECT count(*) n FROM reports WHERE lot_id = ? AND kind = 'price' AND created_at > ? AND quoted IS NOT NULL AND abs(price - quoted) > max(2, 0.2 * quoted)")
        .bind(lotId, Date.now() - 30 * DAY),
    ]);
    return { recent, mismatches: miss.results[0].n as number };
  } catch {
    return null;
  }
}

// null = not a reports route
export async function handleReports(req: Request, env: Env, path: string): Promise<Response | null> {
  if (path !== "/api/reports") return null;
  if (req.method !== "POST") return json({ error: "Not found" }, 404);
  if (req.headers.get("origin") && req.headers.get("origin") !== new URL(req.url).origin) return json({ error: "Bad origin" }, 403);
  const user = await currentUser(req, env);
  if (!user) return json({ error: "sign in first" }, 401);

  const b = await req.json().catch(() => ({})) as Record<string, any>;
  const lot = lots.find((l) => l.id === b.lot_id);
  if (!lot) return json({ error: "No such lot" }, 400);
  if (!["full", "space", "price"].includes(b.kind)) return json({ error: "kind: full, space or price" }, 400);

  let price = null, quoted = null, entered_at = null, minutes = null, resident = null;
  if (b.kind === "price") {
    price = Number(b.price); minutes = Number(b.minutes); entered_at = String(b.entered_at ?? ""); resident = b.resident ? 1 : 0;
    const t = parseLocal(entered_at), now = localNow();
    if (!(price >= 0 && price <= 1000)) return json({ error: "price: 0-1000" }, 400);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 7 * 1440) return json({ error: "minutes: 1-10080" }, 400);
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(entered_at) || !(t <= now + 5 * MIN && t >= now - 30 * DAY)) return json({ error: "entered_at: within the last 30 days" }, 400);
    const q = quote(lot, t, minutes, { resident: !!resident }, offers) as ReturnType<typeof quote> & { app_price_ils?: number | null };
    const near = [q.price_ils, q.app_price_ils].filter((x): x is number => x != null);
    quoted = near.sort((a, c) => Math.abs(a - price!) - Math.abs(c - price!))[0] ?? null; // gate or app price, whichever the driver most likely paid
  }
  const { n } = await env.DB.prepare("SELECT count(*) n FROM reports WHERE user_id = ? AND created_at > ?").bind(user.id, Date.now() - DAY).first();
  if (n >= DAILY_CAP) return json({ error: "daily report limit" }, 429);
  await env.DB.prepare("INSERT INTO reports (user_id, lot_id, kind, price, quoted, entered_at, minutes, resident, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(user.id, lot.id, b.kind, price, quoted, entered_at, minutes, resident, Date.now()).run();
  cache = undefined;
  return json({ ok: true }, 201);
}

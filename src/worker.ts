// One Worker: static site (./public, served before this runs), JSON API, accounts + favorites, and MCP at /mcp.
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createServer } from "./mcp.ts";
import { search, lotDetails, resolveStart, placeOut } from "./search.ts";
import { resolvePlace } from "./places.ts";
import { streetZones } from "./street.ts";
import { handleUsers, type Env as UsersEnv } from "./users.ts";

const json = (data: unknown, status = 200) => Response.json(data, {
  status, headers: { "access-control-allow-origin": "*", "cache-control": "no-store" },
});

type Env = UsersEnv & { ASSETS: { fetch: (u: URL) => Promise<Response> } };
let poisText: Promise<string> | undefined; // public/pois.tsv, once per isolate; a failed load is retried next time
const loadPois = (env: Env, url: URL) => (poisText ??= env.ASSETS.fetch(new URL("/pois.tsv", url))
  .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`pois.tsv: HTTP ${r.status}`))))
  .catch((e) => { poisText = undefined; throw e; }));

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url), p = url.searchParams, origin = url.origin;
    const pois = () => loadPois(env, url);
    if (url.pathname === "/mcp") return createMcpHandler(() => createServer(origin, pois)).fetch(req);
    const u = await handleUsers(req, env, url.pathname).catch((e) => json({ error: String(e?.message ?? e) }, 500));
    if (u) return u;

    const num = (k: string) => (p.get(k) ? Number(p.get(k)) : undefined);
    const bool = (k: string) => ["1", "true"].includes(p.get(k) ?? "");
    try {
      const common = () => ({
        start: resolveStart(p.get("start") ?? undefined, p.get("weekday") ?? undefined, p.get("time") ?? undefined),
        minutes: Math.min(Math.max(num("duration") ?? 120, 1), 7 * 1440),
        resident: bool("resident"), apps: p.get("apps")?.split(",").filter(Boolean) ?? [], transit: bool("transit"), zone: num("zone"), origin,
      });
      switch (true) {
        case url.pathname === "/api/search": {
          let lat = num("lat"), lng = num("lng"), place = null;
          if (p.get("near") && lat == null) {
            place = placeOut(await resolvePlace(p.get("near")!, pois));
            if (!place.resolved) return json({ error: `Place not found: ${p.get("near")}` }, 404);
            ({ lat, lng } = place.resolved);
          }
          const sort = p.get("sort") === "distance" ? "distance" : "price";
          const r = await search({ ...common(), lat, lng, max_walk_m: num("max_walk") ?? (lat == null ? Infinity : 800), sort_by: sort, limit: num("limit") });
          return json({ resolved_location: place?.resolved ?? null, alternatives: place?.alternatives ?? [], ...r });
        }
        case url.pathname.startsWith("/api/lots/"): {
          const d = await lotDetails(decodeURIComponent(url.pathname.slice(10)), common());
          return d ? json(d) : json({ error: "No such lot" }, 404);
        }
        case url.pathname === "/api/street": { // zones along the street nearest lat/lng
          const z = await streetZones({ lat: num("lat") ?? NaN, lng: num("lng") ?? NaN });
          return z ? json(z) : json({ error: "No Tel Aviv blue-white parking zone here" }, 404);
        }
        case url.pathname === "/api/places":
          return json({ candidates: await resolvePlace(p.get("q") ?? "", pois) });
      }
    } catch (e) {
      return json({ error: String(e instanceof Error ? e.message : e) }, 400);
    }
    return json({ error: "Not found" }, 404);
  },
};

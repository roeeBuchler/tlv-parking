// One Worker: static site (./public, served before this runs), JSON API, and MCP at /mcp.
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createServer } from "./mcp.ts";
import { search, lotDetails, offers, live, resolveStart, placeOut } from "./search.ts";
import { resolvePlace } from "./places.ts";

const json = (data: unknown, status = 200) => Response.json(data, {
  status, headers: { "access-control-allow-origin": "*", "cache-control": "no-store" },
});

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url), p = url.searchParams, origin = url.origin;
    if (url.pathname === "/mcp") return createMcpHandler(() => createServer(origin)).fetch(req);

    const num = (k: string) => (p.get(k) ? Number(p.get(k)) : undefined);
    const bool = (k: string) => ["1", "true"].includes(p.get(k) ?? "");
    try {
      const common = () => ({
        start: resolveStart(p.get("start") ?? undefined, p.get("weekday") ?? undefined, p.get("time") ?? undefined),
        minutes: Math.min(Math.max(num("duration") ?? 120, 1), 7 * 1440),
        resident: bool("resident"), apps: p.get("apps")?.split(",").filter(Boolean) ?? [], transit: bool("transit"), origin,
      });
      switch (true) {
        case url.pathname === "/api/search": {
          let lat = num("lat"), lng = num("lng"), place = null;
          if (p.get("near") && lat == null) {
            place = placeOut(await resolvePlace(p.get("near")!));
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
        case url.pathname === "/api/places":
          return json({ candidates: await resolvePlace(p.get("q") ?? "") });
        case url.pathname === "/api/offers":
          return json({ offers });
        case url.pathname === "/api/live":
          return json(await live());
      }
    } catch (e) {
      return json({ error: String(e instanceof Error ? e.message : e) }, 400);
    }
    return json({ error: "Not found" }, 404);
  },
};

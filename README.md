# TLV Parking

A map of Tel Aviv parking lots, plus an MCP server, so an AI can answer *"cheapest parking near Dizengoff on Saturday?"*. Both use the same price engine. It runs free on Cloudflare Workers. The background and plan are in [PLAN.md](PLAN.md).

```
src/engine.ts      price engine: day types (Shabbat/holidays), quote(), shared by everything
src/search.ts      ranking used by both the API and MCP; live status (TLV GIS, cached 120 s)
src/places.ts      landmarks + OpenStreetMap (Nominatim) search
src/mcp.ts         MCP tools: search_parking, get_lot_details
src/worker.ts      routes: /mcp, /api/*, static site from public/
pipeline/          ahuzot.co.il + GIS, centralpark.co.il, greenparking.co.il, mall sites -> priced lots;
                   city license registry (GIS 556) + OpenStreetMap -> unpriced lots; all into data/lots.json; hebcal -> data/holidays.json
data/offers.json   hand-curated deals · data/places.json  landmarks
public/            the site (MapLibre from CDN, no build step), llms.txt, openapi.json
```

## Run

```bash
npm install
npm test            # golden price cases
npm run data        # re-scrape (about 2 min, 1 request/s); exits 1 if something needs a human
npm run dev         # http://localhost:8787
```

## Deploy (one time)

1. Create a free Cloudflare account and run `npx wrangler login`, then `npm run deploy`. The site goes live at `https://tlv-parking.<your-subdomain>.workers.dev`.
2. For CI, add the repo secrets `CLOUDFLARE_API_TOKEN` (use the "Edit Cloudflare Workers" template) and `CLOUDFLARE_ACCOUNT_ID`. After that, every push to main deploys, and every Sunday a run refreshes the data, commits it and deploys.

## Connect an AI

- **Claude:** Settings → Connectors → Add custom connector → `https://<host>/mcp` (no sign-in).
- **Claude Code:** `claude mcp add --transport http tlv-parking https://<host>/mcp`
- **Test:** `npx @modelcontextprotocol/inspector`
- **Without MCP:** `/openapi.json` and `/llms.txt`

## When the pipeline fails

It prints what needs a human: a new tariff wording (extend `pipeline/parse.ts`), a lot whose hours changed or a new "per sign" lot (`pipeline/overrides.ts`), a changed Green Parking or mall price text, or a new Green lot (`pipeline/operators.ts`), or a price jump of more than 50%. Check the change on the operator's site, fix the code or accept the data, and push.

Data: © Tel Aviv-Yafo Municipality open data (GIS), ahuzot.co.il, centralpark.co.il, greenparking.co.il, azrielimalls.co.il, dizengof-center.co.il, saronaparking.co.il; unpriced lots also © OpenStreetMap contributors (ODbL). Map: © OpenStreetMap contributors, OpenFreeMap.

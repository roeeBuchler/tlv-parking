# TLV Parking: website + MCP server

Research findings and build plan, written 2026-10-04.

**Goal.** Two ways in, one source of truth:

1. **AI path.** A user asks Claude, ChatGPT or another assistant: *"Where's the cheapest parking near Dizengoff on Saturday?"* The assistant calls our MCP server and gets back lots ranked by the **estimated price for that exact time window**, with special offers applied, live availability, and links.
2. **Human path.** A website with a map that shows every lot as a dot. Click a dot to see its prices by day and time, opening hours, offers, live status, and Waze or Google Maps links.

**Constraint:** $0 to run.

---

## 1. Research findings

### 1.1 Data sources, most useful first

| # | Source | What it has | Coverage | Access | Verdict |
|---|---|---|---|---|---|
| 1 | **TLV municipality GIS, layer 970 "חניוני אחוזות החוף"** | name, address, lat/lon, **live occupancy** (פנוי / מעט / מלא / סגור), capacity, tariff text | 94 lots | Public ArcGIS REST (JSON/GeoJSON), no key, **CORS open** | Use for **coordinates and live status**. Tariff fields are **stale** (see 1.3). |
| 2 | **ahuzot.co.il lot pages** (`/Parking/ParkingDetails/?ID=n`) | **current tariffs**, opening hours, areas served, resident discount, number of spaces, payment methods, accessibility | 88 lots, 17,653 spaces | HTML scrape. No robots.txt. Consistent page template. | **Primary source for Ahuzot prices.** |
| 3 | GIS layer 488 "חניוני לילה לתושבים" | 146 lots, typed: 44 "near-home" lots (free nights/weekends for permit holders), 39 open-to-public, 29 private lots with cheap night subscriptions, 24 in schools/institutions, 9 paid lots with resident discount. Phone numbers for private lots. | 146 | same as #1 | Source for **resident offers** |
| 4 | GIS layer 556 "חניונים ציבוריים" | **Business-license registry of public parking lots**: name, location, area, covered or not | 249 lots (230 names: Azrieli, Dizengoff Center, Sarona/Gindi, Port, Central Park, Maya, Green…) | same as #1 | **"All lots in TLV" base layer** (no prices). Dedupe against Ahuzot lots by proximity. |
| 5 | GIS layer 527 "כתובות" | every address with lat/lon and **English street names** | all addresses | same as #1 | **Geocoding** without a third-party service. Tested: "Dizengoff 50" → 32.0754, 34.7756. |
| 6 | **Central Park** (centralpark.co.il) | Per-lot pages embed **structured JSON**: price lists per day/time window, **gate price vs. app price**, daily max, **live free-space count**, coordinates | 35 TLV lots | Next.js pages. The site shows a ToS-acceptance modal. | **Central Park agreed to automation.** Scraped weekly by the pipeline (`pipeline/operators.ts`). |
| 7 | Dizengoff Center (dizengof-center.co.il) | tariff table: 24₪ first hour, then 15₪/h, 85₪ daily max; nights Sun–Thu from 18:00, max 35₪; Friday night rate from 16:00 | 1 | HTML | Curate by hand |
| 8 | Gal Parking, Green Parking, Maya Parking, other small operators | lot lists; prices often only as images or missing | dozens | HTML | Curate by hand (hotspots first) |
| 9 | Pango / Cello / Moovit | Payment apps. Benefit pages (Reading park & ride). **No public lot database.** | n/a | app-only | Encode their **offers** by hand |
| 10 | OpenStreetMap (Overpass) | 1,188 `amenity=parking` features in the TLV bbox, but only 99 named, 334 with a `fee` tag | geometry | ODbL (attribution) | Optional grey "unknown price" dots |
| 11 | TLV API portal (apiportal.tel-aviv.gov.il) | Search results say it has a REST API for Ahuzot lots | ? | Connection was reset from here | Revisit later; GIS covers the need |

### 1.2 Special offers found (seed for `offers.yaml`)

- **Reading East and West** (Rokach 7 / 15, about 800 spaces). Normally 36₪ per day, 75% off for residents. **Free for 24h** if you start parking with **Pango or Cello** and pay for a **bus ride in Tel Aviv with the same app on the same day** (Pango + Moovit also counts). **Sunday–Thursday only**, so it does *not* apply on Saturday. Sources: municipality Reading page; Cello terms.
- **Arlozorov park & ride** (Yaakov Dori, 250 spaces): 36₪ flat for 24h from entry, 75% off for residents.
- **Fast Lane park & ride** (Shapirim interchange, Hwy 1, about 3,800 spaces): **free parking plus free shuttles** 801 (Kirya), 803 (Rothschild), 802 (Ramat Gan). Sunday–Thursday 06:00–23:00, not on holidays or holiday eves. Outside TLV but aimed at TLV commuters.
- **Ahuzot resident discount**: 75% at 42 lots, 50% at 8, not stated at 38. **15 minutes free** at every Ahuzot lot.
- **"Near-home" lots** (44 in layer 488): free on nights and weekends for residents with a matching zone permit.
- **App-price discounts** at Central Park: 25–50% off the gate price. Example: Motzkin 8 on Saturday is 40₪ for the first hour at the gate and 20₪ in the app; daily max is 160₪ at the gate and 110₪ in the app.
- **Subscriptions (done 2026-10-11).** Central Park pages list monthly 24/7, night, Sun–Thu, motorcycle and reserved passes per lot; the city's GIS layer 488 type 4 lists night passes at private lots (₪180–645). Both are stored as `Lot.subscriptions` and ranked by `sub=night|full|…` in the API/MCP and the site (duration menu). Ahuzot publishes terms but no prices. City phone numbers and contact names are never copied.

### 1.3 Gotchas that shape the design

1. **The GIS tariff fields are stale, and the two layers are stale in different ways.**
   - Layer 970 says 16₪ first hour, +4₪ per quarter hour, 24₪ night.
   - Layer 488 says 20₪ / 5₪ / 30₪.
   - Ahuzot's site today says **24₪/h billed per minute, and a 36₪ flat entry** for evenings and Shabbat.
   - So never use GIS tariffs. Take prices from ahuzot.co.il.
2. **Ahuzot site IDs ≠ GIS `code_achoza`.** Join by name and address. An automatic join matched 87 of 88.
3. **29 of 88 Ahuzot lots publish no price** ("בהתאם לשילוט במקום", i.e. as per the sign). Show them with "price on sign" until someone enters the sign by hand.
4. **Tariff texts fall into 24 templates.** 5 templates cover 38 of the 59 priced lots; the other 21 lots are one-offs that are cheaper to hand-encode. So a regex parser plus a few hand-written JSON overrides is enough.
5. **Pricing rules depend on entry time.** "A car that enters on the hourly tariff pays hourly at exit." The flat entry is valid until 07:00 the next day, or for 24h from entry at park & ride lots. Billing is per minute, with a 15-minute grace period.
6. **Shabbat, holidays and holiday eves have their own rules.** Holiday eves usually follow Friday rules, and holidays follow Saturday rules. A Jewish calendar is needed (`@hebcal/core`, offline, Israel mode).
7. **Some lots are closed on Shabbat or block entry at certain hours.** For example, the Habima/HaTarbut lot blocks entry 20:00–21:00 Sunday–Thursday and Saturday. So opening hours and no-entry windows must be data fields.
8. **"Dizengoff" is a 3 km street.** The place resolver has to return the resolved point plus alternatives (Dizengoff Center, Dizengoff Square, north Dizengoff), and the tool has to echo back which one it used.
9. **Offers are conditional** on day of week, which app you pay with, riding public transport, and residency. Model them as data with conditions, not as free text.

### 1.4 The use case works with today's data

A rough run on the 2026-10-04 snapshot: **Saturday 14:00–17:00, non-resident, within 1.5 km of Dizengoff Center (Dizengoff 50).**

| Lot | Walk | Est. price | Why |
|---|---|---|---|
| HaTarbut / Habima (Huberman 1), 997 spaces | 560 m | **36₪** | Shabbat flat entry 07:00→07:00 |
| Tel-Nordau (Frishman 28) | 600 m | 36₪ | Shabbat flat entry |
| Dubnov | 780 m | 36₪ | Shabbat flat entry |
| Golda (Berkowitz 7), 937 spaces | 870 m | 36₪ | Shabbat flat entry |
| Bograshov 14 | 660 m | 72₪ | 24₪/h every day (and it was full at check time) |
| Central Park, Motzkin 8 | 1.6 km | ≈140₪ at gate / ≈70₪ in app | Saturday hourly rates |

TLV residents pay 9₪ or 18₪ at the Ahuzot lots (75% or 50% off). The Reading free-parking deal does **not** apply because it's a Saturday. This is exactly the answer the MCP tool should produce.

---

## 2. Architecture (all free tier)

```
GitHub repo (public)
├─ packages/core        zod schemas · price engine · day-type (hebcal) · geo utils   ← shared by everything
├─ packages/pipeline    fetchers + parsers  ──►  data/lots.json, data/offers.json, data/meta.json
│     ├─ TLV GIS layers 970/488/556          (daily)
│     ├─ ahuzot.co.il 88 lot pages, 1 req/s   (weekly + manual run)
│     └─ data/curated/*.yaml                  (hand-entered lots + offers)
├─ apps/web             Vite + MapLibre GL site (built into apps/worker/public)
└─ apps/worker          ONE Cloudflare Worker
      ├─ static assets: site + data/*.json            (free, unlimited)
      ├─ /mcp            MCP server (stateless createMcpHandler)
      ├─ /api/search, /api/lots/:id, /api/live         (JSON API for the site and non-MCP AIs)
      ├─ /openapi.json, /llms.txt
      └─ live status: fetch GIS layer 970 on request, cache 120 s (Cache API)

GitHub Actions: cron → run pipeline → validate → commit data (or open PR if suspicious) → wrangler deploy
```

**Why one Worker:** the site and the MCP use the *same* price engine and data, there's one deploy, and static assets cost nothing.

### Stack

- **TypeScript end to end**, so the price engine is shared by the pipeline, API, MCP and site. A pnpm workspace with Node 22 for the pipeline.
- **MCP:** `@modelcontextprotocol/server` v2 + `createMcpHandler` from `agents/mcp/server` (Cloudflare Agents SDK).
  - It's stateless, per the 2026-07-28 MCP revision, and needs no Durable Objects.
  - `McpAgent` is deprecated, so don't follow older tutorials that use it.
- **Map:** MapLibre GL JS + **OpenFreeMap** tiles (free, no API key), with OSM raster tiles as fallback.
- **Calendar:** `@hebcal/core` for Shabbat, holidays and holiday eves in Israel.
- **Validation and tests:** zod + vitest. "Golden" price cases go in tests, e.g. *Habima, Sat 14:00, 3h, non-resident = 36₪; resident = 9₪*.

### Free-tier budget

| Piece | Service | Free limit | Our need |
|---|---|---|---|
| Site, API, MCP | Cloudflare Workers Free | 100k Worker requests/day, 10 ms CPU per request; **static asset requests free and unlimited** | tiny |
| Live-status cache | Workers Cache API | free | — |
| Scheduled scraping | GitHub Actions | free on public repos | about 5 min/day |
| Optional user reports | D1 (5 GB, 5M rows read/day) or GitHub issue forms | free | — |
| Optional cron inside Cloudflare | Cron Triggers | 5 per account on Free | — |
| Domain | `*.workers.dev` | free | (own domain ≈ $10/yr, optional) |

The 10 ms CPU limit is fine for ~400 lots: filter by bounding box first, then price a handful of lots. If it ever pinches, precompute weekly price tables per lot, or fall back to Vercel Hobby or Netlify (both allow non-commercial use only).

---

## 3. Data model (sketch)

```ts
type Lot = {
  id: string;                         // "ahuzot-94", "cp-60", "lic-123", "osm-w123"
  name: { he: string; en?: string };
  operator: "ahuzot" | "central_park" | "dizengoff_center" | string;
  address: { he: string; en?: string };
  location: { lat: number; lng: number };
  spaces?: number;
  hours: OpeningRule[];               // incl. closed days and no-entry windows
  tariffs: TariffRule[] | null;       // null = "price on sign"
  tariff_text_he?: string;            // original text, always shown
  discounts: Discount[];              // resident 50/75%, app price, 15-min grace
  payment: ("credit" | "app" | "cash")[];
  accessible?: boolean;
  live?: { provider: "tlv-gis-970" | "centralpark"; key: string };
  sources: { url: string; fetched_at: string; hash: string }[];
  verified_at: string;
  confidence: "official" | "operator-site" | "curated" | "registry-only" | "osm";
};

type TariffRule = {
  days: ("sun"|"mon"|"tue"|"wed"|"thu"|"fri"|"sat"|"holiday_eve"|"holiday")[];
  entry_from: string; entry_to: string;           // "07:00" – "16:00" (by ENTRY time)
  kind: "per_minute" | "first_hour_then_step" | "flat_entry";
  rate_per_hour?: number;                         // per_minute
  first_hour?: number; step_minutes?: number; step_price?: number;
  flat_price?: number; valid_until?: "next_day_07:00" | { hours: number };
  daily_max?: number;
  channel?: "gate" | `app:${string}`;            // Central Park gate vs. app price
};

type Offer = {
  id: string; title: { he: string; en: string }; lot_ids: string[];
  when: { days: string[]; from?: string; to?: string };
  requires?: ("app:pango"|"app:cello"|"app:moovit"|"transit_ride_same_day"|"tlv_resident"|"zone_permit")[];
  effect: { kind: "free" | "percent_off" | "fixed_price"; value?: number; max_hours?: number };
  source_url: string; verified_at: string; valid_to?: string;
};
```

### Price engine

```
quote(lot, entry, minutes, profile) → { price | null, breakdown[], applied_offers[], potential_offers[], open_whole_stay, notes[] }
```

1. Classify the entry time's day type: weekday, Friday/holiday eve, or Shabbat/holiday (hebcal, Asia/Jerusalem).
2. Pick the tariff rule by **entry time**, then simulate to exit: per-minute billing, step pricing, flat-entry validity, daily caps.
3. Apply the grace period, the resident %, and the app price if the user has that app.
4. Apply qualifying offers. Also return `potential_offers` the user *could* use, e.g. "free if you take a bus, Sun–Thu".
5. Check opening hours and no-entry windows for the whole stay.

---

## 4. MCP server

- **Endpoint:** `https://<name>.workers.dev/mcp`.
- **Access:** read-only and authless ("No sign in" in Claude's connector dialog). Add a Cloudflare rate-limiting rule.

| Tool | Input | Output |
|---|---|---|
| `search_parking` | `near` (place/address, Hebrew or English) **or** `lat`/`lng`; `start` (ISO local time) **or** `weekday`+`time`; `duration_minutes` (default 120); `max_walk_m` (default 800); `tlv_resident`; `apps[]` (pango/cello/moovit/centralpark); `will_ride_public_transport`; `sort_by` (price/distance); `limit` | `resolved_location` (+ alternatives), `day_type`, and `results[]`. Each result: id, name, operator, walk_m, **price_ils or null**, breakdown, applied/potential offers, open for whole stay, live status, spaces, verified_at, source_url, **map_url** (deep link). Plus `caveats[]`. |
| `get_lot_details` | `id` | full structured tariffs + original Hebrew text, hours, offers, live status |
| `list_offers` | `day?`, `near?` | special deals with their conditions |
| `resolve_place` | `query` | candidate points (handles "Dizengoff" ambiguity), from GIS layer 527 plus a landmark list |

More details:

- **Tool annotations:** `readOnlyHint: true`. Results go in `structuredContent` with a short text summary.
- **Descriptions are written for LLMs:** "Times are Asia/Jerusalem; Shabbat and holiday tariffs differ; if the user gave no duration assume 2h and say so; prices at the gate prevail."
- **Plain REST mirror:** `/api/search` with `/openapi.json` and `/llms.txt`, for assistants that can't do MCP.

**Connecting clients:**

- **Claude (web, desktop, mobile):** Settings → Connectors → Add custom connector → paste the URL. The Free plan allows one custom connector.
- **Claude Code:** `claude mcp add --transport http tlv-parking https://<name>.workers.dev/mcp`
- **ChatGPT:** Developer mode → add the MCP server URL. Needs a paid plan.
- **Cursor, VS Code, Gemini CLI:** remote HTTP MCP config.
- **For development:** test with `npx @modelcontextprotocol/inspector`.

---

## 5. Website

**Map**
- Full-screen MapLibre map.
- **Dots colored by the computed price for the chosen time and duration** (default: now, 2h): green = cheap, red = expensive, grey = unknown.
- An outer ring shows live status (free / few / full).

**Top bar**
- Place search.
- Quick chips: Now · Tonight · Friday · **Saturday**.
- Duration picker.
- Toggles: "TLV resident" and "I'll ride a bus".

**Lot details** (side panel; bottom sheet on mobile)
- Name, operator, address.
- Live status with the time it was last updated.
- **Price for your time window, with a breakdown.**
- Full tariff table and the original Hebrew text.
- Opening hours and no-entry windows.
- Offers, payment methods, accessibility.
- Waze and Google Maps buttons.
- Source link and "last verified" date.
- "Report a wrong price" link (prefilled GitHub issue form).

**Also**
- List view sorted by price (same ranking as the MCP), for accessibility.
- Hebrew RTL first, with an English toggle.
- Deep links like `/?lot=ahuzot-94&when=2026-10-10T14:00&dur=180`. The MCP returns these so the AI can hand the user a map link.

---

## 6. Data pipeline

| Job | When | What |
|---|---|---|
| GIS layers 970 / 488 / 556 | daily | fetch → `data/raw/` → ids, coordinates, registry |
| Ahuzot site, 88 pages | weekly + manual | 1 request/second → parse. If a page's text hash changed: re-parse. Unknown template → open a "needs review" PR. |
| Central Park + Green | weekly, with Ahuzot | Central Park price lists (gate + app) from their lot pages (automation agreed with Central Park); Green Parking texts checked against hand-encoded tariffs |
| Curated YAML | on commit | Dizengoff Center, Azrieli, Sarona, Port, Gal, Green, Maya… + `offers.yaml` |
| Validate | every run | zod schema; price-jump guard (>50% change → PR instead of auto-commit); coverage report |
| Deploy | on data/code change | `cloudflare/wrangler-action` with an API-token secret |

**Live status isn't part of the pipeline.** The Worker reads layer 970 on demand and caches it for 120 s. The GIS also allows browser CORS, so the site can fall back to calling it directly.

**Merge and dedupe:**
1. Ahuzot site + GIS 970: join by name and address.
2. Then the license registry (556): treat a lot as a duplicate if it's within ~60 m and its name is similar.
3. Curated lots override everything.
4. OSM goes last, as optional grey dots.

---

## 7. Milestones (part-time, about 2 weeks to MVP)

| Milestone | Effort | Deliverable |
|---|---|---|
| **M0** Setup | ½ day | `git init` inside `parking/` (**right now this folder sits inside a git repo rooted at your home folder `C:\Users\COMPUTER`**); pnpm workspace; Cloudflare account; first "hello" Worker deployed |
| **M1** Ahuzot data | 1–2 days | pipeline: GIS + site → `lots.json` with coordinates, raw tariff text, ids, live-status key |
| **M2** Price engine | 2–3 days | tariff parser (5 templates + overrides), hebcal day types, quote(), golden tests |
| **M3** MCP | 1–2 days | 4 tools on Workers; tested with Inspector, Claude connector, Claude Code |
| **M4** Website | 2–3 days | map, filters, details panel, deep links, Hebrew/English |
| **M5** Coverage | ongoing | license-registry grey dots; ~20 hand-curated private lots at hotspots (Dizengoff Center, Azrieli, Sarona, Port, Rothschild, Carmel Market, Jaffa); email other operators for permission (Central Park already agreed); "report a price" flow |
| **M6** Extras | later | street (blue-and-white) parking rules (changed in 2025, needs its own research), EV charging, motorcycles |

---

## 8. Risks and mitigations

- **Prices change.** Store `verified_at` and a source link per lot, show "the sign at the gate prevails", and use text-hash change detection with review PRs.
- **The GIS or ahuzot.co.il may block GitHub or Cloudflare IPs.** Test in M1. Fallbacks: live status straight from the browser (CORS is open); run the pipeline as a scheduled task on your PC and push.
- **Terms of service.** Only scrape automatically from open data (TLV terms: reuse allowed with attribution) and Ahuzot (municipal company, no robots.txt), politely. Get private operators by permission or hand curation only. Central Park has given permission for automation. Credit "© OpenStreetMap contributors" if OSM is used.
- **Client limits.** Claude Free allows 1 custom connector, and ChatGPT needs a paid plan. That's why there's a REST/OpenAPI mirror.
- **MCP churn** (stateless 2026-07-28 revision). Use the official SDK v2 + Cloudflare handler, and test against several clients.
- **Public workflows go quiet.** GitHub disables cron in public repos after 60 days without activity, so keep an eye on it.

---

## 9. Decisions (2026-10-04)

1. **Hebrew-first** UI.
2. **Scrape private operators politely:** low frequency, honest user agent, cached. Central Park has explicitly agreed to automation.
3. **Free `*.workers.dev` address.**
4. **Public repo, no secrets exposed.**
   - The app itself needs no secrets.
   - The Cloudflare deploy token lives only in GitHub Actions secrets, set by the owner.
   - `.gitignore` covers `.env*`, `.dev.vars` and `.wrangler/`.
   - GitHub secret scanning and push protection stay on.
   - Personal contact names and emails from scraped pages are dropped before writing to the repo.
   - Commits use the GitHub noreply address instead of a personal email (pending confirmation).

---

## Sources

**Tel Aviv municipality and open data**
- TLV GIS layer 970: https://gisn.tel-aviv.gov.il/ArcGIS/rest/services/IView2/MapServer/970 (also layers 488, 556, 527 on the same service)
- TLV open-data terms: https://opendata.tel-aviv.gov.il/en/pages/faq.aspx
- TLV Reading hub page: https://www.tel-aviv.gov.il/Residents/Transportation/Pages/reading.aspx
- TLV parking arrangements: https://www.tel-aviv.gov.il/Residents/Transportation/Pages/ParkingArrangements.aspx

**Operators**
- Ahuzot lot list: https://www.ahuzot.co.il/Parking/All/ (lot pages: `/Parking/ParkingDetails/?ID=n`)
- Arlozorov park & ride: https://www.ahuzot.co.il/Parking/ParkingDetails/?ID=1
- Central Park: https://centralpark.co.il/ (lot example: https://centralpark.co.il/parking/60-מוצקין-8)
- Dizengoff Center parking: https://www.dizengof-center.co.il/useful-info/parking
- Green Parking lots: https://www.greenparking.co.il/רשימת-חניונים/
- Gal Parking: https://galparking.com/
- Maya Parking: https://mayaparking.co.il/

**Offers**
- Cello public-transport parking benefit: https://www.cello-app.com/pl_benefit_terms/
- Pango + Moovit benefit (2023): https://www.bizportal.co.il/general/news/article/811016
- Fast Lane park & ride: https://fastlane.co.il/park

**MCP and hosting**
- Cloudflare MCP handler: https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/
- MCP 2026-07-28 / McpAgent deprecation: https://bex.co/blog/2026/09/13/cloudflare-agents-sdk-stateless-mcp-handler
- Cloudflare pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare limits: https://developers.cloudflare.com/workers/platform/limits/
- Claude custom connectors: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- ChatGPT MCP (developer mode): https://designrevision.com/blog/add-mcp-server-to-chatgpt

**Prior art**
- https://github.com/chenmu10/tel-aviv-parking-map (live Ahuzot map, reads layer 970 straight from the browser)

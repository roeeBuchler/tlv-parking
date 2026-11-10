// Occupancy snapshot for production. The Worker can't read the city GIS (it blocks Cloudflare, HTTP 571),
// but GitHub Actions can, so Actions snapshots live status to public/live.json and ships it; the Worker
// falls back to it when its own live read fails (src/search.ts live()).
// ponytail: fresh only as of the last Actions run. Cadence is the live.yml cron, not per-request — no evasion.
import { writeFileSync } from "node:fs";
import { gisQuery } from "../src/places.ts";
import { snapshot } from "../src/search.ts";
import { fmtLocal } from "../src/engine.ts";

export async function snapshotLive() {
  const rows = await gisQuery(970, { where: "1=1", outFields: "code_achoza,status_chenyon,tr_status_chenyon" }, 15_000, 2);
  const out = { updated: fmtLocal(Date.now()), data: snapshot(rows) };
  writeFileSync("public/live.json", JSON.stringify(out) + "\n");
  const known = Object.values(out.data).filter((d) => d.status !== "unknown").length;
  console.log(`live snapshot: ${Object.keys(out.data).length} lots, ${known} with a status`);
  return out;
}

// run only when invoked directly (npm run live), not when build.ts imports snapshotLive
if (process.argv[1]?.endsWith("live.ts")) await snapshotLive();

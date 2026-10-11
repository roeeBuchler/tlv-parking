// Businesses and POIs in the TLV area for place search: Overture Maps places (always) + Foursquare OS Places (when HF_TOKEN is set:
// accept the dataset terms at huggingface.co/datasets/foursquare/fsq-os-places first) -> public/pois.tsv.
// One line per place, best first: "<normalized names, |-separated>\t<label>\t<lat>\t<lng>". src/places.ts searches it with indexOf.
import { writeFileSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";
import { norm } from "../src/places.ts";

const BOX = "BETWEEN 34.70 AND 34.90", BOY = "BETWEEN 32.00 AND 32.18"; // TLV-Yafo plus neighbours
const db = await (await DuckDBInstance.create()).connect();
await db.run("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';");
const rows = async (sql: string) => (await db.runAndReadAll(sql)).getRowObjectsJS() as Record<string, any>[];
const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

const ov = (await (await fetch("https://stac.overturemaps.org/catalog.json")).json() as any).latest;
const overture = await rows(`
  SELECT names.primary AS name, names.common['en'] AS en, names.common['he'] AS he, addresses[1].freeform AS addr,
    (bbox.ymin + bbox.ymax) / 2 AS lat, (bbox.xmin + bbox.xmax) / 2 AS lng
  FROM read_parquet('s3://overturemaps-us-west-2/release/${ov}/theme=places/type=place/*', hive_partitioning=1)
  WHERE bbox.xmin ${BOX} AND bbox.ymin ${BOY} AND coalesce(operating_status, '') <> 'permanently_closed' AND names.primary IS NOT NULL
  ORDER BY confidence DESC`);
console.log(`overture ${ov}: ${overture.length}`);

let fsq: Record<string, any>[] = [];
if (process.env.HF_TOKEN) {
  const tree = await (await fetch("https://huggingface.co/api/datasets/foursquare/fsq-os-places/tree/main/release")).json() as any[];
  const rel = tree.map((x) => x.path).sort().at(-1);
  await db.run(`CREATE SECRET (TYPE huggingface, TOKEN '${process.env.HF_TOKEN.replace(/'/g, "")}')`);
  fsq = await rows(`
    SELECT name, NULL AS en, NULL AS he, address AS addr, latitude AS lat, longitude AS lng
    FROM read_parquet('hf://datasets/foursquare/fsq-os-places/${rel}/places/parquet/*.parquet')
    WHERE country = 'IL' AND longitude ${BOX} AND latitude ${BOY} AND date_closed IS NULL AND name IS NOT NULL`);
  console.log(`foursquare ${rel}: ${fsq.length}`);
} else console.log("foursquare: skipped (no HF_TOKEN)");

// dedupe: same normalized name within ~100 m (Foursquare often repeats what Overture has)
const seen = new Map<string, [number, number][]>();
const lines: string[] = [];
for (const r of [...overture, ...fsq]) {
  const names = [...new Set([r.name, r.en, r.he].map((s) => norm(clean(s))).filter(Boolean))];
  const near = seen.get(names[0]) ?? [];
  if (near.some(([la, ln]) => Math.abs(la - r.lat) < 0.001 && Math.abs(ln - r.lng) < 0.001)) continue;
  seen.set(names[0], [...near, [r.lat, r.lng]]);
  const label = [...new Set([clean(r.name), clean(r.addr)])].filter(Boolean).join(", ");
  lines.push(`${names.join("|")}\t${label}\t${(+r.lat).toFixed(6)}\t${(+r.lng).toFixed(6)}`);
}
writeFileSync("public/pois.tsv", lines.join("\n") + "\n");
console.log(`public/pois.tsv: ${lines.length} places`);

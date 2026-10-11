import { test } from "node:test";
import assert from "node:assert/strict";
import { handleReports } from "../src/reports.ts";
import { liveFor, lots } from "../src/search.ts";
import { fmtLocal, localNow, MIN } from "../src/engine.ts";

test("liveFor: crowd report beats older GIS status, loses to newer GIS, fills lots without a feed", () => {
  const l = { id: "x", live_key: 7 } as any, none = { id: "y" } as any;
  const gis = { 7: { status: "free", updated: "2026-10-10T14:00" } };
  const crowd = { x: { status: "full", updated: "2026-10-10T14:10" } as const, y: { status: "free", updated: "2026-10-10T14:10" } as const };
  assert.equal(liveFor(l, gis, crowd)?.status, "full");
  assert.equal(liveFor(l, gis, crowd)?.source, "crowd");
  assert.equal(liveFor(l, { 7: { status: "few", updated: "2026-10-10T14:20" } }, crowd)?.status, "few");
  assert.equal(liveFor(none, {}, crowd)?.status, "free");
  assert.equal(liveFor(none, {}, {}), null);
});

// fake D1: one signed-in user who has filed `filed` reports today; records inserts
function env(filed = 0, user = true) {
  const inserts: unknown[][] = [];
  const DB = { prepare: (sql: string) => ({ bind: (...a: unknown[]) => ({
    first: async () => (sql.includes("FROM sessions") ? (user ? { id: 1, username: "u" } : null) : { n: filed }),
    run: async () => void inserts.push(a),
  }) }) };
  return { e: { DB }, inserts };
}
const post = (body: unknown) => new Request("https://x.test/api/reports", { method: "POST", headers: { cookie: `sid=${"a".repeat(64)}` }, body: JSON.stringify(body) });
const lot = lots.find((l) => l.tariffs)!, ago = (min: number) => fmtLocal(localNow() - min * MIN);

test("reports: needs sign-in, validates input, caps per day, stores the engine's quote", async () => {
  const price = { lot_id: lot.id, kind: "price", price: 40, entered_at: ago(180), minutes: 120 };
  assert.equal((await handleReports(post(price), env(0, false).e, "/api/reports"))!.status, 401);
  for (const bad of [{ ...price, lot_id: "nope" }, { ...price, kind: "x" }, { ...price, price: -1 }, { ...price, price: 5000 },
    { ...price, minutes: 0 }, { ...price, entered_at: ago(-60) }, { ...price, entered_at: ago(40 * 1440) }, { ...price, entered_at: "yesterday" }])
    assert.equal((await handleReports(post(bad), env().e, "/api/reports"))!.status, 400, JSON.stringify(bad));
  assert.equal((await handleReports(post(price), env(20).e, "/api/reports"))!.status, 429);
  const { e, inserts } = env();
  assert.equal((await handleReports(post(price), e, "/api/reports"))!.status, 201);
  assert.equal(inserts.length, 1);
  assert.equal(typeof inserts[0][4], "number"); // quoted
  assert.equal((await handleReports(post({ lot_id: lot.id, kind: "full" }), e, "/api/reports"))!.status, 201);
  assert.equal(await handleReports(post({}), e, "/api/other"), null);
});

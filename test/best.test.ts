// The "best for you" pick: price + walking, and blue-white as a gamble against the best lot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bestPick } from "../src/search.ts";

const lot = (id: string, price_ils: number | null, distance_m: number, more = {}) =>
  ({ id, name: id, price_ils, price_basis: "tariff", open_whole_stay: true, distance_m, live: null, ...more });
const cheapFar = lot("cheap-far", 36, 900), dearNear = lot("dear-near", 50, 100);

test("the walk setting decides between a cheap far lot and a dear near one", () => {
  assert.equal(bestPick([cheapFar, dearNear], null, "far")!.lot!.id, "cheap-far"); // 45 vs 51
  assert.equal(bestPick([cheapFar, dearNear], null, "normal")!.lot!.id, "dear-near"); // 63 vs 53
  assert.equal(bestPick([cheapFar, dearNear], null, "near")!.lot!.id, "dear-near");
});

test("only lots priced for sure, open the whole stay, within 1 km, and not full right now", () => {
  const skip = [lot("sign", null, 50), lot("unverified", 0, 50, { price_basis: "municipal_data_unverified" }),
    lot("closes", 0, 50, { open_whole_stay: false }), lot("far", 0, 1500), lot("full", 0, 50, { live: { status: "full" } })];
  assert.equal(bestPick([...skip, cheapFar], null, "far", true)!.lot!.id, "cheap-far");
  assert.equal(bestPick([lot("full", 0, 50, { live: { status: "full" } })], null, "normal", false)!.lot!.id, "full", "full now says nothing about tomorrow");
  assert.equal(bestPick(skip, null, "normal", true), null);
});

test("blue-white wins when a spot is likely, and keeps the lot as the fallback", () => {
  const likely = bestPick([dearNear], { price_ils: 0, chance_pct: 80 })!, unlikely = bestPick([dearNear], { price_ils: 25, chance_pct: 10 })!;
  assert.equal(likely.kind, "street");
  assert.equal(likely.lot!.id, "dear-near");
  assert.equal(unlikely.kind, "lot");
  assert.ok(unlikely.street_cost_ils! > unlikely.lot!.cost_ils);
  assert.equal(bestPick([], { price_ils: 0, chance_pct: 5 })!.kind, "street", "no lot: the street is the only option");
});

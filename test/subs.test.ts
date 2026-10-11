// Monthly / night passes: the data is sane and search ranks lots by the pass price, not the price of a stay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SUB_TYPES } from "../src/engine.ts";
import { lots, search, monthly, cheapestSub } from "../src/search.ts";

const base = { start: Date.parse("2026-10-10T14:00:00Z"), minutes: 120, origin: "http://x" };

test("every pass in the data is well formed", () => {
  const subs = lots.flatMap((l) => (l.subscriptions ?? []).map((s) => ({ l, s })));
  assert.ok(subs.length >= 40, `only ${subs.length} passes`);
  for (const { l, s } of subs) {
    assert.ok(SUB_TYPES.includes(s.type) && s.price_ils > 0 && ["month", "week"].includes(s.period), `${l.id} ${JSON.stringify(s)}`);
    assert.ok(s.source === "operator" ? l.operator === "centralpark" : s.source === "city", l.id);
  }
  assert.ok(subs.filter(({ s }) => s.type === "night").length >= 15);
  assert.equal(lots.filter((l) => l.operator === "private").every((l) => l.tariffs === null), true);
  assert.ok(!JSON.stringify(lots).includes("054-"), "no phone numbers from the city layer");
});

test("search with sub=night lists only lots selling it, cheapest pass first", async () => {
  const r = await search({ ...base, sub: "night" });
  assert.ok(r.count >= 15 && r.results.every((x) => x.subscription?.type === "night"));
  const prices = r.results.map((x) => monthly(x.subscription!));
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
  assert.ok(r.results[0].map_url.includes("dur=night"));
  assert.ok((await search(base)).count > r.count, "without sub every lot is still listed");
});

test("a weekly pass is ranked as 4.33 weeks; a lot's cheapest pass of a type wins", () => {
  assert.equal(monthly({ type: "full", period: "week", price_ils: 354, source: "operator" }), 1533);
  const l = { subscriptions: [{ type: "full", period: "month", price_ils: 1180 }, { type: "full", period: "month", price_ils: 1003 }] } as any;
  assert.equal(cheapestSub(l, "full")!.price_ils, 1003);
  assert.equal(cheapestSub(l, "night"), undefined);
});

// Golden price cases against the real data. If ahuzot.co.il changes a tariff, these fail on purpose.
import { test } from "node:test";
import assert from "node:assert/strict";
import { quote, parseLocal, type Lot, type Offer } from "../src/engine.ts";
import lotsJson from "../data/lots.json" with { type: "json" };
import offersJson from "../data/offers.json" with { type: "json" };

const lots = lotsJson as unknown as Lot[], offers = offersJson as unknown as Offer[];
const lot = (id: number) => lots.find((l) => l.id === `ahuzot-${id}`)!;
const q = (id: number, when: string, mins: number, profile = {}) => quote(lot(id), parseLocal(when), mins, profile, offers);
const SAT = "2026-10-10", SUN = "2026-10-04", TUE = "2026-10-06";

test("Habima (HaTarbut) – the plan's headline case", () => {
  assert.equal(q(94, `${SAT}T14:00`, 180).price_ils, 36); // Shabbat flat entry
  assert.equal(q(94, `${SAT}T14:00`, 180, { resident: true }).price_ils, 9); // 75% off
  assert.equal(q(94, `${SUN}T10:00`, 120).price_ils, 48); // 24/h by the minute
  assert.equal(q(94, `${SUN}T21:00`, 120).price_ils, 48); // entered on hourly -> hourly to exit
  assert.equal(q(94, `${SUN}T22:30`, 120).price_ils, 36); // night flat
  assert.equal(q(94, `${SUN}T23:00`, 600).price_ils, 36 + 48); // flat until 07:00, then hourly
  assert.equal(q(94, `${SUN}T10:00`, 10).price_ils, 0); // 15 min grace
  assert.equal(q(94, `${SUN}T20:30`, 60).can_enter, false); // no entry 20-21
});

test("Bograshov: hourly every day, 50% resident", () => {
  assert.equal(q(2, `${SAT}T14:00`, 180).price_ils, 72);
  assert.equal(q(2, `${SAT}T14:00`, 180, { resident: true }).price_ils, 36);
});

test("holidays and holiday eves", () => {
  assert.equal(q(4, "2026-09-21T10:00", 120).price_ils, 36); // Yom Kippur (Mon) -> Shabbat rules
  assert.equal(q(4, "2026-09-28T10:00", 120).price_ils, 48); // plain Monday
  assert.equal(q(16, "2027-04-21T10:00", 120).price_ils, 36); // Erev Pesach (Wed) -> Friday rules
  assert.equal(q(16, "2027-04-14T10:00", 120).price_ils, 48); // plain Wednesday
});

test("Reading: free with Pango/Cello + bus, Sun-Thu only", () => {
  const deal = { apps: ["pango"], transit: true };
  const tue = q(41, `${TUE}T09:00`, 480, deal);
  assert.equal(tue.price_ils, 0);
  assert.deepEqual(tue.applied_offers, ["reading-transit-free"]);
  assert.equal(q(41, `${SAT}T09:00`, 480, deal).price_ils, 36);
  assert.deepEqual(q(41, `${TUE}T09:00`, 480).potential_offers, ["reading-transit-free"]);
});

test("resident price lists, daily max, opening hours", () => {
  assert.equal(q(48, `${SUN}T09:00`, 300).price_ils, 52); // 20/h capped at 52/day
  assert.equal(q(48, `${SUN}T09:00`, 120, { resident: true }).price_ils, 13); // 6.5/h
  assert.equal(q(95, "2026-10-09T13:00", 120).open_whole_stay, false); // Fri closes 14:00
  assert.equal(q(95, `${SUN}T10:00`, 120).open_whole_stay, true);
});

test("per-sign lots: free per city data (unverified) vs unknown", () => {
  assert.equal(q(54, `${SUN}T10:00`, 120).price_ils, 0);
  assert.equal(q(54, `${SUN}T10:00`, 120).price_basis, "municipal_data_unverified");
  assert.equal(q(57, `${SUN}T10:00`, 120).price_ils, null); // street rate by day, residents in the evening
  assert.equal(q(133, `${SUN}T10:00`, 120).price_basis, "none");
});

const qq = (id: string, when: string, mins: number, profile = {}) => quote(lots.find((l) => l.id === id)!, parseLocal(when), mins, profile, offers);
test("Central Park: gate vs app price, opening hours", () => {
  const gate = qq("centralpark-22", `${SUN}T10:00`, 120), app = qq("centralpark-22", `${SUN}T10:00`, 120, { apps: ["centralpark"] });
  assert.deepEqual([gate.price_ils, gate.gate_price_ils, gate.app_price_ils], [30, 30, 20]); // 15/h gate, 10/h app
  assert.equal(app.price_ils, 20);
  assert.equal(qq("centralpark-22", `${SUN}T18:00`, 180).price_ils, 15); // evening single entry
  assert.equal(qq("centralpark-8", `${SAT}T10:00`, 120).open_whole_stay, false); // closed Fri-Sat
});

test("Green: tiered per-minute, Shabbat and evening flats", () => {
  assert.equal(qq("green-541", `${SUN}T10:00`, 120).price_ils, 45); // 60 x 0.35 + 60 x 0.40
  assert.equal(qq("green-541", `${SUN}T10:00`, 300).price_ils, 87); // daily max
  assert.equal(qq("green-541", `${SAT}T14:00`, 120).price_ils, 30); // Shabbat flat
  assert.equal(qq("green-1969", "2026-10-09T21:00", 120).price_ils, 15); // evening, Friday included
  assert.equal(qq("green-2142", `${SUN}T10:00`, 90).price_ils, 25 + 2 * 7); // first hour + 2 quarters
});

// Blue-white street parking: zone lookup, the city's published rates, and the chance estimate's direction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLocal } from "../src/engine.ts";
import { zoneAt, streetQuote, streetChance, AREA } from "../src/street.ts";

const p = (zone: number, when: string, mins: number, profile = {}) => streetQuote(zone, parseLocal(when), mins, profile).price_ils;
const TUE = "2026-10-06", FRI = "2026-10-09", SAT = "2026-10-10";
const HABIMA = { lat: 32.0725, lng: 34.7792 }, JAFFA_CLOCK = { lat: 32.0553, lng: 34.7563 };

test("zone lookup", () => {
  assert.equal(AREA[zoneAt(HABIMA)!], "center");
  assert.equal(AREA[zoneAt(JAFFA_CLOCK)!], "city");
  assert.equal(zoneAt({ lat: 31.77, lng: 35.21 }), null); // Jerusalem
});

test("visitor rates and paid hours", () => {
  const C = zoneAt(HABIMA)!, R = zoneAt(JAFFA_CLOCK)!;
  assert.equal(p(C, `${TUE}T10:00`, 120), 24.8); // 12.40/h
  assert.equal(p(R, `${TUE}T10:00`, 120), 14); // 7/h
  assert.equal(p(C, `${TUE}T20:00`, 120), 12.4); // centre paid until 21:00
  assert.equal(p(R, `${TUE}T18:00`, 120), 7); // elsewhere until 19:00
  assert.equal(p(C, `${TUE}T07:00`, 120), 12.4); // paid from 08:00
  assert.equal(p(C, `${FRI}T16:00`, 120), 12.4); // Friday until 17:00
  assert.equal(p(C, `${SAT}T12:00`, 240), 0); // Shabbat free
  assert.equal(p(C, "2026-09-21T10:00", 120), 0); // Yom Kippur
});

test("permit holders", () => {
  const C = zoneAt(HABIMA)!;
  assert.equal(p(C, `${TUE}T10:00`, 600, { zone: C }), 0); // own zone: free
  assert.equal(p(C, `${TUE}T10:00`, 180, { zone: 4 }), 8.68); // 2h free, then 30% off
  assert.equal(p(C, `${TUE}T10:00`, 120, { resident: true }), 0);
  assert.equal(streetQuote(C, parseLocal(`${TUE}T10:00`), 60, { zone: C }).permit, "own_zone");
});

test("chance estimate: bounded, lower when nearby lots are full", () => {
  const C = zoneAt(HABIMA)!, at = parseLocal(`${TUE}T10:00`);
  const quiet = streetChance(C, at, ["free", "free"]).chance_pct, none = streetChance(C, at).chance_pct;
  const busy = streetChance(C, at, ["full", "full", "few"]).chance_pct;
  assert.ok(quiet > none && none > busy, `${quiet} > ${none} > ${busy}`);
  for (const x of [quiet, none, busy]) assert.ok(x >= 5 && x <= 95);
  assert.ok(streetChance(zoneAt(JAFFA_CLOCK)!, at).chance_pct > none); // centre is harder
});

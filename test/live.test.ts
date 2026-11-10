// GIS occupancy rows -> { code_achoza: { status, updated } }, shared by the Worker and the Actions snapshot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { snapshot } from "../src/search.ts";

test("snapshot maps Hebrew status, keeps the GIS timestamp, and flags the unknown", () => {
  const got = snapshot([
    { code_achoza: 10, status_chenyon: "פנוי", tr_status_chenyon: 1762776000000 },
    { code_achoza: 11, status_chenyon: "מלא", tr_status_chenyon: 1762776000000 },
    { code_achoza: 12, status_chenyon: "משהו אחר" }, // unmapped + no timestamp
  ]);
  assert.equal(got[10].status, "free");
  assert.equal(got[11].status, "full");
  assert.equal(got[12].status, "unknown");
  assert.equal(got[12].updated, "");
  assert.match(got[10].updated, /^\d{4}-\d\d-\d\dT\d\d:\d\d$/);
});

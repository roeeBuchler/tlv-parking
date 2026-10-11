import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolvePlace, fromMapsLink, poiSearch } from "../src/places.ts";

const LINK = "https://www.google.com/maps/place/Nachmani/@32.0651024,34.7799142,18z/data=!4m6!3m5!1s0x151d4bd38809b8b3:0x5465038f99120a05!8m2!3d32.0651024!4d34.7776611!16s%2Fg%2F11ybnbvnm4!5m1!1e3?entry=ttu";

test("a pasted Google Maps link resolves to the pin, not the viewport", async () => {
  assert.deepEqual(await resolvePlace(LINK), [{ label: "Nachmani", lat: 32.0651024, lng: 34.7776611, source: "link" }]);
  assert.equal(fromMapsLink("https://www.google.com/maps/@32.1,34.8,15z")?.lat, 32.1);
  assert.equal(fromMapsLink("nachmani"), null);
});

test("share links (maps.app.goo.gl) follow one redirect; other URLs are never fetched", async (t) => {
  const fetched: string[] = [];
  t.mock.method(globalThis, "fetch", async (u: string | URL) => {
    fetched.push(String(u));
    return new Response(null, { status: 302, headers: { location: LINK } });
  });
  const pin = [{ label: "Nachmani", lat: 32.0651024, lng: 34.7776611, source: "link" }];
  assert.deepEqual(await resolvePlace("Nachmani https://maps.app.goo.gl/4dkgUdWsT1NzTkLB8"), pin);
  assert.deepEqual(await resolvePlace("https://evil.example/x"), []);
  assert.deepEqual(fetched, ["https://maps.app.goo.gl/4dkgUdWsT1NzTkLB8"]);
});

test("business names: the index first; OSM down doesn't fail a search the index answered", async (t) => {
  const pois = async () => "pilates nachmani\tPilates Nachmani, Nachmani St 39\t32.06526\t34.777849\n";
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 503 })); // Nominatim down
  assert.deepEqual(await resolvePlace("nachmani", pois), [{ label: "Pilates Nachmani, Nachmani St 39", lat: 32.06526, lng: 34.777849, source: "poi" }]);
  await assert.rejects(resolvePlace("nowhere", pois)); // nothing local either: the error reaches the user
});

test("local index (public/pois.tsv): businesses OSM lacks, fast enough for the Workers CPU limit", () => {
  const tsv = readFileSync("public/pois.tsv", "utf8");
  const t = performance.now();
  const he = poiSearch("קפה נחמני", tsv), en = poiSearch("pilates nachmani", tsv);
  assert.ok(performance.now() - t < 20);
  assert.match(he[0].label, /קפה נחמני 16/);
  assert.match(en[0].label, /Pilates Nachmani/);
  assert.equal(en[0].source, "poi");
  assert.deepEqual(poiSearch("x", tsv), []);
  assert.equal(poiSearch("café", "cafe x\tCafe X\t1\t2\nnoir café\tNoir\t3\t4")[0].label, "Noir"); // last line, no newline
});

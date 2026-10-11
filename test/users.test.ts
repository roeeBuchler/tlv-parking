import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "../src/users.ts";

test("password hash: salted, verifies, rejects wrong password", async () => {
  const a = await hashPassword("correct horse"), b = await hashPassword("correct horse");
  assert.notEqual(a, b); // random salt
  assert.equal(await verifyPassword("correct horse", a), true);
  assert.equal(await verifyPassword("correct hors", a), false);
});

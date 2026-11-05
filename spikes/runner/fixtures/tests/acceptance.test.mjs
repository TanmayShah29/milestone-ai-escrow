import test from "node:test";
import assert from "node:assert/strict";
import { rpc } from "/harness/target.mjs";
test("C1 add returns the sum", async () => {
  assert.equal(await rpc("add", [2, 3]), 5);
  assert.equal(await rpc("add", [-1, 1]), 0);
});
test("C2 slug lowercases and hyphenates", async () => {
  assert.equal(await rpc("slug", ["Hello World"]), "hello-world");
});

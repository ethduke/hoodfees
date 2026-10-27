import test from "node:test";
import assert from "node:assert/strict";
import { O1 } from "../lib/fees/catalog.mjs";
import { NATIVE } from "../lib/fees/model.mjs";
import { readO1Balances } from "../lib/fees/o1-balances.mjs";

const owner = `0x${"11".repeat(20)}`, asset = `0x${"22".repeat(20)}`, block = "0x123";
test("seven native O1 escrows use one explicit-recipient balance batch", async () => {
  let requests = 0;
  const result = await readO1Balances({
    async call() { assert.fail("unbatched balance read"); },
    async calls(calls, snapshot) {
      requests++;
      assert.equal(calls.length, O1.length);
      assert.equal(snapshot, block);
      calls.forEach((call, i) => {
        assert.equal(call.address, O1[i].address);
        assert.equal(call.functionName, "owed");
        assert.deepEqual(call.args, [owner, NATIVE]);
      });
      return calls.map((_, i) => BigInt(i));
    },
  }, owner, O1.map((target) => ({ target, currency: NATIVE })), block);
  assert.equal(requests, 1);
  assert.equal(result.length, 7);
  assert.equal(result[6].raw, 6n);
  assert.equal(result[0].target.version, "legacy");
});
test("saved O1 asset hints deduplicate by pinned escrow and asset before one refresh batch", async () => {
  let count = 0;
  const positions = [
    { target: O1[0].id, currency: asset },
    { target: O1[0], currency: asset },
    { target: O1[1].id, currency: asset },
  ];
  const result = await readO1Balances({ async calls(calls) { count++; assert.equal(calls.length, 2); return [3n, 0n]; } }, owner, positions, block);
  assert.equal(count, 1);
  assert.deepEqual(result.map(({ target, currency, raw }) => [target.id, currency, raw]), [[O1[0].id, asset, 3n], [O1[1].id, asset, 0n]]);
});
test("O1 batching fails closed for foreign targets and invalid results without exposing partial balances", async () => {
  const candidates = [{ target: O1[0], currency: asset }];
  for (const amounts of [[], [1], [-1n], [1n << 256n], [1n, 2n]]) {
    await assert.rejects(readO1Balances({ async calls() { return amounts; } }, owner, candidates, block), (error) => error.code === "invalid_response");
  }
  for (const target of ["other", { ...O1[0], address: asset }]) {
    await assert.rejects(readO1Balances({ async calls() { assert.fail("untrusted hint reached provider"); } }, owner,
      [{ target, currency: asset }], block), (error) => error.code === "invalid_request");
  }
});
test("O1 batch failures propagate without a second unbatched retry or mutation", async () => {
  const positions = [{ target: O1[0].id, currency: asset }], original = JSON.stringify(positions);
  const limited = Object.assign(new Error("rate_limited"), { code: "rate_limited", retryAfter: 9000 });
  await assert.rejects(readO1Balances({ async calls() { throw limited; }, async call() { assert.fail("retry bypassed rate limit"); } }, owner, positions, block), (error) => error === limited);
  assert.equal(JSON.stringify(positions), original);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readBankrIndex, BANKR_INDEX_CACHE_MS } from "../lib/fees/bankr-index.mjs";
import { LONG } from "../lib/fees/catalog.mjs";

const owner = `0x${"11".repeat(20)}`, other = `0x${"22".repeat(20)}`, token = `0x${"33".repeat(20)}`;
const body = (address = owner) => ({ address, chain: "base", tokens: [{ tokenAddress: token, poolId: `0x${"44".repeat(32)}`,
  chain: "robinhood", initializer: LONG.address, source: "doppler", claimable: { token0: "9999999" } }] });
const response = (address) => new Response(JSON.stringify(body(address)));

test("Bankr discovery deduplicates concurrent reads and caches only identity hints for five minutes", async (t) => {
  let calls = 0, finish, now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const fetcher = async () => { calls++; if (calls === 1) await new Promise((resolve) => { finish = resolve; }); return response(owner); };
  const first = readBankrIndex(owner, fetcher), second = readBankrIndex(owner, fetcher);
  assert.equal(calls, 1); finish();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b); assert.equal(calls, 1);
  assert.deepEqual(Object.keys(a.positions[0]).sort(), ["pool", "target", "token"]);
  a.positions[0].target = "unreviewed";
  assert.equal((await readBankrIndex(owner, fetcher)).positions[0].target, LONG.id);
  now += BANKR_INDEX_CACHE_MS - 1;
  await readBankrIndex(owner, fetcher); assert.equal(calls, 1);
  now++;
  await readBankrIndex(owner, fetcher); assert.equal(calls, 2);
});

test("Bankr discovery cache isolates wallets and injected fetchers", async () => {
  let calls = 0;
  const fetcher = async (url) => { calls++; return response(url.includes(other) ? other : owner); };
  await readBankrIndex(owner, fetcher); await readBankrIndex(other, fetcher);
  await readBankrIndex(owner, fetcher); assert.equal(calls, 2);
  let separate = 0;
  await readBankrIndex(owner, async () => { separate++; return response(owner); });
  assert.equal(separate, 1);
});

test("Failures are never cached and provider-directed Retry-After survives without upstream text", async () => {
  for (const failure of ["busy", "outage", "malformed", "network"]) {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      if (calls > 1) return response(owner);
      if (failure === "network") throw Error("PRIVATE_PROVIDER_SENTINEL");
      if (failure === "busy") return new Response("PRIVATE_PROVIDER_SENTINEL", { status: 429, headers: { "retry-after": "75" } });
      if (failure === "outage") return new Response("PRIVATE_PROVIDER_SENTINEL", { status: 503 });
      return new Response(JSON.stringify({ address: other, tokens: [] }));
    };
    await assert.rejects(readBankrIndex(owner, fetcher), (error) => {
      assert.equal(error.code, failure === "busy" ? "rate_limited" : failure === "malformed" ? "invalid_response" : "index_unavailable");
      assert.equal(error.message.includes("PRIVATE_PROVIDER_SENTINEL"), false);
      if (failure === "busy") assert.equal(error.retryAfter, 75_000);
      return true;
    });
    assert.equal((await readBankrIndex(owner, fetcher)).positions.length, 1);
    assert.equal(calls, 2);
  }
});

test("LRU eviction bounds process memory without limiting wallet discovery", async () => {
  let calls = 0;
  const fetcher = async (url) => { calls++; const wallet = new URL(url).pathname.split("/").at(-1); return response(wallet); };
  for (let index = 1; index <= 129; index++) await readBankrIndex(`0x${index.toString(16).padStart(40, "0")}`, fetcher);
  const first = `0x${"0".repeat(39)}1`;
  await readBankrIndex(first, fetcher);
  assert.equal(calls, 130);
});

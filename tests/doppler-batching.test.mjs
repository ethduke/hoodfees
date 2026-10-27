import test from "node:test";
import assert from "node:assert/strict";
import { dopplerPool, dopplerAmounts } from "../lib/fees/doppler-balances.mjs";
import { LONG, LONG_HOOK, BANKR_HOOK } from "../lib/fees/catalog.mjs";
import { poolId, NATIVE, ReadError } from "../lib/fees/model.mjs";

const owner = `0x${"11".repeat(20)}`, token = `0x${"22".repeat(20)}`;
const key = { currency0: NATIVE, currency1: token, fee: 3000, tickSpacing: 60, hooks: LONG.address };
const id = poolId(key), snapshot = { number: 10_000_000 };
function fixture(patch = {}) {
  const state = { requests: 0, batches: [], calls: [], pins: [], shares: 25n * 10n ** 16n, status: 2, hook: LONG_HOOK.address,
    initializer: LONG.address, poolKey: key, badBatch: false, ...patch };
  const value = (address, name) => {
    if (name === "getState") return [NATIVE, 0n, state.hook, "0x", state.status, state.poolKey, 0];
    if (name === "getPoolKey") return Object.values(state.poolKey);
    if (name === "INITIALIZER") return state.initializer;
    if (name === "getShares") return state.shares;
    if (name === "getCumulatedFees0") return 1000n;
    if (name === "getCumulatedFees1") return 2000n;
    if (name === "getLastCumulatedFees0") return 900n;
    if (name === "getLastCumulatedFees1") return 1800n;
    if (name === "collectFees") return [100n, 200n];
    throw Error("UNEXPECTED_FIXTURE_READ");
  };
  const rpc = {
    async verify(profile, block) { state.pins.push({ profile, block }); if (state.changed) throw new ReadError("contract_changed"); },
    async call(address, abi, name, args, block, from) {
      state.requests++; state.calls.push({ address, name, args, block, from });
      return value(address, name);
    },
    async calls(calls, block) {
      state.requests++; state.batches.push({ calls, block });
      return state.badBatch ? [] : calls.map((call) => value(call.address, call.functionName));
    },
  };
  return { rpc, state };
}
const position = (rpc, source = "bankr") => dopplerPool(rpc, id, token, "0x989680", source);
const amounts = (rpc, pool, patch = {}) => dopplerAmounts(rpc, { address: owner, source: "bankr", snapshot, ...patch }, pool);

test("Doppler eligible pool uses three reads, shares/checkpoints batch, wallet-from simulation stays separate", async () => {
  const { rpc, state } = fixture();
  const pool = await position(rpc);
  const result = await amounts(rpc, pool);
  assert.deepEqual(result.amounts, [50n, 100n]);
  assert.equal(result.target.id, LONG.id); assert.equal(result.migrated, false);
  assert.equal(state.requests, 3); assert.equal(state.batches.length, 1);
  assert.equal(state.batches[0].calls.length, 5);
  assert.ok(state.batches[0].calls.every((call) => call.functionName !== "collectFees"));
  assert.equal(state.calls.filter((call) => call.name === "getState").length, 1);
  const simulation = state.calls.find((call) => call.name === "collectFees");
  assert.equal(simulation.from, owner); assert.equal(simulation.block, "0x989680");
  assert.equal(simulation.address, LONG.address);
});

test("Bankr quote-only hook authenticates initializer and matching pool in the same getter batch", async () => {
  const { rpc, state } = fixture({ hook: BANKR_HOOK.address });
  const result = await amounts(rpc, await position(rpc), { feeTarget: BANKR_HOOK.id });
  assert.deepEqual(result.amounts, [50n, 100n]); assert.equal(result.target.id, BANKR_HOOK.id);
  assert.equal(state.requests, 3); assert.equal(state.batches[0].calls.length, 7);
  assert.ok(state.pins.some(({ profile }) => profile.id === BANKR_HOOK.id));
  assert.equal(state.calls.find((call) => call.name === "collectFees").address, BANKR_HOOK.address);
});

test("Unknown asset lookup batches both currency states and binds computed pool identity", async () => {
  const second = `0x${"33".repeat(20)}`, pair = { ...key, currency0: token, currency1: second };
  const { rpc, state } = fixture({ poolKey: pair }); const pool = await dopplerPool(rpc, poolId(pair), null, "0x989680", "bankr");
  assert.equal(pool.asset, token); assert.equal(state.requests, 2);
  assert.equal(state.batches[0].calls.length, 2);
  assert.ok(state.batches[0].calls.every((call) => call.functionName === "getState"));
});

test("Zero shares and migrated pools do not run collection simulation", async () => {
  for (const patch of [{ shares: 0n }, { status: 1 }]) {
    const { rpc, state } = fixture(patch); const result = await amounts(rpc, await position(rpc));
    assert.equal(result.amounts, null); assert.equal(result.migrated, patch.status === 1);
    assert.equal(state.calls.some((call) => call.name === "collectFees"), false);
  }
});

test("State reuse is isolated to RPC object and exact snapshot block", async () => {
  const { rpc, state } = fixture(); const pool = await position(rpc);
  await dopplerAmounts(rpc, { address: owner, source: "bankr", snapshot: { number: snapshot.number + 1 } }, pool);
  assert.equal(state.calls.filter((call) => call.name === "getState").length, 2);
  const other = fixture(); await amounts(other.rpc, pool);
  assert.equal(other.state.calls.filter((call) => call.name === "getState").length, 1);
});

test("Long requires the reviewed trading hook while Bankr source keeps its reviewed ledger route", async () => {
  const { rpc } = fixture({ hook: BANKR_HOOK.address });
  assert.equal(await position(rpc, "long"), null);
  const { rpc: supported, state } = fixture(); const result = await amounts(supported, await position(supported, "long"), { source: "long" });
  assert.deepEqual(result.amounts, [50n, 100n]);
  assert.ok(state.pins.some(({ profile }) => profile.address === LONG_HOOK.address));
});

test("Spoofed pool, changed code, invalid share and malformed batches fail closed", async () => {
  const scenarios = [
    { changed: true }, { shares: 2n * 10n ** 18n }, { shares: "1" }, { badBatch: true },
    { hook: BANKR_HOOK.address, initializer: token, target: BANKR_HOOK.id },
  ];
  for (const patch of scenarios) {
    const { rpc } = fixture(patch);
    await assert.rejects(async () => amounts(rpc, await position(rpc), { feeTarget: patch.target }), ReadError);
  }
  const { rpc } = fixture(); const pool = await position(rpc);
  await assert.rejects(amounts(rpc, { ...pool, id: `0x${"55".repeat(32)}` }), { code: "contract_changed" });
  await assert.rejects(amounts(rpc, pool, { feeTarget: "unreviewed" }), { code: "invalid_request" });
});

test("Batchless transport fallback retains owner, asset amounts and simulation boundary", async () => {
  const { rpc, state } = fixture(); delete rpc.calls;
  const result = await amounts(rpc, await position(rpc));
  assert.deepEqual(result.amounts, [50n, 100n]);
  assert.equal(state.requests, 7);
  assert.equal(state.calls.find((call) => call.name === "collectFees").from, owner);
});

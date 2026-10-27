import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, encodeFunctionResult } from "viem";
import { bagsIndexedBalance, bagsIndexedBalances, bagsPosition, verifyBagsDeployment } from "../lib/fees/bags.mjs";
import { bagsFeeAbi, bagsHookAbi } from "../lib/fees/abi.mjs";
import { BAGS, BAGS_FACTORY_IMPL, BAGS_FEE_IMPL, BAGS_BEACON, BAGS_HOOK, BAGS_FEE_PROXY_HASH, MULTICALL, WETH } from "../lib/fees/catalog.mjs";

const address = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const owner = address(1), other = address(2), snapshot = { number: 1000 };
const token = (n) => address(100 + n), fee = (n) => address(200 + n), curve = (n) => address(300 + n);
const pool = (n) => `0x${(400 + n).toString(16).padStart(64, "0")}`;
function fixture() {
  const state = { batches: [], previews: [], rpcRequests: 0, pins: new Set(), metadata: new Set(),
    changedProxy: false, badSlot: false, badImplementation: false, badWeth: false, badCurve: false,
    malformedBatch: false, previewDecrease: false, eligibility: new Map(), verified: [] };
  function value(c) {
    const i = Number(BigInt(c.address)) - 200;
    if (c.functionName === "feeShareForToken") return fee(Number(BigInt(c.args[0])) - 100);
    if (c.functionName === "curveForToken") return curve(Number(BigInt(c.args[0])) - 100);
    if (c.functionName === "implementation") return state.badImplementation ? other : BAGS_FEE_IMPL.address;
    if (c.functionName === "feeShareBeacon") return BAGS_BEACON.address;
    if (c.functionName === "hook") return BAGS_HOOK.address;
    if (c.functionName === "bondingCurve") return state.badCurve ? other : curve(i);
    if (c.functionName === "WETH") return state.badWeth ? other : WETH;
    if (c.functionName === "poolId") return pool(i);
    const eligibility = state.eligibility.get(i) ?? { owed: 10n, bps: 10000, partner: other };
    if (c.functionName === "claimable") { assert.deepEqual(c.args, [owner]); return eligibility.owed; }
    if (c.functionName === "claimerBps") { assert.deepEqual(c.args, [owner]); return eligibility.bps; }
    if (c.functionName === "PARTNER") return eligibility.partner;
    assert.fail(`Unexpected fixture getter ${c.functionName}`);
  }
  const rpc = {
    async verify(profile, block) {
      state.verified.push({ ...profile, block });
      if (state.changedProxy && profile.hash === BAGS_FEE_PROXY_HASH) throw Object.assign(new Error(), { code: "contract_changed" });
      const key = `${profile.address}:${profile.hash}:${block}`;
      if (!state.pins.has(key)) { state.pins.add(key); state.rpcRequests++; }
    },
    async send(method) {
      assert.equal(method, "eth_getStorageAt"); state.rpcRequests++;
      return `0x${"0".repeat(24)}${(state.badSlot ? other : BAGS_FACTORY_IMPL.address).slice(2)}`;
    },
    async calls(calls, block) {
      await rpc.verify(MULTICALL, block);
      state.rpcRequests++; state.batches.push(calls);
      return state.malformedBatch ? [] : calls.map(value);
    },
    async call(target, abi, name, args, block) {
      if (name !== "aggregate3") { state.rpcRequests++; return value({ address: target, abi, functionName: name, args }); }
      assert.equal(target, MULTICALL.address); assert.equal(block, "0x3e8");
      state.rpcRequests++;
      const [sweep, ledger] = args[0];
      assert.equal(sweep.target, BAGS_HOOK.address); assert.equal(sweep.allowFailure, true);
      assert.equal(ledger.allowFailure, false);
      const sweepArgs = decodeFunctionData({ abi: bagsHookAbi, data: sweep.callData });
      const ledgerArgs = decodeFunctionData({ abi: bagsFeeAbi, data: ledger.callData });
      assert.deepEqual(ledgerArgs.args, [owner]);
      const i = Number(BigInt(ledger.target)) - 200;
      assert.deepEqual(sweepArgs.args, [pool(i)]);
      state.previews.push(i);
      const notified = (state.eligibility.get(i) ?? { owed: 10n }).owed;
      return [{ success: true, returnData: "0x" }, { success: true,
        returnData: encodeFunctionResult({ abi: bagsFeeAbi, functionName: "claimable", result: state.previewDecrease ? notified - 1n : notified + 7n }) }];
    },
    async currency(currency, block) {
      const key = `${currency}:${block}`;
      if (!state.metadata.has(key)) { state.metadata.add(key); state.rpcRequests += 2; }
      return { currency, symbol: "WETH", decimals: 18, metadataVerified: true };
    },
  };
  return { state, rpc };
}
const hints = (count) => Array.from({ length: count }, (_, i) => ({ token: token(i), fee: fee(i) }));

test("Bags batches two candidates into two getter requests plus independent atomic previews", async () => {
  const { rpc, state } = fixture();
  const rows = await bagsIndexedBalances(rpc, owner, hints(2), snapshot);
  assert.equal(state.batches.length, 2); assert.deepEqual(state.batches.map((b) => b.length), [4, 14]);
  assert.deepEqual(state.previews, [0, 1]);
  assert.equal(state.rpcRequests, 9); // four eth_call + three cold code pins + two WETH metadata reads.
  assert.deepEqual(rows.map((r) => [r.token, r.position, r.raw, r.notifiedRaw, r.sweptRaw]), [
    [token(0), fee(0), "17", "10", "7"], [token(1), fee(1), "17", "10", "7"],
  ]);
  const prior = state.rpcRequests;
  await bagsIndexedBalances(rpc, owner, hints(2), snapshot);
  assert.equal(state.rpcRequests - prior, 4); // code and currency caches do not cache live eligibility reads.
  assert.ok(state.verified.some((p) => p.address === fee(0) && p.hash === BAGS_FEE_PROXY_HASH));
});

test("Bags deployment getters share one Multicall while both implementations remain checked", async () => {
  const { rpc, state } = fixture();
  await verifyBagsDeployment(rpc, "0x3e8");
  assert.equal(state.batches.length, 1); assert.equal(state.batches[0].length, 3);
  assert.equal(state.rpcRequests, 8); // six cold code pins, storage slot, one deployment Multicall.
  const prior = state.rpcRequests;
  await verifyBagsDeployment(rpc, "0x3e8");
  assert.equal(state.rpcRequests - prior, 2);
  state.badImplementation = true;
  await assert.rejects(verifyBagsDeployment(rpc, "0x3e8"), (error) => error.code === "contract_changed");
  state.badSlot = true;
  await assert.rejects(verifyBagsDeployment(rpc, "0x3e8"), (error) => error.code === "contract_changed");
});

test("Bags batch keeps removed recipient credits and partner entitlement but skips unrelated wallets", async () => {
  const { rpc, state } = fixture();
  state.eligibility.set(0, { owed: 10n, bps: 0, partner: other });
  state.eligibility.set(1, { owed: 0n, bps: 0, partner: owner });
  state.eligibility.set(2, { owed: 0n, bps: 0, partner: other });
  const rows = await bagsIndexedBalances(rpc, owner, hints(3), snapshot);
  assert.equal(rows[0].raw, "17"); assert.equal(rows[1].raw, "7"); assert.equal(rows[2], null);
  assert.deepEqual(state.previews, [0, 1]);
});

test("Bags authenticates every hint before previewing any candidate", async () => {
  for (const field of ["changedProxy", "badWeth", "badCurve", "malformedBatch"]) {
    const { rpc, state } = fixture(); state[field] = true;
    await assert.rejects(bagsIndexedBalances(rpc, owner, hints(2), snapshot), (error) => ["contract_changed", "invalid_response"].includes(error.code));
    assert.deepEqual(state.previews, []);
  }
  const { rpc, state } = fixture();
  await assert.rejects(bagsIndexedBalances(rpc, owner, [{ token: token(0), fee: other }], snapshot), (e) => e.code === "contract_changed");
  assert.deepEqual(state.previews, []);
});

test("Bags rejects malformed eligibility and decreasing sweep balances", async () => {
  for (const bps of [-1, 10001, NaN, "10000"]) {
    const { rpc, state } = fixture(); state.eligibility.set(0, { owed: 0n, bps, partner: other });
    await assert.rejects(bagsIndexedBalances(rpc, owner, hints(1), snapshot), (e) => e.code === "invalid_response");
    assert.deepEqual(state.previews, []);
  }
  const { rpc, state } = fixture(); state.previewDecrease = true;
  await assert.rejects(bagsIndexedBalance(rpc, owner, token(0), fee(0), snapshot), (e) => e.code === "invalid_response");
});

test("Bags bounds individual Multicall payloads without dropping later positions", async () => {
  const { rpc, state } = fixture();
  const rows = await bagsIndexedBalances(rpc, owner, hints(19), snapshot);
  assert.equal(rows.length, 19); assert.equal(rows.at(-1).token, token(18));
  assert.deepEqual(state.batches.map((b) => b.length), [38, 128, 5]);
  assert.equal(state.previews.length, 19);
});

test("Bags single-position and sequential compatibility paths keep the same identity", async () => {
  const { rpc } = fixture();
  delete rpc.calls;
  assert.deepEqual(await bagsPosition(rpc, token(0), fee(0), "0x3e8"), { token: token(0), fee: fee(0), pool: pool(0) });
  assert.equal((await bagsIndexedBalance(rpc, owner, token(0), fee(0), snapshot)).raw, "17");
  await assert.rejects(bagsIndexedBalances(rpc, owner, [hints(1)[0], hints(1)[0]], snapshot), (e) => e.code === "invalid_request");
});

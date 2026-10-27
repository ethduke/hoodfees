import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult, encodeEventTopics, encodeAbiParameters, parseAbi, toHex } from "viem";
import { scan } from "../lib/fees/engine.mjs";
import { BAGS, BAGS_BEACON, BAGS_FACTORY_IMPL, BAGS_FEE_IMPL, BAGS_HOOK, BANKR_HOOK, LONG, LONG_HOOK, WETH } from "../lib/fees/catalog.mjs";
import { bagsFeeAbi, longAbi } from "../lib/fees/abi.mjs";
import { bagsBalance, verifyBagsDeployment } from "../lib/fees/bags.mjs";
import { parseBagsIndex, readBagsIndex } from "../lib/fees/bags-index.mjs";
import { parseBankrIndex, readBankrIndex } from "../lib/fees/bankr-index.mjs";
import { claimPlan, validateQuote, claimKey } from "../lib/fees/claim-plan.mjs";
import { prepareClaim, confirmClaim, receiptPayouts } from "../lib/fees/claims.mjs";
import { open } from "../lib/fees/cursor.mjs";
import { ReadError, poolId, uniqueFeeRows, totals } from "../lib/fees/model.mjs";
import { ClaimController } from "../lib/wallet/claims.mjs";

const wallet = `0x${"11".repeat(20)}`, other = `0x${"22".repeat(20)}`;
const hash = `0x${"33".repeat(32)}`, txHash = `0x${"44".repeat(32)}`;
const secret = "fixture-" + "7".repeat(40);
const tokenAt = (i) => `0x${(4096 + i).toString(16).padStart(40, "0")}`;
const feeAt = (i) => `0x${(8192 + i).toString(16).padStart(40, "0")}`;
const indexAt = (address, start) => Number(BigInt(address)) - start;
const token = tokenAt(0), fee = feeAt(0);
const key = { currency0: token, currency1: WETH, fee: 3000, tickSpacing: 60, hooks: LONG.address };
const pool = poolId(key);
function fixture() {
  const state = { total: 1, notified: 10n, afterSweep: 17n, bps: 10000, eligible: new Set([0]), verified: [], calls: [],
    implementation: BAGS_FEE_IMPL.address, factoryImplementation: BAGS_FACTORY_IMPL.address,
    replacementFee: null, dopplerHook: LONG_HOOK.address, pendingLogs: [], rangeLimit: Infinity, head: 10_000_020n, receipt: null, transaction: null };
  const rpc = {
    async snapshot(confirmations = 20) { return { number: Number(state.head) - confirmations, hash, timestamp: 1 }; },
    async verify(profile, block) { state.verified.push({ ...profile, block }); },
    async currency(currency) { return { currency: currency.toLowerCase(), symbol: currency.toLowerCase() === WETH ? "WETH" : "TEST", decimals: 18, metadataVerified: true }; },
    async calls(calls, block) { return Promise.all(calls.map((c) => rpc.call(c.address, c.abi, c.functionName, c.args, block))); },
    async call(address, abi, name, args = [], block, from) {
      encodeFunctionData({ abi, functionName: name, args });
      state.calls.push({ address, name, args, block, from });
      if (name === "implementation") return state.implementation;
      if (name === "feeShareBeacon") return BAGS_BEACON.address;
      if (name === "hook") return BAGS_HOOK.address;
      if (name === "WETH") return WETH;
      if (name === "poolId") return pool;
      if (name === "curveForToken") return other;
      if (name === "bondingCurve") return other;
      if (name === "TOKEN") return token;
      if (name === "allTokensLength") return BigInt(state.total);
      if (name === "getTokens") return Array.from({ length: Number(args[1]) }, (_, i) => tokenAt(Number(args[0]) + i));
      if (name === "feeShareForToken") return state.replacementFee ?? feeAt(indexAt(args[0], 4096));
      if (name === "claimable") return state.eligible.has(indexAt(address, 8192)) ? state.notified : 0n;
      if (name === "claimerBps") return state.eligible.has(indexAt(address, 8192)) ? state.bps : 0;
      if (name === "PARTNER") return state.partner ?? other;
      if (name === "aggregate3") return [{ success: true, returnData: "0x" }, { success: true,
        returnData: encodeFunctionResult({ abi: bagsFeeAbi, functionName: "claimable", result: state.afterSweep }) }];
      if (name === "getState") return [WETH, 0n, state.dopplerHook, "0x", 2, key, 0];
      if (name === "getPoolKey") return [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks];
      if (name === "INITIALIZER") return LONG.address;
      if (name === "getShares") return 25n * 10n ** 16n;
      if (name === "getCumulatedFees0") return 1000n;
      if (name === "getCumulatedFees1") return 2000n;
      if (name === "getLastCumulatedFees0") return 900n;
      if (name === "getLastCumulatedFees1") return 1800n;
      if (name === "collectFees") return [100n, 200n];
      throw Error(`Unexpected read ${name}`);
    },
    async send(method, params) {
      state.calls.push({ method, params });
      if (method === "eth_chainId") return "0x1237";
      if (method === "eth_getBlockByNumber") return { hash };
      if (method === "eth_blockNumber") return toHex(state.head);
      if (method === "eth_getStorageAt") return `0x${"0".repeat(24)}${state.factoryImplementation.slice(2)}`;
      if (method === "eth_getLogs") {
        const filter = params[0];
        if (Number(BigInt(filter.toBlock) - BigInt(filter.fromBlock)) > state.rangeLimit) throw new ReadError("log_range");
        return state.pendingLogs.filter((l) => BigInt(l.blockNumber) >= BigInt(filter.fromBlock) && BigInt(l.blockNumber) <= BigInt(filter.toBlock));
      }
      if (method === "eth_call") return [LONG.address, BANKR_HOOK.address].includes(params[0].to.toLowerCase())
        ? encodeFunctionResult({ abi: longAbi, functionName: "collectFees", result: [100n, 200n] }) : "0x";
      if (method === "eth_estimateGas") return "0x186a0";
      if (method === "eth_getTransactionReceipt") return state.receipt;
      if (method === "eth_getTransactionByHash") return state.transaction;
      throw Error(`Unexpected method ${method}`);
    },
  };
  return { state, rpc, options: { secret, createRpc: () => rpc } };
}
const bankrBody = (patch = {}) => ({ address: wallet, chain: "base", tokens: [{ tokenAddress: token, poolId: pool,
  initializer: LONG.address, source: "doppler", chain: "robinhood", claimable: { token0: "9999999" }, ...patch }] });
async function quoteFor(source = "bags", f = fixture(), patch = {}) {
  const result = await scan({ address: wallet, source, scope: "balances" }, { ...f.options,
    indexFetcher: async () => new Response(JSON.stringify(bankrBody(patch))) });
  const row = result.balances[0];
  const quote = await prepareClaim({ address: wallet, claimHandle: row.claimHandle }, f.options);
  return { ...f, row, quote, result };
}
function claimedLog(unwrap = false, user = wallet) {
  return { address: fee, removed: false, blockHash: hash, transactionHash: txHash, blockNumber: toHex(10_000_000), logIndex: "0x0",
    topics: encodeEventTopics({ abi: bagsFeeAbi, eventName: "Claimed", args: { user } }),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "bool" }], [17n, unwrap]) };
}
const transferAbi = parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
function transferLog(to = wallet, value = 17n) {
  return { ...claimedLog(), address: WETH, logIndex: "0x1", topics: encodeEventTopics({ abi: transferAbi, eventName: "Transfer", args: { from: fee, to } }),
    data: encodeAbiParameters([{ type: "uint256" }], [value]) };
}
test("Bags scans the registry without an API, previews the sweep and issues wallet-bound WETH claims", async () => {
  const { state, row, quote } = await quoteFor();
  assert.equal(row.raw, "17"); assert.equal(row.notifiedRaw, "10"); assert.equal(row.sweptRaw, "7");
  assert.equal(quote.target, fee); assert.equal(quote.value, "0x0"); assert.equal(quote.chainId, 4663);
  assert.deepEqual(decodeFunctionData({ abi: bagsFeeAbi, data: quote.data }).args, [false]);
  assert.equal(validateQuote(quote, row, wallet).target, fee);
  assert.ok(state.verified.some((p) => p.address === BAGS_FEE_IMPL.address));
  const calls = state.calls.find((c) => c.name === "aggregate3").args[0];
  assert.equal(calls[0].target, BAGS_HOOK.address); assert.equal(calls[0].allowFailure, true);
  assert.equal(calls[1].allowFailure, false);
  assert.ok(state.calls.some((c) => c.method === "eth_call"));
  assert.equal((await open(row.claimHandle, wallet, "claim", secret)).row.position, fee);
  await assert.rejects(open(row.claimHandle, other, "claim", secret));
});
test("Bags pending-only fees become claimable through the atomic sweep preview; failed sweeps retain only notified balances", async () => {
  const f = fixture(); f.state.notified = 0n;
  assert.equal((await quoteFor("bags", f)).row.raw, "17");
  f.state.notified = 10n; f.state.afterSweep = 10n;
  const row = await bagsBalance(f.rpc, wallet, token, fee, await f.rpc.snapshot());
  assert.equal(row.raw, "10"); assert.equal(row.sweptRaw, "0");
});
test("Bags registry pagination retains every candidate and refreshes known fees after a completed checkpoint", async () => {
  const f = fixture(); f.state.total = 130; f.state.eligible = new Set([0, 127, 129]);
  let result = await scan({ address: wallet, source: "bags", scope: "balances" }, f.options);
  const rows = [...result.balances];
  assert.equal(result.coverage.complete, false); assert.equal(result.coverage.positionsChecked, 128);
  while (result.cursor) {
    result = await scan({ address: wallet, source: "bags", scope: "balances", cursor: result.cursor }, f.options);
    rows.push(...result.balances);
  }
  assert.equal(new Set(rows.map((r) => r.token)).size, 3);
  f.state.afterSweep = 22n; f.state.head++;
  result = await scan({ address: wallet, source: "bags", scope: "balances", checkpoint: result.checkpoint }, f.options);
  assert.equal(result.resetBalances, true); assert.equal(result.balances[0].raw, "22");
});
test("Bags implementation upgrades and registry substitutions block claims even when proxy runtime is unchanged", async () => {
  for (const field of ["implementation", "factoryImplementation"]) {
    const f = fixture(); f.state[field] = other;
    await assert.rejects(verifyBagsDeployment(f.rpc, "latest"), (e) => e.code === "contract_changed");
  }
  const f = await quoteFor(); f.state.replacementFee = other;
  await assert.rejects(prepareClaim({ address: wallet, claimHandle: f.row.claimHandle }, f.options), (e) => e.code === "contract_changed");
  for (const patch of [{ target: LONG.address }, { row: { ...f.quote.row, currency: other } }, { position: other }, { value: "0x1" }]) {
    assert.throws(() => validateQuote({ ...f.quote, ...patch }, f.row, wallet));
  }
  assert.throws(() => claimPlan({ ...f.row, currency: other }, wallet));
});
test("Bags zero balances have no claim handles, and inconsistent sweep previews fail closed", async () => {
  const f = fixture(); f.state.notified = 0n; f.state.afterSweep = 0n;
  const result = await scan({ address: wallet, source: "bags", scope: "balances" }, f.options);
  assert.equal(result.balances[0].raw, "0"); assert.equal(result.balances[0].claimHandle, undefined);
  f.state.notified = 10n;
  await assert.rejects(bagsBalance(f.rpc, wallet, token, fee, await f.rpc.snapshot()), (e) => e.code === "invalid_response");
});
test("Bags confirmation requires the exact owner event and actual WETH transfer, then waits for finality", async () => {
  const { quote, state, options } = await quoteFor();
  const receipt = { from: wallet, to: fee, status: "0x1", transactionHash: txHash, blockHash: hash,
    blockNumber: toHex(10_000_000), logs: [claimedLog(), transferLog()] };
  assert.equal(receiptPayouts(receipt, quote)[0].raw, "17");
  for (const logs of [[claimedLog()], [claimedLog(true), transferLog()], [claimedLog(false, other), transferLog()],
    [claimedLog(), transferLog(other)], [claimedLog(), transferLog(wallet, 16n)]]) assert.deepEqual(receiptPayouts({ ...receipt, logs }, quote), []);
  state.receipt = receipt; state.transaction = { hash: txHash, from: wallet, to: fee, input: quote.data, value: "0x0", blockHash: hash };
  state.head--;
  assert.equal((await confirmClaim({ address: wallet, authorization: quote.authorization, hash: txHash }, options)).status, "confirming");
  state.head++;
  assert.equal((await confirmClaim({ address: wallet, authorization: quote.authorization, hash: txHash }, options)).status, "confirmed");
});
test("Bags history authenticates emitting fee-shares through the factory and does not read current balances", async () => {
  const f = fixture(); f.state.pendingLogs = [claimedLog()];
  const result = await scan({ address: wallet, source: "bags", scope: "history" }, f.options);
  assert.equal(result.history.length, 1); assert.equal(result.history[0].raw, "17"); assert.equal(result.coverage.complete, true);
  assert.equal(f.state.calls.some((c) => ["claimable", "aggregate3", "allTokensLength"].includes(c.name)), false);
});
test("Bankr ignores API amounts and envelope chain, verifies pool identities and uses live beneficiary checkpoints", async () => {
  const { quote, row, state } = await quoteFor("bankr");
  assert.equal(row.source, "bankr"); assert.equal(quote.target, LONG.address);
  assert.deepEqual(quote.payouts.map((r) => r.raw), ["50", "100"]);
  assert.equal(claimKey(row), claimKey({ ...row, source: "long", currency: WETH }));
  assert.ok(state.verified.some((p) => p.address === LONG.address));
  assert.ok(state.verified.some((p) => p.address === BANKR_HOOK.address));
  assert.equal(parseBankrIndex(bankrBody({ chain: "base" }), wallet).positions.length, 0);
});
test("Bankr discovery excludes unreviewed managers, rejects foreign wallets and cannot authorize a spoofed pool", async () => {
  assert.equal(parseBankrIndex(bankrBody({ initializer: other }), wallet).excluded, true);
  assert.equal(parseBankrIndex(bankrBody({ feesContract: LONG_HOOK.address }), wallet).positions.length, 0);
  assert.throws(() => parseBankrIndex(bankrBody(), other));
  assert.throws(() => parseBankrIndex(bankrBody({ poolId: "bad" }), wallet));
  const f = fixture();
  await assert.rejects(scan({ address: wallet, source: "bankr", scope: "balances" }, { ...f.options,
    indexFetcher: async () => new Response(JSON.stringify(bankrBody({ poolId: hash }))) }), (e) => e.code === "invalid_response");
});
test("Bankr standard LP claims support different trading hooks without calling their swap callbacks", async () => {
  const f = fixture(); f.state.dopplerHook = other;
  const { quote } = await quoteFor("bankr", f);
  assert.equal(quote.target, LONG.address);
  assert.deepEqual(quote.payouts.map((r) => r.raw), ["50", "100"]);
  assert.equal(f.state.calls.some((c) => c.address === other), false);
});
test("Bankr quote-only claims use the reviewed hook ledger and verify its initializer and pool binding", async () => {
  const f = fixture(); f.state.dopplerHook = BANKR_HOOK.address;
  const { row, quote } = await quoteFor("bankr", f, { feesContract: BANKR_HOOK.address });
  assert.equal(row.target, BANKR_HOOK.id); assert.equal(quote.target, BANKR_HOOK.address);
  assert.equal(decodeFunctionData({ abi: longAbi, data: quote.data }).args[0], pool);
  assert.ok(f.state.calls.some((c) => c.address === BANKR_HOOK.address && c.name === "INITIALIZER"));
  assert.ok(f.state.calls.some((c) => c.address === BANKR_HOOK.address && c.name === "getPoolKey"));
  f.state.dopplerHook = other;
  await assert.rejects(prepareClaim({ address: wallet, claimHandle: row.claimHandle }, f.options), (e) => e.code === "contract_changed");
});
test("Bankr hook receipt payouts remain bound to the approved ledger, pool and beneficiary", async () => {
  const f = fixture(); f.state.dopplerHook = BANKR_HOOK.address;
  const { quote } = await quoteFor("bankr", f, { feesContract: BANKR_HOOK.address });
  const log = { ...claimedLog(), address: BANKR_HOOK.address,
    topics: encodeEventTopics({ abi: longAbi, eventName: "Release", args: { poolId: pool, beneficiary: wallet } }),
    data: encodeAbiParameters([{type:"uint256"},{type:"uint256"}], [0n,100n]),
  };
  const receipt = { blockHash: hash, transactionHash: txHash, blockNumber: log.blockNumber, logs: [log] };
  assert.deepEqual(receiptPayouts(receipt, quote).map((r)=>[r.currency,r.raw]), [[WETH,"100"]]);
  assert.deepEqual(receiptPayouts({...receipt,logs:[{...log,address:LONG.address}]}, quote), []);
});
test("Bankr lazy history resolves transferred beneficiary payouts without the creator index",async()=>{
  for(const target of [LONG,BANKR_HOOK]) {
    const f=fixture();f.state.dopplerHook=target.id===BANKR_HOOK.id?BANKR_HOOK.address:LONG_HOOK.address;
    f.state.pendingLogs=[{...claimedLog(),address:target.address,
      topics:encodeEventTopics({abi:longAbi,eventName:"Release",args:{poolId:pool,beneficiary:wallet}}),
      data:encodeAbiParameters([{type:"uint256"},{type:"uint256"}],[5n,7n])}];
    let indexCalls=0;
    const result=await scan({address:wallet,source:"bankr",scope:"history"},{...f.options,indexFetcher:async()=>{indexCalls++;throw new Error("must not query creator index");}});
    assert.equal(indexCalls,0);assert.equal(result.coverage.complete,true);
    assert.deepEqual(result.history.map(row=>[row.target,row.raw,row.position]),[[target.id,"5",pool],[target.id,"7",pool]]);
    assert.equal(f.state.calls.some(call=>call.name==="getShares"||call.name==="collectFees"),false);
  }
});
test("Bags durable checkpoints keep completed registry coverage and scan only newly added entries", async () => {
  const f = fixture();
  const first = await scan({address:wallet,source:"bags",scope:"balances"}, f.options);
  assert.equal(first.coverage.complete, true);
  f.state.total = 2; f.state.eligible.add(1); f.state.head++;
  const callBoundary = f.state.calls.length;
  let next = await scan({address:wallet,source:"bags",scope:"balances",checkpoint:first.checkpoint}, f.options);
  assert.equal(next.balances[0].token, token);
  while(next.cursor) next = await scan({address:wallet,source:"bags",scope:"balances",cursor:next.cursor}, f.options);
  assert.equal(next.coverage.positionsChecked, 2);
  const registryReads = f.state.calls.slice(callBoundary).filter((c)=>c.name==="getTokens");
  assert.deepEqual(registryReads.map((c)=>c.args), [[1n,1n]]);
});
test("Bags history renewals keep queued payouts and completed event ranges", async () => {
  const f = fixture();
  f.state.pendingLogs = Array.from({length:3},(_,i)=>({...claimedLog(),logIndex:toHex(i)}));
  const first = await scan({address:wallet,source:"bags",scope:"history"}, f.options);
  assert.equal(first.history.length,2); assert.equal(first.coverage.complete,false);
  f.state.head++;
  const boundary = f.state.calls.length;
  const next = await scan({address:wallet,source:"bags",scope:"history",checkpoint:first.checkpoint}, f.options);
  assert.equal(next.history.length,1); assert.equal(next.history[0].id.includes(":2:"),true);
  const final = await scan({address:wallet,source:"bags",scope:"history",cursor:next.cursor}, f.options);
  assert.equal(final.coverage.complete,true);
  const ranges = f.state.calls.slice(boundary).filter((c)=>c.method==="eth_getLogs");
  assert.equal(ranges.length,1);
  assert.equal(ranges[0].params[0].fromBlock,toHex(10_000_001));
});
test("Bankr upstream failures stay fixed-code errors and never become successful empty results", async () => {
  await assert.rejects(readBankrIndex(wallet, async () => { throw Error("private upstream details"); }), (e) => e.code === "index_unavailable" && !e.message.includes("private"));
  await assert.rejects(readBankrIndex(wallet, async () => new Response("private", { status: 429 })), (e) => e.code === "rate_limited");
});
test("shared Bankr/Long balances and payout events contribute only once regardless of source order", () => {
  const row = { id: `${LONG.id}:${pool}:${WETH}:available`, target: LONG.id, position: pool, currency: WETH, raw: "10", decimals: 18, source: "long" };
  for (const rows of [[row, { ...row, source: "bankr" }], [{ ...row, source: "bankr" }, row]]) {
    assert.equal(uniqueFeeRows(rows).length, 1); assert.equal(uniqueFeeRows(rows)[0].source, "bankr");
    assert.equal(totals(uniqueFeeRows(rows))[0].raw, "10");
  }
});
test("new venue progress remains account/scope-bound and a reorg invalidates resumed data", async () => {
  const f = fixture(); f.state.total = 130;
  const result = await scan({ address: wallet, source: "bags", scope: "balances" }, f.options);
  for (const patch of [{ address: other }, { source: "bankr" }, { scope: "history" }])
    await assert.rejects(scan({ address: wallet, source: "bags", scope: "balances", cursor: result.cursor, ...patch }, f.options));
  const original = f.rpc.send;
  f.rpc.send = (method, params) => method === "eth_getBlockByNumber" ? { hash: txHash } : original(method, params);
  await assert.rejects(scan({ address: wallet, source: "bags", scope: "balances", cursor: result.cursor }, f.options), (e) => e.code === "snapshot_changed");
});
test("Bags browser preflight checks the live implementation before any wallet send", async () => {
  const f = await quoteFor();
  let sends = 0;
  const session = { address: wallet, provider: { async request({ method }) {
    if (method === "eth_accounts") return [wallet];
    if (method === "eth_chainId") return "0x1237";
    if (method === "eth_getCode") return "0xabcd";
    if (method === "eth_getStorageAt") return `0x${"0".repeat(24)}${other.slice(2)}`;
    if (method === "eth_sendTransaction") { sends++; return txHash; }
    throw Error("Unexpected wallet read");
  } } };
  const profiles = [BAGS, BAGS_FACTORY_IMPL, BAGS_BEACON, BAGS_FEE_IMPL, BAGS_HOOK];
  let verified = 0;
  const controller = new ClaimController({ getSession: () => session, notify() {}, refresh() {},
    hashCode: () => profiles[verified++].hash, fetcher: async () => new Response(JSON.stringify(f.quote)) });
  await controller.begin(f.row); assert.equal(controller.state.phase, "review");
  await controller.send(); assert.equal(controller.state.error, "contract_changed"); assert.equal(sends, 0);
});

const bagsKey = "fixture-bags-index-key";
const bagsBody = (indices = [0], patch = {}) => ({ success: true, response: {
  positions: indices.map((i) => ({ version: "v2", token: { address: tokenAt(i), feeShare: feeAt(i) },
    feeShare: feeAt(i), claimableWei: "999999999999", actionableWei: "999999999999", isClaimer: false, isPartner: false })),
  truncated: false, ...patch,
} });

test("Bags wallet index checks only the returned candidate, with onchain eligibility, balance and claim authority", async () => {
  const f = fixture(); f.state.total = 4446;
  let requests = 0;
  const options = { ...f.options, bagsKey, indexFetcher: async function(url, settings) {
    requests++;
    assert.equal(this, globalThis);
    assert.equal(url, `https://public-api-v2.bags.fm/api/v1/evm/rh/claimable-positions?owner=${wallet}`);
    assert.equal(settings.headers["x-api-key"], bagsKey); assert.equal(settings.redirect, "manual");
    assert.equal(settings.credentials, "omit"); assert.equal(settings.cache, "no-store");
    return Response.json(bagsBody());
  } };
  const result = await scan({ address: wallet, source: "bags", scope: "balances" }, options);
  assert.equal(requests, 1); assert.equal(result.discovery, "wallet-index"); assert.equal(result.coverage.complete, true);
  assert.equal(result.balances[0].raw, "17"); assert.equal(result.coverage.positionsChecked, 1);
  assert.equal(f.state.calls.filter((call) => ["getTokens", "allTokensLength"].includes(call.name)).length, 0);
  assert.ok(f.state.calls.some((call) => call.name === "claimerBps"));
  const quote = await prepareClaim({ address: wallet, claimHandle: result.balances[0].claimHandle }, f.options);
  assert.equal(quote.target, fee); assert.equal(quote.value, "0x0");
  assert.deepEqual(decodeFunctionData({ abi: bagsFeeAbi, data: quote.data }).args, [false]);
});

test("Bags index flags and amounts cannot create a fee for an unrelated wallet", async () => {
  const f = fixture(); f.state.eligible.clear(); f.state.notified = 0n;
  const result = await scan({ address: wallet, source: "bags", scope: "balances" }, { ...f.options, bagsKey,
    indexFetcher: async () => Response.json(bagsBody()) });
  assert.equal(result.coverage.complete, true); assert.deepEqual(result.balances, []);
  assert.equal(f.state.calls.some((call) => call.name === "aggregate3"), false);
});

test("Bags index retains the onchain credited balance of a removed claimer", async () => {
  const f = fixture(); f.state.bps = 0; f.state.afterSweep = f.state.notified;
  const result = await scan({ address: wallet, source: "bags", scope: "balances" }, { ...f.options, bagsKey,
    indexFetcher: async () => Response.json(bagsBody()) });
  assert.equal(result.balances[0].raw, "10"); assert.ok(result.balances[0].claimHandle);
});

test("Bags index candidates drain over saved pages without rereading the index or registry", async () => {
  const f = fixture(); f.state.total = 4446; f.state.eligible = new Set([0,1,2,3,4]);
  let requests = 0;
  const options = { ...f.options, bagsKey, indexFetcher: async () => { requests++; return Response.json(bagsBody([0,1,2,3,4])); } };
  let result = await scan({ address: wallet, source: "bags", scope: "balances" }, options);
  assert.equal(result.coverage.complete, false); assert.equal(result.coverage.positionsChecked, 2);
  const rows = [...result.balances];
  while (result.cursor) { result = await scan({ address: wallet, source: "bags", scope: "balances", cursor: result.cursor }, options); rows.push(...result.balances); }
  assert.equal(rows.length, 5); assert.equal(requests, 1); assert.equal(result.coverage.positionsChecked, 5);
  assert.equal(f.state.calls.some((call) => call.name === "getTokens"), false);
});

test("Bags legacy registry checkpoints adopt the index and preserve unfinished registry ranges for fallback", async () => {
  const f = fixture(); f.state.total = 512;
  const first = await scan({ address: wallet, source: "bags", scope: "balances" }, f.options);
  assert.equal(first.coverage.positionsChecked, 128);
  const boundary = f.state.calls.length;
  const indexed = await scan({ address: wallet, source: "bags", scope: "balances", cursor: first.cursor }, { ...f.options, bagsKey,
    indexFetcher: async () => Response.json(bagsBody()) });
  assert.equal(indexed.coverage.complete, true); assert.equal(indexed.balances[0].token, token);
  assert.equal(f.state.calls.slice(boundary).some((call) => call.name === "getTokens"), false);
  f.state.head++;
  let fallback = await scan({ address: wallet, source: "bags", scope: "balances", checkpoint: indexed.checkpoint }, f.options);
  while (fallback.cursor) fallback = await scan({ address: wallet, source: "bags", scope: "balances", cursor: fallback.cursor }, f.options);
  const registryReads = f.state.calls.slice(boundary).filter((call) => call.name === "getTokens");
  assert.deepEqual(registryReads.map((call) => call.args), [[256n,128n],[128n,128n],[0n,128n]]);
});

test("Bags refresh verifies known positions even when the latest index omits them", async () => {
  const f = fixture(); let body = bagsBody();
  const options = { ...f.options, bagsKey, indexFetcher: async () => Response.json(body) };
  const first = await scan({ address: wallet, source: "bags", scope: "balances" }, options);
  body = bagsBody([]); f.state.head++; f.state.afterSweep = 22n;
  const result = await scan({ address: wallet, source: "bags", scope: "balances", checkpoint: first.checkpoint }, options);
  assert.equal(result.resetBalances, true); assert.equal(result.balances[0].raw, "22");
  assert.equal(result.coverage.complete, true); assert.equal(result.coverage.positionsChecked, 1);
  assert.equal(f.state.calls.some((call) => call.name === "getTokens"), false);
});

test("a truncated Bags index cannot replace exhaustive registry coverage with a false empty result", async () => {
  const f = fixture(); f.state.total = 257;
  let requests = 0;
  const options = { ...f.options, bagsKey, indexFetcher: async () => { requests++; return Response.json(bagsBody([], {truncated:true})); } };
  let result = await scan({ address: wallet, source: "bags", scope: "balances" }, options);
  assert.equal(result.discovery, "onchain-registry"); assert.equal(result.coverage.complete, false);
  assert.ok(result.warnings.includes("bags_index_truncated"));
  const rows = [...result.balances];
  while (result.cursor) { result = await scan({ address: wallet, source: "bags", scope: "balances", cursor: result.cursor }, options); rows.push(...result.balances); }
  assert.equal(requests, 1); assert.equal(result.coverage.positionsChecked, 257);
  assert.equal(rows[0].token, token); assert.equal(result.coverage.complete, true);
});

test("Bags index cannot substitute fee-share bindings or survive a pinned implementation change", async () => {
  for (const field of ["replacementFee", "implementation"]) {
    const f = fixture(); f.state[field] = other;
    await assert.rejects(scan({ address: wallet, source: "bags", scope: "balances" }, { ...f.options, bagsKey,
      indexFetcher: async () => Response.json(bagsBody()) }), e => e.code === "contract_changed");
  }
});

test("Bags history remains on demand and never calls the wallet discovery index", async () => {
  const f = fixture(); f.state.pendingLogs = [claimedLog()];
  const result = await scan({ address: wallet, source: "bags", scope: "history" }, { ...f.options, bagsKey,
    indexFetcher: async () => assert.fail("history must not use the wallet index") });
  assert.equal(result.history.length, 1); assert.equal(f.state.calls.some((call) => call.name === "getTokens"), false);
});

test("Bags index parser rejects malformed, foreign and conflicting identities, and explicitly excludes v1", () => {
  const snapshot = 10_000_000;
  for (const body of [
    { success:false, response:{} }, bagsBody([], { owner:other }), bagsBody([], { chainId:1 }),
    bagsBody([], { truncated:"false" }), bagsBody([], { truncated:undefined }),
    bagsBody([], { positions:[{version:"v2",token:{address:token},feeShare:"bad"}] }),
    bagsBody([], { positions:[{version:"v2",token:{address:token,feeShare:other},feeShare:fee}] }),
    bagsBody([], { positions:[{version:"v2",token:{address:token,chainId:1},feeShare:fee}] }),
    bagsBody([], { positions:[{version:"unknown",token:{address:token},feeShare:fee}] }),
    bagsBody([], { positions:[...bagsBody().response.positions,{version:"v2",token:{address:token},feeShare:other}] }),
  ]) assert.throws(() => parseBagsIndex(body,wallet,snapshot), e => e.code === "invalid_response");
  const legacy = parseBagsIndex(bagsBody([], {positions:[{version:"v1"}]}),wallet,snapshot);
  assert.equal(legacy.legacy,true); assert.deepEqual(legacy.positions,[]);
  const future = bagsBody(); future.response.positions[0].token.createdAtBlock = snapshot + 1;
  assert.deepEqual(parseBagsIndex(future,wallet,snapshot).positions,[]);
});

test("Bags index outages, rejected credentials and malformed bodies never leak upstream text or become empty success", async () => {
  const sentinel = "synthetic-upstream-secret-sentinel";
  for (const fetcher of [
    async () => { throw Error(sentinel); },
    async () => new Response(sentinel,{status:401}),
    async () => new Response(sentinel,{status:503}),
    async () => new Response(sentinel),
  ]) await assert.rejects(readBagsIndex(wallet,10_000_000,bagsKey,fetcher), e =>
    ["index_unavailable","invalid_response"].includes(e.code) && !e.message.includes(sentinel));
  await assert.rejects(readBagsIndex(wallet,10_000_000,bagsKey,async () => new Response(sentinel,{status:429})), e => e.code === "rate_limited");
  const f = fixture();
  await assert.rejects(scan({address:wallet,source:"bags",scope:"balances"},{...f.options,bagsKey,
    indexFetcher:async () => new Response(sentinel,{status:503})}), e => e.code === "index_unavailable");
  assert.equal(f.state.calls.some(call => call.name === "getTokens"),false);
});

test("Bags index discovers an onchain partner before any fees have been notified", async () => {
  const f=fixture();f.state.eligible.clear();f.state.notified=0n;f.state.partner=wallet;
  const result=await scan({address:wallet,source:"bags",scope:"balances"},{...f.options,bagsKey,
    indexFetcher:async()=>Response.json(bagsBody())});
  assert.equal(result.balances[0].raw,"17");assert.equal(result.balances[0].notifiedRaw,"0");
  assert.ok(result.balances[0].claimHandle);
});

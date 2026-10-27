import test from "node:test";
import assert from "node:assert/strict";
import { encodeEventTopics, encodeAbiParameters, encodeFunctionResult, decodeFunctionData, parseAbi, toHex } from "viem";
import { PAIR, SOURCE_INFO } from "../lib/fees/catalog.mjs";
import { pairAbi } from "../lib/fees/abi.mjs";
import { parsePairIndex, readPairIndex } from "../lib/fees/pair-index.mjs";
import { pairReceiptEntries } from "../lib/fees/pair.mjs";
import { scan } from "../lib/fees/engine.mjs";
import { claimPlan, validateQuote } from "../lib/fees/claim-plan.mjs";
import { prepareClaim, confirmClaim, receiptPayouts } from "../lib/fees/claims.mjs";
import { open } from "../lib/fees/cursor.mjs";
import { ScanCache } from "../lib/wallet/scan-cache.mjs";
import { ClaimController } from "../lib/wallet/claims.mjs";
import { NATIVE, ReadError, topicAddress } from "../lib/fees/model.mjs";
const wallet = `0x${"11".repeat(20)}`, other = `0x${"22".repeat(20)}`;
const asset = `0x${"33".repeat(20)}`, hash = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const secret = "fixture-" + "p".repeat(40), start = PAIR.start;
const hint = (currency = asset, locker = PAIR.address) => ({ lockerAddress: locker, claimAssetAddress: currency,
  claimableAmount: "999999999999999", claimFunction: "approve", quoteToken: { address: other, symbol: "UNTRUSTED", decimals: 0 } });
const transferAbi = parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
function receipt(height = start + 5, paid = 7n) {
  const base = { removed: false, blockHash: hash(height), transactionHash: hash(999), blockNumber: toHex(height) };
  return { status: "0x1", from: wallet, to: PAIR.address, transactionHash: base.transactionHash,
    blockHash: base.blockHash, blockNumber: base.blockNumber, logs: [
      { ...base, address: PAIR.address, logIndex: "0x2", topics: encodeEventTopics({ abi: pairAbi,
        eventName: "FeesClaimed", args: { recipient: wallet, asset } }), data: encodeAbiParameters([{ type: "uint256" }], [paid]) },
      { ...base, address: asset, logIndex: "0x1", topics: encodeEventTopics({ abi: transferAbi,
        eventName: "Transfer", args: { from: PAIR.address, to: wallet } }), data: encodeAbiParameters([{ type: "uint256" }], [paid]) },
    ] };
}
function fixture() {
  const state = { height: start + 100, raw: 7n, verified: [], calls: [], queries: [], hints: [hint()], receipts: [receipt()], indexRequests: 0 };
  const rpc = {
    async verify(target) { state.verified.push(target.id); },
    async snapshot(confirmations = 20) { const number = state.height - confirmations; return { number, hash: hash(number), timestamp: 1 }; },
    async currency(currency) { return { currency, symbol: "CHAIN", decimals: 18, metadataVerified: true }; },
    async prefetchCurrencies() {},
    async calls(calls) { state.calls.push(calls); return calls.map((call) => {
      assert.equal(call.address, PAIR.address); assert.equal(call.functionName, "claimable"); assert.equal(call.args[0], wallet); return state.raw;
    }); },
    async send(method, params) {
      if (method === "eth_chainId") return "0x1237";
      if (method === "eth_blockNumber") return toHex(state.height);
      if (method === "eth_getBlockByNumber") return { hash: hash(Number(BigInt(params[0]))) };
      if (method === "eth_getTransactionReceipt") return state.receipts.find((receipt) => receipt.transactionHash === params[0]);
      if (method === "eth_getTransactionByHash") return state.transaction;
      if (method === "eth_getLogs") {
        state.queries.push(params[0]);
        const q = params[0]; assert.equal(q.address, PAIR.address); assert.equal(q.topics[1], topicAddress(wallet));
        return state.receipts.flatMap((receipt) => receipt.logs.filter((log) => log.address === PAIR.address &&
          Number(BigInt(log.blockNumber)) >= Number(BigInt(q.fromBlock)) && Number(BigInt(log.blockNumber)) <= Number(BigInt(q.toBlock))));
      }
      if (method === "eth_call") return encodeFunctionResult({ abi: pairAbi, functionName: "claim", result: state.raw });
      if (method === "eth_estimateGas") return "0x186a0";
      throw new ReadError("invalid_request");
    },
  };
  const options = { secret, createRpc: () => rpc, indexFetcher: async (url, init) => {
    state.indexRequests++; assert.equal(url, `https://pair.fund/api/fees/claimable/${wallet}`);
    assert.equal(init.redirect, "manual"); return Response.json(state.hints);
  } };
  return { state, rpc, options };
}
async function finish(input, options) {
  const balances = [], history = [], pages = [];
  for (let page = 0; page < 100; page++) {
    const result = await scan(input, options); pages.push(result); balances.push(...result.balances); history.push(...result.history);
    if (!result.cursor) return { result, pages, balances, history };
    input = { address: wallet, source: "pair", scope: input.scope, cursor: result.cursor };
  }
  assert.fail("fixture did not finish");
}
test("PAIR ignores index amounts, metadata and calldata; only pinned locker identities are accepted", async () => {
  const parsed = parsePairIndex([hint(), hint(), hint(other, other)]);
  assert.deepEqual(parsed, { assets: [asset], excluded: true });
  assert.throws(() => parsePairIndex({ positions: [] }), { code: "invalid_response" });
  assert.throws(() => parsePairIndex([hint(NATIVE)]), { code: "invalid_response" });
  const { state, options } = fixture(); state.hints.push(hint(other, other));
  const { result } = await finish({ address: wallet, source: "pair", scope: "balances" }, options);
  assert.equal(result.balances[0].raw, "7"); assert.equal(result.balances[0].symbol, "CHAIN");
  assert.equal(result.balances[0].currency, asset); assert.ok(result.balances[0].claimHandle);
  assert.deepEqual(result.warnings, ["pair_unreviewed_locker"]); assert.deepEqual(state.queries, []);
  assert.equal(state.indexRequests, 1); assert.equal(state.calls.length, 1); assert.ok(state.verified.includes(PAIR.id));
});
test("PAIR 429 preserves Retry-After and upstream failures never become empty successful discovery", async () => {
  await assert.rejects(readPairIndex(wallet, async () => new Response(null, { status: 429, headers: { "retry-after": "600" } })),
    (error) => error.code === "rate_limited" && error.retryAfter === 600000);
  await assert.rejects(readPairIndex(wallet, async () => { throw Error("private upstream body"); }), { code: "index_unavailable" });
  await assert.rejects(readPairIndex(wallet, async () => new Response(null, { status: 302 })), { code: "index_unavailable" });
});
test("PAIR drains all assets in batched pages and refreshes saved zero balances after cursor expiry", async () => {
  const { state, options } = fixture();
  state.hints = Array.from({ length: 41 }, (_, i) => hint(`0x${(i + 1).toString(16).padStart(40, "0")}`));
  const prior = await finish({ address: wallet, source: "pair", scope: "balances" }, options);
  assert.equal(prior.balances.length, 41); assert.deepEqual(state.calls.map((calls) => calls.length), [16, 16, 9]);
  assert.equal(state.indexRequests, 1); assert.equal(prior.result.coverage.percent, 100);
  const now = Date.now; Date.now = () => now() + 3 * 86400000;
  try {
    await assert.rejects(open(prior.pages[0].cursor, wallet, "pair", secret), { code: "cursor_expired" });
    state.raw = 0n; state.hints = []; state.calls = [];
    const refreshed = await finish({ address: wallet, source: "pair", scope: "balances", checkpoint: prior.result.checkpoint }, options);
    assert.equal(refreshed.pages[0].resetBalances, true); assert.equal(refreshed.balances.length, 41);
    assert.ok(refreshed.balances.every((row) => row.raw === "0" && !row.claimHandle));
  } finally { Date.now = now; }
});
test("PAIR history loads only on demand, authenticates transfers, and refresh scans only new blocks", async () => {
  const { state, options } = fixture();
  const old = await finish({ address: wallet, source: "pair", scope: "history" }, options);
  assert.equal(state.indexRequests, 0); assert.equal(old.history.length, 1); assert.equal(old.history[0].raw, "7");
  assert.equal(state.queries.length, 1); const end = old.result.snapshot.number;
  state.height += 100; state.queries = [];
  const refreshed = await finish({ address: wallet, source: "pair", scope: "history", checkpoint: old.result.checkpoint }, options);
  assert.equal(refreshed.history.length, 0);
  assert.ok(state.queries.every((q) => Number(BigInt(q.fromBlock)) === end + 1));
  state.receipts[0].logs.pop();
  await assert.rejects(scan({ address: wallet, source: "pair", scope: "history" }, options), { code: "invalid_response" });
});
test("PAIR range backoff preserves all historical work and failed reads never dequeue assets", async () => {
  const { rpc, state, options } = fixture(); const send = rpc.send.bind(rpc), calls = rpc.calls.bind(rpc);
  rpc.send = async (method, params) => {
    if (method === "eth_getLogs" && Number(BigInt(params[0].toBlock)) - Number(BigInt(params[0].fromBlock)) > 10)
      throw new ReadError("log_range");
    return send(method, params);
  };
  const history = await finish({ address: wallet, source: "pair", scope: "history" }, options);
  assert.equal(history.history.length, 1); assert.equal(history.result.coverage.percent, 100);
  state.hints = Array.from({ length: 17 }, (_, i) => hint(`0x${(i + 1).toString(16).padStart(40, "0")}`));
  const page = await scan({ address: wallet, source: "pair", scope: "balances" }, options);
  rpc.calls = async () => { throw new ReadError("rate_limited"); };
  await assert.rejects(scan({ address: wallet, source: "pair", scope: "balances", cursor: page.cursor }, options), { code: "rate_limited" });
  rpc.calls = calls;
  const next = await scan({ address: wallet, source: "pair", scope: "balances", cursor: page.cursor }, options);
  assert.equal(next.balances.length, 1); assert.equal(next.coverage.complete, true);
});
test("PAIR preserves unfinished history across renewal and paginates a dense block without skipping claims", async () => {
  const { rpc, state, options } = fixture();
  const height = start + 5;
  state.receipts = Array.from({ length: 37 }, (_, i) => {
    const r = receipt(height); r.transactionHash = hash(2000 + i);
    for (const log of r.logs) { log.transactionHash = r.transactionHash; log.logIndex = toHex(i * 2 + (log.address === PAIR.address ? 2 : 1)); }
    return r;
  });
  let page = await scan({ address: wallet, source: "pair", scope: "history" }, options);
  assert.equal(page.coverage.complete, false);
  state.height += 20;
  const renewed = await finish({ address: wallet, source: "pair", scope: "history", checkpoint: page.checkpoint }, options);
  assert.equal(renewed.history.length, 37); assert.equal(new Set(renewed.history.map((row) => row.id)).size, 37);
  assert.equal(renewed.result.coverage.complete, true);
  const send = rpc.send.bind(rpc);
  rpc.send = async (method, params) => method === "eth_getBlockByNumber" ? { hash: hash(0) } : send(method, params);
  await assert.rejects(scan({ address: wallet, source: "pair", scope: "history", checkpoint: renewed.result.checkpoint }, options), { code: "snapshot_changed" });
});
test("PAIR receipt proof rejects missing, redirected, forged and mismatched token transfers", () => {
  assert.equal(pairReceiptEntries(receipt(), wallet).length, 1);
  for (const mutate of [
    (r) => r.logs.pop(),
    (r) => { r.logs[0].address = other; },
    (r) => { r.logs[1].data = encodeAbiParameters([{ type: "uint256" }], [6n]); },
    (r) => { r.logs[1].topics = encodeEventTopics({ abi: transferAbi, eventName: "Transfer", args: { from: PAIR.address, to: other } }); },
  ]) { const value = receipt(); mutate(value); assert.deepEqual(pairReceiptEntries(value, wallet), []); }
  const removed = receipt(); removed.logs[1].removed = true;
  assert.throws(() => pairReceiptEntries(removed, wallet), { code: "invalid_response" });
});
test("PAIR claim preparation rereads onchain, binds claim(asset), and confirms canonical token payouts", async () => {
  const { state, rpc, options } = fixture();
  const { result } = await finish({ address: wallet, source: "pair", scope: "balances" }, options);
  state.raw = 9n;
  const quote = await prepareClaim({ address: wallet, claimHandle: result.balances[0].claimHandle }, options);
  assert.equal(quote.row.raw, "9"); assert.equal(quote.value, "0x0"); assert.equal(quote.target, PAIR.address);
  assert.deepEqual(decodeFunctionData({ abi: pairAbi, data: quote.data }).args, [asset]);
  assert.equal(validateQuote(quote, result.balances[0], wallet).targetId, PAIR.id);
  assert.throws(() => claimPlan({ ...quote.row, currency: NATIVE }, wallet), { code: "invalid_request" });
  const paid = receipt(start + 5, 9n); state.receipts = [paid];
  state.transaction = { hash: paid.transactionHash, from: wallet, to: PAIR.address, input: quote.data, value: "0x0", blockHash: paid.blockHash };
  const confirmed = await confirmClaim({ address: wallet, authorization: quote.authorization, hash: paid.transactionHash }, options);
  assert.equal(confirmed.status, "confirmed"); assert.equal(confirmed.history[0].raw, "9");
  state.receipts[0].logs.pop();
  assert.equal((await confirmClaim({ address: wallet, authorization: quote.authorization, hash: paid.transactionHash }, options)).status, "no_payout");
  const send = rpc.send.bind(rpc);
  rpc.send = async (method, params) => method === "eth_call" ? encodeFunctionResult({ abi: pairAbi, functionName: "claim", result: 8n }) : send(method, params);
  await assert.rejects(prepareClaim({ address: wallet, claimHandle: result.balances[0].claimHandle }, options), { code: "invalid_response" });
});
test("PAIR supports browser-local saved progress without invalidating existing sources", async () => {
  const { options } = fixture(), { result } = await finish({ address: wallet, source: "pair", scope: "balances" }, options);
  const values = new Map(), cache = new ScanCache({ localStorage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) } });
  cache.save(wallet, { selected: SOURCE_INFO.map((source) => source.id), balances: { pair: { pages: 1, balances: result.balances, history: [], result } }, history: {}, historyStarted: false });
  assert.equal(cache.load(wallet).balances.pair.result.checkpoint, result.checkpoint);
});
test("PAIR wallet confirmation uses the pinned locker and refreshes after proved confirmation", async () => {
  const { state, options } = fixture(), { result } = await finish({ address: wallet, source: "pair", scope: "balances" }, options);
  const quote = await prepareClaim({ address: wallet, claimHandle: result.balances[0].claimHandle }, options);
  const methods = [], refreshes = [];
  const session = { address: wallet, provider: { async request({ method, params }) {
    methods.push(method);
    if (method === "eth_accounts") return [wallet];
    if (method === "eth_chainId") return "0x1237";
    if (method === "eth_getCode") return "0x11";
    if (method === "eth_call") return encodeFunctionResult({ abi: pairAbi, functionName: "claim", result: state.raw });
    if (method === "eth_sendTransaction") { assert.equal(params[0].to, PAIR.address); assert.equal(params[0].value, "0x0"); return hash(999); }
    throw Error("unexpected wallet method");
  } } };
  const controller = new ClaimController({ getSession: () => session, notify() {}, refresh: (...args) => refreshes.push(args), hashCode: () => PAIR.hash,
    fetcher: async (url) => Response.json(url.endsWith("prepare") ? quote : { status: "confirmed", history: receiptPayouts(receipt(), quote), snapshotCursor: "fixture.snapshot" }) });
  await controller.begin(result.balances[0]); assert.equal(controller.state.phase, "review");
  assert.equal(methods.includes("eth_sendTransaction"), false);
  await controller.send(); assert.equal(controller.state.phase, "confirmed");
  assert.equal(methods.filter((method) => method === "eth_sendTransaction").length, 1); assert.equal(refreshes.length, 1);
  assert.equal(methods.includes("personal_sign"), false);
});

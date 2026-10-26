import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, toHex } from "viem";
import { scan } from "../lib/fees/engine.mjs";
import { open, openProgress, seal } from "../lib/fees/cursor.mjs";
import { LONG, LONG_HOOK } from "../lib/fees/catalog.mjs";
import { longAbi } from "../lib/fees/abi.mjs";
import { NATIVE, ReadError } from "../lib/fees/model.mjs";
import { Rpc } from "../lib/fees/rpc.mjs";

const wallet = `0x${"11".repeat(20)}`, other = `0x${"22".repeat(20)}`;
const secret = "long-discovery-fixture-" + "x".repeat(40);
const hash = (height) => toHex(height, { size: 32 });
const lock = longAbi.find((entry) => entry.name === "Lock");
function lockLog(height, index, owner = other) {
  return {
    address: LONG.address, removed: false, blockHash: hash(height),
    transactionHash: hash(index + 1), blockNumber: toHex(height), logIndex: toHex(index),
    topics: encodeEventTopics({ abi: longAbi, eventName: "Lock", args: { pool: toHex(index + 1, { size: 20 }) } }),
    data: encodeAbiParameters(lock.inputs.filter((input) => !input.indexed), [[{ beneficiary: owner, shares: 10n ** 18n }]]),
  };
}
function fixture(readLogs, height = LONG.start + 31) {
  return {
    height, queries: [],
    async snapshot() { return { number: this.height, hash: hash(this.height), timestamp: 1 }; },
    async verify() {},
    async currency(currency) { return { currency, symbol: "TEST", decimals: 18, metadataVerified: true }; },
    async call(target, abi, name, args) {
      if (name === "getState") return [NATIVE, 0n, LONG_HOOK.address, "0x", 2,
        { currency0: NATIVE, currency1: args[0], fee: 3000, tickSpacing: 60, hooks: LONG.address }];
      if (name === "getShares") return 10n ** 18n;
      if (name === "getCumulatedFees0") return 100n;
      if (["getCumulatedFees1", "getLastCumulatedFees0", "getLastCumulatedFees1"].includes(name)) return 0n;
      if (name === "collectFees") return [0n, 0n];
      throw new ReadError("read_failed");
    },
    async send(method, params, options) {
      if (method === "eth_chainId") return toHex(4663);
      if (method === "eth_getBlockByNumber") return { hash: hash(Number(BigInt(params[0]))) };
      if (method !== "eth_getLogs") throw new ReadError("invalid_request");
      this.queries.push({ ...params[0], options });
      return readLogs(params[0], options);
    },
  };
}
async function cursorFor(height, extra = {}) {
  return seal({ version: 1, address: wallet, source: "long", scope: "balances",
    snapshot: { number: height, hash: hash(height), timestamp: 1 }, initialized: true,
    pending: [], seen: [], positions: [], warnings: [], turn: 0,
    streams: [{ target: LONG.id, mode: "discovery", scope: "balances", start: LONG.start,
      end: height, next: height, range: height - LONG.start + 1, sizing: 2, ...extra }],
  }, secret);
}
const step = (rpc, input) => scan({ address: wallet, source: "long", scope: "balances", ...input }, { secret, createRpc: () => rpc });

test("new and legacy Long scans cap raw ranges and cover each block once across resumed pages", async () => {
  const height = LONG.start + 1_000_000;
  for (const legacy of [false, true]) {
    const rpc = fixture(() => [], height);
    let result = await step(rpc, legacy ? { cursor: await cursorFor(height, { sizing: undefined }) } : {});
    for (let page = 0; result.cursor && page < 10; page++) {
      const priorQueries = rpc.queries.length;
      result = await step(rpc, { cursor: result.cursor });
      assert.ok(rpc.queries.length - priorQueries <= 1);
    }
    assert.equal(result.coverage.complete, true);
    assert.equal(result.coverage.blocksChecked, 1_000_001);
    assert.equal(rpc.queries.length, 5);
    for (const [i, query] of rpc.queries.entries()) {
      const lo = Number(BigInt(query.fromBlock)), hi = Number(BigInt(query.toBlock));
      assert.ok(hi - lo + 1 <= 250_000);
      assert.equal(query.options.maxResponseBytes, 64 * 1024);
      assert.equal(hi, i ? Number(BigInt(rpc.queries[i - 1].fromBlock)) - 1 : height);
    }
    assert.equal(rpc.queries.at(-1).fromBlock, toHex(LONG.start));
  }
});

test("dense raw responses shrink before ABI decoding without advancing coverage", async () => {
  // Malformed ABI data must not be touched while the raw response is oversized.
  const height = LONG.start + 999;
  const rpc = fixture(() => Array.from({ length: 1000 }, () => ({ data: "invalid" })), height);
  const result = await step(rpc, { cursor: await cursorFor(height) });
  const saved = await open(result.cursor, wallet, "long", secret);
  assert.equal(result.coverage.blocksChecked, 0);
  assert.equal(result.coverage.complete, false);
  assert.equal(saved.streams[0].next, height);
  assert.equal(saved.streams[0].range, 125);
  assert.equal(rpc.queries.length, 3);
  assert.deepEqual(result.balances, []);
});

test("dense single blocks checkpoint raw log indices and drain matching balances exactly once", async () => {
  const height = LONG.start, owned = new Set([0, 5, 16, 31, 40]);
  const logs = Array.from({ length: 41 }, (_, i) => lockLog(height, i, owned.has(i) ? wallet : other)).reverse();
  const rpc = fixture(() => logs, height);
  let result = await step(rpc, { cursor: await cursorFor(height) });
  const first = await open(result.cursor, wallet, "long", secret);
  assert.equal(first.streams[0].next, height);
  assert.equal(first.streams[0].afterLogIndex, 15);
  assert.equal(first.pending.length, 1);
  assert.equal(result.coverage.complete, false);
  const rows = [...result.balances];
  for (let page = 0; result.cursor && page < 10; page++) {
    result = await step(rpc, { cursor: result.cursor });
    rows.push(...result.balances);
  }
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.blocksChecked, 1);
  assert.equal(rpc.queries.length, 3);
  assert.equal(rows.filter((row) => row.raw === "100").length, owned.size);
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
  const finished = await openProgress(result.checkpoint, wallet, "long", secret);
  assert.equal(finished.streams[0].afterLogIndex, undefined);
  assert.equal(finished.pending.length, 0);
});

test("refreshing a partial single-block checkpoint preserves old work and starts new blocks at log zero", async () => {
  const height = LONG.start;
  const rpc = fixture((query) => {
    const block = Number(BigInt(query.toBlock));
    return Array.from({ length: 20 }, (_, i) => lockLog(block, i,
      block > height && [0, 18].includes(i) ? wallet : other));
  }, height);
  const first = await step(rpc, { cursor: await cursorFor(height) });
  const saved = await openProgress(first.checkpoint, wallet, "long", secret);
  assert.equal(saved.streams[0].afterLogIndex, 15);
  // Durable progress still works after the short-lived cursor has expired.
  const now = Date.now;
  Date.now = () => now() + 3 * 86400000;
  try {
    await assert.rejects(open(first.cursor, wallet, "long", secret), (error) => error.code === "cursor_expired");
    rpc.height++;
    let result = await step(rpc, { checkpoint: first.checkpoint });
    const rows = [...result.balances];
    for (let page = 0; result.cursor && page < 12; page++) {
      result = await step(rpc, { cursor: result.cursor });
      rows.push(...result.balances);
    }
    assert.equal(result.coverage.complete, true);
    assert.equal(rows.filter((row) => row.raw === "100").length, 2);
    assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
    assert.equal(result.coverage.blocksChecked, 2);
  } finally {
    Date.now = now;
  }
});

test("failed or unbounded single-block reads never produce a successful checkpoint", async () => {
  const height = LONG.start;
  for (const code of ["response_limit", "read_failed"]) {
    const rpc = fixture(() => { throw new ReadError(code); }, height);
    const cursor = await cursorFor(height);
    await assert.rejects(step(rpc, { cursor }), (error) => error.code === code);
    const saved = await open(cursor, wallet, "long", secret);
    assert.equal(saved.streams[0].next, height);
  }
  const duplicates = fixture(() => [lockLog(height, 0), lockLog(height, 0)], height);
  await assert.rejects(step(duplicates, { cursor: await cursorFor(height) }), (error) => error.code === "invalid_response");
});

test("a reorg blocks resuming within a dense block before any additional logs are read", async () => {
  const height = LONG.start;
  const rpc = fixture(() => Array.from({ length: 20 }, (_, i) => lockLog(height, i)), height);
  const first = await step(rpc, { cursor: await cursorFor(height) });
  const send = rpc.send.bind(rpc);
  rpc.send = (method, params, options) => method === "eth_getBlockByNumber"
    ? { hash: hash(height + 1) } : send(method, params, options);
  await assert.rejects(step(rpc, { cursor: first.cursor }), (error) => error.code === "snapshot_changed");
  assert.equal(rpc.queries.length, 1);
});

test("small RPC response budgets reject oversized log bodies before JSON parsing", async () => {
  for (const advertised of [false, true]) {
    const rpc = new Rpc("https://rpc.example.invalid", async () => new Response("x".repeat(2048), {
      headers: advertised ? { "content-length": "2048" } : {},
    }));
    await assert.rejects(rpc.send("eth_getLogs", [{}], { maxResponseBytes: 1024 }), (error) => error.code === "response_limit");
  }
  const rpc = new Rpc("https://rpc.example.invalid", async () => Response.json({ jsonrpc: "2.0", id: 1, result: [] }));
  assert.deepEqual(await rpc.send("eth_getLogs", [{}], { maxResponseBytes: 1024 }), []);
});

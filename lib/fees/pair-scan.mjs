import { decodeEventLog, toEventSelector, toHex, isAddress } from "viem";
import { PAIR } from "./catalog.mjs";
import { pairAbi } from "./abi.mjs";
import { readPairIndex } from "./pair-index.mjs";
import { pairBalances, pairReceiptEntries } from "./pair.mjs";
import { open, openProgress, seal, sealProgress } from "./cursor.mjs";
import { ReadError, same, topicAddress, NATIVE } from "./model.mjs";
const selector = toEventSelector(pairAbi.find((entry) => entry.name === "FeesClaimed"));
const remaining = (ranges) => ranges.reduce((n, [lo, hi]) => n + hi - lo + 1, 0);
async function canonical(rpc, snapshot) {
  if (BigInt(await rpc.send("eth_chainId")) !== 4663n) throw new ReadError("wrong_chain");
  const block = await rpc.send("eth_getBlockByNumber", [toHex(snapshot.number), false]);
  if (!same(block?.hash, snapshot.hash)) throw new ReadError("snapshot_changed");
}
function validate(state, scope) {
  if (state.pairVersion !== 1 || state.scope !== scope || !Array.isArray(state.assets) ||
    !Array.isArray(state.pendingAssets) || !Array.isArray(state.ranges) || !Array.isArray(state.pendingHistory) ||
    state.pendingHistory.length > 32 || !Number.isSafeInteger(state.snapshot?.number) ||
    state.assets.some((asset) => !isAddress(asset, { strict: false }) || same(asset, NATIVE)))
    throw new ReadError("cursor_expired");
}
async function historyPage(rpc, state) {
  if (!state.ranges.length) return;
  const [lo, end] = state.ranges[0], hi = Math.min(end, lo + state.range - 1);
  let logs;
  try {
    logs = await rpc.send("eth_getLogs", [{ address: PAIR.address, fromBlock: toHex(lo), toBlock: toHex(hi),
      topics: [selector, topicAddress(state.address)] }], { maxResponseBytes: 128 * 1024 });
    if (!Array.isArray(logs)) throw new ReadError("invalid_response");
    if (logs.length > 32 && hi > lo) throw new ReadError("response_limit");
  } catch (error) {
    if (["log_range", "response_limit"].includes(error.code) && hi > lo) {
      state.range = Math.max(1, Math.floor((hi - lo + 1) / 2)); return;
    }
    throw error;
  }
  const events = logs.map((log) => {
    if (!same(log.address, PAIR.address) || log.removed !== false || !same(log.topics?.[0], selector) ||
      !same(log.topics?.[1], topicAddress(state.address)) || !/^0x[\da-f]{64}$/i.test(log.blockHash) ||
      !/^0x[\da-f]{64}$/i.test(log.transactionHash) || !/^0x[\da-f]+$/i.test(log.blockNumber) || !/^0x[\da-f]+$/i.test(log.logIndex))
      throw new ReadError("invalid_response");
    const height = Number(BigInt(log.blockNumber)), index = Number(BigInt(log.logIndex));
    if (height < lo || height > hi || !Number.isSafeInteger(index)) throw new ReadError("invalid_response");
    let event;
    try { event = decodeEventLog({ abi: pairAbi, data: log.data, topics: log.topics, strict: true }); }
    catch { throw new ReadError("invalid_response"); }
    if (!same(event.args.recipient, state.address)) throw new ReadError("invalid_response");
    return { block: height, index, hash: log.blockHash, tx: log.transactionHash };
  }).sort((a, b) => a.block - b.block || a.index - b.index);
  if (events.some((event, i) => i > 0 && event.block === events[i - 1].block && event.index === events[i - 1].index))
    throw new ReadError("invalid_response");
  const filtered = events.filter((event) => event.block !== lo || event.index > (state.afterLogIndex ?? -1));
  state.pendingHistory = filtered.slice(0, 32);
  if (filtered.length > 32) { state.range = 1; state.afterLogIndex = state.pendingHistory.at(-1).index; }
  else {
    delete state.afterLogIndex;
    if (hi === end) state.ranges.shift(); else state.ranges[0][0] = hi + 1;
    state.range = Math.max(1, state.range * 2);
  }
}
export async function scanPair(input, { rpc, secret, indexFetcher }) {
  const address = input.address.toLowerCase(), scope = input.scope ?? "all", renewed = !!input.checkpoint;
  if ((input.cursor && input.checkpoint) || (renewed && input.snapshotCursor)) throw new ReadError("invalid_request");
  let state = input.cursor ? await open(input.cursor, address, "pair", secret)
    : renewed ? await openProgress(input.checkpoint, address, "pair", secret) : null;
  if (state) { validate(state, scope); await canonical(rpc, state.snapshot); }
  if (!state || renewed) {
    const previous = state;
    let snapshot;
    if (input.snapshotCursor) {
      snapshot = (await open(input.snapshotCursor, address, "snapshot", secret)).snapshot;
      await canonical(rpc, snapshot);
    } else snapshot = await rpc.snapshot();
    if (previous && snapshot.number < previous.snapshot.number) throw new ReadError("snapshot_changed");
    const ranges = previous?.ranges ?? [];
    const nextStart = previous ? previous.snapshot.number + 1 : PAIR.start;
    if (scope !== "balances" && nextStart <= snapshot.number) ranges.push([nextStart, snapshot.number]);
    state = { version: 1, pairVersion: 1, address, source: "pair", scope, snapshot,
      assets: previous?.assets ?? [], pendingAssets: [], indexed: scope === "history", warnings: previous?.warnings ?? [],
      ranges, range: previous?.range ?? Math.max(1, snapshot.number - PAIR.start + 1),
      pendingHistory: previous?.pendingHistory ?? [], ...(previous?.afterLogIndex === undefined ? {} : { afterLogIndex: previous.afterLogIndex }),
    };
  }
  const block = toHex(state.snapshot.number), balances = [], history = [];
  await rpc.verify(PAIR, block);
  if (scope !== "history") {
    if (!state.indexed) {
      const indexed = await readPairIndex(address, indexFetcher);
      state.assets = [...new Set([...state.assets, ...indexed.assets])];
      state.pendingAssets = [...state.assets]; state.indexed = true;
      state.warnings = indexed.excluded ? ["pair_unreviewed_locker"] : [];
    }
    const assets = state.pendingAssets.slice(0, 16);
    balances.push(...await pairBalances(rpc, address, assets, state.snapshot));
    state.pendingAssets.splice(0, assets.length);
  }
  if (scope !== "balances") {
    if (!state.pendingHistory.length) await historyPage(rpc, state);
    // One receipt can contain several claims. Match its exact indexed log;
    // sibling events are processed separately without double-counting rows.
    for (let work = 0; state.pendingHistory.length && work < 2; work++) {
      const event = state.pendingHistory[0];
      const receipt = await rpc.send("eth_getTransactionReceipt", [event.tx]);
      if (!same(receipt?.transactionHash, event.tx) || !same(receipt.blockHash, event.hash) || Number(BigInt(receipt.blockNumber)) !== event.block)
        throw new ReadError("invalid_response");
      const canonicalBlock = await rpc.send("eth_getBlockByNumber", [toHex(event.block), false]);
      if (!same(canonicalBlock?.hash, event.hash)) throw new ReadError("snapshot_changed");
      const entry = pairReceiptEntries(receipt, address).find((entry) => entry.index === event.index);
      if (!entry) throw new ReadError("invalid_response");
      history.push({ id: `${event.hash}:${event.index}:${entry.currency}`, source: "pair", target: PAIR.id,
        ...(await rpc.currency(entry.currency, block)), raw: entry.raw, block: event.block, tx: event.tx, destination: address });
      state.pendingHistory.shift();
    }
  }
  const balanceComplete = scope === "history" || state.indexed && !state.pendingAssets.length;
  const historyComplete = scope === "balances" || !state.ranges.length && !state.pendingHistory.length;
  const complete = balanceComplete && historyComplete;
  const total = Math.max(0, state.snapshot.number - PAIR.start + 1), checked = Math.max(0, total - remaining(state.ranges));
  const balancePercent = state.assets.length ? (state.assets.length - state.pendingAssets.length) / state.assets.length * 100 : balanceComplete ? 100 : 0;
  const historyPercent = total ? checked / total * 100 : 100;
  const percent = scope === "balances" ? balancePercent : scope === "history" ? historyPercent : (balancePercent + historyPercent) / 2;
  return { source: "pair", scope, discovery: scope === "balances" ? "wallet-index" : undefined, snapshot: state.snapshot,
    snapshotCursor: await seal({ version: 1, address, source: "snapshot", snapshot: state.snapshot }, secret),
    checkpoint: await sealProgress(state, secret), resetBalances: renewed && scope !== "history", updatesComplete: complete,
    balances: await Promise.all(balances.map(async (row) => BigInt(row.raw) > 0n
      ? { ...row, claimHandle: await seal({ version: 1, address, source: "claim", row }, secret) } : row)),
    history, warnings: state.warnings, coverage: { complete, percent: complete ? 100 : Math.min(99, percent),
      pending: state.pendingAssets.length + state.pendingHistory.length,
      ...(scope === "balances" ? { positionsChecked: state.assets.length - state.pendingAssets.length, positionsTotal: state.assets.length }
        : { blocksChecked: checked, blocksTotal: total }) },
    cursor: complete ? null : await seal(state, secret),
  };
}

import { decodeEventLog, toEventSelector, toHex } from "viem";
import { BAGS, LONG, BANKR_HOOK, WETH } from "./catalog.mjs";
import { bagsFactoryAbi, bagsFeeAbi, longAbi } from "./abi.mjs";
import { verifyBagsDeployment, bagsBalance, bagsIndexedBalance, bagsIndexedBalances, bagsTokenForFee, nonzeroAddress } from "./bags.mjs";
import { readBagsIndex } from "./bags-index.mjs";
import { readBankrIndex } from "./bankr-index.mjs";
import { longDiscoveryProfile } from "./long-discovery.mjs";
import { bankrDiscoveryProfile } from "./bankr-discovery.mjs";
import { sharedDiscoveryPage } from "./shared-discovery.mjs";
import { longPool, longBalance } from "./engine.mjs";
import { open, openProgress, seal, sealProgress } from "./cursor.mjs";
import { ReadError, same, topicAddress, normalizeAddress, poolId } from "./model.mjs";
import { bankrHookAbi } from "./abi.mjs";

const REGISTRY_PAGE = 128;
const remaining = (ranges) => ranges.reduce((sum, range) => sum + range.end - range.start, 0);
function appendRange(ranges, start, end) {
  if (end <= start) return ranges;
  const sorted = [{start,end}, ...ranges].sort((a,b)=>a.start-b.start), merged = [];
  for (const range of sorted) {
    const prior = merged.at(-1);
    if (prior && range.start <= prior.end) prior.end = Math.max(prior.end, range.end);
    else merged.push({...range});
  }
  return merged.reverse();
}
async function batch(rpc, calls, block) {
  if (!calls.length) return [];
  const results = typeof rpc.calls === "function" ? await rpc.calls(calls, block)
    : await Promise.all(calls.map((call) => rpc.call(call.address, call.abi, call.functionName, call.args, block)));
  if (!Array.isArray(results) || results.length !== calls.length) throw new ReadError("invalid_response");
  return results;
}
function remember(state, position) {
  const key = position.token.toLowerCase();
  if (!state.positions.some((entry) => entry.target === position.target && same(entry.token, key))) {
    if (state.positions.length >= 512) throw new ReadError("position_limit");
    state.positions.push(position);
  }
}
async function initialize(rpc, state, indexFetcher, bagsKey) {
  const block = toHex(state.snapshot.number);
  if (state.source === "bags" && state.scope !== "history") {
    if (bagsKey) {
      const index = await readBagsIndex(state.address, state.snapshot.number, bagsKey, indexFetcher);
      const positions = new Map([...state.positions, ...state.pending, ...index.positions].map((entry) => [entry.token, entry]));
      if (positions.size > 512) throw new ReadError("position_limit");
      state.pending = [...positions.values()];
      if (index.legacy) state.warnings.push("bags_index_legacy");
      state.bagsIndex = { mode: index.truncated ? "onchain-registry" : "wallet-index", total: state.pending.length, checked: 0 };
      if (!index.truncated) { state.initialized = true; return; }
      state.warnings.push("bags_index_truncated");
    }
    const count = await rpc.call(BAGS.address, bagsFactoryAbi, "allTokensLength", [], block);
    if (typeof count !== "bigint" || count < 0n || count > BigInt(Number.MAX_SAFE_INTEGER)) throw new ReadError("position_limit");
    const total = Number(count), prior = state.registry;
    if (prior && total < prior.total) throw new ReadError("snapshot_changed");
    const ranges = appendRange(prior?.ranges ?? [], prior?.total ?? 0, total);
    state.registry = { total, next: remaining(ranges), ranges };
  } else if (state.source === "bankr" && state.scope !== "history") {
    const page = await readBankrIndex(state.address, indexFetcher);
    for (const position of page.positions) remember(state, position);
    if (page.excluded) state.warnings.push("bankr_unreviewed_route");
    // An index is a discovery hint. No API balances, symbols or calldata are used.
    state.pending = [...state.positions];
  }
  state.initialized = true;
}
async function registryPage(rpc, state) {
  const block = toHex(state.snapshot.number), range = state.registry.ranges[0];
  if (!range) return;
  const end = range.end, start = Math.max(range.start, end - REGISTRY_PAGE);
  const tokens = await rpc.call(BAGS.address, bagsFactoryAbi, "getTokens", [BigInt(start), BigInt(end - start)], block);
  if (!Array.isArray(tokens) || tokens.length !== end - start || tokens.some((token) => !nonzeroAddress(token)) ||
    new Set(tokens.map((token) => token.toLowerCase())).size !== tokens.length) throw new ReadError("invalid_response");
  const fees = await batch(rpc, tokens.map((token) => ({ address: BAGS.address, abi: bagsFactoryAbi, functionName: "feeShareForToken", args: [token] })), block);
  if (fees.some((fee) => !nonzeroAddress(fee))) throw new ReadError("invalid_response");
  const readings = await batch(rpc, fees.flatMap((fee) => [
    { address: fee, abi: bagsFeeAbi, functionName: "claimable", args: [state.address] },
    { address: fee, abi: bagsFeeAbi, functionName: "claimerBps", args: [state.address] },
    { address: fee, abi: bagsFeeAbi, functionName: "PARTNER", args: [] },
  ]), block);
  for (const [i, token] of tokens.entries()) {
    const [raw, bps, partner] = readings.slice(i * 3, i * 3 + 3);
    if (typeof raw !== "bigint" || raw < 0n || !Number.isInteger(Number(bps)) || Number(bps) < 0 || Number(bps) > 10000 ||
      typeof partner !== "string" || !/^0x[\da-f]{40}$/i.test(partner)) throw new ReadError("invalid_response");
    if (raw > 0n || Number(bps) > 0 || same(partner, state.address)) {
      const position = { target: BAGS.id, token: token.toLowerCase(), fee: fees[i].toLowerCase() };
      remember(state, position);
      state.pending.push(position);
    }
  }
  range.end = start;
  if (range.start === range.end) state.registry.ranges.shift();
  state.registry.next = remaining(state.registry.ranges);
}
async function readPosition(rpc, state, position, rows, warnings) {
  if (state.source === "bags") {
    const indexed = state.bagsIndex?.mode === "wallet-index";
    const row = await (state.bagsIndex ? bagsIndexedBalance : bagsBalance)(rpc, state.address, position.token, position.fee, state.snapshot);
    if (row) { remember(state, position); rows.push(row); }
    if (indexed) state.bagsIndex.checked++;
  } else {
    const pool = await longPool(rpc, position.pool, position.token, toHex(state.snapshot.number), "bankr");
    if (!pool) { warnings.add("bankr_unreviewed_route"); return; }
    const checkedKey=`${position.target}:${pool.id}`;
    if (state.bankrChecked?.includes(checkedKey)) return;
    remember(state,{target:position.target,pool:pool.id,token:pool.asset});
    await longBalance(rpc, { address: state.address, source: "bankr", feeTarget: position.target, snapshot: state.snapshot }, pool, rows, warnings);
    (state.bankrChecked??=[]).push(checkedKey);
  }
}
function checkedLog(log, state, lo, hi, selector) {
  if (!log || log.removed !== false || !nonzeroAddress(log.address) ||
    !/^0x[\da-f]{64}$/i.test(log.blockHash) || !/^0x[\da-f]{64}$/i.test(log.transactionHash) ||
    !/^0x[\da-f]+$/i.test(log.blockNumber) || !/^0x[\da-f]+$/i.test(log.logIndex) ||
    !Array.isArray(log.topics) || !same(log.topics[0], selector) ||
    !same(log.topics[state.source === "bags" ? 1 : 2], topicAddress(state.address)) ||
    (state.source === "bankr" && ![LONG, BANKR_HOOK].some((profile) => same(log.address, profile.address))) ||
    Number(BigInt(log.blockNumber)) < lo || Number(BigInt(log.blockNumber)) > hi) throw new ReadError("invalid_response");
  try {
    decodeEventLog({ abi: state.source === "bags" ? bagsFeeAbi : longAbi, data: log.data, topics: log.topics, strict: true });
  } catch { throw new ReadError("invalid_response"); }
  return log;
}
async function historyPage(rpc, state) {
  const stream = state.history, abi = state.source === "bags" ? bagsFeeAbi : longAbi;
  const range = stream.ranges[0];
  if (!range) return;
  const selector = toEventSelector(abi.find((entry) => entry.type === "event" && entry.name === (state.source === "bags" ? "Claimed" : "Release")));
  for (let attempt = 0; attempt < 3; attempt++) {
    const hi = range.end - 1, lo = Math.max(range.start, hi - stream.range + 1);
    let logs;
    try {
      logs = await rpc.send("eth_getLogs", [{
        ...(state.source === "bankr" ? { address: [LONG.address, BANKR_HOOK.address] } : {}),
        fromBlock: toHex(lo), toBlock: toHex(hi),
        topics: state.source === "bags" ? [selector, topicAddress(state.address)] : [selector, null, topicAddress(state.address)],
      }]);
    } catch (error) {
      if (!["log_range", "response_limit"].includes(error.code) || stream.range === 1) throw error;
      stream.range = Math.max(1, Math.floor(stream.range / 2)); continue;
    }
    if (!Array.isArray(logs)) throw new ReadError("invalid_response");
    if (logs.length > 64) {
      if (stream.range === 1) throw new ReadError("response_limit");
      stream.range = Math.max(1, Math.floor(stream.range / 2)); continue;
    }
    state.historyPending = logs.map((log) => checkedLog(log, state, lo, hi, selector));
    range.end = lo;
    if (range.start === range.end) stream.ranges.shift();
    if (logs.length < 16) stream.range = Math.min(state.snapshot.number + 1, stream.range * 2);
    return;
  }
}
async function historyRow(rpc, state, log, warnings) {
  const abi = state.source === "bags" ? bagsFeeAbi : longAbi;
  const event = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true });
  let position, amounts;
  if (state.source === "bags") {
    try { position = await bagsTokenForFee(rpc, log.address, toHex(state.snapshot.number)); }
    catch (error) {
      if (!["contract_changed", "read_failed"].includes(error.code)) throw error;
      warnings.add("bags_unreviewed_claim"); return [];
    }
    amounts = [[event.args.unwrap ? `0x${"0".repeat(40)}` : WETH, event.args.amount]];
  } else {
    position = state.positions.find((entry) => same(entry.pool, event.args.poolId) &&
      same(log.address, entry.target === BANKR_HOOK.id ? BANKR_HOOK.address : LONG.address));
    const target=same(log.address,BANKR_HOOK.address)?BANKR_HOOK:LONG;
    // Wallet-filtered onchain Release logs identify former/transferred
    // beneficiaries even when the creator-only API never listed their pool.
    const block=toHex(state.snapshot.number);
    const pool = await longPool(rpc, event.args.poolId, position?.token, block, "bankr");
    if (!pool) { warnings.add("bankr_unreviewed_route"); return []; }
    if (target.id===BANKR_HOOK.id) {
      const readings=await batch(rpc,[
        {address:target.address,abi:bankrHookAbi,functionName:"INITIALIZER",args:[]},
        {address:target.address,abi:longAbi,functionName:"getPoolKey",args:[pool.id]},
      ],block);
      const key=readings[1];
      if (!same(readings[0],LONG.address) || poolId({currency0:key[0],currency1:key[1],fee:key[2],tickSpacing:key[3],hooks:key[4]})!==pool.id)
        throw new ReadError("contract_changed");
    }
    position={target:target.id,pool:pool.id,token:pool.asset};
    amounts = [[pool.key.currency0, event.args.fees0], [pool.key.currency1, event.args.fees1]];
  }
  const rows = [];
  for (const [currency, amount] of amounts) if (amount > 0n) rows.push({
    id: `${log.blockHash}:${Number(BigInt(log.logIndex))}:${currency.toLowerCase()}`,
    source: state.source, target: state.source === "bags" ? BAGS.id : position.target,
    ...(await rpc.currency(currency, toHex(state.snapshot.number))), raw: amount.toString(),
    block: Number(BigInt(log.blockNumber)), tx: log.transactionHash, destination: state.address,
    token: position.token, position: state.source === "bags" ? position.fee : position.pool,
  });
  return rows;
}
export async function scanVenue(input, { rpc, secret, indexFetcher, bagsKey, discoveryIndex } = {}) {
  const address = normalizeAddress(input.address), source = input.source, scope = input.scope ?? "all";
  let state;
  const renewed = !!input.checkpoint;
  if (input.cursor && (input.checkpoint || input.snapshotCursor) || input.checkpoint && input.snapshotCursor) throw new ReadError("invalid_request");
  const saved = input.cursor ? await open(input.cursor, address, source, secret)
    : input.checkpoint ? await openProgress(input.checkpoint, address, source, secret) : null;
  if (saved && (saved.venueVersion !== 1 || saved.scope !== scope || !Array.isArray(saved.positions) || saved.positions.length > 512 ||
    !Array.isArray(saved.pending) || saved.pending.length > 512 || !Array.isArray(saved.historyPending) || saved.historyPending.length > 64)) throw new ReadError("cursor_expired");
  if (saved || input.snapshotCursor) {
    const prior = saved ?? await open(input.snapshotCursor, address, "snapshot", secret);
    if (BigInt(await rpc.send("eth_chainId")) !== 4663n) throw new ReadError("wrong_chain");
    const canonical = await rpc.send("eth_getBlockByNumber", [toHex(prior.snapshot.number), false]);
    if (!same(canonical?.hash, prior.snapshot.hash)) throw new ReadError("snapshot_changed");
    if (!renewed) state = saved;
  }
  if (!state) {
    const snapshot = input.snapshotCursor ? (await open(input.snapshotCursor, address, "snapshot", secret)).snapshot : await rpc.snapshot();
    if (saved && snapshot.number < saved.snapshot.number) throw new ReadError("snapshot_changed");
    const start = source === "bags" ? BAGS.start : LONG.start;
    state = { version: 1, venueVersion: 1, address, source, scope, snapshot, initialized: false,
      positions: saved?.positions ?? [], pending: source === "bags" ? [...(saved?.positions ?? [])] : [], warnings: [],
      ...(saved?.registry ? {registry:saved.registry} : {}),
      history: { start, ranges: appendRange(saved?.history.ranges ?? [], saved ? saved.snapshot.number + 1 : start, snapshot.number + 1),
        range: Math.max(1, snapshot.number - start + 1) }, historyPending: saved?.historyPending ?? [],
    };
  }
  const block = toHex(state.snapshot.number);
  if (source === "bags") await verifyBagsDeployment(rpc, block);
  else { await rpc.verify(LONG, block); await rpc.verify(BANKR_HOOK, block); }
  if (!state.initialized || source === "bags" && scope !== "history" && bagsKey && !state.bagsIndex)
    await initialize(rpc, state, indexFetcher, bagsKey);
  const bagsIndexed = source === "bags" && state.bagsIndex?.mode === "wallet-index";
  const bankrShared = source === "bankr" && scope === "balances" && !!discoveryIndex;
  if (state.bankrDiscovery && !bankrShared) throw new ReadError("index_unavailable");
  const balances = [], history = [], warnings = new Set(state.warnings);
  if (scope !== "history") {
    if (source === "bags" && !bagsIndexed && !state.pending.length && state.registry.next) await registryPage(rpc, state);
    if (source === "bags" && state.bagsIndex && state.pending.length) {
      const candidates=state.pending.slice(0,2);
      const checked=await bagsIndexedBalances(rpc,state.address,candidates,state.snapshot);
      for (const [index,row] of checked.entries()) {
        if (row) { remember(state,candidates[index]);balances.push(row); }
        if (bagsIndexed) state.bagsIndex.checked++;
      }
      state.pending.splice(0,candidates.length);
    } else for (let work = 0; state.pending.length && work < 2; work++) {
        await readPosition(rpc, state, state.pending[0], balances, warnings);
        state.pending.shift();
      }
  } else state.pending = [];
  if (scope !== "balances") {
    if (!state.historyPending.length) await historyPage(rpc, state);
    for (let work = 0; state.historyPending.length && work < 2; work++) {
      history.push(...await historyRow(rpc, state, state.historyPending[0], warnings));
      state.historyPending.shift();
    }
  }
  let sharedComplete=!bankrShared, sharedCoverage;
  if (bankrShared) {
    state.bankrDiscovery??={profiles:{},turn:0};
    const profiles=[longDiscoveryProfile,bankrDiscoveryProfile];
    const candidate=profiles[state.bankrDiscovery.turn%profiles.length];
    const holder={address:state.address,snapshot:state.snapshot,sharedDiscovery:state.bankrDiscovery.profiles[candidate.namespace]};
    const checked=new Set(state.bankrChecked??[]);
    await sharedDiscoveryPage({rpc,index:discoveryIndex,profile:candidate,state:holder,work:1,verify:async(position)=>{
      const key=`${position.target}:${position.pool??position.token}`;
      if (!checked.has(key)) {
        await readPosition(rpc,state,position,balances,warnings);
        checked.add(key);
      }
    }});
    state.bankrChecked=[...new Set([...(state.bankrChecked??[]),...checked])];
    state.bankrDiscovery.profiles[candidate.namespace]=holder.sharedDiscovery;
    state.bankrDiscovery.turn++;
    const parts=profiles.map((profile)=>state.bankrDiscovery.profiles[profile.namespace]);
    sharedComplete=parts.every((part)=>part?.coverage?.complete&&part.exhausted&&!part.pending.length);
    sharedCoverage={blocksTotal:profiles.reduce((sum,profile)=>sum+Math.max(0,state.snapshot.number-profile.start+1),0),
      blocksChecked:parts.reduce((sum,part)=>sum+(part?.coverage?.blocksChecked??0),0),
      pending:parts.reduce((sum,part)=>sum+(part?.pending?.length??0),0)};
  }
  state.warnings = [...warnings];
  const balanceComplete = sharedComplete && (scope === "history" || (!state.pending.length && (source !== "bags" || bagsIndexed || !state.registry.next)));
  const historyComplete = scope === "balances" || (!state.historyPending.length && !state.history.ranges.length);
  const complete = balanceComplete && historyComplete;
  const registryPercent = bagsIndexed ? state.bagsIndex.total ? state.bagsIndex.checked / state.bagsIndex.total * 100 : 100
    : source === "bags" && state.registry?.total ? (state.registry.total - state.registry.next) / state.registry.total * 100 : balanceComplete ? 100 : 0;
  const historyTotal = Math.max(0, state.snapshot.number - state.history.start + 1);
  const historyChecked = historyTotal - remaining(state.history.ranges);
  const percentage = bankrShared ? 100*sharedCoverage.blocksChecked/Math.max(1,sharedCoverage.blocksTotal) : scope === "balances" ? registryPercent : scope === "history" ? historyTotal ? historyChecked / historyTotal * 100 : 100
    : (registryPercent + (historyTotal ? historyChecked / historyTotal * 100 : 100)) / 2;
  return {
    source, scope, discovery: bankrShared ? "shared-index" : source === "bags" && !bagsIndexed ? "onchain-registry" : "wallet-index",
    snapshot: state.snapshot, checkpoint: await sealProgress(state, secret), resetBalances: renewed && scope !== "history",
    snapshotCursor: await seal({ version: 1, address, source: "snapshot", snapshot: state.snapshot }, secret),
    balances: await Promise.all(balances.map(async (row) => BigInt(row.raw) > 0n
      ? { ...row, claimHandle: await seal({ version: 1, address, source: "claim", row }, secret) } : row)),
    history, warnings: state.warnings,
    coverage: { complete, percent: complete ? 100 : Math.min(99, percentage), pending: state.pending.length + state.historyPending.length + (sharedCoverage?.pending??0),
      ...(sharedCoverage?{blocksTotal:sharedCoverage.blocksTotal,blocksChecked:sharedCoverage.blocksChecked}:{}),
      ...(source === "bags" && scope !== "history" ? bagsIndexed
        ? { positionsChecked: state.bagsIndex.checked, positionsTotal: state.bagsIndex.total, indexPages: 1 }
        : { positionsChecked: state.registry.total - state.registry.next, positionsTotal: state.registry.total } : {}),
      ...(scope !== "balances" ? { blocksTotal: historyTotal, blocksChecked: historyChecked } : {}),
    }, cursor: complete ? null : await seal(state, secret),
  };
}

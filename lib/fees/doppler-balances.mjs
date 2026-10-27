import { isAddress, toHex } from "viem";
import { LONG, LONG_HOOK, BANKR_HOOK } from "./catalog.mjs";
import { longAbi, bankrHookAbi } from "./abi.mjs";
import { ReadError, NATIVE, same, poolId, beneficiaryFees, normalizeAddress } from "./model.mjs";

// These values are reused only inside the same Rpc object and frozen block.
// Caller-supplied pool hints never populate this cache.
const states = new WeakMap();
export function clearDopplerState(rpc) { states.delete(rpc); }
const validId = (value) => typeof value === "string" && /^0x[\da-f]{64}$/i.test(value);
const validAddress = (value) => typeof value === "string" && isAddress(value, { strict: false });
const uint = (value) => typeof value === "bigint" && value >= 0n && value < 1n << 256n;
const read = (address, functionName, args = [], abi = longAbi) => ({ address, abi, functionName, args });
async function batch(rpc, calls, block) {
  const values = typeof rpc.calls === "function" ? await rpc.calls(calls, block)
    : await Promise.all(calls.map((call) => rpc.call(call.address, call.abi, call.functionName, call.args, block)));
  if (!Array.isArray(values) || values.length !== calls.length) throw new ReadError("invalid_response");
  return values;
}
function stateKey(asset, block) { return `${asset.toLowerCase()}:${block}`; }
function rememberState(rpc, asset, block, state) {
  let cache = states.get(rpc);
  if (!cache) { cache = new Map(); states.set(rpc, cache); }
  cache.set(stateKey(asset, block), state);
}
function checkedState(state) {
  if (!Array.isArray(state) || state.length < 6 || !validAddress(state[2]) ||
    !Number.isInteger(state[4]) || state[4] < 0 || state[4] > 255) throw new ReadError("invalid_response");
  checkedKey(state[5]);
  return state;
}
function checkedKey(value) {
  const key = Array.isArray(value)
    ? { currency0: value[0], currency1: value[1], fee: value[2], tickSpacing: value[3], hooks: value[4] }
    : value;
  if (!key || !validAddress(key.currency0) || !validAddress(key.currency1) || !validAddress(key.hooks))
    throw new ReadError("invalid_response");
  try { poolId(key); } catch { throw new ReadError("invalid_response"); }
  return key;
}
async function getState(rpc, asset, block) {
  const cached = states.get(rpc)?.get(stateKey(asset, block));
  if (cached) return cached;
  const state = checkedState(await rpc.call(LONG.address, longAbi, "getState", [asset], block));
  rememberState(rpc, asset, block, state);
  return state;
}

/** Authenticate an indexed token/pool hint against the pinned initializer. */
export async function dopplerPool(rpc, id, asset, block, source = "long") {
  if (!["long", "bankr"].includes(source) || id && !validId(id) || asset && (!validAddress(asset) || same(asset, NATIVE)) || !id && !asset)
    throw new ReadError("invalid_request");
  await rpc.verify(LONG, block);
  if (source !== "bankr") await rpc.verify(LONG_HOOK, block);
  let key;
  if (asset) {
    const state = await getState(rpc, asset, block);
    key = checkedKey(state[5]);
    if (state[4] === 0 || source !== "bankr" && !same(state[2], LONG_HOOK.address)) return null;
  } else {
    key = checkedKey(await rpc.call(LONG.address, longAbi, "getPoolKey", [id], block));
    const tokens = [key.currency0, key.currency1].filter((token) => !same(token, NATIVE));
    const missing = tokens.filter((token) => !states.get(rpc)?.has(stateKey(token, block)));
    if (missing.length) {
      const values = await batch(rpc, missing.map((token) => read(LONG.address, "getState", [token])), block);
      values.forEach((value, index) => rememberState(rpc, missing[index], block, checkedState(value)));
    }
    asset = tokens.find((token) => {
      const state = states.get(rpc).get(stateKey(token, block));
      return state[4] !== 0 && (source === "bankr" || same(state[2], LONG_HOOK.address)) && same(poolId(checkedKey(state[5])), id);
    });
    if (!asset) return null;
  }
  if (!same(key.hooks, LONG.address) || BigInt(key.currency0) >= BigInt(key.currency1)) return null;
  const computed = poolId(key);
  if (id && !same(id, computed)) throw new ReadError("invalid_response");
  return { id: computed, key, asset: asset.toLowerCase() };
}

/** Batch sender-independent getters; keep collection as a wallet-from eth_call. */
export async function dopplerAmounts(rpc, state, pool) {
  const address = normalizeAddress(state.address), block = toHex(state.snapshot.number);
  if (!["long", "bankr"].includes(state.source) || !pool || !validId(pool.id) || !validAddress(pool.asset))
    throw new ReadError("invalid_request");
  if (state.source === "bankr" && state.feeTarget && ![LONG.id, BANKR_HOOK.id].includes(state.feeTarget))
    throw new ReadError("invalid_request");
  const target = state.source === "bankr" && state.feeTarget === BANKR_HOOK.id ? BANKR_HOOK : LONG;
  await rpc.verify(LONG, block);
  await rpc.verify(state.source === "bankr" ? target : LONG_HOOK, block);
  const current = await getState(rpc, pool.asset, block);
  if (!same(poolId(checkedKey(pool.key)), pool.id) || !same(poolId(checkedKey(current[5])), pool.id))
    throw new ReadError("contract_changed");
  if (current[4] !== 2 || state.source !== "bankr" && !same(current[2], LONG_HOOK.address))
    return { target, amounts: null, migrated: true };
  if (target.id === BANKR_HOOK.id && !same(current[2], target.address)) throw new ReadError("contract_changed");
  const calls = [
    read(target.address, "getShares", [pool.id, address]),
    read(target.address, "getCumulatedFees0", [pool.id]),
    read(target.address, "getCumulatedFees1", [pool.id]),
    read(target.address, "getLastCumulatedFees0", [pool.id, address]),
    read(target.address, "getLastCumulatedFees1", [pool.id, address]),
    ...(target.id === BANKR_HOOK.id ? [read(target.address, "INITIALIZER", [], bankrHookAbi), read(target.address, "getPoolKey", [pool.id])] : []),
  ];
  const [shares, c0, c1, l0, l1, initializer, key] = await batch(rpc, calls, block);
  if (![shares, c0, c1, l0, l1].every(uint) || shares > 10n ** 18n) throw new ReadError("invalid_response");
  if (target.id === BANKR_HOOK.id && (!same(initializer, LONG.address) || !same(poolId(checkedKey(key)), pool.id)))
    throw new ReadError("contract_changed");
  if (shares === 0n) return { target, amounts: null, migrated: false };
  // collectFees is caller-dependent. Never fold it into Multicall, which would
  // change msg.sender and could return a different beneficiary's result.
  const collected = await rpc.call(target.address, longAbi, "collectFees", [pool.id], block, address);
  if (!Array.isArray(collected) || collected.length !== 2 || !collected.every(uint)) throw new ReadError("invalid_response");
  return { target, amounts: [beneficiaryFees(c0, collected[0], l0, shares), beneficiaryFees(c1, collected[1], l1, shares)], migrated: false };
}

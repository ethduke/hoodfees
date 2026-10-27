import { LONG, BANKR_HOOK } from "./catalog.mjs";
import { ReadError, same, normalizeAddress } from "./model.mjs";
import { nonzeroAddress } from "./bags.mjs";
import { boundedJson } from "./rpc.mjs";
import { rateLimited } from "./retry.mjs";

// Match the documented upstream five-minute discovery cache. Only public
// candidate identities are retained; amounts and claim authority stay onchain.
// The per-fetcher LRU is process memory only, not a wallet-query database.
export const BANKR_INDEX_CACHE_MS = 5 * 60 * 1000;
const discoveryCaches = new WeakMap();
const MAX_CACHE_ENTRIES = 128;
const copyIndex = (index) => ({ excluded: index.excluded, positions: index.positions.map((position) => ({ ...position })) });

export function parseBankrIndex(body, owner) {
  if (!body || !same(body.address, owner) || !Array.isArray(body.tokens) || body.tokens.length > 512)
    throw new ReadError("invalid_response");
  const positions = new Map();
  let excluded = false;
  for (const item of body.tokens) {
    // The envelope's `chain` is often "base", even for a Robinhood wallet.
    // Only the chain attached to each actual position is authoritative here.
    if (item?.chain !== "robinhood") continue;
    if (!nonzeroAddress(item.tokenAddress) || !/^0x[\da-f]{64}$/i.test(item.poolId) || !nonzeroAddress(item.initializer))
      throw new ReadError("invalid_response");
    const target = !item.feesContract || same(item.feesContract, LONG.address) ? LONG
      : same(item.feesContract, BANKR_HOOK.address) ? BANKR_HOOK : null;
    if (item.source !== "doppler" || !same(item.initializer, LONG.address) || !target) { excluded = true; continue; }
    const pool = item.poolId.toLowerCase(), token = item.tokenAddress.toLowerCase();
    const identity = `${target.id}:${pool}`;
    if (positions.has(identity) && positions.get(identity).token !== token) throw new ReadError("invalid_response");
    positions.set(identity, { target: target.id, pool, token });
  }
  return { positions: [...positions.values()], excluded };
}
async function fetchBankrIndex(owner, fetcher) {
  try {
    const response = await fetcher.call(globalThis, `https://api.bankr.bot/public/doppler/creator-fees/${owner}?days=1`, {
      method: "GET", credentials: "omit", redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw response.status === 429 ? rateLimited(response.headers) : new ReadError("index_unavailable");
    }
    return parseBankrIndex(await boundedJson(response, 2 * 1024 * 1024), owner);
  } catch (error) { throw error instanceof ReadError ? error : new ReadError("index_unavailable"); }
}

export async function readBankrIndex(owner, fetcher = fetch) {
  const address = normalizeAddress(owner);
  let cache = discoveryCaches.get(fetcher);
  if (!cache) { cache = new Map(); discoveryCaches.set(fetcher, cache); }
  let entry = cache.get(address);
  if (entry && entry.expires <= Date.now()) { cache.delete(address); entry = undefined; }
  if (entry) {
    cache.delete(address); cache.set(address, entry);
    return copyIndex(await entry.promise);
  }
  entry = { expires: Infinity, promise: null };
  entry.promise = fetchBankrIndex(address, fetcher).then((index) => {
    entry.expires = Date.now() + BANKR_INDEX_CACHE_MS;
    return index;
  }).catch((error) => {
    if (cache.get(address) === entry) cache.delete(address);
    throw error;
  });
  cache.set(address, entry);
  if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  return copyIndex(await entry.promise);
}

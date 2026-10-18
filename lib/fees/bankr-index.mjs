import { LONG, BANKR_HOOK } from "./catalog.mjs";
import { ReadError, same } from "./model.mjs";
import { nonzeroAddress } from "./bags.mjs";
import { boundedJson } from "./rpc.mjs";

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
export async function readBankrIndex(owner, fetcher = fetch) {
  try {
    const response = await fetcher.call(globalThis, `https://api.bankr.bot/public/doppler/creator-fees/${owner}?days=1`, {
      method: "GET", credentials: "omit", redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ReadError(response.status === 429 ? "rate_limited" : "index_unavailable");
    }
    return parseBankrIndex(await boundedJson(response, 2 * 1024 * 1024), owner);
  } catch (error) { throw error instanceof ReadError ? error : new ReadError("index_unavailable"); }
}

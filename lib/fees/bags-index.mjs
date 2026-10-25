import { ReadError, same, normalizeAddress } from "./model.mjs";
import { BAGS } from "./catalog.mjs";
import { nonzeroAddress } from "./bags.mjs";
import { boundedJson } from "./rpc.mjs";

// This endpoint supplies identities only. Contract reads determine recipients,
// balances and claim authority; API amounts and transaction data are ignored.
export function parseBagsIndex(body, owner, snapshot) {
  const value = body?.response;
  if (body?.success !== true || !value || !Array.isArray(value.positions) || value.positions.length > 512 ||
    typeof value.truncated !== "boolean" || (value.owner !== undefined && !same(value.owner, owner)) ||
    (value.chainId !== undefined && value.chainId !== 4663)) throw new ReadError("invalid_response");
  const positions = new Map();
  let legacy = false;
  for (const entry of value.positions) {
    if (entry?.version === "v1") { legacy = true; continue; }
    if (entry?.version !== "v2" || !nonzeroAddress(entry.token?.address) || !nonzeroAddress(entry.feeShare) ||
      (entry.token.feeShare !== undefined && !same(entry.token.feeShare, entry.feeShare)) ||
      (entry.token.chainId !== undefined && entry.token.chainId !== 4663)) throw new ReadError("invalid_response");
    const created = entry.token.createdAtBlock;
    if (created !== undefined && (!Number.isSafeInteger(created) || created < 0)) throw new ReadError("invalid_response");
    if (created !== undefined && created > snapshot) continue;
    const token = entry.token.address.toLowerCase(), fee = entry.feeShare.toLowerCase();
    if (positions.has(token) && positions.get(token).fee !== fee) throw new ReadError("invalid_response");
    positions.set(token, { target: BAGS.id, token, fee });
  }
  return { positions: [...positions.values()], truncated: value.truncated, legacy };
}

export async function readBagsIndex(owner, snapshot, key, fetcher = fetch) {
  try {
    const address = normalizeAddress(owner);
    if (typeof key !== "string" || !key) throw new ReadError("index_unavailable");
    const response = await fetcher.call(globalThis,
      `https://public-api-v2.bags.fm/api/v1/evm/rh/claimable-positions?owner=${address}`, {
        method: "GET", credentials: "omit", redirect: "manual", cache: "no-store",
        headers: { "x-api-key": key }, signal: AbortSignal.timeout(12000),
      });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ReadError(response.status === 429 ? "rate_limited" : "index_unavailable");
    }
    return parseBagsIndex(await boundedJson(response, 2 * 1024 * 1024), address, snapshot);
  } catch (error) { throw error instanceof ReadError ? error : new ReadError("index_unavailable"); }
}

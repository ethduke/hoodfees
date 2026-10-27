import { isAddress } from "viem";
import { PAIR } from "./catalog.mjs";
import { boundedJson } from "./rpc.mjs";
import { ReadError, normalizeAddress, same, NATIVE } from "./model.mjs";
import { rateLimited } from "./retry.mjs";

// Identities only: amounts, metadata, claim functions and transaction payloads
// supplied by the index never authorize a balance or a wallet transaction.
export function parsePairIndex(body) {
  if (!Array.isArray(body)) throw new ReadError("invalid_response");
  const assets = new Set();
  let excluded = false;
  for (const entry of body) {
    if (!isAddress(entry?.lockerAddress, { strict: false })) throw new ReadError("invalid_response");
    if (!same(entry.lockerAddress, PAIR.address)) { excluded = true; continue; }
    if (!isAddress(entry.claimAssetAddress, { strict: false }) || same(entry.claimAssetAddress, NATIVE))
      throw new ReadError("invalid_response");
    assets.add(entry.claimAssetAddress.toLowerCase());
  }
  return { assets: [...assets], excluded };
}
export async function readPairIndex(owner, fetcher = fetch) {
  try {
    const address = normalizeAddress(owner);
    const response = await fetcher.call(globalThis, `https://pair.fund/api/fees/claimable/${address}`, {
      method: "GET", credentials: "omit", redirect: "manual", cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw response.status === 429 ? rateLimited(response.headers) : new ReadError("index_unavailable");
    }
    return parsePairIndex(await boundedJson(response));
  } catch (error) { throw error instanceof ReadError ? error : new ReadError("index_unavailable"); }
}

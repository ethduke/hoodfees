import { O1 } from "./catalog.mjs";
import { ReadError, NATIVE, same } from "./model.mjs";
import { boundedJson } from "./rpc.mjs";

export const O1_INDEX_PAGE_SIZE = 8;
const validAddress = (value) => typeof value === "string" && /^0x[\da-f]{40}$/i.test(value);
export function parseO1Index(body, address) {
  const pagination = body?.pagination;
  if (!Array.isArray(body?.data) || body.data.length > O1_INDEX_PAGE_SIZE ||
    typeof pagination?.has_more !== "boolean" || (pagination.has_more
      ? typeof pagination.next_cursor !== "string" || !pagination.next_cursor.length || pagination.next_cursor.length > 4096
      : pagination.next_cursor !== null)) throw new ReadError("invalid_response");
  const positions = new Map();
  let excluded = false;
  for (const item of body.data) {
    if (item?.chain_id !== 4663 || !same(item.recipient, address) ||
      !validAddress(item.fee_escrow_address) || same(item.fee_escrow_address, NATIVE) ||
      !validAddress(item.currency?.address) || !["confirmed", "pending", "unavailable"].includes(item.reconciliation) ||
      typeof item.claimable_raw !== "string" || !/^\d{1,78}$/.test(item.claimable_raw)) throw new ReadError("invalid_response");
    const target = O1.find((target) => same(target.address, item.fee_escrow_address));
    if (!target) { excluded = true; continue; }
    const currency = item.currency.address.toLowerCase();
    positions.set(`${target.id}:${currency}`, { target, currency });
  }
  return { positions: [...positions.values()], cursor: pagination.next_cursor, excluded };
}
export async function readO1Index(address, cursor, key, fetcher = fetch) {
  if (typeof key !== "string" || !key.length) throw new ReadError("index_unavailable");
  const url = new URL(`/v1/wallets/${address}/fee-claims`, "https://api.launch.o1.exchange");
  url.search = new URLSearchParams({ chain_id: "4663", market: "all", state: "all", limit: String(O1_INDEX_PAGE_SIZE), ...(cursor ? {cursor} : {}) }).toString();
  try {
    const response = await fetcher.call(globalThis, url.toString(), {
      method: "GET", credentials: "omit", headers: { "x-api-key": key },
      redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ReadError(response.status === 429 ? "rate_limited"
        : cursor && [400,409].includes(response.status) ? "index_cursor_expired" : "index_unavailable");
    }
    return parseO1Index(await boundedJson(response, 256 * 1024), address);
  } catch (error) {
    throw error instanceof ReadError ? error : new ReadError("index_unavailable");
  }
}
export function initialO1Index() { return { cursor: null, pages: 0, complete: false, cursors: [] }; }
export async function cursorDigest(cursor) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(cursor)))].map((byte)=>byte.toString(16).padStart(2,"0")).join("");
}

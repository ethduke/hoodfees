import { prepareClaim, confirmClaim } from "./claims.mjs";
import { scan } from "./engine.mjs";
import { SOURCE_INFO } from "./catalog.mjs";
import { ReadError } from "./model.mjs";
const allowedCodes = new Set([
  "invalid_address",
  "invalid_source",
  "invalid_request",
  "cursor_expired",
  "snapshot_changed",
  "wrong_chain",
  "contract_changed",
  "invalid_response",
  "rate_limited",
  "provider_unavailable",
  "read_failed",
  "log_range",
  "response_limit",
  "position_limit",
  "page_limit",
  "nothing_to_claim",
  "wrong_account",
  "gas_limit",
  "quote_expired",
  "index_unavailable",
]);
const headers = {
  "content-type": "application/json",
  "cache-control": "no-store, private",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers });
}
export function sourceResponse() {
  return json({ chainId: 4663, sources: SOURCE_INFO, readOnly: false, scansReadOnly: true, claimsEnabled: true });
}
export function scanResponse(request, options = {}) {
  return operationResponse(request, "scan", ["address", "source", "scope", "cursor", "checkpoint", "positions", "snapshotCursor"], scan, options);
}
export function prepareClaimResponse(request, options = {}) {
  return operationResponse(request, "claim-prepare", ["address", "claimHandle"], prepareClaim, options);
}
export function confirmClaimResponse(request, options = {}) {
  return operationResponse(request, "claim-confirm", ["address", "authorization", "hash"], confirmClaim, options);
}
async function operationResponse(request, intent, keys, operation, options) {
  try {
    const url = new URL(request.url),
      origin = request.headers.get("origin");
    if (
      request.method !== "POST" ||
      request.headers.get("x-hood-intent") !== intent ||
      !request.headers.get("content-type")?.startsWith("application/json") ||
      (origin && origin !== url.origin) ||
      url.search
    )
      return json({ error: "invalid_request" }, 400);
    const reader = request.body?.getReader();
    if (!reader) return json({ error: "invalid_request" }, 400);
    let size = 0,
      body = "";
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 96000) return json({ error: "invalid_request" }, 413);
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
    } finally {
      await reader.cancel();
    }
    let input;
    try {
      input = JSON.parse(body);
    } catch {
      return json({ error: "invalid_request" }, 400);
    }
    if (
      !input ||
      Array.isArray(input) ||
      Object.keys(input).some((k) => !keys.includes(k))
    )
      return json({ error: "invalid_request" }, 400);
    const result = await operation(input, options);
    return json(result);
  } catch (error) {
    // Fixed codes only. No logs, exception strings, upstream bodies, wallet
    // parameters, provider URLs or stack traces cross this boundary.
    const code =
      error instanceof ReadError && allowedCodes.has(error.code)
        ? error.code
        : "provider_unavailable";
    return json(
      { error: code },
      code.startsWith("invalid_")
        ? 400
        : code === "rate_limited"
          ? 429
          : ["cursor_expired", "snapshot_changed", "nothing_to_claim", "wrong_account", "quote_expired"].includes(code)
            ? 409
            : 502,
    );
  }
}

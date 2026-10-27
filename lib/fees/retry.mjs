import { ReadError } from "./model.mjs";

// Preserve provider-directed cooldowns; a busy API can legitimately ask for
// longer than a few minutes (for example an hourly quota reset).
export function retryDelay(headers, now = Date.now()) {
  const value = headers?.get("retry-after");
  const seconds = value?.trim() ? Number(value) : NaN;
  const after = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000
    : value ? Date.parse(value) - now : 0;
  const reset = Number(headers?.get("x-ratelimit-reset"));
  const remaining = headers?.get("x-ratelimit-remaining");
  const resetDelay = remaining !== null && Number(remaining) === 0 && Number.isFinite(reset) && reset > 0
    ? reset * 1000 - now : 0;
  const delay = Math.max(0, Number.isFinite(after) ? after : 0, resetDelay);
  return Number.isSafeInteger(Math.ceil(delay)) ? Math.ceil(delay) : 0;
}

export function rateLimited(headers, scope = "source") {
  const error = new ReadError("rate_limited");
  error.retryAfter = retryDelay(headers);
  error.rateLimitScope = scope === "rpc" ? "rpc" : "source";
  return error;
}

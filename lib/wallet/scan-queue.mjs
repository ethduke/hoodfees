const retryable = new Set(["rate_limited", "provider_unavailable", "index_unavailable", "migration_unavailable"]);

export class ScanError extends Error {
  constructor(code, retryAfter = 0) {
    super(code);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

// Both network requests and cooldowns use the run's signal, so Pause is immediate.
export function waitForScan(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) { resolve(); return; }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/**
 * @param {{
 *   sources: string[], signal: AbortSignal,
 *   isComplete: (source: string) => boolean,
 *   step: (source: string) => Promise<void>,
 *   onRetry?: (source: string, retry: {code: string, attempt: number, delay: number}) => void,
 *   onError?: (source: string, error: unknown) => void,
 *   now?: () => number,
 *   wait?: (ms: number, signal: AbortSignal) => Promise<void>,
 *   interval?: number
 * }} options
 */
export async function runScanQueue({ sources, signal, isComplete, step, onRetry = () => {}, onError = () => {},
  now = Date.now, wait = waitForScan, interval = 1000 }) {
  const queue = [...new Set(sources)], retries = new Map();
  let nextRequest = 0;
  while (queue.length && !signal.aborted) {
    // Completed sources drop out, while unfinished sources take turns.
    for (let i = queue.length - 1; i >= 0; i--) if (isComplete(queue[i])) queue.splice(i, 1);
    if (!queue.length) break;
    const ready = queue.findIndex((source) => (retries.get(source)?.at ?? 0) <= now());
    if (ready < 0 || nextRequest > now()) {
      const earliest = Math.min(...queue.map((source) => retries.get(source)?.at ?? 0));
      await wait(Math.max(nextRequest, earliest) - now(), signal);
      continue;
    }
    const [source] = queue.splice(ready, 1);
    try {
      await step(source);
      retries.delete(source);
      if (!isComplete(source)) queue.push(source);
    } catch (error) {
      if (signal.aborted) break;
      if (error instanceof ScanError && retryable.has(error.code)) {
        const attempt = (retries.get(source)?.attempt ?? 0) + 1;
        // Limit retry traffic indefinitely without inventing a completed result.
        const delay = Math.max(Math.min(30_000, 2000 * 2 ** Math.min(attempt - 1, 4)),
          Math.min(300_000, Math.max(0, Number(error.retryAfter) || 0)));
        retries.set(source, { attempt, at: now() + delay });
        queue.push(source);
        // A shared RPC limit cools down the whole queue, not just this source.
        if (error.code === "rate_limited") nextRequest = now() + delay;
        onRetry(source, { code: error.code, attempt, delay });
      } else onError(source, error);
    }
    nextRequest = Math.max(nextRequest, now() + interval);
  }
}

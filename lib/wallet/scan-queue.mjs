const retryable = new Set(["rate_limited", "provider_unavailable", "index_unavailable", "migration_unavailable"]);

export class ScanError extends Error {
  constructor(code, retryAfter = 0, scope = "rpc") {
    super(code);
    this.code = code;
    this.retryAfter = retryAfter;
    this.scope = scope === "source" ? "source" : "rpc";
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
    const end = Date.now() + ms;
    let timer;
    const tick = () => {
      const remaining = end - Date.now();
      if (remaining <= 0 || signal.aborted) finish();
      else timer = setTimeout(tick, Math.min(remaining, 2_147_483_647));
    };
    tick();
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
 *   interval?: number, concurrency?: number
 * }} options
 */
export async function runScanQueue({ sources, signal, isComplete, step, onRetry = () => {}, onError = () => {},
  now = Date.now, wait = waitForScan, interval = 1000, concurrency = 1 }) {
  if (Number.isSafeInteger(concurrency) && concurrency > 1)
    return runParallelQueue({sources,signal,isComplete,step,onRetry,onError,now,wait,interval,concurrency});
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
          Math.max(0, Number.isSafeInteger(error.retryAfter) ? error.retryAfter : 0));
        retries.set(source, { attempt, at: now() + delay });
        queue.push(source);
        // A shared RPC limit cools down the whole queue, not just this source.
        if (error.code === "rate_limited" && error.scope !== "source") nextRequest = now() + delay;
        onRetry(source, { code: error.code, attempt, delay });
      } else onError(source, error);
    }
    nextRequest = Math.max(nextRequest, now() + interval);
  }
}

// Independent sources may overlap, but a single source never has two cursor
// pages in flight. The shared transport owns provider connection/CU admission;
// the browser also honors the provider's cooldown before dispatching new pages.
async function runParallelQueue({sources,signal,isComplete,step,onRetry,onError,now,wait,interval,concurrency}) {
  const queue=[...new Set(sources)], inFlight=new Map(), retries=new Map();
  let nextRequest=0, rpcCooldown=0, failed=false, failure;
  const launch=(source)=>{
    const promise=Promise.resolve().then(async()=>{
      try {
        await step(source);
        retries.delete(source);
        if (!signal.aborted && !isComplete(source)) queue.push(source);
      } catch(error) {
        if (signal.aborted) return;
        if (error instanceof ScanError && retryable.has(error.code)) {
          const attempt=(retries.get(source)?.attempt??0)+1;
          const delay=Math.max(Math.min(30_000,2000*2**Math.min(attempt-1,4)),
            Math.max(0,Number.isSafeInteger(error.retryAfter)?error.retryAfter:0));
          retries.set(source,{attempt,at:now()+delay});queue.push(source);
          if (error.code==="rate_limited" && error.scope!=="source") rpcCooldown=Math.max(rpcCooldown,now()+delay);
          onRetry(source,{code:error.code,attempt,delay});
        } else onError(source,error);
      } finally { inFlight.delete(source); }
    }).catch(error=>{failed=true;failure=error;});
    inFlight.set(source,promise);
  };
  try {
    while ((queue.length||inFlight.size) && !signal.aborted) {
      if (failed) throw failure;
      for (let index=queue.length-1;index>=0;index--) if (isComplete(queue[index])) queue.splice(index,1);
      while (inFlight.size<concurrency && queue.length && !signal.aborted && Math.max(nextRequest,rpcCooldown)<=now()) {
        const ready=queue.findIndex(source=>(retries.get(source)?.at??0)<=now());
        if (ready<0) break;
        launch(queue.splice(ready,1)[0]);
        nextRequest=Math.max(nextRequest,now()+interval);
      }
      if (!inFlight.size && !queue.length) break;
      // When all slots are occupied, completion is the next useful event. Do
      // not create a timer that could survive a successful request for hours.
      if (inFlight.size>=concurrency || !queue.length) {
        await Promise.race(inFlight.values());
        continue;
      }
      const earliest=Math.min(...queue.map(source=>retries.get(source)?.at??0));
      const delay=Math.max(0,Math.max(earliest,nextRequest,rpcCooldown)-now());
      const timer=new AbortController();
      try {
        await Promise.race([...inFlight.values(),wait(delay,AbortSignal.any([signal,timer.signal]))]);
      } finally { timer.abort(); }
    }
    if (failed) throw failure;
  } finally {
    // Pause aborts each request through the run signal. Wait for their handlers
    // to settle so a later Resume cannot overlap the previous run's pages.
    await Promise.allSettled(inFlight.values());
  }
}

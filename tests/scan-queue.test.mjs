import test from "node:test";
import assert from "node:assert/strict";
import { runScanQueue, ScanError, waitForScan } from "../lib/wallet/scan-queue.mjs";

function clock() {
  let time = 0;
  return { now: () => time, wait: async (ms) => { assert.ok(ms > 0); time += ms; } };
}

test("all five sources continue beyond six requests and twenty seconds, without overlapping pages", async () => {
  const sources = ["o1", "bags", "bankr", "long", "pons"];
  const required = { o1: 1, bags: 35, bankr: 3, long: 12, pons: 15 };
  const pages = Object.fromEntries(sources.map((source) => [source, 0]));
  const calls = [], time = clock();
  let active = 0;
  await runScanQueue({ ...time, sources, signal: new AbortController().signal,
    isComplete: (source) => pages[source] === required[source],
    step: async (source) => {
      assert.equal(++active, 1);
      calls.push(source);
      await Promise.resolve();
      pages[source]++;
      active--;
    },
  });
  assert.deepEqual(pages, required);
  assert.deepEqual(calls.slice(0, 5), sources);
  assert.equal(calls.filter((source) => source === "o1").length, 1);
  assert.ok(time.now() > 20_000);
});

test("429 retries back off the entire queue and honor Retry-After before continuing", async () => {
  const time = clock(), calls = [], retries = [], done = new Set();
  let failures = 0;
  await runScanQueue({ ...time, sources: ["bags", "long"], signal: new AbortController().signal,
    isComplete: (source) => done.has(source),
    step: async (source) => {
      calls.push({ source, at: time.now() });
      if (source === "bags" && failures++ < 3) throw new ScanError("rate_limited", failures === 1 ? 5000 : 0);
      done.add(source);
    },
    onRetry: (_, retry) => retries.push(retry.delay),
    onError: () => assert.fail("rate limit should retry"),
  });
  assert.deepEqual(retries, [5000, 4000, 8000]);
  assert.deepEqual(calls, [
    { source: "bags", at: 0 }, { source: "long", at: 5000 },
    { source: "bags", at: 6000 }, { source: "bags", at: 10000 }, { source: "bags", at: 18000 },
  ]);
  assert.equal(done.size, 2);
});

test("index outages let other sources finish; a recovery clears the retry streak", async () => {
  const time = clock(), done = new Set(), delays = [], calls = [];
  let bankrCalls = 0;
  await runScanQueue({ ...time, sources: ["bankr", "pons"], signal: new AbortController().signal,
    isComplete: (source) => done.has(source),
    step: async (source) => {
      calls.push([source, time.now()]);
      if (source === "bankr") {
        bankrCalls++;
        if (bankrCalls === 1 || bankrCalls === 3) throw new ScanError("index_unavailable");
        if (bankrCalls === 2) return; // One page succeeded, with another still to read.
      }
      done.add(source);
    },
    onRetry: (_, retry) => delays.push(retry.delay),
  });
  assert.deepEqual(delays, [2000, 2000]);
  assert.deepEqual(calls.slice(0, 2), [["bankr", 0], ["pons", 1000]]);
  assert.equal(bankrCalls, 4);
});

test("long outages cap backoff and never become a false completed scan", async () => {
  const time = clock(), controller = new AbortController(), delays = [];
  await runScanQueue({ ...time, sources: ["o1"], signal: controller.signal,
    isComplete: () => false,
    step: async () => { throw new ScanError("provider_unavailable"); },
    onRetry: (_, retry) => {
      delays.push(retry.delay);
      if (delays.length === 8) controller.abort();
    },
    onError: () => assert.fail("temporary outage should not discard progress"),
  });
  assert.deepEqual(delays, [2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]);
});

test("a permanent source error remains incomplete while the other sources finish", async () => {
  const time = clock(), done = new Set(), errors = [];
  await runScanQueue({ ...time, sources: ["long", "pons"], signal: new AbortController().signal,
    isComplete: (source) => done.has(source),
    step: async (source) => {
      if (source === "long") throw new ScanError("contract_changed");
      done.add(source);
    },
    onRetry: () => assert.fail("must not retry a changed contract"),
    onError: (source, error) => errors.push([source, error.code]),
  });
  assert.deepEqual(errors, [["long", "contract_changed"]]);
  assert.deepEqual([...done], ["pons"]);
});

test("Pause cancels an in-flight page; Resume keeps the last committed page and skips completed sources", async () => {
  const time = clock(), controller = new AbortController();
  const saved = { o1: 1, bags: 0 }, calls = [];
  const options = { ...time, sources: ["o1", "bags"],
    isComplete: (source) => saved[source] === (source === "o1" ? 1 : 3),
  };
  await runScanQueue({ ...options, signal: controller.signal,
    step: async (source) => {
      calls.push([source, saved[source]]);
      if (saved[source] === 1) {
        controller.abort();
        throw new DOMException("Cancelled", "AbortError");
      }
      saved[source]++;
    },
    onError: () => assert.fail("Pause is not a source failure"),
  });
  assert.deepEqual(saved, { o1: 1, bags: 1 });
  await runScanQueue({ ...options, signal: new AbortController().signal,
    step: async (source) => { calls.push([source, saved[source]]); saved[source]++; },
  });
  assert.deepEqual(saved, { o1: 1, bags: 3 });
  assert.deepEqual(calls, [["bags", 0], ["bags", 1], ["bags", 1], ["bags", 2]]);
});

test("Pause interrupts a long cooldown immediately and schedules no further requests", async () => {
  const controller = new AbortController();
  let calls = 0;
  await runScanQueue({ sources: ["bags"], signal: controller.signal,
    isComplete: () => false,
    step: async () => { calls++; throw new ScanError("rate_limited", 300_000); },
    wait: async (ms, signal) => {
      assert.ok(ms > 200_000);
      const waiting = waitForScan(ms, signal);
      controller.abort();
      await waiting;
    },
  });
  assert.equal(calls, 1);
});

test("refresh completion of new blocks continues through the saved historical backlog", async () => {
  const time = clock();
  let result, calls = 0;
  await runScanQueue({ ...time, sources: ["pons"], signal: new AbortController().signal,
    isComplete: () => result?.coverage.complete,
    step: async () => {
      calls++;
      result = { updatesComplete: calls === 1, coverage: { complete: calls === 4 } };
    },
  });
  assert.equal(calls, 4);
  assert.equal(result.coverage.complete, true);
});

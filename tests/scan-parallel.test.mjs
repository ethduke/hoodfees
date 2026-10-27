import test from "node:test";
import assert from "node:assert/strict";
import { runScanQueue, ScanError } from "../lib/wallet/scan-queue.mjs";

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
function clockFixture(){
  let time=0;const waits=[];
  return{waits,now:()=>time,wait:async(delay,signal)=>{
    assert.ok(delay>=0);await new Promise(resolve=>setImmediate(resolve));
    if(!signal.aborted){waits.push(delay);time+=delay;}
  }};
}
test("parallel sources overlap while their own cursor pages remain ordered and fairly scheduled",async()=>{
  const first=deferred(),gates={a:deferred(),b:deferred()},started=[],active=new Set(),counts=new Map();
  const running=runScanQueue({sources:["a","b","c"],signal:new AbortController().signal,concurrency:2,interval:0,
    isComplete:source=>(counts.get(source)??0)===2,
    async step(source){
      assert.ok(!active.has(source),"two cursor pages overlapped for one source");active.add(source);
      const number=(counts.get(source)??0)+1;started.push(`${source}:${number}`);
      if(started.length===2)first.resolve();
      if(number===1&&gates[source])await gates[source].promise;
      counts.set(source,number);active.delete(source);
    },onError(_source,error){throw error;},
  });
  await first.promise;assert.deepEqual(started,["a:1","b:1"]);assert.equal(active.size,2);
  gates.a.resolve();
  // Let the freed slot drain; the previously queued source takes its turn
  // before source A receives another page, while B's request remains in flight.
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(started.indexOf("c:1")<started.indexOf("a:2"));assert.ok(active.has("b"));
  gates.b.resolve();await running;
  assert.equal(started.length,6);assert.equal(active.size,0);
});
test("a provider-wide 429 delays all new dispatches and preserves its full Retry-After",async()=>{
  const clock=clockFixture(),calls=[],counts=new Map();
  await runScanQueue({sources:["a","b","c"],signal:new AbortController().signal,concurrency:2,interval:0,...clock,
    isComplete:source=>(counts.get(source)??0)===1,
    async step(source){
      calls.push({source,at:clock.now()});
      if(source==="a"&&calls.filter(call=>call.source==="a").length===1)throw new ScanError("rate_limited",73_000,"rpc");
      counts.set(source,1);
    },onError(_source,error){throw error;},
  });
  assert.ok(clock.waits.includes(73_000));
  assert.equal(calls.find(call=>call.source==="b").at,0,"an already-dispatched request may finish");
  assert.ok(calls.find(call=>call.source==="c").at>=73_000);
  assert.ok(calls.filter(call=>call.source==="a")[1].at>=73_000);
});
test("an index-only hourly limit cools down that source while other launchpads keep scanning",async()=>{
  const clock=clockFixture(),calls=[],counts=new Map();let limited=false;
  await runScanQueue({sources:["bags","o1","pons"],signal:new AbortController().signal,concurrency:2,interval:0,...clock,
    isComplete:source=>(counts.get(source)??0)===(source==="bags"?1:2),
    async step(source){
      calls.push({source,at:clock.now()});
      if(source==="bags"&&!limited){limited=true;throw new ScanError("rate_limited",3_600_000,"source");}
      counts.set(source,(counts.get(source)??0)+1);
    },onError(_source,error){throw error;},
  });
  assert.ok(clock.waits.includes(3_600_000));
  assert.ok(calls.filter(call=>call.source!=="bags").every(call=>call.at===0));
  assert.equal(calls.filter(call=>call.source==="bags")[1].at,3_600_000);
});
test("Pause aborts all in-flight pages, waits for settlement and dispatches no remaining source",async()=>{
  const controller=new AbortController(),started=deferred(),calls=[];let settled=0;
  const running=runScanQueue({sources:["a","b","c"],signal:controller.signal,concurrency:2,interval:0,isComplete:()=>false,
    async step(source){
      calls.push(source);if(calls.length===2)started.resolve();
      try{await new Promise((_resolve,reject)=>controller.signal.addEventListener("abort",()=>reject(new Error("aborted")),{once:true}));}
      finally{await Promise.resolve();settled++;}
    },onError(){assert.fail("an aborted page became a permanent source error");},
  });
  await started.promise;controller.abort();await running;
  assert.deepEqual(calls,["a","b"]);assert.equal(settled,2);
});
test("parallel retries have no scan-pass cap and permanent errors do not stop other sources",async()=>{
  const clock=clockFixture();let attempts=0,done=false;const errors=[];
  await runScanQueue({sources:["retry","bad","good"],signal:new AbortController().signal,concurrency:3,interval:0,...clock,
    isComplete:source=>source==="retry"?attempts===40:source==="good"?done:false,
    async step(source){
      if(source==="retry"&&++attempts<40)throw new ScanError("provider_unavailable");
      if(source==="bad")throw new ScanError("contract_changed");
      if(source==="good")done=true;
    },onError(source,error){errors.push([source,error.code]);},
  });
  assert.equal(attempts,40);assert.equal(done,true);assert.deepEqual(errors,[["bad","contract_changed"]]);
});

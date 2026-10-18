import test from "node:test";
import assert from "node:assert/strict";
import { ScanCache } from "../lib/wallet/scan-cache.mjs";
import { O1 } from "../lib/fees/catalog.mjs";
import { NATIVE } from "../lib/fees/model.mjs";

const wallet = `0x${"11".repeat(20)}`, other = `0x${"22".repeat(20)}`;
function setup() {
  const values = new Map();
  const host = { localStorage: {
    get length() {return values.size;},
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  } };
  return { cache: new ScanCache(host), host, values };
}
function progress() {
  const row = {id:"native", source:"o1", target:O1[0].id, currency:NATIVE, raw:"12", symbol:"ETH", decimals:18, metadataVerified:true, kind:"available", claimHandle:"fixture.handle"};
  const state = (scope) => ({pages:2, balances:scope === "balances" ? [row] : [], history:[], result:{
    source:"o1", scope, snapshot:{number:100,hash:`0x${"33".repeat(32)}`}, snapshotCursor:"fixture.snapshot",
    cursor:`fixture.${scope}`, checkpoint:`durable.${scope}`, coverage:{complete:false,percent:20,pending:0},warnings:[],
  }});
  return {balances:{o1:state("balances")},history:{o1:state("history")},selected:["o1","pons"],historyStarted:true};
}
test("browser progress restores independent fee/history cursors, rows and source choices across instances", () => {
  const {cache,host}=setup(), input=progress();
  assert.ok(cache.save(wallet,input));
  const saved=new ScanCache(host).load(wallet.toUpperCase().replace("0X","0x"));
  assert.deepEqual(saved.balances,input.balances);
  assert.deepEqual(saved.history,input.history);
  assert.deepEqual(saved.selected,input.selected);
  assert.equal(saved.historyStarted,true);
  assert.equal(saved.chainId,4663);
  assert.equal(cache.load(other),null);
});
test("reset removes only the chosen wallet and does not erase unrelated browser data", () => {
  const {cache,values}=setup();
  cache.save(wallet,progress());cache.save(other,progress());values.set("unrelated","kept");
  assert.equal(cache.remove(wallet),true);
  assert.equal(cache.load(wallet),null);
  assert.ok(cache.load(other));
  assert.equal(values.get("unrelated"),"kept");
});
test("corrupt, mismatched and incompatible cached records fail closed without throwing", () => {
  for (const mutate of [
    (x)=>({...x,chainId:1}), (x)=>({...x,address:other}), (x)=>({...x,version:2}),
    (x)=>({...x,selected:["unknown"]}),
    (x)=>{x.balances.o1.balances[0].raw="invalid";return x;},
    (x)=>{x.balances.o1.result.scope="history";return x;},
    (x)=>{x.balances.o1.result.coverage.percent=null;return x;},
  ]) {
    const {cache,values}=setup();cache.save(wallet,progress());
    const key=[...values.keys()][0];values.set(key,JSON.stringify(mutate(JSON.parse(values.get(key)))));
    assert.equal(cache.load(wallet),null);
  }
  const {cache,values}=setup();cache.save(wallet,progress());values.set([...values.keys()][0],"broken json");
  assert.equal(cache.load(wallet),null);
});
test("denied or full browser storage never interrupts scanning and is reported by the cache", () => {
  const denied = new ScanCache({get localStorage(){throw Error("withheld");}});
  assert.equal(denied.save(wallet,progress()),null);
  assert.equal(denied.load(wallet),null);
  assert.equal(denied.remove(wallet),false);
  const {cache}=setup();
  assert.equal(cache.save(wallet,{excess:"x".repeat(2_000_001)}),null);
});

test("local backup restores signed fee/history checkpoints and all wallets across site origins", () => {
  const old=setup(), next=setup();
  old.cache.save(wallet,progress());old.cache.save(other,progress());old.values.set("unrelated","private value");
  const backup=old.cache.exportProgress();
  assert.equal(backup.count,2);assert.equal(backup.data.includes("private value"),false);
  assert.deepEqual(next.cache.importProgress(backup.data),{imported:2,kept:0});
  assert.deepEqual(next.cache.load(wallet),old.cache.load(wallet));
  assert.deepEqual(next.cache.load(other),old.cache.load(other));
  assert.ok(old.cache.load(wallet));
  assert.deepEqual(next.cache.importProgress(backup.data),{imported:0,kept:2});
});
test("restore preserves newer progress and rejects malformed or mixed-chain backups before writing", () => {
  const old=setup(), next=setup();old.cache.save(wallet,progress());
  const backup=JSON.parse(old.cache.exportProgress().data);backup.wallets[0].savedAt=1;
  next.cache.save(wallet,progress());const saved=next.cache.load(wallet);
  assert.deepEqual(next.cache.importProgress(JSON.stringify(backup)),{imported:0,kept:1});
  for(const mutate of [x=>({...x,chainId:1}),x=>({...x,format:"other"}),x=>({...x,wallets:[...x.wallets,...x.wallets]}),
    x=>{x.wallets[0].balances.o1.result.checkpoint={bad:true};return x;}]) {
    const raw=JSON.stringify(mutate(JSON.parse(JSON.stringify(backup))));
    assert.throws(()=>next.cache.importProgress(raw),e=>e.message==="restore_failed");
    assert.deepEqual(next.cache.load(wallet),saved);
  }
});
test("failed restore rolls back earlier writes and never exposes storage errors", () => {
  const old=setup(),next=setup();old.cache.save(wallet,progress());old.cache.save(other,progress());
  const set=next.host.localStorage.setItem;next.host.localStorage.setItem=(key,value)=>{
    if(key.endsWith(other))throw Error("withheld storage detail");set(key,value);
  };
  assert.throws(()=>next.cache.importProgress(old.cache.exportProgress().data),e=>e.message==="restore_failed");
  assert.equal(next.cache.load(wallet),null);assert.equal(next.cache.load(other),null);
  assert.throws(()=>new ScanCache({get localStorage(){throw Error("withheld");}}).exportProgress(),e=>e.message==="backup_unavailable");
});

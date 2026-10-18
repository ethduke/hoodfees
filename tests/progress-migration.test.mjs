import test from "node:test";
import assert from "node:assert/strict";
import {seal,sealProgress,openProgress} from "../lib/fees/cursor.mjs";
import {verifyProgress,scanWithMigration} from "../lib/fees/progress-migration.mjs";
import {migrateProgressResponse} from "../lib/fees/api.mjs";
import {ReadError} from "../lib/fees/model.mjs";
const address=`0x${"11".repeat(20)}`,oldKey="old-fixture-"+"x".repeat(40),newKey="new-fixture-"+"y".repeat(40);
const state={version:1,address,source:"o1",scope:"balances",snapshot:{number:100,hash:`0x${"22".repeat(32)}`},streams:[{start:1,next:40}],positions:[],seen:[]};
test("verified handoff preserves unfinished ranges and scope under the new signing key",async()=>{
  const old=await sealProgress(state,oldKey);
  const result=await verifyProgress({address,source:"o1",checkpoint:old},{secret:oldKey});
  assert.deepEqual(result,{verified:true});
  const restored=await openProgress(old,address,"o1",oldKey);
  assert.deepEqual(restored.streams,state.streams);assert.equal(restored.scope,"balances");
  await assert.rejects(verifyProgress({address,source:"o1",checkpoint:old+"bad"},{secret:oldKey}));
});
test("claim permissions and missing verification keys cannot migrate",async()=>{
  const claim=await seal({...state,source:"claim"},oldKey);
  await assert.rejects(verifyProgress({address,source:"o1",checkpoint:claim},{secret:oldKey}));
  await assert.rejects(verifyProgress({address,source:"o1",checkpoint:claim},{}),e=>e.code==="migration_unavailable");
});
test("scan handoff contacts only the configured previous host and verifies the exact old checkpoint before locally re-signing it",async()=>{
  const old=await sealProgress(state,oldKey),renewed=await verifyProgress({address,source:"o1",checkpoint:old},{secret:oldKey});
  let calls=0;
  const result=await scanWithMigration({address,source:"o1",scope:"balances",checkpoint:old},{secret:newKey,legacyProgressUrl:"https://previous.example.invalid",migrationFetcher:async(url,settings)=>{
    assert.equal(url,"https://previous.example.invalid/api/progress/migrate");assert.equal(settings.redirect,"manual");
    assert.equal(JSON.parse(settings.body).checkpoint,old);return Response.json(renewed);
  }},async(input)=>{if(++calls===1)throw new ReadError("cursor_expired");const restored=await openProgress(input.checkpoint,address,"o1",newKey);return {resumed:restored.streams[0].next};});
  assert.deepEqual(result,{resumed:40});assert.equal(calls,2);
});
test("handoff failures are bounded and redacted; API still rejects cross-origin requests",async()=>{
  const token=await sealProgress(state,oldKey);
  await assert.rejects(scanWithMigration({address,source:"o1",checkpoint:token},{secret:newKey,legacyProgressUrl:"https://previous.example.invalid",migrationFetcher:async()=>Response.json({checkpoint:token})},async()=>{throw new ReadError("cursor_expired");}),e=>e.code==="migration_unavailable");
  const request=new Request("https://app.example.invalid/api/progress/migrate",{method:"POST",headers:{origin:"https://foreign.example.invalid","content-type":"application/json","x-hood-intent":"progress-migrate"},body:JSON.stringify({address,source:"o1",checkpoint:token})});
  const response=await migrateProgressResponse(request,{secret:oldKey});assert.equal(response.status,400);assert.deepEqual(await response.json(),{error:"invalid_request"});
});

import test from "node:test";
import assert from "node:assert/strict";
import {workerApi} from "../lib/worker-api.mjs";
const origin="https://app.example.invalid",revision="ab".repeat(20);
test("Workers runtime fails closed when private bindings or a stable signing key are missing",async()=>{
  for(const env of [{},{ROBINHOOD_RPC_URL:"withheld",O1_API_KEY:"withheld",SCAN_CURSOR_SECRET:"short"}]){
    const health=await workerApi(new Request(origin+"/api/health"),env,revision);
    assert.equal(health.status,503);assert.deepEqual(await health.json(),{status:"unconfigured",revision,chainId:4663});
    for(const path of ["/api/scan","/api/claim/prepare","/api/claim/confirm"]){
      const response=await workerApi(new Request(origin+path,{method:"POST"}),env,revision);
      assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:"provider_unavailable"});
    }
  }
});
test("Workers health exposes only release metadata; API method and same-origin protections remain enforced",async()=>{
  const env={ROBINHOOD_RPC_URL:"https://provider.example.invalid/withheld",O1_API_KEY:"withheld",SCAN_CURSOR_SECRET:"fixture-"+"x".repeat(40)};
  const health=await workerApi(new Request(origin+"/api/health"),env,revision);
  assert.deepEqual(await health.json(),{status:"ok",revision,chainId:4663});
  const get=await workerApi(new Request(origin+"/api/claim/prepare"),env,revision);
  assert.equal(get.status,405);assert.equal(get.headers.get("allow"),"POST");
  const crossOrigin=await workerApi(new Request(origin+"/api/claim/prepare",{method:"POST",headers:{origin:"https://foreign.example.invalid","content-type":"application/json","x-hood-intent":"claim-prepare"},body:"{}"}),env,revision);
  assert.equal(crossOrigin.status,400);assert.deepEqual(await crossOrigin.json(),{error:"invalid_request"});
  const sources=await workerApi(new Request(origin+"/api/sources"),env,revision);
  assert.equal(sources.status,200);assert.equal((await sources.json()).claimsEnabled,true);
  assert.equal(await workerApi(new Request(origin+"/"),env,revision),null);
});

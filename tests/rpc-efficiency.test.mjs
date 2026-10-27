import test from "node:test";
import assert from "node:assert/strict";
import { parseAbi, decodeFunctionData, encodeFunctionResult, keccak256 } from "viem";
import { Rpc } from "../lib/fees/rpc.mjs";
import { retryDelay, rateLimited } from "../lib/fees/retry.mjs";
import { scanResponse } from "../lib/fees/api.mjs";

const aggregate=parseAbi(["struct Call3 {address target;bool allowFailure;bytes callData;}","struct Result {bool success;bytes returnData;}","function aggregate3(Call3[] calls) payable returns (Result[] returnData)"]);
const tokenAbi=parseAbi(["function decimals() view returns (uint8)","function symbol() view returns (string)"]);
const fixtureUrl="https://rpc.example.invalid/withheld";
const token=(i)=>`0x${BigInt(10000+i).toString(16).padStart(40,"0")}`;
function metadataRpc({bad=false}={}) {
  let count=0;
  const rpc=new Rpc(fixtureUrl,async(_url,init)=>{
    count++;
    const body=JSON.parse(init.body),decoded=decodeFunctionData({abi:aggregate,data:body.params[0].data});
    const results=decoded.args[0].map((call)=>{
      const read=decodeFunctionData({abi:tokenAbi,data:call.callData});
      return {success:!(bad&&read.functionName==="decimals"),returnData:encodeFunctionResult({abi:tokenAbi,functionName:read.functionName,result:read.functionName==="decimals"?18:"TEST"})};
    });
    return Response.json({jsonrpc:"2.0",id:1,result:encodeFunctionResult({abi:aggregate,functionName:"aggregate3",result:results})});
  });
  rpc.verify=async()=>{};
  return {rpc,count:()=>count};
}

test("all token metadata is prefetched in bounded batches and reused at the exact snapshot",async()=>{
  const {rpc,count}=metadataRpc(),addresses=Array.from({length:130},(_,i)=>token(i));
  await rpc.prefetchCurrencies(addresses,"0x123400");
  assert.equal(count(),3);
  for(const address of addresses) assert.deepEqual(await rpc.currency(address,"0x123400"),{currency:address,symbol:"TEST",decimals:18,metadataVerified:true});
  assert.equal(count(),3);
  await rpc.prefetchCurrencies([addresses[0]],"0x123401");assert.equal(count(),4);
});
test("a failed token decimals read is never labeled verified",async()=>{
  const {rpc}=metadataRpc({bad:true});await rpc.prefetchCurrencies([token(600)],"0x123402");
  assert.equal((await rpc.currency(token(600),"0x123402")).metadataVerified,false);
});
test("transport does not fabricate a local RPC quota or reject concurrent reads",async()=>{
  let calls=0;
  const rpc=new Rpc(fixtureUrl,async()=>{calls++;return Response.json({jsonrpc:"2.0",id:1,result:"0x10"});});
  await Promise.all(Array.from({length:120},()=>rpc.send("eth_blockNumber")));
  assert.equal(calls,120);assert.equal(rpc.count,120);
});
test("simultaneous bytecode checks share work but all callers wait for verification",async()=>{
  const address=token(700),code="0x60006000",profile={address,hash:keccak256(code)};
  let release,calls=0;
  const pending=new Promise(resolve=>{release=resolve;});
  const rpc=new Rpc(fixtureUrl,async()=>{calls++;await pending;return Response.json({jsonrpc:"2.0",id:1,result:code});});
  let completed=false;const first=rpc.verify(profile,"0x123403"),second=rpc.verify(profile,"0x123403").then(()=>{completed=true;});
  await Promise.resolve();assert.equal(completed,false);assert.equal(calls,1);
  release();await Promise.all([first,second]);assert.equal(completed,true);
});
test("failed code verification is not cached as success",async()=>{
  const profile={address:token(701),hash:keccak256("0x60016001")};let calls=0;
  const rpc=new Rpc(fixtureUrl,async()=>{calls++;return Response.json({jsonrpc:"2.0",id:1,result:"0x60006000"});});
  for(let attempt=0;attempt<2;attempt++)await assert.rejects(rpc.verify(profile,"0x123404"),error=>error.code==="contract_changed");
  assert.equal(calls,2);
});
test("provider cooldowns keep hourly resets and HTTP dates without a five-minute cap",()=>{
  const now=Date.parse("2026-10-27T12:00:00Z");
  assert.equal(retryDelay(new Headers({"retry-after":"3600"}),now),3_600_000);
  assert.equal(retryDelay(new Headers({"retry-after":"Tue, 27 Oct 2026 13:00:00 GMT"}),now),3_600_000);
  assert.equal(retryDelay(new Headers({"x-ratelimit-remaining":"0","x-ratelimit-reset":String((now+3_600_000)/1000)}),now),3_600_000);
  assert.equal(rateLimited(new Headers()).rateLimitScope,"source");
});
test("scan API forwards only safe quota timing and scope, never upstream errors",async()=>{
  const origin="https://app.example.invalid";
  const request=new Request(origin+"/api/scan",{method:"POST",headers:{origin,"content-type":"application/json","x-hood-intent":"scan"},body:JSON.stringify({address:`0x${"11".repeat(20)}`,source:"o1",scope:"balances"})});
  const response=await scanResponse(request,{url:fixtureUrl,secret:"fixture-"+"x".repeat(40),fetcher:async()=>new Response("PRIVATE_SENTINEL",{status:429,headers:{"retry-after":"3600"}})});
  assert.equal(response.status,429);assert.equal(response.headers.get("retry-after"),"3600");assert.equal(response.headers.get("x-hood-rate-scope"),"rpc");
  assert.deepEqual(await response.json(),{error:"rate_limited"});
});

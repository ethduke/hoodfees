import test from "node:test";
import assert from "node:assert/strict";
import { toHex } from "viem";
import { scan } from "../lib/fees/engine.mjs";
import { scanResponse } from "../lib/fees/api.mjs";
import { openProgress, sealProgress } from "../lib/fees/cursor.mjs";
import { parseO1Index, readO1Index } from "../lib/fees/o1-index.mjs";
import { O1 } from "../lib/fees/catalog.mjs";
import { NATIVE, ReadError } from "../lib/fees/model.mjs";

const wallet=`0x${"11".repeat(20)}`,asset=`0x${"22".repeat(20)}`,other=`0x${"44".repeat(20)}`;
const secret="index-fixture-"+"x".repeat(40),height=88000000;
const item=(currency=asset)=>({chain_id:4663,recipient:wallet,fee_escrow_address:O1[0].address,
  currency:{address:currency},claimable_raw:"999999999",reconciliation:"confirmed"});
const body=(data=[],cursor=null)=>({data,pagination:{has_more:!!cursor,next_cursor:cursor}});
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});
function fixture(fetcher) {
  const rpc={height,verified:[],callsMade:[],logs:0,
    async snapshot(){return {number:this.height,hash:toHex(this.height,{size:32}),timestamp:1};},
    async verify(target){this.verified.push(target.id);},
    async currency(currency){return {currency,symbol:"TEST",decimals:18,metadataVerified:true};},
    async call(target,abi,name,args,block){this.callsMade.push({target,name,args,block});assert.equal(name,"owed");return args[1]===NATIVE?0n:7n;},
    async calls(calls,block){return Promise.all(calls.map(c=>this.call(c.address,c.abi,c.functionName,c.args,block)));},
    async send(method,params){
      if(method==="eth_chainId")return toHex(4663);
      if(method==="eth_getBlockByNumber")return {hash:toHex(Number(BigInt(params[0])),{size:32})};
      if(method==="eth_getLogs"){this.logs++;return [];}
      throw new ReadError("invalid_request");
    },
  };
  return {rpc,options:{secret,o1Key:"fixture-key",indexFetcher:fetcher,createRpc:()=>rpc}};
}
test("O1 index supplies identities only; pinned contracts and onchain owed amounts determine claimable rows",async()=>{
  const {rpc,options}=fixture(async function(url,settings){
    assert.equal(this,globalThis);assert.equal(new URL(url).origin,"https://api.launch.o1.exchange");
    assert.ok(new URL(url).pathname.endsWith(`/wallets/${wallet}/fee-claims`));
    assert.equal(new URL(url).searchParams.get("limit"),"8");assert.equal(new URL(url).searchParams.get("chain_id"),"4663");
    assert.equal(settings.headers["x-api-key"],"fixture-key");assert.equal(settings.redirect,"manual");
    return json(body([item(),item()]));
  });
  const result=await scan({address:wallet,source:"o1",scope:"balances"},options);
  assert.deepEqual(rpc.verified,O1.map(target=>target.id));
  assert.equal(result.discovery,"wallet-index");assert.equal(result.coverage.complete,true);
  assert.equal(result.balances.find(row=>row.currency===asset).raw,"7");
  assert.ok(result.balances.find(row=>row.currency===asset).claimHandle);
  assert.equal(rpc.callsMade.filter(call=>call.args[1]===asset).length,1);
  assert.equal(rpc.logs,0);assert.equal(result.history.length,0);
});
test("index pagination and durable checkpoints survive expiration and preserve already-known positions",async()=>{
  let page=0;
  const {rpc,options}=fixture(async()=>json(++page===1?body([item()],"next-page"):body([item(other)])));
  const first=await scan({address:wallet,source:"o1",scope:"balances"},options);
  assert.equal(first.coverage.complete,false);assert.ok(first.cursor);
  const next=await scan({address:wallet,source:"o1",scope:"balances",cursor:first.cursor},options);
  assert.equal(next.coverage.complete,true);assert.equal(next.balances[0].currency,other);
  const realNow=Date.now;Date.now=()=>realNow()+3*86400000;
  try{
    rpc.height+=100;page=0;
    let result=await scan({address:wallet,source:"o1",scope:"balances",checkpoint:next.checkpoint},options);
    const rows=[...result.balances];
    assert.equal(result.resetBalances,true);
    while(result.cursor&&!result.updatesComplete){result=await scan({address:wallet,source:"o1",scope:"balances",cursor:result.cursor},options);rows.push(...result.balances);}
    assert.equal(result.coverage.complete,true);
    assert.ok(rows.some(row=>row.currency===asset&&row.raw==="7"));
    assert.ok(rows.some(row=>row.currency===other&&row.raw==="7"));
    assert.equal(rpc.logs,0);
  }finally{Date.now=realNow;}
});
test("existing log checkpoints migrate to the index while retaining known currencies",async()=>{
  const {rpc,options}=fixture(async()=>json(body([])));
  const first=await scan({address:wallet,source:"o1",scope:"balances"},{...options,o1Key:undefined});
  const state=await openProgress(first.checkpoint,wallet,"o1",secret);
  state.positions.push({target:O1[0].id,currency:asset});state.seen.push(`${O1[0].id}:${asset}`);
  rpc.height+=20;
  const result=await scan({address:wallet,source:"o1",scope:"balances",checkpoint:await sealProgress(state,secret)},options);
  assert.equal(result.discovery,"wallet-index");assert.equal(result.coverage.complete,true);
  assert.ok(result.balances.some(row=>row.currency===asset&&row.raw==="7"));
  assert.equal(rpc.logs,0);
});
test("unknown escrows are excluded and foreign wallets, chains and malformed pages fail closed",async()=>{
  assert.equal(parseO1Index(body([{...item(),fee_escrow_address:other}]),wallet).excluded,true);
  const {options}=fixture(async()=>json(body([{...item(),fee_escrow_address:other}])));
  const result=await scan({address:wallet,source:"o1",scope:"balances"},options);
  assert.ok(result.warnings.includes("o1_unreviewed_escrow"));
  assert.ok(result.balances.every(row=>row.currency===NATIVE));
  for(const malformed of [body([{...item(),recipient:other}]),body([{...item(),chain_id:8453}]),body([{...item(),claimable_raw:"bad"}]),body(Array(9).fill(item())),{data:[],pagination:{has_more:true,next_cursor:null}}])
    assert.throws(()=>parseO1Index(malformed,wallet),e=>e.code==="invalid_response");
});
test("expired upstream pagination restarts only the small wallet list and repeated cursors are rejected",async()=>{
  let request=0;
  const {options}=fixture(async()=>++request===1?json(body([item()],"expired")):request===2?json({error:"withheld"},409):json(body([item(other)])));
  const first=await scan({address:wallet,source:"o1",scope:"balances"},options);
  const next=await scan({address:wallet,source:"o1",scope:"balances",cursor:first.cursor},options);
  assert.equal(next.coverage.complete,true);assert.equal(next.resetBalances,false);
  const cyclic=fixture(async()=>json(body([],"repeated")));
  const initial=await scan({address:wallet,source:"o1",scope:"balances"},cyclic.options);
  await assert.rejects(scan({address:wallet,source:"o1",scope:"balances",cursor:initial.cursor},cyclic.options),e=>e.code==="invalid_response");
});
test("index failures never leak upstream text or credentials; history still uses onchain payout events",async()=>{
  for(const [status,code]of [[401,"index_unavailable"],[302,"index_unavailable"],[429,"rate_limited"]])
    await assert.rejects(readO1Index(wallet,null,"fixture-key",async()=>json({secret:"withheld"},status)),e=>e.code===code&&e.message===code);
  const {rpc,options}=fixture(async()=>assert.fail("payout history used the wallet index"));
  const history=await scan({address:wallet,source:"o1",scope:"history"},options);
  assert.equal(history.discovery,undefined);assert.ok(rpc.logs>0);
  const response=await scanResponse(new Request("https://app.example.invalid/api/scan",{method:"POST",headers:{"content-type":"application/json","x-hood-intent":"scan"},body:JSON.stringify({address:wallet,source:"o1",scope:"balances"})}),{...options,indexFetcher:async()=>{throw Error("withheld credential and URL");}});
  assert.deepEqual(await response.json(),{error:"index_unavailable"});
});

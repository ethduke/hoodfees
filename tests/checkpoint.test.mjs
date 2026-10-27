import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, toEventSelector, toHex } from "viem";
import { scan } from "../lib/fees/engine.mjs";
import { open, openProgress, seal, sealProgress } from "../lib/fees/cursor.mjs";
import { O1, LONG, LONG_HOOK, PONS, PONS_V1, PONS_FACTORY } from "../lib/fees/catalog.mjs";
import { o1Legacy } from "../lib/fees/abi.mjs";
import { NATIVE, ReadError, poolId } from "../lib/fees/model.mjs";
import { runScanQueue } from "../lib/wallet/scan-queue.mjs";

const wallet=`0x${"11".repeat(20)}`, asset=`0x${"22".repeat(20)}`, freshAsset=`0x${"44".repeat(20)}`;
const secret="checkpoint-fixture-"+"x".repeat(40), height=88000000;
const hash=(number)=>toHex(number,{size:32});
function fixture() {
  const rpc={height,queries:[],calls:[],
    async snapshot(){return {number:this.height,hash:hash(this.height),timestamp:1};},
    async verify(){},
    async currency(currency){return {currency,symbol:"TEST",decimals:18,metadataVerified:true};},
    async call(target,abi,name,args,block){
      this.calls.push({target,name,args,block});
      if(name==="owed")return args[1]===NATIVE ? (Number(BigInt(block))>height?0n:20n) : Number(BigInt(block))>height?9n:5n;
      if(name==="balanceOf"||name==="balanceOfToken")return 7n;
      if(name==="feeRecipientTokenCount"||name==="deployerTokenCount")return 0n;
      throw new ReadError("read_failed");
    },
    async send(method,params){
      if(method==="eth_chainId")return toHex(4663);
      if(method==="eth_getBlockByNumber")return {hash:hash(Number(BigInt(params[0])))};
      if(method!=="eth_getLogs")throw new ReadError("invalid_request");
      const q=params[0];this.queries.push(q);
      if(q.address!==O1[0].address)return [];
      const selectors=Array.isArray(q.topics[0])?q.topics[0]:[q.topics[0]];
      const name=selectors.includes(toEventSelector(o1Legacy.find(e=>e.name==="Credited")))?"Credited":"Claimed";
      return [[height-3,asset],[height+5,freshAsset]].filter(([number])=>number>=Number(BigInt(q.fromBlock))&&number<=Number(BigInt(q.toBlock))).map(([number,currency])=>({
        address:q.address,removed:false,blockHash:hash(number),transactionHash:hash(number+1),blockNumber:toHex(number),logIndex:"0x1",
        topics:encodeEventTopics({abi:o1Legacy,eventName:name,args:{recipient:wallet,currency}}),
        data:encodeAbiParameters([{type:"uint256"}],[3n]),
      }));
    },
  };return rpc;
}
async function finish(rpc,input) {
  const balances=[],history=[],results=[];
  for(let page=0;page<40;page++){
    const result=await scan(input,{secret,createRpc:()=>rpc});results.push(result);
    if(result.resetBalances)balances.length=0;
    balances.push(...result.balances);history.push(...result.history);
    if(!result.cursor||result.updatesComplete)return {result,results,balances,history};
    input={address:wallet,source:input.source,scope:input.scope,cursor:result.cursor};
  }assert.fail("fixture did not settle");
}
test("completed checkpoint survives cursor expiry, refreshes known assets and scans only new blocks",async()=>{
  const rpc=fixture();
  const old=await finish(rpc,{address:wallet,source:"o1",scope:"balances"});
  const cursor=old.results[0].cursor, realNow=Date.now;
  Date.now=()=>realNow()+3*86400000;
  try{
    await assert.rejects(open(cursor,wallet,"o1",secret),e=>e.code==="cursor_expired");
    rpc.height=height+100;rpc.queries=[];rpc.calls=[];
    const next=await finish(rpc,{address:wallet,source:"o1",scope:"balances",checkpoint:old.result.checkpoint});
    assert.equal(next.result.updatesComplete,true);
    assert.equal(next.result.coverage.complete,true);
    assert.equal(next.results[0].resetBalances,true);
    assert.ok(rpc.queries.length>0);
    assert.ok(rpc.queries.every(q=>Number(BigInt(q.fromBlock))===height+1&&Number(BigInt(q.toBlock))===height+100));
    assert.ok(next.balances.some(row=>row.currency===asset&&row.raw==="9"));
    assert.ok(next.balances.some(row=>row.currency===freshAsset&&row.raw==="9"));
    assert.ok(next.balances.filter(row=>row.currency===NATIVE).every(row=>row.raw==="0"));
    assert.equal(next.history.length,0);
  }finally{Date.now=realNow;}
});
test("partial checkpoints keep unsearched older ranges while a return pass reads only new blocks",async()=>{
  const rpc=fixture();
  const first=await scan({address:wallet,source:"o1",scope:"balances"},{secret,createRpc:()=>rpc});
  rpc.height+=20;rpc.queries=[];
  const next=await finish(rpc,{address:wallet,source:"o1",scope:"balances",checkpoint:first.checkpoint});
  assert.equal(next.result.updatesComplete,true);
  assert.equal(next.result.coverage.complete,false);
  assert.ok(rpc.queries.every(q=>Number(BigInt(q.fromBlock))===height+1));
  rpc.queries=[];
  const resumed=await finish(rpc,{address:wallet,source:"o1",scope:"balances",cursor:next.result.cursor});
  assert.equal(resumed.result.coverage.complete,true);
  assert.ok(rpc.queries.some(q=>Number(BigInt(q.fromBlock))===O1[0].start));
});
test("automatic refresh drains both new blocks and unfinished historical ranges to 100%",async()=>{
  for (const source of ["o1", "long", "pons"]) {
    const rpc=fixture();
    let result=await scan({address:wallet,source,scope:"balances"},{secret,createRpc:()=>rpc});
    let input={address:wallet,source,scope:"balances",checkpoint:result.checkpoint};
    const results=[];
    rpc.height+=20;rpc.queries=[];
    await runScanQueue({sources:[source],signal:new AbortController().signal,interval:0,
      isComplete:()=>result.coverage.complete,
      step:async()=>{
        result=await scan(input,{secret,createRpc:()=>rpc});
        results.push(result);
        input={address:wallet,source,scope:"balances",cursor:result.cursor};
      },
      onError:(_,error)=>{throw error;},
    });
    assert.ok(results.some(page=>page.updatesComplete&&!page.coverage.complete));
    assert.equal(result.coverage.complete,true);
    assert.equal(result.coverage.percent,100);
    assert.ok(rpc.queries.some(query=>Number(BigInt(query.fromBlock))===height+1));
    assert.ok(rpc.queries.some(query=>Number(BigInt(query.fromBlock))<height));
  }
});
test("history checkpoints append new payouts without rereading covered history or current balances",async()=>{
  const rpc=fixture(),old=await finish(rpc,{address:wallet,source:"o1",scope:"history"});
  assert.equal(old.history.length,1);
  rpc.height+=20;rpc.queries=[];rpc.calls=[];
  const next=await finish(rpc,{address:wallet,source:"o1",scope:"history",checkpoint:old.result.checkpoint});
  assert.equal(next.history.length,1);
  assert.equal(next.history[0].currency,freshAsset);
  assert.equal(rpc.calls.length,0);
  assert.ok(rpc.queries.every(q=>Number(BigInt(q.fromBlock))===height+1));
});
test("tampered, cross-wallet, cross-source, cross-scope and reorged checkpoints fail closed",async()=>{
  const rpc=fixture(),{result}=await finish(rpc,{address:wallet,source:"o1",scope:"balances"});
  for(const input of [
    {address:asset,source:"o1",scope:"balances",checkpoint:result.checkpoint},
    {address:wallet,source:"pons",scope:"balances",checkpoint:result.checkpoint},
    {address:wallet,source:"o1",scope:"history",checkpoint:result.checkpoint},
    {address:wallet,source:"o1",scope:"balances",checkpoint:result.checkpoint.replace(/^./,result.checkpoint[0]==="A"?"B":"A")},
  ])await assert.rejects(scan(input,{secret,createRpc:()=>rpc}),e=>e.code==="cursor_expired");
  const send=rpc.send.bind(rpc);rpc.send=(method,params)=>method==="eth_getBlockByNumber"?{hash:hash(1)}:send(method,params);
  await assert.rejects(scan({address:wallet,source:"o1",scope:"balances",checkpoint:result.checkpoint},{secret,createRpc:()=>rpc}),e=>e.code==="snapshot_changed");
});
test("durable progress never extends claim permissions and legacy expired scan cursors can migrate",async()=>{
  const rpc=fixture(),first=await scan({address:wallet,source:"o1",scope:"balances"},{secret,createRpc:()=>rpc});
  const claim=await seal({version:1,address:wallet,source:"claim",row:{}},secret),realNow=Date.now;
  Date.now=()=>realNow()+2*86400000;
  try{
    await assert.rejects(openProgress(claim,wallet,"o1",secret),e=>e.code==="cursor_expired");
    await assert.rejects(open(claim,wallet,"claim",secret),e=>e.code==="cursor_expired");
    await assert.rejects(open(first.checkpoint,wallet,"o1",secret),e=>e.code==="cursor_expired");
    rpc.height+=10;
    const next=await scan({address:wallet,source:"o1",scope:"balances",checkpoint:first.cursor},{secret,createRpc:()=>rpc});
    assert.equal(next.snapshot.number,height+10);
    assert.equal(next.resetBalances,true);
  }finally{Date.now=realNow;}
});
test("older completed snapshots migrate without rescanning and refresh their cached token hints",async()=>{
  const rpc=fixture(),snapshotCursor=await seal({version:1,address:wallet,source:"snapshot",snapshot:await rpc.snapshot()},secret);
  rpc.height+=40;rpc.queries=[];
  const next=await finish(rpc,{address:wallet,source:"o1",scope:"balances",checkpoint:snapshotCursor,
    positions:[{target:O1[0].id,currency:asset}]});
  assert.ok(next.balances.some(row=>row.currency===asset&&row.raw==="9"));
  assert.ok(rpc.queries.every(q=>Number(BigInt(q.fromBlock))===height+1));
  rpc.height+=20;rpc.queries=[];
  await finish(rpc,{address:wallet,source:"o1",scope:"balances",checkpoint:next.result.checkpoint});
  assert.ok(rpc.queries.every(q=>Number(BigInt(q.fromBlock))===height+41));
});
test("known Long, pons escrow, v1 and unswept positions refresh without rediscovering old logs",async()=>{
  const key={currency0:NATIVE,currency1:asset,fee:3000,tickSpacing:60,hooks:LONG.address},id=poolId(key);
  for(const [source,position] of [
    ["long",{target:LONG.id,pool:id,token:asset}],
    ["pons",{target:PONS.id,currency:asset}],
    ["pons",{target:PONS_V1.id,token:asset}],
    ["pons",{target:PONS_FACTORY.id,token:asset}],
  ]) {
    const rpc=fixture(),first=await scan({address:wallet,source,scope:"balances"},{secret,createRpc:()=>rpc});
    const state=await openProgress(first.checkpoint,wallet,source,secret);
    for(const stream of state.streams)stream.next=stream.start-1;
    state.positions=[position];state.v1Index=[];
    const checkpoint=await sealProgress(state,secret),call=rpc.call.bind(rpc);
    rpc.call=async(target,abi,name,args,block)=>{
      if(name==="getState")return[NATIVE,0n,LONG_HOOK.address,"0x",2,key,0];
      if(name==="getShares")return 10n**18n;
      if(name==="getCumulatedFees0"||name==="getCumulatedFees1")return 100n;
      if(name==="getLastCumulatedFees0"||name==="getLastCumulatedFees1")return 0n;
      if(name==="collectFees")return[10n,20n];
      if(name==="feeRedirects")return NATIVE;
      if(name==="deployer")return wallet;
      if(name==="tokenProtocolFeeShares")return 10n;
      if(name==="pairedToken")return NATIVE;
      if(name==="getLaunchedToken")return{exists:true,token:args[0],creatorFeeRecipient:wallet,curve:asset,pairToken:NATIVE};
      if(name==="graduated")return false;
      if(name==="quoteFeeBalance")return 20n;
      if(name==="creatorTaxBalance"||name==="buybackQuoteBalance"||name==="protocolFeeShareBps")return 0n;
      return call(target,abi,name,args,block);
    };
    rpc.height+=30;rpc.queries=[];
    const next=await finish(rpc,{address:wallet,source,scope:"balances",checkpoint});
    assert.ok(next.balances.some(row=>row.target===position.target||position.target===PONS_FACTORY.id&&row.kind==="unswept"));
    assert.ok(rpc.queries.every(q=>Number(BigInt(q.fromBlock))===height+1));
    assert.equal(next.result.updatesComplete,true);
  }
});
test("repeated returns compact completed ranges instead of growing the checkpoint each visit",async()=>{
  const rpc=fixture();let {result}=await finish(rpc,{address:wallet,source:"o1",scope:"balances"});
  for(let visit=0;visit<15;visit++){
    const previous=rpc.height;rpc.height+=10;rpc.queries=[];
    ({result}=await finish(rpc,{address:wallet,source:"o1",scope:"balances",checkpoint:result.checkpoint}));
    assert.ok(rpc.queries.every(q=>Number(BigInt(q.fromBlock))===previous+1));
    const state=await openProgress(result.checkpoint,wallet,"o1",secret);
    assert.equal(state.streams.length,O1.length);
    assert.equal(result.coverage.blocksChecked,result.coverage.blocksTotal);
  }
});
test("new-block updates preserve previously queued historical payouts for explicit continuation",async()=>{
  const rpc=fixture(),first=await scan({address:wallet,source:"o1",scope:"history"},{secret,createRpc:()=>rpc});
  const state=await openProgress(first.checkpoint,wallet,"o1",secret);
  for(const stream of state.streams)stream.next=stream.start-1;
  state.pending=Array.from({length:5},(_,i)=>({target:O1[0].id,event:"Claimed",args:{recipient:wallet,currency:asset,amount:"1"},
    block:height-10-i,tx:hash(height-20-i),index:i,hash:hash(height-10-i)}));
  rpc.height+=20;
  const next=await finish(rpc,{address:wallet,source:"o1",scope:"history",checkpoint:await sealProgress(state,secret)});
  assert.equal(next.history.length,1);
  assert.equal(next.result.coverage.pending,5);
  assert.equal(next.result.coverage.complete,false);
  rpc.queries=[];
  const continued=await finish(rpc,{address:wallet,source:"o1",scope:"history",cursor:next.result.cursor});
  assert.equal(continued.history.length,5);
  assert.equal(continued.result.coverage.complete,true);
  assert.equal(rpc.queries.length,0);
});

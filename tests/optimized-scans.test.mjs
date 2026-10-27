import test from "node:test";
import assert from "node:assert/strict";
import { parseAbi, decodeFunctionData, encodeFunctionData, encodeFunctionResult, toHex } from "viem";
import { scan } from "../lib/fees/engine.mjs";
import { Rpc } from "../lib/fees/rpc.mjs";
import { O1, LONG, LONG_HOOK, PONS, PONS_V1, PONS_FACTORY, BAGS, BAGS_FACTORY_IMPL, BAGS_FEE_IMPL, BAGS_BEACON, BAGS_HOOK, MULTICALL, WETH } from "../lib/fees/catalog.mjs";
import { o1Current, o1Legacy, bagsFeeAbi, longAbi, ponsEscrow } from "../lib/fees/abi.mjs";
import { NATIVE, ReadError, poolId, mergeRows, uniqueFeeRows } from "../lib/fees/model.mjs";
import { openProgress } from "../lib/fees/cursor.mjs";
import { prepareClaim } from "../lib/fees/claims.mjs";
import { claimPlan } from "../lib/fees/claim-plan.mjs";
import { runScanQueue } from "../lib/wallet/scan-queue.mjs";
import { ScanCache } from "../lib/wallet/scan-cache.mjs";

const owner=`0x${"11".repeat(20)}`,other=`0x${"22".repeat(20)}`,secret="optimized-fixture-"+"7".repeat(40);
const address=(index)=>toHex(index,{size:20}),hash=(height)=>toHex(height,{size:32});
const aggregateAbi=parseAbi(["struct Call3 {address target;bool allowFailure;bytes callData;}",
  "struct Result {bool success;bytes returnData;}","function aggregate3(Call3[] calls) payable returns (Result[] returnData)"]);
const indexBody=(currencies)=>({data:currencies.map(currency=>({chain_id:4663,recipient:owner,
  fee_escrow_address:O1[0].address,currency:{address:currency},claimable_raw:"999999999",reconciliation:"confirmed"})),
  pagination:{has_more:false,next_cursor:null}});
const json=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json",...headers}});

// Use the real RPC encoder/transport/Multicall decoder. Pin and metadata fixtures
// isolate balance request counts; those independent safeguards have their own tests.
function o1Transport(currencies=[]) {
  const state={height:100_000_000,raw:10n,requests:[],batches:[],limitRefresh:false,currencies};
  const transport=async(_url,settings)=>{
    const request=JSON.parse(settings.body);state.requests.push(request.method);
    let result;
    if(request.method==="eth_chainId")result=toHex(4663);
    else if(request.method==="eth_blockNumber")result=toHex(state.height+20);
    else if(request.method==="eth_getBlockByNumber")result={hash:hash(Number(BigInt(request.params[0]))),timestamp:"0x1"};
    else if(request.method==="eth_estimateGas")result="0x186a0";
    else if(request.method==="eth_call"){
      const tx=request.params[0];
      if(tx.to.toLowerCase()===MULTICALL.address){
        const decoded=decodeFunctionData({abi:aggregateAbi,data:tx.data});
        const entries=decoded.args[0].map(entry=>({entry,decoded:decodeFunctionData({abi:o1Current,data:entry.callData})}));
        state.batches.push(entries.map(entry=>entry.decoded.args[1]));
        if(state.limitRefresh&&entries.some(entry=>entry.decoded.args[1]!==NATIVE)){
          state.limitRefresh=false;return json({error:"withheld"},429,{"retry-after":"73"});
        }
        result=encodeFunctionResult({abi:aggregateAbi,functionName:"aggregate3",result:entries.map(({decoded})=>{
          assert.equal(decoded.functionName,"owed");assert.equal(decoded.args[0].toLowerCase(),owner);
          return{success:true,returnData:encodeFunctionResult({abi:o1Current,functionName:"owed",result:state.raw})};
        })});
      }else{
        const decoded=decodeFunctionData({abi:[...o1Current,...o1Legacy],data:tx.data});
        result=decoded.functionName==="owed"?encodeFunctionResult({abi:o1Current,functionName:"owed",result:state.raw}):"0x";
        if(decoded.functionName!=="owed")assert.equal(tx.from,owner);
      }
    }else assert.fail(`unexpected read method ${request.method}`);
    return json({jsonrpc:"2.0",id:request.id,result});
  };
  const rpc=new Rpc("https://rpc.example.invalid",transport);
  rpc.verify=async()=>{};
  rpc.prefetchCurrencies=async()=>{};
  rpc.currency=async currency=>({currency,symbol:currency===NATIVE?"ETH":"TEST",decimals:18,metadataVerified:true});
  return {state,rpc,options:{secret,o1Key:"fixture-key",createRpc:()=>rpc,indexFetcher:async()=>json(indexBody(state.currencies))}};
}
test("integrated O1 scan sends one balance RPC for seven escrows and two for a full 50-position index page",async()=>{
  const empty=o1Transport();
  const first=await scan({address:owner,source:"o1",scope:"balances"},empty.options);
  assert.equal(first.coverage.complete,true);assert.equal(empty.state.requests.filter(method=>method==="eth_call").length,1);
  assert.equal(empty.state.batches[0].length,7);
  const full=o1Transport(Array.from({length:50},(_,index)=>address(index+1000)));
  const result=await scan({address:owner,source:"o1",scope:"balances"},full.options);
  assert.equal(result.coverage.complete,true);assert.deepEqual(full.state.batches.map(batch=>batch.length),[7,50]);
  assert.equal(full.state.requests.filter(method=>method==="eth_call").length,2);
  assert.equal(result.balances.filter(row=>row.currency!==NATIVE).length,50);
  assert.ok(result.balances.every(row=>row.raw==="10"));
});
test("O1 saved refresh retries the complete balance batch after provider limits without losing expired-cursor progress",async()=>{
  const fixture=o1Transport([address(1000),address(1001),address(1002)]);
  const first=await scan({address:owner,source:"o1",scope:"balances"},fixture.options);
  const oldState=await openProgress(first.checkpoint,owner,"o1",secret);
  fixture.state.height+=100;fixture.state.raw=3n;fixture.state.currencies=[];fixture.state.limitRefresh=true;
  const input={address:owner,source:"o1",scope:"balances",checkpoint:first.checkpoint};
  await assert.rejects(scan(input,fixture.options),error=>error.code==="rate_limited"&&error.retryAfter===73000);
  assert.deepEqual(await openProgress(first.checkpoint,owner,"o1",secret),oldState);
  const now=Date.now;Date.now=()=>now()+3*86400000;
  try{
    const refreshed=await scan(input,fixture.options);
    assert.equal(refreshed.coverage.complete,true);assert.equal(refreshed.resetBalances,true);
    assert.deepEqual(refreshed.balances.filter(row=>row.currency!==NATIVE).map(row=>row.raw),["3","3","3"]);
    assert.deepEqual(fixture.state.batches.filter(batch=>batch.length===3).at(-1).map(currency=>currency.toLowerCase()),[address(1000),address(1001),address(1002)]);
    assert.ok(!fixture.state.requests.includes("eth_getLogs"));
  }finally{Date.now=now;}
});
test("an optimized scan handle still requires fresh claim reads and never authorizes a different wallet",async()=>{
  const fixture=o1Transport();
  const result=await scan({address:owner,source:"o1",scope:"balances"},fixture.options),row=result.balances[0];
  fixture.state.raw=2n;
  const quote=await prepareClaim({address:owner,claimHandle:row.claimHandle},fixture.options);
  assert.equal(quote.row.raw,"2");assert.equal(quote.target,O1[0].address);assert.equal(quote.value,"0x0");
  assert.equal(decodeFunctionData({abi:o1Legacy,data:quote.data}).functionName,"claim");
  await assert.rejects(prepareClaim({address:other,claimHandle:row.claimHandle},fixture.options));
  fixture.state.raw=0n;
  await assert.rejects(prepareClaim({address:owner,claimHandle:row.claimHandle},fixture.options),error=>error.code==="nothing_to_claim");
  assert.ok(!fixture.state.requests.some(method=>method.startsWith("eth_send")));
});

function combinedFixture(){
  const token=address(4096),bagsToken=address(4097),ponsToken=address(4098),fee=address(8192),curve=address(12288);
  const key={currency0:token,currency1:WETH,fee:3000,tickSpacing:60,hooks:LONG.address},pool=poolId(key);
  const state={height:100_000_000,calls:[],logs:[],advances:new Map(),candidateReads:[]};
  const rpc={
    async snapshot(){return{number:state.height,hash:hash(state.height),timestamp:1};},
    async verify(){},
    async currency(currency){return{currency:currency.toLowerCase(),symbol:currency===NATIVE?"ETH":"TEST",decimals:18,metadataVerified:true};},
    async calls(calls,block){return Promise.all(calls.map(call=>rpc.call(call.address,call.abi,call.functionName,call.args,block)));},
    async call(target,abi,name,args=[],block,from){
      encodeFunctionData({abi,functionName:name,args});state.calls.push({target,name,args,block,from});
      if(name==="owed")return args[1]===NATIVE?0n:11n;
      if(name==="balanceOf")return 7n;
      if(name==="feeRecipientTokenCount"||name==="deployerTokenCount")return 0n;
      if(name==="getLaunchedToken")return{token:ponsToken,curve,deployer:owner,creatorFeeRecipient:owner,pairToken:WETH,poolFee:3000,tickSpacing:60,exists:true};
      if(name==="graduated")return false;
      if(name==="deployer")return owner;
      if(name==="quoteFeeBalance")return 100n;
      if(name==="creatorTaxBalance")return 5n;
      if(name==="protocolFeeShareBps")return 2000;
      if(name==="buybackQuoteBalance")return 10n;
      if(name==="implementation")return BAGS_FEE_IMPL.address;
      if(name==="feeShareBeacon")return BAGS_BEACON.address;
      if(name==="hook")return BAGS_HOOK.address;
      if(name==="feeShareForToken")return fee;
      if(name==="curveForToken"||name==="bondingCurve")return curve;
      if(name==="WETH")return WETH;
      if(name==="poolId")return pool;
      if(name==="claimable")return 10n;
      if(name==="claimerBps")return 10000;
      if(name==="PARTNER")return other;
      if(name==="aggregate3")return[{success:true,returnData:"0x"},{success:true,returnData:encodeFunctionResult({abi:bagsFeeAbi,functionName:"claimable",result:17n})}];
      if(name==="getState")return[WETH,0n,LONG_HOOK.address,"0x",2,key,0];
      if(name==="getPoolKey")return[key.currency0,key.currency1,key.fee,key.tickSpacing,key.hooks];
      if(name==="getShares")return 25n*10n**16n;
      if(name==="getCumulatedFees0")return 1000n;
      if(name==="getCumulatedFees1")return 2000n;
      if(name==="getLastCumulatedFees0")return 900n;
      if(name==="getLastCumulatedFees1")return 1800n;
      if(name==="collectFees"){assert.equal(from,owner);return[100n,200n];}
      assert.fail(`unexpected fixture read ${name}`);
    },
    async send(method,params){
      if(method==="eth_chainId")return toHex(4663);
      if(method==="eth_getBlockByNumber")return{hash:hash(Number(BigInt(params[0])))};
      if(method==="eth_getStorageAt")return`0x${"0".repeat(24)}${BAGS_FACTORY_IMPL.address.slice(2)}`;
      if(method==="eth_getLogs"){state.logs.push(params[0]);return[];}
      assert.fail(`unexpected fixture method ${method}`);
    },
  };
  const discoveryIndex={
    async advance({profile,snapshot}){const count=(state.advances.get(profile.namespace)??0)+1;state.advances.set(profile.namespace,count);
      return{complete:count>1,blocksChecked:count>1?10:5,blocksTotal:10,next:snapshot.number+1,revision:count};},
    async coverage({profile,snapshot}){return{complete:true,blocksChecked:10,blocksTotal:10,next:snapshot.number+1,revision:1};},
    async positions({profile,owner:requested}){assert.equal(requested,owner);state.candidateReads.push(profile.address);
      return{positions:profile.address===LONG.address?[{target:LONG.id,token,pool}]:profile.address===PONS_FACTORY.address?[{target:PONS_FACTORY.id,token:ponsToken}]:[],after:null};},
  };
  const indexFetcher=async(url)=>{
    const host=new URL(url).hostname;
    if(host==="api.launch.o1.exchange")return json(indexBody([address(5000)]));
    if(host==="public-api-v2.bags.fm")return json({success:true,response:{truncated:false,positions:[{version:"v2",token:{address:bagsToken},feeShare:fee}]}});
    if(host==="api.bankr.bot")return json({address:owner,tokens:[{tokenAddress:token,poolId:pool,initializer:LONG.address,source:"doppler",chain:"robinhood"}]});
    assert.fail("unknown synthetic index host");
  };
  return{state,rpc,token,fee,pool,options:{secret,o1Key:"fixture-key",bagsKey:"fixture-key",createRpc:()=>rpc,indexFetcher,discoveryIndex}};
}
test("all five optimized adapters finish together, preserve browser checkpoints and retain original claim targets/math",async()=>{
  const fixture=combinedFixture(),sources=["o1","bags","bankr","long","pons"],states={},values=new Map();
  const host={localStorage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)}};
  const cache=new ScanCache(host);let clock=0,steps=0;
  await runScanQueue({sources,signal:new AbortController().signal,isComplete:source=>!!states[source]?.result.coverage.complete,
    now:()=>clock,wait:async delay=>{clock+=delay;},interval:0,concurrency:sources.length,
    async step(source){
      assert.ok(++steps<40,"combined scan did not converge");
      const prior=states[source],result=await scan({address:owner,source,scope:"balances",...(prior?.result.cursor?{cursor:prior.result.cursor}:{})},fixture.options);
      states[source]={result,balances:mergeRows([...(prior?.balances??[]),...result.balances]),history:[],pages:(prior?.pages??0)+1};
      assert.ok(cache.save(owner,{balances:states,history:{},selected:sources,historyStarted:false}));
    },onError(_source,error){throw error;},
  });
  assert.ok(sources.every(source=>states[source].result.coverage.complete));
  const restored=new ScanCache(host).load(owner);assert.ok(restored);assert.deepEqual(restored.selected,sources);
  for(const source of sources){
    assert.equal(restored.balances[source].result.checkpoint,states[source].result.checkpoint);
    await assert.rejects(openProgress(states[source].result.checkpoint,other,source,secret));
  }
  assert.ok(states.long.pages>1&&states.pons.pages>1);
  assert.ok(!fixture.state.logs.some(filter=>filter.address===LONG.address||filter.address===PONS_FACTORY.address),"global discovery repeated per wallet");
  const bags=states.bags.balances.find(row=>row.kind==="available"),pons=states.pons.balances.find(row=>row.kind==="available");
  assert.equal(bags.raw,"17");assert.equal(claimPlan(bags,owner).target,fixture.fee);
  assert.equal(decodeFunctionData({abi:bagsFeeAbi,data:claimPlan(bags,owner).data}).args[0],false);
  assert.equal(pons.raw,"7");assert.equal(claimPlan(pons,owner).target,PONS.address);
  assert.throws(()=>claimPlan(states.pons.balances.find(row=>row.kind==="unswept"),owner));
  const long=states.long.balances.filter(row=>row.kind==="available"),bankr=states.bankr.balances.filter(row=>row.kind==="available");
  assert.deepEqual(long.map(row=>row.raw),["50","100"]);assert.deepEqual(bankr.map(row=>row.raw),["50","100"]);
  assert.equal(uniqueFeeRows([...long,...bankr]).length,2);
  for(const rows of [long,bankr]){const plan=claimPlan(rows[0],owner,rows);assert.equal(plan.target,LONG.address);assert.equal(plan.value,"0x0");}
});

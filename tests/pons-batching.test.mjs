import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData } from "viem";
import { readPonsInitial,readPonsEscrowBalances,readPonsV1TokenPage,readPonsV1Position,readPonsLaunches,readPonsCurveState } from "../lib/fees/pons-balances.mjs";
import { NATIVE,ReadError } from "../lib/fees/model.mjs";
const owner=`0x${"11".repeat(20)}`,deployer=`0x${"22".repeat(20)}`,token=`0x${"33".repeat(20)}`,
  pair=`0x${"44".repeat(20)}`,curve=`0x${"55".repeat(20)}`,block="0x1234";
function fixture() {
  const state={requests:[],redirect:owner,graduated:false,failPreview:false,share:30n,
    native:10n,recipientCount:2n,deployerCount:1n,recipient:owner};
  const launch={exists:true,token,curve,creatorFeeRecipient:owner,pairToken:pair,poolFee:0,tickSpacing:60};
  const value=(name,args) => {
    if (name==="balanceOf") return state.native;
    if (name==="feeRecipientTokenCount") return state.recipientCount;
    if (name==="deployerTokenCount") return state.deployerCount;
    if (name==="balanceOfToken") return 20n;
    if (["feeRecipientTokens","deployerTokens"].includes(name)) return args[1]===0n ? token : pair;
    if (name==="feeRedirects") return state.redirect;
    if (name==="deployer") return state.recipient===owner && state.readingCurve ? owner : deployer;
    if (name==="pairedToken") return pair;
    if (name==="tokenProtocolFeeShares") return state.share;
    if (name==="getLaunchedToken") return launch;
    if (name==="graduated") return state.graduated;
    if (name==="quoteFeeBalance") return 1000n;
    if (name==="creatorTaxBalance") return 100n;
    if (name==="protocolFeeShareBps") return 3000;
    if (name==="buybackQuoteBalance") return 200n;
    if (name==="launches") { const config=[];config[0]=true;config[2]=token;config[4]=state.recipient;config[8]=3000;return config; }
    if (name==="pendingFees") return 1000n;
    if (name==="pendingCreatorTax") return 100n;
    if (name==="pendingBuyback") return 200n;
    throw Error("Unexpected synthetic read");
  };
  const rpc={
    async calls(calls,snapshot) {
      state.requests.push({kind:"batch",calls,snapshot});
      return calls.map((call) => {encodeFunctionData({abi:call.abi,functionName:call.functionName,args:call.args});return value(call.functionName,call.args);});
    },
    async call(address,abi,name,args=[],snapshot,from) {
      encodeFunctionData({abi,functionName:name,args});state.requests.push({kind:"single",address,name,args,snapshot,from});
      if (name==="collectFees") {if(state.failPreview) throw state.failPreview instanceof Error ? state.failPreview : new ReadError(state.failPreview);return [1000n,2000n];}
      return value(name,args);
    },
  };
  return {state,launch,rpc};
}
test("Pons initial balance and recipient/deployer counts use one authenticated getter batch",async()=>{
  const {rpc,state}=fixture();const result=await readPonsInitial(rpc,owner,block);
  assert.deepEqual(result,{native:10n,recipientCount:2n,deployerCount:1n});
  assert.equal(state.requests.length,1);assert.equal(state.requests[0].calls.length,3);
  assert.ok(state.requests[0].calls.every((call)=>call.args[0]===owner));assert.equal(state.requests[0].snapshot,block);
});
test("Pons escrow refresh and v1 token enumeration batch without losing wallet identity or array order",async()=>{
  const {rpc,state}=fixture();
  assert.deepEqual(await readPonsEscrowBalances(rpc,owner,[NATIVE,pair,pair],block),[{currency:NATIVE,raw:10n},{currency:pair,raw:20n}]);
  assert.deepEqual(await readPonsV1TokenPage(rpc,owner,[{name:"feeRecipientTokens",index:1},{name:"deployerTokens",index:0}],block),[pair,token]);
  assert.equal(state.requests.length,2);assert.equal(state.requests[0].calls.length,2);
  await assert.rejects(readPonsV1TokenPage(rpc,owner,[{name:"collectFees",index:0}],block),{code:"invalid_request"});
});
test("Pons v1 batches pure getters but preserves deployer-from simulation and protocol deductions",async()=>{
  const {rpc,state}=fixture();const result=await readPonsV1Position(rpc,owner,token,block);
  assert.equal(result.eligible,true);assert.equal(state.requests.length,3);
  const simulation=state.requests.find((request)=>request.name==="collectFees");
  assert.equal(simulation.from,deployer);assert.equal(simulation.snapshot,block);
  assert.deepEqual(result.payouts,[{currency:token,raw:700n},{currency:pair,raw:1400n}]);
});
test("Pons v1 rejects unrelated recipients before simulating and treats no-fees preview separately from provider failure",async()=>{
  const {rpc,state}=fixture();state.redirect=pair;
  assert.deepEqual(await readPonsV1Position(rpc,owner,token,block),{eligible:false});assert.equal(state.requests.length,1);
  state.redirect=owner;state.failPreview="nothing_to_collect";
  assert.deepEqual((await readPonsV1Position(rpc,owner,token,block)).payouts.map((row)=>row.raw),[0n,0n]);
  state.failPreview="provider_unavailable";
  await assert.rejects(readPonsV1Position(rpc,owner,token,block),{code:"provider_unavailable"});
});
test("Pons v1 preserves quota errors and Retry-After without returning a validated balance",async()=>{
  const {rpc,state}=fixture(),quota=new ReadError("rate_limited");quota.retryAfter=3_600_000;
  state.failPreview=quota;
  await assert.rejects(readPonsV1Position(rpc,owner,token,block),(error)=>error===quota && error.retryAfter===3_600_000);
  assert.equal(state.requests.length,2);assert.equal(state.requests[1].name,"collectFees");
  assert.equal(state.requests[1].from,deployer);
  for (const code of ["index_unavailable","read_failed","contract_changed"]) {
    const error=new ReadError(code);state.failPreview=error;
    await assert.rejects(readPonsV1Position(rpc,owner,token,block),(caught)=>caught===error);
  }
  state.failPreview=new Error("private-provider-diagnostic");
  await assert.rejects(readPonsV1Position(rpc,owner,token,block),(error)=>error instanceof ReadError &&
    error.code==="read_failed" && !error.message.includes("private-provider-diagnostic"));
});
test("Pons curve getter batch preserves buyback and tax accounting with two RPC getter calls",async()=>{
  const {rpc,state,launch}=fixture();state.readingCurve=true;
  const result=await readPonsCurveState(rpc,owner,token,launch,block);
  assert.equal(state.requests.length,2);assert.equal(result.payouts.length,1);
  assert.deepEqual(result.payouts[0],{currency:pair,raw:600n,kind:"unswept",token,position:curve,earmarkedRaw:"200"});
  assert.deepEqual(result.warnings,["buyback_earmark"]);
});
test("Pons graduated hook reads both assets in one getter batch and never creates an available claim",async()=>{
  const {rpc,state,launch}=fixture();state.graduated=true;
  const result=await readPonsCurveState(rpc,owner,token,launch,block);
  assert.equal(state.requests.length,3);assert.equal(state.requests[2].calls.length,6);
  assert.deepEqual(result.payouts.map((row)=>[row.kind,row.raw]),[["conversion-needed",600n],["unswept",600n]]);
  state.recipient=pair;
  await assert.rejects(readPonsCurveState(rpc,owner,token,launch,block),{code:"contract_changed"});
});
test("Pons launch batching and arithmetic reject malformed identities and impossible fee shares",async()=>{
  const {rpc,state,launch}=fixture();
  assert.equal((await readPonsLaunches(rpc,[token],block))[0],launch);
  launch.token=pair;await assert.rejects(readPonsLaunches(rpc,[token],block),{code:"invalid_response"});
  state.share=101n;await assert.rejects(readPonsV1Position(rpc,owner,token,block),{code:"invalid_response"});
  state.native=-1n;await assert.rejects(readPonsInitial(rpc,owner,block),{code:"invalid_response"});
});

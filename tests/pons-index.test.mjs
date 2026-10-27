import test from "node:test";
import assert from "node:assert/strict";
import { encodeEventTopics,encodeAbiParameters } from "viem";
import { ponsDiscoveryProfile } from "../lib/fees/pons-discovery.mjs";
import { ponsFactoryAbi } from "../lib/fees/abi.mjs";
import { PONS_FACTORY } from "../lib/fees/catalog.mjs";
import { NATIVE,ReadError } from "../lib/fees/model.mjs";
const owner=`0x${"11".repeat(20)}`,next=`0x${"22".repeat(20)}`,token=`0x${"33".repeat(20)}`,curve=`0x${"44".repeat(20)}`;
function launched(launchToken=token,blockNumber="0x1234") {
  return {blockNumber,topics:encodeEventTopics({abi:ponsFactoryAbi,eventName:"TokenLaunched",args:{token:launchToken,curve,deployer:next}}),
    data:encodeAbiParameters([{type:"address"},{type:"uint256"},{type:"uint256"}],[NATIVE,0n,10n])};
}
const updated=(previousRecipient,newRecipient)=>({blockNumber:"0x2345",data:"0x",topics:encodeEventTopics({abi:ponsFactoryAbi,
  eventName:"CreatorFeeRecipientUpdated",args:{token,previousRecipient,newRecipient}})});
test("Pons public index discovers the event-block recipient instead of assuming deployer or latest recipient",async()=>{
  const calls=[];const rpc={async call(address,abi,name,args,block){calls.push({address,name,args,block});
    return {exists:true,token,curve,creatorFeeRecipient:block==="0x1234"?owner:next};}};
  assert.deepEqual(await ponsDiscoveryProfile.decode(launched(),{rpc}),[{owner,target:PONS_FACTORY.id,token}]);
  assert.deepEqual(calls,[{address:PONS_FACTORY.address,name:"getLaunchedToken",args:[token],block:"0x1234"}]);
});
test("Pons public index retains both sides of recipient changes without an RPC lookup",async()=>{
  const rpc={async call(){throw Error("Unexpected read");}};
  assert.deepEqual(await ponsDiscoveryProfile.decode(updated(owner,next),{rpc}),[
    {owner,target:PONS_FACTORY.id,token},{owner:next,target:PONS_FACTORY.id,token},
  ]);
  assert.deepEqual(await ponsDiscoveryProfile.decode(updated(owner,owner),{rpc}),[{owner,target:PONS_FACTORY.id,token}]);
  assert.deepEqual(await ponsDiscoveryProfile.decode(updated(NATIVE,next),{rpc}),[{owner:next,target:PONS_FACTORY.id,token}]);
});
test("Pons index never marks unavailable archival state or a mismatched launch identity as valid discovery",async()=>{
  const unavailable={async call(){throw new ReadError("provider_unavailable");}};
  await assert.rejects(ponsDiscoveryProfile.decode(launched(),{rpc:unavailable}),{code:"provider_unavailable"});
  const mismatch={async call(){return {exists:true,token:next,curve,creatorFeeRecipient:owner};}};
  await assert.rejects(ponsDiscoveryProfile.decode(launched(),{rpc:mismatch}),{code:"invalid_response"});
});
test("Pons index batches sixteen same-block launch records into one historical Multicall",async()=>{
  const tokens=Array.from({length:16},(_,index)=>`0x${(1000+index).toString(16).padStart(40,"0")}`),calls=[];
  const rpc={async calls(reads,block){calls.push({reads,block});return reads.map((read)=>({exists:true,
    token:read.args[0],curve,creatorFeeRecipient:owner}));}};
  const result=await ponsDiscoveryProfile.decodeMany(tokens.map((token)=>launched(token)),{rpc});
  assert.equal(calls.length,1);assert.equal(calls[0].block,"0x1234");assert.equal(calls[0].reads.length,16);
  assert.deepEqual(result,tokens.map((token)=>[{owner,target:PONS_FACTORY.id,token}]));
});
test("Pons bulk index keeps each launch at its event block and recipient changes at the original event slot",async()=>{
  const calls=[];const rpc={async calls(reads,block){calls.push({reads,block});return reads.map((read)=>({exists:true,
    token:read.args[0],curve,creatorFeeRecipient:block==="0x1234"?owner:next}));}};
  const result=await ponsDiscoveryProfile.decodeMany([launched(),updated(owner,next),launched(token,"0x2345"),launched(token,"0x001234")],{rpc});
  assert.equal(calls.length,2);assert.deepEqual(calls.map((call)=>[call.block,call.reads.length]),[["0x1234",2],["0x2345",1]]);
  assert.deepEqual(result,[
    [{owner,target:PONS_FACTORY.id,token}],
    [{owner,target:PONS_FACTORY.id,token},{owner:next,target:PONS_FACTORY.id,token}],
    [{owner:next,target:PONS_FACTORY.id,token}],
    [{owner,target:PONS_FACTORY.id,token}],
  ]);
});
test("Pons bulk index preserves archive failure and rejects incomplete or mismatched batches",async()=>{
  await assert.rejects(ponsDiscoveryProfile.decodeMany([launched()],{rpc:{async calls(){throw new ReadError("provider_unavailable");}}}),{code:"provider_unavailable"});
  await assert.rejects(ponsDiscoveryProfile.decodeMany([launched()],{rpc:{async calls(){return [];}}}),{code:"invalid_response"});
  await assert.rejects(ponsDiscoveryProfile.decodeMany([launched()],{rpc:{async calls(){return [{exists:true,token:next,curve,creatorFeeRecipient:owner}];}}}),{code:"invalid_response"});
});

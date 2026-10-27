import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters,encodeEventTopics,toHex } from "viem";
import { longDiscoveryProfile } from "../lib/fees/long-discovery.mjs";
import { LONG } from "../lib/fees/catalog.mjs";
import { longAbi } from "../lib/fees/abi.mjs";
const first=toHex(1,{size:20}),second=toHex(2,{size:20}),asset=toHex(3,{size:20}),pool=toHex(4,{size:32});
function event(name,args){const abi=longAbi.find((entry)=>entry.type==="event"&&entry.name===name);return {topics:encodeEventTopics({abi:longAbi,eventName:name,args}),data:encodeAbiParameters(abi.inputs.filter((input)=>!input.indexed),abi.inputs.filter((input)=>!input.indexed).map((input)=>args[input.name]))};}
test("Long discovery retains every positive-share Lock beneficiary as a hint",()=>{
  const log=event("Lock",{pool:asset,beneficiaries:[{beneficiary:first,shares:1n},{beneficiary:second,shares:2n}]});
  assert.deepEqual(longDiscoveryProfile.decode(log),[{owner:first,target:LONG.id,token:asset},{owner:second,target:LONG.id,token:asset}]);
});
test("Long discovery includes transferred-in and former beneficiaries without assuming current rights",()=>{
  const log=event("UpdateBeneficiary",{poolId:pool,oldBeneficiary:first,newBeneficiary:second});
  assert.deepEqual(longDiscoveryProfile.decode(log),[{owner:first,target:LONG.id,pool},{owner:second,target:LONG.id,pool}]);
  assert.ok(longDiscoveryProfile.namespace.includes(LONG.hash));
});
test("malformed Long event data cannot become a discovery hint",()=>{
  assert.throws(()=>longDiscoveryProfile.decode({topics:longDiscoveryProfile.topics[0],data:"0x"}),(error)=>error.code==="invalid_response");
});

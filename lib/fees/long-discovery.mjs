import { decodeEventLog, toEventSelector } from "viem";
import { LONG } from "./catalog.mjs";
import { longAbi } from "./abi.mjs";
import { ReadError, NATIVE, same } from "./model.mjs";

// Historical membership is a discovery hint, never evidence of current shares.
// Keeping both sides of a transfer also preserves removed beneficiaries whose
// accrued ledger or previously saved position still needs onchain verification.
export const longDiscoveryProfile = {
  namespace:`4663:${LONG.id}:${LONG.address.toLowerCase()}:${LONG.hash}:beneficiaries-v1`,
  start:LONG.start,address:LONG.address,
  topics:[["Lock","UpdateBeneficiary"].map((name)=>toEventSelector(longAbi.find((entry)=>entry.type==="event"&&entry.name===name)))],
  decode(log) {
    let event;
    try { event=decodeEventLog({abi:longAbi,topics:log.topics,data:log.data,strict:true}); }
    catch { throw new ReadError("invalid_response"); }
    if (event.eventName==="Lock") return event.args.beneficiaries
      .filter((entry)=>entry.shares>0n && !same(entry.beneficiary,NATIVE))
      .map((entry)=>({owner:entry.beneficiary,target:LONG.id,token:event.args.pool}));
    if (event.eventName==="UpdateBeneficiary") return [...new Set([event.args.oldBeneficiary,event.args.newBeneficiary]
      .map((address)=>address.toLowerCase()).filter((address)=>!same(address,NATIVE)))]
      .map((owner)=>({owner,target:LONG.id,pool:event.args.poolId}));
    throw new ReadError("invalid_response");
  },
};

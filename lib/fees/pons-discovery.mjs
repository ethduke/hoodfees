import { decodeEventLog, toEventSelector, toHex } from "viem";
import { PONS_FACTORY } from "./catalog.mjs";
import { ponsFactoryAbi } from "./abi.mjs";
import { ReadError, NATIVE, same } from "./model.mjs";

const address = (value) => typeof value === "string" && /^0x[\da-f]{40}$/i.test(value);
const member = (owner, token) => ({ owner:owner.toLowerCase(), target:PONS_FACTORY.id, token:token.toLowerCase() });
function eventFor(log) {
  let event;
  try { event=decodeEventLog({abi:ponsFactoryAbi, topics:log.topics, data:log.data, strict:true}); }
  catch { throw new ReadError("invalid_response"); }
  if (!address(event.args.token) || same(event.args.token,NATIVE) ||
    !["TokenLaunched","CreatorFeeRecipientUpdated"].includes(event.eventName)) throw new ReadError("invalid_response");
  return event;
}
const changedMembers = (event) => [...new Set([event.args.previousRecipient,event.args.newRecipient]
  .map((owner) => owner.toLowerCase()).filter((owner) => !same(owner,NATIVE)))]
  .map((owner) => member(owner,event.args.token));
function launchMembers(event,launch) {
  if (!launch?.exists || !same(launch.token,event.args.token) || !same(launch.curve,event.args.curve) ||
    !address(launch.creatorFeeRecipient) || same(launch.creatorFeeRecipient,NATIVE)) throw new ReadError("invalid_response");
  return [member(launch.creatorFeeRecipient,event.args.token)];
}
function eventBlock(log) {
  if (!/^0x[\da-f]+$/i.test(log?.blockNumber)) throw new ReadError("invalid_response");
  return toHex(BigInt(log.blockNumber));
}

// Public historic recipient membership only. The current factory record and
// curve/hook state must still authenticate every candidate before showing fees.
export const ponsDiscoveryProfile = {
  namespace:`4663:${PONS_FACTORY.id}:${PONS_FACTORY.address.toLowerCase()}:${PONS_FACTORY.hash}:recipients-v1`,
  start:PONS_FACTORY.start, address:PONS_FACTORY.address,
  topics:[["TokenLaunched", "CreatorFeeRecipientUpdated"].map((name) => toEventSelector(
    ponsFactoryAbi.find((entry) => entry.type === "event" && entry.name === name),
  ))],
  async decode(log, {rpc}) {
    const event=eventFor(log);
    if (event.eventName === "CreatorFeeRecipientUpdated") return changedMembers(event);
    // TokenLaunched omits the fee recipient. Read the record at its event block:
    // using latest would erase recipients after later ownership changes. If a
    // provider cannot serve historical state, leave coverage incomplete.
    const launch=await rpc.call(PONS_FACTORY.address,ponsFactoryAbi,"getLaunchedToken",[event.args.token],eventBlock(log));
    return launchMembers(event,launch);
  },
  async decodeMany(logs,{rpc}) {
    if (!Array.isArray(logs)) throw new ReadError("invalid_response");
    const result=new Array(logs.length), groups=new Map();
    logs.forEach((log,index) => {
      const event=eventFor(log);
      if (event.eventName === "CreatorFeeRecipientUpdated") { result[index]=changedMembers(event);return; }
      const block=eventBlock(log), group=groups.get(block) ?? [];
      group.push({event,index});groups.set(block,group);
    });
    // A Multicall has one snapshot: never merge records from distinct event
    // blocks. Independent groups may overlap through the transport's connection
    // queue; recipient-only events need no RPC request at all.
    await Promise.all([...groups].map(async ([block,group]) => {
      const calls=group.map(({event}) => ({address:PONS_FACTORY.address,abi:ponsFactoryAbi,
        functionName:"getLaunchedToken",args:[event.args.token]}));
      const launches=typeof rpc.calls === "function" ? await rpc.calls(calls,block)
        : await Promise.all(calls.map((call) => rpc.call(call.address,call.abi,call.functionName,call.args,block)));
      if (!Array.isArray(launches) || launches.length!==group.length) throw new ReadError("invalid_response");
      group.forEach(({event,index},at) => {result[index]=launchMembers(event,launches[at]);});
    }));
    return result;
  },
};

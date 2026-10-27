import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, toHex } from "viem";
import { scan } from "../lib/fees/engine.mjs";
import { seal } from "../lib/fees/cursor.mjs";
import { O1, LONG, PONS_V1, PONS_FACTORY } from "../lib/fees/catalog.mjs";
import { o1Legacy, longAbi, ponsFactoryAbi, ponsV1Abi } from "../lib/fees/abi.mjs";
import { Rpc } from "../lib/fees/rpc.mjs";
import { NATIVE, ReadError } from "../lib/fees/model.mjs";

const wallet = `0x${"11".repeat(20)}`, other = `0x${"22".repeat(20)}`;
const hash = `0x${"33".repeat(32)}`, secret = "discovery-fixture-" + "x".repeat(40);
function rpcFor(logs) {
  const queries = [];
  return {
    queries,
    async snapshot() { return {number: 88000000, hash}; },
    async verify() {},
    async currency(currency) { return {currency, symbol:"TEST", decimals:18, metadataVerified:true}; },
    async call(target, abi, name) {
      if (["owed", "balanceOf", "feeRecipientTokenCount", "deployerTokenCount"].includes(name)) return 0n;
      throw new ReadError("read_failed");
    },
    async send(method, params) {
      if (method === "eth_chainId") return toHex(4663);
      if (method === "eth_getBlockByNumber") return {hash};
      if (method === "eth_getLogs") { queries.push(params[0]); return logs(params[0]); }
      throw new ReadError("invalid_request");
    },
  };
}
async function allPages(source, rpc, cursor, scope) {
  const history = [], results = [];
  for (let page = 0; page < 100; page++) {
    const result = await scan({address:wallet, source, scope, ...(cursor ? {cursor} : {})}, {secret, createRpc:()=>rpc});
    results.push(result); history.push(...result.history);
    if (!result.cursor) return {results, history};
    cursor = result.cursor;
  }
  assert.fail("scan did not terminate within its fixture budget");
}
async function oneStreamCursor(next, extra = {}) {
  return seal({version:1, address:wallet, source:"o1", snapshot:{number:next,hash}, initialized:true,
    pending:[], seen:[`${O1[0].id}:${other}`], warnings:[], turn:0,
    streams:[{target:O1[0].id, start:O1[0].start, next, range:next-O1[0].start+1, sizing:2, ...extra}]}, secret);
}
function claimLog(filter, height) {
  return {address:filter.address, removed:false, blockHash:toHex(height,{size:32}),
    transactionHash:toHex(height,{size:32}), blockNumber:toHex(height), logIndex:"0x1",
    topics:encodeEventTopics({abi:o1Legacy,eventName:"Claimed",args:{recipient:wallet,currency:other}}),
    data:encodeAbiParameters([{type:"uint256"}],[1n])};
}
test("O1 sparse full history completes in seven queries, one per escrow", async () => {
  const rpc = rpcFor(() => []);
  const {results} = await allPages("o1", rpc);
  assert.equal(results.length, 2);
  assert.equal(rpc.queries.length, 7);
  for (const target of O1) {
    const query = rpc.queries.find((q) => q.address === target.address);
    assert.equal(Number(BigInt(query.fromBlock)), target.start);
    assert.equal(Number(BigInt(query.toBlock)), 88000000);
    assert.equal(query.topics[1], `0x${"0".repeat(24)}${wallet.slice(2)}`);
  }
  assert.equal(results.at(-1).coverage.complete, true);
  assert.equal(results.at(-1).coverage.blocksChecked, results.at(-1).coverage.blocksTotal);
});
test("available-fee scans return direct balances before any event query for all three sources", async () => {
  for (const source of ["o1", "long", "pons"]) {
    const rpc = rpcFor(() => assert.fail("initial balance page queried logs"));
    const result = await scan({address:wallet, source, scope:"balances"}, {secret, createRpc:()=>rpc});
    assert.equal(result.history.length, 0);
    assert.ok(result.cursor);
    if (source !== "long") assert.ok(result.balances.length > 0);
  }
});
test("available discovery excludes payout streams and still finds non-native owed fees", async () => {
  for (const source of ["o1", "long", "pons"]) {
    const rpc = rpcFor((filter) => {
      const selectors = Array.isArray(filter.topics[0]) ? filter.topics[0] : [filter.topics[0]];
      const payouts = [o1Legacy, longAbi, ponsV1Abi].flatMap((abi) => abi.filter((e) => e.type === "event" && /Claimed|Release/.test(e.name)).map((e) => encodeEventTopics({abi:[e], eventName:e.name})[0]));
      assert.ok(selectors.every((selector) => !payouts.includes(selector)));
      if (filter.address !== O1[0].address) return [];
      return [{...claimLog(filter,88000000), topics:encodeEventTopics({abi:o1Legacy,eventName:"Credited",args:{recipient:wallet,currency:other}})}];
    });
    if (source === "long") rpc.snapshot = async () => ({ number: LONG.start + 250000, hash });
    const {results, history} = await allPages(source,rpc,undefined,"balances");
    assert.equal(history.length,0);
    assert.equal(results.at(-1).coverage.complete,true);
    if (source === "o1") assert.ok(results.flatMap((r)=>r.balances).some((r)=>r.currency===other));
    if (source === "long") assert.equal(rpc.queries.length,2);
  }
});
test("payout history loads claim events without balance reads or claim simulations", async () => {
  const rpc = rpcFor((filter) => filter.address===O1[0].address ? [claimLog(filter,88000000)] : []);
  rpc.call=async()=>assert.fail("history scan read a current balance");
  const {results,history}=await allPages("o1",rpc,undefined,"history");
  assert.equal(history.length,1);
  assert.ok(results.every((r)=>r.balances.length===0));
  assert.equal(results.at(-1).coverage.complete,true);
});
test("scan cursors cannot be reused across balance and history scopes", async () => {
  const rpc=rpcFor(()=>[]);
  const first=await scan({address:wallet,source:"o1",scope:"balances"},{secret,createRpc:()=>rpc});
  await assert.rejects(scan({address:wallet,source:"o1",scope:"history",cursor:first.cursor},{secret,createRpc:()=>rpc}),e=>e.code==="cursor_expired");
  await assert.rejects(scan({address:wallet,source:"o1",scope:"unknown"},{secret,createRpc:()=>rpc}),e=>e.code==="invalid_request");
});
test("provider range limits bisect in place and cover every block exactly once", async () => {
  const covered = [];
  const rpc = rpcFor((filter) => {
    const lo = Number(BigInt(filter.fromBlock)), hi = Number(BigInt(filter.toBlock));
    if (hi-lo+1 > 24) throw new ReadError("log_range");
    covered.push([lo,hi]); return [];
  });
  const {results} = await allPages("o1", rpc, await oneStreamCursor(O1[0].start+95));
  assert.equal(results.length, 1);
  assert.equal(rpc.queries.length, 8);
  assert.equal(covered[0][1], O1[0].start+95);
  for(let i=1;i<covered.length;i++) assert.equal(covered[i][1],covered[i-1][0]-1);
  assert.equal(covered.at(-1)[0], O1[0].start);
});
test("dense payout history splits ranges and drains every payout without loss or duplicates", async () => {
  const rpc = rpcFor((filter) => {
    const lo = Number(BigInt(filter.fromBlock)), hi = Number(BigInt(filter.toBlock));
    return Array.from({length:hi-lo+1},(_,i)=>claimLog(filter,lo+i));
  });
  const {history,results} = await allPages("o1", rpc, await oneStreamCursor(O1[0].start+199));
  assert.equal(history.length, 200);
  assert.equal(new Set(history.map((r)=>r.id)).size,200);
  assert.equal(Math.min(...history.map((r)=>r.block)),O1[0].start);
  assert.equal(Math.max(...history.map((r)=>r.block)),O1[0].start+199);
  assert.ok(results.some((r)=>!r.coverage.complete && r.coverage.pending>0));
  assert.equal(results.at(-1).coverage.complete,true);
});
test("in-flight fixed-window cursors expand only their remaining unprocessed range", async () => {
  const rpc = rpcFor(() => []);
  const cursor = await oneStreamCursor(50000000,{next:40000000, range:10000, sizing:undefined});
  const {results} = await allPages("o1",rpc,cursor);
  assert.equal(results.length,1);
  assert.equal(rpc.queries[0].toBlock,toHex(40000000));
  assert.equal(rpc.queries[0].fromBlock,toHex(O1[0].start));
});
test("Long pages unrelated global discovery before decoding and filters payouts by beneficiary", async () => {
  const lock = longAbi.find((e)=>e.name==="Lock");
  const rpc = rpcFor((filter) => Array.isArray(filter.topics[0])
    ? Array.from({length:32},(_,i)=>({address:LONG.address, removed:false, blockHash:hash,
      transactionHash:hash,blockNumber:filter.toBlock,logIndex:toHex(i),
      topics:encodeEventTopics({abi:longAbi,eventName:"Lock",args:{pool:other}}),
      data:encodeAbiParameters(lock.inputs.filter((p)=>!p.indexed),[[{beneficiary:other,shares:10n**18n}]])}))
    : []);
  rpc.snapshot = async () => ({ number: LONG.start, hash });
  const {results} = await allPages("long",rpc);
  assert.equal(rpc.queries.length,3);
  assert.equal(results[0].coverage.pending,0);
  assert.equal(rpc.queries.find((query) => !Array.isArray(query.topics[0])).topics[2],`0x${"0".repeat(24)}${wallet.slice(2)}`);
});
test("empty pons wallet never scans all v1 collections or misuses the collection caller as recipient", async () => {
  const rpc = rpcFor(()=>[]);
  const {results} = await allPages("pons",rpc);
  const v1 = rpc.queries.filter((q)=>q.address===PONS_V1.address);
  assert.equal(v1.length,2);
  assert.ok(v1.every((q)=>q.topics[2]===`0x${"0".repeat(24)}${wallet.slice(2)}`));
  assert.equal(results.at(-1).coverage.complete,true);
});
test("RPC logs outside an indexed wallet filter cannot become a successful empty scan", async () => {
  const rpc = rpcFor((filter)=>[{
    ...claimLog(filter,88000000),
    topics:encodeEventTopics({abi:o1Legacy,eventName:"Claimed",args:{recipient:other,currency:other}}),
  }]);
  await assert.rejects(scan({address:wallet,source:"o1"},{secret,createRpc:()=>rpc}),e=>e.code==="invalid_response");
});
test("pons batches initial custom-recipient discovery before applying the pending-record limit", async () => {
  const launched = ponsFactoryAbi.find((e)=>e.name==="TokenLaunched");
  const rpc = rpcFor((filter) => filter.address !== PONS_FACTORY.address ? []
    : Array.from({length:1024},(_,i)=>({address:filter.address,removed:false,blockHash:hash,
      transactionHash:hash,blockNumber:filter.toBlock,logIndex:toHex(i),
      topics:encodeEventTopics({abi:ponsFactoryAbi,eventName:"TokenLaunched",args:{token:toHex(BigInt(i+1),{size:20}),curve:other,deployer:other}}),
      data:encodeAbiParameters(launched.inputs.filter((p)=>!p.indexed),[NATIVE,1n,1n]),
    })));
  let batches=0;
  rpc.calls=async(calls)=>{
    assert.ok(calls.length<=512);
    if(calls.some((call)=>call.functionName==="getLaunchedToken"))batches++;
    return Promise.all(calls.map((call)=>call.functionName==="getLaunchedToken"
      ? {exists:true,creatorFeeRecipient:other} : rpc.call(call.address,call.abi,call.functionName,call.args)));
  };
  const {results}=await allPages("pons",rpc);
  assert.equal(results.length,1);
  assert.equal(batches,2);
  assert.equal(results.at(-1).coverage.complete,true);
});
test("HTTP 400 range-limit errors are safely classified; credentials and auth errors remain failures", async () => {
  for(const [message,expected]of[["query result size exceeds limit", "log_range"],["invalid authentication fixture", "read_failed"]]) {
    const rpc=new Rpc("https://rpc.example.invalid",async()=>new Response(JSON.stringify({jsonrpc:"2.0",id:1,error:{code:-32602,message}}),{status:400}));
    await assert.rejects(rpc.send("eth_getLogs",[{}]),e=>e.code===expected&&e.message===expected);
  }
  const rpc=new Rpc("https://rpc.example.invalid",async()=>new Response("withheld",{status:413}));
  await assert.rejects(rpc.send("eth_getLogs",[{}]),e=>e.code==="response_limit");
});

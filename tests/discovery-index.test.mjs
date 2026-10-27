import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { toHex } from "viem";
import { createDiscoveryIndex } from "../lib/fees/discovery-index.mjs";
import { ReadError } from "../lib/fees/model.mjs";

const address=`0x${"aa".repeat(20)}`, owner=`0x${"11".repeat(20)}`, other=`0x${"22".repeat(20)}`;
const hash=(height)=>toHex(height,{size:32});
function database() {
  const sql=new DatabaseSync(":memory:");
  const db={
    prepare(query) {
      return {query,args:[],bind(...args){return {...this,args};},
        async run(){const result=sql.prepare(this.query).run(...this.args);return {success:true,meta:{changes:Number(result.changes)}};},
        async first(){return sql.prepare(this.query).get(...this.args)??null;},
        async all(){return {success:true,results:sql.prepare(this.query).all(...this.args)};}};
    },
    async batch(statements){sql.exec("BEGIN");try{const results=[];for(const statement of statements) results.push(await statement.run());sql.exec("COMMIT");return results;}catch(error){sql.exec("ROLLBACK");throw error;}},
  };
  return {db,sql,index:createDiscoveryIndex(db)};
}
const selector=hash(123);
function log(height,index=0,who=owner) {
  return {address,removed:false,blockNumber:toHex(height),logIndex:toHex(index),blockHash:hash(height),transactionHash:hash(index+1),topics:[selector],data:"0x",who};
}
const profile={namespace:"4663:fixture:pin-v1",address,start:100,topics:[selector],decode:(log)=>[{owner:log.who,target:"fixture",token:toHex(Number(BigInt(log.logIndex))+1,{size:20})}]};
const snapshot=(number)=>({number,hash:hash(number)});
function rpc(logs=[],handler) {
  return {queries:[],async send(method,params,options){
    if(method==="eth_getBlockByNumber")return {hash:hash(Number(BigInt(params[0])))};
    if(method!=="eth_getLogs")throw new Error("unexpected method");
    this.queries.push({query:params[0],options});
    if(handler)return handler(params[0]);
    return logs.filter((entry)=>Number(BigInt(entry.blockNumber))>=Number(BigInt(params[0].fromBlock))&&Number(BigInt(entry.blockNumber))<=Number(BigInt(params[0].toBlock)));
  }};
}

test("a completed shared index serves different wallet lookups without rescanning global logs",async()=>{
  const {index,sql}=database(), chain=rpc([log(101,0,owner),log(104,1,other)]), snap=snapshot(110);
  assert.equal((await index.advance({rpc:chain,profile,snapshot:snap})).complete,true);
  assert.equal((await index.positions({profile,owner,snapshot:snap})).positions.length,1);
  assert.equal((await index.positions({profile,owner:other,snapshot:snap})).positions.length,1);
  assert.equal((await index.advance({rpc:chain,profile,snapshot:snap})).complete,true);
  assert.equal(chain.queries.length,1);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM fee_discovery_members").get().n,2);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM fee_discovery_state").get().n,1);
});

test("refresh only requests new blocks and frozen snapshots exclude later memberships",async()=>{
  const {index}=database(), chain=rpc([log(101),log(112,1)]);
  await index.advance({rpc:chain,profile,snapshot:snapshot(110)});
  await index.advance({rpc:chain,profile,snapshot:snapshot(115)});
  assert.equal(chain.queries[1].query.fromBlock,toHex(111));
  assert.equal((await index.positions({profile,owner,snapshot:snapshot(110)})).positions.length,1);
  assert.equal((await index.positions({profile,owner,snapshot:snapshot(115)})).positions.length,2);
});

test("dense raw responses shrink without decoding or advancing coverage",async()=>{
  const {index}=database();let decoded=0;
  const custom={...profile,decode(){decoded++;throw new Error("must not decode");}};
  const chain=rpc([],()=>Array.from({length:40},()=>({data:"malformed"})));
  const result=await index.advance({rpc:chain,profile:custom,snapshot:snapshot(131)});
  assert.equal(result.complete,false);assert.equal(result.blocksChecked,0);assert.equal(decoded,0);
  assert.equal(chain.queries[0].options.maxResponseBytes,64*1024);
});

test("single-block discovery resumes by log index and persists every membership exactly once",async()=>{
  const {index,sql}=database(), chain=rpc(Array.from({length:41},(_,i)=>log(100,i)));
  let result=await index.advance({rpc:chain,profile,snapshot:snapshot(100)});
  assert.equal(result.complete,false);assert.equal(result.blocksChecked,0);
  result=await index.advance({rpc:chain,profile,snapshot:snapshot(100)});
  assert.equal(result.complete,false);
  result=await index.advance({rpc:chain,profile,snapshot:snapshot(100)});
  assert.equal(result.complete,true);assert.equal(result.blocksChecked,1);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM fee_discovery_members").get().n,41);
  const page=await index.positions({profile,owner,snapshot:snapshot(100),limit:16});
  assert.equal(page.positions.length,16);assert.ok(page.after);
  const next=await index.positions({profile,owner,snapshot:snapshot(100),after:page.after,limit:16});
  assert.equal(next.positions.length,16);assert.ok(next.after);
  assert.equal(new Set([...page.positions,...next.positions].map((position)=>position.token)).size,32);
});

test("provider range limits preserve progress and reduce the next request size",async()=>{
  const {index}=database(), chain=rpc([],()=>{throw new ReadError("log_range");});
  const first=await index.advance({rpc:chain,profile,snapshot:snapshot(131)});
  assert.equal(first.blocksChecked,0);assert.equal(first.complete,false);
  await index.advance({rpc:chain,profile,snapshot:snapshot(131)});
  assert.equal(Number(BigInt(chain.queries[1].query.toBlock))-Number(BigInt(chain.queries[1].query.fromBlock))+1,16);
});

test("malformed logs and changed canonical hashes cannot publish memberships or completion",async()=>{
  const {index,sql}=database(), chain=rpc([log(101)]);
  await index.advance({rpc:chain,profile,snapshot:snapshot(110)});
  chain.send=async()=>({hash:hash(999)});
  await assert.rejects(index.advance({rpc:chain,profile,snapshot:snapshot(111)}),(error)=>error.code==="snapshot_changed");
  assert.equal(sql.prepare("SELECT next_block FROM fee_discovery_state").get().next_block,profile.start);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM fee_discovery_members").get().n,0);
  const second=database(), invalid=rpc([{...log(101),address:other}]);
  await assert.rejects(second.index.advance({rpc:invalid,profile,snapshot:snapshot(110)}),(error)=>error.code==="invalid_response");
  assert.equal((await second.index.coverage({profile,snapshot:snapshot(110)})).blocksChecked,0);
});

test("a database failure is fixed-code and a live lease avoids duplicate provider work",async()=>{
  const {db,index,sql}=database();
  await index.coverage({profile,snapshot:snapshot(110)});
  sql.prepare("UPDATE fee_discovery_state SET lease_owner='another-request',lease_until=?").run(Date.now()+60000);
  const chain=rpc();assert.equal((await index.advance({rpc:chain,profile,snapshot:snapshot(110)})).complete,false);assert.equal(chain.queries.length,0);
  const broken={prepare(){throw new Error("private database details");},async batch(){throw new Error("private database details");}};
  await assert.rejects(createDiscoveryIndex(broken).coverage({profile,snapshot:snapshot(110)}),(error)=>error.code==="index_unavailable"&&!error.message.includes("private"));
});

test("many public memberships use bounded SQL parameters and optional grouped decoding",async()=>{
  const {db,index,sql}=database(), original=db.prepare;let maximum=0,groups=0,insertPages=0;
  db.prepare=(query)=>{const statement=original(query),bind=statement.bind;statement.bind=function(...args){maximum=Math.max(maximum,args.length);if(query.includes("INSERT OR IGNORE INTO fee_discovery_members")){insertPages++;assert.ok(args[1].length<2_000_000);}return bind.apply(this,args);};return statement;};
  const grouped={...profile,decode:undefined,decodeMany(logs){groups++;return logs.map(()=>Array.from({length:1100},(_,i)=>({owner:toHex(i+1,{size:20}),target:"fixture",token:address})));}};
  await index.advance({rpc:rpc([log(100)]),profile:grouped,snapshot:snapshot(100)});
  assert.equal(groups,1);assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM fee_discovery_members").get().n,1100);assert.equal(insertPages,3);
  assert.ok(maximum<=100);
});

test("membership inserts and checkpoint writes roll back atomically",async()=>{
  const {db,index,sql}=database(), original=db.batch;
  await index.coverage({profile,snapshot:snapshot(110)});
  db.batch=async(statements)=>{
    if(statements.length===2&&statements[0].query.includes("INSERT OR IGNORE INTO fee_discovery_members")){
      sql.exec("BEGIN");await statements[0].run();sql.exec("ROLLBACK");throw new Error("private write failure");
    }
    return original(statements);
  };
  await assert.rejects(index.advance({rpc:rpc([log(101)]),profile,snapshot:snapshot(110)}),(error)=>error.code==="index_unavailable");
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM fee_discovery_members").get().n,0);
  assert.equal(sql.prepare("SELECT next_block FROM fee_discovery_state").get().next_block,profile.start);
});

test("warm lookups issue no state inserts and use only one member query",async()=>{
  const {db,index}=database(), chain=rpc([log(101)]);
  await index.advance({rpc:chain,profile,snapshot:snapshot(110)});
  const original=db.prepare;let writes=0,reads=0;
  db.prepare=(query)=>{if(/^\s*(?:INSERT|UPDATE|DELETE)/.test(query))writes++;else if(/^\s*SELECT/.test(query))reads++;return original(query);};
  await index.coverage({profile,snapshot:snapshot(110)});
  await index.positions({profile,owner,snapshot:snapshot(110)});
  await index.advance({rpc:chain,profile,snapshot:snapshot(110)});
  assert.equal(writes,0);assert.equal(reads,3);assert.equal(chain.queries.length,1);
});

test("optional hint variants deduplicate by identity without keyset pagination skips",async()=>{
  const {index}=database(), poolA=hash(1),poolB=hash(2);
  const variant={...profile,decode(entry){const position=Number(BigInt(entry.logIndex))===0 ? {pool:poolA,token:address}
    : Number(BigInt(entry.logIndex))===1 ? {pool:poolA} : {pool:poolB,token:other};return [{owner,target:"fixture",...position}];}};
  await index.advance({rpc:rpc([log(100,0),log(101,1),log(102,2)]),profile:variant,snapshot:snapshot(110)});
  const first=await index.positions({profile:variant,owner,snapshot:snapshot(110),limit:1});
  assert.deepEqual(first.positions,[{target:"fixture",pool:poolA}]);assert.ok(first.after);
  const second=await index.positions({profile:variant,owner,snapshot:snapshot(110),limit:1,after:first.after});
  assert.deepEqual(second.positions,[{target:"fixture",token:other,pool:poolB}]);assert.equal(second.after,null);
  const earlier=await index.positions({profile:variant,owner,snapshot:snapshot(100)});
  assert.deepEqual(earlier.positions,[{target:"fixture",token:address,pool:poolA}]);
});

test("a replaced lease cannot commit stale memberships or advance another request's checkpoint",async()=>{
  const {index,sql}=database();
  const chain=rpc([],()=>{sql.prepare("UPDATE fee_discovery_state SET lease_owner='replacement',lease_until=?").run(Date.now()+60000);return [log(101)];});
  const result=await index.advance({rpc:chain,profile,snapshot:snapshot(110)});
  assert.equal(result.complete,false);assert.equal(result.blocksChecked,0);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM fee_discovery_members").get().n,0);
  assert.equal(sql.prepare("SELECT lease_owner FROM fee_discovery_state").get().lease_owner,"replacement");
});

test("documented daily D1 row quotas retry at midnight UTC without exposing database details",async()=>{
  const originalNow=Date.now;
  Date.now=()=>Date.UTC(2026,9,27,18,30,15,250);
  try {
    for(const kind of ["read","write"]) {
      const message=`D1_ERROR: Your account has exceeded D1's free tier daily row ${kind} limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue. private-credential`;
      for(const wrapped of [false,true]) {
        const failure=wrapped ? new Error("D1 binding failure",{cause:new Error(message)}) : new Error(message);
        const db={prepare(){throw failure;},async batch(){throw failure;}};
        await assert.rejects(createDiscoveryIndex(db).coverage({profile,snapshot:snapshot(110)}),(error)=>{
          assert.equal(error.code,"rate_limited");assert.equal(error.message,"rate_limited");
          assert.equal(error.retryAfter,19_784_750);
          assert.equal(error.cause,undefined);assert.ok(!JSON.stringify(error).includes("private-credential"));return true;
        });
      }
    }
  } finally {Date.now=originalNow;}
});

test("storage, invocation and generic D1 failures do not receive a daily quota retry",async()=>{
  for(const message of ["D1_ERROR: Exceeded maximum DB size.","Too many API requests by single Worker invocation",
    "D1 daily limit exceeded", "Daily row read limit for a custom provider", "D1_ERROR: private-credential sql failure"]) {
    const db={prepare(){throw new Error(message);},async batch(){throw new Error(message);}};
    await assert.rejects(createDiscoveryIndex(db).positions({profile,owner,snapshot:snapshot(110)}),(error)=>{
      assert.equal(error.code,"index_unavailable");assert.equal(error.retryAfter,undefined);
      assert.equal(error.message,"index_unavailable");assert.ok(!JSON.stringify(error).includes("private-credential"));return true;
    });
  }
});

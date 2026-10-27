import { toHex } from "viem";
import { ReadError, same, normalizeAddress } from "./model.mjs";

// Only public onchain discovery memberships are stored. Incoming wallet queries,
// balances, claim handles and credentials are never written to this database.
export const DISCOVERY_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS fee_discovery_state (
    namespace TEXT PRIMARY KEY, start_block INTEGER NOT NULL, next_block INTEGER NOT NULL,
    after_log_index INTEGER NOT NULL DEFAULT -1, last_block INTEGER, last_hash TEXT,
    block_range INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
    lease_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS fee_discovery_members (
    namespace TEXT NOT NULL, owner TEXT NOT NULL, identity TEXT NOT NULL,
    target TEXT NOT NULL, token TEXT, pool TEXT, currency TEXT,
    block_number INTEGER NOT NULL, log_index INTEGER NOT NULL,
    PRIMARY KEY (namespace, owner, identity, block_number, log_index)
  ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS fee_discovery_owner ON fee_discovery_members(namespace,owner,identity,block_number)`,
];
const readyDatabases = new WeakMap();
const HASH = /^0x[\da-f]{64}$/i;
const ADDRESS = /^0x[\da-f]{40}$/i;
// This is a response/CPU page budget, not a historical coverage limit. The caller
// continues until complete, and empty ranges expand rather than imposing a cap.
const PAGE_LOGS = 16;
const RESPONSE_BYTES = 64 * 1024;
// Every validated record contains only short ASCII addresses/identities, so
// these JSON pages remain well below D1's 2 MB bound-value limit. All pages are
// committed in the same transaction; this never caps or drops memberships.
const INSERT_ROWS = 512;
const safeHeight = (number) => Number.isSafeInteger(number) && number >= 0;
function failed(error) {
  if (error instanceof ReadError) return error;
  // Match only Cloudflare's documented daily-row quota messages. Storage and
  // invocation limits do not reset daily and must not inherit this retry time.
  // Older bindings wrap the detailed message in cause; never return it.
  let detail=error;
  for(let depth=0;detail&&depth<3;depth++,detail=detail.cause) {
    const message=typeof detail.message==="string" ? detail.message : "";
    if(message.includes("Your account has exceeded D1's free tier daily row read limit.") ||
      message.includes("Your account has exceeded D1's free tier daily row write limit.")) {
      const limited=new ReadError("rate_limited"),day=86_400_000;
      limited.retryAfter=day-((Date.now()%day)+day)%day;
      return limited;
    }
  }
  return new ReadError("index_unavailable");
}
function validProfile(profile) {
  if (!profile || typeof profile.namespace !== "string" || profile.namespace.length > 512 ||
    !ADDRESS.test(profile.address) || !safeHeight(profile.start) || !Array.isArray(profile.topics) ||
    (typeof profile.decode !== "function" && typeof profile.decodeMany !== "function")) throw new ReadError("invalid_request");
}
function snapshotNumber(snapshot) {
  if (!safeHeight(snapshot?.number) || !HASH.test(snapshot?.hash)) throw new ReadError("invalid_request");
  return snapshot.number;
}
function cover(state, snapshot) {
  const total = Math.max(0, snapshot - state.start_block + 1);
  const checked = Math.min(total, Math.max(0, state.next_block - state.start_block));
  return { complete: state.next_block > snapshot, blocksChecked: checked, blocksTotal: total,
    next: state.next_block, revision: state.revision };
}
function record(entry, log) {
  const owner = normalizeAddress(entry.owner);
  if (typeof entry.target !== "string" || !/^[a-z\d-]{1,64}$/.test(entry.target) ||
    (entry.token !== undefined && !ADDRESS.test(entry.token)) ||
    (entry.pool !== undefined && !HASH.test(entry.pool)) ||
    (entry.currency !== undefined && !ADDRESS.test(entry.currency))) throw new ReadError("invalid_response");
  const token = entry.token?.toLowerCase() ?? null, pool = entry.pool?.toLowerCase() ?? null,
    currency = entry.currency?.toLowerCase() ?? null;
  if (!token && !pool && !currency) throw new ReadError("invalid_response");
  return { owner, identity: `${entry.target}:${pool ?? token ?? currency}`, target: entry.target,
    token, pool, currency, block: Number(BigInt(log.blockNumber)), index: Number(BigInt(log.logIndex)) };
}
function orderedLogs(logs, profile, lo, hi) {
  if (!Array.isArray(logs)) throw new ReadError("invalid_response");
  const selectors = Array.isArray(profile.topics[0]) ? profile.topics[0] : [profile.topics[0]];
  const ordered = logs.map((log) => {
    if (!same(log?.address,profile.address) || log.removed !== false || !HASH.test(log.blockHash) ||
      !HASH.test(log.transactionHash) || !/^0x[\da-f]+$/i.test(log.blockNumber) || !/^0x[\da-f]+$/i.test(log.logIndex) ||
      !Array.isArray(log.topics) || !selectors.some((selector) => same(selector,log.topics[0]))) throw new ReadError("invalid_response");
    const height = Number(BigInt(log.blockNumber)), index = Number(BigInt(log.logIndex));
    if (!safeHeight(height) || height < lo || height > hi || !safeHeight(index)) throw new ReadError("invalid_response");
    return {log,height,index};
  }).sort((a,b)=>a.height-b.height || a.index-b.index);
  if (ordered.some((entry,i)=>i>0 && entry.height===ordered[i-1].height && entry.index===ordered[i-1].index))
    throw new ReadError("invalid_response");
  return ordered;
}
export function createDiscoveryIndex(db) {
  if (!db?.prepare || !db?.batch) throw new ReadError("index_unavailable");
  async function ready() {
    let promise = readyDatabases.get(db);
    if (!promise) {
      promise = db.batch(DISCOVERY_SCHEMA.map((sql)=>db.prepare(sql))).catch((error)=>{readyDatabases.delete(db);throw failed(error);});
      readyDatabases.set(db,promise);
    }
    await promise;
  }
  async function stateFor(profile) {
    validProfile(profile); await ready();
    const statement=db.prepare(`SELECT * FROM fee_discovery_state WHERE namespace=?`).bind(profile.namespace);
    let state=await statement.first();
    if (!state) {
      await db.prepare(`INSERT OR IGNORE INTO fee_discovery_state(namespace,start_block,next_block,block_range) VALUES(?,?,?,?)`)
        .bind(profile.namespace,profile.start,profile.start,250_000).run();
      state=await statement.first();
    }
    if (!state || state.start_block !== profile.start || !safeHeight(state.next_block) || !Number.isSafeInteger(state.revision) ||
      !Number.isSafeInteger(state.after_log_index) || state.after_log_index < -1 || !safeHeight(state.block_range) || !state.block_range ||
      (state.last_block !== null && (!safeHeight(state.last_block) || !HASH.test(state.last_hash))))
      throw new ReadError("invalid_response");
    return state;
  }
  async function canonical(rpc,state) {
    if (state.last_block === null) return;
    const block = await rpc.send("eth_getBlockByNumber",[toHex(state.last_block),false]);
    if (!same(block?.hash,state.last_hash)) throw new ReadError("snapshot_changed");
  }
  async function release(profile,owner) {
    await db.prepare(`UPDATE fee_discovery_state SET lease_owner=NULL,lease_until=0 WHERE namespace=? AND lease_owner=?`)
      .bind(profile.namespace,owner).run();
  }
  return {
    async coverage({profile,snapshot}) {
      try { const number=snapshotNumber(snapshot); return cover(await stateFor(profile),number); }
      catch(error) { throw failed(error); }
    },
    async positions({profile,owner,snapshot,after="",limit=64}) {
      try {
        const number=snapshotNumber(snapshot), address=normalizeAddress(owner);
        if (typeof after!=="string" || after.length>256 || !Number.isSafeInteger(limit) || limit<1 || limit>256)
          throw new ReadError("invalid_request");
        validProfile(profile); await ready();
        // One deterministic hint per identity is essential for keyset paging:
        // grouping by optional fields could repeat an identity across pages and
        // skip the remainder when the next page uses identity > after.
        const result=await db.prepare(`SELECT identity,target,token,pool,currency FROM (
          SELECT identity,target,token,pool,currency,ROW_NUMBER() OVER
            (PARTITION BY identity ORDER BY block_number DESC,log_index DESC,target,token,pool,currency) AS hint_rank
          FROM fee_discovery_members WHERE namespace=? AND owner=? AND block_number<=? AND identity>?
        ) WHERE hint_rank=1 ORDER BY identity LIMIT ?`)
          .bind(profile.namespace,address,number,after,limit+1).all();
        const rows=result.results;
        if (!Array.isArray(rows)) throw new ReadError("invalid_response");
        return { positions:rows.slice(0,limit).map(({target,token,pool,currency})=>({target,...(token?{token}:{}),...(pool?{pool}:{}),...(currency?{currency}:{})})),
          after:rows.length>limit ? rows[limit-1].identity : null };
      } catch(error) { throw failed(error); }
    },
    async advance({rpc,profile,snapshot}) {
      let lease;
      try {
        const number=snapshotNumber(snapshot), state=await stateFor(profile);
        // Another request already owns the unfinished global range. Avoid
        // hammering the chain for the same canonical boundary while it works.
        if(state.next_block<=number && state.lease_owner && state.lease_until>Date.now())
          return {...cover(state,number),busy:true};
        try { await canonical(rpc,state); }
        catch(error) {
          if(error.code!=="snapshot_changed") throw error;
          // Confirmed reorgs are unusual, but a stale shared watermark must
          // never permanently poison discovery or survive as complete coverage.
          await db.batch([
            db.prepare(`DELETE FROM fee_discovery_members WHERE namespace=? AND EXISTS
              (SELECT 1 FROM fee_discovery_state WHERE namespace=? AND revision=?)`)
              .bind(profile.namespace,profile.namespace,state.revision),
            db.prepare(`UPDATE fee_discovery_state SET next_block=start_block,after_log_index=-1,last_block=NULL,last_hash=NULL,
              block_range=250000,revision=revision+1,lease_owner=NULL,lease_until=0 WHERE namespace=? AND revision=?`)
              .bind(profile.namespace,state.revision),
          ]);
          throw error;
        }
        if (state.next_block>number) return cover(state,number);
        lease=crypto.randomUUID();
        const claim=await db.prepare(`UPDATE fee_discovery_state SET lease_owner=?,lease_until=?
          WHERE namespace=? AND revision=? AND (lease_owner IS NULL OR lease_until<?)`)
          .bind(lease,Date.now()+30_000,profile.namespace,state.revision,Date.now()).run();
        if (claim.meta?.changes!==1) {
          lease=undefined;
          const current=await stateFor(profile);
          return {...cover(current,number),busy:!!current.lease_owner&&current.lease_until>Date.now()};
        }
        const lo=state.next_block, range=Math.max(1,Math.min(state.block_range,number-lo+1));
        const hi=lo+range-1;
        let logs;
        try {
          logs=await rpc.send("eth_getLogs",[{address:profile.address,fromBlock:toHex(lo),toBlock:toHex(hi),topics:profile.topics}],
            {maxResponseBytes:RESPONSE_BYTES});
        } catch(error) {
          if (!["log_range","response_limit"].includes(error.code) || range===1) throw error;
          const changed=await db.prepare(`UPDATE fee_discovery_state SET block_range=?,revision=revision+1,lease_owner=NULL,lease_until=0
            WHERE namespace=? AND revision=? AND lease_owner=?`).bind(Math.max(1,Math.floor(range/2)),profile.namespace,state.revision,lease).run();
          lease=undefined;
          return cover(changed.meta?.changes===1 ? {...state,revision:state.revision+1} : await stateFor(profile),number);
        }
        // Reject dense arrays before decoding or serializing any event body.
        if (!Array.isArray(logs)) throw new ReadError("invalid_response");
        if (logs.length>PAGE_LOGS && range>1) {
          const changed=await db.prepare(`UPDATE fee_discovery_state SET block_range=?,revision=revision+1,lease_owner=NULL,lease_until=0
            WHERE namespace=? AND revision=? AND lease_owner=?`).bind(Math.max(1,Math.floor(range/2)),profile.namespace,state.revision,lease).run();
          lease=undefined;
          return cover(changed.meta?.changes===1 ? {...state,revision:state.revision+1} : await stateFor(profile),number);
        }
        const ordered=orderedLogs(logs,profile,lo,hi).filter((entry)=>entry.height!==lo || entry.index>state.after_log_index);
        const selected=ordered.slice(0,PAGE_LOGS), more=ordered.length>PAGE_LOGS, entries=[];
        const decodedMany=profile.decodeMany ? selected.length ? await profile.decodeMany(selected.map((entry)=>entry.log),{rpc,snapshot}) : [] : null;
        if(profile.decodeMany && (!Array.isArray(decodedMany) || decodedMany.length!==selected.length)) throw new ReadError("invalid_response");
        for (const [index,entry] of selected.entries()) {
          const decoded=decodedMany ? decodedMany[index] : await profile.decode(entry.log,{rpc,snapshot});
          if (!Array.isArray(decoded)) throw new ReadError("invalid_response");
          for (const member of decoded) entries.push(record(member,entry.log));
        }
        const boundary=more ? selected.at(-1).height : hi;
        const block=await rpc.send("eth_getBlockByNumber",[toHex(boundary),false]);
        if (!HASH.test(block?.hash) || selected.some((entry)=>entry.height===boundary && !same(entry.log.blockHash,block.hash)))
          throw new ReadError("snapshot_changed");
        const next=more ? boundary : hi+1, after=more ? selected.at(-1).index : -1;
        const nextRange=more ? 1 : logs.length<PAGE_LOGS/4 ? Math.max(1,Math.min(Number.MAX_SAFE_INTEGER,range*2)) : range;
        // The insert and checkpoint CAS execute in one D1 transaction; a losing
        // concurrent request cannot publish rows or advance past uncommitted work.
        const unique=[...new Map(entries.map((entry)=>[`${entry.owner}:${entry.identity}:${entry.block}:${entry.index}`,entry])).values()],inserts=[];
        for(let offset=0;offset<unique.length;offset+=INSERT_ROWS) {
          inserts.push(db.prepare(`INSERT OR IGNORE INTO fee_discovery_members(namespace,owner,identity,target,token,pool,currency,block_number,log_index)
            SELECT ?,json_extract(value,'$.owner'),json_extract(value,'$.identity'),json_extract(value,'$.target'),
            json_extract(value,'$.token'),json_extract(value,'$.pool'),json_extract(value,'$.currency'),json_extract(value,'$.block'),json_extract(value,'$.index')
            FROM json_each(?) WHERE EXISTS(SELECT 1 FROM fee_discovery_state WHERE namespace=? AND revision=? AND lease_owner=?)`)
            .bind(profile.namespace,JSON.stringify(unique.slice(offset,offset+INSERT_ROWS)),profile.namespace,state.revision,lease));
        }
        const update=db.prepare(`UPDATE fee_discovery_state SET next_block=?,after_log_index=?,last_block=?,last_hash=?,block_range=?,revision=revision+1,
          lease_owner=NULL,lease_until=0 WHERE namespace=? AND revision=? AND lease_owner=?`)
          .bind(next,after,boundary,block.hash,nextRange,profile.namespace,state.revision,lease);
        const committed=await db.batch([...inserts,update]);
        lease=undefined;
        return cover(committed.at(-1)?.meta?.changes===1 ? {...state,next_block:next,revision:state.revision+1} : await stateFor(profile),number);
      } catch(error) { throw failed(error); }
      finally { if(lease) { try { await release(profile,lease); } catch {} } }
    },
  };
}

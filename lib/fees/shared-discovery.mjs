import { ReadError } from "./model.mjs";

// Only pagination and verified coverage travel in the signed wallet checkpoint.
// The shared database contains public event memberships, never claim authority.
export async function sharedDiscoveryPage({rpc,index,profile,state,work=1,verify}) {
  let saved=state.sharedDiscovery;
  if (!saved || saved.namespace!==profile.namespace) saved=state.sharedDiscovery={namespace:profile.namespace,after:"",pending:[],exhausted:false};
  if (!Array.isArray(saved.pending) || saved.pending.length>16 || typeof saved.after!=="string") throw new ReadError("cursor_expired");
  const coverage=await index.advance({rpc,profile,snapshot:state.snapshot});
  if (!coverage.complete) {
    // Rebuilding or extending the public index cannot turn a partial result into
    // a complete wallet scan. Restart hint pagination when coverage is ready.
    saved.after="";saved.pending=[];saved.exhausted=false;
  }
  saved.coverage=coverage;
  if (coverage.complete && !saved.pending.length && !saved.exhausted) {
    const page=await index.positions({profile,owner:state.address,snapshot:state.snapshot,after:saved.after,limit:16});
    saved.pending=page.positions;
    saved.after=page.after??saved.after;
    saved.exhausted=page.after===null;
  }
  let checked=0;
  while (saved.pending.length && checked<work) {
    await verify(saved.pending[0]);
    saved.pending.shift();checked++;
  }
  return {coverage,checked,complete:coverage.complete&&saved.exhausted&&!saved.pending.length};
}

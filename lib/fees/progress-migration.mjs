import {scan} from "./engine.mjs";
import {openProgress,seal} from "./cursor.mjs";
import {ReadError,normalizeAddress} from "./model.mjs";
import {boundedJson} from "./rpc.mjs";

export async function verifyProgress(input,{secret}={}) {
  if(typeof secret!=="string"||secret.length<32)
    throw new ReadError("migration_unavailable");
  const address=normalizeAddress(input.address);
  await openProgress(input.checkpoint,address,input.source,secret);
  // The previous host only verifies; signing keys never leave either host.
  return {verified:true};
}
export async function scanWithMigration(input,options={},operation=scan) {
  try{return await operation(input,options);}
  catch(error){
    const checkpoint=input.checkpoint||input.cursor;
    if(!(error instanceof ReadError)||error.code!=="cursor_expired"||!checkpoint||!options.legacyProgressUrl)throw error;
    try{
      const address=normalizeAddress(input.address),origin=new URL(options.legacyProgressUrl);
      if(origin.protocol!=="https:"||origin.username||origin.password||origin.search||origin.hash)throw Error();
      const response=await (options.migrationFetcher||fetch).call(globalThis,new URL("/api/progress/migrate",origin).toString(),{
        method:"POST",credentials:"omit",redirect:"manual",cache:"no-store",signal:AbortSignal.timeout(12000),
        headers:{"content-type":"application/json","x-hood-intent":"progress-migrate"},
        body:JSON.stringify({address,source:input.source,checkpoint}),
      });
      if(!response.ok){await response.body?.cancel();throw Error();}
      const value=await boundedJson(response,128*1024);
      if(value.verified!==true||typeof options.secret!=="string"||options.secret.length<32)throw Error();
      // Only this fixed HTTPS verifier can approve the exact submitted token.
      const payload=checkpoint.split(".")[0].replaceAll("-","+").replaceAll("_","/");
      const state=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload),c=>c.charCodeAt(0))));
      const renewed=await seal(state,options.secret);
      await openProgress(renewed,address,input.source,options.secret);
      return await operation({...input,cursor:undefined,snapshotCursor:undefined,checkpoint:renewed},options);
    }catch{throw new ReadError("migration_unavailable");}
  }
}

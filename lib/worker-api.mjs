import { scanResponse, sourceResponse, prepareClaimResponse, confirmClaimResponse } from "./fees/api.mjs";
import { createDiscoveryIndex } from "./fees/discovery-index.mjs";

export async function workerApi(request, env, revision) {
  const path = new URL(request.url).pathname;
  const configured = [env.ROBINHOOD_RPC_URL, env.O1_API_KEY, env.SCAN_CURSOR_SECRET].every((value) => typeof value === "string" && value.length > 0) && env.SCAN_CURSOR_SECRET.length >= 32 &&
    typeof env.DISCOVERY_DB?.prepare === "function" && typeof env.DISCOVERY_DB?.batch === "function";
  const json = (value, status=200) => Response.json(value, {status,headers:{"cache-control":"no-store","x-content-type-options":"nosniff"}});
  if (path === "/api/health") return json({status:configured ? "ok" : "unconfigured", revision, chainId:4663}, configured ? 200 : 503);
  if (path === "/api/sources") return request.method === "GET" ? sourceResponse() : new Response(null,{status:405,headers:{Allow:"GET"}});
  const operation = {"/api/scan":scanResponse,"/api/claim/prepare":prepareClaimResponse,"/api/claim/confirm":confirmClaimResponse}[path];
  if (!operation) return null;
  if (request.method !== "POST") return new Response(null,{status:405,headers:{Allow:"POST","cache-control":"no-store"}});
  // Fail closed instead of silently falling back to a public RPC or transient key.
  if (!configured) return json({error:"provider_unavailable"},503);
  return operation(request,{url:env.ROBINHOOD_RPC_URL,secret:env.SCAN_CURSOR_SECRET,o1Key:env.O1_API_KEY,bagsKey:env.BAGS_API_KEY,legacyProgressUrl:env.LEGACY_PROGRESS_URL,
    ...(env.DISCOVERY_DB ? {discoveryIndex:createDiscoveryIndex(env.DISCOVERY_DB)} : {})});
}

import { parseAbi } from "viem";
import { PONS, PONS_V1, PONS_FACTORY, PONS_HOOK } from "./catalog.mjs";
import { ponsEscrow, ponsV1Abi, ponsFactoryAbi, ponsCurveAbi, ponsHookAbi } from "./abi.mjs";
import { ReadError, NATIVE, same, normalizeAddress, poolId } from "./model.mjs";

const tokenAbi=parseAbi(["function deployer() view returns (address)","function pairedToken() view returns (address)"]);
const isAddress=(value) => typeof value === "string" && /^0x[\da-f]{40}$/i.test(value);
const uint=(value) => typeof value === "bigint" && value >= 0n;
const checkToken=(value) => { if (!isAddress(value) || same(value,NATIVE)) throw new ReadError("invalid_request"); return value.toLowerCase(); };
async function batch(rpc,calls,block) {
  if (!calls.length) return [];
  const results=typeof rpc.calls === "function" ? await rpc.calls(calls,block)
    : await Promise.all(calls.map((call) => rpc.call(call.address,call.abi,call.functionName,call.args,block)));
  if (!Array.isArray(results) || results.length !== calls.length) throw new ReadError("invalid_response");
  return results;
}
const read=(address,abi,functionName,args=[]) => ({address,abi,functionName,args});

export async function readPonsInitial(rpc,owner,block) {
  owner=normalizeAddress(owner);
  const [native,recipientCount,deployerCount]=await batch(rpc,[
    read(PONS.address,ponsEscrow,"balanceOf",[owner]),
    read(PONS_V1.address,ponsV1Abi,"feeRecipientTokenCount",[owner]),
    read(PONS_V1.address,ponsV1Abi,"deployerTokenCount",[owner]),
  ],block);
  if (![native,recipientCount,deployerCount].every(uint) || recipientCount > BigInt(Number.MAX_SAFE_INTEGER) ||
    deployerCount > BigInt(Number.MAX_SAFE_INTEGER)) throw new ReadError("invalid_response");
  return {native,recipientCount,deployerCount};
}

export async function readPonsEscrowBalances(rpc,owner,currencies,block) {
  owner=normalizeAddress(owner);
  if (!Array.isArray(currencies) || currencies.some((currency) => !isAddress(currency))) throw new ReadError("invalid_request");
  const unique=[...new Set(currencies.map((currency) => currency.toLowerCase()))];
  const values=await batch(rpc,unique.map((currency) => same(currency,NATIVE)
    ? read(PONS.address,ponsEscrow,"balanceOf",[owner])
    : read(PONS.address,ponsEscrow,"balanceOfToken",[owner,currency])),block);
  if (!values.every(uint)) throw new ReadError("invalid_response");
  return unique.map((currency,index) => ({currency,raw:values[index]}));
}

export async function readPonsV1TokenPage(rpc,owner,entries,block) {
  owner=normalizeAddress(owner);
  if (!Array.isArray(entries) || entries.some((entry) => !["feeRecipientTokens","deployerTokens"].includes(entry?.name) ||
    !Number.isSafeInteger(entry.index) || entry.index < 0)) throw new ReadError("invalid_request");
  const tokens=await batch(rpc,entries.map((entry) => read(PONS_V1.address,ponsV1Abi,entry.name,[owner,BigInt(entry.index)])),block);
  if (tokens.some((token) => !isAddress(token) || same(token,NATIVE))) throw new ReadError("invalid_response");
  return tokens.map((token) => token.toLowerCase());
}

export async function readPonsV1Position(rpc,owner,token,block) {
  owner=normalizeAddress(owner); token=checkToken(token);
  const [redirect,deployer]=await batch(rpc,[read(PONS_V1.address,ponsV1Abi,"feeRedirects",[token]),read(token,tokenAbi,"deployer")],block);
  if (!isAddress(redirect) || !isAddress(deployer) || same(deployer,NATIVE)) throw new ReadError("invalid_response");
  if (!same(same(redirect,NATIVE) ? deployer : redirect,owner)) return {eligible:false};
  let gross;
  // Sender-dependent simulation must remain an independent eth_call. It never
  // submits a transaction and cannot be moved into Multicall's sender context.
  try { gross=await rpc.call(PONS_V1.address,ponsV1Abi,"collectFees",[token],block,deployer); }
  catch (error) {
    if (error instanceof ReadError && error.code === "nothing_to_collect") gross=[0n,0n];
    // An unread simulation is not a verified zero balance. Preserve transient
    // errors and Retry-After so the same signed page is retried without moving
    // its token offset; unexpected failures cross the boundary as a fixed code.
    else throw error instanceof ReadError ? error : new ReadError("read_failed");
  }
  if (!Array.isArray(gross) || gross.length !== 2 || !gross.every(uint)) throw new ReadError("invalid_response");
  const [share,pair]=await batch(rpc,[read(PONS_V1.address,ponsV1Abi,"tokenProtocolFeeShares",[token]),read(token,tokenAbi,"pairedToken")],block);
  if (!uint(share) || share > 100n || !isAddress(pair) || same(pair,token)) throw new ReadError("invalid_response");
  const ordered=BigInt(token) < BigInt(pair) ? [token,pair] : [pair,token];
  return {eligible:true,deployer:deployer.toLowerCase(),pair:pair.toLowerCase(),share,
    payouts:ordered.map((currency,index) => ({currency:currency.toLowerCase(),raw:gross[index]-(gross[index]*share)/100n}))};
}

export async function readPonsLaunches(rpc,tokens,block) {
  if (!Array.isArray(tokens)) throw new ReadError("invalid_request");
  const normalized=tokens.map(checkToken);
  const launches=await batch(rpc,normalized.map((token) => read(PONS_FACTORY.address,ponsFactoryAbi,"getLaunchedToken",[token])),block);
  for (let index=0;index<launches.length;index++) {
    const launch=launches[index];
    if (typeof launch?.exists !== "boolean" || launch.exists && (!same(launch.token,normalized[index]) ||
      !isAddress(launch.curve) || same(launch.curve,NATIVE) || !isAddress(launch.creatorFeeRecipient) || !isAddress(launch.pairToken)))
      throw new ReadError("invalid_response");
  }
  return launches;
}

export async function readPonsCurveState(rpc,owner,token,launch,block) {
  owner=normalizeAddress(owner); token=checkToken(token);
  if (!launch?.exists || !same(launch.creatorFeeRecipient,owner)) return {eligible:false,payouts:[],warnings:[]};
  if (!isAddress(launch.curve) || same(launch.curve,NATIVE) || !isAddress(launch.pairToken)) throw new ReadError("invalid_response");
  const graduated=await rpc.call(launch.curve,ponsCurveAbi,"graduated",[],block);
  if (typeof graduated !== "boolean") throw new ReadError("invalid_response");
  const payouts=[], warnings=[];
  if (!graduated) {
    const [recipient,quote,tax,share,earmark]=await batch(rpc,["deployer","quoteFeeBalance","creatorTaxBalance","protocolFeeShareBps","buybackQuoteBalance"]
      .map((name) => read(launch.curve,ponsCurveAbi,name)),block);
    if (!same(recipient,owner)) throw new ReadError("contract_changed");
    if (![quote,tax,earmark].every(uint) || !["bigint","number"].includes(typeof share) ||
      !Number.isSafeInteger(Number(share)) || Number(share) < 0 || Number(share) > 10000) throw new ReadError("invalid_response");
    const bucket=quote-(quote*BigInt(share))/10000n, buyback=earmark < bucket ? earmark : bucket;
    if (quote > 0n || tax > 0n) payouts.push({currency:launch.pairToken.toLowerCase(),raw:bucket-buyback+tax,
      kind:"unswept",token,position:launch.curve,earmarkedRaw:buyback.toString()});
    if (buyback > 0n) warnings.push("buyback_earmark");
  } else {
    const ordered=BigInt(token) < BigInt(launch.pairToken) ? [token,launch.pairToken] : [launch.pairToken,token];
    const id=poolId({currency0:ordered[0],currency1:ordered[1],fee:launch.poolFee,tickSpacing:launch.tickSpacing,hooks:PONS_HOOK.address});
    const config=await rpc.call(PONS_HOOK.address,ponsHookAbi,"launches",[id],block);
    if (!config?.[0] || !same(config[2],token) || !same(config[4],owner)) throw new ReadError("contract_changed");
    const share=config[8];
    if (!["bigint","number"].includes(typeof share) || !Number.isSafeInteger(Number(share)) || Number(share)<0 || Number(share)>10000)
      throw new ReadError("invalid_response");
    const values=await batch(rpc,ordered.flatMap((currency) => ["pendingFees","pendingCreatorTax","pendingBuyback"]
      .map((name) => read(PONS_HOOK.address,ponsHookAbi,name,[id,currency]))),block);
    if (!values.every(uint)) throw new ReadError("invalid_response");
    ordered.forEach((currency,index) => {
      const [gross,tax,earmark]=values.slice(index*3,index*3+3), bucket=gross-(gross*BigInt(share))/10000n,
        buyback=earmark < bucket ? earmark : bucket;
      if (gross > 0n || tax > 0n) payouts.push({currency:currency.toLowerCase(),raw:bucket-buyback+tax,
        kind:same(currency,token)?"conversion-needed":"unswept",token,position:id,earmarkedRaw:buyback.toString()});
    });
  }
  return {eligible:true,payouts,warnings};
}

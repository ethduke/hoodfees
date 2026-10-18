import { encodeFunctionData, isAddress } from "viem";
import { O1, LONG, PONS, PONS_V1, BAGS, BANKR_HOOK, WETH } from "./catalog.mjs";
import { o1Legacy, o1Current, ponsEscrow, ponsV1Abi, longAbi, bagsFeeAbi } from "./abi.mjs";
import { ReadError, normalizeAddress, same, NATIVE, CHAIN } from "./model.mjs";
export const amount = (value) => typeof value === "string" && /^(0|[1-9]\d{0,77})$/.test(value) && BigInt(value) < 1n << 256n;
export function claimKey(row) {
  return [row.target, row.position ?? "", [LONG.id, BANKR_HOOK.id, PONS_V1.id].includes(row.target) ? "both" : row.currency?.toLowerCase()].join(":");
}
export function claimPlan(row, owner, payouts = [row]) {
  const address = normalizeAddress(owner);
  if (!row || row.kind !== "available" || !amount(row.raw) || BigInt(row.raw) === 0n || !isAddress(row.currency, { strict: false }))
    throw new ReadError("nothing_to_claim");
  const target = [...O1, LONG, PONS, PONS_V1, BAGS, BANKR_HOOK].find((candidate) => candidate.id === row.target);
  if (!target || (row.source !== (target.kind.startsWith("pons") ? "pons" : target.kind) &&
    !(target.id === LONG.id && row.source === "bankr"))) throw new ReadError("invalid_request");
  let abi, functionName, args;
  if (target.kind === "bags") {
    if (!isAddress(row.position, { strict: false }) || same(row.position, NATIVE) || !isAddress(row.token, { strict: false }) ||
      same(row.token, NATIVE) || !same(row.currency, WETH)) throw new ReadError("invalid_request");
    abi = bagsFeeAbi; functionName = "claim"; args = [false];
  } else if (target.kind === "o1") {
    abi = target.version === "legacy" ? o1Legacy : o1Current;
    functionName = target.version === "legacy" ? "claim" : "claimFor";
    args = [address, row.currency];
  } else if (target.id === PONS.id) {
    abi = ponsEscrow;
    functionName = same(row.currency, NATIVE) ? "claim" : "claimToken";
    args = functionName === "claim" ? [BigInt(row.raw)] : [row.currency, BigInt(row.raw)];
  } else if ([LONG.id, BANKR_HOOK.id].includes(target.id)) {
    if (!/^0x[\da-f]{64}$/i.test(row.position) || !isAddress(row.token)) throw new ReadError("invalid_request");
    abi = longAbi; functionName = "collectFees"; args = [row.position];
  } else {
    if (!isAddress(row.token) || !same(row.position, row.token)) throw new ReadError("invalid_request");
    abi = ponsV1Abi; functionName = "collectFees"; args = [row.token];
  }
  const expectedCount = [LONG.id, BANKR_HOOK.id, PONS_V1.id].includes(target.id) ? 2 : 1;
  if (!Array.isArray(payouts) || payouts.length !== expectedCount ||
    payouts.some((payout) => !isAddress(payout.currency, { strict: false }) || !amount(payout.raw)) ||
    !payouts.some((payout) => same(payout.currency, row.currency) && BigInt(payout.raw) > 0n) ||
    new Set(payouts.map((payout) => payout.currency.toLowerCase())).size !== payouts.length)
    throw new ReadError("invalid_response");
  return { address, chainId: CHAIN, target: target.kind === "bags" ? row.position.toLowerCase() : target.address, targetId: target.id,
    source: row.source, position: row.position, token: row.token, row,
    key: claimKey(row), payouts, data: encodeFunctionData({ abi, functionName, args }), value: "0x0" };
}
export function validateQuote(quote, row, owner, now = Date.now()) {
  if (!quote || !Number.isSafeInteger(quote.expiresAt) || quote.expiresAt <= now || quote.expiresAt > now + 120000 ||
    !/^0x[\da-f]+$/i.test(quote.gas) || BigInt(quote.gas) < 21000n || BigInt(quote.gas) > 3000000n ||
    typeof quote.authorization !== "string" || quote.authorization.length > 85000 || !/^[\w-]+\.[\w-]+$/.test(quote.authorization))
    throw new ReadError("quote_expired");
  const expected = claimPlan(quote.row, owner, quote.payouts);
  if (claimKey(row) !== expected.key || !same(row.currency, quote.row.currency) ||
    !same(quote.address, expected.address) || quote.chainId !== CHAIN || !same(quote.target, expected.target) ||
    quote.targetId !== expected.targetId || quote.source !== expected.source || quote.position !== expected.position ||
    quote.token !== expected.token || quote.key !== expected.key || quote.data !== expected.data || quote.value !== "0x0")
    throw new ReadError("invalid_response");
  return { ...expected, gas: quote.gas, expiresAt: quote.expiresAt, authorization: quote.authorization };
}

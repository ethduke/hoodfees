import { isAddress } from "viem";
import { O1 } from "./catalog.mjs";
import { o1Current } from "./abi.mjs";
import { ReadError, same } from "./model.mjs";

// Owed() takes its recipient explicitly, so Multicall cannot change ownership.
// Both reviewed legacy and current escrows expose this exact read signature.
export async function readO1Balances(rpc, owner, positions, block) {
  if (!isAddress(owner, { strict: false }) || !Array.isArray(positions)) throw new ReadError("invalid_request");
  const unique = new Map();
  for (const position of positions) {
    const supplied = position?.target;
    const target = O1.find((entry) => entry.id === (typeof supplied === "string" ? supplied : supplied?.id));
    const currency = position?.currency;
    if (!target || (typeof supplied === "object" && supplied?.address && !same(supplied.address, target.address)) ||
      typeof currency !== "string" || !isAddress(currency, { strict: false })) throw new ReadError("invalid_request");
    unique.set(`${target.id}:${currency.toLowerCase()}`, { target, currency: currency.toLowerCase() });
  }
  const candidates = [...unique.values()];
  if (!candidates.length) return [];
  const calls = candidates.map(({ target, currency }) => ({ address: target.address, abi: o1Current,
    functionName: "owed", args: [owner, currency] }));
  const amounts = typeof rpc.calls === "function" ? await rpc.calls(calls, block) : [];
  if (typeof rpc.calls !== "function") for (const call of calls) amounts.push(await rpc.call(call.address, call.abi, call.functionName, call.args, block));
  if (!Array.isArray(amounts) || amounts.length !== candidates.length ||
    amounts.some((raw) => typeof raw !== "bigint" || raw < 0n || raw >= 1n << 256n)) throw new ReadError("invalid_response");
  return candidates.map((position, index) => ({ ...position, raw: amounts[index] }));
}

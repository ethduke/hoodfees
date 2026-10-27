import { decodeEventLog, parseAbi, toHex, isAddress } from "viem";
import { PAIR } from "./catalog.mjs";
import { pairAbi } from "./abi.mjs";
import { same, ReadError, NATIVE } from "./model.mjs";
const transferAbi = parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
export async function pairBalances(rpc, owner, assets, snapshot) {
  if (assets.some((asset) => !isAddress(asset, { strict: false }) || same(asset, NATIVE)))
    throw new ReadError("invalid_request");
  if (!assets.length) return [];
  const block = toHex(snapshot.number);
  await rpc.verify(PAIR, block);
  const values = await rpc.calls(assets.map((asset) => ({ address: PAIR.address, abi: pairAbi,
    functionName: "claimable", args: [owner, asset] })), block);
  if (values.length !== assets.length || values.some((value) => typeof value !== "bigint" || value < 0n))
    throw new ReadError("invalid_response");
  await rpc.prefetchCurrencies?.(assets, block);
  return Promise.all(assets.map(async (asset, i) => ({
    id: `${PAIR.id}::${asset.toLowerCase()}:available`, source: "pair", target: PAIR.id,
    ...(await rpc.currency(asset, block)), raw: values[i].toString(), kind: "available",
  })));
}
// A claim event alone does not prove that the ERC-20 actually paid the wallet.
// Require matching transfers from the pinned locker, grouped per receipt/asset.
export function pairReceiptEntries(receipt, owner) {
  if (!receipt || receipt.status !== "0x1" || !Array.isArray(receipt.logs) || receipt.logs.length > 2048 ||
    !/^0x[\da-f]{64}$/i.test(receipt.transactionHash) || !/^0x[\da-f]{64}$/i.test(receipt.blockHash) ||
    !/^0x[\da-f]+$/i.test(receipt.blockNumber)) throw new ReadError("invalid_response");
  const entries = [], transfers = new Map(), sums = new Map(), indexes = new Set();
  for (const log of receipt.logs) {
    if (log.removed === true || !same(log.blockHash, receipt.blockHash) || !same(log.transactionHash, receipt.transactionHash) ||
      !/^0x[\da-f]+$/i.test(log.logIndex) || indexes.has(log.logIndex)) throw new ReadError("invalid_response");
    indexes.add(log.logIndex);
    if (same(log.address, PAIR.address)) {
      let event;
      try { event = decodeEventLog({ abi: pairAbi, data: log.data, topics: log.topics, strict: true }); } catch { continue; }
      if (event.eventName === "FeesClaimed" && same(event.args.recipient, owner) && event.args.amount > 0n) {
        const currency = event.args.asset.toLowerCase();
        if (same(currency, NATIVE)) throw new ReadError("invalid_response");
        entries.push({ currency, raw: event.args.amount.toString(), index: Number(BigInt(log.logIndex)) });
        sums.set(currency, (sums.get(currency) ?? 0n) + event.args.amount);
      }
    } else {
      try {
        const event = decodeEventLog({ abi: transferAbi, data: log.data, topics: log.topics, strict: true });
        if (same(event.args.from, PAIR.address) && same(event.args.to, owner)) {
          const currency = log.address.toLowerCase();
          transfers.set(currency, (transfers.get(currency) ?? 0n) + event.args.value);
        }
      } catch { /* Other receipt logs do not authenticate a payout. */ }
    }
  }
  return entries.filter((entry) => sums.get(entry.currency) === transfers.get(entry.currency));
}

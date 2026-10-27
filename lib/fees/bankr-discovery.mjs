import { decodeEventLog, parseAbi, toEventSelector } from "viem";
import { LONG, BANKR_HOOK } from "./catalog.mjs";
import { ReadError, NATIVE, same } from "./model.mjs";

// The reviewed hook keeps a separate beneficiary ledger. Its initial membership
// event uses a pool ID, unlike the initializer's Lock(asset, beneficiaries).
// These signatures were strictly decoded against pinned Robinhood hook logs.
export const bankrDiscoveryAbi = parseAbi([
  "event FeeBeneficiariesSet(bytes32 indexed poolId,(address beneficiary,uint96 shares)[] beneficiaries)",
  "event UpdateBeneficiary(bytes32 poolId,address oldBeneficiary,address newBeneficiary)",
]);
export const bankrDiscoveryProfile = {
  namespace: `4663:${BANKR_HOOK.id}:${BANKR_HOOK.address.toLowerCase()}:${BANKR_HOOK.hash}:${LONG.hash}:beneficiaries-v1`,
  start: BANKR_HOOK.start, address: BANKR_HOOK.address,
  topics: [bankrDiscoveryAbi.map(toEventSelector)],
  decode(log) {
    let event;
    try { event = decodeEventLog({ abi: bankrDiscoveryAbi, topics: log.topics, data: log.data, strict: true }); }
    catch { throw new ReadError("invalid_response"); }
    if (event.eventName === "FeeBeneficiariesSet") return event.args.beneficiaries
      .filter((entry) => entry.shares > 0n && !same(entry.beneficiary, NATIVE))
      .map((entry) => ({ owner: entry.beneficiary.toLowerCase(), target: BANKR_HOOK.id, pool: event.args.poolId }));
    if (event.eventName === "UpdateBeneficiary") return [...new Set([event.args.oldBeneficiary, event.args.newBeneficiary]
      .map((address) => address.toLowerCase()).filter((address) => !same(address, NATIVE)))]
      .map((owner) => ({ owner, target: BANKR_HOOK.id, pool: event.args.poolId }));
    throw new ReadError("invalid_response");
  },
};

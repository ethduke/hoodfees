import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, toHex } from "viem";
import { bankrDiscoveryAbi, bankrDiscoveryProfile } from "../lib/fees/bankr-discovery.mjs";
import { LONG, BANKR_HOOK } from "../lib/fees/catalog.mjs";
import { NATIVE } from "../lib/fees/model.mjs";
const first = toHex(1, { size: 20 }), second = toHex(2, { size: 20 }), pool = toHex(3, { size: 32 });
function event(name, args) {
  const definition = bankrDiscoveryAbi.find((entry) => entry.name === name);
  return { topics: encodeEventTopics({ abi: bankrDiscoveryAbi, eventName: name, args }),
    data: encodeAbiParameters(definition.inputs.filter((input) => !input.indexed),
      definition.inputs.filter((input) => !input.indexed).map((input) => args[input.name])) };
}
test("Bankr hook discovery uses its own initial membership event and ledger target", () => {
  const log = event("FeeBeneficiariesSet", { poolId: pool, beneficiaries: [
    { beneficiary: first, shares: 5n }, { beneficiary: second, shares: 10n },
    { beneficiary: NATIVE, shares: 1n }, { beneficiary: toHex(4, { size: 20 }), shares: 0n },
  ] });
  assert.deepEqual(bankrDiscoveryProfile.decode(log), [
    { owner: first, target: BANKR_HOOK.id, pool }, { owner: second, target: BANKR_HOOK.id, pool },
  ]);
  assert.equal(bankrDiscoveryProfile.address, BANKR_HOOK.address);
  assert.ok(bankrDiscoveryProfile.namespace.includes(BANKR_HOOK.hash));
  assert.ok(bankrDiscoveryProfile.namespace.includes(LONG.hash));
});
test("Transferred Bankr hook rights discover both current and former beneficiaries without assuming eligibility", () => {
  assert.deepEqual(bankrDiscoveryProfile.decode(event("UpdateBeneficiary", { poolId: pool, oldBeneficiary: first, newBeneficiary: second })), [
    { owner: first, target: BANKR_HOOK.id, pool }, { owner: second, target: BANKR_HOOK.id, pool },
  ]);
  assert.deepEqual(bankrDiscoveryProfile.decode(event("UpdateBeneficiary", { poolId: pool, oldBeneficiary: first, newBeneficiary: first })), [
    { owner: first, target: BANKR_HOOK.id, pool },
  ]);
});
test("Malformed or initializer Lock logs cannot be interpreted as hook beneficiary identities", () => {
  assert.throws(() => bankrDiscoveryProfile.decode({ topics: bankrDiscoveryProfile.topics[0], data: "0x" }), { code: "invalid_response" });
  assert.deepEqual(bankrDiscoveryAbi.map((entry) => entry.name), ["FeeBeneficiariesSet", "UpdateBeneficiary"]);
});

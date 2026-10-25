import { parseAbi, encodeFunctionData, decodeFunctionResult, isAddress, toHex } from "viem";
import { BAGS, BAGS_FACTORY_IMPL, BAGS_BEACON, BAGS_FEE_IMPL, BAGS_HOOK, BAGS_FEE_PROXY_HASH, WETH, IMPLEMENTATION_SLOT, MULTICALL } from "./catalog.mjs";
import { bagsFactoryAbi, bagsFeeAbi, bagsBeaconAbi, bagsCurveAbi, bagsHookAbi } from "./abi.mjs";
import { ReadError, same, NATIVE } from "./model.mjs";

const aggregateAbi = parseAbi([
  "struct Call3 {address target;bool allowFailure;bytes callData;}",
  "struct Result {bool success;bytes returnData;}",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);
export const nonzeroAddress = (value) => typeof value === "string" && isAddress(value, { strict: false }) && !same(value, NATIVE);
export async function verifyBagsDeployment(rpc, block) {
  for (const profile of [BAGS, BAGS_FACTORY_IMPL, BAGS_BEACON, BAGS_FEE_IMPL, BAGS_HOOK]) await rpc.verify(profile, block);
  const slot = await rpc.send("eth_getStorageAt", [BAGS.address, IMPLEMENTATION_SLOT, block]);
  if (!/^0x0{24}[\da-f]{40}$/i.test(slot) || !same(`0x${slot.slice(-40)}`, BAGS_FACTORY_IMPL.address) ||
    !same(await rpc.call(BAGS_BEACON.address, bagsBeaconAbi, "implementation", [], block), BAGS_FEE_IMPL.address) ||
    !same(await rpc.call(BAGS.address, bagsFactoryAbi, "feeShareBeacon", [], block), BAGS_BEACON.address) ||
    !same(await rpc.call(BAGS.address, bagsFactoryAbi, "hook", [], block), BAGS_HOOK.address)) throw new ReadError("contract_changed");
}
export async function bagsPosition(rpc, token, expectedFee, block) {
  if (!nonzeroAddress(token) || (expectedFee !== undefined && !nonzeroAddress(expectedFee))) throw new ReadError("invalid_request");
  const fee = await rpc.call(BAGS.address, bagsFactoryAbi, "feeShareForToken", [token], block);
  if (!nonzeroAddress(fee) || (expectedFee && !same(fee, expectedFee))) throw new ReadError("contract_changed");
  await rpc.verify({ address: fee, hash: BAGS_FEE_PROXY_HASH }, block);
  const curve = await rpc.call(BAGS.address, bagsFactoryAbi, "curveForToken", [token], block);
  if (!nonzeroAddress(curve) || !same(await rpc.call(fee, bagsFeeAbi, "bondingCurve", [], block), curve) ||
    !same(await rpc.call(fee, bagsFeeAbi, "WETH", [], block), WETH) ||
    !same(await rpc.call(fee, bagsFeeAbi, "hook", [], block), BAGS_HOOK.address)) throw new ReadError("contract_changed");
  const pool = await rpc.call(fee, bagsFeeAbi, "poolId", [], block);
  if (!/^0x[\da-f]{64}$/i.test(pool)) throw new ReadError("invalid_response");
  return { token: token.toLowerCase(), fee: fee.toLowerCase(), pool };
}
export async function bagsTokenForFee(rpc, fee, block) {
  if (!nonzeroAddress(fee)) throw new ReadError("invalid_response");
  await rpc.verify({ address: fee, hash: BAGS_FEE_PROXY_HASH }, block);
  const curve = await rpc.call(fee, bagsFeeAbi, "bondingCurve", [], block);
  const token = await rpc.call(curve, bagsCurveAbi, "TOKEN", [], block);
  return bagsPosition(rpc, token, fee, block);
}
export async function bagsBalance(rpc, owner, token, expectedFee, snapshot) {
  const block = toHex(snapshot.number), position = await bagsPosition(rpc, token, expectedFee, block);
  const notified = await rpc.call(position.fee, bagsFeeAbi, "claimable", [owner], block);
  return balanceForPosition(rpc, owner, position, snapshot, notified);
}
export async function bagsIndexedBalance(rpc, owner, token, expectedFee, snapshot) {
  const block = toHex(snapshot.number), position = await bagsPosition(rpc, token, expectedFee, block);
  const calls = [
    { address: position.fee, abi: bagsFeeAbi, functionName: "claimable", args: [owner] },
    { address: position.fee, abi: bagsFeeAbi, functionName: "claimerBps", args: [owner] },
    { address: position.fee, abi: bagsFeeAbi, functionName: "PARTNER", args: [] },
  ];
  const readings = rpc.calls ? await rpc.calls(calls, block)
    : await Promise.all(calls.map((call) => rpc.call(call.address, call.abi, call.functionName, call.args, block)));
  if (!Array.isArray(readings) || readings.length !== 3) throw new ReadError("invalid_response");
  const [notified, bps, partner] = readings;
  if (typeof notified !== "bigint" || notified < 0n || !["bigint", "number"].includes(typeof bps) ||
    !Number.isSafeInteger(Number(bps)) || Number(bps) < 0 || Number(bps) > 10000 ||
    typeof partner !== "string" || !isAddress(partner, { strict: false })) throw new ReadError("invalid_response");
  // Removed recipients can still withdraw their previously credited balance.
  if (notified === 0n && Number(bps) === 0 && !same(partner, owner)) return null;
  return balanceForPosition(rpc, owner, position, snapshot, notified);
}
async function balanceForPosition(rpc, owner, position, snapshot, notified) {
  const block = toHex(snapshot.number);
  await rpc.verify(MULTICALL, block);
  // eth_call discards all state changes. This previews the same permissionless
  // sweep that claim() attempts, then reads the owner's resulting ledger. A
  // failed sweep is allowed, exactly as in the reviewed fee-share claim path.
  const preview = await rpc.call(MULTICALL.address, aggregateAbi, "aggregate3", [[
    { target: BAGS_HOOK.address, allowFailure: true, callData: encodeFunctionData({ abi: bagsHookAbi, functionName: "sweep", args: [position.pool] }) },
    { target: position.fee, allowFailure: false, callData: encodeFunctionData({ abi: bagsFeeAbi, functionName: "claimable", args: [owner] }) },
  ]], block);
  if (!Array.isArray(preview) || preview.length !== 2 || !preview[1].success) throw new ReadError("invalid_response");
  let raw;
  try { raw = decodeFunctionResult({ abi: bagsFeeAbi, functionName: "claimable", data: preview[1].returnData }); }
  catch { throw new ReadError("read_failed"); }
  if (typeof notified !== "bigint" || typeof raw !== "bigint" || raw < notified) throw new ReadError("invalid_response");
  return {
    id: `${BAGS.id}:${position.fee}:${WETH}:available`, source: "bags", target: BAGS.id,
    ...(await rpc.currency(WETH, block)), kind: "available", raw: raw.toString(),
    notifiedRaw: notified.toString(), sweptRaw: (raw - notified).toString(),
    token: position.token, position: position.fee,
  };
}

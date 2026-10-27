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
// Keep each Multicall payload bounded; callers can supply any number of positions
// and continue through chunks rather than losing candidates at a list-size cap.
async function readMany(rpc, calls, block) {
  const values = [];
  for (let offset = 0; offset < calls.length; offset += 128) {
    const chunk = calls.slice(offset, offset + 128);
    const result = typeof rpc.calls === "function" ? await rpc.calls(chunk, block) : await readSequentially(rpc, chunk, block);
    if (!Array.isArray(result) || result.length !== chunk.length) throw new ReadError("invalid_response");
    values.push(...result);
  }
  return values;
}
async function readSequentially(rpc, calls, block) {
  const values = [];
  for (const call of calls) values.push(await rpc.call(call.address, call.abi, call.functionName, call.args ?? [], block));
  return values;
}
const read = (address, abi, functionName, args = []) => ({ address, abi, functionName, args });
export async function verifyBagsDeployment(rpc, block) {
  for (const profile of [BAGS, BAGS_FACTORY_IMPL, BAGS_BEACON, BAGS_FEE_IMPL, BAGS_HOOK]) await rpc.verify(profile, block);
  const slot = await rpc.send("eth_getStorageAt", [BAGS.address, IMPLEMENTATION_SLOT, block]);
  if (!/^0x0{24}[\da-f]{40}$/i.test(slot) || !same(`0x${slot.slice(-40)}`, BAGS_FACTORY_IMPL.address)) throw new ReadError("contract_changed");
  const [implementation, beacon, hook] = await readMany(rpc, [
    read(BAGS_BEACON.address, bagsBeaconAbi, "implementation"),
    read(BAGS.address, bagsFactoryAbi, "feeShareBeacon"),
    read(BAGS.address, bagsFactoryAbi, "hook"),
  ], block);
  if (!same(implementation, BAGS_FEE_IMPL.address) || !same(beacon, BAGS_BEACON.address) || !same(hook, BAGS_HOOK.address))
    throw new ReadError("contract_changed");
}
export async function bagsPosition(rpc, token, expectedFee, block) {
  const [position] = await factoryPositions(rpc, [{ token, fee: expectedFee }], block);
  const identity = await readMany(rpc, identityReads(position.fee), block);
  return checkedPosition(position, identity);
}
async function factoryPositions(rpc, hints, block) {
  if (!Array.isArray(hints) || hints.some((entry) => !nonzeroAddress(entry?.token) ||
    (entry.fee !== undefined && !nonzeroAddress(entry.fee)))) throw new ReadError("invalid_request");
  const unique = [...new Map(hints.map((entry) => [entry.token.toLowerCase(), entry])).values()];
  if (unique.length !== hints.length) throw new ReadError("invalid_request");
  const mapped = await readMany(rpc, hints.flatMap(({ token }) => [
    read(BAGS.address, bagsFactoryAbi, "feeShareForToken", [token]),
    read(BAGS.address, bagsFactoryAbi, "curveForToken", [token]),
  ]), block);
  const positions = hints.map((entry, index) => {
    const [fee, curve] = mapped.slice(index * 2, index * 2 + 2);
    if (!nonzeroAddress(fee) || !nonzeroAddress(curve) || (entry.fee && !same(entry.fee, fee))) throw new ReadError("contract_changed");
    return { token: entry.token.toLowerCase(), fee: fee.toLowerCase(), curve: curve.toLowerCase() };
  });
  for (const fee of new Set(positions.map((position) => position.fee))) await rpc.verify({ address: fee, hash: BAGS_FEE_PROXY_HASH }, block);
  return positions;
}
function identityReads(fee) {
  return ["bondingCurve", "WETH", "hook", "poolId"].map((name) => read(fee, bagsFeeAbi, name));
}
function checkedPosition(position, [curve, currency, hook, pool]) {
  if (!same(curve, position.curve) || !same(currency, WETH) || !same(hook, BAGS_HOOK.address)) throw new ReadError("contract_changed");
  if (!/^0x[\da-f]{64}$/i.test(pool)) throw new ReadError("invalid_response");
  return { token: position.token, fee: position.fee, pool };
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
  return (await bagsIndexedBalances(rpc, owner, [{ token, fee: expectedFee }], snapshot))[0];
}
export async function bagsIndexedBalances(rpc, owner, hints, snapshot) {
  if (!nonzeroAddress(owner)) throw new ReadError("invalid_address");
  const block = toHex(snapshot.number), positions = await factoryPositions(rpc, hints, block);
  const readings = await readMany(rpc, positions.flatMap(({ fee }) => [
    ...identityReads(fee),
    read(fee, bagsFeeAbi, "claimable", [owner]),
    read(fee, bagsFeeAbi, "claimerBps", [owner]),
    read(fee, bagsFeeAbi, "PARTNER"),
  ]), block);
  // Authenticate the entire batch before any sweep preview. An index cannot
  // redirect a preview to an unrelated contract, even when its other hints match.
  const eligible = positions.map((candidate, index) => {
    const values = readings.slice(index * 7, index * 7 + 7), position = checkedPosition(candidate, values);
    const [notified, bps, partner] = values.slice(4);
    if (typeof notified !== "bigint" || notified < 0n || !["bigint", "number"].includes(typeof bps) ||
      !Number.isSafeInteger(Number(bps)) || Number(bps) < 0 || Number(bps) > 10000 ||
      typeof partner !== "string" || !isAddress(partner, { strict: false })) throw new ReadError("invalid_response");
    // Removed recipients can still withdraw their previously credited balance.
    return { position, notified, allowed: notified > 0n || Number(bps) > 0 || same(partner, owner) };
  });
  const rows = [];
  // Each preview remains an independent atomic sweep + ledger read. Combining
  // previews could change a later candidate's simulated balance when pools overlap.
  for (const { position, notified, allowed } of eligible)
    rows.push(allowed ? await balanceForPosition(rpc, owner, position, snapshot, notified) : null);
  return rows;
}
async function balanceForPosition(rpc, owner, position, snapshot, notified) {
  const block = toHex(snapshot.number);
  await rpc.prefetchCurrencies?.([WETH],block);
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

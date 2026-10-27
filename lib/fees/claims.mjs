import { decodeEventLog, decodeFunctionResult, parseAbi, toHex } from "viem";
import { Rpc } from "./rpc.mjs";
import { open, seal } from "./cursor.mjs";
import { claimPlan, amount } from "./claim-plan.mjs";
import { O1, LONG, LONG_HOOK, PONS, PONS_V1, BAGS, BANKR_HOOK, WETH } from "./catalog.mjs";
import { o1Legacy, o1Current, ponsEscrow, ponsV1Abi, longAbi, bagsFeeAbi } from "./abi.mjs";
import { verifyBagsDeployment, bagsBalance, bagsPosition } from "./bags.mjs";
import { longPool, longBalance, ponsV1Balance } from "./engine.mjs";
import { clearDopplerState } from "./doppler-balances.mjs";
import { normalizeAddress, same, NATIVE, ReadError, CHAIN } from "./model.mjs";
const transferAbi = parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
const profiles = [...O1, LONG, PONS, PONS_V1, BAGS, BANKR_HOOK];
const rpcFor = (options) => options.createRpc?.() ?? new Rpc(options.url ?? "https://rpc.mainnet.chain.robinhood.com", options.fetcher);
async function freshPayouts(rpc, row, address, snapshot) {
  // A claim review always starts with fresh contract state, even when a test or
  // embedding caller supplies a reused transport object at the same block.
  clearDopplerState(rpc);
  const target = profiles.find((candidate) => candidate.id === row.target), block = toHex(snapshot.number);
  if (!target) throw new ReadError("invalid_request");
  if (target.id === BAGS.id) {
    await verifyBagsDeployment(rpc, block);
    return [await bagsBalance(rpc, address, row.token, row.position, snapshot)];
  }
  await rpc.verify(target, block);
  if (target.kind === "o1" || target.id === PONS.id) {
    const raw = target.kind === "o1"
      ? await rpc.call(target.address, o1Current, "owed", [address, row.currency], block)
      : await rpc.call(target.address, ponsEscrow, same(row.currency, NATIVE) ? "balanceOf" : "balanceOfToken",
        same(row.currency, NATIVE) ? [address] : [address, row.currency], block);
    return [{ ...row, ...(await rpc.currency(row.currency, block)), raw: raw.toString() }];
  }
  const state = { address, source: row.source, feeTarget: target.id, snapshot, seen: [] }, rows = [], warnings = new Set();
  if ([LONG.id, BANKR_HOOK.id].includes(target.id)) {
    await rpc.verify(row.source === "bankr" ? LONG : LONG_HOOK, block);
    const pool = await longPool(rpc, row.position, row.token, block, row.source);
    if (!pool || pool.id !== row.position) throw new ReadError("contract_changed");
    await longBalance(rpc, state, pool, rows, warnings);
  } else {
    const launch = await rpc.call(PONS_V1.address, ponsV1Abi, "getLaunchedToken", [row.token], block);
    const redirect = await rpc.call(PONS_V1.address, ponsV1Abi, "feeRedirects", [row.token], block);
    if (!launch.exists || !same(launch.token, row.token) || !same(same(redirect, NATIVE) ? launch.deployer : redirect, address))
      throw new ReadError("wrong_account");
    await ponsV1Balance(rpc, state, row.token, rows, warnings);
    const expected = [launch.token, launch.pairedToken].map((currency) => currency.toLowerCase());
    if (rows.some((payout) => !expected.includes(payout.currency.toLowerCase()))) throw new ReadError("contract_changed");
  }
  if (warnings.has("v1_preview_unavailable")) throw new ReadError("read_failed");
  return rows;
}
export async function prepareClaim(input, options = {}) {
  const address = normalizeAddress(input.address);
  const handle = await open(input.claimHandle, address, "claim", options.secret);
  const originalTarget = profiles.find((profile) => profile.id === handle.row?.target);
  if (!originalTarget || handle.row.kind !== "available") throw new ReadError("invalid_request");
  const rpc = rpcFor(options), snapshot = await rpc.snapshot(0);
  const payouts = await freshPayouts(rpc, handle.row, address, snapshot);
  const clicked = payouts.find((payout) => same(payout.currency, handle.row.currency));
  if (!clicked || !amount(clicked.raw) || BigInt(clicked.raw) === 0n) throw new ReadError("nothing_to_claim");
  const plan = claimPlan(clicked, address, payouts);
  if (originalTarget.id !== BAGS.id && originalTarget.address !== plan.target) throw new ReadError("contract_changed");
  const transaction = { from: address, to: plan.target, data: plan.data, value: "0x0" }, block = toHex(snapshot.number);
  const simulated = await rpc.send("eth_call", [transaction, block]);
  if (!/^0x(?:[\da-f]{2})*$/i.test(simulated)) throw new ReadError("invalid_response");
  if (plan.targetId === BAGS.id && simulated !== "0x") throw new ReadError("invalid_response");
  if (plan.targetId === PONS.id && BigInt(simulated) !== BigInt(clicked.raw)) throw new ReadError("invalid_response");
  if ([LONG.id, BANKR_HOOK.id, PONS_V1.id].includes(plan.targetId)) {
    try { decodeFunctionResult({ abi: plan.targetId === PONS_V1.id ? ponsV1Abi : longAbi, functionName: "collectFees", data: simulated }); }
    catch { throw new ReadError("read_failed"); }
  }
  const estimate = await rpc.send("eth_estimateGas", [transaction, block]);
  if (!/^0x[\da-f]+$/i.test(estimate)) throw new ReadError("invalid_response");
  const gas = (BigInt(estimate) * 120n + 99n) / 100n;
  if (gas < 21000n || gas > 3000000n) throw new ReadError("gas_limit");
  const quote = { ...plan, gas: toHex(gas), expiresAt: Date.now() + 90000 };
  return { ...quote, authorization: await seal({ version: 1, address, source: "claim-quote", quote }, options.secret) };
}
export function receiptPayouts(receipt, quote) {
  const matches = [], abi = quote.targetId === BAGS.id ? bagsFeeAbi : quote.targetId === PONS.id ? ponsEscrow : quote.targetId === PONS_V1.id ? ponsV1Abi
    : [LONG.id, BANKR_HOOK.id].includes(quote.targetId) ? longAbi : O1.find((target) => target.id === quote.targetId)?.version === "legacy" ? o1Legacy : o1Current;
  if (!Array.isArray(receipt.logs) || receipt.logs.length > 2048) throw new ReadError("invalid_response");
  const push = (log, currency, raw) => {
    const payout = quote.payouts.find((entry) => same(entry.currency, currency));
    if (payout && raw > 0n) matches.push({ ...payout, id: `${receipt.blockHash}:${Number(BigInt(log.logIndex))}:${currency.toLowerCase()}`,
      source: quote.source, target: quote.targetId, raw: raw.toString(), tx: receipt.transactionHash,
      block: Number(BigInt(receipt.blockNumber)), destination: quote.address });
  };
  for (const log of receipt.logs) {
    if (!same(log.address, quote.target)) continue;
    if (log.removed === true || !/^0x[\da-f]+$/i.test(log.logIndex) || !same(log.blockHash, receipt.blockHash) || !same(log.transactionHash, receipt.transactionHash))
      throw new ReadError("invalid_response");
    let event;
    try { event = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true }); } catch { continue; }
    const args = event.args;
    if (quote.targetId === BAGS.id && event.eventName === "Claimed" && same(args.user, quote.address) && args.unwrap === false) {
      let received = 0n;
      for (const transfer of receipt.logs) {
        if (!same(transfer.address, WETH) || transfer.removed === true || !same(transfer.blockHash, receipt.blockHash) ||
          !same(transfer.transactionHash, receipt.transactionHash)) continue;
        try {
          const decoded = decodeEventLog({ abi: transferAbi, data: transfer.data, topics: transfer.topics, strict: true });
          if (same(decoded.args.from, quote.target) && same(decoded.args.to, quote.address)) received += decoded.args.value;
        } catch {}
      }
      if (args.amount > 0n && received === args.amount) push(log, WETH, args.amount);
    }
    if (quote.source === "o1" && event.eventName === "Claimed" && same(args.recipient, quote.address) &&
      (!args.destination || same(args.destination, quote.address))) push(log, args.currency, args.amount);
    if (quote.targetId === PONS.id && same(args.recipient, quote.address)) {
      const currency = event.eventName === "Claimed" ? NATIVE : event.eventName === "ClaimedToken" ? args.token : null;
      if (currency && args.amount === BigInt(quote.row.raw)) push(log, currency, args.amount);
    }
    if ([LONG.id, BANKR_HOOK.id].includes(quote.targetId) && event.eventName === "Release" && same(args.beneficiary, quote.address) && args.poolId === quote.position) {
      push(log, quote.payouts[0].currency, args.fees0); push(log, quote.payouts[1].currency, args.fees1);
    }
    if (quote.targetId === PONS_V1.id && event.eventName === "FeesClaimed" && same(args.token, quote.token) && same(args.caller, quote.address)) {
      for (const [currency, raw] of [[args.token0, args.recipientAmount0], [args.token1, args.recipientAmount1]]) {
        let received = 0n;
        for (const transfer of receipt.logs) {
          if (!same(transfer.address, currency)) continue;
          try {
            const decoded = decodeEventLog({ abi: transferAbi, data: transfer.data, topics: transfer.topics, strict: true });
            if (same(decoded.args.from, quote.target) && same(decoded.args.to, quote.address)) received += decoded.args.value;
          } catch {}
        }
        if (raw > 0n && received >= raw) push(log, currency, raw);
      }
    }
  }
  return matches;
}
export async function confirmClaim(input, options = {}) {
  const address = normalizeAddress(input.address);
  if (!/^0x[\da-f]{64}$/i.test(input.hash)) throw new ReadError("invalid_request");
  const { quote } = await open(input.authorization, address, "claim-quote", options.secret);
  const rpc = rpcFor(options);
  if (BigInt(await rpc.send("eth_chainId")) !== BigInt(CHAIN)) throw new ReadError("wrong_chain");
  const receipt = await rpc.send("eth_getTransactionReceipt", [input.hash]);
  if (!receipt) return { status: "pending" };
  if (!same(receipt.transactionHash, input.hash) || !same(receipt.from, address) || !same(receipt.to, quote.target) ||
    !["0x0", "0x1"].includes(receipt.status) || !/^0x[\da-f]{64}$/i.test(receipt.blockHash) || !/^0x[\da-f]+$/i.test(receipt.blockNumber))
    throw new ReadError("invalid_response");
  const transaction = await rpc.send("eth_getTransactionByHash", [input.hash]);
  if (!transaction || !same(transaction.hash, input.hash) || !same(transaction.from, address) || !same(transaction.to, quote.target) ||
    transaction.input !== quote.data || BigInt(transaction.value) !== 0n || !same(transaction.blockHash, receipt.blockHash)) throw new ReadError("invalid_response");
  const canonical = await rpc.send("eth_getBlockByNumber", [receipt.blockNumber, false]);
  if (!same(canonical?.hash, receipt.blockHash)) return { status: "pending" };
  await rpc.verify(profiles.find((profile) => profile.id === quote.targetId), receipt.blockNumber);
  if (quote.targetId === BAGS.id) {
    await verifyBagsDeployment(rpc, receipt.blockNumber);
    await bagsPosition(rpc, quote.token, quote.target, receipt.blockNumber);
  }
  const head = BigInt(await rpc.send("eth_blockNumber")), mined = BigInt(receipt.blockNumber);
  const confirmations = head >= mined ? Number(head - mined) : 0;
  if (confirmations < 20) return { status: "confirming", confirmations, required: 20 };
  const snapshot = await rpc.snapshot();
  if (snapshot.number < Number(mined)) return { status: "confirming", confirmations: 19, required: 20 };
  const history = receipt.status === "0x1" ? receiptPayouts(receipt, quote) : [];
  return { status: receipt.status === "0x0" ? "reverted" : history.length ? "confirmed" : "no_payout", history,
    snapshotCursor: await seal({ version: 1, address, source: "snapshot", snapshot }, options.secret) };
}

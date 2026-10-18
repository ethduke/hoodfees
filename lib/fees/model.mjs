import { isAddress, formatUnits, keccak256, encodeAbiParameters } from "viem";
export const NATIVE = `0x${"0".repeat(40)}`;
export const CHAIN = 4663;
export class ReadError extends Error {
  constructor(code = "provider_unavailable") {
    super(code);
    this.code = code;
  }
}
export function normalizeAddress(input) {
  const value = typeof input === "string" ? input.trim() : "";
  if (!isAddress(value) || value.toLowerCase() === NATIVE) throw new ReadError("invalid_address");
  return value.toLowerCase();
}
export function compactAmount(raw, decimals) {
  const value = formatUnits(BigInt(raw), decimals);
  const [whole, fraction = ""] = value.split(".");
  const trimmed = fraction.slice(0, whole === "0" ? 6 : 4).replace(/0+$/, "");
  if (whole === "0" && !trimmed && /[1-9]/.test(fraction)) return "<0.000001";
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return trimmed ? `${grouped}.${trimmed}` : grouped;
}
// Adapted from fungun/apps/api/src/fee-contracts.mjs. Never use the pool-wide
// collectFees return as the beneficiary payout: apply the caller's checkpoint/share.
export function beneficiaryFees(cumulative, collected, last, shares) {
  const max = (1n << 256n) - 1n;
  if (
    [cumulative, collected, last, shares].some((v) => typeof v !== "bigint" || v < 0n || v > max) ||
    shares > 10n ** 18n ||
    cumulative + collected > max ||
    last > cumulative + collected
  )
    throw new ReadError("invalid_response");
  const product = (cumulative + collected - last) * shares;
  if (product > max) throw new ReadError("invalid_response");
  return product / 10n ** 18n;
}
export function poolId(key) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}
export const same = (a, b) =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
export const topicAddress = (address) => `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
export function progress(streams, snapshot) {
  const total = streams.reduce((n, s) => n + Math.max(0, (s.end ?? snapshot) - s.start + 1), 0);
  const left = streams.reduce((n, s) => n + Math.max(0, s.next - s.start + 1), 0);
  return total ? Math.min(100, Math.max(0, (100 * (total - left)) / total)) : 100;
}
export function mergeRows(rows) {
  return [...new Map(rows.map((r) => [r.id, r])).values()];
}
// Bankr and Long use the same locked-pool ledger and emit the same identities.
// Prefer Bankr's explicit attribution without counting the same fee twice.
export function uniqueFeeRows(rows) {
  const map = new Map();
  for (const row of rows) {
    const prior = map.get(row.id);
    if (!prior || row.source === "bankr" || prior.source !== "bankr") map.set(row.id, row);
  }
  return [...map.values()];
}
export function totals(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = row.currency.toLowerCase();
    const prior = map.get(key) ?? { ...row, id: key, raw: "0" };
    if (
      prior.metadataVerified !== false &&
      row.metadataVerified !== false &&
      prior.decimals !== row.decimals
    )
      throw new ReadError("invalid_response");
    if (prior.metadataVerified === false && row.metadataVerified !== false) {
      prior.decimals = row.decimals;
      prior.symbol = row.symbol;
      prior.metadataVerified = true;
    }
    prior.raw = (BigInt(prior.raw) + BigInt(row.raw)).toString();
    map.set(key, prior);
  }
  return [...map.values()];
}

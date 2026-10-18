import { ReadError } from "./model.mjs";
const encoder = new TextEncoder();
let transient;
function keyBytes(secret) {
  if (secret && secret.length >= 32) return encoder.encode(secret);
  transient ??= crypto.getRandomValues(new Uint8Array(32));
  return transient;
}
function base64(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
function decode(value) {
  try {
    return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
      c.charCodeAt(0),
    );
  } catch {
    throw new ReadError("cursor_expired");
  }
}
async function hmac(secret) {
  return crypto.subtle.importKey(
    "raw",
    keyBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
async function sign(state, secret) {
  const payload = encoder.encode(JSON.stringify(state));
  if (payload.length > 60000) throw new ReadError("position_limit");
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await hmac(secret), payload));
  return `${base64(payload)}.${base64(signature)}`;
}
export function seal(state, secret) {
  return sign({ ...state, expires: Date.now() + 86400000 }, secret);
}
export function sealProgress(state, secret) {
  return sign({ ...state, source: "scan-progress", scanSource: state.source, expires: undefined }, secret);
}
async function verified(cursor, address, secret) {
  if (typeof cursor !== "string" || cursor.length > 85000 || !/^[\w-]+\.[\w-]+$/.test(cursor))
    throw new ReadError("cursor_expired");
  const [p, s] = cursor.split(".");
  const payload = decode(p);
  if (!(await crypto.subtle.verify("HMAC", await hmac(secret), decode(s), payload)))
    throw new ReadError("cursor_expired");
  let state;
  try {
    state = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    throw new ReadError("cursor_expired");
  }
  if (
    state.address !== address ||
    state.version !== 1
  )
    throw new ReadError("cursor_expired");
  return state;
}
export async function open(cursor, address, source, secret) {
  const state = await verified(cursor, address, secret);
  if (state.source !== source || !Number.isFinite(state.expires) || state.expires < Date.now())
    throw new ReadError("cursor_expired");
  return state;
}
// Expiry is ignored only for read-only scan progress, never claim permissions.
// Legacy scan/snapshot signatures can migrate without trusting a client block number.
export async function openProgress(cursor, address, source, secret) {
  if (!["o1", "bags", "bankr", "long", "pons"].includes(source)) throw new ReadError("cursor_expired");
  const state = await verified(cursor, address, secret);
  if (state.source === "scan-progress" && state.scanSource === source)
    return { ...state, source };
  if (state.source === source && Array.isArray(state.streams)) return state;
  if (state.source === "snapshot") return { ...state, source, legacySnapshot: true };
  throw new ReadError("cursor_expired");
}

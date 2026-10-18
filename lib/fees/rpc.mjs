import {
  encodeFunctionData,
  decodeFunctionResult,
  keccak256,
  toHex,
  toFunctionSelector,
  parseAbi,
} from "viem";
import { ReadError, CHAIN, NATIVE } from "./model.mjs";
import { MULTICALL } from "./catalog.mjs";
const multicallAbi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);
const allowed = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getLogs",
  "eth_call",
  "eth_estimateGas",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
]);
const pins = new Map();
const metadata = new Map();
let running = 0;
let tokens = 400;
let refillAt = Date.now();
export async function boundedJson(response, max = 2 * 1024 * 1024, readLogError = false) {
  if (!response.ok && !(readLogError && response.status === 400)) {
    await response.body?.cancel();
    throw new ReadError(response.status === 429 ? "rate_limited" : response.status === 413 ? "response_limit" : "provider_unavailable");
  }
  if (Number(response.headers.get("content-length")) > max) {
    await response.body?.cancel();
    throw new ReadError("response_limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ReadError();
  let bytes = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > max) throw new ReadError("response_limit");
      chunks.push(value);
    }
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const c of chunks) {
      data.set(c, offset);
      offset += c.length;
    }
    try {
      return JSON.parse(new TextDecoder().decode(data));
    } catch {
      throw new ReadError("invalid_response");
    }
  } finally {
    await reader.cancel();
  }
}
export class Rpc {
  constructor(url, fetcher = fetch) {
    this.url = url;
    this.fetcher = fetcher;
    this.count = 0;
  }
  async send(method, params = []) {
    if (!allowed.has(method)) throw new ReadError("invalid_request");
    if (++this.count > 100) throw new ReadError("page_limit");
    const now = Date.now();
    tokens = Math.min(400, tokens + (now - refillAt) / 150);
    refillAt = now;
    if (tokens < 1 || running >= 8) throw new ReadError("rate_limited");
    tokens--;
    running++;
    try {
      const response = await this.fetcher.call(globalThis, this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        redirect: "manual",
        signal: AbortSignal.timeout(12000),
      });
      const body = await boundedJson(response, (method === "eth_getLogs" ? 4 : 2) * 1024 * 1024, method === "eth_getLogs");
      if (body?.jsonrpc !== "2.0" || body.id !== 1) throw new ReadError("invalid_response");
      // Never expose provider messages: they can embed URLs, requests or keys.
      if (body.error) {
        if (
          method === "eth_call" &&
          typeof body.error.data === "string" &&
          body.error.data.toLowerCase() === toFunctionSelector("NoFeesToCollect()")
        )
          throw new ReadError("nothing_to_collect");
        if (method === "eth_getLogs" &&
          (body.error.code === -32005 || /(?:block|result|response|log).*(?:limit|range|large|exceed)|too many|range.*(?:limit|exceed)/i.test(String(body.error.message))))
          throw new ReadError("log_range");
        throw new ReadError("read_failed");
      }
      if (!response.ok) throw new ReadError("provider_unavailable");
      if (!Object.hasOwn(body, "result")) throw new ReadError("invalid_response");
      return body.result;
    } catch (error) {
      throw error instanceof ReadError ? error : new ReadError();
    } finally {
      running--;
    }
  }
  async call(address, abi, functionName, args = [], block = "latest", from) {
    const data = encodeFunctionData({ abi, functionName, args });
    const result = await this.send("eth_call", [
      { to: address, data, ...(from ? { from } : {}) },
      block,
    ]);
    try {
      return decodeFunctionResult({ abi, functionName, data: result });
    } catch {
      throw new ReadError("read_failed");
    }
  }
  async calls(calls, block) {
    if (!calls.length || calls.length > 512) throw new ReadError("invalid_request");
    await this.verify(MULTICALL, block);
    const results = await this.call(MULTICALL.address, multicallAbi, "aggregate3", [calls.map((call) => ({
      target: call.address, allowFailure: false,
      callData: encodeFunctionData({abi:call.abi, functionName:call.functionName, args:call.args}),
    }))], block);
    if (!Array.isArray(results) || results.length !== calls.length || results.some((r) => !r.success))
      throw new ReadError("invalid_response");
    try {
      return results.map((result, i) => decodeFunctionResult({
        abi:calls[i].abi, functionName:calls[i].functionName, data:result.returnData,
      }));
    } catch { throw new ReadError("read_failed"); }
  }
  async snapshot(confirmations = 20) {
    if (BigInt(await this.send("eth_chainId")) !== BigInt(CHAIN))
      throw new ReadError("wrong_chain");
    const head = BigInt(await this.send("eth_blockNumber"));
    const number = Number(head > BigInt(confirmations) ? head - BigInt(confirmations) : 0n);
    const block = await this.send("eth_getBlockByNumber", [toHex(number), false]);
    if (!/^0x[\da-f]{64}$/i.test(block?.hash)) throw new ReadError("invalid_response");
    return { number, hash: block.hash, timestamp: Number(BigInt(block.timestamp)) };
  }
  async verify(target, block) {
    const key = `${target.address}:${target.hash}:${block}`;
    if (pins.has(key)) return;
    const code = await this.send("eth_getCode", [target.address, block]);
    if (!/^0x(?:[\da-f]{2})+$/i.test(code) || keccak256(code) !== target.hash)
      throw new ReadError("contract_changed");
    pins.set(key, true);
    if (pins.size > 128) pins.delete(pins.keys().next().value);
  }
  async currency(address, block) {
    if (address.toLowerCase() === NATIVE)
      return { currency: NATIVE, symbol: "ETH", decimals: 18, metadataVerified: true };
    const key = `${address.toLowerCase()}:${block}`;
    if (metadata.has(key)) return metadata.get(key);
    const abi = [
      {
        type: "function",
        name: "symbol",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "string" }],
      },
      {
        type: "function",
        name: "decimals",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint8" }],
      },
    ];
    try {
      const decimals = Number(await this.call(address, abi, "decimals", [], block));
      const rawSymbol = await this.call(address, abi, "symbol", [], block).catch(() => "TOKEN");
      const symbol =
        typeof rawSymbol === "string" && /^[A-Za-z0-9._-]{1,24}$/.test(rawSymbol)
          ? rawSymbol
          : "TOKEN";
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new ReadError();
      const value = { currency: address.toLowerCase(), symbol, decimals, metadataVerified: true };
      metadata.set(key, value);
      if (metadata.size > 256) metadata.delete(metadata.keys().next().value);
      return value;
    } catch {
      return {
        currency: address.toLowerCase(),
        symbol: "TOKEN",
        decimals: 0,
        metadataVerified: false,
      };
    }
  }
}

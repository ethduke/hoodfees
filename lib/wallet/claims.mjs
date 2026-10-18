import { keccak256, encodeFunctionData, decodeFunctionResult } from "viem";
import { validateQuote } from "../fees/claim-plan.mjs";
import { O1, LONG, LONG_HOOK, PONS, PONS_V1, BAGS, BANKR_HOOK } from "../fees/catalog.mjs";
import { verifyBagsDeployment, bagsPosition } from "../fees/bags.mjs";
import { ponsEscrow, ponsV1Abi, longAbi, bankrHookAbi } from "../fees/abi.mjs";
import { same, NATIVE, ReadError, poolId } from "../fees/model.mjs";
const activePhases = new Set(["preparing", "review", "wallet", "submitted", "confirming", "uncertain"]);
const safeCodes = new Set(["invalid_request", "invalid_response", "cursor_expired", "wrong_chain", "contract_changed", "wrong_account", "nothing_to_claim", "gas_limit", "quote_expired", "rate_limited", "provider_unavailable", "read_failed", "rejected", "cancelled"]);
export class ClaimController {
  constructor({ getSession, notify, refresh, fetcher = fetch, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, hashCode = keccak256 }) {
    Object.assign(this, { getSession, notify, refresh, fetcher, delay, now, hashCode });
    this.state = { phase: "idle" };
    this.operation = 0;
    this.disposed = false;
    this.watching = false;
  }
  busy() { return activePhases.has(this.state.phase); }
  publish(patch) { this.state = { ...this.state, ...patch }; if (!this.disposed) this.notify(this.state); }
  current(token, session) {
    if (this.disposed || token !== this.operation || this.getSession() !== session) throw new ReadError("wrong_account");
  }
  async api(kind, body) {
    try {
      const response = await this.fetcher.call(globalThis, `/api/claim/${kind === "claim-prepare" ? "prepare" : "confirm"}`, {
        method: "POST", credentials: "omit", cache: "no-store", headers: { "content-type": "application/json", "x-hood-intent": kind },
        body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
      });
      const data = await response.json();
      if (!response.ok) throw new ReadError(safeCodes.has(data?.error) ? data.error : "provider_unavailable");
      return data;
    } catch (error) { throw error instanceof ReadError ? error : new ReadError("provider_unavailable"); }
  }
  async begin(row) {
    if (this.busy() || this.disposed) return;
    const session = this.getSession(), token = ++this.operation;
    this.state = { phase: "preparing", row, owner: session?.address }; this.publish({});
    try {
      if (!session || !row.claimHandle) throw new ReadError("wrong_account");
      const input = await this.api("claim-prepare", { address: session.address, claimHandle: row.claimHandle });
      this.current(token, session);
      const quote = validateQuote(input, row, session.address, this.now());
      this.bound = session;
      this.publish({ phase: "review", quote });
    } catch (error) {
      if (token === this.operation) this.publish({ phase: "error", error: safeCodes.has(error?.code) ? error.code : "provider_unavailable" });
    }
  }
  cancel() {
    if (!["preparing", "review", "error"].includes(this.state.phase)) return;
    this.operation++;
    this.state = { phase: "idle" }; this.publish({});
  }
  contextChanged() { if (["preparing", "review"].includes(this.state.phase)) this.cancel(); }
  async send() {
    if (this.state.phase !== "review" || this.disposed) return;
    const token = this.operation, session = this.bound;
    let dispatched = false;
    this.publish({ phase: "preparing", error: undefined });
    try {
      const quote = validateQuote(this.state.quote, this.state.row, session.address, this.now());
      const read = async (method, params = []) => {
        this.current(token, session);
        const value = await session.provider.request({ method, params });
        this.current(token, session); return value;
      };
      const identity = async () => {
        const accounts = await read("eth_accounts");
        if (!Array.isArray(accounts) || !same(accounts[0], quote.address)) throw new ReadError("wrong_account");
        if (BigInt(await read("eth_chainId")) !== 4663n) throw new ReadError("wrong_chain");
      };
      this.current(token, session);
      const accounts = await read("eth_accounts");
      if (!Array.isArray(accounts) || !same(accounts[0], quote.address)) throw new ReadError("wrong_account");
      if (BigInt(await read("eth_chainId")) !== 4663n)
        await read("wallet_switchEthereumChain", [{ chainId: "0x1237" }]);
      await identity();
      const target = [...O1, LONG, PONS, PONS_V1, BAGS, BANKR_HOOK].find((profile) => profile.id === quote.targetId);
      const verify = async (profile, block) => {
        const code = await read("eth_getCode", [profile.address, block]);
        if (typeof code !== "string" || !/^0x(?:[\da-f]{2})+$/i.test(code) || this.hashCode(code) !== profile.hash) throw new ReadError("contract_changed");
      };
      if (quote.targetId === BAGS.id) {
        const reader = { send: read, verify, call: async (address, abi, functionName, args, block) =>
          decodeFunctionResult({ abi, functionName, data: await read("eth_call", [{ to: address, data: encodeFunctionData({ abi, functionName, args }) }, block]) }) };
        await verifyBagsDeployment(reader, "pending");
        await bagsPosition(reader, quote.token, quote.target, "pending");
      }
      for (const profile of quote.targetId === BAGS.id ? [] : [target,
        ...(quote.targetId === LONG.id && quote.source !== "bankr" ? [LONG_HOOK] : quote.targetId === BANKR_HOOK.id ? [LONG] : [])]) {
        const code = await read("eth_getCode", [profile.address, "latest"]);
        if (typeof code !== "string" || !/^0x(?:[\da-f]{2})+$/i.test(code) || this.hashCode(code) !== profile.hash) throw new ReadError("contract_changed");
      }
      const call = async (abi, functionName, args) => decodeFunctionResult({ abi, functionName,
        data: await read("eth_call", [{ to: quote.target, data: encodeFunctionData({ abi, functionName, args }) }, "pending"]) });
      if (quote.targetId === PONS_V1.id) {
        const launch = await call(ponsV1Abi, "getLaunchedToken", [quote.token]);
        const redirect = await call(ponsV1Abi, "feeRedirects", [quote.token]);
        if (!launch.exists || !same(launch.token, quote.token) || !same(same(redirect, NATIVE) ? launch.deployer : redirect, quote.address)) throw new ReadError("wrong_account");
      }
      if ([LONG.id, BANKR_HOOK.id].includes(quote.targetId) && await call(longAbi, "getShares", [quote.position, quote.address]) === 0n) throw new ReadError("nothing_to_claim");
      if (quote.source === "bankr") {
        const state = decodeFunctionResult({ abi: longAbi, functionName: "getState", data: await read("eth_call", [{
          to: LONG.address, data: encodeFunctionData({ abi: longAbi, functionName: "getState", args: [quote.token] }),
        }, "pending"]) });
        if (state[4] !== 2 || !same(state[5].hooks, LONG.address) || poolId(state[5]) !== quote.position)
          throw new ReadError("contract_changed");
        if (quote.targetId === BANKR_HOOK.id) {
          if (!same(state[2], BANKR_HOOK.address) || !same(await call(bankrHookAbi, "INITIALIZER", []), LONG.address))
            throw new ReadError("contract_changed");
          const k = await call(longAbi, "getPoolKey", [quote.position]);
          if (poolId({currency0:k[0],currency1:k[1],fee:k[2],tickSpacing:k[3],hooks:k[4]}) !== quote.position)
            throw new ReadError("contract_changed");
        }
      }
      const transaction = { from: quote.address, to: quote.target, data: quote.data, value: "0x0", chainId: "0x1237", gas: quote.gas };
      const simulated = await read("eth_call", [{ from: quote.address, to: quote.target, data: quote.data, value: "0x0" }, "pending"]);
      if (!/^0x(?:[\da-f]{2})*$/i.test(simulated)) throw new ReadError("read_failed");
      if (quote.targetId === BAGS.id && simulated !== "0x") throw new ReadError("read_failed");
      if (quote.targetId === PONS.id) {
        const functionName = same(quote.row.currency, NATIVE) ? "claim" : "claimToken";
        const paid = decodeFunctionResult({ abi: ponsEscrow, functionName, data: simulated });
        if (paid !== BigInt(quote.row.raw)) throw new ReadError("read_failed");
      }
      if ([LONG.id, BANKR_HOOK.id, PONS_V1.id].includes(quote.targetId)) decodeFunctionResult({ abi: quote.targetId === PONS_V1.id ? ponsV1Abi : longAbi, functionName: "collectFees", data: simulated });
      await identity();
      if (this.now() >= quote.expiresAt) throw new ReadError("quote_expired");
      this.publish({ phase: "wallet" });
      this.current(token, session);
      dispatched = true;
      const hash = await session.provider.request({ method: "eth_sendTransaction", params: [transaction] });
      if (!/^0x[\da-f]{64}$/i.test(hash)) throw new ReadError("invalid_response");
      this.publish({ phase: "submitted", hash });
      await this.watch();
    } catch (error) {
      const rejected = error?.code === 4001;
      this.publish({ phase: dispatched && !rejected ? "uncertain" : "error", error: rejected ? "rejected" : safeCodes.has(error?.code) ? error.code : "read_failed" });
    }
  }
  async watch() {
    if (this.watching || this.disposed || !this.state.hash || !["submitted", "confirming"].includes(this.state.phase)) return;
    this.watching = true;
    try {
      for (let attempt = 0; attempt < 90 && !this.disposed; attempt++) {
        try {
          const result = await this.api("claim-confirm", { address: this.state.quote.address, authorization: this.state.quote.authorization, hash: this.state.hash });
          if (this.disposed) return;
          if (["confirmed", "reverted", "no_payout"].includes(result.status)) {
            if (!Array.isArray(result.history) || typeof result.snapshotCursor !== "string") throw new ReadError("invalid_response");
            this.publish({ phase: result.status, error: undefined });
            if (same(this.getSession()?.address, this.state.quote.address)) this.refresh(result, this.state.quote.address);
            return;
          }
          if (!["pending", "confirming"].includes(result.status)) throw new ReadError("invalid_response");
          this.publish({ phase: result.status === "confirming" ? "confirming" : "submitted", confirmations: result.confirmations ?? 0, error: undefined });
        } catch (error) {
          if (this.disposed) return;
          this.publish({ error: safeCodes.has(error?.code) ? error.code : "provider_unavailable" });
        }
        await this.delay(Math.min(30000, 4000 + attempt * 1000));
      }
      if (!this.disposed) this.publish({ error: "confirmation_pending" });
    } finally { this.watching = false; }
  }
  dispose() { this.disposed = true; this.operation++; this.notify = () => {}; this.refresh = () => {}; }
}

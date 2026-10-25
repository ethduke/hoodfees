"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  ArrowRight,
  Search,
  Wallet,
  History,
  Check,
  ShieldCheck,
  ChevronDown,
  Pause,
  X,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { ClaimController } from "../lib/wallet/claims.mjs";
import { claimKey } from "../lib/fees/claim-plan.mjs";
import { WalletAdapter } from "../lib/wallet/adapter.mjs";
import { ScanCache } from "../lib/wallet/scan-cache.mjs";
import { runScanQueue, ScanError } from "../lib/wallet/scan-queue.mjs";
import { SOURCE_INFO } from "../lib/fees/catalog.mjs";
import { compactAmount, mergeRows, uniqueFeeRows, totals } from "../lib/fees/model.mjs";
type ScanScope = "balances" | "history";
type WalletOption = { id: string; name: string; rabby: boolean; provider: { request: (input: { method: string }) => Promise<unknown> } };
type WalletEvent =
  | { type: "providers"; options: WalletOption[] }
  | { type: "connecting"; name: string }
  | { type: "connected"; address: string; name: string; switched: boolean }
  | { type: "disconnected" }
  | { type: "error"; code: string };
const walletErrors: Record<string, string> = {
  rejected: "Connection cancelled. Connect again when you’re ready.",
  pending: "A wallet request is already open. Approve or dismiss it in your wallet, then try again.",
  unavailable: "The wallet could not connect. Unlock it and try again.",
  invalid_account: "The wallet returned an invalid account. Choose another account and reconnect.",
};
type FeeRow = {
  id: string;
  source: string;
  target: string;
  currency: string;
  symbol: string;
  decimals: number;
  metadataVerified: boolean;
  raw: string;
  kind?: string;
  token?: string;
  tx?: string;
  block?: number;
  destination?: string;
  earmarkedRaw?: string;
  position?: string;
  claimHandle?: string;
  sweptRaw?: string;
};
type ClaimState = {
  phase: string; error?: string; row?: FeeRow; owner?: string; hash?: string; confirmations?: number;
  quote?: { target: string; address: string; payouts: FeeRow[]; expiresAt: number; gas: string };
};
const claimErrors: Record<string, string> = {
  rejected: "Request cancelled in your wallet. No new claim was approved.",
  nothing_to_claim: "These fees are no longer available. Refresh your balances.",
  wrong_account: "The connected account changed. Reconnect the fee owner and try again.",
  wrong_chain: "Choose Robinhood Chain in your wallet, then try again.",
  contract_changed: "This contract no longer matches its reviewed code. The claim was blocked.",
  cursor_expired: "This fee record expired. Refresh balances before claiming.",
  quote_expired: "The claim review expired. Click Claim again to prepare fresh amounts.",
  gas_limit: "This claim needs more gas than the supported limit. Use the launchpad to review it.",
  read_failed: "The claim or its confirmation could not be verified. Check wallet activity before retrying.",
  provider_unavailable: "The chain provider is unavailable. Try again shortly.",
  rate_limited: "The provider is busy. Confirmation checks retry automatically; preparation can be retried shortly.",
  invalid_response: "The claim response could not be verified.",
  confirmation_pending: "Confirmation is taking longer than expected. Check again; do not submit a duplicate claim.",
};
type Result = {
  checkpoint?: string;
  resetBalances?: boolean;
  updatesComplete?: boolean;
  discovery?: "wallet-index" | "onchain-registry";
  snapshotCursor: string;
  source: string;
  snapshot: { number: number; hash: string; timestamp: number };
  balances: FeeRow[];
  history: FeeRow[];
  warnings: string[];
  coverage: { complete: boolean; percent: number; pending: number; blocksChecked?: number; blocksTotal?: number; indexPages?: number; positionsChecked?: number; positionsTotal?: number };
  cursor: string | null;
};
type SourceState = {
  result?: Result;
  refreshPending?: boolean;
  balances: FeeRow[];
  history: FeeRow[];
  error?: string;
  pages: number;
};
const errors: Record<string, string> = {
  migration_unavailable: "The previous host could not verify this saved checkpoint. Your progress is kept; try refreshing again shortly.",
  invalid_address: "Enter a valid Ethereum wallet address.",
  provider_unavailable:
    "The chain provider is unavailable. Your scan progress is kept; try again shortly.",
  rate_limited: "The provider is busy. Wait a moment, then continue your scan.",
  cursor_expired: "This saved checkpoint could not be verified. Use Reset scan to start again.",
  snapshot_changed: "The chain changed beneath the saved snapshot. Use Reset scan to verify coverage again.",
  contract_changed:
    "A contract no longer matches its reviewed deployment. This source is unavailable.",
  read_failed: "A contract read could not be verified. This source is unknown; try again.",
  wrong_chain: "The provider returned a different network. This source is unavailable.",
  invalid_response: "The provider returned data that could not be verified.",
  log_range:
    "The provider cannot read this historical range. Try a provider with historical log support.",
  response_limit: "This historical page exceeds the provider limit.",
  position_limit: "This wallet exceeds the current scan capacity. The result remains incomplete.",
  page_limit: "This page exceeded its read budget. Continue to retry.",
  index_unavailable: "The launchpad’s wallet index is unavailable. Saved progress is kept; try again shortly.",
};
const warningText: Record<string, string> = {
  bags_index_truncated: "Bags’ wallet index returned an incomplete list. Registry discovery is used to finish supported coverage.",
  bags_index_legacy: "Legacy Bags v1 positions returned by the index are outside this adapter’s reviewed deployments and are excluded.",
  bankr_unreviewed_route: "Some Bankr positions use a hook or manager outside the reviewed deployments. Those fees are excluded.",
  bags_unreviewed_claim: "Some matching claim events are outside the reviewed Bags v2 deployments and were excluded.",
  o1_unreviewed_escrow: "The O1 index returned an escrow outside the reviewed contract set. Its fees are excluded from claims here.",
  migrated_pool: "Migrated Doppler pools are outside this adapter’s coverage.",
  other_doppler_route: "Other integrations on the shared manager were excluded.",
  archive_required:
    "Some pons v1 payout recipients could not be verified historically. History is incomplete; an archive RPC is needed.",
  v1_preview_unavailable: "A pons v1 fee preview failed. Its balance is unknown, not zero.",
  buyback_earmark:
    "pons has fees earmarked for buybacks. A skipped buyback can increase the eventual creator payout.",
};
const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;
function exact(row: FeeRow) {
  return row.metadataVerified
    ? `${compactAmount(row.raw, row.decimals)} ${row.symbol}`
    : `${row.raw} raw units`;
}
const explorer = (type: string, address: string) =>
  `https://robinhoodchain.blockscout.com/${type}/${address}`;
function Brand() {
  return (
    <span className="brand-mark">
      h<span>↗</span>
    </span>
  );
}
function Amount({ row }: { row: FeeRow }) {
  return (
    <span title={`${row.raw} raw units · ${row.currency}`} className="amount">
      {exact(row)}
    </span>
  );
}
export default function Home() {
  const [wallet, setWallet] = useState("");
  const [claimState, setClaimState] = useState<ClaimState>({ phase: "idle" });
  const claims = useRef<ClaimController | null>(null);
  const [walletOptions, setWalletOptions] = useState<WalletOption[]>([]);
  const [walletMenu, setWalletMenu] = useState(false);
  const [progressMenu, setProgressMenu] = useState(false);
  const [progressNotice, setProgressNotice] = useState("");
  const progressFile = useRef<HTMLInputElement>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectionNotice, setConnectionNotice] = useState("Connect your wallet to check available fees. Payout history loads only when opened.");
  const [selected, setSelected] = useState(new Set(SOURCE_INFO.map((s) => s.id))),
    [states, setStates] = useState<Record<string, SourceState>>({});
  const [historyStates, setHistoryStates] = useState<Record<string, SourceState>>({});
  const historyLatest = useRef<Record<string, SourceState>>({});
  const historyStarted = useRef(false);
  const historyNeedsUpdate = useRef(false);
  const cache = useRef<ScanCache | null>(null);
  const cacheAddress = useRef("");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [storageError, setStorageError] = useState(false);
  const [activeTab, setActiveTab] = useState("unclaimed"),
    [running, setRunning] = useState(false),
    [info, setInfo] = useState(false),
    [showZero, setShowZero] = useState(false),
    [filter, setFilter] = useState("all"),
    [notice, setNotice] = useState("");
  const [retrying, setRetrying] = useState<Record<string, string>>({});
  const active = useRef(false),
    generation = useRef(0),
    controller = useRef<AbortController | null>(null),
    latest = useRef(states);
  const connectRef = useRef<HTMLButtonElement>(null);
  const adapter = useRef<WalletAdapter | null>(null);
  const selectedRef = useRef(selected);
  function cancelWork() {
    active.current = false;
    generation.current++;
    controller.current?.abort();
  }
  function stop() {
    cancelWork();
    setRunning(false);
    setRetrying({});
  }
  function connectDefault() {
    adapter.current?.discoverLegacy();
    const preferred = adapter.current?.options.find((option) => option.rabby);
    if (preferred) void adapter.current?.connect(preferred);
    else setWalletMenu(true);
  }
  function exportProgress() {
    try {
      const backup = cache.current!.exportProgress();
      const url = URL.createObjectURL(new Blob([backup.data], {type:"application/json"}));
      const link = document.createElement("a");
      link.href = url; link.download = "hoodfees-progress.json"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setProgressNotice(`${backup.count} saved wallets exported. Keep the file to restore progress at the new address.`);
    } catch { setProgressNotice("Progress could not be exported. Browser storage may be unavailable."); }
  }
  async function importProgress(file?: File) {
    if (!file || claimBusy || running) return;
    try {
      if (file.size > 25_000_000) throw Error();
      const result = cache.current!.importProgress(await file.text());
      setProgressNotice(`${result.imported} saved wallets restored; ${result.kept} newer or matching records kept.`);
      setConnectionNotice("Saved progress restored. Reconnect your wallet to resume its checkpoints.");
      if (wallet) adapter.current?.disconnect();
    } catch { setProgressNotice("This backup could not be restored. Existing progress has been kept. Use a valid HoodFees progress file and check browser storage."); }
    finally { if (progressFile.current) progressFile.current.value = ""; }
  }
  function saveProgress() {
    if (!cacheAddress.current) return;
    const time = cache.current?.save(cacheAddress.current, {
      balances: latest.current, history: historyLatest.current,
      selected: [...selectedRef.current], historyStarted: historyStarted.current,
    });
    setStorageError(!time);
    if (time) setSavedAt(time);
  }
  function publish(next: Record<string, SourceState>, scope: ScanScope = "balances", persist = true) {
    if (scope === "history") {
      historyLatest.current = next;
      setHistoryStates(next);
    } else {
      latest.current = next;
      setStates(next);
    }
    if (persist) saveProgress();
  }
  async function run(address: string, update = false, anchor?: string, scope: ScanScope = "balances") {
    stop();
    if (scope === "history") { historyStarted.current = true; historyNeedsUpdate.current = false; }
    const token = generation.current;
    const runController = new AbortController();
    controller.current = runController;
    const { signal } = runController;
    const isActive = () => !signal.aborted && active.current && token === generation.current;
    active.current = true;
    setRunning(true);
    setNotice("");
    const ids = SOURCE_INFO.filter((s) => selectedRef.current.has(s.id)).map((s) => s.id);
    let current: Record<string, SourceState> = Object.fromEntries(Object.entries(
      scope === "history" ? historyLatest.current : latest.current,
    ).map(([id, state]) => [id, {
      ...state,
      error: undefined,
      // Keep queued refreshes across Pause/reload, even when old coverage was 100%.
      refreshPending: state.refreshPending || !!(state.result && ids.includes(id) && (update || state.error && state.result.coverage.complete)),
    }]));
    publish(current, scope);
    const updatesWanted = new Set(ids.filter((id) => current[id]?.refreshPending));
    const renewed = new Set<string>(), readSources = new Set<string>();
    const sourceName = (id: string) => SOURCE_INFO.find((source) => source.id === id)?.name;
    const sourceComplete = (id: string) => !!current[id]?.result?.coverage.complete && !updatesWanted.has(id);
    try {
      await runScanQueue({
        sources: ids,
        signal,
        isComplete: sourceComplete,
        step: async (id: string) => {
          if (!isActive()) return;
          const existing = current[id], saved = existing?.result;
          const renewing = updatesWanted.has(id);
          if (renewing) renewed.add(id);
          setNotice(`Checking ${sourceName(id)}: ${scope === "history" ? "payout history" : "available fees"}. Scanning continues until all selected sources reach 100%.`);
          const snapshotCursor = anchor || Object.entries(current).find(([source, state]) => readSources.has(source) && state.result)?.[1].result?.snapshotCursor;
          let response: Response;
          let data: Result & { error: string };
          try {
            response = await fetch("/api/scan", {
              method: "POST",
              headers: { "content-type": "application/json", "x-hood-intent": "scan" },
              body: JSON.stringify({
                address,
                source: id,
                scope,
                ...(renewing && saved ? {
                  checkpoint: saved.checkpoint || saved.cursor || saved.snapshotCursor,
                  ...(!saved.checkpoint && !saved.cursor && scope === "balances" ? { positions: [...new Map((existing.balances ?? []).map((row) => [
                    `${row.target}:${row.position || row.currency}:${row.kind || "available"}`,
                    row.position ? { target: row.target, token: row.token, position: row.position, kind: row.kind } : { target: row.target, currency: row.currency },
                  ])).values()] } : {}),
                } : saved?.cursor ? { cursor: saved.cursor } : snapshotCursor ? { snapshotCursor } : {}),
              }),
              // Bound a stalled request, not the lifetime of the entire scan.
              signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
              cache: "no-store",
            });
          } catch { throw new ScanError("provider_unavailable"); }
          try { data = await response.json(); }
          catch {
            throw new ScanError(response.status === 429 ? "rate_limited" : response.ok ? "invalid_response" : "provider_unavailable");
          }
          if (!isActive()) return;
          if (!response.ok) {
            if (data.error === "cursor_expired" && saved && !renewed.has(id)) {
              updatesWanted.add(id);
              return;
            }
            const retryHeader = response.headers.get("retry-after");
            const seconds = retryHeader ? Number(retryHeader) : 0;
            const retryAfter = Number.isFinite(seconds) ? seconds * 1000 : Math.max(0, Date.parse(retryHeader || "") - Date.now());
            throw new ScanError(response.status === 429 ? "rate_limited" : data.error || "provider_unavailable", retryAfter);
          }
          const result = data as Result;
          updatesWanted.delete(id);
          readSources.add(id);
          setRetrying((prior) => { const next = { ...prior }; delete next[id]; return next; });
          current = {
            ...current,
            [id]: {
              result,
              balances: mergeRows([
                ...(result.resetBalances ? [] : existing?.balances ?? []),
                ...result.balances,
              ]) as FeeRow[],
              history: mergeRows([...(existing?.history ?? []), ...result.history]) as FeeRow[],
              pages: (existing?.pages ?? 0) + 1,
            },
          };
          // Persist each successful page before scheduling another request.
          publish(current, scope);
        },
        onRetry: (id, retry) => {
          if (!isActive()) return;
          const message = retry.code === "rate_limited" ? "Provider busy" : "Provider temporarily unavailable";
          setRetrying((prior) => ({ ...prior, [id]: `${message} · retrying automatically` }));
          setNotice(`${sourceName(id)}: ${message.toLowerCase()}. Retrying automatically in ${Math.ceil(retry.delay / 1000)} seconds. Your progress is saved.`);
        },
        onError: (id, error) => {
          if (!isActive()) return;
          const existing = current[id];
          setRetrying((prior) => { const next = { ...prior }; delete next[id]; return next; });
          current = { ...current, [id]: {
            ...existing,
            balances: existing?.balances ?? [],
            history: existing?.history ?? [],
            pages: existing?.pages ?? 0,
            error: errors[error instanceof ScanError ? error.code : "provider_unavailable"] ?? errors.provider_unavailable,
          } };
          publish(current, scope);
        },
      });
      if (isActive()) {
        const failed = ids.some((id) => current[id]?.error);
        const finished = ids.length > 0 && ids.every(sourceComplete);
        setNotice(failed
          ? "Some sources need attention and remain incomplete. Other selected sources have finished. Your verified results and progress are saved."
          : finished
            ? scope === "history" ? "100% of supported payout-history checks complete for every selected source." : "100% of supported available-fee checks complete for every selected source. Open Payout history to check past claims."
            : "Choose at least one source to start scanning.");
      }
    } finally {
      if (token === generation.current) {
        active.current = false;
        setRunning(false);
        setRetrying({});
      }
    }
  }
  function continueScan() {
    // Resume the saved cursor; renew it only if the server reports expiry.
    void run(wallet, false, undefined, activeTab === "history" ? "history" : "balances");
  }
  function changeTab(tab: string) {
    if (tab === activeTab) return;
    stop();
    setActiveTab(tab);
    setNotice("");
    if (tab === "history" && wallet && !claimBusy && (!historyStarted.current || historyNeedsUpdate.current) && selectedRef.current.size)
      void run(wallet, historyNeedsUpdate.current, undefined, "history");
  }
  function toggleSource(id: string) {
    if (running) return;
    const next = new Set(selectedRef.current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedRef.current = next;
    setSelected(next);
    setFilter("all");
    saveProgress();
    if (wallet && next.size) setNotice("Scan sources updated. Choose Resume scan to check your selection.");
    else if (wallet) { stop(); setNotice("Choose at least one scan source to start checking fees."); }
  }
  function resetScan() {
    stop();
    claims.current?.cancel();
    cacheAddress.current = "";
    publish({});
    publish({}, "history");
    historyStarted.current = false;
    historyNeedsUpdate.current = false;
    const removed = cache.current?.remove(wallet);
    cacheAddress.current = wallet;
    setSavedAt(null);
    setStorageError(!removed);
    setActiveTab("unclaimed");
    setConnectionNotice("Local scan progress reset. Available fees will be checked first; payout history stays on demand.");
    setNotice("Scan progress cleared. Choose Resume scan to start again.");
  }
  const claimBusy = ["preparing", "review", "wallet", "submitted", "confirming", "uncertain"].includes(claimState.phase);
  function beginClaim(row: FeeRow) {
    if (claimBusy) return;
    stop();
    setNotice("Scan paused while your claim is prepared. Review the transaction in your wallet.");
    void claims.current?.begin(row);
  }
  useEffect(() => {
    cache.current = new ScanCache(window);
    const claimController = new ClaimController({
      getSession: () => adapter.current?.session,
      notify: (state: ClaimState) => setClaimState(state),
      refresh: (confirmation: { history: FeeRow[]; snapshotCursor: string }, address: string) => {
        stop();
        const seeded: Record<string, SourceState> = {};
        for (const [id, state] of Object.entries(historyLatest.current))
          seeded[id] = { ...state, history: state.history };
        for (const row of confirmation.history) {
          const source = seeded[row.source] ?? { balances: [], history: [], pages: 0 };
          source.history = mergeRows([...source.history, row]) as FeeRow[];
          seeded[row.source] = source;
        }
        publish(seeded, "history");
        historyNeedsUpdate.current = true;
        setActiveTab("unclaimed");
        void run(address, true, confirmation.snapshotCursor);
      },
    });
    claims.current = claimController;
    const connection = new WalletAdapter(window, (event: WalletEvent) => {
      if (event.type === "providers") { setWalletOptions(event.options); return; }
      claimController.contextChanged();
      stop();
      cacheAddress.current = "";
      setSavedAt(null);
      setStorageError(false);
      publish({}, "history");
      historyStarted.current = false;
      historyNeedsUpdate.current = false;
      setActiveTab("unclaimed");
      if (event.type === "connecting") {
        stop();
        publish({});
        setWallet("");
        setConnecting(true);
        setConnectionNotice("Approve the connection in your wallet. Available fees are checked first; payout history loads when opened.");
      } else if (event.type === "connected") {
        stop();
        publish({});
        const saved = cache.current?.load(event.address);
        cacheAddress.current = event.address;
        setWallet(event.address);
        setConnecting(false);
        setWalletMenu(false);
        setFilter("all");
        if (saved) {
          selectedRef.current = new Set(saved.selected as string[]);
          setSelected(new Set(saved.selected as string[]));
          historyStarted.current = saved.historyStarted;
          historyNeedsUpdate.current = saved.historyStarted;
          publish(saved.balances as Record<string, SourceState>, "balances", false);
          publish(saved.history as Record<string, SourceState>, "history", false);
          setSavedAt(saved.savedAt);
          setConnectionNotice("Saved progress restored. Refreshing known balances and checking new blocks. Older coverage is kept; payout history stays on demand.");
          if (selectedRef.current.size) void run(event.address, true);
          else setNotice("Choose a scan source to refresh saved progress.");
        } else if (selectedRef.current.size) {
          setConnectionNotice(`${event.switched ? "Account changed" : "Wallet connected"}. Checking available fees first. Open Payout history to load past claims.`);
          void run(event.address, true);
        }
        else setNotice("Choose at least one scan source to start checking fees.");
      } else {
        stop();
        publish({});
        setWallet("");
        setConnecting(false);
        setNotice("");
        setConnectionNotice(event.type === "error" ? walletErrors[event.code] ?? walletErrors.unavailable : "Wallet disconnected. Scanning stopped; saved progress stays in this browser.");
      }
    });
    adapter.current = connection;
    connection.start();
    return () => {
      claimController.dispose();
      claims.current = null;
      connection.dispose();
      adapter.current = null;
      cancelWork();
    };
    // Wallet events use current scan state and source selections through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const included = SOURCE_INFO.filter((s) => selected.has(s.id));
  const scanStates = activeTab === "history" ? historyStates : states;
  const hasSourceErrors = included.some((source) => scanStates[source.id]?.error);
  const allBalances = uniqueFeeRows(included.flatMap((s) => states[s.id]?.balances ?? [])) as FeeRow[];
  const available = allBalances.filter((r) => r.kind === "available" && BigInt(r.raw) > 0n);
  const sourcesWithFees = new Set(SOURCE_INFO.filter((source) =>
    wallet && states[source.id]?.balances.some((row) => row.kind === "available" && BigInt(row.raw) > 0n),
  ).map((source) => source.id));
  const pending = allBalances.filter((r) => r.kind !== "available" && BigInt(r.raw) > 0n);
  const claimed = (uniqueFeeRows(included.flatMap((s) => historyStates[s.id]?.history ?? [])) as FeeRow[])
    .sort((a, b) => (b.block ?? 0) - (a.block ?? 0));
  const complete =
    wallet && included.length > 0 &&
    included.every((s) => scanStates[s.id]?.result?.coverage.complete && !scanStates[s.id]?.refreshPending && !scanStates[s.id]?.error);
  const historyComplete = included.length > 0 && included.every((s) => historyStates[s.id]?.result?.coverage.complete && !historyStates[s.id]?.refreshPending && !historyStates[s.id]?.error);
  const historyIncomplete = included.some((s) =>
    historyStates[s.id]?.result?.warnings.includes("archive_required"),
  );
  const found = totals(available) as FeeRow[],
    paid = totals(claimed) as FeeRow[];
  const snapshots = included.flatMap((s) =>
    states[s.id]?.result ? [states[s.id].result!.snapshot] : [],
  );
  const snapshotsMatch =
    snapshots.length > 0 && snapshots.length === included.length && snapshots.every((s) => s.hash === snapshots[0].hash);
  // Each source has a confirmed frozen snapshot. Cross-source aggregate amounts
  // are only shown when the snapshots coincide; otherwise show separate assets.
  const resultRows = activeTab === "history" ? claimed : allBalances.filter((r) => showZero || BigInt(r.raw) > 0n);
  // A source-specific view still shows that adapter's shared positions. Only
  // the combined view and totals collapse Bankr/Long overlaps.
  const rows = filter === "all" ? resultRows : activeTab === "history"
    ? included.filter((s) => s.id === filter).flatMap((s) => historyStates[s.id]?.history ?? []).sort((a,b)=>(b.block ?? 0)-(a.block ?? 0))
    : included.filter((s) => s.id === filter).flatMap((s) => states[s.id]?.balances ?? []).filter((r) => showZero || BigInt(r.raw) > 0n);
  return (
    <div className="app-shell">
      <div className="main-shell">
        <header className="topbar">
          <Link href="/" className="brand" aria-label="HoodFees home">
            <Brand /><span>Hood<span className="brand-fees">Fees</span></span>
          </Link>
          <div className="topbar-right">
            <span className="header-network"><span className="green-dot" /> Robinhood Chain</span>
            <div className="wallet-control">
              <button ref={connectRef} className="wallet-connect" disabled={connecting}
                onClick={() => wallet ? setWalletMenu(true) : connectDefault()}>
                {connecting ? <span className="spinner" /> : <Wallet size={16} />}
                <span>{connecting ? "Connecting…" : wallet ? short(wallet) : "Connect wallet"}</span>
              </button>
              <button className="wallet-choose" aria-label="Choose wallet or disconnect" onClick={() => setWalletMenu(true)}>
                <ChevronDown size={14} />
              </button>
            </div>
          </div>
        </header>
        <div className="terminal-frame">
        <main id="harvest">
          <section className="page-heading" aria-labelledby="hero-title">
            <div>
              <h1 id="hero-title">Find and claim your <span>launchpad fees.</span></h1>
              <p>Find available fees. Track confirmed payouts.</p>
            </div>
          </section>
          <section className="summary-grid" aria-label="Wallet summary">
            <Summary
              label="AVAILABLE TO HARVEST"
              values={found}
              wallet={wallet}
              helper={
                !wallet
                  ? "Your claimable balances will appear here"
                  : snapshotsMatch
                    ? "Located in reviewed contracts"
                    : "Per-source confirmed snapshots"
              }
              icon={<Wallet size={17} />}
            />
            <Summary
              label="CLAIMED TO DATE"
              emptyLabel={!Object.keys(historyStates).length ? "Not loaded" : "None found"}
              values={paid}
              wallet={wallet}
              helper={
                !wallet
                  ? "Confirmed payout history"
                  : !Object.keys(historyStates).length
                    ? "Open Payout history to load past claims"
                  : historyComplete && !historyIncomplete
                    ? "Verified history across scanned contracts"
                    : "Verified payouts found so far"
              }
              icon={<History size={17} />}
            />
          </section>
          <section className="lookup-panel" aria-label="Scan sources">
            {!wallet && <div className="connection-status" role="status" aria-live="polite" aria-atomic="true">
              <ShieldCheck size={16} />
              <div><strong>{connectionNotice}</strong></div>
            </div>}
            <div className="source-selector">
              <span>SCAN SOURCES</span>
              <div>
                {SOURCE_INFO.map((source) => (
                  <button
                    key={source.id}
                    className={`source-chip ${selected.has(source.id) ? "selected" : ""} ${sourcesWithFees.has(source.id) ? "has-fees" : ""}`}
                    aria-pressed={selected.has(source.id)}
                    aria-label={`${source.name}${sourcesWithFees.has(source.id) ? ": available fees found" : ""}`}
                    title={sourcesWithFees.has(source.id) ? "Available fees found" : undefined}
                    disabled={running || claimBusy}
                    onClick={() => toggleSource(source.id)}
                  >
                    <span className={`pad-mark ${source.id}`}>{source.mark}</span>
                    {source.name}
                    {selected.has(source.id) && <Check size={12} />}
                  </button>
                ))}
              </div>
              <button className="text-button coverage-link" onClick={() => setInfo(true)}>
                What’s covered
                <ArrowUpRight size={13} />
              </button>
            </div>
          </section>
          {wallet && (
            <section className="scan-strip" aria-label="Scan status">
              <div className="scan-overview">
                <div className="scan-summary" role="status" aria-live="polite" aria-atomic="true">
                  <span className={running ? "pulse-dot" : "green-dot"} />
                  <strong>{running ? "Scanning to 100%…" : complete
                    ? activeTab === "history" ? "Payout history loaded" : "Available-fee checks complete"
                    : !included.length ? "Choose scan sources" : hasSourceErrors ? "Scan needs attention" : "Scan paused"}</strong>
                  <p>{notice || (activeTab === "history"
                    ? "Resume scanning to finish checking older payouts."
                    : "Payout history loads only when opened.")}</p>
                </div>
                <div className="scan-actions">
                  {running ? (
                    <button className="secondary-button" onClick={() => { stop(); setNotice("Scan paused. Completed pages are saved in this browser. Resume scan to continue from your checkpoint."); }}>
                      <Pause size={14} />Pause
                    </button>
                  ) : (
                    <>
                      <button className="secondary-button" disabled={!included.length || claimBusy}
                        title="Refresh balances and discovery for the selected view"
                        onClick={() => void run(wallet, true, undefined, activeTab === "history" ? "history" : "balances")}>
                        <RefreshCw size={14} />Refresh
                      </button>
                      {!complete && included.length > 0 && (
                        <button className="secondary-button" disabled={claimBusy} onClick={continueScan}>
                          Resume scan<ArrowRight size={14} />
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
              <details className="scan-details">
                <summary>Scan details<span>{storageError ? "Storage unavailable" : savedAt ? "Saved in this browser" : ""}</span></summary>
                <p>{connectionNotice}</p>
                <p>{storageError ? "Progress may not survive a refresh."
                  : "Each completed page is saved in this browser. Scans continue automatically until every selected source reaches 100%. Pause at any time; Resume scan keeps your progress."}
                  {" Requests run one page at a time with a delay between pages. Busy providers are retried automatically with increasing delays."}</p>
                <ul className="source-progress">
                  {included.map((source) => {
                    const state = scanStates[source.id], result = state?.result;
                    const indexed = result?.discovery === "wallet-index";
                    const registry = result?.discovery === "onchain-registry" && activeTab !== "history";
                    const percent = result?.coverage.complete && !state.refreshPending ? 100 : Math.min(99.99, result?.coverage.percent ?? 0);
                    const label = state?.error ? "Needs attention · incomplete" : !result ? "Waiting to check"
                      : state.refreshPending ? "Refreshing saved positions and discovery"
                      : registry ? `${percent.toFixed(2)}% · ${result.coverage.positionsChecked ?? 0} / ${result.coverage.positionsTotal ?? 0} registry entries checked`
                      : indexed && activeTab !== "history" ? result.coverage.complete ? "100% · indexed positions verified" : "Checking wallet index and verifying fees"
                      : result.coverage.complete ? "100% · supported checks complete"
                      : !result.coverage.blocksChecked && !result.coverage.pending ? "0.00% · preparing historical ranges"
                      : `${percent.toFixed(2)}% · event coverage${result.coverage.pending ? " · verifying records" : ""}`;
                    return <li key={source.id}>
                      <div>
                        <div className="source-name"><strong>{source.name}</strong>{running && retrying[source.id] && <span className="source-retry" role="status">({retrying[source.id]})</span>}</div>
                        <span>{label}</span>
                      </div>
                      {result && <progress aria-label={`${source.name} ${registry ? "registry" : indexed ? "wallet index" : "event range"} progress`} max={100}
                        value={state.refreshPending || indexed && activeTab !== "history" && !result.coverage.complete ? undefined : percent} />}
                    </li>;
                  })}
                </ul>
                <button className="text-button reset-scan" disabled={claimBusy} onClick={resetScan}><RotateCcw size={13} />Reset scan</button>
              </details>
            </section>
          )}
          {claimState.phase !== "idle" && (claimState.owner === wallet || claimBusy) && (
            <section className="claim-status" role="status" aria-live="polite" aria-atomic="true">
              <strong>{claimBusy && claimState.owner && claimState.owner !== wallet
                ? "A claim for the previous account is still being tracked."
                : claimState.phase === "preparing" ? "Checking your claim…"
                : claimState.phase === "review" ? "Your claim is ready to review."
                : claimState.phase === "wallet" ? "Confirm the transaction in your wallet."
                : claimState.phase === "submitted" ? "Claim submitted. Waiting for it to be mined."
                : claimState.phase === "confirming" ? `Claim mined. Confirming onchain · ${claimState.confirmations ?? 0}/20 blocks.`
                : claimState.phase === "confirmed" ? running ? "Claim confirmed. Refreshing your balances and payout history." : complete ? "Claim confirmed. Balances and payout history refreshed." : "Claim confirmed. Your payout is recorded; check the scan status for remaining reads."
                : claimState.phase === "reverted" ? "The claim reverted. No fee payout was made; network gas may have been spent."
                : claimState.phase === "no_payout" ? "Transaction confirmed; a fee payout could not be verified. Refreshing your results."
                : claimState.phase === "uncertain" ? "The wallet may have submitted this claim. Check wallet activity before trying again."
                : "Claim needs attention."}</strong>
              {claimState.error && claimState.phase !== "uncertain" && <p>{claimErrors[claimState.error] ?? "The claim could not be verified. Check your wallet before retrying."}</p>}
              {claimState.hash && <a href={explorer("tx", claimState.hash)} target="_blank" rel="noreferrer">View transaction <ArrowUpRight size={13} /></a>}
              {claimState.error === "confirmation_pending" && <button className="secondary-button" onClick={() => void claims.current?.watch()}>Check confirmation</button>}
            </section>
          )}
          <section className="results-panel" id="fees" aria-label="Fee balances and payout history">
            <div className="results-header">
              <div className="tabs" role="tablist" aria-label="Fee results">
                <button
                  role="tab"
                  aria-selected={activeTab === "unclaimed"}
                  className={activeTab === "unclaimed" ? "active" : ""}
                  onClick={() => changeTab("unclaimed")}
                >
                  Unclaimed fees<span>{available.length + pending.length}</span>
                </button>
                <button
                  role="tab"
                  aria-selected={activeTab === "history"}
                  className={activeTab === "history" ? "active" : ""}
                  onClick={() => changeTab("history")}
                >
                  Payout history<span>{Object.keys(historyStates).length ? claimed.length : "—"}</span>
                </button>
              </div>
              <div className="table-controls">
                {activeTab === "unclaimed" && wallet && allBalances.length > 0 && (
                  <label className="zero-toggle">
                    <input
                      type="checkbox"
                      checked={showZero}
                      onChange={(e) => setShowZero(e.target.checked)}
                    />
                    Show zero
                  </label>
                )}
                {(resultRows.length > 0 || filter !== "all") && <label className="filter-select">
                  <select
                    aria-label="Filter by launchpad"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  >
                    <option value="all">All launchpads</option>
                    {included.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={13} />
                </label>}
              </div>
            </div>
            {rows.length ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>LAUNCHPAD</th>
                      <th>ASSET</th>
                      <th>{activeTab === "history" ? "PAID OUT" : "AMOUNT"}</th>
                      <th>{activeTab === "history" ? "CONFIRMED AT" : "STATUS"}</th>
                      <th>{activeTab === "history" ? "TRANSACTION" : "POSITION"}</th>
                      {activeTab !== "history" && <th>CLAIM</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <div className="pad-cell">
                            <span className={`pad-mark ${row.source}`}>
                              {SOURCE_INFO.find((s) => s.id === row.source)?.mark}
                            </span>
                            <span>
                              {SOURCE_INFO.find((s) => s.id === row.source)?.name}
                              <small>{row.target}</small>
                            </span>
                          </div>
                        </td>
                        <td>
                          <a
                            className="asset-cell"
                            href={explorer("address", row.currency)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <strong>{row.symbol}</strong>
                            <small>{short(row.currency)}</small>
                          </a>
                        </td>
                        <td>
                          <Amount row={row} />
                        </td>
                        <td>
                          {activeTab === "history" ? (
                            <a
                              className="block-link"
                              href={explorer("block", String(row.block))}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Block {row.block?.toLocaleString()}
                            </a>
                          ) : (
                            <span
                              className={`status-pill ${row.kind === "available" ? "available" : "pending"}`}
                            >
                              {row.kind === "available"
                                ? row.sweptRaw && BigInt(row.sweptRaw) > 0n ? "Available with sweep" : "Available"
                                : row.kind === "conversion-needed"
                                  ? "Needs conversion"
                                  : "Unswept estimate"}
                            </span>
                          )}
                        </td>
                        <td>
                          {row.tx ? (
                            <a
                              className="explorer-link"
                              href={explorer("tx", row.tx)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {short(row.tx)}
                              <ArrowUpRight size={12} />
                            </a>
                          ) : row.token ? (
                            <a
                              className="explorer-link"
                              href={explorer("address", row.token)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {short(row.token)}
                              <ArrowUpRight size={12} />
                            </a>
                          ) : (
                            <span className="table-muted">Shared escrow</span>
                          )}
                        </td>
                        {activeTab !== "history" && <td>
                          {row.kind === "available" && BigInt(row.raw) > 0n ? (
                            <button className="claim-button" disabled={claimBusy || !row.claimHandle}
                              title={!row.claimHandle ? "Refresh this fee before claiming" : "Review and claim with your connected wallet"}
                              onClick={() => beginClaim(row)}>
                              {claimBusy && claimState.row && claimKey(claimState.row) === claimKey(row) ? "In progress…" : "Claim"}
                              <ArrowUpRight size={13} />
                            </button>
                          ) : <span className="table-muted">{row.kind !== "available" ? "Not yet claimable" : "—"}</span>}
                        </td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-state">
                <div className="empty-icon" aria-hidden="true">
                  {activeTab === "history" ? <History size={27} /> : <Wallet size={27} />}
                  <span>
                    <Search size={12} />
                  </span>
                </div>
                <h2>
                  {!wallet
                    ? "Your fees are out there."
                    : filter !== "all" && resultRows.length > 0 ? "No matching results"
                    : running
                      ? "Looking for your fees…"
                      : complete && (activeTab !== "history" || !historyIncomplete)
                        ? activeTab === "history" ? "No payout history found" : "No unclaimed fees found"
                        : "Nothing found in the pages scanned yet"}
                </h2>
                <p>
                  {!wallet
                    ? "Connect your wallet to discover unclaimed fees\nand see your verified payout history."
                    : filter !== "all" && resultRows.length > 0 ? "Choose another launchpad or All launchpads to see the other results."
                    : complete && (activeTab !== "history" || !historyIncomplete)
                      ? activeTab === "history" ? "No matching payouts in the covered contracts. Check coverage for excluded routes." : "No positive balances found in the covered contracts. Confirmed claims appear in Payout history."
                      : "Keep scanning to discover older positions. Unread pages and failed reads remain unknown."}
                </p>
                {!wallet && (
                  <button className="primary-button" onClick={connectDefault} disabled={connecting}>
                    Connect wallet
                    <ArrowUpRight size={13} />
                  </button>
                )}
              </div>
            )}
            <div className="results-footer">
              <span>
                <ShieldCheck size={13} />
                Read-only scans · Wallet-approved claims
              </span>
              <span>
                {wallet
                  ? `${available.length} available · ${pending.length} unswept positions`
                  : "Ready when you are"}
              </span>
            </div>
          </section>
          {included.map((source) => {
            const state = scanStates[source.id];
            return (
              <div key={source.id} className="source-notes">
                {state?.error && (
                  <p className="source-error" role="alert">
                    <strong>{source.name}:</strong> {state.error}
                  </p>
                )}
                {state?.result?.warnings.map((w) => (
                  <p key={w}>
                    {warningText[w] ??
                      "This source has additional fees outside the current adapter’s coverage."}
                  </p>
                ))}
              </div>
            );
          })}
          <footer className="page-footer">
            <div><span className="footer-brand">HoodFees ↗</span><span>Find it. Claim it. Carry on.</span></div>
            <div><a href="https://github.com/ethduke/hoodfees" target="_blank" rel="noreferrer">View source <ArrowUpRight size={14} /></a><button className="text-button" onClick={() => { setProgressNotice(""); setProgressMenu(true); }}>Saved progress</button><button className="text-button" onClick={() => setInfo(true)}>Coverage & privacy <ArrowUpRight size={14} /></button></div>
            <small>Independent tool. No Robinhood or launchpad affiliation.</small>
          </footer>
        </main>
        </div>
      </div>
      {claimState.phase === "review" && claimState.quote && (
        <WalletDialog titleId="claim-title" closeLabel="Cancel claim review" onClose={() => claims.current?.cancel()}>
          <span className="eyebrow">REVIEW YOUR CLAIM</span>
          <h2 id="claim-title">Claim your fees.</h2>
          <p>{claimState.quote.payouts.length > 1 ? "This transaction collects both assets for this position." : "This transaction claims fees to your connected account."}</p>
          <div className="claim-payouts">{claimState.quote.payouts.filter((row) => BigInt(row.raw) > 0n).map((row) => <div key={row.currency}><Amount row={row} /><small>{short(row.currency)}</small></div>)}</div>
          <p>Recipient: <span className="mono">{short(claimState.quote.address)}</span><br />Network: Robinhood Chain</p>
          <a className="text-button" href={explorer("address", claimState.quote.target)} target="_blank" rel="noreferrer">View claim contract <ArrowUpRight size={13} /></a>
          <p>The claim was simulated. Amounts can change before mining. You pay network gas in ETH; your wallet shows the final gas fee. No token approval is requested.</p>
          <button className="primary-button" onClick={() => void claims.current?.send()}>Confirm in wallet<ArrowUpRight size={15} /></button>
        </WalletDialog>
      )}
      {progressMenu && (
        <WalletDialog titleId="progress-title" closeLabel="Close saved progress" onClose={() => setProgressMenu(false)}>
          <h2 id="progress-title">Your saved progress.</h2>
          <p>Export checkpoints before changing the site address, or restore a backup here. Your source choices, discovered positions and payout history are included.</p>
          <p>Backups contain wallet addresses and scan results. Export and restore happen in this browser; the file is never uploaded to the server.</p>
          <button className="secondary-button" disabled={running || claimBusy} onClick={exportProgress}>Export progress</button>
          <button className="secondary-button" disabled={running || claimBusy} onClick={() => progressFile.current?.click()}>Restore progress</button>
          <input ref={progressFile} type="file" accept=".json,application/json" hidden aria-label="Progress backup file" onChange={(event) => void importProgress(event.target.files?.[0])} />
          {(running || claimBusy) && <p>Pause the scan and finish any active claim before exporting or restoring.</p>}
          {progressNotice && <p role="status" aria-live="polite">{progressNotice}</p>}
          <p>After restoring, connect your wallet to refresh balances and resume the saved checkpoints. Newer progress is kept.</p>
        </WalletDialog>
      )}
      {walletMenu && (
        <WalletDialog onClose={() => { if (connecting) adapter.current?.disconnect(); setWalletMenu(false); }}>

            <span className="eyebrow">YOUR WALLET</span>
            <h2 id="wallet-title">Connect to find your fees.</h2>
            <p>Choose an installed wallet to share your account address and check available fees. Open Payout history to load past claims.</p>
            {walletOptions.map((option) => <button key={option.id} className="wallet-option" disabled={connecting} onClick={() => void adapter.current?.connect(option)}><Wallet size={20} /><span>{option.rabby ? "Browser wallet" : option.name}<small>{option.rabby ? "Default wallet" : "Detected in your browser"}</small></span><ArrowRight size={16} /></button>)}
            {!walletOptions.length && <p>No browser wallet detected. Open this site in your wallet’s browser or install a compatible browser wallet.</p>}
            {connecting && <p role="status">Approve the connection in your wallet, or cancel below.</p>}
            {(wallet || connecting) && <button className="secondary-button" onClick={() => { adapter.current?.disconnect(); setWalletMenu(false); }}>{connecting ? "Cancel connection" : "Disconnect wallet"}</button>}
            <p className="wallet-readonly"><ShieldCheck size={14} />Connection shares your address. Each claim requires wallet confirmation.</p>
        </WalletDialog>
      )}
      {info && (
        <WalletDialog titleId="coverage-title" closeLabel="Close coverage details" className="coverage-modal" onClose={() => setInfo(false)}>
            <span className="eyebrow">KNOW WHAT’S COVERED</span>
            <h2 id="coverage-title">A clear view of your fees.</h2>
            <p>
              Sources are checked against pinned deployed bytecode on Robinhood Chain.
              Bags checks its proxy implementations too. Bankr and Long share Doppler accounting;
              overlapping positions and payouts are counted once.
            </p>
            {SOURCE_INFO.map((s) => (
              <article key={s.id}>
                <span className={`pad-mark ${s.id}`}>{s.mark}</span>
                <div>
                  <h3>{s.name}</h3>
                  <p>{s.description}</p>
                  <small>{s.note}</small>
                </div>
              </article>
            ))}
            <div className="coverage-footnotes">
              <p>
                <strong>Available fees first.</strong> Connecting reads balances and discovers fee positions at a fixed block with 20 confirmations. Past payouts load only when you open Payout history. Scanning continues automatically until every selected source completes. Pause and resume at any time; progress is saved after each completed page. Partial scans show only what has been found so far. 100% applies to the supported routes for the selected view at its snapshot block, subject to each source’s exclusions and index delays.
              </p>
              <p>
                <strong>Available and unswept are separate.</strong> Bags previews the sweep included
                in its claim; payouts arrive as WETH. Pending pons fees may need
                collection or conversion. Buyback earmarks can change the final payout. Asset totals
                are never converted into a pretend combined currency.
              </p>
              <p>
                <strong>Progress stays in this browser.</strong> Scan results, wallet addresses, source choices and signed progress cursors are stored locally per wallet so you can resume after refresh or reconnect. Reset scan removes the connected wallet’s saved progress. No wallet address is put in this site’s URLs, application logs, analytics or a database. O1, Bankr and configured Bags index discovery send your address to their wallet indexes through the server; registry discovery and onchain queries go to the chain provider. Hosting logs depend on the operator’s settings. Signed scan checkpoints survive cursor expiry. Returning refreshes known balances and discovery, then automatically finishes older unchecked ranges. A changed chain snapshot or signing key can require a reset.
              </p>
              <p>
                <strong>More adapters come later.</strong> Flap, pools.trade, PAIR and other
                verified platforms are not included in this first release. pons’ older unreviewed
                stacks, Bags v1, holder dividends and buyback vesting remain outside coverage.
              </p>
              <p>
                <strong>You approve every claim.</strong> Scanning only reads the chain. Claiming sends one transaction after you review it and approve it in your wallet. Pool claims collect both assets together. Unswept estimates cannot be claimed here.
              </p>
            </div>
            <button className="primary-button" onClick={() => setInfo(false)}>
              Back to dashboard
              <ArrowRight size={15} />
            </button>
        </WalletDialog>
      )}
    </div>
  );
}
function Summary({
  label,
  values,
  wallet,
  helper,
  icon,
  emptyLabel = "None found",
}: {
  label: string;
  values: FeeRow[];
  wallet: string;
  helper: string;
  icon: React.ReactNode;
  emptyLabel?: string;
}) {
  return (
    <div className="summary-card">
      <span className="summary-label">
        {label}
        {icon}
      </span>
      <div className="summary-value">
        {!wallet ? (
          <span className="muted-number">—</span>
        ) : !values.length ? (
          <span className="muted-number">{emptyLabel}</span>
        ) : (
          values.slice(0, 2).map((row) => <span key={row.currency} title={`${row.raw} raw units · ${row.currency}`}>{row.metadataVerified ? <>{compactAmount(row.raw, row.decimals)} <small>{row.symbol}</small></> : `${row.raw} raw units`}</span>)
        )}
        {values.length > 2 && <small>+{values.length - 2} other assets</small>}
      </div>
      <p>{helper}</p>
    </div>
  );
}

function WalletDialog({ children, onClose, titleId = "wallet-title", closeLabel = "Close wallet picker", className = "wallet-modal" }: { children: React.ReactNode; onClose: () => void; titleId?: string; closeLabel?: string; className?: string }) {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => previous?.focus();
  }, []);
  return <div className="modal-backdrop" onClick={onClose}>
    <section ref={dialog} className={className} role="dialog" aria-modal="true" aria-labelledby={titleId}
      onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); onClose(); }
        if (event.key !== "Tab") return;
        const items = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]');
        if (!items?.length) return;
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
      <button className="icon-button modal-close" aria-label={closeLabel} onClick={onClose}><X size={18} /></button>
      {children}
    </section>
  </div>;
}

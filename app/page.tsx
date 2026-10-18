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
  Radar,
  LayoutGrid,
  CircleHelp,
} from "lucide-react";
import { ClaimController } from "../lib/wallet/claims.mjs";
import { claimKey } from "../lib/fees/claim-plan.mjs";
import { WalletAdapter } from "../lib/wallet/adapter.mjs";
import { ScanCache } from "../lib/wallet/scan-cache.mjs";
import { SOURCE_INFO } from "../lib/fees/catalog.mjs";
import { compactAmount, mergeRows, totals } from "../lib/fees/model.mjs";
const SCAN_PASS_REQUESTS = 6;
const SCAN_PASS_DURATION = 20_000;
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
  discovery?: "wallet-index";
  snapshotCursor: string;
  source: string;
  snapshot: { number: number; hash: string; timestamp: number };
  balances: FeeRow[];
  history: FeeRow[];
  warnings: string[];
  coverage: { complete: boolean; percent: number; pending: number; blocksChecked?: number; blocksTotal?: number };
  cursor: string | null;
};
type SourceState = {
  result?: Result;
  balances: FeeRow[];
  history: FeeRow[];
  error?: string;
  pages: number;
};
const errors: Record<string, string> = {
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
  index_unavailable: "The O1 wallet index is unavailable. Saved progress is kept; try again shortly.",
};
const warningText: Record<string, string> = {
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
  function connectDefault() {
    adapter.current?.discoverLegacy();
    const preferred = adapter.current?.options.find((option) => option.rabby);
    if (preferred) void adapter.current?.connect(preferred);
    else setWalletMenu(true);
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
    active.current = true;
    setRunning(true);
    setNotice("");
    let current: Record<string, SourceState> = { ...(scope === "history" ? historyLatest.current : latest.current) };
    if (update) current = Object.fromEntries(Object.entries(current).map(([id,state])=>[id,{...state,error:undefined}]));
    const ids = SOURCE_INFO.filter((s) => selectedRef.current.has(s.id)).map((s) => s.id);
    const updatesWanted = new Set(update ? ids.filter((id)=>current[id]?.result) : []);
    const renewed = new Set<string>(), settled = new Set<string>(), readSources = new Set<string>();
    let requests = 0;
    let timedOut = false;
    const deadline = Date.now() + SCAN_PASS_DURATION;
    const timeout = setTimeout(() => {
      if (token === generation.current && active.current) {
        timedOut = true;
        controller.current?.abort();
      }
    }, SCAN_PASS_DURATION);
    const withinBudget = () => !timedOut && requests < SCAN_PASS_REQUESTS && Date.now() < deadline;
    try {
      while (active.current && token === generation.current && withinBudget()) {
        let didWork = false;
        for (const id of ids) {
          if (!active.current || token !== generation.current || !withinBudget()) break;
          const existing = current[id];
          if (settled.has(id) || (existing?.result?.coverage.complete && !updatesWanted.has(id)) || existing?.error) continue;
          didWork = true;
          requests++;
          const coverage = existing?.result?.coverage;
          setNotice(`Checking ${SOURCE_INFO.find((source) => source.id === id)?.name}: ${scope === "history" ? "payout history" : "available fees"}. This pass stops after ${SCAN_PASS_REQUESTS} pages or ${SCAN_PASS_DURATION / 1000} seconds.${coverage?.pending ? ` ${coverage.pending} candidate records awaiting verification.` : ""}`);
          controller.current = new AbortController();
          try {
            const saved = existing?.result;
            const renewing = updatesWanted.has(id);
            if (renewing) { updatesWanted.delete(id); renewed.add(id); }
            const snapshotCursor = anchor || Object.entries(current).find(([source,state])=>readSources.has(source) && state.result)?.[1].result?.snapshotCursor;
            const response = await fetch("/api/scan", {
              method: "POST",
              headers: { "content-type": "application/json", "x-hood-intent": "scan" },
              body: JSON.stringify({
                address,
                source: id,
                scope,
                ...(renewing && saved ? {
                  checkpoint: saved.checkpoint || saved.cursor || saved.snapshotCursor,
                  ...(!saved.checkpoint && !saved.cursor && scope === "balances" ? {positions: [...new Map((existing.balances ?? []).map((row)=>[
                    `${row.target}:${row.position || row.currency}:${row.kind || "available"}`,
                    row.position ? {target:row.target,token:row.token,position:row.position,kind:row.kind} : {target:row.target,currency:row.currency},
                  ])).values()]} : {}),
                } : saved?.cursor ? {cursor:saved.cursor} : snapshotCursor ? {snapshotCursor} : {}),
              }),
              signal: controller.current.signal,
              cache: "no-store",
            });
            const data = (await response.json()) as Result & { error: string };
            if (token !== generation.current || !active.current || timedOut) break;
            if (!response.ok) {
              if (data.error === "cursor_expired" && saved && !renewed.has(id)) {
                updatesWanted.add(id);
                continue;
              }
              current = {
                ...current,
                [id]: {
                  ...existing,
                  balances: existing?.balances ?? [],
                  history: existing?.history ?? [],
                  pages: existing?.pages ?? 0,
                  error: errors[data.error] ?? errors.provider_unavailable,
                },
              };
              publish(current, scope);
              continue;
            }
            const result = data as Result;
            readSources.add(id);
            if (result.updatesComplete) settled.add(id);
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
            publish(current, scope);
          } catch {
            if (token !== generation.current || !active.current || timedOut) break;
            current = {
              ...current,
              [id]: {
                ...existing,
                balances: existing?.balances ?? [],
                history: existing?.history ?? [],
                pages: existing?.pages ?? 0,
                error: errors.provider_unavailable,
              },
            };
            publish(current, scope);
          }
        }
        if (!didWork) break;
        if (active.current && withinBudget())
          await new Promise((resolve) => setTimeout(resolve, 350));
      }
      if (active.current && token === generation.current) {
        const failed = ids.some((id) => current[id]?.error);
        const finished = ids.length > 0 && ids.every((id) => current[id]?.result?.coverage.complete && !current[id]?.error);
        setNotice(failed
          ? "Some sources could not be read. Verified results are kept; unread fees remain unknown. Continue to retry."
          : settled.size > 0 && ids.every((id)=>settled.has(id) || current[id]?.result?.coverage.complete)
            ? `${scope === "history" ? "New payouts checked" : "New blocks checked and known balances refreshed"}. Saved older coverage is kept. Continue scan checks any unfinished older ranges.`
          : finished
            ? scope === "history" ? "Payout history loaded for the selected contracts." : "Available-fee checks complete for the selected contracts. Open Payout history to load past claims."
            : `This scan pass is finished. Your results are kept. Choose Continue scan to check more ${scope === "history" ? "payout history" : "fee positions"}.`);
      }
    } finally {
      clearTimeout(timeout);
      if (token === generation.current) {
        active.current = false;
        setRunning(false);
      }
    }
  }
  function continueScan() {
    const scope = activeTab === "history" ? "history" : "balances";
    const needsUpdate = Object.values(scope === "history" ? historyLatest.current : latest.current).some((state)=>state.error && state.result);
    const cleaned = Object.fromEntries(
      Object.entries(scope === "history" ? historyLatest.current : latest.current).map(([id, state]) => [id, { ...state, error: undefined }]),
    );
    publish(cleaned, scope);
    void run(wallet, needsUpdate, undefined, scope);
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
    saveProgress();
    if (wallet && next.size) setNotice("Scan sources updated. Choose Continue scan to check your selection.");
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
    setNotice("Scan progress cleared. Choose Continue scan to start again.");
  }
  const claimBusy = ["preparing", "review", "wallet", "submitted", "confirming", "uncertain"].includes(claimState.phase);
  function beginClaim(row: FeeRow) {
    if (claimBusy) return;
    stop();
    setNotice("Scan paused while your claim is prepared. Review the transaction in your wallet.");
    void claims.current?.begin(row);
  }
  const included = SOURCE_INFO.filter((s) => selected.has(s.id));
  const scanStates = activeTab === "history" ? historyStates : states;
  const hasSourceErrors = included.some((source) => scanStates[source.id]?.error);
  const allBalances = included.flatMap((s) => states[s.id]?.balances ?? []);
  const available = allBalances.filter((r) => r.kind === "available" && BigInt(r.raw) > 0n);
  const sourcesWithFees = new Set(SOURCE_INFO.filter((source) =>
    wallet && states[source.id]?.balances.some((row) => row.kind === "available" && BigInt(row.raw) > 0n),
  ).map((source) => source.id));
  const pending = allBalances.filter((r) => r.kind !== "available" && BigInt(r.raw) > 0n);
  const claimed = included
    .flatMap((s) => historyStates[s.id]?.history ?? [])
    .sort((a, b) => (b.block ?? 0) - (a.block ?? 0));
  const complete =
    wallet && included.length > 0 &&
    included.every((s) => scanStates[s.id]?.result?.coverage.complete && !scanStates[s.id]?.error);
  const historyComplete = included.length > 0 && included.every((s) => historyStates[s.id]?.result?.coverage.complete && !historyStates[s.id]?.error);
  const historyIncomplete = included.some((s) =>
    historyStates[s.id]?.result?.warnings.includes("archive_required"),
  );
  const found = totals(available) as FeeRow[],
    paid = totals(claimed) as FeeRow[];
  const pct = included.length
    ? included.reduce((n, s) => n + (scanStates[s.id]?.result?.coverage.percent ?? 0), 0) /
      included.length
    : 0;
  const snapshots = included.flatMap((s) =>
    states[s.id]?.result ? [states[s.id].result!.snapshot] : [],
  );
  const snapshotsMatch =
    snapshots.length > 0 && snapshots.every((s) => s.hash === snapshots[0].hash);
  // Each source has a confirmed frozen snapshot. Cross-source aggregate amounts
  // are only shown when the snapshots coincide; otherwise show separate assets.
  const rows = (
    activeTab === "history" ? claimed : allBalances.filter((r) => showZero || BigInt(r.raw) > 0n)
  ).filter((r) => filter === "all" || r.source === filter);
  return (
    <div className="app-shell">
      <div className="main-shell">
        <header className="topbar">
          <Link href="/" className="brand" aria-label="Hood Fee Harvest home">
            <Brand /><span>hood<span className="brand-sub">FEE HARVEST</span></span>
          </Link>
          <nav className="top-nav" aria-label="Main navigation">
            <a href="#harvest" className="nav-link active">Overview</a>
            <a href="#fees" className="nav-link">Your fees</a>
            <button className="nav-link" onClick={() => setInfo(true)}>Coverage <ArrowUpRight size={13} /></button>
          </nav>
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
          <aside className="terminal-rail" aria-label="Workspace navigation">
            <a className="rail-item active" href="#harvest" aria-label="Overview"><LayoutGrid size={18} /></a>
            <a className="rail-item" href="#fees" aria-label="Available fees" onClick={() => changeTab("unclaimed")}><Wallet size={18} /></a>
            <a className="rail-item" href="#fees" aria-label="Payout history" onClick={() => changeTab("history")}><History size={18} /></a>
            <button className="rail-item" aria-label="Reviewed sources" onClick={() => setInfo(true)}><ShieldCheck size={18} /></button>
            <span className="rail-caption">YOUR FEES. YOUR CALL.</span>
            <button className="rail-item rail-help" aria-label="Coverage details" onClick={() => setInfo(true)}><CircleHelp size={18} /></button>
          </aside>
        <main id="harvest">
          <section className="page-heading" aria-labelledby="hero-title">
            <div>
              <span className="eyebrow"><span className="green-dot" /> {running ? "SCANNING. DISCOVERING. YOURS." : wallet ? "CONNECTED. DISCOVERED. YOURS." : "YOUR FEES. YOUR CALL."}</span>
              <h1 id="hero-title">Make every <span>fee count.</span></h1>
              <p>Your launchpad fees, together at last. Find what’s ready. Follow what’s paid.</p>
            </div>
            <div className="snapshot-note">
              <span>{snapshotsMatch ? "CONFIRMED SNAPSHOT" : "ROBINHOOD CHAIN MAINNET"}</span>
              {snapshotsMatch ? <a href={explorer("block", String(snapshots[0].number))} target="_blank" rel="noreferrer">Block {snapshots[0].number.toLocaleString()} <ArrowUpRight size={11} /></a> : <small>Chain 4663 · 20-block confirmations</small>}
            </div>
          </section>
          <section className="summary-grid" aria-label="Wallet summary">
            <Summary
              label="AVAILABLE TO HARVEST"
              onViewAvailable={() => changeTab("unclaimed")}
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
            <div className="summary-card">
              <span className="summary-label">
                {activeTab === "history" ? "HISTORY COVERAGE" : "FEE DISCOVERY"}
                <Radar size={17} />
              </span>
              <div className="summary-value">
                {wallet ? (
                  <>{complete ? "Complete" : pct < 0.01 ? "Started" : `${pct.toFixed(1)}%`}</>
                ) : (
                  <span className="muted-number">—</span>
                )}
              </div>
              <p>
                {wallet
                  ? `${included.length} source groups · ${included.reduce((n, s) => n + (scanStates[s.id]?.pages ?? 0), 0)} pages checked`
                  : "Connect your wallet to start scanning"}
              </p>
              <div className="mini-progress">
                <span style={{ width: `${pct}%` }} />
              </div>
            </div>
          </section>
          <section className="lookup-panel" aria-label="Scan sources">
            <div className="connection-status" role="status" aria-live="polite" aria-atomic="true">
              <ShieldCheck size={16} />
              <div><strong>{connectionNotice}</strong></div>
            </div>
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
            <section className="scan-strip" aria-live="polite">
              <div>
                <span className={running ? "pulse-dot" : "green-dot"} />
                <strong>
                  {running
                    ? "Checking a short batch…"
                    : complete
                      ? activeTab === "history" ? "Payout history loaded" : "Available-fee checks complete"
                      : !included.length ? "Choose scan sources" : hasSourceErrors ? "Scan needs attention" : "Scan paused"}
                </strong>
                <p>
                  {notice ||
                    (activeTab === "history" ? "Payout history loads in short passes. Continue to check older payouts." : "Available fees use direct contract reads and position discovery. Payout history loads only when opened.")}
                  {` ${available.length} available fee positions · ${claimed.length} verified payouts found.`}
                  {running && ` ${pct.toFixed(2)}% of event ranges searched · ${included.reduce((n, s) => n + (scanStates[s.id]?.pages ?? 0), 0)} pages checked.`}
                  {storageError ? " Browser storage is unavailable. Progress may not survive a refresh." : savedAt ? " Saved in this browser. Checkpoints survive cursor expiry; Refresh checks new blocks and current balances." : ""}
                </p>
              </div>
              <div className="scan-actions">
                <button className="secondary-button" disabled={claimBusy} onClick={resetScan}>
                  <RotateCcw size={14} />Reset scan
                </button>
                {running ? (
                  <button className="secondary-button" onClick={() => { stop(); setNotice("Scan paused. Your verified results are kept. Continue whenever you are ready."); }}>
                    <Pause size={14} />
                    Pause
                  </button>
                ) : (
                  <>
                    <button
                      className="icon-button"
                      title="Refresh balances and check new blocks"
                      aria-label="Refresh balances and check new blocks"
                      disabled={!included.length || claimBusy}
                      onClick={() => void run(wallet, true, undefined, activeTab === "history" ? "history" : "balances")}
                    >
                      <RefreshCw size={16} />
                    </button>
                    {!complete && included.length > 0 && (
                      <button className="secondary-button" disabled={claimBusy} onClick={continueScan}>
                        Continue scan
                        <ArrowRight size={14} />
                      </button>
                    )}
                  </>
                )}
              </div>
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
          <div className="section-heading results-title"><div><h2>Your next harvest.</h2><p>Available balances and a clear record of every payout.</p></div><button className="text-button" onClick={() => setInfo(true)}>What’s covered <ArrowUpRight size={15} /></button></div>
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
                {activeTab === "unclaimed" && wallet && (
                  <label className="zero-toggle">
                    <input
                      type="checkbox"
                      checked={showZero}
                      onChange={(e) => setShowZero(e.target.checked)}
                    />
                    Show zero
                  </label>
                )}
                <label className="filter-select">
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
                </label>
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
                                ? "Available"
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
                    : running
                      ? "Looking for your fees…"
                      : complete && (activeTab !== "history" || !historyIncomplete)
                        ? activeTab === "history" ? "No payout history found" : "No unclaimed fees found"
                        : "Nothing found in the pages scanned yet"}
                </h2>
                <p>
                  {!wallet
                    ? "Connect your wallet to discover unclaimed fees\nand see your verified payout history."
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
            <div><span className="footer-brand">hood ↗</span><span>Find it. Claim it. Carry on.</span></div>
            <div><a href="https://github.com/ethduke/hood-fee-harvest" target="_blank" rel="noreferrer">View source <ArrowUpRight size={14} /></a><button className="text-button" onClick={() => setInfo(true)}>Coverage & privacy <ArrowUpRight size={14} /></button></div>
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
              The first release reuses fungun’s reviewed accounting. Sources are checked against
              pinned deployed bytecode on Robinhood Chain.
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
                <strong>Available fees first.</strong> Connecting reads balances and discovers fee positions at a fixed block with 20 confirmations. Past payouts load only when you open Payout history. Each pass stops automatically; Continue scan resumes the selected view. Partial scans show only what has been found so far.
              </p>
              <p>
                <strong>Available and unswept are separate.</strong> Pending pons fees may need
                collection or conversion. Buyback earmarks can change the final payout. Asset totals
                are never converted into a pretend combined currency.
              </p>
              <p>
                <strong>Progress stays in this browser.</strong> Scan results, wallet addresses, source choices and signed progress cursors are stored locally per wallet so you can resume after refresh or reconnect. Reset scan removes the connected wallet’s saved progress. No wallet address is put in this site’s URLs, application logs, analytics or a database. O1 discovery sends your address to O1’s wallet index through the server; onchain queries go to the chain provider. Hosting logs depend on the operator’s settings. Signed scan checkpoints survive cursor expiry. Returning refreshes known balances and discovery; unfinished older ranges stay available through Continue scan. A changed chain snapshot or signing key can require a reset.
              </p>
              <p>
                <strong>More adapters come later.</strong> Bags, Flap, pools.trade, PAIR and other
                verified platforms are not included in this first release. pons’ older unreviewed
                stacks, holder dividends and buyback vesting remain outside coverage.
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
  onViewAvailable,
  emptyLabel = "None found",
}: {
  label: string;
  values: FeeRow[];
  wallet: string;
  helper: string;
  icon: React.ReactNode;
  onViewAvailable?: () => void;
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
      {label === "AVAILABLE TO HARVEST" && <a className="harvest-shortcut" href="#fees" onClick={onViewAvailable} aria-label="View claimable fees"><ArrowUpRight size={20} /></a>}
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

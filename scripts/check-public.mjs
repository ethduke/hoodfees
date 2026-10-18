import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const publicCatalog = "lib/fees/catalog.mjs";
export function checkBlob(path, bytes) {
  const violations = [];
  const source = bytes.toString("utf8");
  if (
    /(?:^|\/)(?:node_modules|dist|build|out|local|logs|reports|outputs|coverage|test-results|wallets|credentials|secrets)(?:\/|$)/i.test(
      path,
    ) ||
    /\.(?:md|log|csv|jsonl|sqlite\d*|db|pem|key|p12|pfx|zip|gz|tar|pdf|har|png|jpe?g|webp|mp4)$/i.test(
      path,
    ) ||
    (/(?:^|\/)\.env(?:\.|$)/.test(path) && path !== ".env.example") ||
    (/(?:^|\/)\.[^/]+/.test(path) && ![".gitignore", ".env.example"].includes(path) && !path.startsWith(".githooks/") && path !== ".github/workflows/ci.yml")
  )
    violations.push("excluded file");
  const excludedNames = [["open", "ai"], ["co", "dex"], ["chat", "gpt"]].map((parts) => parts.join(""));
  if (excludedNames.some((name) => path.toLowerCase().includes(name) || source.toLowerCase().includes(name)))
    violations.push("excluded vendor reference");
  if (bytes.length > (/lock\.json$/.test(path) ? 3 * 1024 * 1024 : 512 * 1024))
    violations.push("file too large");
  if (
    /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})/.test(
      source,
    )
  )
    violations.push("credential material");
  if (
    /https?:\/\/[^\s/"'<>]+:[^\s/"'<>]+@|https?:\/\/[^\s"'<>]+[?&](?:api[_-]?key|token|secret|password)=[A-Za-z0-9_%.-]{8,}|https?:\/\/[^\s/"'<>]*(?:infura\.io|alchemy\.com)\/v[23]\/[A-Za-z0-9_-]{12,}/i.test(
      source,
    )
  )
    violations.push("credential-bearing URL");
  if (
    path !== publicCatalog &&
    /\b0x(?:[a-f\d]{40}|[a-f\d]{64}|[a-f\d]{128}|[a-f\d]{130})\b/i.test(source)
  )
    violations.push("unreviewed address, key or capture");
  if (
    /\b(?:password|private[_-]?key|api[_-]?key|access[_-]?token|cursor[_-]?secret|mnemonic|seed[_-]?phrase)\s*[:=]\s*["'`][^"'`\r\n]{8,}["'`]/i.test(
      source,
    )
  )
    violations.push("literal credential assignment");
  if (
    /^(?:app|lib)\//.test(path) &&
    /console\.(?:log|warn|error|debug|info)|process\.(?:stdout|stderr)\.write/.test(source)
  )
    violations.push("application logging");
  // Browser-local scan caching is explicitly supported in this one module.
  if (path !== "lib/wallet/scan-cache.mjs" && /^(?:app|lib)\//.test(path) && /localStorage|sessionStorage|indexedDB/.test(source))
    violations.push("persisted wallet state");
  return violations;
}
export function scanIndex(cwd = process.cwd(), history = false) {
  const git = (args) =>
    execFileSync("git", args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const entries = history
    ? git(["ls-tree", "-r", "HEAD"]).toString().split("\n")
    : git(["ls-files", "--stage"]).toString().split("\n");
  const results = [];
  for (const entry of entries.filter(Boolean)) {
    const [meta, path] = entry.split("\t");
    const [mode, , oidOrStage] = meta.split(" ");
    const oid = history ? oidOrStage : meta.split(" ")[1];
    if (mode === "120000" || mode === "160000") {
      results.push({ path, rules: ["symlink or submodule"] });
      continue;
    }
    const bytes = git(["cat-file", "blob", oid]);
    const rules = checkBlob(path, bytes);
    if (rules.length) results.push({ path, rules });
  }
  return { files: entries.filter(Boolean).length, results };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = scanIndex(process.cwd(), process.argv.includes("--history"));
    if (result.results.length) {
      for (const v of result.results) process.stderr.write(`${v.path}: ${v.rules.join(", ")}\n`);
      process.exitCode = 1;
    } else process.stdout.write(`Public repository check passed (${result.files} files).\n`);
  } catch {
    process.stderr.write(
      "Public repository check could not complete. No file contents were printed.\n",
    );
    process.exitCode = 1;
  }
}

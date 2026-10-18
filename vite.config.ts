import vinext from "vinext";
import { defineConfig } from "vite";
import { execFileSync } from "node:child_process";

export default defineConfig(async () => {
  process.env.WRANGLER_SEND_METRICS = "false";
  process.env.WRANGLER_WRITE_LOGS = "false";
  process.env.WRANGLER_LOG_PATH = ".wrangler/logs";
  process.env.CLOUDFLARE_CF_FETCH_ENABLED = "false";
  process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";
  const { cloudflare } = await import("@cloudflare/vite-plugin");
  const revision = process.env.GITHUB_SHA || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!/^[a-f\d]{40}$/.test(revision)) throw new Error("invalid_build_revision");
  return {
    // Runtime credentials must never be loaded into the deployment build.
    envDir: false as const,
    define: { __RELEASE_SHA__: JSON.stringify(revision) },
    plugins: [vinext(), cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] }, inspectorPort: false })],
  };
});

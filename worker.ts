import handler from "vinext/server/fetch-handler";
import { workerApi } from "./lib/worker-api.mjs";

declare const __RELEASE_SHA__: string;
type Bindings = {
  ROBINHOOD_RPC_URL?: string;
  O1_API_KEY?: string;
  SCAN_CURSOR_SECRET?: string;
  LEGACY_PROGRESS_URL?: string;
};

export default {
  async fetch(request: Request, env: Bindings, context: ExecutionContext) {
    try {
      const api = await workerApi(request, env, __RELEASE_SHA__);
      if (api) return api;
      const url = new URL(request.url);
      if (url.hostname === "www.hoodfees.xyz") {
        url.hostname = "hoodfees.xyz";
        return Response.redirect(url.toString(), 308);
      }
      return await handler.fetch(request, env, context);
    } catch {
      return Response.json({ error: "provider_unavailable" }, { status: 502, headers: { "cache-control": "no-store" } });
    }
  },
};

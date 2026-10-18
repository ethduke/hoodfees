import { scanResponse } from "../../../lib/fees/api.mjs";
export async function POST(request: Request) {
  return scanResponse(request, {
    url: process.env.ROBINHOOD_RPC_URL || undefined,
    secret: process.env.SCAN_CURSOR_SECRET || undefined,
    o1Key: process.env.O1_API_KEY || undefined,
  });
}
export function GET() {
  return new Response(null, {
    status: 405,
    headers: { Allow: "POST", "Cache-Control": "no-store" },
  });
}

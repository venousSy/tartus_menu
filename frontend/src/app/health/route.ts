import { connection } from "next/server";

import { djangoFetch } from "@/lib/server/django";

// Longer than this and the uptime monitor and Docker would rather hear "down" than wait.
const TIMEOUT_MS = 2000;

/**
 * GET /health (system_design.md §3.7): the whole chain in one answer. Nginx sends it here, and this
 * route asks Django's /api/v1/health/, which runs one database query. 200 {"status":"ok"} means
 * Nginx, Next.js, Django and PostgreSQL all answer; anything else is 503. Never cached.
 */
export async function GET() {
  await connection(); // render on every request, never at build time
  let ok = false;
  try {
    const response = await djangoFetch("/health/", { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    ok = response.ok;
  } catch {
    // Django is down, or slower than the timeout.
  }
  return Response.json(ok ? { status: "ok" } : { detail: "Service unavailable." }, {
    status: ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}

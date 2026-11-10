import { connection } from "next/server";

import { djangoFetch } from "@/lib/server/django";

// The qr_token of a table is a UUID; anything else is not one of our codes, so Django is not asked.
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMEOUT_MS = 5000;

/** A temporary redirect with a relative Location, so it keeps the scheme and host the customer used. */
function redirectTo(location: string) {
  return new Response(null, {
    status: 302, // not 301: the slug behind a code can change (UC-ADMIN-006), so browsers must not remember it
    headers: { Location: location, "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" },
  });
}

/**
 * GET /t/<qr_token> (use_cases.md UC-GUEST-003): the permanent short link printed in a table's QR code
 * (GC 4). It asks Django where the code leads now and redirects to /menu/<slug>?table=N, so codes printed
 * before a slug change keep working. An inactive table leads to the menu without a table number (A1);
 * an unknown token goes to the "not valid" page (A3). Counts nothing: the menu page itself is the visit.
 */
export async function GET(_request: Request, { params }: RouteContext<"/t/[token]">) {
  await connection(); // never prerendered or cached: the slug behind a token can change
  const { token } = await params;
  if (!TOKEN.test(token)) return redirectTo("/qr-invalid");

  let response: Response;
  try {
    response = await djangoFetch(`/qr/${token}/`, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    response = new Response(null, { status: 503 });
  }
  if (response.status === 404) return redirectTo("/qr-invalid");
  if (!response.ok) {
    // Django is down: the menu would not open either. Say so instead of claiming the code is invalid.
    return new Response("The menu is temporarily unavailable. Please try again in a minute.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "60" },
    });
  }
  const { slug, table_number: table } = (await response.json()) as { slug: string; table_number: number | null };
  return redirectTo(`/menu/${encodeURIComponent(slug)}${table === null ? "" : `?table=${table}`}`);
}

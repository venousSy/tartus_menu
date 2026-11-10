import { djangoFetch } from "@/lib/server/django";

// A cafe's slug (Django's SlugField). Anything else is not a menu, so Django is not asked.
const SLUG = /^[-a-zA-Z0-9_]+$/;
const TIMEOUT_MS = 3000;

const empty = (status: number) => new Response(null, { status, headers: { "Cache-Control": "no-store" } });

/**
 * POST /menu/<slug>/views (use_cases.md UC-GUEST-004): one menu open, reported by the menu page
 * itself, because the page is cached and Django never sees a customer open it. The body
 * { "table": N or null } goes to Django's public counter unchanged. Nothing about the visitor is
 * passed on: no cookie, no address, no user agent. The browser ignores the answer.
 */
export async function POST(request: Request, { params }: RouteContext<"/menu/[slug]/views">) {
  const { slug } = await params;
  if (!SLUG.test(slug)) return empty(404);
  try {
    const response = await djangoFetch(`/menu/${slug}/views/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: (await request.text()) || "{}",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // 204 counted (or an inactive cafe), 400 a bad table number, 404 an unknown cafe; else Django failed.
    return empty([204, 400, 404].includes(response.status) ? response.status : 503);
  } catch {
    return empty(503); // Django cannot be reached: this open is lost (A5)
  }
}

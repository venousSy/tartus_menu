import "server-only";

/**
 * True when a request comes from a page of our own site. State-changing BFF routes check it in
 * addition to SameSite=Strict cookies (system_design.md §3.6), so another website cannot make a
 * signed-in browser log out or change a password.
 *
 * Browsers send `Origin` with every POST, from fetch() and from forms. A request without it, or with
 * "null" (sandboxed frames, local files), is refused. The comparison is the one Next.js uses for
 * Server Actions: the host in `Origin` against `X-Forwarded-Host` (set by a proxy) or `Host`.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host) {
    return false;
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false; // "null" or another value that is not a URL
  }
}

/** For route handlers: a 403 answer in the DRF error shape when the origin check fails, else null. */
export function rejectCrossOrigin(request: Request): Response | null {
  return isSameOrigin(request) ? null : Response.json({ detail: "Origin check failed." }, { status: 403 });
}

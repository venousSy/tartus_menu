import "server-only";

/**
 * Calls the Django API from the Next.js server. The browser never calls Django directly
 * (system_design.md §3.6): pages and BFF routes go through this function.
 * `path` starts after the API prefix, for example "/menu/tartus-coffee/".
 */
export async function djangoFetch(path: string, init?: RequestInit): Promise<Response> {
  const baseUrl = process.env.DJANGO_API_URL;
  if (!baseUrl) {
    throw new Error("DJANGO_API_URL is not set. Copy frontend/.env.example to frontend/.env.local.");
  }
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Accept: "application/json", ...init?.headers },
  });
}

/**
 * The browser's X-Forwarded-For for a call to Django (§3.6), so Django's login throttle and logs see the
 * visitor's IP, not the Next.js server's. Spread it into the call's headers; it is empty when there is none.
 */
export function forwardedForHeader(forwardedFor: string | null): Record<string, string> {
  return forwardedFor ? { "X-Forwarded-For": forwardedFor } : {};
}

/** Django's 4xx answer for the browser unchanged (status and body), so the form can show Django's messages. */
export function passThrough(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    headers: { "Content-Type": response.headers.get("content-type") ?? "application/json" },
  });
}

import "server-only";

import { djangoFetch } from "@/lib/server/django";
import type { TokenPair } from "@/lib/server/session";

// How long a finished refresh stays remembered. A request that left the browser before the new
// cookies arrived still carries the old refresh token; it gets the same new pair instead of a 401.
// Kept short: during this window the old token still works for this one purpose.
const GRACE_MS = 10_000;

// One entry per old refresh token: the call to Django that is running or has just finished.
// Only proxy.ts refreshes tokens, so this map in one module sees every refresh of the server.
const flights = new Map<string, Promise<TokenPair | null>>();

/**
 * Exchanges a refresh token for a new pair (UC-AUTH-002), at most once per token. Refresh tokens
 * work only once (rotation + blacklist), so parallel requests with the same token must share one
 * call; a second call would get 401 and log the user out (system_design.md §3.6).
 * Resolves to null when Django rejects the token (expired, blacklisted): the session is over.
 * Rejects when Django cannot answer, so an outage never logs anybody out.
 * `forwardedFor` is the X-Forwarded-For header of the request that starts the call (§3.6).
 */
export function refreshOnce(refreshToken: string, forwardedFor: string | null): Promise<TokenPair | null> {
  let flight = flights.get(refreshToken);
  if (!flight) {
    flight = callRefresh(refreshToken, forwardedFor);
    flights.set(refreshToken, flight);
    flight.then(
      () => setTimeout(() => flights.delete(refreshToken), GRACE_MS),
      () => flights.delete(refreshToken), // a failure is not remembered: the next request tries again
    );
  }
  return flight;
}

async function callRefresh(refreshToken: string, forwardedFor: string | null): Promise<TokenPair | null> {
  const response = await djangoFetch("/auth/refresh/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(forwardedFor ? { "X-Forwarded-For": forwardedFor } : {}),
    },
    body: JSON.stringify({ refresh: refreshToken }),
  });
  // 401: expired or blacklisted (UC-AUTH-002 A1, A2). 400: not a token at all.
  if (response.status === 401 || response.status === 400) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`The refresh API answered ${response.status}.`);
  }
  const body = await response.json();
  if (typeof body.access !== "string" || typeof body.refresh !== "string") {
    throw new Error("The refresh API answered without a token pair.");
  }
  return { access: body.access, refresh: body.refresh };
}

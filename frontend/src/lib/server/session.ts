import "server-only";

import type { NextResponse } from "next/server";

// The BFF keeps Django's JWT pair in two cookies that browser scripts cannot read (system_design.md §3.6).
export const ACCESS_COOKIE = "access";
export const REFRESH_COOKIE = "refresh";

export type TokenPair = { access: string; refresh: string };
export type Role = "SYSTEM_ADMIN" | "CAFE_OWNER";

/**
 * Where the cookies are written: `response.cookies` in proxy.ts, `await cookies()` in route
 * handlers and server actions. Server Components cannot set cookies, so they never refresh tokens.
 */
type CookieStore = Pick<NextResponse["cookies"], "set">;

// Browsers accept Secure cookies from http://localhost, so development needs no exception.
const COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: "strict", path: "/" } as const;

// The access cookie disappears this long before its token expires. A missing access cookie then
// means "refresh first", and a request already on its way never reaches Django with a stale token.
const ACCESS_EARLY_EXPIRY_MS = 30_000;

/**
 * The payload of a JWT, decoded WITHOUT checking the signature. That is enough for the BFF's own
 * choices (when to refresh, which dashboard to show): Django checks the signature on every call.
 */
export function readClaims(token: string): { exp?: number; role?: string } {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof claims === "object" && claims !== null ? claims : {};
  } catch {
    return {};
  }
}

/** The role claim Django puts in both tokens (users/serializers.py); anything else is no role. */
export function roleOf(token: string): Role | null {
  const { role } = readClaims(token);
  return role === "SYSTEM_ADMIN" || role === "CAFE_OWNER" ? role : null;
}

function expiresAt(token: string, earlyMs = 0): Date | undefined {
  const { exp } = readClaims(token);
  return typeof exp === "number" ? new Date(exp * 1000 - earlyMs) : undefined;
}

/** Saves a new pair from Django (login or refresh). Each cookie expires together with its token. */
export function saveTokens(store: CookieStore, tokens: TokenPair) {
  store.set(ACCESS_COOKIE, tokens.access, {
    ...COOKIE_OPTIONS,
    expires: expiresAt(tokens.access, ACCESS_EARLY_EXPIRY_MS),
  });
  store.set(REFRESH_COOKIE, tokens.refresh, { ...COOKIE_OPTIONS, expires: expiresAt(tokens.refresh) });
}

/** Ends the browser session: both cookies are replaced by empty ones that expire at once. */
export function clearTokens(store: CookieStore) {
  store.set(ACCESS_COOKIE, "", { ...COOKIE_OPTIONS, maxAge: 0 });
  store.set(REFRESH_COOKIE, "", { ...COOKIE_OPTIONS, maxAge: 0 });
}

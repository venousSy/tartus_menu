import { type NextRequest, NextResponse } from "next/server";

import { refreshOnce } from "@/lib/server/refresh";
import {
  ACCESS_COOKIE,
  clearTokens,
  REFRESH_COOKIE,
  type Role,
  roleOf,
  saveTokens,
  type TokenPair,
} from "@/lib/server/session";

const HOME: Record<Role, string> = { CAFE_OWNER: "/dashboard", SYSTEM_ADMIN: "/admin" };

/**
 * Runs before the signed-in pages and the BFF routes, never before the customer menu (`config`).
 * 1. It is the only caller of refreshOnce (src/lib/server/refresh.ts): when the access cookie has
 *    expired but the refresh cookie has not, it gets a new pair for the browser AND for the page
 *    or route behind it, so they always find a usable access token.
 * 2. Optimistic routing: each visitor lands on the page of their role. "Optimistic" because the
 *    role is read without checking the token's signature; Django still checks every API call.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const access = request.cookies.get(ACCESS_COOKIE)?.value;
  const refresh = request.cookies.get(REFRESH_COOKIE)?.value;

  // undefined: no refresh was needed, or Django could not answer. null: the session is over.
  let tokens: TokenPair | null | undefined;
  if (!access && refresh && pathname !== "/bff/auth/login") {
    try {
      tokens = await refreshOnce(refresh, request.headers.get("x-forwarded-for"));
    } catch {
      // Django is down: keep the cookies (an outage logs nobody out) and go on without access.
    }
  }

  // During an outage the refresh token still tells the role.
  const current = tokens === null ? undefined : (tokens?.access ?? access ?? refresh);
  const role = current ? roleOf(current) : null;
  // Only page visits are redirected. Server Functions are POSTs to the page and check auth themselves.
  const target = request.method === "GET" ? redirectFor(pathname, role) : null;

  let response: NextResponse;
  if (target) {
    response = NextResponse.redirect(new URL(target, request.url));
  } else if (tokens) {
    // The page or route behind the proxy reads the new pair from the request's Cookie header.
    request.cookies.set(ACCESS_COOKIE, tokens.access);
    request.cookies.set(REFRESH_COOKIE, tokens.refresh);
    response = NextResponse.next({ request: { headers: new Headers(request.headers) } });
  } else {
    response = NextResponse.next();
  }

  // Next sends these Set-Cookie headers before the route handler's own, so a handler that clears
  // the cookies (logout, change-password) still has the last word in the browser.
  if (tokens) {
    saveTokens(response.cookies, tokens);
  } else if (tokens === null) {
    clearTokens(response.cookies);
  }
  return response;
}

/** Where a visitor must go instead of `pathname` (role null: not logged in), or null to stay. */
function redirectFor(pathname: string, role: Role | null): string | null {
  if (pathname.startsWith("/bff/")) {
    return null; // BFF routes answer 401 themselves
  }
  if (pathname === "/login") {
    return role ? HOME[role] : null;
  }
  if (!role) {
    return "/login";
  }
  const home = HOME[role];
  return pathname === home || pathname.startsWith(`${home}/`) ? null : home;
}

export const config = {
  matcher: ["/login", "/dashboard/:path*", "/admin/:path*", "/bff/:path*"],
};

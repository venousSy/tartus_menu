import { cookies } from "next/headers";

import { djangoFetch, forwardedForHeader, passThrough } from "@/lib/server/django";
import { rejectCrossOrigin } from "@/lib/server/origin";
import { ACCESS_COOKIE, clearTokens, REFRESH_COOKIE } from "@/lib/server/session";

/**
 * POST /bff/auth/change-password: UC-AUTH-004 through the BFF (system_design.md §3.6). The browser
 * sends { old_password, new_password } as JSON. On success Django blacklists every refresh token of
 * the user, so the BFF clears both cookies too: the user logs in again with the new password.
 */
export async function POST(request: Request) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) {
    return rejected;
  }

  const cookieStore = await cookies();
  const access = cookieStore.get(ACCESS_COOKIE)?.value;
  if (!access) {
    // proxy.ts removes both cookies when the session is over. A refresh cookie without an access
    // cookie means Django could not be reached for the refresh: an outage logs nobody out.
    if (cookieStore.has(REFRESH_COOKIE)) {
      return Response.json({ detail: "The server could not be reached." }, { status: 503 });
    }
    // UC-AUTH-004 A5 with DRF's own message, so the page gets one answer for "not logged in".
    return Response.json({ detail: "Authentication credentials were not provided." }, { status: 401 });
  }

  // The body goes to Django unchanged: its serializer checks both passwords.
  const response = await djangoFetch("/auth/change-password/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access}`,
      "Content-Type": "application/json",
      ...forwardedForHeader(request.headers.get("x-forwarded-for")),
    },
    body: await request.text(),
  });

  if (response.ok) {
    clearTokens(cookieStore);
    return new Response(null, { status: 204 });
  }
  // 400 wrong old password, weak or unchanged new password, missing fields; 401 rejected access
  // token (A1-A5): same status and body, so the form can show Django's messages. The cookies stay.
  if (response.status >= 400 && response.status < 500) {
    return passThrough(response);
  }
  throw new Error(`The change-password API answered ${response.status}.`);
}

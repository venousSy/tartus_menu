import { cookies } from "next/headers";

import { djangoFetch } from "@/lib/server/django";
import { rejectCrossOrigin } from "@/lib/server/origin";
import { ACCESS_COOKIE, clearTokens } from "@/lib/server/session";

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
    // UC-AUTH-004 A5 with DRF's own message, so the page gets one answer for "not logged in".
    return Response.json({ detail: "Authentication credentials were not provided." }, { status: 401 });
  }

  // The body goes to Django unchanged: its serializer checks both passwords.
  const forwardedFor = request.headers.get("x-forwarded-for");
  const response = await djangoFetch("/auth/change-password/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access}`,
      "Content-Type": "application/json",
      ...(forwardedFor ? { "X-Forwarded-For": forwardedFor } : {}),
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
    return new Response(response.body, {
      status: response.status,
      headers: { "Content-Type": response.headers.get("content-type") ?? "application/json" },
    });
  }
  throw new Error(`The change-password API answered ${response.status}.`);
}

import { cookies } from "next/headers";

import { djangoFetch } from "@/lib/server/django";
import { rejectCrossOrigin } from "@/lib/server/origin";
import { ACCESS_COOKIE, clearTokens, REFRESH_COOKIE } from "@/lib/server/session";

/**
 * POST /bff/auth/logout: UC-AUTH-003 through the BFF (system_design.md §3.6). The browser forgets
 * both tokens whatever Django answers, so a click on "Logout" always logs out. Answers 205 like the API.
 */
export async function POST(request: Request) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) {
    return rejected;
  }

  const cookieStore = await cookies();
  const access = cookieStore.get(ACCESS_COOKIE)?.value;
  const refresh = cookieStore.get(REFRESH_COOKIE)?.value;
  clearTokens(cookieStore);

  // Django needs a valid access token for this call (IsAuthenticated). Without one, the refresh
  // token is only forgotten, not blacklisted; it still expires within a day.
  if (access && refresh) {
    await revoke(access, refresh, request.headers.get("x-forwarded-for"));
  }
  return new Response(null, { status: 205 });
}

/** Blacklists the refresh token, so a copy of it can never be used. Failures are only logged. */
async function revoke(access: string, refresh: string, forwardedFor: string | null) {
  try {
    const response = await djangoFetch("/auth/logout/", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json",
        ...(forwardedFor ? { "X-Forwarded-For": forwardedFor } : {}),
      },
      body: JSON.stringify({ refresh }),
    });
    // 400: the token was already unusable (UC-AUTH-003 A1), so nothing is left to revoke.
    if (!response.ok && response.status !== 400) {
      console.error(`The logout API answered ${response.status}.`);
    }
  } catch (error) {
    console.error("The logout API could not be reached.", error);
  }
}

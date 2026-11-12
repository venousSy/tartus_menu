import { djangoFetch, forwardedForHeader, passThrough } from "@/lib/server/django";
import { rejectCrossOrigin } from "@/lib/server/origin";

/**
 * POST /bff/auth/forgot-password: UC-AUTH-006 through the BFF (system_design.md §3.6). The "Forgot
 * password?" page sends { email } as JSON. The caller has no session, and none starts: no cookie is
 * read, set or cleared. Django answers 204 for every well-formed address, with or without an account.
 */
export async function POST(request: Request) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) {
    return rejected;
  }

  // The body goes to Django unchanged. X-Forwarded-For too, so the throttle counts the browser's IP, not ours.
  const response = await djangoFetch("/auth/password-reset/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...forwardedForHeader(request.headers.get("x-forwarded-for")),
    },
    body: await request.text(),
  });

  if (response.ok) {
    return new Response(null, { status: 204 });
  }
  // 400 malformed address, 429 too many requests (A3, A4): same status, body and headers.
  // So is the 503 that says the server has no mail settings (A5); any other 5xx is a real failure.
  const noMail = response.status === 503 && response.headers.get("x-error-code") === "email_not_configured";
  if ((response.status >= 400 && response.status < 500) || noMail) {
    return passThrough(response);
  }
  throw new Error(`The password-reset email API answered ${response.status}.`);
}

import { djangoFetch, forwardedForHeader, passThrough } from "@/lib/server/django";
import { rejectCrossOrigin } from "@/lib/server/origin";

/**
 * POST /bff/auth/password-reset: UC-AUTH-005 through the BFF (system_design.md §3.6). The reset page
 * sends { uid, token, new_password } as JSON; uid and token are the two parts of the link after "#".
 * The caller has no session, and a success starts none: no cookie is read, set or cleared. The owner
 * logs in with the new password afterwards.
 */
export async function POST(request: Request) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) {
    return rejected;
  }

  // The body goes to Django unchanged: it checks the link and the password rules.
  // X-Forwarded-For too, so the reset throttle counts the browser's IP, not ours.
  const response = await djangoFetch("/auth/password-reset/confirm/", {
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
  // 400 invalid link or weak password, 429 too many attempts (A1-A4): same status, body and headers.
  if (response.status >= 400 && response.status < 500) {
    return passThrough(response);
  }
  throw new Error(`The password-reset API answered ${response.status}.`);
}

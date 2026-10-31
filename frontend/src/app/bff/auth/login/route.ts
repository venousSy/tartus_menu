import { cookies } from "next/headers";

import { djangoFetch } from "@/lib/server/django";
import { rejectCrossOrigin } from "@/lib/server/origin";
import { saveTokens } from "@/lib/server/session";

/**
 * POST /bff/auth/login: UC-AUTH-001 through the BFF (system_design.md §3.6). The browser sends
 * { email, password } as JSON. The JWT pair goes into HttpOnly cookies, and the browser gets only
 * { role }, which the login page needs to open /dashboard or /admin.
 */
export async function POST(request: Request) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) {
    return rejected;
  }

  // The body goes to Django unchanged: its serializer is the only place that validates it.
  // X-Forwarded-For too, so the login throttle counts the browser's IP, not ours.
  const forwardedFor = request.headers.get("x-forwarded-for");
  const response = await djangoFetch("/auth/login/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(forwardedFor ? { "X-Forwarded-For": forwardedFor } : {}),
    },
    body: await request.text(),
  });

  // 400 missing fields, 401 wrong credentials or inactive account, 429 too many attempts
  // (UC-AUTH-001 A1-A4): same status and body, so the login page can show Django's message.
  if (response.status >= 400 && response.status < 500) {
    return new Response(response.body, {
      status: response.status,
      headers: { "Content-Type": response.headers.get("content-type") ?? "application/json" },
    });
  }
  if (!response.ok) {
    throw new Error(`The login API answered ${response.status}.`);
  }

  const body = await response.json();
  if (typeof body.access !== "string" || typeof body.refresh !== "string") {
    throw new Error("The login API answered without a token pair.");
  }
  saveTokens(await cookies(), { access: body.access, refresh: body.refresh });
  return Response.json({ role: body.role });
}

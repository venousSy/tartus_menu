import { NextResponse } from "next/server";

import { clearTokens } from "@/lib/server/session";

/**
 * GET /bff/auth/session-ended: where a dashboard page goes when Django no longer accepts the access
 * token (owner-api.ts), for example because the account was deactivated. It clears both cookies and
 * opens /login?ended=1, where the form says that the session ended. A page cannot do this itself:
 * rendering cannot change cookies, and with the old access cookie proxy.ts would send /login straight
 * back to the dashboard.
 */
export function GET(request: Request) {
  // Only our own pages send users here. A link on another site must not log anyone out, nor make
  // the login page claim that a session ended.
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return new NextResponse(null, { status: 303, headers: { Location: "/login" } });
  }
  const response = new NextResponse(null, { status: 303, headers: { Location: "/login?ended=1" } });
  clearTokens(response.cookies);
  return response;
}

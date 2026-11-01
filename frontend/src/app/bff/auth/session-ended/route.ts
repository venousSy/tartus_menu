import { NextResponse } from "next/server";

import { clearTokens } from "@/lib/server/session";

/**
 * GET /bff/auth/session-ended: where a dashboard page goes when Django no longer accepts the access
 * token (owner-api.ts), for example because the account was deactivated. It clears both cookies and
 * opens /login. A page cannot do this itself: rendering cannot change cookies, and with the old
 * access cookie proxy.ts would send /login straight back to the dashboard.
 */
export function GET(request: Request) {
  const response = new NextResponse(null, { status: 303, headers: { Location: "/login" } });
  // Only our own pages send users here. A link on another site must not log anyone out.
  if (request.headers.get("sec-fetch-site") !== "cross-site") {
    clearTokens(response.cookies);
  }
  return response;
}

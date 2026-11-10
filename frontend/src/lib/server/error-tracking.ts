import type { ErrorEvent } from "@sentry/nextjs";

// Request headers that carry credentials or a visitor's address.
const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "x-revalidate-secret", "x-forwarded-for"]);

/**
 * beforeSend hook of the server SDK (src/instrumentation.ts, system_design.md §5 "Error Tracking"): drop the
 * request body, the cookies and the sensitive headers before an error leaves the server. The SDK already
 * leaves most of them out with sendDefaultPii: false; this makes it certain. The same rule as Django's
 * core/error_tracking.py.
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const request = event.request;
  if (request) {
    delete request.data;
    delete request.cookies;
    if (request.headers) {
      request.headers = Object.fromEntries(
        Object.entries(request.headers).filter(([name]) => !SENSITIVE_HEADERS.has(name.toLowerCase())),
      );
    }
  }
  return event;
}

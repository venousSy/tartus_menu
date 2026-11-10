import * as Sentry from "@sentry/nextjs";

import { scrubEvent } from "@/lib/server/error-tracking";

/**
 * Error tracking with Sentry or GlitchTip (system_design.md §5 "Error Tracking"), on the Next.js server only:
 * nothing is added to the pages a customer downloads. Only when SENTRY_DSN is set, so development, tests
 * and CI send nothing. Errors only (no tracing), no personal data, every event through scrubEvent().
 */
export function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.SENTRY_DSN) {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      release: process.env.SENTRY_RELEASE || undefined,
      environment: process.env.SENTRY_ENVIRONMENT || "production",
      // SDK 11 collects all of these by default; none of them is needed to fix an error, and some hold
      // tokens, cookies or what a customer typed (local variables included).
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        stackFrameVariables: false,
      },
      tracesSampleRate: 0,
      beforeSend: scrubEvent,
    });
  }
}

// Next.js calls this for every error thrown while rendering a page or running a route handler or a
// Server Action. Without an initialised SDK it does nothing.
export const onRequestError = Sentry.captureRequestError;

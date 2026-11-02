"use client";

import { catchError, type ErrorInfo } from "next/error";
import { useTranslations } from "next-intl";
import { useTransition } from "react";

/**
 * The dashboard's error screen, shown in place of a screen whose data could not be read: an
 * OwnerApiError (Django unreachable, a server error) or any other failure while rendering. In
 * production Next hides an error's details from the browser, so the text is the same for all.
 * redirect() also works by throwing, but catchError lets it pass.
 */
function LoadError(_props: object, { retry }: ErrorInfo) {
  const t = useTranslations("Dashboard");
  const [pending, startTransition] = useTransition();
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-900">
      <p>{t("loadError")}</p>
      {/* retry() asks the server for the screen again and shows it if that works. */}
      <button type="button" disabled={pending} onClick={() => startTransition(retry)}
        className="min-h-11 rounded-lg border border-red-300 bg-white px-4 text-sm font-semibold disabled:opacity-60">
        {t("retry")}
      </button>
    </div>
  );
}

export const RetryBoundary = catchError(LoadError);

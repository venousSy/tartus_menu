"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { type FormError, SERVER_ERROR, toFormError } from "@/lib/api-errors";
import { FormAlert, PRIMARY_BUTTON, TextField } from "../ui/form-parts";

// `minutes`: the wait after too many requests. `sent`: Django took the request (it never says whether
// an account exists). `email` refills the field: React resets a form after its action.
type ForgotState = { error: FormError | null; minutes?: number; sent?: boolean; email?: string };

/** Sends the address to the BFF route /bff/auth/forgot-password (UC-AUTH-006). */
async function askForLink(formData: FormData): Promise<ForgotState> {
  const email = String(formData.get("email") ?? "");
  let response: Response;
  try {
    response = await fetch("/bff/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
  } catch {
    return { error: SERVER_ERROR, email }; // no network, or the server is down
  }
  if (response.ok) return { error: null, sent: true };
  if (response.status === 429) {
    // A4: DRF names the wait in Retry-After (seconds, up to an hour); Nginx's own 429 has none: one minute.
    const wait = Number(response.headers.get("retry-after"));
    return { error: null, minutes: Number.isInteger(wait) && wait > 0 ? Math.ceil(wait / 60) : 1, email };
  }
  // 400: a malformed address (A3). 503 with a code: the server sends no email (A5).
  if (response.status !== 400 && response.status !== 503) return { error: SERVER_ERROR, email };
  return { error: toFormError(await response.json().catch(() => null), response.headers.get("x-error-code")), email };
}

/**
 * The "Forgot password?" form. After a request it shows one message for every address: whether an
 * account exists must stay unknown to the visitor.
 */
export function ForgotForm() {
  const t = useTranslations("ForgotPassword");
  const [state, formAction, pending] = useActionState(
    async (_previous: ForgotState, formData: FormData): Promise<ForgotState> => askForLink(formData),
    { error: null },
  );

  if (state.sent) {
    return (
      <div className="mx-auto mt-12 flex max-w-sm flex-col gap-3 px-4">
        <p role="status" className="font-semibold text-green-800">{t("sent")}</p>
        <p className="text-sm text-stone-600">{t("sentHint")}</p>
        <a href="/login" className={`${PRIMARY_BUTTON} flex items-center self-start`}>{t("backToLogin")}</a>
      </div>
    );
  }
  return (
    <form action={formAction} className="mx-auto mt-12 flex max-w-sm flex-col gap-3 px-4">
      <p>{t("intro")}</p>
      <TextField label={t("email")} name="email" inputMode="email" required maxLength={255}
        defaultValue={state.email ?? ""} messages={state.error?.fields.email} />
      <FormAlert error={state.error} />
      {state.minutes !== undefined && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{t("throttled", { minutes: state.minutes })}</p>
      )}
      <button type="submit" disabled={pending} className={`${PRIMARY_BUTTON} self-start`}>
        {pending ? t("sending") : t("send")}
      </button>
      <a href="/login" className="self-start text-sm underline">{t("backToLogin")}</a>
    </form>
  );
}

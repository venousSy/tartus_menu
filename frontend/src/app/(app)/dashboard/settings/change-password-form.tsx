"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { type FormError, SERVER_ERROR, toFormError } from "@/lib/api-errors";
import { FormAlert, PRIMARY_BUTTON, TextField } from "../form-parts";

// `mismatch`: the two new passwords differ (checked here, Django never sees them). `changed`: done.
type PasswordState = { error: FormError | null; mismatch?: boolean; changed?: boolean };

/**
 * Sends the passwords to the BFF route /bff/auth/change-password (UC-AUTH-004), not to a Server
 * Action: on success that route clears the token cookies, because Django has blacklisted every
 * refresh token of the user and the user must log in again.
 */
async function changePassword(formData: FormData): Promise<PasswordState> {
  const text = (name: string) => String(formData.get(name) ?? "");
  // A typo in the new password would lock the owner out after the change: it must be typed twice.
  if (text("new_password") !== text("new_password_again")) return { error: null, mismatch: true };
  let response: Response;
  try {
    response = await fetch("/bff/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ old_password: text("old_password"), new_password: text("new_password") }),
    });
  } catch {
    return { error: SERVER_ERROR }; // no network, or the server is down
  }
  if (response.ok) return { error: null, changed: true };
  if (response.status === 401) {
    // A5: the session is over. Same way out as a dashboard page (D2): clear the cookies, then /login.
    window.location.replace("/bff/auth/session-ended");
    return { error: null };
  }
  // A1-A4: Django's field messages (old_password, new_password); anything else is a server error.
  return { error: response.status === 400 ? toFormError(await response.json().catch(() => null)) : SERVER_ERROR };
}

/**
 * Changes the password of the signed-in user. It works for an inactive cafe too: auth endpoints
 * never check the subscription (GC 5). Passwords are never refilled: React empties the form after
 * every try.
 */
export function ChangePasswordForm() {
  const t = useTranslations("Password");
  const [state, formAction, pending] = useActionState(
    (_previous: PasswordState, formData: FormData) => changePassword(formData),
    { error: null },
  );
  if (state.changed) {
    return (
      <div className="flex flex-col gap-3">
        <p role="status" className="font-semibold text-green-800">{t("changed")}</p>
        {/* A full page load: the cookies are gone, so the dashboard's pages must not stay in memory. */}
        <a href="/login" className={`${PRIMARY_BUTTON} flex items-center self-start`}>{t("logIn")}</a>
      </div>
    );
  }
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <TextField label={t("current")} name="old_password" password="current-password" required defaultValue=""
        messages={state.error?.fields.old_password} />
      <TextField label={t("new")} name="new_password" password="new-password" required defaultValue=""
        messages={state.error?.fields.new_password} />
      <TextField label={t("newAgain")} name="new_password_again" password="new-password" required defaultValue=""
        messages={state.mismatch ? [{ text: t("mismatch") }] : undefined} />
      <p className="text-sm text-stone-600">{t("hint")}</p>
      <FormAlert error={state.error} />
      <button type="submit" disabled={pending} className={`${PRIMARY_BUTTON} self-start`}>
        {pending ? t("changing") : t("change")}
      </button>
    </form>
  );
}

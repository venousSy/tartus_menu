"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useSyncExternalStore } from "react";
import { type FormError, SERVER_ERROR, toFormError } from "@/lib/api-errors";
import { FormAlert, PRIMARY_BUTTON, TextField } from "../ui/form-parts";

/** The two parts of a reset link after "#": <uid>.<token> (UC-ADMIN-010). */
type Link = { uid: string; token: string };

// Read once per page load and kept here: the address bar is cleaned right after, and a second
// render (a language switch, React's development double render) must still find the link.
// undefined: not read yet (the server render). null: the address holds no link.
let captured: Link | null | undefined;
const noSubscription = () => () => {};
function readLink(): Link | null {
  if (captured === undefined) {
    const [uid, token, ...rest] = window.location.hash.slice(1).split(".");
    captured = uid && token && rest.length === 0 ? { uid, token } : null;
  }
  return captured;
}

// `mismatch`: the two passwords differ (checked here). `seconds`: the wait after too many tries. `done`: saved.
type ResetState = { error: FormError | null; mismatch?: boolean; seconds?: number; done?: boolean };

const INVALID_LINK: FormError = { form: { key: "resetLinkInvalid" }, fields: {} };

/** Sends the link and the new password to the BFF route /bff/auth/password-reset (UC-AUTH-005). */
async function resetPassword(link: Link, formData: FormData): Promise<ResetState> {
  const text = (name: string) => String(formData.get(name) ?? "");
  // A typo would lock the owner out again, and the link is gone after one use: typed twice.
  if (text("new_password") !== text("new_password_again")) return { error: null, mismatch: true };
  let response: Response;
  try {
    response = await fetch("/bff/auth/password-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...link, new_password: text("new_password") }),
    });
  } catch {
    return { error: SERVER_ERROR }; // no network, or the server is down
  }
  if (response.ok) return { error: null, done: true };
  if (response.status === 429) {
    // A3: DRF names the wait in Retry-After; Nginx's own 429 has none: one minute, its rate window.
    const wait = Number(response.headers.get("retry-after"));
    return { error: null, seconds: Number.isInteger(wait) && wait > 0 ? wait : 60 };
  }
  if (response.status !== 400) return { error: SERVER_ERROR };
  const error = toFormError(await response.json().catch(() => null), response.headers.get("x-error-code"));
  // A link cut while copying sends an empty uid or token: for the owner that is an invalid link too.
  return { error: error.fields.uid || error.fields.token ? INVALID_LINK : error };
}

/**
 * The new-password form of a reset link. Without a link in the address it only explains what to do.
 * Passwords are never refilled: React empties the form after every try.
 */
export function ResetForm() {
  const t = useTranslations("ResetPassword");
  const link = useSyncExternalStore(noSubscription, readLink, () => undefined);
  useEffect(() => {
    // The link is in memory now: take it out of the address bar, so it is not left in the history
    // of a shared computer or copied by accident.
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
  }, []);
  const [state, formAction, pending] = useActionState(
    async (_previous: ResetState, formData: FormData): Promise<ResetState> =>
      link ? resetPassword(link, formData) : { error: INVALID_LINK },
    { error: null },
  );

  if (link === undefined) return null; // the server render: the link is known only in the browser
  if (state.done) {
    return (
      <div className="mx-auto mt-12 flex max-w-sm flex-col gap-3 px-4">
        <p role="status" className="font-semibold text-green-800">{t("done")}</p>
        <a href="/login" className={`${PRIMARY_BUTTON} flex items-center self-start`}>{t("logIn")}</a>
      </div>
    );
  }
  if (link === null) {
    return <p role="alert" className="mx-auto mt-12 max-w-sm px-4 text-red-800">{t("noLink")}</p>;
  }
  return (
    <form action={formAction} className="mx-auto mt-12 flex max-w-sm flex-col gap-3 px-4">
      <p>{t("intro")}</p>
      <TextField label={t("new")} name="new_password" password="new-password" required defaultValue=""
        messages={state.error?.fields.new_password} />
      <TextField label={t("newAgain")} name="new_password_again" password="new-password" required defaultValue=""
        messages={state.mismatch ? [{ text: t("mismatch") }] : undefined} />
      <p className="text-sm text-stone-600">{t("hint")}</p>
      <FormAlert error={state.error} />
      {state.seconds !== undefined && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{t("throttled", { seconds: state.seconds })}</p>
      )}
      <button type="submit" disabled={pending} className={`${PRIMARY_BUTTON} self-start`}>
        {pending ? t("saving") : t("save")}
      </button>
    </form>
  );
}

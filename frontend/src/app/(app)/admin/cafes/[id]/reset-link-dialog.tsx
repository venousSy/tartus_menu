"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { formatDateTime, toLang } from "@/lib/i18n";
import { CancelButton, DialogButton } from "../../../ui/dialog-button";
import { FormAlert, PRIMARY_BUTTON } from "../../../ui/form-parts";
import { createResetLink, type ResetLinkState } from "../actions";

const IDLE: ResetLinkState = { error: null };

/**
 * Makes a one-time password reset link for the cafe's owner (UC-ADMIN-010) and shows it with a Copy
 * button. The system sends nothing: the admin passes the link on, for example by WhatsApp.
 */
export function ResetLinkDialog({ id, email }: { id: number; email: string }) {
  const t = useTranslations("AdminCafe");
  return (
    <DialogButton label={t("resetLink")} title={t("resetLinkTitle")}>
      <ResetLinkForm id={id} email={email} />
    </DialogButton>
  );
}

/** The dialog's form; each opening renders it anew (DialogButton), so an old link is never shown again. */
function ResetLinkForm({ id, email }: { id: number; email: string }) {
  const t = useTranslations("AdminCafe");
  const lang = toLang(useLocale());
  const [state, formAction, pending] = useActionState(createResetLink, IDLE);
  const [copied, setCopied] = useState(false);
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={id} />
      <p>{t.rich("resetLinkText", { email, mail: (chunks) => <bdi dir="ltr" className="font-semibold">{chunks}</bdi> })}</p>
      {state.link ? (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-sm font-semibold">{t("resetLinkLabel")}</span>
            <input readOnly dir="ltr" value={state.link.url} onFocus={(event) => event.currentTarget.select()}
              className="min-h-11 rounded-lg border border-stone-300 bg-stone-50 px-3 font-mono text-sm" />
          </label>
          <p className="text-sm text-stone-600">{t("resetLinkExpires", { date: formatDateTime(state.link.expires_at, lang) })}</p>
          <p className="text-sm text-amber-900">{t("resetLinkWarning")}</p>
          <p role="status" className="text-sm font-semibold text-green-800">{copied ? t("resetLinkCopied") : ""}</p>
        </>
      ) : (
        <p className="text-sm text-stone-600">{t("resetLinkHint")}</p>
      )}
      <FormAlert error={state.error} />
      <div className="flex justify-end gap-2">
        <CancelButton />
        {state.link ? (
          <button type="button" className={PRIMARY_BUTTON}
            onClick={() => navigator.clipboard.writeText(state.link!.url).then(() => setCopied(true), () => setCopied(false))}>
            {t("resetLinkCopy")}
          </button>
        ) : (
          <button type="submit" disabled={pending} className={PRIMARY_BUTTON}>
            {pending ? t("resetLinkCreating") : t("resetLinkCreate")}
          </button>
        )}
      </div>
    </form>
  );
}

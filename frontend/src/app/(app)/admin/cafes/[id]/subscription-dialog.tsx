"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef } from "react";
import { CancelButton, DialogButton } from "../../../ui/dialog-button";
import { DANGER_BUTTON, DateField, FormAlert, PRIMARY_BUTTON, TextField } from "../../../ui/form-parts";
import { changeSubscription, renewSubscription, type SubscriptionState } from "../actions";

const IDLE: SubscriptionState = { error: null };

/** The billing notes Django accepts (SubscriptionChangeSerializer, UC-ADMIN-004 A4). */
const NOTES_MAX_LENGTH = 500;

/** The dates a subscription form starts from: today in the business time zone, and the proposed last paid day. */
type Dates = { today: string; proposed: string };

/**
 * Activate (UC-ADMIN-004) or Deactivate (UC-ADMIN-005), whichever changes the cafe's current state,
 * in a dialog that says what will happen and takes optional notes for the billing log. An
 * activation also takes the last paid day (GC 5).
 */
export function SubscriptionDialog({ id, active, dates }: { id: number; active: boolean; dates: Dates }) {
  const t = useTranslations("AdminCafe");
  const change = active ? "deactivate" : "activate";
  return (
    <DialogButton label={t(change)} title={t(`${change}Title`)}>
      <SubscriptionForm id={id} change={change} dates={dates} />
    </DialogButton>
  );
}

/** Renew (UC-ADMIN-011): a later last paid day for an active cafe, with optional notes. */
export function RenewDialog({ id, dates }: { id: number; dates: Dates }) {
  const t = useTranslations("AdminCafe");
  return (
    <DialogButton label={t("renew")} title={t("renewTitle")}>
      <SubscriptionForm id={id} change="renew" dates={dates} />
    </DialogButton>
  );
}

/** The dialog's form. It closes after a success; the page then shows the new state and billing event. */
function SubscriptionForm({ id, change, dates }: { id: number; change: "activate" | "deactivate" | "renew"; dates: Dates }) {
  const t = useTranslations("AdminCafe");
  const tForms = useTranslations("Forms");
  const form = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState(change === "renew" ? renewSubscription : changeSubscription, IDLE);
  useEffect(() => {
    if (state.saved) form.current?.closest("dialog")?.close();
  }, [state]);
  return (
    <form ref={form} action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={id} />
      {change !== "renew" && <input type="hidden" name="change" value={change} />}
      <p>{t(`${change}Text`)}</p>
      {change !== "deactivate" && (
        <>
          <DateField label={t("expiresOn")} name="expires_on" min={dates.today}
            defaultValue={state.expiresOn ?? dates.proposed} messages={state.error?.fields.expires_on} />
          <p className="text-sm text-stone-600">{t("expiresOnHint")}</p>
        </>
      )}
      <TextField label={t("notes")} name="notes" lang="auto" multiline maxLength={NOTES_MAX_LENGTH}
        defaultValue={state.notes ?? ""} messages={state.error?.fields.notes} />
      <p className="text-sm text-stone-600">{t("notesHint")}</p>
      <FormAlert error={state.error} />
      <div className="flex justify-end gap-2">
        <CancelButton />
        <button type="submit" disabled={pending} className={change === "deactivate" ? DANGER_BUTTON : PRIMARY_BUTTON}>
          {pending ? tForms("saving") : t(`${change}Confirm`)}
        </button>
      </div>
    </form>
  );
}

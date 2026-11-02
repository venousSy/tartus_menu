"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef } from "react";
import { CancelButton, DialogButton } from "../../../ui/dialog-button";
import { DANGER_BUTTON, FormAlert, PRIMARY_BUTTON, TextField } from "../../../ui/form-parts";
import { changeSubscription, type SubscriptionState } from "../actions";

const IDLE: SubscriptionState = { error: null };

/** The billing notes Django accepts (SubscriptionChangeSerializer, UC-ADMIN-004 A4). */
const NOTES_MAX_LENGTH = 500;

/**
 * Activate (UC-ADMIN-004) or Deactivate (UC-ADMIN-005), whichever changes the cafe's current state,
 * in a dialog that says what will happen and takes optional notes for the billing log.
 */
export function SubscriptionDialog({ id, active }: { id: number; active: boolean }) {
  const t = useTranslations("AdminCafe");
  const change = active ? "deactivate" : "activate";
  return (
    <DialogButton label={t(change)} title={t(`${change}Title`)}>
      <SubscriptionForm id={id} change={change} />
    </DialogButton>
  );
}

/** The dialog's form. It closes after a success; the page then shows the new state and billing event. */
function SubscriptionForm({ id, change }: { id: number; change: "activate" | "deactivate" }) {
  const t = useTranslations("AdminCafe");
  const tForms = useTranslations("Forms");
  const form = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState(changeSubscription, IDLE);
  useEffect(() => {
    if (state.saved) form.current?.closest("dialog")?.close();
  }, [state]);
  return (
    <form ref={form} action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="change" value={change} />
      <p>{t(`${change}Text`)}</p>
      <TextField label={t("notes")} name="notes" lang="auto" multiline maxLength={NOTES_MAX_LENGTH}
        defaultValue={state.notes ?? ""} messages={state.error?.fields.notes} />
      <p className="text-sm text-stone-600">{t("notesHint")}</p>
      <FormAlert error={state.error} />
      <div className="flex justify-end gap-2">
        <CancelButton />
        <button type="submit" disabled={pending} className={change === "activate" ? PRIMARY_BUTTON : DANGER_BUTTON}>
          {pending ? tForms("saving") : t(`${change}Confirm`)}
        </button>
      </div>
    </form>
  );
}

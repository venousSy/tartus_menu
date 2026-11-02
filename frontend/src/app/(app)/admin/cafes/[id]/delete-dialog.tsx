"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import type { BilingualText } from "@/lib/i18n";
import { CancelButton, DialogButton } from "../../../ui/dialog-button";
import { BilingualName, DANGER_BUTTON, FormAlert } from "../../../ui/form-parts";
import { type DeleteCafeState, deleteCafe } from "../actions";

const IDLE: DeleteCafeState = { error: null };

/**
 * The Delete button and its confirm dialog (UC-ADMIN-007: "Admin confirms deletion in a dialog").
 * The dialog names the cafe and everything that goes with it, because the delete cannot be undone.
 * The focus starts on Cancel, so a quick Enter does not delete.
 */
export function DeleteDialog({ id, name, slug }: { id: number; name: BilingualText; slug: string }) {
  const t = useTranslations("AdminCafe");
  return (
    <DialogButton label={t("delete")} title={t("deleteTitle")}>
      <DeleteForm id={id} name={name} slug={slug} />
    </DialogButton>
  );
}

/** The dialog's form; each opening renders it anew (DialogButton), so an old error is gone. */
function DeleteForm({ id, name, slug }: { id: number; name: BilingualText; slug: string }) {
  const t = useTranslations("AdminCafe");
  const [state, formAction, pending] = useActionState(deleteCafe, IDLE);
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={id} />
      <div className="flex flex-col gap-1 rounded-lg bg-stone-100 px-3 py-2">
        <BilingualName name={name} />
        <bdi dir="ltr" className="self-start font-mono text-sm">{slug}</bdi>
      </div>
      <p>{t("deleteWarning")}</p>
      <FormAlert error={state.error} />
      <div className="flex justify-end gap-2">
        <CancelButton />
        <button type="submit" disabled={pending} className={DANGER_BUTTON}>
          {pending ? t("deleting") : t("deleteConfirm")}
        </button>
      </div>
    </form>
  );
}

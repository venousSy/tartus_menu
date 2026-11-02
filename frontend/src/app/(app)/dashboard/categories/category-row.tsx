"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState, useEffect, useRef } from "react";
import { pickText, toLang } from "@/lib/i18n";
import type { ActionState } from "@/lib/server/owner-actions";
import type { Category } from "@/lib/server/owner-api";
import { CancelButton, DialogButton } from "../dialog-button";
import { BilingualName, DANGER_BUTTON, FormAlert, NameFields, PRIMARY_BUTTON, SECONDARY_BUTTON } from "../form-parts";
import { SortableRow } from "../sortable-list";
import { deleteCategory, type NameFormState, renameCategory, setCategoryVisibility } from "./actions";

const IDLE: ActionState = { error: null };
const NAME_IDLE: NameFormState = { error: null };

/**
 * One category and what the owner can do with it: move it by its handle (UC-OWNER-003), rename,
 * hide or show, delete (UC-OWNER-001).
 */
export function CategoryRow({ category, movable }: { category: Category; movable: boolean }) {
  const t = useTranslations("Categories");
  const name = pickText(category.name, toLang(useLocale()));
  const [visibility, visibilityAction, visibilityPending] = useActionState(setCategoryVisibility, IDLE);
  return (
    <SortableRow id={category.id} name={name} movable={movable} roleDescription={t("dragRole")}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-2">
          <BilingualName name={category.name} />
          {!category.is_visible && (
            <span className="rounded-full bg-stone-200 px-2 text-xs font-semibold text-stone-700">{t("hidden")}</span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <DialogButton label={t("rename")} title={t("renameTitle")}>
            <RenameForm category={category} />
          </DialogButton>
          {/* The new value travels in the form, so the button also works before JavaScript has loaded. */}
          <form action={visibilityAction}>
            <input type="hidden" name="id" value={category.id} />
            <input type="hidden" name="is_visible" value={String(!category.is_visible)} />
            <button type="submit" disabled={visibilityPending} className={SECONDARY_BUTTON}>
              {category.is_visible ? t("hide") : t("show")}
            </button>
          </form>
          <DialogButton label={t("delete")} title={t("deleteTitle")}>
            <DeleteForm category={category} />
          </DialogButton>
        </div>
      </div>
      <FormAlert error={visibility.error} />
    </SortableRow>
  );
}

/** A new name for the category. The dialog closes after a successful save and stays open on an error. */
function RenameForm({ category }: { category: Category }) {
  const t = useTranslations("Forms");
  const form = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState(renameCategory, NAME_IDLE);
  useEffect(() => {
    if (state.saved) form.current?.closest("dialog")?.close();
  }, [state]);
  return (
    <form ref={form} action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={category.id} />
      <NameFields names={state.names ?? category.name} error={state.error} />
      <FormAlert error={state.error} />
      <div className="flex justify-end gap-2">
        <CancelButton />
        <button type="submit" disabled={pending} className={PRIMARY_BUTTON}>
          {pending ? t("saving") : t("save")}
        </button>
      </div>
    </form>
  );
}

/** Confirms the delete. After a success the row leaves the page, and this dialog with it. */
function DeleteForm({ category }: { category: Category }) {
  const t = useTranslations("Categories");
  const [state, formAction, pending] = useActionState(deleteCategory, IDLE);
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={category.id} />
      <BilingualName name={category.name} />
      <p>{t("deleteWarning")}</p>
      <FormAlert error={state.error} />
      <div className="flex justify-end gap-2">
        <CancelButton />
        <button type="submit" disabled={pending} className={DANGER_BUTTON}>
          {pending ? t("deleting") : t("confirmDelete")}
        </button>
      </div>
    </form>
  );
}

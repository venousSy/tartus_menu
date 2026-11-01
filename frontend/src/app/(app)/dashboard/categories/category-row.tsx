"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useLocale, useTranslations } from "next-intl";
import { useActionState, useEffect, useRef } from "react";
import { pickText, toLang } from "@/lib/i18n";
import type { ActionState } from "@/lib/server/owner-actions";
import type { Category } from "@/lib/server/owner-api";
import { CancelButton, DialogButton } from "../dialog-button";
import { BilingualName, DANGER_BUTTON, FormAlert, NameFields, PRIMARY_BUTTON, SECONDARY_BUTTON } from "../form-parts";
import { deleteCategory, type NameFormState, renameCategory, setCategoryVisibility } from "./actions";

const IDLE: ActionState = { error: null };
const NAME_IDLE: NameFormState = { error: null };

/**
 * One category and what the owner can do with it: move it by its handle (UC-OWNER-003), rename,
 * hide or show, delete (UC-OWNER-001). Only the handle starts a drag, so the buttons stay buttons.
 */
export function CategoryRow({ category, movable }: { category: Category; movable: boolean }) {
  const t = useTranslations("Categories");
  const name = pickText(category.name, toLang(useLocale()));
  const [visibility, visibilityAction, visibilityPending] = useActionState(setCategoryVisibility, IDLE);
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: category.id,
    disabled: !movable,
    attributes: { roleDescription: t("dragRole") },
  });
  return (
    <li ref={setNodeRef}
      // Only up and down (x = 0), and a translation, not dnd-kit's scale: rows differ in height.
      style={{ transform: CSS.Translate.toString(transform && { ...transform, x: 0 }), transition }}
      className={`relative flex flex-col gap-2 bg-white px-4 py-3 first:rounded-t-lg last:rounded-b-lg ${isDragging ? "z-10 shadow-lg" : ""}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-2">
          {movable && (
            <button type="button" ref={setActivatorNodeRef} {...attributes} {...listeners} aria-label={t("move", { name })}
              className="-ms-2 flex min-h-11 min-w-11 cursor-grab touch-none items-center justify-center rounded-lg text-stone-500 active:cursor-grabbing">
              <GripIcon />
            </button>
          )}
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
    </li>
  );
}

// Six dots, the usual sign for "drag here". The button around it carries the label.
function GripIcon() {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" fill="currentColor" aria-hidden="true">
      {[6, 10, 14].map((y) => [7, 13].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.5" />))}
    </svg>
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

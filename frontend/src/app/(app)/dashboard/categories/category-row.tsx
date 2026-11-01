"use client";

import { useTranslations } from "next-intl";
import { Fragment, type ReactNode, useActionState, useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { BilingualText } from "@/lib/i18n";
import type { Category } from "@/lib/server/owner-api";
import { DANGER_BUTTON, FormAlert, NameFields, PRIMARY_BUTTON, SECONDARY_BUTTON } from "../form-parts";
import { type ActionState, deleteCategory, type NameFormState, renameCategory, setCategoryVisibility } from "./actions";

const IDLE: ActionState = { error: null };
const NAME_IDLE: NameFormState = { error: null };

/** One category and what the owner can do with it (UC-OWNER-001): rename, hide or show, delete. */
export function CategoryRow({ category }: { category: Category }) {
  const t = useTranslations("Categories");
  const [visibility, visibilityAction, visibilityPending] = useActionState(setCategoryVisibility, IDLE);
  return (
    <li className="flex flex-col gap-2 bg-white px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-2">
          <CategoryName name={category.name} />
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

// Both names of a category. <bdi> keeps each name's own direction inside a page of either language.
function CategoryName({ name }: { name: BilingualText }) {
  return (
    <span className="flex flex-col">
      <span className="font-semibold"><bdi lang="ar">{name.ar}</bdi></span>
      {name.en && <span className="text-sm text-stone-600"><bdi lang="en">{name.en}</bdi></span>}
    </span>
  );
}

/**
 * A button and the modal dialog it opens. The dialog and its form are part of the page from the
 * start, so the form exists for a post without JavaScript too. Each opening renders the form anew
 * (`key`): the current values, without the error or the typing of the last time.
 */
function DialogButton({ label, title, children }: { label: string; title: string; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [openings, setOpenings] = useState(0);
  const titleId = useId();
  return (
    <>
      <button type="button" className={SECONDARY_BUTTON}
        onClick={() => {
          // The new form must be in place before showModal() moves the focus to its first field.
          flushSync(() => setOpenings((count) => count + 1));
          dialog.current?.showModal();
        }}>
        {label}
      </button>
      <dialog ref={dialog} aria-labelledby={titleId}
        className="m-auto w-[min(28rem,calc(100%-2rem))] rounded-lg p-4 backdrop:bg-black/40">
        <h3 id={titleId} className="mb-3 font-bold">{title}</h3>
        <Fragment key={openings}>{children}</Fragment>
      </dialog>
    </>
  );
}

// Closes the dialog around the button; the Escape key does the same.
function CancelButton() {
  const t = useTranslations("Forms");
  return (
    <button type="button" className={SECONDARY_BUTTON} onClick={(event) => event.currentTarget.closest("dialog")?.close()}>
      {t("cancel")}
    </button>
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
      <CategoryName name={category.name} />
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

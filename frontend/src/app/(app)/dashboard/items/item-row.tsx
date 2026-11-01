"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState, useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import type { FormError } from "@/lib/api-errors";
import { formatPrice, pickText, toLang } from "@/lib/i18n";
import type { ActionState } from "@/lib/server/owner-actions";
import type { Category, MenuItem } from "@/lib/server/owner-api";
import { CancelButton, DialogButton } from "../dialog-button";
import { BilingualName, DANGER_BUTTON, FormAlert, PRIMARY_BUTTON } from "../form-parts";
import { SortableRow } from "../sortable-list";
import { deleteItem, type ItemFormState, setItemAvailability, updateItem } from "./actions";
import { ItemFields, itemValues } from "./item-fields";

const IDLE: ActionState = { error: null };
const ITEM_IDLE: ItemFormState = { error: null };

/**
 * One item and what the owner can do with it: move it by its handle (UC-OWNER-004), switch its
 * availability (UC-OWNER-005), edit, delete (UC-OWNER-002). The image comes with UC-OWNER-006.
 */
export function ItemRow({ item, categories, movable }: { item: MenuItem; categories: Category[]; movable: boolean }) {
  const t = useTranslations("Items");
  const lang = toLang(useLocale());
  const name = pickText(item.name, lang);
  // UC-OWNER-005: the switch shows the new value at once. When the save ends, React shows the
  // server's value: the same after a success, the old one again after a refusal.
  const [available, showAvailable] = useOptimistic(item.is_available);
  const [availabilityError, setAvailabilityError] = useState<FormError | null>(null);
  const [, startTransition] = useTransition();
  function toggleAvailability() {
    const next = !available;
    startTransition(async () => {
      showAvailable(next);
      setAvailabilityError((await setItemAvailability(item.id, next)).error);
    });
  }
  return (
    <SortableRow id={item.id} name={name} movable={movable} roleDescription={t("dragRole")}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <BilingualName name={item.name} />
          <span className="text-sm font-semibold">{formatPrice(item.price, lang)}</span>
          {(item.is_featured || item.is_new) && (
            <span className="flex flex-wrap gap-1">
              {item.is_featured && <Badge text={t("featured")} />}
              {item.is_new && <Badge text={t("new")} />}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" role="switch" aria-checked={available} aria-label={t("availableFor", { name })}
            onClick={toggleAvailability} className="group flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm font-semibold">
            <span aria-hidden="true"
              className="relative h-6 w-11 shrink-0 rounded-full bg-stone-300 transition-colors group-aria-checked:bg-green-700">
              <span className="absolute start-0.5 top-0.5 size-5 rounded-full bg-white shadow transition-all group-aria-checked:start-5.5" />
            </span>
            {t("available")}
          </button>
          <DialogButton label={t("edit")} title={t("editTitle")}>
            <EditForm item={item} categories={categories} />
          </DialogButton>
          <DialogButton label={t("delete")} title={t("deleteTitle")}>
            <DeleteForm item={item} />
          </DialogButton>
        </div>
      </div>
      <FormAlert error={availabilityError} />
    </SortableRow>
  );
}

function Badge({ text }: { text: string }) {
  return <span className="rounded-full bg-amber-100 px-2 text-xs font-semibold text-amber-900">{text}</span>;
}

/** Every field of the item; it can also move to another category. Closes after a successful save. */
function EditForm({ item, categories }: { item: MenuItem; categories: Category[] }) {
  const t = useTranslations("Forms");
  const form = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState(updateItem, ITEM_IDLE);
  useEffect(() => {
    if (state.saved) form.current?.closest("dialog")?.close();
  }, [state]);
  return (
    <form ref={form} action={formAction} className="@container flex flex-col gap-3">
      <input type="hidden" name="id" value={item.id} />
      <ItemFields values={state.values ?? itemValues(item)} error={state.error} categories={categories} />
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
function DeleteForm({ item }: { item: MenuItem }) {
  const t = useTranslations("Items");
  const [state, formAction, pending] = useActionState(deleteItem, IDLE);
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={item.id} />
      <BilingualName name={item.name} />
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

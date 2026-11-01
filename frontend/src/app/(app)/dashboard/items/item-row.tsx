"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState, useEffect, useRef } from "react";
import { formatPrice, toLang } from "@/lib/i18n";
import type { ActionState } from "@/lib/server/owner-actions";
import type { Category, MenuItem } from "@/lib/server/owner-api";
import { CancelButton, DialogButton } from "../dialog-button";
import { BilingualName, DANGER_BUTTON, FormAlert, PRIMARY_BUTTON } from "../form-parts";
import { deleteItem, type ItemFormState, updateItem } from "./actions";
import { ItemFields, itemValues } from "./item-fields";

const IDLE: ActionState = { error: null };
const ITEM_IDLE: ItemFormState = { error: null };

/**
 * One item and what the owner can do with it (UC-OWNER-002): edit, delete. Availability, order
 * and image come in their own steps (UC-OWNER-005, 004, 006); the row already shows availability.
 */
export function ItemRow({ item, categories }: { item: MenuItem; categories: Category[] }) {
  const t = useTranslations("Items");
  const lang = toLang(useLocale());
  return (
    <li className="flex flex-col gap-3 bg-white px-4 py-3 first:rounded-t-lg last:rounded-b-lg sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col gap-1">
        <BilingualName name={item.name} />
        <span className="text-sm font-semibold">{formatPrice(item.price, lang)}</span>
        <span className="flex flex-wrap gap-1">
          {item.is_featured && <Badge text={t("featured")} />}
          {item.is_new && <Badge text={t("new")} />}
          {!item.is_available && <Badge text={t("unavailable")} muted />}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <DialogButton label={t("edit")} title={t("editTitle")}>
          <EditForm item={item} categories={categories} />
        </DialogButton>
        <DialogButton label={t("delete")} title={t("deleteTitle")}>
          <DeleteForm item={item} />
        </DialogButton>
      </div>
    </li>
  );
}

function Badge({ text, muted = false }: { text: string; muted?: boolean }) {
  const colors = muted ? "bg-stone-200 text-stone-700" : "bg-amber-100 text-amber-900";
  return <span className={`rounded-full px-2 text-xs font-semibold ${colors}`}>{text}</span>;
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

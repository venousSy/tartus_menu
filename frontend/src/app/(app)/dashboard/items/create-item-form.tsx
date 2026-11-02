"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { FormAlert, PRIMARY_BUTTON } from "../form-parts";
import { createItem, type ItemFormState } from "./actions";
import { ItemFields, newItemValues } from "./item-fields";

const INITIAL: ItemFormState = { error: null };

/**
 * Adds an item at the end of the open category (UC-OWNER-002). The page gives each category its
 * own form (`key`), so typing never moves with the owner from one category to another.
 */
export function CreateItemForm({ categoryId }: { categoryId: number }) {
  const t = useTranslations("Items");
  const [state, formAction, pending] = useActionState(createItem, INITIAL);
  return (
    <form action={formAction} className="@container flex flex-col gap-3 rounded-lg border border-stone-200 bg-white p-4">
      <h3 className="font-bold">{t("newItem")}</h3>
      <ItemFields values={state.values ?? newItemValues(categoryId)} error={state.error} />
      <FormAlert error={state.error} />
      <button type="submit" disabled={pending} className={`${PRIMARY_BUTTON} self-start`}>
        {pending ? t("adding") : t("add")}
      </button>
    </form>
  );
}

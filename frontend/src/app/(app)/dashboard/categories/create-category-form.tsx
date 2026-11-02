"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { FormAlert, NameFields, PRIMARY_BUTTON } from "../form-parts";
import { createCategory, type NameFormState } from "./actions";

const INITIAL: NameFormState = { error: null };

/** Adds a category at the end of the menu (UC-OWNER-001). After a success React empties the form. */
export function CreateCategoryForm() {
  const t = useTranslations("Categories");
  const [state, formAction, pending] = useActionState(createCategory, INITIAL);
  return (
    <form action={formAction} className="flex flex-col gap-3 rounded-lg border border-stone-200 bg-white p-4">
      <h3 className="font-bold">{t("newCategory")}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <NameFields names={state.names} error={state.error} />
      </div>
      <FormAlert error={state.error} />
      <button type="submit" disabled={pending} className={`${PRIMARY_BUTTON} self-start`}>
        {pending ? t("adding") : t("add")}
      </button>
    </form>
  );
}

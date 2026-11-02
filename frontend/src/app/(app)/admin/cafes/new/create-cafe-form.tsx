"use client";

import { useTranslations } from "next-intl";
import { useActionState, useId } from "react";
import { PLAN_CODES } from "@/lib/plans";
import { FieldMessages, FormAlert, NameFields, PRIMARY_BUTTON, TextField } from "../../../ui/form-parts";
import { type CreateCafeState, createCafe } from "../actions";

const IDLE: CreateCafeState = { error: null };

/** The create form (UC-ADMIN-001): the cafe's address name, names and plan, and its owner's login. */
export function CreateCafeForm() {
  const t = useTranslations("AdminCreate");
  const tCafes = useTranslations("AdminCafes");
  const [state, formAction, pending] = useActionState(createCafe, IDLE);
  const planErrorId = useId();
  const planMessages = state.error?.fields.plan;
  const values = state.values;
  return (
    <form action={formAction} className="@container flex flex-col gap-4 rounded-lg border border-stone-200 bg-white p-4">
      <div className="flex flex-col gap-1">
        <TextField label={t("slug")} name="slug" lang="en" required maxLength={100}
          defaultValue={values?.slug ?? ""} messages={state.error?.fields.slug} />
        <p className="text-sm text-stone-600">{t("slugHint")}</p>
      </div>
      <div className="grid gap-3 @lg:grid-cols-2">
        <NameFields names={values?.name} error={state.error} />
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-semibold">{t("plan")}</span>
        {/* key: React resets a form after its action, so the choice comes back through defaultValue. */}
        <select key={values?.plan ?? "basic"} name="plan" defaultValue={values?.plan ?? "basic"}
          aria-invalid={planMessages ? true : undefined} aria-describedby={planMessages ? planErrorId : undefined}
          className="min-h-11 rounded-lg border border-stone-300 bg-white px-3 aria-invalid:border-red-600">
          {PLAN_CODES.map((plan) => <option key={plan} value={plan}>{tCafes("planName", { name: plan })}</option>)}
        </select>
      </label>
      <FieldMessages id={planErrorId} messages={planMessages} />
      <fieldset className="grid gap-3 @lg:grid-cols-2">
        <legend className="mb-2 font-semibold">{t("owner")}</legend>
        <TextField label={t("ownerEmail")} name="owner_email" lang="en" inputMode="email" required
          defaultValue={values?.email ?? ""} messages={state.error?.fields["owner.email"]} />
        {/* Never refilled: a password is not written back into a page. */}
        <TextField label={t("ownerPassword")} name="owner_password" password="new-password" required
          defaultValue="" messages={state.error?.fields["owner.password"]} />
      </fieldset>
      <p className="text-sm text-stone-600">{t("passwordHint")}</p>
      <FormAlert error={state.error} />
      <button type="submit" disabled={pending} className={`${PRIMARY_BUTTON} self-start`}>
        {pending ? t("creating") : t("submit")}
      </button>
    </form>
  );
}

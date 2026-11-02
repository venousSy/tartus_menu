"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useId, useRef } from "react";
import type { AdminCafe } from "@/lib/server/admin-api";
import { PLAN_CODES } from "@/lib/plans";
import { CancelButton, DialogButton } from "../../../ui/dialog-button";
import { FieldMessages, FormAlert, NameFields, PRIMARY_BUTTON, TextField } from "../../../ui/form-parts";
import { type EditCafeState, updateCafe } from "../actions";

const IDLE: EditCafeState = { error: null };

/** The Edit button and its dialog (UC-ADMIN-006). `defaultColor` is the brand color the picker starts with. */
export function EditDialog({ cafe, defaultColor }: { cafe: AdminCafe; defaultColor: string }) {
  const t = useTranslations("AdminCafe");
  return (
    <DialogButton label={t("edit")} title={t("editTitle")}>
      <EditForm cafe={cafe} defaultColor={defaultColor} />
    </DialogButton>
  );
}

/**
 * The cafe's names (GC 6), slug, plan and menu color. A refusal keeps what was typed; a success
 * closes the dialog, and the page shows the saved values (and a "plan changed" event).
 */
function EditForm({ cafe, defaultColor }: { cafe: AdminCafe; defaultColor: string }) {
  const t = useTranslations("AdminCafe");
  const tCafes = useTranslations("AdminCafes");
  const tForms = useTranslations("Forms");
  const form = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState(updateCafe, IDLE);
  const planErrorId = useId();
  const colorErrorId = useId();
  useEffect(() => {
    if (state.saved) form.current?.closest("dialog")?.close();
  }, [state]);
  const values = state.values;
  const plan = values?.plan ?? cafe.plan;
  const color = values ? values.color : cafe.primary_color;
  const planMessages = state.error?.fields.plan;
  const colorMessages = state.error?.fields.primary_color;
  return (
    <form ref={form} action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={cafe.id} />
      <NameFields names={values?.name ?? cafe.name} error={state.error} />
      <div className="flex flex-col gap-1">
        <TextField label={t("slug")} name="slug" lang="en" required maxLength={100}
          defaultValue={values?.slug ?? cafe.slug} messages={state.error?.fields.slug} />
        {/* UC-ADMIN-006: there is no redirect from an old slug in the MVP. */}
        <p className="text-sm text-amber-800">{t("slugWarning")}</p>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-semibold">{t("plan")}</span>
        <select key={plan} name="plan" defaultValue={plan}
          aria-invalid={planMessages ? true : undefined} aria-describedby={planMessages ? planErrorId : undefined}
          className="min-h-11 rounded-lg border border-stone-300 bg-white px-3 aria-invalid:border-red-600">
          {PLAN_CODES.map((code) => <option key={code} value={code}>{tCafes("planName", { name: code })}</option>)}
        </select>
      </label>
      <FieldMessages id={planErrorId} messages={planMessages} />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold">{t("color")}</legend>
        {/* key: React resets a form after its action; a fresh box starts from the typed choice. */}
        <label key={`box-${color !== ""}`} className="flex min-h-11 items-center gap-2">
          <input type="checkbox" name="custom_color" defaultChecked={color !== ""} className="size-5 accent-primary" />
          <span>{t("customColor")}</span>
        </label>
        <input key={`color-${color}`} type="color" name="primary_color" defaultValue={color || defaultColor} aria-label={t("colorPick")}
          aria-invalid={colorMessages ? true : undefined} aria-describedby={colorMessages ? colorErrorId : undefined}
          className="h-11 w-16 rounded-lg border border-stone-300 bg-white aria-invalid:border-red-600" />
        {/* GC 7: a color set here is kept on any plan, and customers see it only with branding. */}
        <p className="text-sm text-stone-600">{t("colorHint")}</p>
        <FieldMessages id={colorErrorId} messages={colorMessages} />
      </fieldset>
      <FormAlert error={state.error} />
      <div className="flex justify-end gap-2">
        <CancelButton />
        <button type="submit" disabled={pending} className={PRIMARY_BUTTON}>
          {pending ? tForms("saving") : tForms("save")}
        </button>
      </div>
    </form>
  );
}

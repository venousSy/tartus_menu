"use client";

import { useTranslations } from "next-intl";
import { useActionState, useId } from "react";
import type { CafeSettings } from "@/lib/server/owner-api";
import { FieldMessages, FormAlert, NameFields, PRIMARY_BUTTON } from "../form-parts";
import { type SettingsFormState, updateSettings } from "./actions";

const IDLE: SettingsFormState = { error: null };

/**
 * The cafe's names (GC 6) and, when the plan allows branding, the menu color customers see
 * (UC-OWNER-009). A native color picker gives "#rrggbb"; the box chooses between it and the default.
 */
export function SettingsForm({ settings, defaultColor }: { settings: CafeSettings; defaultColor: string }) {
  const t = useTranslations("Settings");
  const tForms = useTranslations("Forms");
  const [state, formAction, pending] = useActionState(updateSettings, IDLE);
  const colorErrorId = useId();
  const colorMessages = state.error?.fields.primary_color;
  const typedColor = state.values?.color; // after a refusal: what the owner chose
  const custom = typedColor !== undefined ? typedColor !== "" : settings.primary_color !== "";
  return (
    <form action={formAction} className="@container flex flex-col gap-4 rounded-lg border border-stone-200 bg-white p-4">
      <div className="grid gap-3 @lg:grid-cols-2">
        <NameFields names={state.values?.name ?? settings.name} error={state.error} />
      </div>
      {settings.plan.allows_branding && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold">{t("colorLegend")}</legend>
          <label className="flex min-h-11 items-center gap-2">
            <input type="checkbox" name="custom_color" defaultChecked={custom} className="size-5 accent-primary" />
            <span>{t("customColor")}</span>
          </label>
          <label className="flex items-center gap-3">
            <input type="color" name="primary_color" defaultValue={typedColor || settings.primary_color || defaultColor}
              aria-invalid={colorMessages ? true : undefined} aria-describedby={colorMessages ? colorErrorId : undefined}
              className="h-11 w-16 shrink-0 rounded-lg border border-stone-300 bg-white aria-invalid:border-red-600" />
            <span>{t("colorPick")}</span>
          </label>
          <p className="text-sm text-stone-600">{t("colorHint")}</p>
          <FieldMessages id={colorErrorId} messages={colorMessages} />
        </fieldset>
      )}
      <FormAlert error={state.error} />
      <p role="status" className="text-sm font-semibold text-green-800">{state.saved ? t("saved") : ""}</p>
      <button type="submit" disabled={pending} className={`${PRIMARY_BUTTON} self-start`}>
        {pending ? tForms("saving") : tForms("save")}
      </button>
    </form>
  );
}

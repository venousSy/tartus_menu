"use server";

import { type ActionState, writeThenRefresh } from "@/lib/server/owner-actions";

// The Server Action of the Settings screen (UC-OWNER-009). Django checks the name (GC 6), the color
// format and the plan's allows_branding flag; this action only carries the values to it.

/** What the owner typed. `color` is "" for the default theme, and absent when the form has no color. */
export type SettingsValues = { name: { ar: string; en: string }; color?: string };

/** The settings form's state: `values` refill the form after a refusal, `saved` shows "Changes saved." */
export type SettingsFormState = ActionState & { values?: SettingsValues; saved?: boolean };

/**
 * Saves the cafe's names and, on a plan with branding, its menu color. The color input is in the
 * form only on such a plan: Django refuses primary_color on any other plan, even "" (A2).
 */
export async function updateSettings(_previous: SettingsFormState, formData: FormData): Promise<SettingsFormState> {
  const text = (name: string) => String(formData.get(name) ?? "");
  const name = { ar: text("name_ar"), en: text("name_en") };
  // An unticked "own color" box means the default theme: "" (GC 7).
  const color = formData.has("primary_color") ? (formData.has("custom_color") ? text("primary_color") : "") : undefined;
  const json = color === undefined ? { name } : { name, primary_color: color };
  const error = await writeThenRefresh("/dashboard/settings/", { method: "PATCH", json });
  return error ? { error, values: { name, color } } : { error: null, saved: true };
}

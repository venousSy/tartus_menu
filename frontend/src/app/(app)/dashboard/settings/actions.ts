"use server";

import { type ActionState, imageBody, type UploadState, writeThenRefresh } from "@/lib/server/owner-actions";

// The Server Actions of the Settings screen (UC-OWNER-009, UC-OWNER-010). Django checks the name
// (GC 6), the color format, the logo file and the plan's allows_branding flag; these actions only
// carry the values to it.

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

/**
 * A new logo (UC-OWNER-010), as multipart/form-data with the file in "image". Django checks the
 * plan (A1), the file like an item image (A2, A3), keeps its transparency, stores a WebP copy of at
 * most 512 px on R2 (A4) and removes the old logo.
 */
export async function uploadLogo(_previous: UploadState, formData: FormData): Promise<UploadState> {
  const error = await writeThenRefresh("/dashboard/settings/logo/", { method: "POST", form: imageBody(formData) });
  return error ? { error } : { error: null, saved: true };
}

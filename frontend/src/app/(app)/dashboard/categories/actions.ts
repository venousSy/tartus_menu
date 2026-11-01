"use server";

import { refresh } from "next/cache";
import type { FormError } from "@/lib/api-errors";
import { type OwnerInit, ownerWrite } from "@/lib/server/owner-api";

// The Server Actions of the Categories screen (UC-OWNER-001). Each one only carries the owner's
// token to Django: Django checks the role, the subscription, the plan limit, the name and that the
// category belongs to this cafe. After a successful write, refresh() renders the page again with
// the new data, in the same response.

/** A form's state after its action: Django's error, or null after a success. */
export type ActionState = { error: FormError | null };

/**
 * The state of a name form. After a refused write, `names` holds what the owner typed: React
 * empties a form after its action, and the inputs refill from here. `saved` closes the rename dialog.
 */
export type NameFormState = ActionState & { names?: { ar: string; en: string }; saved?: boolean };

const NOT_FOUND: FormError = { form: { key: "notFound" }, fields: {} };

// The two inputs of a name (GC 6). Django checks them: "ar" required, both at most 100 characters.
function namesFrom(formData: FormData) {
  return { ar: String(formData.get("name_ar") ?? ""), en: String(formData.get("name_en") ?? "") };
}

// The API path of the category in the form's hidden "id" input. A user can change hidden inputs,
// so only a positive whole number may go into the path; anything else counts as "not found".
function categoryPath(formData: FormData): string | null {
  const id = Number(formData.get("id"));
  return Number.isSafeInteger(id) && id > 0 ? `/dashboard/categories/${id}/` : null;
}

// One write, then the fresh page. Returns Django's error, or null when the write succeeded.
async function writeThenRefresh(path: string | null, init: OwnerInit): Promise<FormError | null> {
  if (!path) return NOT_FOUND;
  const result = await ownerWrite(path, init);
  if (!result.ok) return result.error;
  refresh();
  return null;
}

/** Create. Plan limit (A1), inactive cafe (A3) and invalid name (A4) come back as the form's error. */
export async function createCategory(_previous: NameFormState, formData: FormData): Promise<NameFormState> {
  const names = namesFrom(formData);
  const error = await writeThenRefresh("/dashboard/categories/", { method: "POST", json: { name: names } });
  return error ? { error, names } : { error: null }; // no names: the emptied form is ready for the next one
}

/** A new name. A sent name replaces both languages at once (GC 6). */
export async function renameCategory(_previous: NameFormState, formData: FormData): Promise<NameFormState> {
  const names = namesFrom(formData);
  const error = await writeThenRefresh(categoryPath(formData), { method: "PATCH", json: { name: names } });
  return error ? { error, names } : { error: null, saved: true };
}

/** Hide or show. A hidden category stays in the dashboard, but customers no longer see it (UC-GUEST-001). */
export async function setCategoryVisibility(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const json = { is_visible: formData.get("is_visible") === "true" };
  return { error: await writeThenRefresh(categoryPath(formData), { method: "PATCH", json }) };
}

/** Delete. Django soft-deletes the category together with its items, in one transaction. */
export async function deleteCategory(_previous: ActionState, formData: FormData): Promise<ActionState> {
  return { error: await writeThenRefresh(categoryPath(formData), { method: "DELETE" }) };
}

"use server";

import { type ActionState, NOT_FOUND, pathOf, writeThenRefresh } from "@/lib/server/owner-actions";

// The Server Actions of the Categories screen (UC-OWNER-001, UC-OWNER-003). Django checks the
// role, the subscription, the plan limit, the name and that the category belongs to this cafe.

/**
 * The state of a name form. After a refused write, `names` holds what the owner typed: React
 * empties a form after its action, and the inputs refill from here. `saved` closes the rename dialog.
 */
export type NameFormState = ActionState & { names?: { ar: string; en: string }; saved?: boolean };

const CATEGORIES = "/dashboard/categories/";

// The two inputs of a name (GC 6). Django checks them: "ar" required, both at most 100 characters.
function namesFrom(formData: FormData) {
  return { ar: String(formData.get("name_ar") ?? ""), en: String(formData.get("name_en") ?? "") };
}

/** Create. Plan limit (A1), inactive cafe (A3) and invalid name (A4) come back as the form's error. */
export async function createCategory(_previous: NameFormState, formData: FormData): Promise<NameFormState> {
  const names = namesFrom(formData);
  const error = await writeThenRefresh(CATEGORIES, { method: "POST", json: { name: names } });
  return error ? { error, names } : { error: null }; // no names: the emptied form is ready for the next one
}

/** A new name. A sent name replaces both languages at once (GC 6). */
export async function renameCategory(_previous: NameFormState, formData: FormData): Promise<NameFormState> {
  const names = namesFrom(formData);
  const error = await writeThenRefresh(pathOf(CATEGORIES, formData), { method: "PATCH", json: { name: names } });
  return error ? { error, names } : { error: null, saved: true };
}

/** Hide or show. A hidden category stays in the dashboard, but customers no longer see it (UC-GUEST-001). */
export async function setCategoryVisibility(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const json = { is_visible: formData.get("is_visible") === "true" };
  return { error: await writeThenRefresh(pathOf(CATEGORIES, formData), { method: "PATCH", json }) };
}

/** Delete. Django soft-deletes the category together with its items, in one transaction. */
export async function deleteCategory(_previous: ActionState, formData: FormData): Promise<ActionState> {
  return { error: await writeThenRefresh(pathOf(CATEGORIES, formData), { method: "DELETE" }) };
}

/**
 * The new order of all the cafe's categories, saved right after a drag (UC-OWNER-003). The page
 * calls it with the list of ids, not with a form. Django checks that the list names every
 * category of this cafe exactly once (A1: 404, A2: 400) and saves nothing otherwise.
 */
export async function reorderCategories(orderedIds: readonly number[]): Promise<ActionState> {
  // TypeScript only describes what the page sends; a request can carry anything. Ids only.
  if (!Array.isArray(orderedIds) || !orderedIds.every((id) => Number.isSafeInteger(id) && id > 0)) {
    return { error: NOT_FOUND };
  }
  const error = await writeThenRefresh(`${CATEGORIES}reorder/`, {
    method: "POST",
    json: { ordered_ids: orderedIds },
  });
  // A2 is a field error of "ordered_ids", but the list has no input to show it next to.
  const listMessage = error?.fields.ordered_ids?.[0];
  return { error: listMessage ? { form: listMessage, fields: {} } : error };
}

"use server";

import { type ActionState, isId, NOT_FOUND, pathOf, saveOrder, writeThenRefresh } from "@/lib/server/owner-actions";

// The Server Actions of the Items screen (UC-OWNER-002, 004, 005). Django checks the category,
// the plan limit, the texts (GC 6) and the price (GC 10); these actions only carry the data to it.

/** What the owner typed into an item form, as the form's inputs hold it. */
export type ItemValues = {
  category_id: string;
  name: { ar: string; en: string };
  description: { ar: string; en: string };
  price: string; // sent as typed: Django reads "12.5" as 12.50 and refuses anything that is no price
  is_featured: boolean;
  is_new: boolean;
};

/** An item form's state: `values` refill the form after a refused write, `saved` closes the edit dialog. */
export type ItemFormState = ActionState & { values?: ItemValues; saved?: boolean };

const ITEMS = "/dashboard/items/";

function valuesFrom(formData: FormData): ItemValues {
  const text = (name: string) => String(formData.get(name) ?? "");
  return {
    category_id: text("category_id"),
    name: { ar: text("name_ar"), en: text("name_en") },
    description: { ar: text("description_ar"), en: text("description_en") },
    price: text("price"),
    // A checkbox is part of the form data only while it is checked.
    is_featured: formData.has("is_featured"),
    is_new: formData.has("is_new"),
  };
}

/**
 * Create, at the end of its category. The plan limit (A1), an unknown category (A2), the price (A3),
 * the texts (A4) and an inactive cafe (A5) come back as the form's errors.
 */
export async function createItem(_previous: ItemFormState, formData: FormData): Promise<ItemFormState> {
  const values = valuesFrom(formData);
  const error = await writeThenRefresh(ITEMS, { method: "POST", json: values });
  return error ? { error, values } : { error: null }; // no values: the emptied form is ready for the next one
}

/** Edit: every field of the form at once. A new category moves the item to the end of that category. */
export async function updateItem(_previous: ItemFormState, formData: FormData): Promise<ItemFormState> {
  const values = valuesFrom(formData);
  const error = await writeThenRefresh(pathOf(ITEMS, formData), { method: "PATCH", json: values });
  return error ? { error, values } : { error: null, saved: true };
}

/** Delete. Django keeps the row with a deletion time (soft delete); customers no longer see it. */
export async function deleteItem(_previous: ActionState, formData: FormData): Promise<ActionState> {
  return { error: await writeThenRefresh(pathOf(ITEMS, formData), { method: "DELETE" }) };
}

/**
 * The new order of one category's items, saved right after a drag (UC-OWNER-004). Called with the
 * list of ids (A1: several categories, 400; A2: an unknown id, 404).
 */
export async function reorderItems(orderedIds: readonly number[]): Promise<ActionState> {
  return saveOrder(`${ITEMS}reorder/`, orderedIds);
}

/**
 * Only the availability of one item, from its switch (UC-OWNER-005): the page shows the new value
 * at once and calls this with values, not a form. Customers see the change within seconds (GC 9).
 */
export async function setItemAvailability(id: number, isAvailable: boolean): Promise<ActionState> {
  if (!isId(id) || typeof isAvailable !== "boolean") return { error: NOT_FOUND };
  const json = { is_available: isAvailable };
  return { error: await writeThenRefresh(`${ITEMS}${id}/availability/`, { method: "PATCH", json }) };
}

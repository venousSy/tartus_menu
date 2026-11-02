import "server-only";

import { refresh } from "next/cache";
import type { FormError } from "@/lib/api-errors";
import { type ApiInit, apiWrite } from "@/lib/server/api";

// What the dashboard's Server Actions share. An action only carries the owner's form to Django
// (api.ts); Django checks every rule. After a successful write, refresh() renders the page
// again with the new data, in the same response.

/** A form's state after its action: Django's error, or null after a success. */
export type ActionState = { error: FormError | null };

export const NOT_FOUND: FormError = { form: { key: "notFound" }, fields: {} };

/** An image upload's state: `saved` after a success. A file input cannot be refilled, so no values. */
export type UploadState = ActionState & { saved?: boolean };

/**
 * The body of an image upload (item image UC-OWNER-006, logo UC-OWNER-010): only the "image" file
 * of the form, as multipart/form-data. Anything else in that field is no image; Django then answers
 * that no file was submitted.
 */
export function imageBody(formData: FormData): FormData {
  const image = formData.get("image");
  const body = new FormData();
  if (image instanceof File) body.set("image", image);
  return body;
}

/**
 * An id as the browser sent it. Hidden inputs and action arguments can be changed by the user,
 * and TypeScript only describes what the page sends: only a positive whole number may go into a path.
 */
export function isId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/**
 * The API path of the row named by a form's hidden "id" input, below `base` ("/dashboard/items/").
 * Anything that is not an id counts as "not found".
 */
export function pathOf(base: string, formData: FormData): string | null {
  const id = Number(formData.get("id"));
  return isId(id) ? `${base}${id}/` : null;
}

/** One write, then the fresh page. Returns Django's error, or null when the write succeeded. */
export async function writeThenRefresh(path: string | null, init: ApiInit): Promise<FormError | null> {
  if (!path) return NOT_FOUND;
  const result = await apiWrite(path, init);
  if (!result.ok) return result.error;
  refresh(); // works here because only Server Actions call this function
  return null;
}

/**
 * Saves a list's new order after a drag (UC-OWNER-003, UC-OWNER-004): `path` is the reorder
 * endpoint, `orderedIds` the whole list. Django checks that it names every row exactly once and
 * saves nothing otherwise. Its 400 is a field error of "ordered_ids", but the list has no input to
 * show a message next to, so that message becomes the list's own.
 */
export async function saveOrder(path: string, orderedIds: unknown): Promise<ActionState> {
  if (!Array.isArray(orderedIds) || !orderedIds.every(isId)) return { error: NOT_FOUND };
  const error = await writeThenRefresh(path, { method: "POST", json: { ordered_ids: orderedIds } });
  const listMessage = error?.fields.ordered_ids?.[0];
  return { error: listMessage ? { form: listMessage, fields: {} } : error };
}

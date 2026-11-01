import "server-only";

import { refresh } from "next/cache";
import type { FormError } from "@/lib/api-errors";
import { type OwnerInit, ownerWrite } from "@/lib/server/owner-api";

// What the dashboard's Server Actions share. An action only carries the owner's form to Django
// (owner-api.ts); Django checks every rule. After a successful write, refresh() renders the page
// again with the new data, in the same response.

/** A form's state after its action: Django's error, or null after a success. */
export type ActionState = { error: FormError | null };

export const NOT_FOUND: FormError = { form: { key: "notFound" }, fields: {} };

/**
 * The API path of the row named by a form's hidden "id" input, below `base` ("/dashboard/items/").
 * A user can change hidden inputs, so only a positive whole number may go into the path;
 * anything else counts as "not found".
 */
export function pathOf(base: string, formData: FormData): string | null {
  const id = Number(formData.get("id"));
  return Number.isSafeInteger(id) && id > 0 ? `${base}${id}/` : null;
}

/** One write, then the fresh page. Returns Django's error, or null when the write succeeded. */
export async function writeThenRefresh(path: string | null, init: OwnerInit): Promise<FormError | null> {
  if (!path) return NOT_FOUND;
  const result = await ownerWrite(path, init);
  if (!result.ok) return result.error;
  refresh(); // works here because only Server Actions call this function
  return null;
}

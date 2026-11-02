"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import type { FormError } from "@/lib/api-errors";
import { type AdminCafe, adminWrite } from "@/lib/server/admin-api";
import type { ApiInit } from "@/lib/server/api";
import { isId, NOT_FOUND } from "@/lib/server/owner-actions";

// The Server Actions of the Super Admin's cafe screens (UC-ADMIN-001 to 007). Django checks every
// field and rule; these actions only carry the form to it.

/** What the admin typed in the create form. The password is not kept: it is never written back into a page. */
export type CreateCafeValues = { slug: string; name: { ar: string; en: string }; plan: string; email: string };

/** The create form's state after a refusal: Django's error and the typed values. */
export type CreateCafeState = { error: FormError | null; values?: CreateCafeValues };

/**
 * Creates a cafe and its owner account (UC-ADMIN-001). The cafe starts inactive. Django checks the
 * slug (A1), the email (A2), the plan (A3), the names (A5) and the password rules; its owner errors
 * are nested ({"owner": {"email": [...]}}), so the form reads them as "owner.email".
 * On success the browser goes to the new cafe's page.
 */
export async function createCafe(_previous: CreateCafeState, formData: FormData): Promise<CreateCafeState> {
  const text = (name: string) => String(formData.get(name) ?? "");
  const values: CreateCafeValues = {
    slug: text("slug"), name: { ar: text("name_ar"), en: text("name_en") }, plan: text("plan"), email: text("owner_email"),
  };
  const result = await adminWrite<AdminCafe>("/admin/cafes/", {
    method: "POST",
    json: {
      slug: values.slug, name: values.name, plan: values.plan,
      owner: { email: values.email, password: text("owner_password") },
    },
  });
  if (!result.ok) return { error: result.error, values };
  redirect(`/admin/cafes/${result.data.id}`); // outside any try block: redirect() works by throwing
}

/**
 * The path of the cafe named by a form's hidden "id" input, plus `rest` ("activate/"); null when it
 * is not an id. Like the owner's pathOf, but with adminWrite below, so a 403 ends the session.
 */
function cafePath(formData: FormData, rest = ""): string | null {
  const id = Number(formData.get("id"));
  return isId(id) ? `/admin/cafes/${id}/${rest}` : null;
}

/** One write, then the fresh page. Returns Django's error, or null when the write succeeded. */
async function writeThenRefresh(path: string | null, init: ApiInit): Promise<FormError | null> {
  if (!path) return NOT_FOUND;
  const result = await adminWrite(path, init);
  if (!result.ok) return result.error;
  refresh(); // works here because only Server Actions call this function
  return null;
}

/** A subscription change's state: the typed notes come back after a refusal; `saved` closes the dialog. */
export type SubscriptionState = { error: FormError | null; notes?: string; saved?: boolean };

/**
 * Activates (UC-ADMIN-004) or deactivates (UC-ADMIN-005) the cafe, with optional notes that Django
 * stores on the BillingEvent (at most 500 characters, A4). The hidden "change" input picks the
 * endpoint. Django refuses a change to the state the cafe already has (A1), for example from a page
 * opened before another admin's change.
 */
export async function changeSubscription(_previous: SubscriptionState, formData: FormData): Promise<SubscriptionState> {
  const change = formData.get("change");
  if (change !== "activate" && change !== "deactivate") return { error: NOT_FOUND };
  const notes = String(formData.get("notes") ?? "");
  const error = await writeThenRefresh(cafePath(formData, `${change}/`), { method: "POST", json: { notes } });
  return error ? { error, notes } : { error: null, saved: true };
}

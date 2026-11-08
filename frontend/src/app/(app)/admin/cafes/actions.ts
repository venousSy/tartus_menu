"use server";

import { redirect } from "next/navigation";

import type { FormError } from "@/lib/api-errors";
import { type AdminCafe, adminWrite } from "@/lib/server/admin-api";
import type { ApiInit } from "@/lib/server/api";
import { NOT_FOUND, pathOf, writeThenRefresh as ownerWriteThenRefresh } from "@/lib/server/owner-actions";

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

/** The path of the cafe named by a form's hidden "id" input, plus `rest` ("activate/"); null when it is not an id. */
function cafePath(formData: FormData, rest = ""): string | null {
  const path = pathOf("/admin/cafes/", formData);
  return path && `${path}${rest}`;
}

/** The shared write-then-refresh, with adminWrite: a 403 ends the session. */
function writeThenRefresh(path: string | null, init: ApiInit): Promise<FormError | null> {
  return ownerWriteThenRefresh(path, init, adminWrite);
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

/** What the admin typed in the edit form. `color` is "" for the default theme. */
export type EditCafeValues = { slug: string; name: { ar: string; en: string }; plan: string; color: string };

/** The edit form's state: the typed values come back after a refusal; `saved` closes the dialog. */
export type EditCafeState = { error: FormError | null; values?: EditCafeValues; saved?: boolean };

/**
 * Saves the cafe's names, slug, plan and menu color (UC-ADMIN-006). All four are sent; Django
 * changes only what differs and writes a "plan_changed" billing event for a new plan. Django checks
 * a new slug (A1), a downgrade against the plan's limits (A2), the color (A5) and the names (A6).
 * The color is stored even on a plan without branding (GC 7). An unticked "own color" box means the
 * default theme: "".
 */
export async function updateCafe(_previous: EditCafeState, formData: FormData): Promise<EditCafeState> {
  const text = (name: string) => String(formData.get(name) ?? "");
  const values: EditCafeValues = {
    slug: text("slug"), name: { ar: text("name_ar"), en: text("name_en") }, plan: text("plan"),
    color: formData.has("custom_color") ? text("primary_color") : "",
  };
  const error = await writeThenRefresh(cafePath(formData), {
    method: "PATCH",
    json: { name: values.name, slug: values.slug, plan: values.plan, primary_color: values.color },
  });
  return error ? { error, values } : { error: null, saved: true };
}

/** The delete dialog's state: Django's error, if any. A success leaves the page, so it has no state. */
export type DeleteCafeState = { error: FormError | null };

/**
 * Deletes the cafe for good (UC-ADMIN-007): Django removes it, its owner account and all its data
 * in one transaction, then its images. On success the browser goes back to the list, because this
 * cafe's page no longer exists.
 */
export async function deleteCafe(_previous: DeleteCafeState, formData: FormData): Promise<DeleteCafeState> {
  const path = cafePath(formData);
  if (!path) return { error: NOT_FOUND };
  const result = await adminWrite(path, { method: "DELETE" });
  if (!result.ok) return { error: result.error };
  redirect("/admin/cafes"); // outside any try block: redirect() works by throwing
}

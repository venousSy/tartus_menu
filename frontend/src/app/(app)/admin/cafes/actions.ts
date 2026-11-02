"use server";

import { redirect } from "next/navigation";

import type { FormError } from "@/lib/api-errors";
import { type AdminCafe, adminWrite } from "@/lib/server/admin-api";

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

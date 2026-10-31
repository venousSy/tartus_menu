"use server";

import { cookies } from "next/headers";
import { LANG_COOKIE, toLang } from "@/lib/i18n";

const ONE_YEAR = 60 * 60 * 24 * 365;

/**
 * Saves the dashboard language. Used as a form action: Next.js sets the cookie and sends back the
 * page rendered in the new language in the same round trip. The value is only a display choice,
 * not a secret, so the cookie is readable by scripts; toLang() accepts only "ar" or "en".
 */
export async function setLanguage(formData: FormData) {
  (await cookies()).set(LANG_COOKIE, toLang(formData.get("lang")), {
    path: "/",
    maxAge: ONE_YEAR,
    sameSite: "lax",
  });
}

import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { LANG_COOKIE, toLang } from "@/lib/i18n";

// next-intl calls this once per request in the dashboards. There are no language prefixes in the
// URLs: the language comes from a cookie, and Arabic is the default (implementation_plan.md).
// A locale that code asks for, as in getTranslations({ locale: "en" }), wins over the cookie.
export default getRequestConfig(async ({ locale: asked }) => {
  const locale = toLang(asked ?? (await cookies()).get(LANG_COOKIE)?.value);
  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});

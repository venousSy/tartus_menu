"use client";

import { useTranslations } from "next-intl";
import { useTransition } from "react";

/**
 * Logs out (UC-AUTH-003): the BFF route clears both cookies and asks Django to blacklist the
 * refresh token. Then a full page load of /login, not a router navigation: it also drops the
 * dashboard pages Next keeps in memory, and replace() keeps Back from returning to this page.
 */
export function LogoutButton() {
  const t = useTranslations("Session");
  const [pending, startTransition] = useTransition();
  return (
    <button type="button" disabled={pending}
      onClick={() => startTransition(async () => {
        await fetch("/bff/auth/logout", { method: "POST" }).catch(() => {}); // the route clears the cookies in any case
        window.location.replace("/login");
      })}
      className="min-h-11 rounded-full border border-stone-300 px-4 text-sm font-semibold disabled:opacity-60">
      {t("logout")}
    </button>
  );
}

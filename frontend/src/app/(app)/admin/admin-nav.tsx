"use client";

import { useTranslations } from "next-intl";
import { ScreenNav } from "../ui/screen-nav";

// The Super Admin's screens (system_design.md §4.1). `label` is a key of "Admin".
const SCREENS = [
  { href: "/admin", label: "home" },
  { href: "/admin/cafes", label: "cafes" },
] as const;

/** The Super Admin's dashboard menu. */
export function AdminNav() {
  const t = useTranslations("Admin");
  return <ScreenNav label={t("navLabel")} screens={SCREENS.map(({ href, label }) => ({ href, label: t(label) }))} />;
}

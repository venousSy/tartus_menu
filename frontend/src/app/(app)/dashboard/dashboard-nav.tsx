"use client";

import { useTranslations } from "next-intl";
import { ScreenNav } from "../ui/screen-nav";

// The owner's screens, in the order of system_design.md §4.2. `label` is a key of "Dashboard".
const SCREENS = [
  { href: "/dashboard", label: "home" },
  { href: "/dashboard/categories", label: "categories" },
  { href: "/dashboard/items", label: "items" },
  { href: "/dashboard/qr", label: "qr" },
  { href: "/dashboard/analytics", label: "analytics" },
  { href: "/dashboard/settings", label: "settings" },
] as const;

/** The Cafe Owner's dashboard menu. */
export function DashboardNav() {
  const t = useTranslations("Dashboard");
  return <ScreenNav label={t("navLabel")} screens={SCREENS.map(({ href, label }) => ({ href, label: t(label) }))} />;
}

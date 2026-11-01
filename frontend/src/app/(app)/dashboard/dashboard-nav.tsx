"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

// The owner's screens, in the order of system_design.md §4.2. `label` is a key of "Dashboard".
const SCREENS = [
  { href: "/dashboard", label: "home" },
  { href: "/dashboard/categories", label: "categories" },
  { href: "/dashboard/items", label: "items" },
  { href: "/dashboard/qr", label: "qr" },
  { href: "/dashboard/settings", label: "settings" },
] as const;

/**
 * The dashboard menu. A Client Component: the layout around it is not rendered again when the
 * owner opens another screen, so only the browser knows which one is open (usePathname).
 */
export function DashboardNav() {
  const t = useTranslations("Dashboard");
  const pathname = usePathname();
  return (
    <nav aria-label={t("navLabel")} className="border-b border-stone-200 bg-white">
      {/* On a narrow phone the menu scrolls sideways; the page itself never does. */}
      <ul className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-4">
        {SCREENS.map(({ href, label }) => {
          // Home is open only on /dashboard itself; the other screens also on their sub-pages.
          const open = pathname === href || (href !== "/dashboard" && pathname.startsWith(`${href}/`));
          return (
            <li key={href} className="shrink-0">
              <Link href={href} aria-current={open ? "page" : undefined}
                className="flex min-h-11 items-center border-b-2 border-transparent px-3 text-sm font-semibold text-stone-600 aria-[current=page]:border-primary aria-[current=page]:text-stone-900">
                {t(label)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** One entry of a dashboard menu: its address and its translated label. */
export type Screen = { href: string; label: string };

/**
 * The menu of a dashboard (Cafe Owner or Super Admin). A Client Component: the layout around it is
 * not rendered again when the user opens another screen, so only the browser knows which one is
 * open (usePathname). `screens[0]` is the dashboard's home.
 */
export function ScreenNav({ label, screens }: { label: string; screens: readonly Screen[] }) {
  const pathname = usePathname();
  const home = screens[0].href;
  return (
    <nav aria-label={label} className="border-b border-stone-200 bg-white">
      {/* On a narrow phone the menu scrolls sideways; the page itself never does. */}
      <ul className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-4">
        {screens.map(({ href, label }) => {
          // Home is open only on its own address; the other screens also on their sub-pages.
          const open = pathname === href || (href !== home && pathname.startsWith(`${href}/`));
          return (
            <li key={href} className="shrink-0">
              <Link href={href} aria-current={open ? "page" : undefined}
                className="flex min-h-11 items-center border-b-2 border-transparent px-3 text-sm font-semibold text-stone-600 aria-[current=page]:border-primary aria-[current=page]:text-stone-900">
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

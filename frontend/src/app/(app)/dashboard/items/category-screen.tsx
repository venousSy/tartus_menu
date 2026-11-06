"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type MouseEvent, type ReactNode, useTransition } from "react";

export type CategoryTab = { id: number; name: string; href: string; current: boolean };

/**
 * The category tabs of the Items screen and the open category's content (`children`: the list and
 * the create form). While a tab's page loads, the content is inert: a switch or a form used in that
 * moment would refresh the old list while the new one arrives, and both lists could show at once.
 */
export function CategoryScreen({ tabs, label, children }: { tabs: CategoryTab[]; label: string; children: ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function open(event: MouseEvent<HTMLAnchorElement>, href: string) {
    // A new tab or window (Ctrl, Shift, middle click) stays the browser's job.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    startTransition(() => router.push(href));
  }

  return (
    <>
      <nav aria-label={label}>
        <ul className="flex gap-2 overflow-x-auto pb-1">
          {tabs.map((tab) => (
            <li key={tab.id} className="shrink-0">
              <Link href={tab.href} onClick={(event) => open(event, tab.href)}
                aria-current={tab.current ? "true" : undefined}
                className="flex min-h-11 items-center rounded-full border border-stone-300 bg-white px-4 text-sm font-semibold aria-[current=true]:border-primary aria-[current=true]:bg-primary aria-[current=true]:text-on-primary">
                {tab.name}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div inert={pending} aria-busy={pending} className={`flex flex-col gap-6 ${pending ? "opacity-60" : ""}`}>
        {children}
      </div>
    </>
  );
}

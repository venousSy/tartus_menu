import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { getSettings } from "@/lib/server/owner-api";
import { PageHeader } from "../page-header";
import { DashboardNav } from "./dashboard-nav";
import { RetryBoundary } from "./retry-boundary";

// The frame of every Cafe Owner screen (system_design.md §4.2). Next keeps a layout on screen while
// the owner moves between the screens below it, and renders only the new page.
export default async function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  const t = await getTranslations("Dashboard");
  return (
    <>
      <PageHeader title={t("title")} signedIn />
      <DashboardNav />
      <main className="mx-auto max-w-5xl px-4 py-6">
        {/* A failed read replaces only this part: the header and the menu stay usable. The
            <Suspense> keeps them in the server's HTML even then, as React builds a failed
            part in the browser, where the boundary catches the error. */}
        <RetryBoundary>
          <Suspense>
            <InactiveNotice />
            {children}
          </Suspense>
        </RetryBoundary>
      </main>
    </>
  );
}

/**
 * GC 5: the owner of an inactive cafe can still log in and read the settings, but Django refuses
 * every other dashboard call. Reading the settings also re-checks the role (getSettings).
 */
async function InactiveNotice() {
  const settings = await getSettings();
  if (settings.is_active) return null;
  const t = await getTranslations("Dashboard");
  return (
    <p className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900">
      {t("inactive")}
    </p>
  );
}

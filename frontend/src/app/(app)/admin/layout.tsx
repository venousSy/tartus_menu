import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { PageHeader } from "../page-header";
import { RetryBoundary } from "../ui/retry-boundary";
import { AdminNav } from "./admin-nav";

// The frame of every Super Admin screen (system_design.md §4.1), like the owner's dashboard layout.
// No read of its own: proxy.ts already sent other roles away by their token, and every admin read
// ends the session on a 403 (admin-api.ts), so each page re-checks the role with its own call.
export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const t = await getTranslations("Admin");
  return (
    <>
      <PageHeader title={t("title")} signedIn />
      <AdminNav />
      <main className="mx-auto max-w-5xl px-4 py-6">
        {/* A failed read replaces only this part: the header and the menu stay usable. */}
        <RetryBoundary>
          <Suspense>{children}</Suspense>
        </RetryBoundary>
      </main>
    </>
  );
}

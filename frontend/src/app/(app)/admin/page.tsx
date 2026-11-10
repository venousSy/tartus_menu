import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getStats } from "@/lib/server/admin-api";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("Admin"))("title") };
}

// The Super Admin's home (system_design.md §4.1): the platform's numbers (UC-ADMIN-009) and the
// way to the cafe list.
export default async function AdminHomePage() {
  const [stats, t] = await Promise.all([getStats(), getTranslations("AdminHome")]);
  return (
    <section className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">{t("title")}</h2>
      {/* The first and the last number take a whole row, so the other four fill the grid: 2 x 2 on a phone, 4 across wider. */}
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-stone-200 bg-stone-200 sm:grid-cols-4">
        <Stat label={t("total")} value={stats.total_cafes} wide />
        <Stat label={t("active")} value={stats.active_cafes} />
        <Stat label={t("inactive")} value={stats.inactive_cafes} />
        <Stat label={t("basic")} value={stats.basic_plan_count} />
        <Stat label={t("pro")} value={stats.pro_plan_count} />
        {/* Active cafes with 7 paid days or fewer left: the ones to call about a renewal (GC 5). */}
        <Stat label={t("expiringSoon")} value={stats.expiring_soon_cafes} wide />
      </dl>
      <Link href="/admin/cafes"
        className="flex min-h-11 items-center self-start rounded-lg bg-primary px-4 font-semibold text-on-primary">
        {t("manageCafes")}
      </Link>
    </section>
  );
}

function Stat({ label, value, wide = false }: { label: string; value: number; wide?: boolean }) {
  return (
    <div className={`flex flex-col gap-1 bg-white px-4 py-3 ${wide ? "col-span-full" : ""}`}>
      <dt className="text-sm text-stone-600">{label}</dt>
      <dd className="text-2xl font-bold">{value}</dd>
    </div>
  );
}

import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { pickText, toLang } from "@/lib/i18n";
import { getSettings } from "@/lib/server/owner-api";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("Dashboard"))("title") };
}

// The owner's home (system_design.md §4.2): the cafe, its subscription, what its plan allows
// (UC-OWNER-014, GC 3) and the way to the customer menu.
export default async function DashboardHomePage() {
  const [settings, t, locale] = await Promise.all([getSettings(), getTranslations("DashboardHome"), getLocale()]);
  const { plan } = settings;
  // GC 3: a null limit means unlimited.
  const limit = (max: number | null) => (max === null ? t("unlimited") : t("upTo", { max }));
  const yesNo = (allowed: boolean) => (allowed ? t("yes") : t("no"));
  return (
    <section className="flex flex-col gap-6">
      <h2 dir="auto" className="text-2xl font-bold">{pickText(settings.name, toLang(locale))}</h2>
      <dl className="grid gap-px overflow-hidden rounded-lg border border-stone-200 bg-stone-200 sm:grid-cols-2">
        <Row label={t("subscription")} value={settings.is_active ? t("active") : t("inactive")} />
        <Row label={t("plan")} value={t("planName", { name: plan.name })} />
        <Row label={t("categories")} value={limit(plan.max_categories)} />
        <Row label={t("items")} value={limit(plan.max_items)} />
        <Row label={t("itemImages")} value={yesNo(plan.allows_images)} />
        <Row label={t("branding")} value={yesNo(plan.allows_branding)} />
      </dl>
      {/* A new tab keeps the dashboard open. A plain <a>: the menu has its own root layout. */}
      <a href={`/menu/${encodeURIComponent(settings.slug)}`} target="_blank" rel="noopener"
        className="flex min-h-11 items-center self-start rounded-lg bg-primary px-4 font-semibold text-on-primary">
        {t("openMenu")}
        <span className="sr-only"> {t("newTab")}</span>
      </a>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 bg-white px-4 py-3">
      <dt className="text-sm text-stone-600">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { formatDate, formatDayLabel, toLang } from "@/lib/i18n";
import { ANALYTICS_PERIODS, type AnalyticsPeriod, getAnalyticsDetail, getAnalyticsSummary, getSettings } from "@/lib/server/owner-api";
import { BarChart } from "./bar-chart";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("Analytics"))("title") };
}

/** The period in the address (?days=30); anything else is the default week. */
function periodOf(value: string | string[] | undefined): AnalyticsPeriod {
  const days = Number(Array.isArray(value) ? value[0] : value);
  return ANALYTICS_PERIODS.find((period) => period === days) ?? 7;
}

// The Analytics screen: how often the menu was opened. Every plan sees the opens per day
// (UC-OWNER-015); a plan with detailed analytics also sees them per hour of the day and per table
// (UC-OWNER-016). The numbers come from the counter of UC-GUEST-004 and hold nothing about a customer.
export default async function AnalyticsPage({ searchParams }: PageProps<"/dashboard/analytics">) {
  const [settings, t, locale, query] = await Promise.all([getSettings(), getTranslations("Analytics"), getLocale(), searchParams]);
  if (!settings.is_active) {
    // GC 5: Django refuses every analytics call of an inactive cafe, so the page makes none.
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-2xl font-bold">{t("title")}</h2>
        <p className="text-stone-600">{t("inactive")}</p>
      </section>
    );
  }

  const lang = toLang(locale);
  const days = periodOf(query.days);
  const detailed = settings.plan.allows_detailed_analytics; // the flag, never the plan name (GC 3)
  // Asked together. Without the flag the detail is not asked at all: Django would answer 403.
  const [summary, detail] = await Promise.all([getAnalyticsSummary(days), detailed ? getAnalyticsDetail(days) : null]);
  const mostOpened = Math.max(1, ...(detail?.by_table.map((table) => table.count) ?? []));
  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-bold">{t("title")}</h2>
        <p className="text-sm text-stone-600">{t("intro")}</p>
      </div>
      <nav aria-label={t("periodLabel")} className="flex flex-wrap gap-2">
        {ANALYTICS_PERIODS.map((period) => (
          <Link key={period} href={period === 7 ? "/dashboard/analytics" : `/dashboard/analytics?days=${period}`}
            aria-current={period === days ? "page" : undefined}
            className="flex min-h-11 items-center rounded-lg border border-stone-300 bg-white px-3 text-sm font-semibold aria-[current=page]:border-primary aria-[current=page]:bg-primary aria-[current=page]:text-on-primary">
            {t("period", { days: period })}
          </Link>
        ))}
      </nav>
      <p className="text-lg"><span className="text-3xl font-bold">{summary.total}</span> {t("total", { count: summary.total, days })}</p>
      <BarChart caption={t("byDay")} columns={[t("day"), t("opens")]}
        bars={summary.by_day.map((entry) => ({
          label: formatDayLabel(entry.date, lang), name: formatDate(entry.date, lang), value: entry.count,
        }))} />
      {detail ? (
        <>
          <BarChart caption={t("byHour")} columns={[t("hour"), t("opens")]}
            bars={detail.by_hour.map((entry) => ({
              label: String(entry.hour), name: t("hourName", { hour: String(entry.hour).padStart(2, "0") }), value: entry.count,
            }))} />
          <div className="flex flex-col gap-3 rounded-lg border border-stone-200 bg-white p-4">
            <h3 className="font-semibold">{t("byTable")}</h3>
            {detail.by_table.length === 0 ? (
              <p className="text-stone-600">{t("noOpens")}</p>
            ) : (
              <ol className="flex flex-col gap-2">
                {detail.by_table.map((table) => (
                  <li key={table.table_number} className="flex flex-col gap-1">
                    <span className="flex justify-between gap-4 text-sm">
                      <span>{table.table_number === 0 ? t("noTable") : t("table", { number: table.table_number })}</span>
                      <span className="font-semibold">{table.count}</span>
                    </span>
                    {/* The bar's length compares the tables; the number above is the fact. */}
                    <span aria-hidden="true" className="h-2 rounded bg-primary" style={{ width: `${(table.count / mostOpened) * 100}%` }} />
                  </li>
                ))}
              </ol>
            )}
          </div>
        </>
      ) : (
        <p className="rounded-lg border border-stone-200 bg-white px-4 py-3 text-stone-600">{t("needPro")}</p>
      )}
      <p className="text-sm text-stone-600">{t("approximate")}</p>
    </section>
  );
}

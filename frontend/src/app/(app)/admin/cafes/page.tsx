import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { pickText, toLang } from "@/lib/i18n";
import { CAFES_PER_PAGE, getCafes } from "@/lib/server/admin-api";
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "../../ui/form-parts";
import { ExpiryBadge } from "./expiry-badge";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("AdminCafes"))("title") };
}

/** The first value of a query parameter: an address can repeat one (?page=1&page=2). */
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

/** The list's address for a page and a search text; page 1 and an empty search stay out of it. */
function listHref(page: number, search: string) {
  const query = new URLSearchParams({ ...(page > 1 ? { page: String(page) } : {}), ...(search ? { search } : {}) });
  return query.size ? `/admin/cafes?${query}` : "/admin/cafes";
}

// The Super Admin's cafe list (UC-ADMIN-002): /admin/cafes?page=<n>&search=<text> (D3, D4). Django
// pages and searches (name, slug, owner email); the address keeps both, so a result can be shared.
export default async function AdminCafesPage({ searchParams }: PageProps<"/admin/cafes">) {
  const query = await searchParams;
  const search = first(query.search).trim();
  const wanted = Number(first(query.page) || "1");
  const page = Number.isSafeInteger(wanted) && wanted > 0 ? wanted : 1;
  const [cafes, t, locale] = await Promise.all([getCafes(page, search), getTranslations("AdminCafes"), getLocale()]);
  const lang = toLang(locale);
  const pages = cafes ? Math.max(1, Math.ceil(cafes.count / CAFES_PER_PAGE)) : 0;
  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-bold">{t("title")}</h2>
        <Link href="/admin/cafes/new" className={PRIMARY_BUTTON}>{t("create")}</Link>
      </div>
      {/* A GET form: it works without JavaScript and starts again at page 1. */}
      <Form action="/admin/cafes" role="search" className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-sm font-semibold">{t("searchLabel")}</span>
          <input type="search" name="search" defaultValue={search} dir="auto"
            className="min-h-11 rounded-lg border border-stone-300 bg-white px-3" />
        </label>
        <button type="submit" className={SECONDARY_BUTTON}>{t("search")}</button>
        {search && <Link href="/admin/cafes" className="flex min-h-11 items-center px-2 font-semibold text-primary underline">{t("clear")}</Link>}
      </Form>
      {cafes === null ? (
        // D4: a page past the end, for example an old link after deletions.
        <p className="text-stone-600">
          {t("noSuchPage")}{" "}
          <Link href={listHref(1, search)} className="font-semibold text-primary underline">{t("firstPage")}</Link>
        </p>
      ) : cafes.count === 0 ? (
        <p className="text-stone-600">{search ? t("noMatch", { search }) : t("empty")}</p>
      ) : (
        <>
          <p className="text-sm text-stone-600">{search ? t("matches", { count: cafes.count, search }) : t("count", { count: cafes.count })}</p>
          <ul className="flex flex-col divide-y divide-stone-200 overflow-hidden rounded-lg border border-stone-200 bg-white">
            {cafes.results.map((cafe) => (
              <li key={cafe.id}>
                <Link href={`/admin/cafes/${cafe.id}`} className="flex flex-col gap-1 px-4 py-3 hover:bg-stone-50">
                  <span className="flex flex-wrap items-center gap-2">
                    <span dir="auto" className="font-semibold">{pickText(cafe.name, lang)}</span>
                    <span className="rounded bg-stone-100 px-2 py-0.5 text-xs font-semibold">{t("planName", { name: cafe.plan })}</span>
                    <span className={`rounded px-2 py-0.5 text-xs font-semibold ${cafe.is_active ? "bg-green-100 text-green-900" : "bg-amber-100 text-amber-900"}`}>
                      {cafe.is_active ? t("active") : t("inactive")}
                    </span>
                    <ExpiryBadge daysLeft={cafe.days_left} soon={t("daysLeft", { days: Math.max(cafe.days_left ?? 0, 0) })} overdue={t("overdue")} />
                  </span>
                  {/* Addresses and emails read left to right inside Arabic text too. */}
                  <span className="flex flex-wrap gap-x-4 text-sm text-stone-600">
                    <bdi dir="ltr" className="font-mono">{cafe.slug}</bdi>
                    <bdi dir="ltr">{cafe.owner_email}</bdi>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {pages > 1 && (
            <nav aria-label={t("pagesLabel")} className="flex items-center justify-between gap-3">
              {page > 1 ? <Link href={listHref(page - 1, search)} className={SECONDARY_BUTTON}>{t("previous")}</Link> : <span />}
              <span className="text-sm text-stone-600">{t("pageOf", { page, pages })}</span>
              {page < pages ? <Link href={listHref(page + 1, search)} className={SECONDARY_BUTTON}>{t("next")}</Link> : <span />}
            </nav>
          )}
        </>
      )}
    </section>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { type Lang, pickText, toLang } from "@/lib/i18n";
import { type Category, getCategories, getItems, getSettings } from "@/lib/server/owner-api";
import { CreateItemForm } from "./create-item-form";
import { ItemRow } from "./item-row";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("Items"))("title") };
}

// The Items screen (UC-OWNER-013 list, UC-OWNER-002 create, edit and delete), one category at a
// time: /dashboard/items?category=<id> (D8). A missing or unknown id, for example an old link to a
// deleted category, opens the first category.
export default async function ItemsPage({ searchParams }: PageProps<"/dashboard/items">) {
  const [settings, t] = await Promise.all([getSettings(), getTranslations("Items")]);
  if (!settings.is_active) {
    // GC 5: Django refuses every item call of an inactive cafe, so the page makes none.
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-2xl font-bold">{t("title")}</h2>
        <p className="text-stone-600">{t("inactive")}</p>
      </section>
    );
  }

  // One read of all items: the plan limit counts them all (GC 3), and the page shows one category's.
  const [categories, items, { category: wanted }, locale] = await Promise.all([
    getCategories(), getItems(), searchParams, getLocale(),
  ]);
  const lang = toLang(locale);
  if (categories.length === 0) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-2xl font-bold">{t("title")}</h2>
        <p className="text-stone-600">{t("noCategories")}</p>
        <Link href="/dashboard/categories" className="font-semibold text-primary underline">{t("toCategories")}</Link>
      </section>
    );
  }

  const current = categories.find((category) => String(category.id) === wanted) ?? categories[0];
  const shown = items.filter((item) => item.category_id === current.id);
  const count = items.length;
  const max = settings.plan.max_items; // null = unlimited; unavailable items count too
  const [tErrors, tHome] = await Promise.all([getTranslations("ApiErrors"), getTranslations("DashboardHome")]);
  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-bold">{t("title")}</h2>
        {(max !== null || count > 0) && (
          <p className="text-sm text-stone-600">
            {max === null ? t("countUnlimited", { count }) : t("count", { count, max })}
          </p>
        )}
      </div>
      <CategoryTabs categories={categories} current={current} lang={lang} label={t("categoriesLabel")} />
      {shown.length === 0 ? (
        <p className="text-stone-600">{t("empty")}</p>
      ) : (
        <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200">
          {shown.map((item) => <ItemRow key={item.id} item={item} categories={categories} />)}
        </ul>
      )}
      {max !== null && count >= max ? (
        // The same text Django answers when the limit is reached (A1), shown before the owner tries.
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900">
          {tErrors("planLimitItems", { plan: tHome("planName", { name: settings.plan.name }), max })}
        </p>
      ) : (
        <CreateItemForm key={current.id} categoryId={current.id} />
      )}
    </section>
  );
}

// One link per category. Each opens the same screen for that category; the open one is marked.
function CategoryTabs({ categories, current, lang, label }: {
  categories: Category[];
  current: Category;
  lang: Lang;
  label: string;
}) {
  return (
    <nav aria-label={label}>
      <ul className="flex gap-2 overflow-x-auto pb-1">
        {categories.map((category) => (
          <li key={category.id} className="shrink-0">
            <Link href={`/dashboard/items?category=${category.id}`}
              aria-current={category.id === current.id ? "true" : undefined}
              className="flex min-h-11 items-center rounded-full border border-stone-300 bg-white px-4 text-sm font-semibold aria-[current=true]:border-primary aria-[current=true]:bg-primary aria-[current=true]:text-on-primary">
              {pickText(category.name, lang)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

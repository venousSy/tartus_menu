import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { getCategories, getSettings } from "@/lib/server/owner-api";
import { CategoryRow } from "./category-row";
import { CreateCategoryForm } from "./create-category-form";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("Categories"))("title") };
}

// The Categories screen: the list (UC-OWNER-012), then create, rename, hide and delete (UC-OWNER-001).
export default async function CategoriesPage() {
  const [settings, t] = await Promise.all([getSettings(), getTranslations("Categories")]);
  if (!settings.is_active) {
    // GC 5: Django refuses every category call of an inactive cafe, so the page makes none.
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-2xl font-bold">{t("title")}</h2>
        <p className="text-stone-600">{t("inactive")}</p>
      </section>
    );
  }

  const [categories, tErrors, tHome] = await Promise.all([
    getCategories(),
    getTranslations("ApiErrors"),
    getTranslations("DashboardHome"),
  ]);
  const count = categories.length;
  // GC 3: the limit comes from the plan (null = unlimited), and hidden categories count too.
  const max = settings.plan.max_categories;
  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-bold">{t("title")}</h2>
        {/* Without a limit, an empty list says enough on its own. */}
        {(max !== null || count > 0) && (
          <p className="text-sm text-stone-600">
            {max === null ? t("countUnlimited", { count }) : t("count", { count, max })}
          </p>
        )}
      </div>
      {count === 0 ? (
        <p className="text-stone-600">{t("empty")}</p>
      ) : (
        <ul className="divide-y divide-stone-200 overflow-hidden rounded-lg border border-stone-200">
          {categories.map((category) => <CategoryRow key={category.id} category={category} />)}
        </ul>
      )}
      {max !== null && count >= max ? (
        // The same text Django answers when the limit is reached (A1), shown before the owner tries.
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900">
          {tErrors("planLimitCategories", { plan: tHome("planName", { name: settings.plan.name }), max })}
        </p>
      ) : (
        <CreateCategoryForm />
      )}
    </section>
  );
}

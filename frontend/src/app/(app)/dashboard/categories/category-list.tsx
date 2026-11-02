"use client";

import { useTranslations } from "next-intl";
import type { Category } from "@/lib/server/owner-api";
import { SortableList } from "../sortable-list";
import { reorderCategories } from "./actions";
import { CategoryRow } from "./category-row";

/**
 * The categories in menu order, reordered by drag and drop (UC-OWNER-003). A Client Component:
 * the page on the server cannot hand SortableList a function that draws a row.
 */
export function CategoryList({ categories }: { categories: Category[] }) {
  const t = useTranslations("Categories");
  return (
    <SortableList rows={categories} save={reorderCategories} hint={t("reorderHint")}
      instructions={t("dragInstructions")}
      renderRow={(category, movable) => <CategoryRow category={category} movable={movable} />} />
  );
}

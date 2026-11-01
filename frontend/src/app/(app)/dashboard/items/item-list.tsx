"use client";

import { useTranslations } from "next-intl";
import type { Category, MenuItem } from "@/lib/server/owner-api";
import { SortableList } from "../sortable-list";
import { reorderItems } from "./actions";
import { ItemRow } from "./item-row";

/**
 * The open category's items in menu order, reordered by drag and drop inside that category
 * (UC-OWNER-004). A Client Component for the same reason as CategoryList.
 */
export function ItemList({ items, categories }: { items: MenuItem[]; categories: Category[] }) {
  const t = useTranslations("Items");
  return (
    <SortableList rows={items} save={reorderItems} hint={t("reorderHint")} instructions={t("dragInstructions")}
      renderRow={(item, movable) => <ItemRow item={item} categories={categories} movable={movable} />} />
  );
}

"use client";

import {
  type Announcements,
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  type UniqueIdentifier,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useLocale, useTranslations } from "next-intl";
import { useId, useOptimistic, useRef, useState, useTransition } from "react";
import type { FormError } from "@/lib/api-errors";
import { pickText, toLang } from "@/lib/i18n";
import type { Category } from "@/lib/server/owner-api";
import { FormAlert } from "../form-parts";
import { reorderCategories } from "./actions";
import { CategoryRow } from "./category-row";

/**
 * The categories in menu order (UC-OWNER-003). The owner drags a row by its handle, with a mouse,
 * a finger or the keyboard, and the new order is saved at once. The rows move before Django
 * answers; if Django refuses, React shows the last saved order again and the message says why.
 */
export function CategoryList({ categories }: { categories: Category[] }) {
  const t = useTranslations("Categories");
  const lang = toLang(useLocale());
  const [items, showOrder] = useOptimistic(categories);
  const [error, setError] = useState<FormError | null>(null);
  const [saving, startTransition] = useTransition();
  const sensors = useSensors(
    useSensor(PointerSensor), // mouse, pen and touch; the handle has touch-action: none
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const contextId = useId(); // the same ids on the server and in the browser (no hydration mismatch)

  const indexOf = (id: UniqueIdentifier) => items.findIndex((category) => category.id === id);
  const nameOf = (id: UniqueIdentifier) => pickText(items[indexOf(id)]?.name ?? {}, lang);
  const place = (id: UniqueIdentifier, overId: UniqueIdentifier) =>
    ({ name: nameOf(id), position: indexOf(overId) + 1, count: items.length });

  // What a screen reader hears while a row moves. dnd-kit's own texts are English and name raw ids.
  // Right after a pick-up dnd-kit reports the row over itself; announcing that would replace the
  // pick-up message at once, so that first report is skipped (a later return to the start is not).
  const justPickedUp = useRef(false);
  const announcements: Announcements = {
    onDragStart: ({ active }) => {
      justPickedUp.current = true;
      return t("pickedUp", place(active.id, active.id));
    },
    onDragOver: ({ active, over }) => {
      const first = justPickedUp.current;
      justPickedUp.current = false;
      return over && !(first && over.id === active.id) ? t("movedTo", place(active.id, over.id)) : undefined;
    },
    onDragEnd: ({ active, over }) => (over ? t("droppedAt", place(active.id, over.id)) : undefined),
    onDragCancel: ({ active }) => t("dragCancelled", { name: nameOf(active.id) }),
  };

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const next = arrayMove(items, indexOf(active.id), indexOf(over.id));
    startTransition(async () => {
      showOrder(next); // shown at once; when the transition ends, React shows the server's order
      const result = await reorderCategories(next.map((category) => category.id));
      setError(result.error);
    });
  }

  const movable = items.length > 1; // UC-OWNER-003 needs at least 2 categories
  return (
    <div className="flex flex-col gap-2">
      {movable && <p className="text-sm text-stone-600">{t("reorderHint")}</p>}
      <FormAlert error={error} />
      <DndContext id={contextId} sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}
        accessibility={{ announcements, screenReaderInstructions: { draggable: t("dragInstructions") } }}>
        <SortableContext items={items.map((category) => category.id)} strategy={verticalListSortingStrategy}>
          <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200">
            {items.map((category) => <CategoryRow key={category.id} category={category} movable={movable} />)}
          </ul>
        </SortableContext>
      </DndContext>
      <p role="status" className="text-sm text-stone-600">{saving ? t("savingOrder") : ""}</p>
    </div>
  );
}

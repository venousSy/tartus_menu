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
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useLocale, useTranslations } from "next-intl";
import { Fragment, type ReactNode, useId, useOptimistic, useRef, useState, useTransition } from "react";
import type { FormError } from "@/lib/api-errors";
import { type BilingualText, pickText, toLang } from "@/lib/i18n";
import type { ActionState } from "@/lib/server/owner-actions";
import { FormAlert } from "./form-parts";

type Row = { id: number; name: BilingualText };

/**
 * A list the owner reorders by dragging a row by its handle, with a mouse, a finger or the
 * keyboard; the new order is saved at once (UC-OWNER-003 categories, UC-OWNER-004 items). The
 * rows move before Django answers; if Django refuses, React shows the last saved order again and
 * the message says why. `save` is the screen's Server Action; `renderRow` draws one SortableRow.
 */
export function SortableList<T extends Row>({ rows, save, hint, instructions, renderRow }: {
  rows: T[];
  save: (orderedIds: number[]) => Promise<ActionState>;
  hint: string; // shown above the list once there is something to move
  instructions: string; // what a screen reader says about the handles
  renderRow: (row: T, movable: boolean) => ReactNode;
}) {
  const t = useTranslations("Sortable");
  const lang = toLang(useLocale());
  const [items, showOrder] = useOptimistic(rows);
  const [error, setError] = useState<FormError | null>(null);
  const [saving, startTransition] = useTransition();
  const sensors = useSensors(
    useSensor(PointerSensor), // mouse, pen and touch; the handle has touch-action: none
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const contextId = useId(); // the same ids on the server and in the browser (no hydration mismatch)

  const indexOf = (id: UniqueIdentifier) => items.findIndex((row) => row.id === id);
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
      const result = await save(next.map((row) => row.id));
      setError(result.error);
    });
  }

  const movable = items.length > 1; // a reorder needs at least 2 rows
  return (
    <div className="flex flex-col gap-2">
      {movable && <p className="text-sm text-stone-600">{hint}</p>}
      <FormAlert error={error} />
      <DndContext id={contextId} sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}
        accessibility={{ announcements, screenReaderInstructions: { draggable: instructions } }}>
        <SortableContext items={items.map((row) => row.id)} strategy={verticalListSortingStrategy}>
          <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200">
            {items.map((row) => <Fragment key={row.id}>{renderRow(row, movable)}</Fragment>)}
          </ul>
        </SortableContext>
      </DndContext>
      <p role="status" className="text-sm text-stone-600">{saving ? t("savingOrder") : ""}</p>
    </div>
  );
}

/**
 * One row of a SortableList: the <li> that moves, with the drag handle at its start. Only the
 * handle starts a drag, so the row's own buttons stay buttons.
 */
export function SortableRow({ id, name, movable, roleDescription, children }: {
  id: number;
  name: string; // the row's name in the reader's language, for the handle's label
  movable: boolean;
  roleDescription: string; // what a screen reader calls a movable row, e.g. "movable category"
  children: ReactNode;
}) {
  const t = useTranslations("Sortable");
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id, disabled: !movable, attributes: { roleDescription } });
  return (
    <li ref={setNodeRef}
      // Only up and down (x = 0), and a translation, not dnd-kit's scale: rows differ in height.
      style={{ transform: CSS.Translate.toString(transform && { ...transform, x: 0 }), transition }}
      className={`relative flex items-start gap-2 bg-white px-4 py-3 first:rounded-t-lg last:rounded-b-lg ${isDragging ? "z-10 shadow-lg" : ""}`}>
      {movable && (
        <button type="button" ref={setActivatorNodeRef} {...attributes} {...listeners} aria-label={t("move", { name })}
          className="-ms-2 flex min-h-11 min-w-11 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-stone-500 active:cursor-grabbing">
          <GripIcon />
        </button>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2">{children}</div>
    </li>
  );
}

// Six dots, the usual sign for "drag here". The button around it carries the label.
function GripIcon() {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" fill="currentColor" aria-hidden="true">
      {[6, 10, 14].map((y) => [7, 13].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.5" />))}
    </svg>
  );
}

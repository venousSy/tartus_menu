"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import type { FormError } from "@/lib/api-errors";
import { FieldMessages, SECONDARY_BUTTON, TextField } from "../../ui/form-parts";
import type { ItemValues } from "./actions";

// GC 10: an item has at most 10 variants (sizes); a size name has at most 50 characters per language.
const MAX_VARIANTS = 10;
const VARIANT_NAME_MAX_LENGTH = 50;

/** One size row of the form. `key` stays with the row when it moves, so React keeps what was typed in it. */
type Row = ItemValues["variants"][number] & { key: number };

// The key of a row that came from `values` is its place in that list: Django names a refused
// variant by the same number ("variants.1.price"), so its messages find their row even after a move.
const toRows = (variants: ItemValues["variants"]): Row[] => variants.map((variant, key) => ({ ...variant, key }));

/**
 * The price part of an item form (GC 10): one price, or a list of sizes that each have a name and a
 * price. The owner adds, removes and moves size rows here; nothing is saved before the form is sent.
 * The inputs of row N are named "variants.N.name_ar", "variants.N.name_en" and "variants.N.price",
 * numbered in the order shown. While there are rows there is no "price" input: Django takes the
 * item's price from its sizes.
 *
 * A client component because the rows are state. `resetOn` is the form's action state: a new one
 * means the form was sent, so the rows start again from `values` (what Django kept or refused).
 */
export function PriceFields({ values, error, resetOn }: {
  values: ItemValues;
  error: FormError | null;
  resetOn: unknown;
}) {
  const t = useTranslations("Items");
  const tForms = useTranslations("Forms");
  const hintId = useId();
  const errorId = useId();
  const [rows, setRows] = useState(() => toRows(values.variants));
  // React's way to reset state when a prop changes: compare during the render, no effect needed.
  const [seen, setSeen] = useState(resetOn);
  if (seen !== resetOn) {
    setSeen(resetOn);
    setRows(toRows(values.variants));
  }

  const addRow = () => setRows((current) => [
    ...current,
    { key: Math.max(-1, ...current.map((row) => row.key)) + 1, name: { ar: "", en: "" }, price: "" },
  ]);
  const removeRow = (key: number) => setRows((current) => current.filter((row) => row.key !== key));
  /** Swaps the row at `index` with its neighbour: -1 moves it up, +1 down. */
  const moveRow = (index: number, step: -1 | 1) => setRows((current) => {
    const next = [...current];
    [next[index], next[index + step]] = [next[index + step], next[index]];
    return next;
  });

  // Errors of the list as a whole (not a list, more than 10): shown once, below the group.
  const listMessages = [...(error?.fields.variants ?? []), ...(error?.fields["variants.non_field_errors"] ?? [])];
  return (
    <>
      {rows.length === 0 && (
        <TextField label={t("price")} name="price" inputMode="decimal" required defaultValue={values.price}
          messages={error?.fields.price} />
      )}
      <fieldset aria-describedby={listMessages.length > 0 ? `${hintId} ${errorId}` : hintId} className="flex flex-col gap-2">
        <legend className="text-sm font-semibold">{t("sizes")}</legend>
        <p id={hintId} className="text-sm text-stone-600">{t("sizesHint")}</p>
        {rows.map((row, index) => (
          <fieldset key={row.key} className="flex flex-col gap-2 rounded-lg border border-stone-200 p-3">
            <legend className="px-1 text-sm font-semibold">{t("size", { number: index + 1 })}</legend>
            <div className="grid gap-3 @lg:grid-cols-3">
              <TextField label={tForms("nameAr")} name={`variants.${index}.name_ar`} lang="ar" required
                maxLength={VARIANT_NAME_MAX_LENGTH} defaultValue={row.name.ar}
                messages={error?.fields[`variants.${row.key}.name.ar`]} />
              <TextField label={tForms("nameEn")} name={`variants.${index}.name_en`} lang="en"
                maxLength={VARIANT_NAME_MAX_LENGTH} defaultValue={row.name.en}
                messages={error?.fields[`variants.${row.key}.name.en`]} />
              <TextField label={t("price")} name={`variants.${index}.price`} inputMode="decimal" required
                defaultValue={row.price} messages={error?.fields[`variants.${row.key}.price`]} />
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={index === 0} onClick={() => moveRow(index, -1)}
                aria-label={t("moveSizeUp", { number: index + 1 })} className={SECONDARY_BUTTON}>
                {t("moveUp")}
              </button>
              <button type="button" disabled={index === rows.length - 1} onClick={() => moveRow(index, 1)}
                aria-label={t("moveSizeDown", { number: index + 1 })} className={SECONDARY_BUTTON}>
                {t("moveDown")}
              </button>
              <button type="button" onClick={() => removeRow(row.key)}
                aria-label={t("removeSize", { number: index + 1 })} className={SECONDARY_BUTTON}>
                {t("remove")}
              </button>
            </div>
          </fieldset>
        ))}
        <FieldMessages id={errorId} messages={listMessages} />
        <button type="button" disabled={rows.length >= MAX_VARIANTS} onClick={addRow} className={`${SECONDARY_BUTTON} self-start`}>
          {t("addSize")}
        </button>
      </fieldset>
    </>
  );
}

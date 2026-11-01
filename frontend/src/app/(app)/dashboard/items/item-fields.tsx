import { useLocale, useTranslations } from "next-intl";
import { useId } from "react";
import type { FormError } from "@/lib/api-errors";
import { DESCRIPTION_MAX_LENGTH, pickText, toLang } from "@/lib/i18n";
import type { Category, MenuItem } from "@/lib/server/owner-api";
import { FieldMessages, NameFields, TextField } from "../form-parts";
import type { ItemValues } from "./actions";

/** The values of a new item's form: empty, in the chosen category. */
export function newItemValues(categoryId: number): ItemValues {
  return {
    category_id: String(categoryId),
    name: { ar: "", en: "" },
    description: { ar: "", en: "" },
    price: "",
    is_featured: false,
    is_new: false,
  };
}

/** The values of an existing item, for its edit form. */
export function itemValues(item: MenuItem): ItemValues {
  return {
    category_id: String(item.category_id),
    name: { ar: item.name.ar ?? "", en: item.name.en ?? "" },
    description: { ar: item.description.ar ?? "", en: item.description.en ?? "" },
    price: item.price,
    is_featured: item.is_featured,
    is_new: item.is_new,
  };
}

/**
 * The inputs of an item form (UC-OWNER-002), with Django's errors at each field. With `categories`
 * the owner can move the item to another category; without, it stays in `values.category_id`.
 * The form around them is a container (`@container`): each Arabic and English pair sits side by
 * side only where the form is wide enough.
 */
export function ItemFields({ values, error, categories }: {
  values: ItemValues;
  error: FormError | null;
  categories?: Category[];
}) {
  const t = useTranslations("Items");
  const lang = toLang(useLocale());
  const categoryErrorId = useId();
  const categoryMessages = error?.fields.category_id;
  return (
    <>
      {categories ? (
        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1">
            <span className="text-sm font-semibold">{t("category")}</span>
            <select name="category_id" defaultValue={values.category_id}
              aria-invalid={categoryMessages ? true : undefined}
              aria-describedby={categoryMessages ? categoryErrorId : undefined}
              className="min-h-11 rounded-lg border border-stone-300 bg-white px-3 aria-invalid:border-red-600">
              {categories.map((category) => (
                <option key={category.id} value={category.id}>{pickText(category.name, lang)}</option>
              ))}
            </select>
          </label>
          <FieldMessages id={categoryErrorId} messages={categoryMessages} />
        </div>
      ) : (
        <input type="hidden" name="category_id" value={values.category_id} />
      )}
      <div className="grid gap-3 @lg:grid-cols-2">
        <NameFields names={values.name} error={error} />
      </div>
      <div className="grid gap-3 @lg:grid-cols-2">
        <TextField label={t("descriptionAr")} name="description_ar" lang="ar" multiline
          maxLength={DESCRIPTION_MAX_LENGTH} defaultValue={values.description.ar}
          messages={error?.fields["description.ar"]} />
        <TextField label={t("descriptionEn")} name="description_en" lang="en" multiline
          maxLength={DESCRIPTION_MAX_LENGTH} defaultValue={values.description.en}
          messages={error?.fields["description.en"]} />
      </div>
      <TextField label={t("price")} name="price" inputMode="decimal" required defaultValue={values.price}
        messages={error?.fields.price} />
      <div className="flex flex-wrap gap-x-6">
        <Checkbox name="is_featured" label={t("featured")} defaultChecked={values.is_featured} />
        <Checkbox name="is_new" label={t("new")} defaultChecked={values.is_new} />
      </div>
    </>
  );
}

function Checkbox({ name, label, defaultChecked }: { name: string; label: string; defaultChecked: boolean }) {
  return (
    <label className="flex min-h-11 items-center gap-2">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className="size-5 accent-primary" />
      <span>{label}</span>
    </label>
  );
}

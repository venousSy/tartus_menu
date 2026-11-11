import { useLocale, useTranslations } from "next-intl";
import { useId } from "react";
import type { FormError } from "@/lib/api-errors";
import { DESCRIPTION_MAX_LENGTH, pickText, toLang } from "@/lib/i18n";
import type { Category, MenuItem } from "@/lib/server/owner-api";
import { ITEM_TAGS } from "@/lib/tags";
import { FieldMessages, NameFields, TextField } from "../../ui/form-parts";
import type { ItemValues } from "./actions";
import { PriceFields } from "./price-fields";

/** The values of a new item's form: empty, in the chosen category. */
export function newItemValues(categoryId: number): ItemValues {
  return {
    category_id: String(categoryId),
    name: { ar: "", en: "" },
    description: { ar: "", en: "" },
    price: "",
    is_featured: false,
    is_new: false,
    tags: [],
    variants: [],
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
    tags: item.tags,
    variants: item.variants.map((variant) => ({
      name: { ar: variant.name.ar ?? "", en: variant.name.en ?? "" },
      price: variant.price,
    })),
  };
}

/**
 * The inputs of an item form (UC-OWNER-002), with Django's errors at each field. With `categories`
 * the owner can move the item to another category; without, it stays in `values.category_id`.
 * The form around them is a container (`@container`): each Arabic and English pair sits side by
 * side only where the form is wide enough. `resetOn` is the form's action state (see PriceFields).
 */
export function ItemFields({ values, error, categories, resetOn }: {
  values: ItemValues;
  error: FormError | null;
  categories?: Category[];
  resetOn: unknown;
}) {
  const t = useTranslations("Items");
  const lang = toLang(useLocale());
  const tTags = useTranslations("Tags");
  const categoryErrorId = useId();
  const categoryMessages = error?.fields.category_id;
  const tagsHintId = useId();
  const tagsErrorId = useId();
  // Django names a refused code by its place in the list ("tags.1"); the whole list is "tags".
  // The boxes cannot send a wrong code, so one place below the group shows whatever came back.
  const tagMessages = Object.entries(error?.fields ?? {})
    .filter(([field]) => field === "tags" || field.startsWith("tags."))
    .flatMap(([, messages]) => messages);
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
      <PriceFields values={values} error={error} resetOn={resetOn} />
      <div className="flex flex-wrap gap-x-6">
        <Checkbox name="is_featured" label={t("featured")} defaultChecked={values.is_featured} />
        <Checkbox name="is_new" label={t("new")} defaultChecked={values.is_new} />
      </div>
      {/* GC 11: one box per tag of the fixed list, all named "tags". A <fieldset> gives the group its name. */}
      <fieldset aria-describedby={tagMessages.length > 0 ? `${tagsHintId} ${tagsErrorId}` : tagsHintId} className="flex flex-col gap-1">
        <legend className="text-sm font-semibold">{t("tags")}</legend>
        <div className="flex flex-wrap gap-x-6">
          {ITEM_TAGS.map((tag) => (
            <Checkbox key={tag} name="tags" value={tag} label={tTags(tag)} defaultChecked={values.tags.includes(tag)} />
          ))}
        </div>
        <p id={tagsHintId} className="text-sm text-stone-600">{t("tagsHint")}</p>
        <FieldMessages id={tagsErrorId} messages={tagMessages} />
      </fieldset>
    </>
  );
}

function Checkbox({ name, value, label, defaultChecked }: { name: string; value?: string; label: string; defaultChecked: boolean }) {
  return (
    <label className="flex min-h-11 items-center gap-2">
      <input type="checkbox" name={name} value={value} defaultChecked={defaultChecked} className="size-5 accent-primary" />
      <span>{label}</span>
    </label>
  );
}

// The item tags (use_cases.md Global Convention 11): a fixed list, the same codes and the same order
// as Django's MenuItem.Tag. The API stores and returns the codes; their Arabic and English texts are
// in the "Tags" messages (src/messages/*.json). Plain values and functions: the owner dashboard and
// the customer menu both use them.

/** Every tag code, in display order. Django stores an item's tags in this order too. */
export const ITEM_TAGS = ["vegan", "vegetarian", "gluten_free", "spicy", "contains_nuts", "contains_dairy"] as const;

export type ItemTag = (typeof ITEM_TAGS)[number];

/** The tags a customer can filter the menu by (UC-GUEST-001). The others are warnings: shown, never a filter. */
export const DIETARY_TAGS: readonly ItemTag[] = ["vegan", "vegetarian", "gluten_free"];

/** "dietary" (what the item is free of) or "warning" (what it contains); the two look different. */
export function tagKind(tag: ItemTag): "dietary" | "warning" {
  return DIETARY_TAGS.includes(tag) ? "dietary" : "warning";
}

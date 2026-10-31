import "server-only";

import { cacheLife, cacheTag } from "next/cache";
import type { BilingualText } from "@/lib/i18n";
import { djangoFetch } from "@/lib/server/django";

// The answer of GET /api/v1/menu/{slug}/ (system_design.md §3.4).
export type PublicMenuItem = {
  id: number;
  name: BilingualText;
  description: BilingualText;
  price: string;
  image_url: string;
  is_available: boolean;
  is_featured: boolean;
  is_new: boolean;
  sort_order: number;
};

export type PublicCategory = {
  id: number;
  name: BilingualText;
  sort_order: number;
  items: PublicMenuItem[];
};

export type PublicCafe = {
  name: BilingualText;
  primary_color: string;
  logo_url: string;
  is_active: boolean;
};

export type PublicMenu = { cafe: PublicCafe; categories: PublicCategory[] };

/** The cache tag of one cafe's menu; /internal/revalidate must use the very same string. */
export const menuTag = (slug: string) => `menu:${slug}`;

/**
 * The menu of one cafe as customers see it, or null for an unknown slug (UC-GUEST-001 A1).
 * The result is cached and shared by every customer. It is rebuilt when Django revalidates the
 * tag `menu:<slug>` after a change (§3.5), and at most every 5 minutes as a fallback (GC 9).
 */
export async function getPublicMenu(slug: string): Promise<PublicMenu | null> {
  "use cache";
  cacheTag(menuTag(slug));
  cacheLife({ revalidate: 300 });

  const response = await djangoFetch(`/menu/${encodeURIComponent(slug)}/`);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    // Throw instead of returning a value: an outage must never be cached as an empty menu.
    throw new Error(`The menu API answered ${response.status} for "${slug}".`);
  }
  return response.json();
}

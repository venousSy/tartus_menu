import "server-only";

import { redirect } from "next/navigation";
import { cache } from "react";

import type { BilingualText } from "@/lib/i18n";
import { ApiError, apiFetch, apiGet } from "@/lib/server/api";
import type { ItemTag } from "@/lib/tags";

// The Cafe Owner's reads of Django (system_design.md §3.6), through api.ts.

/** GET /api/v1/dashboard/settings/ (UC-OWNER-014): the cafe profile, its plan and its subscription state. */
export type CafeSettings = {
  name: BilingualText;
  slug: string;
  primary_color: string; // stored value, even when the plan hides it from customers (GC 7)
  logo_url: string;
  is_active: boolean;
  subscription_expires_on: string | null; // the last paid day, "YYYY-MM-DD"; null = no end date (GC 5)
  days_left: number | null; // 0 on the last day; null when inactive or without an end date
  plan: {
    name: string; // the plan code: "basic" or "pro"
    max_categories: number | null; // null = unlimited
    max_items: number | null;
    allows_images: boolean;
    allows_branding: boolean;
    allows_detailed_analytics: boolean; // menu opens per hour and per table (UC-OWNER-016)
  };
};

/** The periods the analytics endpoints accept, in days (UC-OWNER-015). */
export const ANALYTICS_PERIODS = [7, 30, 90] as const;
export type AnalyticsPeriod = (typeof ANALYTICS_PERIODS)[number];

/** GET /api/v1/dashboard/analytics/summary/ (UC-OWNER-015): menu opens per day, oldest first, empty days as 0. */
export type AnalyticsSummary = { days: number; total: number; by_day: { date: string; count: number }[] };

/** GET /api/v1/dashboard/analytics/detail/ (UC-OWNER-016): 24 hours of the day, and the tables with opens (0 = no table). */
export type AnalyticsDetail = {
  days: number;
  total: number;
  by_hour: { hour: number; count: number }[];
  by_table: { table_number: number; count: number }[];
};

/** A category of GET /api/v1/dashboard/categories/ (UC-OWNER-012), hidden ones included. */
export type Category = { id: number; name: BilingualText; sort_order: number; is_visible: boolean };

/** An item of GET /api/v1/dashboard/items/ (UC-OWNER-013), unavailable ones included. */
export type MenuItem = {
  id: number;
  category_id: number;
  name: BilingualText;
  description: BilingualText;
  price: string; // two decimals, as Django sends it: "50.00" (GC 10)
  image_url: string;
  thumbnail_url: string; // at most 192 px, for the list's 64 px picture; image_url for older uploads
  is_available: boolean;
  is_featured: boolean;
  is_new: boolean;
  tags: ItemTag[]; // codes of the fixed list, each once, in the list's order (GC 11); [] without tags
  // Sizes with their own prices, in the owner's order (GC 10); [] for an item with one price.
  // With sizes, `price` is the lowest of their prices. An id changes with every save of the list.
  variants: { id: number; name: BilingualText; price: string }[];
  sort_order: number;
};

/** An active table and its QR code (UC-OWNER-007, UC-OWNER-011). */
export type QrTable = {
  id: number;
  table_number: number;
  url: string; // the customer menu with ?table=N (GC 4)
  qr_token: string;
  qr_image_url: string; // "data:image/png;base64,...": nothing is stored on R2
};

/** GET /api/v1/dashboard/qr/preview/ (UC-OWNER-011): the active tables in table order. */
export type QrCodes = { table_count: number; tables: QrTable[] };

/**
 * The cafe's settings (UC-OWNER-014). cache(): the layout and the page of one request share one call.
 * It is also the role re-check behind proxy.ts. This is the only owner endpoint without the
 * active-cafe check (GC 5), so its only 403 is the role check: the account is no longer a Cafe
 * Owner with a cafe, but the role claim in its token still says so. Django writes that claim at
 * login and every refresh copies it, so only a new login fixes it: the session ends here.
 */
export const getSettings = cache(async (): Promise<CafeSettings> => {
  try {
    return await apiGet<CafeSettings>("/dashboard/settings/");
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) redirect("/bff/auth/session-ended");
    throw error; // also the redirects of apiFetch, which work by throwing
  }
});

/** The cafe's categories in menu order (UC-OWNER-012). Django answers 403 for an inactive cafe (GC 5). */
export function getCategories(): Promise<Category[]> {
  return apiGet<Category[]>("/dashboard/categories/");
}

/** All the cafe's items in menu order: by category, then inside it (UC-OWNER-013). 403 when inactive. */
export function getItems(): Promise<MenuItem[]> {
  return apiGet<MenuItem[]>("/dashboard/items/");
}

/** The cafe's active tables with their QR codes (UC-OWNER-011). Read-only; 403 when inactive. */
export function getQrCodes(): Promise<QrCodes> {
  return apiGet<QrCodes>("/dashboard/qr/preview/");
}

/** The cafe's menu opens per day for the last `days` days (UC-OWNER-015). Every plan; 403 when inactive. */
export function getAnalyticsSummary(days: AnalyticsPeriod): Promise<AnalyticsSummary> {
  return apiGet<AnalyticsSummary>(`/dashboard/analytics/summary/?days=${days}`);
}

/**
 * The opens per hour of the day and per table (UC-OWNER-016). Django answers 403 for a plan without
 * allows_detailed_analytics, so a page calls this only when the settings show the flag.
 */
export function getAnalyticsDetail(days: AnalyticsPeriod): Promise<AnalyticsDetail> {
  return apiGet<AnalyticsDetail>(`/dashboard/analytics/detail/?days=${days}`);
}

/**
 * Django's answer to the PDF download (UC-OWNER-008), as it is, for a route handler to pass on; null
 * when Django cannot be reached. djangoFetch asks for JSON, which the view accepts like
 * "application/pdf" (its PDFRenderer); the PDF comes back either way, because the view returns the
 * file itself, and an error comes back as JSON.
 */
export function getQrPdf(): Promise<Response | null> {
  return apiFetch("/dashboard/qr/download-pdf/");
}

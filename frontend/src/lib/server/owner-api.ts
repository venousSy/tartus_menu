import "server-only";

import { redirect } from "next/navigation";
import { cache } from "react";

import type { BilingualText } from "@/lib/i18n";
import { ApiError, apiFetch, apiGet } from "@/lib/server/api";

// The Cafe Owner's reads of Django (system_design.md §3.6), through api.ts.

/** GET /api/v1/dashboard/settings/ (UC-OWNER-014): the cafe profile, its plan and its subscription state. */
export type CafeSettings = {
  name: BilingualText;
  slug: string;
  primary_color: string; // stored value, even when the plan hides it from customers (GC 7)
  logo_url: string;
  is_active: boolean;
  plan: {
    name: string; // the plan code: "basic" or "pro"
    max_categories: number | null; // null = unlimited
    max_items: number | null;
    allows_images: boolean;
    allows_branding: boolean;
  };
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

/**
 * Django's answer to the PDF download (UC-OWNER-008), as it is, for a route handler to pass on; null
 * when Django cannot be reached. djangoFetch asks for JSON, which the view accepts like
 * "application/pdf" (its PDFRenderer); the PDF comes back either way, because the view returns the
 * file itself, and an error comes back as JSON.
 */
export function getQrPdf(): Promise<Response | null> {
  return apiFetch("/dashboard/qr/download-pdf/");
}

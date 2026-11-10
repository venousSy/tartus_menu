import "server-only";

import { redirect } from "next/navigation";

import type { BilingualText } from "@/lib/i18n";
import { ApiError, type ApiInit, apiGet, apiWrite, type WriteResult } from "@/lib/server/api";

// The Super Admin's calls of Django (UC-ADMIN-001 to 009, system_design.md §3), through api.ts.
// Every admin endpoint has only one permission rule, role == SYSTEM_ADMIN, so every 403 here means
// the account is no longer a Super Admin while its token still says so. Only a new login fixes
// that (the role claim is copied on every refresh), so the session ends, as for getSettings.

/** One row of GET /api/v1/admin/cafes/ (UC-ADMIN-002). */
export type AdminCafeSummary = {
  id: number;
  name: BilingualText;
  slug: string;
  plan: string; // the plan code: "basic" or "pro"
  is_active: boolean;
  owner_email: string;
  subscription_expires_on: string | null; // the last paid day, "YYYY-MM-DD"; null = no end date (GC 5)
  days_left: number | null; // 0 on the last day, negative when overdue; null when inactive or without an end date
};

/** GET /api/v1/admin/cafes/{id}/ (UC-ADMIN-003), also the answer of create, activate, deactivate and edit. */
export type AdminCafe = AdminCafeSummary & {
  subscription_start_at: string | null; // ISO 8601; null until the first activation
  subscription_end_at: string | null; // null while the current period runs
  logo_url: string; // stored values, also when the plan hides them from customers (GC 7)
  primary_color: string;
};

/** A page of DRF's PageNumberPagination. */
export type Page<T> = { count: number; next: string | null; previous: string | null; results: T[] };

/** Rows per page of the cafe list: Django's AdminCafePagination.page_size. */
export const CAFES_PER_PAGE = 20;

/** One entry of GET /api/v1/admin/cafes/{id}/billing/ (UC-ADMIN-008), newest first. */
export type BillingEvent = {
  action: "activated" | "deactivated" | "plan_changed" | "renewed" | "expired";
  notes: string;
  performed_by_email: string | null; // null for "expired" (the system), or when that admin account was deleted later
  created_at: string;
};

/** POST /api/v1/admin/cafes/{id}/password-reset-link/ (UC-ADMIN-010). */
export type PasswordResetLink = {
  url: string; // <site>/reset-password#<uid>.<token>; whoever holds it can set the owner's password
  expires_at: string; // ISO 8601, 24 hours after it was made
};

/** GET /api/v1/admin/stats/ (UC-ADMIN-009). */
export type PlatformStats = {
  total_cafes: number;
  active_cafes: number;
  inactive_cafes: number;
  basic_plan_count: number;
  pro_plan_count: number;
  expiring_soon_cafes: number; // active, 7 days or fewer left, overdue ones included
};

/** A read for a page; a 403 ends the session (see above). */
async function adminGet<T>(path: string): Promise<T> {
  try {
    return await apiGet<T>(path);
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) redirect("/bff/auth/session-ended");
    throw error; // also the redirects of apiFetch, which work by throwing
  }
}

/** A write from a Server Action; a 403 ends the session, other refusals go back to the form. */
export async function adminWrite<T>(path: string, init: ApiInit): Promise<WriteResult<T>> {
  const result = await apiWrite<T>(path, init);
  if (!result.ok && result.status === 403) redirect("/bff/auth/session-ended");
  return result;
}

/** The platform's numbers for the admin home page (UC-ADMIN-009). */
export function getStats(): Promise<PlatformStats> {
  return adminGet<PlatformStats>("/admin/stats/");
}

/**
 * One page of all cafes, newest first, optionally filtered by a search text (UC-ADMIN-002). null
 * when `page` is past the last page: DRF answers 404 "Invalid page." there, and the list page then
 * offers page 1 instead of the error screen.
 */
export async function getCafes(page: number, search: string): Promise<Page<AdminCafeSummary> | null> {
  const query = new URLSearchParams({ page: String(page), ...(search ? { search } : {}) });
  try {
    return await adminGet<Page<AdminCafeSummary>>(`/admin/cafes/?${query}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** One cafe (UC-ADMIN-003). `id` must already be a checked id (isId); Django answers 404 for an unknown one. */
export function getCafe(id: number): Promise<AdminCafe> {
  return adminGet<AdminCafe>(`/admin/cafes/${id}/`);
}

/** The cafe's billing history, newest first (UC-ADMIN-008). */
export function getBilling(id: number): Promise<BillingEvent[]> {
  return adminGet<BillingEvent[]>(`/admin/cafes/${id}/billing/`);
}

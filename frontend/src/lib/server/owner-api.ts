import "server-only";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { type FormError, SERVER_ERROR, toFormError } from "@/lib/api-errors";
import type { BilingualText } from "@/lib/i18n";
import { djangoFetch } from "@/lib/server/django";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "@/lib/server/session";

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

/** A write's result: Django's answer on success (null for 204 No Content), or the error for the form. */
export type WriteResult<T> = { ok: true; data: T } | { ok: false; error: FormError };

/** A Django answer a page cannot use. The page's error screen shows it; the layout reads `status` (403). */
export class OwnerApiError extends Error {
  readonly status: number;
  readonly error: FormError;

  constructor(status: number, error: FormError) {
    super(`The owner API answered ${status}.`);
    this.status = status;
    this.error = error;
  }
}

type OwnerInit = { method?: "POST" | "PATCH" | "DELETE"; json?: object; form?: FormData };

/**
 * Calls one of Django's owner endpoints with the signed-in user's access token (system_design.md
 * §3.6). Django decides every permission; this module only carries the token. `path` starts after
 * /api/v1. Returns null when Django cannot be reached; redirects when there is no session.
 */
async function ownerFetch(path: string, { method, json, form }: OwnerInit = {}): Promise<Response | null> {
  const cookieStore = await cookies();
  const access = cookieStore.get(ACCESS_COOKIE)?.value;
  if (!access) {
    // proxy.ts refreshes an expired access token before every dashboard request. If it is still
    // missing while a refresh cookie exists, Django could not be reached: never log anyone out for that.
    if (cookieStore.has(REFRESH_COOKIE)) return null;
    redirect("/login");
  }
  const forwardedFor = (await headers()).get("x-forwarded-for");
  let response: Response;
  try {
    response = await djangoFetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${access}`,
        ...(json ? { "Content-Type": "application/json" } : {}),
        ...(forwardedFor ? { "X-Forwarded-For": forwardedFor } : {}),
      },
      body: json ? JSON.stringify(json) : form, // FormData: fetch sets the multipart Content-Type itself
    });
  } catch {
    return null;
  }
  // Django no longer accepts the token, for example because the account was deactivated. redirect()
  // works by throwing, so it stays outside the try block above (Next docs).
  if (response.status === 401) redirect("/bff/auth/session-ended");
  return response;
}

/** A read for a page. Any answer other than 2xx throws OwnerApiError, so the page shows its error screen. */
async function ownerGet<T>(path: string): Promise<T> {
  const response = await ownerFetch(path);
  if (!response) throw new OwnerApiError(503, SERVER_ERROR);
  if (!response.ok) throw new OwnerApiError(response.status, toFormError(await response.json().catch(() => null)));
  return response.json();
}

/** A write from a Server Action. Errors are returned, not thrown, so the form can show them at its fields. */
export async function ownerWrite<T>(path: string, init: OwnerInit): Promise<WriteResult<T>> {
  const response = await ownerFetch(path, init);
  if (!response) return { ok: false, error: SERVER_ERROR };
  if (!response.ok) return { ok: false, error: toFormError(await response.json().catch(() => null)) };
  return { ok: true, data: response.status === 204 ? (null as T) : await response.json() };
}

/** The cafe's settings (UC-OWNER-014). cache(): the layout and the page of one request share one call. */
export const getSettings = cache(() => ownerGet<CafeSettings>("/dashboard/settings/"));

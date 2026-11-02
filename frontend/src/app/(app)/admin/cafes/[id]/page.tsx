import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { formatDateTime, pickText, toLang } from "@/lib/i18n";
import { getBilling, getCafe } from "@/lib/server/admin-api";
import { ApiError } from "@/lib/server/api";
import { BilingualName } from "../../../ui/form-parts";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("AdminCafe"))("title") };
}

/**
 * The cafe and its billing history, or the 404 page. The id comes from the address, so only digits
 * of a positive safe integer go to Django ("1e1" or "0x1F" would be numbers too); Django answers 404
 * for an unknown cafe (UC-ADMIN-003 A1, UC-ADMIN-008 A2).
 */
async function load(id: string) {
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) notFound();
  try {
    return await Promise.all([getCafe(Number(id)), getBilling(Number(id))]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error; // also the redirects of apiFetch, which work by throwing
  }
}

// One cafe for the Super Admin (UC-ADMIN-003) with its billing log (UC-ADMIN-008), as in
// system_design.md §4.1. Activate, deactivate, edit and delete come in the next steps.
export default async function AdminCafePage({ params }: PageProps<"/admin/cafes/[id]">) {
  const [[cafe, billing], t, locale] = await Promise.all([load((await params).id), getTranslations("AdminCafe"), getLocale()]);
  const lang = toLang(locale);
  const date = (iso: string | null) => (iso ? formatDateTime(iso, lang) : t("never"));
  return (
    <section className="flex flex-col gap-6">
      <Link href="/admin/cafes" className="self-start font-semibold text-primary underline">{t("back")}</Link>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-2xl font-bold"><BilingualName name={cafe.name} /></h2>
        <span className={`rounded px-2 py-0.5 text-sm font-semibold ${cafe.is_active ? "bg-green-100 text-green-900" : "bg-amber-100 text-amber-900"}`}>
          {cafe.is_active ? t("active") : t("inactive")}
        </span>
      </div>
      <dl className="grid gap-px overflow-hidden rounded-lg border border-stone-200 bg-stone-200 sm:grid-cols-2">
        <Row label={t("slug")}>
          <bdi dir="ltr" className="font-mono">{cafe.slug}</bdi>{" "}
          {/* A new tab keeps the dashboard open. A plain <a>: the menu has its own root layout. */}
          <a href={`/menu/${encodeURIComponent(cafe.slug)}`} target="_blank" rel="noopener" className="text-sm font-normal text-primary underline">
            {t("openMenu")}<span className="sr-only"> {t("newTab")}</span>
          </a>
        </Row>
        <Row label={t("plan")}>{t("planName", { name: cafe.plan })}</Row>
        <Row label={t("owner")}><bdi dir="ltr">{cafe.owner_email}</bdi></Row>
        <Row label={t("subscriptionStart")}>{date(cafe.subscription_start_at)}</Row>
        <Row label={t("subscriptionEnd")}>{cafe.subscription_end_at ? date(cafe.subscription_end_at) : cafe.is_active ? t("running") : t("never")}</Row>
        <Row label={t("color")}>
          {cafe.primary_color ? (
            <span className="flex items-center gap-2">
              <span aria-hidden="true" className="inline-block size-4 rounded border border-stone-300" style={{ backgroundColor: cafe.primary_color }} />
              <bdi dir="ltr" className="font-mono">{cafe.primary_color}</bdi>
            </span>
          ) : t("defaultColor")}
        </Row>
        <Row label={t("logo")}>
          {cafe.logo_url
            ? <Image src={cafe.logo_url} alt={t("logoAlt", { name: pickText(cafe.name, lang) })} width={64} height={64} unoptimized className="size-16 rounded-lg bg-stone-100 object-contain" />
            : t("noLogo")}
        </Row>
      </dl>
      <div className="flex flex-col gap-3">
        <h3 className="text-xl font-bold">{t("billing")}</h3>
        {billing.length === 0 ? (
          <p className="text-stone-600">{t("noBilling")}</p>
        ) : (
          <ol className="flex flex-col divide-y divide-stone-200 overflow-hidden rounded-lg border border-stone-200 bg-white">
            {billing.map((event, index) => (
              // Django sends no id for an event; the list never changes order while it is shown.
              <li key={index} className="flex flex-col gap-1 px-4 py-3">
                <span className="flex flex-wrap items-baseline justify-between gap-x-4">
                  <span className="font-semibold">{t("action", { action: event.action })}</span>
                  <time dateTime={event.created_at} className="text-sm text-stone-600">{formatDateTime(event.created_at, lang)}</time>
                </span>
                {event.notes && <p dir="auto" className="whitespace-pre-line">{event.notes}</p>}
                <span className="text-sm text-stone-600">
                  {event.performed_by_email
                    ? t.rich("by", { email: event.performed_by_email, mail: (chunks) => <bdi dir="ltr">{chunks}</bdi> })
                    : t("byDeleted")}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 bg-white px-4 py-3">
      <dt className="text-sm text-stone-600">{label}</dt>
      <dd className="font-semibold">{children}</dd>
    </div>
  );
}

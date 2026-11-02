import type { Metadata } from "next";
import Image from "next/image";
import { getTranslations } from "next-intl/server";
import { BRAND_COLOR } from "@/app/brand-mark";
import { getSettings } from "@/lib/server/owner-api";
import { LogoForm } from "./logo-form";
import { SettingsForm } from "./settings-form";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("Settings"))("title") };
}

// The Settings screen: the cafe profile (UC-OWNER-014), its names and menu color (UC-OWNER-009) and
// its logo (UC-OWNER-010). GET settings is the one owner call that also works for an inactive cafe
// (GC 5), so this page always reads; only the forms need an active subscription.
export default async function SettingsPage() {
  const [settings, t, tErrors] = await Promise.all([
    getSettings(), getTranslations("Settings"), getTranslations("ApiErrors"),
  ]);
  const branding = settings.plan.allows_branding; // the plan's flag, never its name (GC 3)
  return (
    <section className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">{t("title")}</h2>
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold">{t("slug")}</span>
        <span dir="ltr" className="self-start font-mono">{settings.slug}</span>
        <p className="text-sm text-stone-600">{t("slugHint")}</p>
      </div>
      {settings.is_active ? (
        <SettingsForm settings={settings} defaultColor={BRAND_COLOR} />
      ) : (
        // GC 5: Django refuses the change of an inactive cafe, so the form is not offered.
        <p className="text-stone-600">{t("inactive")}</p>
      )}
      <div className="flex flex-col gap-3 rounded-lg border border-stone-200 bg-white p-4">
        <h3 className="font-bold">{t("logo")}</h3>
        {settings.logo_url ? (
          // GC 7: a plan without branding keeps the stored logo but hides it from customers: faded here.
          <Image src={settings.logo_url} alt={t("currentLogo")} width={96} height={96} unoptimized
            className={`size-24 rounded-lg bg-stone-100 object-contain ${branding ? "" : "opacity-50 grayscale"}`} />
        ) : (
          <p className="text-sm text-stone-600">{t("noLogo")}</p>
        )}
        {!branding ? (
          // The text Django answers to a logo on this plan (A1), and what happens to a stored one.
          <p className="text-sm text-stone-600">
            {tErrors("logosNeedPro")} {settings.logo_url && t("logoKept")}
          </p>
        ) : (
          settings.is_active && <LogoForm />
        )}
      </div>
      {!branding && (
        // The text Django answers to a color on this plan (A2), shown before the owner tries; a
        // stored color stays and comes back after an upgrade (GC 7).
        <p className="flex flex-wrap items-center gap-2 text-sm text-stone-600">
          {tErrors("colorsNeedPro")}
          {settings.primary_color && (
            <>
              <span aria-hidden="true" className="inline-block size-4 rounded border border-stone-300"
                style={{ backgroundColor: settings.primary_color }} />
              {/* <bdi>: "#C0392B" keeps its "#" in front inside Arabic text too. */}
              {t.rich("colorKept", {
                color: settings.primary_color,
                code: (chunks) => <bdi dir="ltr" className="font-mono">{chunks}</bdi>,
              })}
            </>
          )}
        </p>
      )}
    </section>
  );
}

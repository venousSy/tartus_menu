import type { Metadata } from "next";
import Image from "next/image";
import { getTranslations } from "next-intl/server";
import { getQrCodes, getSettings } from "@/lib/server/owner-api";
import { PRIMARY_BUTTON } from "../form-parts";
import { GenerateForm } from "./generate-form";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("Qr"))("title") };
}

// The QR codes screen: the number of tables that creates the codes (UC-OWNER-007), the codes on
// screen (UC-OWNER-011) and the PDF to print them (UC-OWNER-008, through /bff/dashboard/qr-pdf).
export default async function QrPage() {
  const [settings, t] = await Promise.all([getSettings(), getTranslations("Qr")]);
  if (!settings.is_active) {
    // GC 5: Django refuses every QR call of an inactive cafe, so the page makes none.
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-2xl font-bold">{t("title")}</h2>
        <p className="text-stone-600">{t("inactive")}</p>
      </section>
    );
  }

  const { table_count: count, tables } = await getQrCodes();
  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-bold">{t("title")}</h2>
        {count > 0 && <p className="text-sm text-stone-600">{t("count", { count })}</p>}
      </div>
      <GenerateForm tableCount={count} />
      {count === 0 ? (
        <p className="text-stone-600">{t("empty")}</p>
      ) : (
        <>
          {/* A plain link: Django's "Content-Disposition: attachment" makes the browser save the file
              and stay on this page. A `download` attribute would also save the page an error leads to. */}
          <a href="/bff/dashboard/qr-pdf" className={`${PRIMARY_BUTTON} flex items-center self-start`}>
            {t("downloadPdf")}
          </a>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {tables.map((table) => (
              <li key={table.id} className="flex flex-col items-center gap-2 rounded-lg border border-stone-200 bg-white p-3">
                <Image src={table.qr_image_url} alt={t("qrAlt", { number: table.table_number })} width={160} height={160}
                  unoptimized className="h-auto w-full max-w-40" />
                <span className="font-semibold">{t("table", { number: table.table_number })}</span>
                {/* The address the code opens (GC 4), left to right in both languages. */}
                <span dir="ltr" className="break-all text-center text-xs text-stone-600">{table.url}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

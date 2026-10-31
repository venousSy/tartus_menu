import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";
import { Suspense } from "react";
import { dirOf, toLang } from "@/lib/i18n";
import { cairo } from "../fonts";
import "../globals.css";

export const metadata: Metadata = {
  title: "Tartus Smart Digital Menu",
};

// The root layout of the signed-in side: login, the owner dashboard and the Super Admin screens.
// Their language comes from the `lang` cookie, which is request data. With Cache Components, the
// <Suspense> around <html> tells Next.js that these pages render per request; they show each
// user's own data anyway. The customer menu has its own root layout and stays cached.
export default function AppRootLayout({ children }: LayoutProps<"/">) {
  return (
    <Suspense>
      <AppDocument>{children}</AppDocument>
    </Suspense>
  );
}

async function AppDocument({ children }: { children: React.ReactNode }) {
  const lang = toLang(await getLocale());
  return (
    <html lang={lang} dir={dirOf(lang)} className={cairo.variable}>
      <body className="min-h-dvh bg-stone-50 text-stone-900">
        {/* Gives client components the language and the messages from src/i18n/request.ts. */}
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}

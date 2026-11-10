import type { Metadata } from "next";
import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "../page-header";
import { ResetForm } from "./reset-form";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("ResetPassword"))("title"), robots: { index: false, follow: false } };
}

// The page a one-time reset link opens (UC-AUTH-005). No session is needed, so proxy.ts does not
// run for it. The link's secret part is after "#": only the browser sees it (reset-form.tsx).
export default function ResetPasswordPage() {
  const t = useTranslations("ResetPassword");
  return (
    <>
      <PageHeader title={t("title")} />
      <ResetForm />
    </>
  );
}

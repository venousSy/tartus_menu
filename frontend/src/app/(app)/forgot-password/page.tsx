import type { Metadata } from "next";
import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "../page-header";
import { ForgotForm } from "./forgot-form";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("ForgotPassword"))("title"), robots: { index: false, follow: false } };
}

// "Forgot password?" (UC-AUTH-006), linked from the login page. No session is needed, so proxy.ts
// does not run for it.
export default function ForgotPasswordPage() {
  const t = useTranslations("ForgotPassword");
  return (
    <>
      <PageHeader title={t("title")} />
      <ForgotForm />
    </>
  );
}

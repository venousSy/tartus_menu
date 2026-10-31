import type { Metadata } from "next";
import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "../page-header";
import { LoginForm } from "./login-form";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("Login"))("title") };
}

// Both roles log in here (UC-AUTH-001). proxy.ts sends users who are already signed in to their home.
export default function LoginPage() {
  const t = useTranslations("Login");
  return (
    <>
      <PageHeader title={t("title")} />
      <LoginForm />
    </>
  );
}

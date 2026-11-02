import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { CreateCafeForm } from "./create-cafe-form";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("AdminCreate"))("title") };
}

// The create screen (UC-ADMIN-001). It reads nothing: Django checks the role when the form is sent.
export default async function CreateCafePage() {
  const t = await getTranslations("AdminCreate");
  return (
    <section className="flex flex-col gap-4">
      <Link href="/admin/cafes" className="self-start font-semibold text-primary underline">{t("back")}</Link>
      <h2 className="text-2xl font-bold">{t("title")}</h2>
      {/* Postcondition of UC-ADMIN-001: a new cafe is inactive until a Super Admin activates it. */}
      <p className="text-stone-600">{t("intro")}</p>
      <CreateCafeForm />
    </section>
  );
}

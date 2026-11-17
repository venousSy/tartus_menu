import type { Metadata } from "next";
import { THEME_SCRIPT } from "@/lib/theme";
import { cairo } from "../fonts";
import "../globals.css";

export const metadata: Metadata = {
  title: "Tartus Smart Digital Menu",
};

// Customer pages always start in Arabic (right to left). The language switch
// runs in the browser (step 9), so this layout never reads a cookie and the
// cached menu page is the same for every customer.
// The theme choice (UC-GUEST-001 step 10) is applied by a small inline script before the page is
// first drawn. It sets data-theme on <html> before React starts, so React must not treat that
// attribute as a mismatch (suppressHydrationWarning covers the attributes of <html> only).
export default function CustomerRootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ar" dir="rtl" className={cairo.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

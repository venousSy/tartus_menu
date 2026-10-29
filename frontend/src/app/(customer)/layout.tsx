import type { Metadata } from "next";
import { Cairo } from "next/font/google";
import "../globals.css";

// Cairo is a variable font: one file per subset holds every weight, for both
// Arabic and English text. next/font downloads it at build time and serves it
// from our own domain, so customers' browsers never contact Google.
const cairo = Cairo({
  subsets: ["arabic", "latin"],
  variable: "--font-cairo",
});

export const metadata: Metadata = {
  title: "Tartus Smart Digital Menu",
};

// Customer pages always start in Arabic (right to left). The language switch
// runs in the browser (step 9), so this layout never reads a cookie and the
// cached menu page is the same for every customer.
export default function CustomerRootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ar" dir="rtl" className={cairo.variable}>
      <body>{children}</body>
    </html>
  );
}

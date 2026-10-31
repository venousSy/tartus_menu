import type { Metadata } from "next";
import { cairo } from "../fonts";
import "../globals.css";

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

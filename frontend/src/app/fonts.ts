import { Cairo } from "next/font/google";

// Loaded once here and imported by both root layouts: every call to Cairo() would add another
// copy of the font to the app. Cairo is a variable font: one file per subset holds every weight,
// for both Arabic and English text. next/font downloads it at build time and serves it from our
// own domain, so browsers never contact Google.
export const cairo = Cairo({
  subsets: ["arabic", "latin"],
  variable: "--font-cairo",
});

import { redirect } from "next/navigation";

import { getQrPdf } from "@/lib/server/owner-api";

/**
 * GET /bff/dashboard/qr-pdf: the print-ready PDF of the cafe's QR codes (UC-OWNER-008, D7). The
 * browser never holds a token, so this route asks Django with the owner's access token and passes
 * the file on as it arrives. proxy.ts has already refreshed an expired token. Without a session,
 * getQrPdf goes to /login; when Django rejects the token, to /bff/auth/session-ended.
 */
export async function GET() {
  const response = await getQrPdf();
  if (response?.ok) {
    return new Response(response.body, {
      headers: {
        "Content-Type": "application/pdf",
        // Django's attachment header, filename="qrcodes.pdf": the browser saves the file.
        "Content-Disposition": response.headers.get("content-disposition") ?? 'attachment; filename="qrcodes.pdf"',
        "Cache-Control": "no-store", // built from the current slug and tables on every request
      },
    });
  }
  if (response && response.status < 500) {
    // No active tables (A1), an inactive cafe (A2) or a role that changed: the QR page says which.
    redirect("/dashboard/qr");
  }
  throw new Error(`The QR PDF could not be loaded (${response ? `Django answered ${response.status}` : "Django unreachable"}).`);
}

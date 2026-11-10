import type { Metadata } from "next";

import { Notice } from "../menu/[slug]/notice";

export const metadata: Metadata = { robots: { index: false, follow: false } };

// Where /t/<token> sends a scan whose code belongs to no table (UC-GUEST-003 A3).
export default function QrInvalidPage() {
  return <Notice messageKey="qrInvalid" />;
}

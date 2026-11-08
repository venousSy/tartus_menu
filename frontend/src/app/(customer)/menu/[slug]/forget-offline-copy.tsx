"use client";

import { useEffect } from "react";

/**
 * Rendered by the notices: a menu that is not found or unavailable (UC-GUEST-002) must not open from
 * the offline copy either. The worker (public/sw.js) keeps a copy only after MenuView confirms it,
 * so this page is never kept; this asks it to drop the menu it kept earlier.
 */
export function ForgetOfflineCopy() {
  useEffect(() => {
    navigator.serviceWorker?.controller?.postMessage({ type: "forget", page: location.href });
  }, []);
  return null;
}

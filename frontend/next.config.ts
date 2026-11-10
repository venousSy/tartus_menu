import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// Connects next-intl to src/i18n/request.ts.
const withNextIntl = createNextIntlPlugin();

// Django's own answers get these from its middleware; Next.js pages need them here. Set in Nginx
// instead, they would be doubled on /api/ and lost on /menu/ (a location with its own add_header).
const SECURITY_HEADERS = [
  // No page may be shown inside another site's frame (clickjacking). The CSP form is the modern one.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // The same value as Django's default: other sites never see which page a visitor came from.
  { key: "Referrer-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  /* config options here */
  // The repository's root AGENTS.md is the only rule file: stop `next dev`
  // from writing a second one into frontend/.
  agentRules: false,
  cacheComponents: true,
  partialPrefetching: true,
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      // The reset page is opened from a one-time link (UC-AUTH-005): it tells no other page, not even
      // one of this site, where the visitor came from. A later entry wins over the one above.
      { source: "/reset-password", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
    ];
  },
  experimental: {
    serverActions: {
      // Image uploads go through Server Actions. A file may be up to 2 MB (UC-OWNER-006, checked
      // by Django), plus a few KB of multipart overhead; Nginx allows 3 MB too. The default is 1 MB.
      bodySizeLimit: "3mb",
    },
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default withNextIntl(nextConfig);

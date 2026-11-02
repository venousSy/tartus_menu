import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// Connects next-intl to src/i18n/request.ts.
const withNextIntl = createNextIntlPlugin();

const nextConfig: NextConfig = {
  /* config options here */
  // The repository's root AGENTS.md is the only rule file: stop `next dev`
  // from writing a second one into frontend/.
  agentRules: false,
  cacheComponents: true,
  partialPrefetching: true,
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

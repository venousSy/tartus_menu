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

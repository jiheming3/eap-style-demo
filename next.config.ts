import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.EAP_NEXT_DIST_DIR ?? ".next",
  poweredByHeader: false,
  devIndicators: false,
  turbopack: { root: process.cwd() },
};

export default nextConfig;

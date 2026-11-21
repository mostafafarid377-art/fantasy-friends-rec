import type { NextConfig } from "next";

const previewEnabled = process.env.NODE_ENV === "development" && process.env.LINEUP_DESIGN_PREVIEW === "1";

const nextConfig: NextConfig = previewEnabled ? {
  devIndicators: false,
  allowedDevOrigins: ["*.e2b.app"],
  async redirects() {
    return [{ source: "/", destination: "/team/next-match-preview", permanent: false }];
  },
} : {};

export default nextConfig;
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["mupdf"],
  outputFileTracingIncludes: {
    "/api/ai/parse-flyer": [
      "./node_modules/mupdf/**/*",
    ],
  },
};

export default nextConfig;

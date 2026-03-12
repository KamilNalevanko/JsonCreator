import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@napi-rs/canvas", "pdfjs-dist"],
  outputFileTracingIncludes: {
    "/api/ai/parse-flyer": [
      "./node_modules/pdfjs-dist/**/*",
    ],
  },
};

export default nextConfig;

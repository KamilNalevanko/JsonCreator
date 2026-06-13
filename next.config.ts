import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["mupdf"],
  outputFileTracingIncludes: {
    "/api/ai/parse-flyer": [
      "./node_modules/mupdf/**/*",
      "./node_modules/mupdf/dist/**/*",
    ],
  },
  webpack: (config) => {
    config.experiments = { ...config.experiments, asyncWebAssembly: true };
    return config;
  },
};

export default nextConfig;

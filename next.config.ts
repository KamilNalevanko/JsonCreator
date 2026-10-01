import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Dátum zostavenia — v editore je vidno, akú verziu kto má.
  env: {
    NEXT_PUBLIC_EDITOR_BUILD: new Date().toISOString().slice(0, 16).replace("T", " "),
  },
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

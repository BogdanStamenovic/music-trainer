import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
  // curriculum YAML is read at runtime; ship it with the standalone server
  outputFileTracingIncludes: { "/api/**": ["./curriculum/**/*"] },
  poweredByHeader: false,
};
export default config;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["@modelcontextprotocol/server"],
  turbopack: { root: __dirname },
  agentRules: false,
};

export default nextConfig;

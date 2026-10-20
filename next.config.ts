import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Load the PayPal SDK from node_modules at runtime instead of bundling it, so the server holds one
  // copy of its error classes (bundling mixed its ESM and CJS builds and broke instanceof).
  serverExternalPackages: ["paypal"],
};

export default nextConfig;

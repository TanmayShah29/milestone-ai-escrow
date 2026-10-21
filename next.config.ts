import type { NextConfig } from "next";

// Security headers for every route. The CSP is deliberately narrow (no script-src): Next's app router injects
// inline scripts that would need nonces, so it covers framing, <base>, plugins and form targets only. Form
// targets allow PayPal in case a submission ever redirects to its approval page.
const csp = ["frame-ancestors 'none'", "base-uri 'self'", "object-src 'none'", "form-action 'self' https://*.paypal.com"].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  // Capability tokens arrive in ?t= links; never leak them to other sites through Referer.
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), usb=()" },
];

const nextConfig: NextConfig = {
  // Load the PayPal SDK from node_modules at runtime instead of bundling it, so the server holds one
  // copy of its error classes (bundling mixed its ESM and CJS builds and broke instanceof).
  serverExternalPackages: ["paypal"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;

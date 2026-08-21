/**
 * @type {import('next').NextConfig}
 *
 * Security headers applied to every route.
 *
 * CSP notes:
 *  - `script-src 'unsafe-inline'` is required by Next.js 14 App Router, which
 *    injects inline bootstrap scripts. A nonce-based CSP is the recommended
 *    migration path and is tracked for a future release.
 *  - `style-src 'unsafe-inline'` is required by Tailwind/Next injected styles.
 *  - `frame-ancestors 'none'` + `X-Frame-Options: DENY` block clickjacking.
 *  - `'unsafe-eval'` is added to `script-src` ONLY in development, where
 *    Next.js uses `eval` for fast refresh and source maps. Production keeps a
 *    strict CSP without it.
 */

const isProduction = process.env.NODE_ENV === "production";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProduction ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    const headers = [...securityHeaders];
    if (isProduction) {
      headers.push({
        key: "Strict-Transport-Security",
        value: "max-age=63072000; includeSubDomains; preload",
      });
    }
    return [{ source: "/(.*)", headers }];
  },
};

export default nextConfig;

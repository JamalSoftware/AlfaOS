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
 *  - `img-src` inclui a ORIGEM do provedor de tiles, derivada da mesma
 *    configuracao que o componente do mapa consome. Sem ela o mapa abre cinza.
 *  - `frame-ancestors 'none'` + `X-Frame-Options: DENY` block clickjacking.
 *  - `'unsafe-eval'` is added to `script-src` ONLY in development, where
 *    Next.js uses `eval` for fast refresh and source maps. Production keeps a
 *    strict CSP without it.
 */

import {
  readMapTileConfig,
  tileImageSource,
} from "./src/lib/map-tiles.config.mjs";

const isProduction = process.env.NODE_ENV === "production";

/**
 * A origem do provedor de tiles, LIBERADA A PARTIR DA MESMA CONFIGURAÇÃO que o
 * componente do mapa usa (`CTO-3.2`).
 *
 * Sem esta linha o mapa abre cinza: `img-src 'self' data:` bloqueia toda imagem
 * de outro host, e tile é imagem. O modo de falha é traiçoeiro — a página
 * carrega, os marcadores aparecem, os controles funcionam, e só o fundo some.
 * Nada quebra o suficiente para alguém suspeitar da política de segurança.
 *
 * Derivada, e não escrita à mão: um host repetido aqui seria o segundo lugar
 * que a próxima troca de provedor esqueceria. Ver `src/lib/map-tiles.config.mjs`.
 */
const TILE_IMAGE_SOURCE = tileImageSource(readMapTileConfig().urlTemplate);

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProduction ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: ${TILE_IMAGE_SOURCE}`,
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

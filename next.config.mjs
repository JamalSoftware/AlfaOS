/**
 * @type {import('next').NextConfig}
 *
 * Security headers applied to every route.
 *
 * CSP notes:
 *  - `script-src 'unsafe-inline'` is required by the Next.js App Router (14 and
 *    15 alike), which injects inline bootstrap scripts. A nonce-based CSP is the recommended
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
  tileImageSources,
} from "./src/lib/map-tiles.config.mjs";

const isProduction = process.env.NODE_ENV === "production";

/**
 * As origens dos provedores de tiles, LIBERADAS A PARTIR DA MESMA CONFIGURAÇÃO
 * que o componente do mapa usa (`CTO-3.2`, estendida na `CTO-3.2.1`).
 *
 * Sem esta linha o mapa abre cinza: `img-src 'self' data:` bloqueia toda imagem
 * de outro host, e tile é imagem. O modo de falha é traiçoeiro — a página
 * carrega, os marcadores aparecem, os controles funcionam, e só o fundo some.
 * Nada quebra o suficiente para alguém suspeitar da política de segurança.
 *
 * São TRÊS origens no padrão, porque a `CTO-3.2.1` acrescentou satélite e
 * híbrido. Elas vêm de `tileImageSources`, que percorre as camadas
 * configuradas — acrescentar uma quarta camada um dia não exige tocar aqui, e
 * desligar o satélite encolhe a política sozinho.
 *
 * **Nunca um curinga.** `img-src *` resolveria o sintoma e destruiria a
 * política: qualquer host da internet passaria a entregar imagem para dentro da
 * aplicação. Ver `src/lib/map-tiles.config.mjs`.
 */
const TILE_IMAGE_SOURCES = tileImageSources(readMapTileConfig()).join(" ");

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProduction ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: ${TILE_IMAGE_SOURCES}`,
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
  /**
   * # O otimizador de imagem do Next fica DESLIGADO (`SEC-003`)
   *
   * A revisão de segurança independente apontou um aviso crítico novo em
   * `next@14.2.35`. Dois dos avisos são RCE não autenticado, e um deles —
   * `GHSA-2xp9-vwfh-vxw4` — é **na API de otimização de imagem, com arquivos
   * AVIF**. Esta linha o tira do alcance.
   *
   * ## Por que desligar não custa nada aqui
   *
   * O AlfaOS **não tem um único consumidor de `next/image`** — nenhum
   * `<Image>`, nenhum import. As imagens do produto (foto de evidência,
   * assinatura, foto de CTO) são servidas por rota própria, que confere empresa
   * e posse antes de devolver byte; e os tiles do mapa vêm do provedor
   * configurado, direto para o `<img>` do Leaflet. O otimizador estava ligado
   * por ser o padrão, não por ser usado. Há teste permanente cobrando a
   * ausência de consumidores (`SEC-003-02`).
   *
   * ## Por que ISTO é mitigação de verdade, e não maquiagem
   *
   * Verificado no código instalado (`next/dist/server/next-server.js`), no 14
   * e de novo no 15: com `unoptimized`, o manipulador de `/_next/image`
   * responde **404 antes** de `validateParams` — antes de buscar, decodificar ou
   * olhar formato. O caminho inteiro do otimizador fica inalcançável. Não é uma
   * allowlist vazia que ainda processa a requisição: é o endereço deixar de
   * existir.
   *
   * ## Depois do upgrade, continua desligado — e de propósito
   *
   * A decisão do dono fechou o `SEC-003` por VERSÃO: `next@15.5.25`, que a base
   * de avisos do registro não lista como afetada por nenhum aviso. O
   * desligamento fica mesmo assim, como defesa em profundidade: ele não custa
   * nada (não há consumidor), e o próximo aviso do otimizador não vai precisar
   * de upgrade de emergência para sair do alcance. `SEC-003-01` falha se alguém
   * o religar. Ver `docs/SECURITY.md` §8.27.
   */
  images: {
    unoptimized: true,
  },
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

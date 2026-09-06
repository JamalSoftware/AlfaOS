import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

/**
 * # Validação de URL de saída — proteção SSRF
 *
 * Existe porque a `baseUrl` do SGP é **fornecida pelo ADMIN**. Sem esta camada,
 * um endereço enviado no formulário faria o servidor do AlfaOS bater em
 * qualquer coisa que ele alcança — incluindo a própria infraestrutura, o banco,
 * e o serviço de metadados da nuvem, que devolve credencial de instância a quem
 * pedir.
 *
 * ## Regex não basta, e é por isso que aqui há DNS
 *
 * `http://127.0.0.1` é fácil de barrar por texto. `http://meu-host.exemplo`
 * apontando para `127.0.0.1` **não é** — o texto não tem nada de suspeito. Por
 * isso a validação resolve o nome e examina os endereços resolvidos.
 *
 * ## O que esta camada NÃO fecha, declarado
 *
 * **DNS rebinding.** Entre a resolução feita aqui e a conexão que o `fetch`
 * abre existe uma janela: um servidor autoritativo hostil pode responder um IP
 * público na primeira consulta e um interno na segunda. Fechar isso exige fixar
 * o IP validado na própria conexão (dispatcher com `lookup` próprio), o que
 * atravessa a camada de transporte e não é escopo desta fase.
 *
 * A janela é registrada e não mascarada. O que esta camada garante é que um
 * endereço **estaticamente** interno — direto ou por resolução — nunca é
 * aceito, o que cobre o vetor realista de um formulário mal preenchido ou de um
 * ADMIN comprometido apontando para dentro.
 */

export type OutboundUrlRejection =
  | "NOT_ABSOLUTE"
  | "SCHEME_NOT_ALLOWED"
  | "HAS_CREDENTIALS"
  | "HAS_FRAGMENT"
  | "PRIVATE_ADDRESS"
  | "UNRESOLVABLE";

export class UnsafeOutboundUrlError extends Error {
  readonly reason: OutboundUrlRejection;
  constructor(reason: OutboundUrlRejection, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "UnsafeOutboundUrlError";
    this.reason = reason;
  }
}

/** Mensagem para o operador. Nunca revela o IP resolvido nem topologia. */
const MESSAGES: Record<OutboundUrlRejection, string> = {
  NOT_ABSOLUTE: "Informe uma URL absoluta, começando por https://",
  SCHEME_NOT_ALLOWED: "A URL deve usar https.",
  HAS_CREDENTIALS: "A URL não pode conter usuário e senha.",
  HAS_FRAGMENT: "A URL não pode conter fragmento (#).",
  PRIVATE_ADDRESS:
    "Este endereço não é acessível: aponte para o host público da instalação.",
  UNRESOLVABLE: "Não foi possível resolver o endereço informado.",
};

export function outboundUrlMessage(reason: OutboundUrlRejection): string {
  return MESSAGES[reason];
}

/**
 * `http` é aceito **apenas** fora de produção.
 *
 * O token do SGP viaja no CORPO da requisição. Em `http` ele atravessa a rede
 * em texto claro, e um segredo de escrita não pode depender de a rede ser
 * confiável. Em desenvolvimento a permissão existe para não exigir TLS num
 * SGP de laboratório.
 */
function schemeAllowed(protocol: string): boolean {
  if (protocol === "https:") return true;
  return protocol === "http:" && process.env.NODE_ENV !== "production";
}

/** IPv4 privado, loopback, link-local, CGNAT e reservados. */
function isPrivateIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p as [number, number, number, number];

  if (a === 0) return true; // "este host"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback — todo o /8, não só .0.1
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT RFC6598
  if (a === 169 && b === 254) return true; // link-local, inclui 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast e reservado
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (v === "::" || v === "::1") return true; // não especificado, loopback
  if (v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb")) {
    return true; // link-local fe80::/10
  }
  if (v.startsWith("fc") || v.startsWith("fd")) return true; // unique-local fc00::/7
  if (v.startsWith("ff")) return true; // multicast
  /**
   * IPv4 mapeado/embutido (`::ffff:127.0.0.1`, `64:ff9b::7f00:1`). Sem esta
   * ramificação, o loopback entraria por IPv6 e passaria pelas regras acima.
   *
   * ## As DUAS formas, e por que a pontuada sozinha não bastava
   *
   * Esta função recebia só a forma pontuada, e a auditoria de release mostrou
   * que é justamente a forma que **nunca chega aqui** vinda de uma URL: o
   * parser WHATWG normaliza `[::ffff:127.0.0.1]` para o hostname
   * `[::ffff:7f00:1]` — hexadecimal, sem ponto nenhum. A regex não casava, a
   * função devolvia `false`, e `https://[::ffff:127.0.0.1]` era ACEITO.
   *
   * Reproduzido: loopback, `169.254.169.254` (metadados de nuvem), RFC1918 e
   * NAT64 atravessavam, enquanto `127.0.0.1` e `[::1]` eram corretamente
   * recusados — o teste existia, mas no nível da função auxiliar, onde o
   * defeito não aparece.
   */
  const pontuado = v.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (pontuado) return isPrivateIPv4(pontuado[1]);

  /*
    A forma hexadecimal: os 32 bits baixos de um endereço que embute IPv4.

    `::ffff:a.b.c.d` (mapeado), `::a.b.c.d` (compatível, obsoleto e ainda
    roteável em pilhas antigas) e `64:ff9b::a.b.c.d` (NAT64) — os três chegam
    como dois grupos hexadecimais no fim. Reconstruímos o IPv4 e devolvemos a
    decisão para a mesma tabela que já governa o resto.
  */
  const hex = v.match(/^(?:::ffff:|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const alto = parseInt(hex[1], 16);
    const baixo = parseInt(hex[2], 16);
    const ipv4 = [alto >> 8, alto & 0xff, baixo >> 8, baixo & 0xff].join(".");
    return isPrivateIPv4(ipv4);
  }

  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  // Não é IP. Quem chama já resolveu; um valor não-IP aqui é falha de uso.
  return true;
}

export interface SafeOutboundUrl {
  /** A URL normalizada, sem barra final duplicada. */
  origin: string;
  hostname: string;
}

/**
 * Valida uma URL de saída fornecida pelo operador.
 *
 * `resolver` é injetável para o teste exercitar rebinding e nomes internos sem
 * depender de DNS real — e para que o teste não faça consulta de rede.
 */
export async function assertSafeOutboundUrl(
  raw: string,
  resolver: (hostname: string) => Promise<{ address: string }[]> = (h) =>
    lookup(h, { all: true, verbatim: true }),
): Promise<SafeOutboundUrl> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeOutboundUrlError("NOT_ABSOLUTE", "URL inválida");
  }

  if (!schemeAllowed(url.protocol)) {
    throw new UnsafeOutboundUrlError("SCHEME_NOT_ALLOWED", url.protocol);
  }
  /**
   * `https://user:senha@host` embute credencial na URL — que vai para log de
   * proxy, histórico e `Referer`. E é o truque clássico para fazer um parser
   * ingênuo ler o host errado.
   */
  if (url.username || url.password) {
    throw new UnsafeOutboundUrlError("HAS_CREDENTIALS");
  }
  if (url.hash) {
    throw new UnsafeOutboundUrlError("HAS_FRAGMENT");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");

  // Literal IP: nem chega a consultar DNS.
  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new UnsafeOutboundUrlError("PRIVATE_ADDRESS", "literal");
    }
    return { origin: url.origin, hostname: host };
  }

  /**
   * `localhost` e afins são barrados por nome ANTES do DNS. Um resolvedor
   * local pode devolver algo público para `localhost`, e ainda assim o nome não
   * tem lugar numa configuração de ERP de produção.
   */
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata|metadata\..*)$/i.test(host)) {
    throw new UnsafeOutboundUrlError("PRIVATE_ADDRESS", "nome reservado");
  }

  let addresses: { address: string }[];
  try {
    addresses = await resolver(host);
  } catch {
    throw new UnsafeOutboundUrlError("UNRESOLVABLE");
  }
  if (addresses.length === 0) {
    throw new UnsafeOutboundUrlError("UNRESOLVABLE", "sem endereços");
  }

  /**
   * TODOS os endereços precisam ser públicos, não apenas o primeiro.
   *
   * Um nome com dois registros — um público e um interno — passaria se a
   * verificação parasse no primeiro, e o cliente HTTP escolhe qual usar.
   */
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new UnsafeOutboundUrlError("PRIVATE_ADDRESS", "resolvido");
    }
  }

  return { origin: url.origin, hostname: host };
}

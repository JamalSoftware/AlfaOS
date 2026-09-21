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

/**
 * Os 16 BYTES de um IPv6 textual, ou `null` quando não dá para classificar.
 *
 * # Por que bytes, e não prefixo de texto (`SEC-007`)
 *
 * A versão anterior decidia por `startsWith` e por duas expressões regulares, e
 * a revisão de segurança independente mostrou o que toda comparação de texto de
 * IPv6 deixa passar: **o mesmo endereço tem muitas grafias**. A regra do IPv4
 * embutido exigia exatamente dois grupos hexadecimais no fim
 * (`^::ffff:HHHH:HHHH$`), então a forma NÃO comprimida —
 * `0:0:0:0:0:ffff:7f00:1`, que é o que uma resolução de DNS pode devolver, sem
 * passar pela normalização do parser de URL — não casava e era ACEITA. E
 * `fec0::/10` e `2002::/16` não tinham regra nenhuma.
 *
 * Com os bytes na mão, a classificação é aritmética de prefixo: uma regra por
 * faixa, insensível a como o endereço foi escrito. É o que o `isIP` do Node
 * valida e o que esta função entrega.
 */
function bytesDeIPv6(ip: string): number[] | null {
  let v = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  // Identificador de zona (`%eth0`) não faz parte do endereço.
  const zona = v.indexOf("%");
  if (zona !== -1) v = v.slice(0, zona);
  if (isIP(v) !== 6) return null;

  // IPv4 na cauda (`::ffff:1.2.3.4`) vira dois grupos hexadecimais.
  const pontuado = v.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (pontuado) {
    const octetos = pontuado[2].split(".").map(Number);
    if (octetos.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const alto = ((octetos[0] << 8) | octetos[1]).toString(16);
    const baixo = ((octetos[2] << 8) | octetos[3]).toString(16);
    v = `${pontuado[1]}${alto}:${baixo}`;
  }

  const lados = v.split("::");
  if (lados.length > 2) return null;
  const separar = (parte: string) => (parte === "" ? [] : parte.split(":"));
  const esquerda = separar(lados[0]);
  const direita = lados.length === 2 ? separar(lados[1]) : [];
  const faltando = 8 - (esquerda.length + direita.length);
  if (faltando < 0 || (lados.length === 1 && faltando !== 0)) return null;

  const grupos = [
    ...esquerda,
    ...Array.from({ length: lados.length === 2 ? faltando : 0 }, () => "0"),
    ...direita,
  ];
  if (grupos.length !== 8) return null;

  const bytes: number[] = [];
  for (const grupo of grupos) {
    if (!/^[0-9a-f]{1,4}$/.test(grupo)) return null;
    const valor = Number.parseInt(grupo, 16);
    bytes.push(valor >> 8, valor & 0xff);
  }
  return bytes;
}

/** O IPv4 embutido a partir de `inicio`, julgado pela tabela do IPv4. */
function ipv4Embutido(bytes: number[], inicio: number): boolean {
  return isPrivateIPv4(bytes.slice(inicio, inicio + 4).join("."));
}

function isPrivateIPv6(ip: string): boolean {
  const b = bytesDeIPv6(ip);
  /*
    Não conseguimos classificar: recusa. Aceitar o que não se entende é o
    oposto do que este módulo existe para fazer.

    **Medido: este ramo é INALCANÇÁVEL pelo caminho de hoje.** O único chamador
    é `isPrivateAddress`, que só entra aqui depois de `isIP(ip) === 6`, e
    `bytesDeIPv6` devolve `null` justamente quando `isIP` recusa. Uma sabotagem
    que o invertesse para `false` não derruba teste nenhum, e não há teste a
    escrever: um caso que o produto não consegue produzir não se prova.

    Fica porque é o padrão certo para um chamador futuro que não passe pelo
    `isIP` — e fica DOCUMENTADO como redundante para que ninguém o leia como
    proteção ativa.
  */
  if (b === null) return true;

  const zerados = (ate: number) => b.slice(0, ate).every((x) => x === 0);

  // `::/128` não especificado e `::1/128` loopback.
  if (zerados(15) && (b[15] === 0 || b[15] === 1)) return true;

  /*
    As três faixas que EMBUTEM um IPv4. A decisão vai para a mesma tabela que
    governa o IPv4, então loopback, RFC1918, CGNAT e `169.254.169.254` são
    barrados por qualquer uma das portas, e um IPv4 público embutido continua
    aceito — que é o controle positivo do `SGP1-11c`.
  */
  // `::ffff:0:0/96` — IPv4 mapeado, em QUALQUER grafia.
  if (zerados(10) && b[10] === 0xff && b[11] === 0xff) return ipv4Embutido(b, 12);
  // `::/96` — IPv4 compatível: obsoleto, e ainda roteável em pilha antiga.
  if (zerados(12)) return ipv4Embutido(b, 12);
  // `64:ff9b::/96` — NAT64. `64:ff9b:1::/48` é uso local: barra inteiro.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    return b[4] === 0x00 && b[5] === 0x01 ? true : ipv4Embutido(b, 12);
  }
  // `2002::/16` — 6to4: aqui o IPv4 mora nos bytes 2..5, não na cauda.
  if (b[0] === 0x20 && b[1] === 0x02) return ipv4Embutido(b, 2);

  /*
    `2001::/32` — Teredo. O IPv4 do cliente vem ofuscado (XOR) nos bytes
    finais, e nenhuma instalação de ERP é servida por Teredo. Barra a faixa em
    vez de desofuscar: menos código para o mesmo efeito.
  */
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true;

  // `fe80::/10` link-local (inclui o equivalente de `169.254.169.254`).
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;
  // `fec0::/10` site-local: depreciado pela RFC 3879 e ainda roteado por
  // pilhas antigas — era a faixa que faltava.
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true;
  // `fc00::/7` unique-local.
  if ((b[0] & 0xfe) === 0xfc) return true;
  // `ff00::/8` multicast.
  if (b[0] === 0xff) return true;
  // `100::/64` descarte e `2001:db8::/32` documentação: nunca são um host real.
  if (b[0] === 0x01 && b[1] === 0x00 && b.slice(2, 8).every((x) => x === 0)) return true;
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true;

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

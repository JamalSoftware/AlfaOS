import { jsonError } from "./api";

export const STATE_CHANGING_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

/**
 * O `Origin` da requisição, ou `null` quando não há um utilizável.
 *
 * Cabeçalho presente porém vazio conta como AUSENTE, e isso é decisão, não
 * acidente: um `Origin` em branco não afirma origem nenhuma, e tratá-lo como
 * valor inválido recusaria requisição de intermediário que normaliza
 * cabeçalhos. Nenhum navegador envia isso — o caminho existe para não depender
 * de coincidência de implementação.
 */
function getOrigin(request: Request): string | null {
  const bruto = request.headers.get("origin");
  if (bruto === null) return null;
  const limpo = bruto.trim();
  return limpo.length > 0 ? limpo : null;
}

/**
 * Confiar ou não nos cabeçalhos `X-Forwarded-*`.
 *
 * Desligado por padrão, e é deliberado: `X-Forwarded-Host` é escrito por
 * QUALQUER cliente. Numa aplicação exposta direto, confiar nele deixaria
 * um atacante declarar o host que quisesse e passar por qualquer comparação
 * baseada nele.
 *
 * Só faz sentido ligar quando existe um proxy reverso na frente que
 * SOBRESCREVE o cabeçalho — aí ele deixa de ser entrada do usuário e passa a
 * ser afirmação da infraestrutura.
 */
function trustsProxyHeaders(): boolean {
  return process.env.TRUST_PROXY_HEADERS === "true";
}

/**
 * Allowlist explícita de origens da aplicação.
 *
 * É a política estrita, recomendada em produção: as origens ficam fixadas na
 * configuração e a comparação deixa de depender de qualquer cabeçalho da
 * requisição. Vazia, o helper cai na comparação Origin × Host descrita abaixo.
 *
 * Formato: origens absolutas separadas por vírgula, por exemplo
 * `https://app.alfaos.com.br,https://alfaos.com.br`.
 */
function configuredOrigins(): string[] {
  const bruto = process.env.APP_ORIGINS;
  if (!bruto) return [];
  return bruto
    .split(",")
    .map((valor) => valor.trim())
    .filter((valor) => valor.length > 0)
    .map(normalizeOrigin)
    .filter((valor): valor is string => valor !== null);
}

/**
 * `https://App.Example:443/x` → `https://app.example`.
 *
 * Comparar strings cruas erraria em maiúscula, barra final e porta padrão
 * explícita — três formas de escrever a mesma origem. `URL.origin` resolve as
 * três de uma vez.
 */
function normalizeOrigin(valor: string): string | null {
  try {
    return new URL(valor).origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * O host que o NAVEGADOR realmente endereçou.
 *
 * Este é o coração da correção. `new URL(request.url).host` **não** serve:
 * no Next 14 essa URL carrega o host que o servidor resolveu ao subir —
 * `localhost` — e não o host da requisição. O efeito era que abrir o AlfaOS
 * por `http://192.168.1.50:3000` ou até por `http://127.0.0.1:3000` fazia
 * toda ação mutante ser recusada com "Origem não permitida", mesmo com
 * `Origin` idêntico ao `Host`.
 *
 * Ordem, da mais confiável para a menos:
 *
 * 1. `X-Forwarded-Host`, **apenas** com `TRUST_PROXY_HEADERS=true`;
 * 2. `Host` — que o navegador preenche a partir da URL e o conteúdo de outra
 *    página não consegue forjar;
 * 3. o host de `request.url`, como último recurso.
 *
 * O valor devolvido daqui é usado SOMENTE para comparação. Ele nunca monta
 * URL de redirect nem link — é o que separa esta função de uma Host Header
 * Injection.
 */
function effectiveHost(request: Request): string | null {
  if (trustsProxyHeaders()) {
    const encaminhado = request.headers.get("x-forwarded-host");
    if (encaminhado) {
      // Vários proxies em cadeia acrescentam entradas; o primeiro é o que o
      // cliente enxergou.
      const primeiro = encaminhado.split(",")[0]?.trim();
      if (primeiro) return primeiro.toLowerCase();
    }
  }

  const host = request.headers.get("host");
  if (host) return host.trim().toLowerCase();

  try {
    return new URL(request.url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Same-Origin para requisições que mudam estado.
 *
 * O cookie de sessão é `SameSite=Lax`, o que já bloqueia POST cross-site. Esta
 * checagem é defesa em profundidade: quando o `Origin` está presente, ele
 * precisa corresponder à origem efetiva da aplicação.
 *
 * **Requisições sem `Origin`** — navegação same-origin antiga, `curl`,
 * servidor-para-servidor — passam e ficam apoiadas em `SameSite` mais o cookie
 * de sessão. É política herdada e mantida de propósito: apertá-la é mudança de
 * comportamento de todas as rotas, com risco próprio, e não é o defeito
 * relatado aqui. O navegador de hoje envia `Origin` em POST, inclusive
 * same-origin — foi por isso que o logout falhava.
 */
export function assertSameOrigin(request: Request): Response | null {
  const origin = getOrigin(request);
  if (!origin) {
    return null;
  }

  const origemNormalizada = normalizeOrigin(origin);
  if (!origemNormalizada) {
    // Inclui o literal `Origin: null`, que iframe sandboxed e alguns
    // redirects produzem. `null` não é origem nossa.
    return jsonError("Origem inválida.", 403);
  }

  /*
    Política estrita: com `APP_ORIGINS` configurado, a origem precisa estar na
    lista, e nenhum cabeçalho da requisição participa da decisão. É o que se
    quer em produção.
  */
  const permitidas = configuredOrigins();
  if (permitidas.length > 0) {
    return permitidas.includes(origemNormalizada)
      ? null
      : jsonError("Origem não permitida.", 403);
  }

  const host = effectiveHost(request);
  if (!host) {
    return jsonError("Requisição inválida.", 400);
  }

  /*
    Compara HOST (nome + porta), não a origem inteira.

    O esquema fica de fora porque desenvolvimento roda em `http` e produção em
    `https`, e a proteção que importa aqui é contra outra ORIGEM — que sempre
    difere no host. Quem precisa fixar o esquema usa `APP_ORIGINS`.
  */
  let origemHost: string;
  try {
    origemHost = new URL(origin).host.toLowerCase();
  } catch {
    return jsonError("Origem inválida.", 403);
  }

  if (origemHost !== host) {
    return jsonError("Origem não permitida.", 403);
  }

  return null;
}

export function isStateChangingMethod(method: string): boolean {
  return STATE_CHANGING_METHODS.includes(method.toUpperCase());
}

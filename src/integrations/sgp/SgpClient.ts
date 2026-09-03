import { IntegrationError } from "../errors";

/**
 * # Transporte do SGP (TSMX)
 *
 * Tudo o que o AlfaOS envia ao SGP passa por aqui: URL, corpo, timeout, parse e
 * normalização de erro. Nenhum `fetch` ao SGP fora deste arquivo.
 *
 * ## O que este módulo NÃO faz
 *
 * Não toca Prisma, não decifra ciphertext, não decide empresa e não importa
 * `Customer`. Ele recebe `baseUrl`, `app` e `token` **já resolvidos** e usa. É
 * essa fronteira que mantém o adapter testável sem banco — e o teste de
 * arquitetura em `sgp-boundary.test.ts` a cobra.
 *
 * ## Autenticação: Token + App, no CORPO
 *
 * Documentação oficial (`docs/ERP-SGP.md` §2): *"o método mais seguro e
 * recomendado para a API"*, com `token` e `app` **obrigatórios** e enviados no
 * body ao lado dos filtros. Diferença estrutural em relação ao ReceitaNet, que
 * usa header.
 *
 * **Nunca em query string.** Uma URL entra em log de servidor, proxy, histórico
 * e `Referer`, e o token do SGP é credencial de escrita. É a mesma regra que o
 * `ReceitanetCallCenterClient` segue, aqui por um motivo mais forte: no SGP o
 * token teria como caber na URL.
 */

/**
 * Mesma forma do `FetchLike` do cliente do ReceitaNet, de propósito.
 *
 * `ERPAdapterConfig.fetchImpl` é um campo só, compartilhado por todos os
 * adapters. Uma assinatura divergente aqui — `body` opcional, por exemplo —
 * tornaria os dois tipos mutuamente inatribuíveis, e a fábrica não conseguiria
 * repassar o mesmo `fetchImpl`. Declarada aqui em vez de importada do módulo do
 * ReceitaNet: o SGP não deve depender de um arquivo de outro provider.
 */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
    redirect?: "error" | "manual" | "follow";
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface SgpClientOptions {
  baseUrl: string;
  app: string;
  token: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/**
 * 8s, o mesmo teto do diagnóstico do ReceitaNet.
 *
 * Não há SLA publicado do qual derivar o número, e a documentação oficial não
 * traz um (`docs/ERP-SGP.md` §10). Folgado para um round trip saudável, curto
 * o bastante para não segurar um handler.
 */
export const SGP_TIMEOUT_MS = 8000;

/** Uma entrada do plano de contas. Só o que o AlfaOS realmente lê. */
export interface SgpChartOfAccountsEntry {
  id: number;
  codigo: string | null;
}

export class SgpClient {
  private readonly baseUrl: string;
  private readonly app: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: SgpClientOptions) {
    /**
     * Falha na CONSTRUÇÃO quando falta configuração, e não numa chamada
     * adiante — é o mesmo princípio que `getERPAdapter` já aplica ao token do
     * ReceitaNet: recusar onde a causa ainda é óbvia.
     *
     * `baseUrl` é obrigatória porque cada provedor tem instalação própria do
     * SGP; `app` porque a documentação oficial o marca como obrigatório junto
     * do token.
     */
    const baseUrl = (options.baseUrl ?? "").trim().replace(/\/+$/, "");
    if (!baseUrl) {
      throw new IntegrationError("AUTHENTICATION_FAILED", "SGP", "baseUrl ausente");
    }
    if (!options.app?.trim()) {
      throw new IntegrationError("AUTHENTICATION_FAILED", "SGP", "app ausente");
    }
    if (!options.token?.trim()) {
      throw new IntegrationError("AUTHENTICATION_FAILED", "SGP", "token ausente");
    }

    this.baseUrl = baseUrl;
    this.app = options.app.trim();
    this.token = options.token.trim();
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.timeoutMs = options.timeoutMs ?? SGP_TIMEOUT_MS;
  }

  /**
   * Sonda de conexão: `POST /api/ura/planoscontas/`.
   *
   * ## Por que este endpoint, e por que NÃO `consultaplano`
   *
   * A `ERP-0R` sugeriu `consultaplano`. A reconfirmação na coleção oficial
   * mostrou que ele é **`GET` com corpo `form-data`** — e um `GET` com corpo é
   * descartado por proxies e por vários clientes HTTP. A única alternativa
   * seria mandar `token`/`app` na query string, que é justamente o que não se
   * pode fazer com um segredo.
   *
   * `planoscontas` é **`POST`**, recebe exatamente `token` e `app` e nada mais,
   * e devolve `[{ id, codigo, descricao }]` — plano de contas, sem cliente,
   * sem valor e sem PII. Autenticado, somente leitura, e nenhum parâmetro que
   * possa disparar efeito.
   *
   * Descartados, com motivo: `fatura2via` tem `nao_gerar_os` e pode **abrir
   * OS**; `cpemanager/.../command/ping/` executa comando em equipamento; e
   * qualquer `consultacliente` exigiria enviar documento de uma pessoa real só
   * para saber se o token vale.
   */
  async listarPlanosContas(): Promise<SgpChartOfAccountsEntry[]> {
    const payload = await this.post("/api/ura/planoscontas/");

    /**
     * Um array é a resposta documentada. Objeto de erro, HTML ou qualquer
     * outra forma é `INVALID_RESPONSE` — e não uma sonda que "passou" porque
     * chegou algo com status 200.
     */
    if (!Array.isArray(payload)) {
      throw new IntegrationError(
        "INVALID_RESPONSE",
        "SGP",
        "plano de contas: resposta não é lista",
      );
    }

    return payload.map((linha) => {
      const item = (linha ?? {}) as Record<string, unknown>;
      return {
        id: Number(item.id ?? 0),
        codigo: typeof item.codigo === "string" ? item.codigo : null,
      };
    });
  }

  /**
   * `application/x-www-form-urlencoded`.
   *
   * A coleção oficial cataloga `multipart/form-data`, e a documentação de
   * autenticação registra que *"o uso de form-data é opcional"* — ou seja,
   * parâmetros simples de corpo são aceitos. `urlencoded` evita gerar
   * boundary e é o mesmo transporte que o cliente do ReceitaNet já usa.
   *
   * **É o único detalhe de transporte que depende de confirmação no sandbox**
   * (`docs/ERP-SGP.md` §10). Se o SGP recusar `urlencoded`, muda o
   * `Content-Type` e a serialização — e nada mais.
   */
  private async post(path: string): Promise<unknown> {
    const body = new URLSearchParams();
    body.set("app", this.app);
    body.set("token", this.token);

    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: { ok: boolean; status: number; text: () => Promise<string> };
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
        signal: controller.signal,
        // Um 30x seguido automaticamente levaria o token para um host que a
        // validação de SSRF nunca examinou — ela só viu a URL que NÓS montamos.
        redirect: "manual",
      });
    } catch (error) {
      /**
       * `AbortError` é o NOSSO prazo, não indisponibilidade do provider.
       * Colapsar os dois faria o operador procurar defeito no SGP quando o
       * problema é a latência contra o teto local.
       */
      if (error instanceof Error && error.name === "AbortError") {
        throw new IntegrationError("TIMEOUT", "SGP");
      }
      throw new IntegrationError("UPSTREAM_UNAVAILABLE", "SGP", "falha de rede");
    } finally {
      clearTimeout(deadline);
    }

    if (!response.ok) {
      throw mapHttpStatus(response.status);
    }

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      /**
       * O texto NÃO entra no erro. Uma resposta de erro do SGP pode carregar
       * HTML de portal, e um trecho dele acabaria em tela ou em log.
       */
      throw new IntegrationError("INVALID_RESPONSE", "SGP", "corpo não é JSON");
    }
  }
}

/**
 * Tradução de status na fronteira, para o domínio nunca ver HTTP do provider.
 *
 * O catálogo é fechado (`IntegrationError`); nada aqui inventa código.
 */
function mapHttpStatus(status: number): IntegrationError {
  if (status === 401 || status === 403) {
    return new IntegrationError("AUTHENTICATION_FAILED", "SGP", `HTTP ${status}`);
  }
  if (status === 404) {
    return new IntegrationError("UPSTREAM_UNAVAILABLE", "SGP", "HTTP 404");
  }
  if (status === 429) {
    return new IntegrationError("RATE_LIMITED", "SGP", "HTTP 429");
  }
  if (status >= 500) {
    return new IntegrationError("UPSTREAM_UNAVAILABLE", "SGP", `HTTP ${status}`);
  }
  return new IntegrationError("INVALID_RESPONSE", "SGP", `HTTP ${status}`);
}

const defaultFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
    redirect: init.redirect ?? "manual",
  });
  return { ok: res.ok, status: res.status, text: () => res.text() };
};

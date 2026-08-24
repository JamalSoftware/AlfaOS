import { IntegrationError } from "../errors";

/**
 * Transporte HTTP da API CallCenter do ReceitaNet.
 *
 * Responsabilidade ÚNICA: base URL, token, encoding, timeout, request, parse e
 * normalização de erro. Nenhuma regra de negócio, nenhum mapeamento para o
 * modelo AlfaOS — isso é do adapter. Concentrar o HTTP aqui é o que impede
 * `fetch` de se espalhar e é o que torna cada modo de falha testável sem rede.
 *
 * Contrato oficial: https://www.receitanet.net/api/callcenter/ (OpenAPI 3.0.3,
 * `info.version` 1.0.3). Nada aqui é inferido: cada endpoint, campo e código de
 * status usado abaixo está no OpenAPI.
 */

export const CALLCENTER_BASE_URL = "https://api.receitanet.net/callcenter";

/**
 * Host e caminho oficiais, guardados separados da URL completa porque a
 * validação precisa comparar cada parte por si — comparar a string inteira
 * não distingue `porta errada` de `host errado`, e a mensagem de recusa
 * ficaria inútil para quem tem de consertar a configuração.
 */
const CALLCENTER_HOST = "api.receitanet.net";
const CALLCENTER_BASE_PATH = "/callcenter";

/** Deadline próprio do cliente. O call site de diagnóstico tem o seu também. */
export const CALLCENTER_TIMEOUT_MS = 8_000;

const PROVIDER = "RECEITANET";

/**
 * Assinatura mínima de `fetch` que o cliente usa.
 *
 * Injetável para que os testes exercitem 401, 404, 500, timeout, JSON inválido
 * e payload incompleto sem tocar a API real — o que também garante que a suíte
 * nunca dependa de internet.
 */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

export interface CallCenterClientOptions {
  token: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

/**
 * Valida e normaliza a base URL ANTES que ela possa receber um token.
 *
 * `ERPIntegration.baseUrl` é uma coluna do banco. Hoje nenhuma tela a escreve
 * e ela permanece nula — mas o cliente não pode depender disso. No dia em que
 * alguém expuser um campo `URL base` numa configuração, o token da empresa
 * passaria a viajar, em header, para onde aquele campo mandasse. Quem carrega
 * o segredo é quem tem de se proteger, e essa proteção precisa existir antes
 * de existir a tela que a torna necessária.
 *
 * A checagem é allowlist exata, não lista de proibidos: lista negra erra por
 * omissão, e `api.receitanet.net.attacker.com` é justamente o caso que uma
 * verificação por sufixo deixaria passar.
 *
 * Homologação, se um dia existir, entra aqui como constante adicional — nunca
 * como afrouxamento desta regra.
 */
function resolveBaseUrl(raw?: string | null): string {
  const candidate = raw?.trim();
  if (!candidate) {
    return CALLCENTER_BASE_URL;
  }

  /**
   * `AUTHENTICATION_FAILED`, e não `INVALID_RESPONSE`: ninguém respondeu nada.
   * É configuração inválida — e a mensagem desse código já manda o operador
   * conferir a configuração da integração, que é exatamente onde está o
   * conserto. O `detail` fica no log do servidor; a URL recusada nunca sobe
   * para a tela.
   */
  const refuse = (detail: string) =>
    new IntegrationError(
      "AUTHENTICATION_FAILED",
      PROVIDER,
      `base URL do CallCenter recusada (${detail})`,
    );

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw refuse("URL malformada");
  }

  if (url.protocol !== "https:") {
    throw refuse("protocolo não é https");
  }
  // Credencial embutida vaza em log e Referer, e ainda disfarça o host real
  // para quem lê a URL de relance.
  if (url.username !== "" || url.password !== "") {
    throw refuse("credencial embutida na URL");
  }
  // Igualdade exata resolve de uma vez: host arbitrário, localhost, IP e
  // sufixo enganoso. Nenhum deles É `api.receitanet.net`.
  if (url.hostname !== CALLCENTER_HOST) {
    throw refuse("host não é o oficial");
  }
  // `URL` já normaliza a porta padrão para "", então só sobra porta explícita
  // e diferente de 443.
  if (url.port !== "") {
    throw refuse("porta não padrão");
  }
  if (url.pathname.replace(/\/+$/, "") !== CALLCENTER_BASE_PATH) {
    throw refuse("caminho base não é /callcenter");
  }
  if (url.search !== "" || url.hash !== "") {
    throw refuse("query ou fragmento na base URL");
  }

  return `https://${CALLCENTER_HOST}${CALLCENTER_BASE_PATH}`;
}

/** Objeto não-nulo. `Array.isArray` já foi descartado por quem chama. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class ReceitanetCallCenterClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: CallCenterClientOptions) {
    if (!options.token || options.token.trim() === "") {
      // Falha na construção, não na primeira chamada: um cliente sem token não
      // tem uso válido, e deixá-lo existir empurraria o erro para longe da causa.
      throw new IntegrationError(
        "AUTHENTICATION_FAILED",
        PROVIDER,
        "cliente CallCenter construído sem token",
      );
    }
    this.token = options.token;
    this.baseUrl = resolveBaseUrl(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? CALLCENTER_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
  }

  /**
   * Disponibilidade da API. `GET /ping`, `security: []` no OpenAPI.
   *
   * NÃO autentica. Um ping bem-sucedido diz que o serviço está de pé e nada
   * sobre o token da empresa — ver `ReceitanetAdapter.testConnection`.
   */
  async ping(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/ping`, {
        method: "GET",
        headers: {},
        body: "",
        signal: controller.signal,
      });
      return res.status === 200;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * POST autenticado para uma rota `/v1`.
   *
   * O OpenAPI declara `multipart/form-data` e `application/x-www-form-urlencoded`
   * como os únicos corpos aceitos — **JSON não está no contrato** e não é usado.
   * Escolhi form-urlencoded por ser o mais simples dos dois e não exigir
   * geração de boundary.
   *
   * O token vai no header `token`, nunca na query string: uma URL entra em log
   * de servidor, proxy, histórico e cabeçalho Referer. O OpenAPI menciona um
   * campo `token` no corpo como compatibilidade legada; não é usado aqui.
   */
  private async post<T>(path: string, params: Record<string, string>): Promise<T> {
    const body = new URLSearchParams(params).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          token: this.token,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      // `AbortError` é o nosso deadline; qualquer outra falha de rede é o
      // provider fora do ar. Nenhum dos dois é uma afirmação sobre o cliente.
      const aborted =
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError");
      throw new IntegrationError(
        aborted ? "TIMEOUT" : "UPSTREAM_UNAVAILABLE",
        PROVIDER,
        aborted ? `sem resposta em ${this.timeoutMs}ms` : "falha de rede",
      );
    } finally {
      clearTimeout(timer);
    }

    // Traduz o status na FRONTEIRA. Nada acima deste ponto vê código HTTP.
    if (res.status === 401 || res.status === 403) {
      throw new IntegrationError("AUTHENTICATION_FAILED", PROVIDER, `HTTP ${res.status}`);
    }
    if (res.status === 404) {
      throw new IntegrationError("CUSTOMER_NOT_FOUND", PROVIDER, "HTTP 404");
    }
    if (res.status === 429) {
      throw new IntegrationError("RATE_LIMITED", PROVIDER, "HTTP 429");
    }
    if (res.status >= 500) {
      throw new IntegrationError("UPSTREAM_UNAVAILABLE", PROVIDER, `HTTP ${res.status}`);
    }
    if (res.status !== 200) {
      throw new IntegrationError("INVALID_RESPONSE", PROVIDER, `HTTP ${res.status}`);
    }

    const raw = await res.text();
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Corpo ilegível é resposta não confiável — nunca um estado do cliente.
      throw new IntegrationError("INVALID_RESPONSE", PROVIDER, "corpo não é JSON");
    }
  }

  /**
   * `POST /v1/clientes` — busca por `nome`, `phone` ou `cpfcnpj` (anyOf).
   *
   * O contrato declara `oneOf`: `ClienteResumo[]` ou `ErrorMessage`. A
   * fronteira resolve isso em lista OU exceção — nunca numa lista vazia
   * fabricada a partir de um corpo de erro.
   */
  async searchClientes(
    filters: { nome?: string; phone?: string; cpfcnpj?: string },
  ): Promise<CallCenterClienteResumo[]> {
    const params: Record<string, string> = {};
    if (filters.nome) params.nome = filters.nome;
    if (filters.phone) params.phone = filters.phone;
    if (filters.cpfcnpj) params.cpfcnpj = filters.cpfcnpj;
    if (Object.keys(params).length === 0) {
      throw new IntegrationError("INVALID_RESPONSE", PROVIDER, "busca sem filtro");
    }

    const payload = await this.post<unknown>("/v1/clientes", params);

    // Lista é o único desfecho de sucesso. `[]` aqui significa mesmo zero
    // resultados, e continua passando como tal.
    if (Array.isArray(payload)) {
      return payload as CallCenterClienteResumo[];
    }

    /**
     * Qualquer outra forma é falha — e falha não pode virar lista vazia.
     *
     * Devolver `[]` para um corpo de erro faria o operador ler "nenhum cliente
     * encontrado" quando o ERP na verdade recusou a consulta. O desfecho
     * provável seria um cadastro duplicado, criado à mão, para um cliente que
     * já existe do outro lado.
     *
     * A distinção olha o booleano `success`, nunca o texto da mensagem: casar
     * string de provider é heurística que quebra na primeira vez que eles
     * mudarem a redação.
     */
    throw new IntegrationError(
      "INVALID_RESPONSE",
      PROVIDER,
      isRecord(payload) && payload.success === false
        ? "provider recusou a busca"
        : "resposta de busca não é lista",
    );
  }

  /** `POST /v1/cliente` — detalhe. Chave: `idCliente`. */
  async getCliente(idCliente: number): Promise<CallCenterClienteDetalhado> {
    const payload = await this.post<Record<string, unknown>>("/v1/cliente", {
      idCliente: String(idCliente),
    });
    // 404 já virou CUSTOMER_NOT_FOUND acima; aqui pega o corpo de erro com 200.
    if (payload && payload.success === false) {
      throw new IntegrationError("CUSTOMER_NOT_FOUND", PROVIDER, "cliente não localizado");
    }
    return payload as unknown as CallCenterClienteDetalhado;
  }

  /** `POST /v1/cliente/verificar-acesso` — `status` 1 online, 2 offline. */
  async verificarAcesso(idCliente: number): Promise<CallCenterVerificarAcesso> {
    const payload = await this.post<Record<string, unknown>>(
      "/v1/cliente/verificar-acesso",
      { idCliente: String(idCliente) },
    );
    if (payload && payload.success === false) {
      throw new IntegrationError("CUSTOMER_NOT_FOUND", PROVIDER, "cliente não localizado");
    }
    return payload as unknown as CallCenterVerificarAcesso;
  }
}

// ---------------------------------------------------------------------------
// Formas do provider, tal como o OpenAPI as declara.
//
// Ficam aqui porque descrevem o que chega do fio, não o modelo AlfaOS. Nenhuma
// delas atravessa o adapter: ele normaliza antes de devolver.
// ---------------------------------------------------------------------------

export interface CallCenterClienteResumo {
  idCliente: number;
  razaoSocial: string;
  login: string;
  /** minúsculo neste schema — o detalhe usa `cpfCnpj`. Divergência do contrato. */
  cpfcnpj: string;
  cep?: string | null;
  endereco?: string | null;
  cidade?: string | null;
  bairro?: string | null;
  uf?: string | null;
}

export interface CallCenterPlano {
  descricao?: string;
  quantidade?: number;
  valor?: number;
}

export interface CallCenterClienteDetalhado {
  idCliente: number;
  razaoSocial: string;
  /** camelCase neste schema — o resumo usa `cpfcnpj`. */
  cpfCnpj?: string;
  contratoStatusDisplay?: string;
  contratoStatus?: number;
  cep?: string | null;
  endereco?: string | null;
  cidade?: string | null;
  bairro?: string | null;
  uf?: string | null;
  planos?: CallCenterPlano[];
  tecnologia?: number | null;
  servidor?: { manutencao?: boolean | string };
}

export interface CallCenterVerificarAcesso {
  idCliente: number;
  razaoSocial: string;
  cpfcnpj: string;
  message: string;
  /** 1 = online, 2 = offline. Não há terceiro valor no contrato. */
  status: number;
}

/**
 * `fetch` real, adaptado à assinatura mínima acima.
 *
 * Isolado num único ponto para que trocar a implementação (proxy, retry,
 * instrumentação) não exija tocar o cliente.
 */
const defaultFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.method === "GET" ? {} : { body: init.body }),
    signal: init.signal,
    cache: "no-store",
  });
  return { ok: res.ok, status: res.status, text: () => res.text() };
};

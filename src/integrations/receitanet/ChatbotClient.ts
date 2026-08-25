import { IntegrationError } from "../errors";
import { acceptsAsJson, type FetchLike } from "./CallCenterClient";

/**
 * Transporte HTTP da API Chatbot do ReceitaNet.
 *
 * Separado do CallCenter de propósito: são contratos diferentes, com
 * autenticação diferente e credencial diferente. Compartilhar um cliente
 * obrigaria a um punhado de condicionais internas e tornaria fácil mandar o
 * token errado para a API errada.
 *
 * **Esta API devolve senha de cliente em TEXTO PURO.** Isso governa tudo aqui:
 *
 * - o corpo bruto NUNCA é logado, persistido ou devolvido a um chamador;
 * - nada deste módulo escreve em disco ou em banco;
 * - o único caminho de saída é um DTO já reduzido aos campos necessários, e a
 *   senha segue dele direto para a cifra da `CustomerConnection`;
 * - erros carregam código e nada do corpo — uma mensagem de erro que ecoasse o
 *   payload vazaria a credencial num log.
 *
 * O token vai na QUERY STRING porque o contrato do Chatbot só aceita assim.
 * Isso é pior que o header do CallCenter — URL entra em log de servidor, proxy
 * e histórico — e é limitação do provider, não escolha nossa. Está registrado
 * em `docs/RECEITANET-HOMOLOGATION.md`; a mitigação possível é a chamada ser
 * exclusivamente server-side, que é o caso.
 */

/**
 * Base oficial do Chatbot, do bloco `servers` do OpenAPI dele.
 *
 * **Não é o host do CallCenter.** As duas APIs do ReceitaNet vivem em
 * lugares diferentes — `api.receitanet.net/callcenter` contra
 * `sistema.receitanet.net/api/novo/chatbot` — e presumir uniformidade foi
 * o que apontou todas as chamadas do Chatbot para um host que não serve
 * esta API. O sintoma era `UPSTREAM_UNAVAILABLE` em toda tentativa,
 * inclusive com a credencial correta.
 *
 * Cada cliente lê o `servers` do SEU contrato. Há regressão fixando este
 * valor exatamente como o spec o declara.
 */
export const CHATBOT_BASE_URL = "https://sistema.receitanet.net/api/novo/chatbot";
export const CHATBOT_TIMEOUT_MS = 8_000;

const PROVIDER = "RECEITANET";
const CHATBOT_HOST = "sistema.receitanet.net";
const CHATBOT_BASE_PATH = "/api/novo/chatbot";

/** `app` identifica o tipo de integração. Não é segredo. */
const CHATBOT_APP = "chatbot";

export interface ChatbotClientOptions {
  token: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

/**
 * Allowlist da base URL, pelos mesmos motivos do CallCenter: uma coluna de
 * banco não pode decidir para onde o token viaja. Aqui pesa ainda mais, porque
 * o token vai na URL e a resposta traz senha de cliente.
 */
function resolveBaseUrl(raw?: string | null): string {
  const candidate = raw?.trim();
  if (!candidate) {
    return CHATBOT_BASE_URL;
  }

  const refuse = (detail: string) =>
    new IntegrationError(
      "AUTHENTICATION_FAILED",
      PROVIDER,
      `base URL do Chatbot recusada (${detail})`,
    );

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw refuse("URL malformada");
  }

  if (url.protocol !== "https:") throw refuse("protocolo não é https");
  if (url.username !== "" || url.password !== "") throw refuse("credencial embutida");
  if (url.hostname !== CHATBOT_HOST) throw refuse("host não é o oficial");
  if (url.port !== "") throw refuse("porta não padrão");
  if (url.pathname.replace(/\/+$/, "") !== CHATBOT_BASE_PATH) {
    throw refuse("caminho base não é /chatbot");
  }
  if (url.search !== "" || url.hash !== "") throw refuse("query ou fragmento");

  return `https://${CHATBOT_HOST}${CHATBOT_BASE_PATH}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ReceitanetChatbotClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: ChatbotClientOptions) {
    if (!options.token || options.token.trim() === "") {
      throw new IntegrationError(
        "AUTHENTICATION_FAILED",
        PROVIDER,
        "cliente Chatbot construído sem token",
      );
    }
    this.token = options.token;
    this.baseUrl = resolveBaseUrl(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? CHATBOT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
  }

  /**
   * `POST /empresa` — dados cadastrais da empresa.
   *
   * Menor chamada autenticada do contrato: exige apenas `token` e `app`, e
   * NAO devolve dado de cliente nem senha. E por isso a escolha certa para
   * testar a credencial — testar com `/clientes` exigiria um CPF real e
   * traria senha em texto puro para uma operacao que so precisa saber se o
   * token vale.
   */
  async verificarCredencial(): Promise<boolean> {
    const params = new URLSearchParams({ token: this.token, app: CHATBOT_APP });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(
        `${this.baseUrl}/empresa?${params.toString()}`,
        {
          method: "POST",
          redirect: "error",
          headers: { Accept: "application/json" },
          body: "",
          signal: controller.signal,
        },
      );
      if (res.status === 401 || res.status === 403) {
        throw new IntegrationError("AUTHENTICATION_FAILED", PROVIDER, `HTTP ${res.status}`);
      }
      if (res.status < 200 || res.status > 299) {
        throw new IntegrationError("UPSTREAM_UNAVAILABLE", PROVIDER, `HTTP ${res.status}`);
      }
      if (!acceptsAsJson(res.contentType)) {
        throw new IntegrationError("INVALID_RESPONSE", PROVIDER, "resposta não é JSON");
      }

      let payload: unknown;
      try {
        payload = JSON.parse(await res.text());
      } catch {
        throw new IntegrationError("INVALID_RESPONSE", PROVIDER, "corpo não é JSON");
      }

      /**
       * O contrato devolve os campos da empresa na RAIZ — `success`, `nome`,
       * `cnpj`, `endereco`, `telefone1`… Não existe wrapper `empresa`, e
       * procurar um faria a sonda falhar contra a resposta real.
       *
       * Só `success` é lido. Nome, CNPJ, endereço e telefones são dado
       * cadastral da empresa e não têm por que atravessar uma verificação de
       * credencial — o que não é lido não pode vazar.
       */
      if (!isRecord(payload)) {
        throw new IntegrationError("INVALID_RESPONSE", PROVIDER, "resposta não é objeto");
      }
      if (typeof payload.success !== "boolean") {
        throw new IntegrationError(
          "INVALID_RESPONSE",
          PROVIDER,
          // Sem o valor recebido no detalhe: ele viria do provider.
          "resposta sem indicador de sucesso",
        );
      }
      if (payload.success !== true) {
        /**
         * `success:false` com HTTP 200 aqui é o provider recusando a
         * credencial — o único motivo pelo qual uma consulta de dados da
         * PRÓPRIA empresa falharia. Classificado pelo catálogo fechado; a
         * `msg` do provider não é ecoada.
         */
        throw new IntegrationError(
          "AUTHENTICATION_FAILED",
          PROVIDER,
          "provider recusou a credencial",
        );
      }

      return true;
    } catch (error) {
      if (error instanceof IntegrationError) throw error;
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
  }

  /**
   * `POST /clientes` — cliente e contratos, por CPF/CNPJ.
   *
   * Devolve o payload BRUTO para o adapter normalizar imediatamente. Ele não
   * atravessa mais nenhuma camada, e nenhum chamador fora do adapter deve
   * invocá-lo: o objeto contém senha em texto puro.
   */
  async buscarClientes(cpfcnpj: string): Promise<unknown> {
    const digits = cpfcnpj.replace(/\D/g, "");
    if (digits.length !== 11 && digits.length !== 14) {
      throw new IntegrationError(
        "INVALID_RESPONSE",
        PROVIDER,
        "documento fora do formato aceito pelo Chatbot",
      );
    }

    const params = new URLSearchParams({
      token: this.token,
      app: CHATBOT_APP,
      cpfcnpj: digits,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/clientes?${params.toString()}`, {
        method: "POST",
        /**
         * Crítico nesta API: o token está na QUERY STRING, então um 30x
         * seguido automaticamente entregaria o segredo inteiro ao host do
         * `Location`, junto com o CPF do cliente.
         */
        redirect: "error",
        headers: { Accept: "application/json" },
        body: "",
        signal: controller.signal,
      });
    } catch (error) {
      const aborted =
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError");
      throw new IntegrationError(
        aborted ? "TIMEOUT" : "UPSTREAM_UNAVAILABLE",
        PROVIDER,
        // Sem eco do erro original: ele pode carregar a URL, e a URL carrega o
        // token.
        aborted ? `sem resposta em ${this.timeoutMs}ms` : "falha de rede",
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 || res.status === 403) {
      throw new IntegrationError("AUTHENTICATION_FAILED", PROVIDER, `HTTP ${res.status}`);
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

    if (!acceptsAsJson(res.contentType)) {
      throw new IntegrationError(
        "INVALID_RESPONSE",
        PROVIDER,
        "resposta não é JSON",
      );
    }

    const raw = await res.text();
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new IntegrationError("INVALID_RESPONSE", PROVIDER, "corpo não é JSON");
    }

    if (!isRecord(payload)) {
      throw new IntegrationError("INVALID_RESPONSE", PROVIDER, "resposta não é objeto");
    }
    if (payload.success === false) {
      throw new IntegrationError("CUSTOMER_NOT_FOUND", PROVIDER, "cliente não localizado");
    }

    return payload;
  }
}

const defaultFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.method === "GET" ? {} : { body: init.body }),
    signal: init.signal,
    cache: "no-store",
    redirect: init.redirect ?? "error",
  });
  return {
    ok: res.ok,
    status: res.status,
    text: () => res.text(),
    contentType: res.headers.get("content-type"),
  };
};

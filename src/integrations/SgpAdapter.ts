import type { ERPConnectionResult, ERPIntegrationContract } from "./contract";
import { isIntegrationError } from "./errors";
import { SgpClient, type FetchLike } from "./sgp/SgpClient";

/**
 * # Adapter do SGP (TSMX) — `SGP-1`
 *
 * Implementa **apenas** `ERPIntegrationContract`: identidade do provider e
 * `testConnection`. Nada mais.
 *
 * ## Nenhuma capability é declarada, e isso é deliberado
 *
 * A API do SGP documenta busca de cliente, contratos, financeiro, OS, ONU e
 * CPE (`docs/ERP-SGP.md` §4). **A existência do endpoint não é a capability.**
 * Declarar `ERPCustomerLookupCapability` aqui faria `supportsCustomerLookup()`
 * responder `true` para um método que não existe, e a tela ofereceria uma busca
 * que morre na primeira chamada.
 *
 * Os type guards são estruturais — eles testam a presença do método. Enquanto
 * este adapter não tiver `searchCustomers`, `fetchCustomerConnectivity` e
 * `listOpenTickets`, todos respondem `false` sem que ninguém precise manter uma
 * lista. Cada capability entra na sua fase, com o método e o teste dela.
 */
export interface SgpAdapterOptions {
  baseUrl: string;
  app: string;
  token: string;
  /** Injetável no teste, para exercitar a integração sem tocar a rede. */
  fetchImpl?: FetchLike;
}

export class SgpAdapter implements ERPIntegrationContract {
  readonly provider = "SGP";
  private readonly client: SgpClient;

  constructor(options: SgpAdapterOptions) {
    // Lança quando falta `baseUrl`, `app` ou `token` — ver `SgpClient`.
    this.client = new SgpClient(options);
  }

  /**
   * Sonda autenticada e somente leitura.
   *
   * ## `reachable` e `credentialValidated` respondem perguntas diferentes
   *
   * Ao contrário do ReceitaNet, o SGP **não tem `/ping` anônimo**: não existe
   * chamada que prove "o serviço está de pé" sem apresentar credencial. Então:
   *
   * - sucesso → alcançável **e** credencial aceita;
   * - `AUTHENTICATION_FAILED` → o serviço RESPONDEU (401/403 é resposta), logo
   *   alcançável, com credencial recusada;
   * - `TIMEOUT` / `UPSTREAM_UNAVAILABLE` → não alcançável, e **nada** se sabe
   *   sobre a credencial.
   *
   * Colapsar os dois campos faria a tela anunciar "conectado" para um token que
   * nunca foi aceito — ou culpar o token por uma rede que caiu.
   *
   * **Nunca lança.** O contrato exige que falha de conexão volte como
   * `ok: false`, porque o operador clicou justamente para descobrir o estado.
   */
  async testConnection(): Promise<ERPConnectionResult> {
    const startedAt = Date.now();
    try {
      await this.client.listarPlanosContas();
      return {
        ok: true,
        provider: this.provider,
        latencyMs: Date.now() - startedAt,
        reachable: true,
        credentialValidated: true,
        message: "SGP conectado e credencial aceita.",
      };
    } catch (error) {
      const autenticacao =
        isIntegrationError(error) && error.code === "AUTHENTICATION_FAILED";
      return {
        ok: false,
        provider: this.provider,
        latencyMs: Date.now() - startedAt,
        reachable: autenticacao,
        credentialValidated: false,
        /**
         * Mensagem do catálogo fechado. Nunca o corpo do SGP, que numa página
         * de erro traz HTML de portal, e nunca a URL, que carrega o host da
         * instalação.
         */
        message: isIntegrationError(error)
          ? error.userMessage
          : "Não foi possível testar a conexão com o SGP.",
      };
    }
  }
}

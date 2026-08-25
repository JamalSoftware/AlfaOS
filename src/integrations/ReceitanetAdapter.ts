import {
  type ERPConnectionResult,
  type ERPIntegrationContract,
} from "./contract";
import type {
  ERPCustomerDetail,
  ERPCustomerLookupCapability,
  ERPCustomerQuery,
  ERPCustomerSummary,
} from "./customer-lookup";
import type {
  ERPConnectivityObservation,
  ERPCustomerRef,
  ERPDiagnosticsCapability,
} from "./diagnostics";
import { IntegrationError, isIntegrationError } from "./errors";
import {
  parseTicketContactPhone,
  type ERPServiceTicket,
  type ERPServiceTicketsCapability,
  type ERPServiceTicketsResult,
} from "./service-tickets";
import {
  CALLCENTER_CHAMADOS_CAP,
  ReceitanetCallCenterClient,
  type CallCenterClienteDetalhado,
  type CallCenterClienteResumo,
  type FetchLike,
} from "./receitanet/CallCenterClient";

/**
 * ReceitanetAdapter — integração READ-ONLY real sobre a API CallCenter.
 *
 * ## Escopo desta versão
 *
 * Implementado, contra o OpenAPI oficial da CallCenter (3.0.3, `info.version`
 * 1.0.3, https://www.receitanet.net/api/callcenter/):
 *
 *   - `GET  /ping`                        disponibilidade
 *   - `POST /v1/clientes`                 busca por nome, telefone ou CPF/CNPJ
 *   - `POST /v1/cliente`                  detalhe do cliente
 *   - `POST /v1/cliente/verificar-acesso` conectividade ONLINE/OFFLINE
 *
 * **Nada além disso.** Reiniciar, liberar em confiança, boletos, abrir/fechar
 * chamado e gravação existem no contrato e NÃO são implementados: são operações
 * mutantes no sistema do cliente, fora do escopo read-only desta etapa. URA,
 * Chatbot e Central do Assinante continuam sem uma linha de código.
 *
 * ## Identidade
 *
 * O CallCenter expõe **um único** identificador, `idCliente`, que o próprio
 * OpenAPI descreve como "ID do cliente/contrato no ReceitaNet" — e o schema
 * NÃO possui `contratoId` separado. É esse valor, e somente ele, que vai para
 * `Customer.externalId` sob `externalProvider = RECEITANET`.
 *
 * Atenção para quando a URA entrar: lá o schema `Cliente` devolve `idCliente`
 * **e** `contratoId` como campos distintos. Antes de misturar as duas APIs é
 * preciso confirmar com o suporte se são o mesmo número — assumir que sim
 * vincularia clientes errados.
 */
export class ReceitanetAdapter
  implements
    ERPIntegrationContract,
    ERPDiagnosticsCapability,
    ERPCustomerLookupCapability,
    ERPServiceTicketsCapability
{
  readonly provider = "RECEITANET";

  private readonly client: ReceitanetCallCenterClient;

  constructor(options: {
    token: string;
    baseUrl?: string | null;
    fetchImpl?: FetchLike;
  }) {
    this.client = new ReceitanetCallCenterClient({
      token: options.token,
      baseUrl: options.baseUrl ?? undefined,
      fetchImpl: options.fetchImpl,
    });
  }

  /**
   * Duas perguntas diferentes, respondidas separadamente.
   *
   * `/ping` tem `security: []` no contrato — ele NÃO autentica. Um ping
   * bem-sucedido prova que o serviço está de pé e absolutamente nada sobre o
   * token da empresa. Relatar "ReceitaNet conectado" só porque o ping passou
   * seria mentir para o operador exatamente no momento em que ele está tentando
   * descobrir se a credencial dele funciona.
   *
   * Por isso, quando a API responde, o adapter faz UMA leitura autenticada e
   * documentada (`POST /v1/clientes` com um filtro de CPF que não casa) apenas
   * para ver se o token é aceito. É read-only e inofensiva: só o 401/403
   * importa, o conteúdo da resposta é descartado.
   */
  async testConnection(): Promise<ERPConnectionResult> {
    const startedAt = Date.now();

    const reachable = await this.client.ping();
    if (!reachable) {
      return {
        ok: false,
        provider: this.provider,
        latencyMs: Date.now() - startedAt,
        reachable: false,
        credentialValidated: false,
        message:
          "API CallCenter do ReceitaNet não respondeu. Credencial não foi verificada.",
      };
    }

    try {
      // Filtro documentado, resultado irrelevante. Só o status importa.
      await this.client.searchClientes({ cpfcnpj: "00000000000" });
      return {
        ok: true,
        provider: this.provider,
        latencyMs: Date.now() - startedAt,
        reachable: true,
        credentialValidated: true,
        message: "API CallCenter alcançável e credencial aceita.",
      };
    } catch (error) {
      const authFailed =
        isIntegrationError(error) && error.code === "AUTHENTICATION_FAILED";
      return {
        ok: false,
        provider: this.provider,
        latencyMs: Date.now() - startedAt,
        reachable: true,
        credentialValidated: false,
        message: authFailed
          ? "API CallCenter alcançável, mas a credencial foi recusada."
          : "API CallCenter alcançável, mas a verificação da credencial falhou.",
      };
    }
  }

  // -------------------------------------------------------------------------
  // Busca de cliente
  // -------------------------------------------------------------------------

  async searchCustomers(query: ERPCustomerQuery): Promise<ERPCustomerSummary[]> {
    const nome = query.name?.trim();
    const cpfcnpj = query.document?.replace(/\D/g, "");
    const phone = query.phone?.replace(/\D/g, "");

    if (!nome && !cpfcnpj && !phone) {
      throw new IntegrationError(
        "INVALID_RESPONSE",
        this.provider,
        "busca sem filtro",
      );
    }

    /**
     * Um filtro por chamada, na ordem de precisão.
     *
     * O contrato declara `anyOf` para os três, mas não documenta como a API se
     * comporta quando mais de um é enviado — a URA documenta uma precedência,
     * o CallCenter não. Enviar dois e torcer para a API escolher certo seria
     * exatamente o tipo de suposição que o §64 do PRD proíbe.
     */
    const filters = cpfcnpj
      ? { cpfcnpj }
      : phone
        ? { phone }
        : { nome: nome as string };

    const rows = await this.client.searchClientes(filters);
    return rows.map((row) => toSummary(row));
  }

  /**
   * Chamados ABERTOS do cliente. Somente leitura.
   *
   * O contrato limita a 10 e não pagina, então o teto viaja junto no
   * resultado: a tela precisa poder dizer que a lista pode estar truncada
   * em vez de apresentá-la como completa.
   */
  async listOpenTickets(externalId: string): Promise<ERPServiceTicketsResult> {
    const id = parseIdCliente(externalId, this.provider);
    const rows = await this.client.listarChamados(id);
    return {
      tickets: rows.map((row): ERPServiceTicket => {
        const description = text(row.descricao);
        return {
          externalId: String(row.idSuporte),
          externalNumber:
            typeof row.numero === "number" ? String(row.numero) : null,
          protocol: text(row.protocolo),
          description,
          typeCode:
            typeof row.tipo === "number" ? String(row.tipo) : null,
          forecast: text(row.data_previsao),
          contactPhone: parseTicketContactPhone(description),
        };
      }),
      cap: CALLCENTER_CHAMADOS_CAP,
    };
  }

  async getCustomerDetail(externalId: string): Promise<ERPCustomerDetail> {
    const id = parseIdCliente(externalId, this.provider);
    const row = await this.client.getCliente(id);
    return toDetail(row);
  }

  // -------------------------------------------------------------------------
  // Conectividade
  // -------------------------------------------------------------------------

  /**
   * `POST /v1/cliente/verificar-acesso`.
   *
   * O contrato define `status` como enum `[1, 2]` — 1 online, 2 offline — e
   * **não define terceiro valor**. Qualquer coisa fora disso é payload que não
   * dá para confiar, e vira `INVALID_RESPONSE`, nunca OFFLINE.
   *
   * A regra que domina esta função: **erro ≠ OFFLINE**. 401, 404, 5xx, timeout,
   * falha de rede e JSON inválido são falhas da INTEGRAÇÃO, não afirmações
   * sobre o link do cliente. Colapsá-las em OFFLINE mandaria um técnico a campo
   * por causa de um token expirado.
   *
   * Diferença relevante em relação à URA, que documenta responder "offline com
   * success false e HTTP 200" quando ela própria não alcança o servidor de
   * acesso: **o CallCenter não tem esse campo** e não sinaliza esse caso. Não
   * há como distingui-lo aqui, e inventar um sinal seria pior que registrar a
   * lacuna — ela está em `docs/ERP-INTEGRATIONS.md`.
   */
  async fetchCustomerConnectivity(
    ref: ERPCustomerRef,
  ): Promise<ERPConnectivityObservation> {
    if (!ref.externalId) {
      throw new IntegrationError(
        "CUSTOMER_NOT_FOUND",
        this.provider,
        "cliente sem identificador ReceitaNet",
      );
    }
    const id = parseIdCliente(ref.externalId, this.provider);
    const payload = await this.client.verificarAcesso(id);

    if (payload?.status !== 1 && payload?.status !== 2) {
      throw new IntegrationError(
        "INVALID_RESPONSE",
        this.provider,
        "status fora do enum documentado",
      );
    }

    /**
     * Contexto adicional, BEST-EFFORT.
     *
     * `verificar-acesso` não devolve tecnologia nem manutenção — esses campos
     * só existem em `/v1/cliente`. Uma segunda leitura documentada e
     * read-only os traz, mas ela NUNCA pode custar o estado: se falhar, os
     * extras ficam nulos e o ONLINE/OFFLINE segue intacto. Trocar o
     * essencial pelo acessório seria o erro óbvio aqui.
     */
    let technology: string | null = null;
    let serverMaintenance: boolean | null = null;
    try {
      const detail = await this.getCustomerDetail(String(id));
      technology = detail.technology;
      serverMaintenance = detail.serverMaintenance;
    } catch {
      // Silêncio deliberado: o estado já foi obtido e é o que importa.
    }

    // `sourceUpdatedAt` fica NULO: o contrato não devolve nenhum instante em
    // que o estado mudou, e derivá-lo do nosso tempo de recebimento seria
    // fabricar um sinal de ordenação que o provider não deu.
    return {
      status: payload.status === 1 ? "ONLINE" : "OFFLINE",
      sourceUpdatedAt: null,
      technology,
      serverMaintenance,
    };
  }
}

// ---------------------------------------------------------------------------
// Normalização
//
// Nenhum payload bruto do provider atravessa estas funções. Campo ausente vira
// `null`, nunca string vazia nem valor inventado — quem consome precisa
// conseguir distinguir "o ERP não informou" de "o ERP informou vazio".
// ---------------------------------------------------------------------------

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function toSummary(row: CallCenterClienteResumo): ERPCustomerSummary {
  return {
    externalId: String(row.idCliente),
    name: text(row.razaoSocial) ?? "(sem nome)",
    document: text(row.cpfcnpj),
    login: text(row.login),
    address: text(row.endereco),
    district: text(row.bairro),
    city: text(row.cidade),
    state: text(row.uf)?.toUpperCase() ?? null,
    zipCode: text(row.cep),
  };
}

function toDetail(row: CallCenterClienteDetalhado): ERPCustomerDetail {
  /**
   * `cpfCnpj` no detalhe, `cpfcnpj` no resumo — divergência real entre os dois
   * schemas do próprio contrato. Aceito os dois em vez de escolher um e perder
   * o dado quando a API responder com o outro.
   */
  const document =
    text(row.cpfCnpj) ??
    text((row as unknown as { cpfcnpj?: unknown }).cpfcnpj);

  const plan = Array.isArray(row.planos)
    ? (text(row.planos.find((p) => text(p?.descricao))?.descricao) ?? null)
    : null;

  /**
   * `tecnologia` é um inteiro e o contrato NÃO documenta o que cada valor
   * significa. Devolvo o código como veio, sem traduzir: inventar
   * "1 = Fibra, 2 = Rádio" produziria uma tela que parece informada e mente.
   * Está na lista de perguntas ao suporte (`docs/ERP-INTEGRATIONS.md`).
   */
  const technology =
    typeof row.tecnologia === "number" ? String(row.tecnologia) : null;

  const maintenanceRaw = row.servidor?.manutencao;
  const serverMaintenance =
    typeof maintenanceRaw === "boolean"
      ? maintenanceRaw
      : typeof maintenanceRaw === "string"
        ? maintenanceRaw.trim() !== "" && maintenanceRaw !== "false"
        : null;

  return {
    externalId: String(row.idCliente),
    name: text(row.razaoSocial) ?? "(sem nome)",
    document,
    login: text((row as unknown as { login?: unknown }).login),
    address: text(row.endereco),
    district: text(row.bairro),
    city: text(row.cidade),
    state: text(row.uf)?.toUpperCase() ?? null,
    zipCode: text(row.cep),
    plan,
    technology,
    contractStatus: text(row.contratoStatusDisplay),
    serverMaintenance,
  };
}

function parseIdCliente(externalId: string, provider: string): number {
  const id = Number(externalId);
  if (!Number.isInteger(id) || id <= 0) {
    // O CallCenter exige `idCliente` inteiro. Um externalId que não é numérico
    // veio de outro provider ou foi digitado à mão — não é cliente ReceitaNet.
    throw new IntegrationError(
      "CUSTOMER_NOT_FOUND",
      provider,
      "identificador externo não é um idCliente ReceitaNet",
    );
  }
  return id;
}

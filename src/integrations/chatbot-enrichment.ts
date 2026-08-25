/**
 * Normalização do payload do Chatbot para um DTO seguro.
 *
 * Este módulo existe para uma finalidade: ser a ÚNICA fronteira entre um
 * payload que contém senha de cliente em texto puro e o resto do AlfaOS. Depois
 * daqui, o objeto bruto é descartado.
 *
 * Todos os campos são tratados como opcionais mesmo quando a homologação os
 * observou preenchidos: foram observados em UM cliente, e um contrato não
 * publicado não vira garantia porque uma amostra coincidiu.
 */

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decimal do provider, que pode chegar como número OU string.
 *
 * `planos[].valor` chega como String nesta API, e coordenadas como Decimal.
 * `Number()` ingênuo aceitaria `"1.234,56"` como `NaN` e `""` como `0` — este
 * último é o perigoso, porque zero parece um valor legítimo.
 */
function decimal(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (trimmed === "") return null;

  // Formato brasileiro (`1.234,56`) vira `1234.56`; formato com ponto decimal
  // passa direto. A distinção é pela ÚLTIMA vírgula, não por heurística de
  // contagem.
  const normalized = trimmed.includes(",")
    ? trimmed.replace(/\./g, "").replace(",", ".")
    : trimmed;

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Uma credencial de acesso do cliente, como o Chatbot a expõe. */
export interface ChatbotLogin {
  login: string;
  /**
   * Senha em TEXTO PURO.
   *
   * Segue imediatamente para a cifra da `CustomerConnection`. Nunca é
   * persistida assim, nunca é logada, nunca atravessa para um Client Component.
   */
  password: string | null;
  isPrincipal: boolean;
}

export interface ChatbotAddress {
  address: string | null;
  /** Pode ser nulo no provider. Nunca inventar número. */
  number: string | null;
  complement: string | null;
  district: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  /** Ponto de referência — é o que faz o técnico achar a casa. */
  reference: string | null;
}

export interface ChatbotServer {
  server: string | null;
  profile: string | null;
  /** Código do tipo. Sem enum: o provider não publica os significados. */
  type: string | null;
  ip: string | null;
  networkInterface: string | null;
  mac: string | null;
  serial: string | null;
  networkElement: string | null;
  maintenance: boolean | null;
}

export interface ChatbotPlan {
  description: string | null;
  quantity: number | null;
  /** Já normalizado. `null` quando o provider mandou algo não numérico. */
  value: number | null;
}

export interface ChatbotCustomerEnrichment {
  externalId: string | null;
  contractId: string | null;
  name: string | null;
  document: string | null;
  email: string | null;
  /** Todos os telefones, sem assumir que há exatamente um. */
  phones: string[];
  /**
   * Coordenadas do cadastro do provider.
   *
   * `x` é latitude e `y` é longitude — validado geograficamente contra o
   * endereço real. A nomenclatura do provider é ambígua o bastante para que
   * inverter fosse fácil, por isso o mapeamento está fixado aqui e testado.
   */
  latitude: number | null;
  longitude: number | null;
  address: ChatbotAddress;
  server: ChatbotServer;
  plans: ChatbotPlan[];
  logins: ChatbotLogin[];
  contractStatus: string | null;
  technologyCode: string | null;
}

/** Extrai o telefone de um item que pode ser string ou objeto. */
function phoneOf(entry: unknown): string | null {
  if (typeof entry === "string") return text(entry);
  if (isRecord(entry)) {
    // O provider pode encapsular; tenta as chaves plausíveis sem inventar.
    for (const key of ["telefone", "numero", "fone", "phone"]) {
      const found = text(entry[key]);
      if (found) return found;
    }
  }
  return null;
}

function toLogins(raw: unknown, fallback: Record<string, unknown>): ChatbotLogin[] {
  const list = Array.isArray(raw) ? raw : [];

  const parsed = list
    .filter(isRecord)
    .map((item): ChatbotLogin | null => {
      const login = text(item.login);
      if (!login) return null;
      return {
        login,
        password: text(item.senha),
        isPrincipal: item.isPrincipal === true,
      };
    })
    .filter((item): item is ChatbotLogin => item !== null);

  if (parsed.length > 0) {
    return parsed;
  }

  /**
   * Sem `logins[]`, cai para o par solto `login`/`senha` do contrato.
   *
   * A homologação mostrou que `logins[0]` coincide com esse par quando ambos
   * existem, então o fallback não contradiz nada — e cobre um provider que
   * responda só a forma antiga.
   */
  const login = text(fallback.login);
  if (!login) return [];
  return [{ login, password: text(fallback.senha), isPrincipal: true }];
}

/**
 * Escolhe a conexão principal.
 *
 * **Pelo campo `isPrincipal`, nunca pelo índice.** A homologação viu
 * `logins[0].isPrincipal === true`, mas uma amostra não é ordenação garantida,
 * e assumir a ordem faria o técnico receber a credencial errada no primeiro
 * cliente em que o provider devolvesse outra sequência.
 */
export function selectPrincipalLogin(logins: ChatbotLogin[]): ChatbotLogin | null {
  return logins.find((l) => l.isPrincipal) ?? logins[0] ?? null;
}

/**
 * Normaliza a resposta do Chatbot.
 *
 * Devolve `null` quando não há contrato utilizável — sem lançar, porque
 * "cliente sem contrato" não é falha de integração.
 */
export function normalizeChatbotCustomer(
  payload: unknown,
): ChatbotCustomerEnrichment | null {
  if (!isRecord(payload)) return null;

  const contratos = payload.contratos;
  // O contrato descreve um objeto; aceitar também array de um evita quebrar se
  // o provider mudar a cardinalidade sem avisar.
  const contract = isRecord(contratos)
    ? contratos
    : Array.isArray(contratos) && isRecord(contratos[0])
      ? contratos[0]
      : null;

  if (!contract) return null;

  const endereco = isRecord(contract.endereco) ? contract.endereco : {};
  const servidor = isRecord(contract.servidor) ? contract.servidor : {};
  const coords = isRecord(contract.coordenadas) ? contract.coordenadas : {};

  const phones = (Array.isArray(contract.telefones) ? contract.telefones : [])
    .map(phoneOf)
    .filter((p): p is string => p !== null);

  const plans = (Array.isArray(contract.planos) ? contract.planos : [])
    .filter(isRecord)
    .map(
      (p): ChatbotPlan => ({
        description: text(p.descricao),
        quantity: typeof p.quantidade === "number" ? p.quantidade : null,
        value: decimal(p.valor),
      }),
    );

  return {
    externalId:
      typeof contract.idCliente === "number" ? String(contract.idCliente) : null,
    contractId:
      typeof contract.idContrato === "number" ? String(contract.idContrato) : null,
    name: text(contract.razaoSocial),
    document: text(contract.cpfCnpj),
    email: text(contract.email),
    phones,
    latitude: decimal(coords.x),
    longitude: decimal(coords.y),
    address: {
      address: text(endereco.endereco),
      number: text(endereco.numero),
      complement: text(endereco.complemento),
      district: text(endereco.bairro),
      city: text(endereco.cidade),
      state: text(endereco.uf)?.toUpperCase() ?? null,
      zipCode: text(endereco.cep),
      reference: text(endereco.referencia),
    },
    server: {
      server: text(servidor.servidor),
      profile: text(servidor.profile),
      type: text(servidor.tipo),
      ip: text(servidor.ip),
      networkInterface: text(servidor.interface),
      mac: text(servidor.mac),
      serial: text(servidor.idSerial),
      networkElement: text(servidor.elementoRede),
      maintenance:
        typeof servidor.isManutencao === "boolean" ? servidor.isManutencao : null,
    },
    plans,
    logins: toLogins(contract.logins, contract),
    contractStatus: text(contract.contratoStatusDisplay),
    technologyCode:
      typeof contract.tecnologia === "number" ? String(contract.tecnologia) : null,
  };
}

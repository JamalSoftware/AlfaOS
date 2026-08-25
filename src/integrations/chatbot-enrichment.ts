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
 * Desfecho da seleção da credencial principal.
 *
 * Três estados, e não um `| null`, porque “não há credencial” e “há mais de
 * uma e não dá para saber qual” exigem reações opostas: a primeira é
 * silêncio legítimo, a segunda precisa parar a automação e aparecer.
 */
export type ChatbotLoginSelection =
  | { outcome: "NONE" }
  | { outcome: "SELECTED"; login: ChatbotLogin }
  | { outcome: "AMBIGUOUS"; reason: "NO_PRINCIPAL" | "MULTIPLE_PRINCIPAL" };

/**
 * Escolhe a credencial principal — **nunca por ordem do provider**.
 *
 * A versão anterior caía em `logins[0]` quando nenhum vinha marcado. Isso
 * parecia inofensivo porque a homologação viu o principal na posição 0, mas
 * uma amostra não é ordenação garantida: no primeiro cliente em que o
 * provider devolvesse outra sequência, o técnico receberia a credencial de
 * OUTRA conexão do mesmo cliente — e ela seria gravada rotulada como
 * `RECEITANET_CHATBOT`, isto é, como se fosse a verdade do provedor.
 *
 * Uma lista de UM elemento é selecionada mesmo sem `isPrincipal`, porque aí
 * não existe ambiguidade a resolver: não há outra candidata.
 */
export function selectPrincipalLogin(logins: ChatbotLogin[]): ChatbotLoginSelection {
  if (logins.length === 0) {
    return { outcome: "NONE" };
  }
  if (logins.length === 1) {
    return { outcome: "SELECTED", login: logins[0] };
  }

  const principals = logins.filter((l) => l.isPrincipal);
  if (principals.length === 1) {
    return { outcome: "SELECTED", login: principals[0] };
  }
  return {
    outcome: "AMBIGUOUS",
    reason: principals.length === 0 ? "NO_PRINCIPAL" : "MULTIPLE_PRINCIPAL",
  };
}

/**
 * Desfecho da normalização.
 *
 * `AMBIGUOUS` existe porque escolher em silêncio entre contratos é a falha
 * mais cara possível aqui: gravaria PPPoE, telefone, endereço e coordenada
 * de um contrato que talvez não seja o que o técnico vai atender.
 */
export type ChatbotNormalization =
  | { outcome: "NONE" }
  | { outcome: "RESOLVED"; customer: ChatbotCustomerEnrichment }
  | { outcome: "AMBIGUOUS"; contractIds: string[] };

/** Identidade que o AlfaOS já conhece, para desempatar múltiplos contratos. */
export interface ChatbotContractHint {
  /** `idCliente` já vinculado ao Customer, quando houver. */
  externalId?: string | null;
  /** `idContrato`, se algum dia for persistido. Hoje o AlfaOS não guarda. */
  contractId?: string | null;
}

function contractsOf(payload: Record<string, unknown>): Record<string, unknown>[] {
  const contratos = payload.contratos;
  if (isRecord(contratos)) return [contratos];
  if (Array.isArray(contratos)) return contratos.filter(isRecord);
  return [];
}

/**
 * Normaliza a resposta do Chatbot.
 *
 * Com mais de um contrato, resolve SOMENTE por identidade estável que o
 * AlfaOS já conhece. Não havendo desempate, devolve `AMBIGUOUS` — e o
 * chamador não grava nada. "Cliente sem contrato" continua sendo `NONE`,
 * não falha.
 */
export function normalizeChatbotCustomer(
  payload: unknown,
  hint: ChatbotContractHint = {},
): ChatbotNormalization {
  if (!isRecord(payload)) return { outcome: "NONE" };

  const all = contractsOf(payload);
  if (all.length === 0) return { outcome: "NONE" };

  let contract: Record<string, unknown>;

  if (all.length === 1) {
    contract = all[0];
  } else {
    /**
     * `idContrato` primeiro: é o identificador do CONTRATO, e é o único que
     * desempata de fato. `idCliente` é compartilhado entre os contratos do
     * mesmo cliente, então não resolve nada aqui — e é por isso que ele
     * sozinho não basta para sair do estado ambíguo.
     */
    const byContract = hint.contractId
      ? all.filter((c) => String(c.idContrato) === hint.contractId)
      : [];

    if (byContract.length !== 1) {
      return {
        outcome: "AMBIGUOUS",
        contractIds: all.map((c) =>
          typeof c.idContrato === "number" ? String(c.idContrato) : "?",
        ),
      };
    }
    contract = byContract[0];
  }

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

  const customer: ChatbotCustomerEnrichment = {
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

  return { outcome: "RESOLVED", customer };
}

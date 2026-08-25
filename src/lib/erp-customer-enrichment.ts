import type { CustomerLocationSource } from "@prisma/client";
import {
  normalizeChatbotCustomer,
  type ChatbotCustomerEnrichment,
} from "@/integrations/chatbot-enrichment";
import { isIntegrationError } from "@/integrations/errors";
import { logAudit } from "./audit";
import { resolveChatbotClient } from "./erp-adapter";
import {
  provisionPppoeFromErp,
  type PppoeProvisionOutcome,
} from "./pppoe-provisioning";
import { prisma } from "./prisma";

/**
 * Enriquecimento do cadastro do cliente a partir do ReceitaNet Chatbot.
 *
 * O Chatbot é a única API do provedor que devolve telefone, e-mail, endereço
 * completo, coordenadas e a credencial PPPoE real. O CallCenter continua sendo
 * quem LOCALIZA o cliente; este módulo é o que enriquece o que já foi
 * localizado.
 *
 * ## Três regras governam tudo aqui
 *
 * 1. **Ambiguidade não grava.** Múltiplos contratos sem desempate inequívoco
 *    não produzem escrita nenhuma — nem telefone, nem endereço, nem PPPoE.
 *    Gravar "o primeiro" espalharia dados de um contrato que talvez não seja o
 *    que o técnico vai atender, e o erro só apareceria em campo.
 *
 * 2. **Falha do Chatbot não derruba o CallCenter.** A importação básica já
 *    aconteceu quando este módulo roda. Um Chatbot indisponível vira um
 *    desfecho reportado, não uma exceção que desfaz o trabalho anterior.
 *
 * 3. **Contato digitado por gente não é sobrescrito.** Ver
 *    `CONTACT_FILL_POLICY` abaixo.
 *
 * Nenhum campo do payload bruto atravessa este módulo: tudo passa pelo DTO
 * normalizado, e a senha PPPoE segue direto para a cifra.
 */

/**
 * Política de preenchimento dos campos de CONTATO (telefone e e-mail).
 *
 * Eles só são gravados quando o campo local está VAZIO.
 *
 * O motivo é operacional, não técnico: telefone e e-mail são exatamente os
 * campos que o despachante corrige à mão depois de falar com o cliente — o
 * número do cadastro não atende, ele anota o novo. Deixar a releitura do ERP
 * sobrescrever isso apagaria a informação mais atual que a empresa tem, em
 * favor da mais velha.
 *
 * Endereço e nome seguem a política oposta (ERP é fonte), porque vêm do
 * cadastro do provedor e já eram tratados assim antes desta versão.
 */
const CONTACT_FILL_POLICY = "only-when-empty" as const;

export type ErpEnrichmentOutcome =
  /** Contrato resolvido e dados aplicados. */
  | "SUCCESS"
  /** Aplicado, mas algo não coube no modelo — ver `phonesDiscarded`. */
  | "PARTIAL"
  /** Múltiplos contratos sem desempate. NADA foi gravado. */
  | "AMBIGUOUS"
  /** Provedor não conhece este documento. */
  | "NOT_FOUND"
  /** Chatbot não configurado, indisponível, ou cliente sem documento. */
  | "UNAVAILABLE";

export interface ErpEnrichmentResult {
  outcome: ErpEnrichmentOutcome;
  /**
   * Código do catálogo fechado quando `UNAVAILABLE`. Nunca corpo, mensagem ou
   * URL do provedor.
   */
  code?: string;
  /**
   * Quantos telefones o modelo não comportou.
   *
   * Contagem, nunca os valores. Existe para que a perda seja VISÍVEL: o
   * cadastro tem dois campos e o provedor pode devolver mais, e descartar em
   * silêncio deixaria o operador sem saber que existe um terceiro contato.
   */
  phonesDiscarded?: number;
  /** Ids dos contratos candidatos quando `AMBIGUOUS`. Só os ids. */
  contractIds?: string[];
  /** Desfecho do provisionamento da conexão PPPoE. */
  pppoe?: PppoeProvisionOutcome;
}

/** Só dígitos. */
function digits(raw: string): string {
  return raw.replace(/\D/g, "");
}

/**
 * Telefone brasileiro plausível, ou `null`.
 *
 * 10 dígitos (fixo com DDD) ou 11 (celular com DDD). Rejeita repetição total
 * (`0000000000`, `9999999999`), que é preenchimento de formulário, não
 * telefone.
 */
export function normalizeCustomerPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const only = digits(raw);
  if (only.length !== 10 && only.length !== 11) return null;
  if (/^(\d)\1+$/.test(only)) return null;
  return only;
}

/**
 * E-mail plausível, ou `null`.
 *
 * Validação deliberadamente frouxa — a rigorosa vive na RFC e rejeitaria
 * endereços válidos. Aqui basta separar "parece endereço" de "não é".
 */
export function normalizeCustomerEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase();
  if (value.length < 5 || value.length > 254) return null;
  if (!/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(value)) return null;
  return value;
}

/**
 * Coordenada dentro da faixa, ou `null`.
 *
 * `(0, 0)` é recusado: é o Golfo da Guiné, e nenhum provedor brasileiro tem
 * cliente lá. Na prática é o sentinela de "não preenchido" que um cadastro
 * devolve, e gravá-lo mandaria o técnico para o meio do Atlântico.
 */
export function normalizeCoordinates(
  latitude: number | null,
  longitude: number | null,
): { latitude: number; longitude: number } | null {
  if (latitude === null || longitude === null) return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90) return null;
  if (longitude < -180 || longitude > 180) return null;
  if (latitude === 0 && longitude === 0) return null;
  return { latitude, longitude };
}

/** Telefones válidos e sem repetição, na ordem em que o provedor mandou. */
export function normalizePhoneList(raw: string[]): string[] {
  const valid: string[] = [];
  for (const entry of raw) {
    const normalized = normalizeCustomerPhone(entry);
    // Sem duplicata: o provedor às vezes repete o mesmo número nos dois campos.
    if (normalized && !valid.includes(normalized)) valid.push(normalized);
  }
  return valid;
}

/**
 * Preenche os slots LIVRES do cadastro com os telefones do provedor.
 *
 * O cálculo tem de olhar quais slots estão de fato disponíveis, não apenas
 * partir a lista em dois. Com `phone` já ocupado por um número digitado à
 * mão, uma divisão cega gravaria o SEGUNDO telefone do provedor em
 * `secondaryPhone` e perderia o primeiro sem contá-lo — exatamente a perda
 * silenciosa que o descarte reportado existe para impedir.
 *
 * Números que já estão no cadastro são ignorados: reescrever o mesmo valor
 * no outro campo ocuparia um slot com informação que já existe.
 */
export function fillPhoneSlots(
  providerPhones: string[],
  local: { phone: string | null; secondaryPhone: string | null },
): { phone?: string; secondaryPhone?: string; discarded: number } {
  const already = normalizePhoneList(
    [local.phone, local.secondaryPhone].filter((p): p is string => Boolean(p)),
  );
  const candidates = normalizePhoneList(providerPhones).filter(
    (p) => !already.includes(p),
  );

  const out: { phone?: string; secondaryPhone?: string; discarded: number } = {
    discarded: 0,
  };
  let used = 0;

  if (!local.phone && candidates[used]) {
    out.phone = candidates[used];
    used += 1;
  }
  if (!local.secondaryPhone && candidates[used]) {
    out.secondaryPhone = candidates[used];
    used += 1;
  }

  out.discarded = candidates.length - used;
  return out;
}

function errorCode(error: unknown): string {
  return isIntegrationError(error) ? error.code : "UNKNOWN";
}

/**
 * Enriquece um Customer já existente com o que o Chatbot souber dele.
 *
 * Nunca lança: o chamador é o fluxo de importação, que já concluiu o essencial.
 */
export async function enrichCustomerFromChatbot(
  companyId: string,
  actorUserId: string,
  customerId: string,
): Promise<ErpEnrichmentResult> {
  /**
   * A garantia de não lançar precisa valer para o corpo INTEIRO.
   *
   * A versão anterior só protegia as chamadas ao provedor: uma falha na
   * gravação ou na resolução do contrato escapava e derrubava a importação
   * — que já tinha concluído a parte essencial. O enriquecimento é efeito
   * colateral, e efeito colateral não desfaz o trabalho principal.
   */
  try {
    return await runEnrichment(companyId, actorUserId, customerId);
  } catch {
    // Sem detalhe: a exceção pode carregar fragmento do payload.
    return { outcome: "UNAVAILABLE", code: "ENRICHMENT_FAILED" };
  }
}

async function runEnrichment(
  companyId: string,
  actorUserId: string,
  customerId: string,
): Promise<ErpEnrichmentResult> {
  const customer = await prisma.customer.findFirst({
    // Tenant em SQL. O `customerId` vem do fluxo interno, mas filtrar de novo
    // impede que a segurança dependa de o chamador ter feito o certo.
    where: { id: customerId, companyId },
    select: {
      id: true,
      document: true,
      phone: true,
      secondaryPhone: true,
      email: true,
      externalContractId: true,
    },
  });

  if (!customer?.document) {
    // O Chatbot consulta por CPF/CNPJ. Sem documento não há o que perguntar.
    return { outcome: "UNAVAILABLE", code: "NO_DOCUMENT" };
  }

  let client;
  try {
    client = await resolveChatbotClient(companyId);
  } catch (error) {
    return { outcome: "UNAVAILABLE", code: errorCode(error) };
  }
  if (!client) {
    // Empresa não configurou o Chatbot. Estado legítimo, não falha.
    return { outcome: "UNAVAILABLE", code: "NOT_CONFIGURED" };
  }

  let payload: unknown;
  try {
    payload = await client.buscarClientes(customer.document);
  } catch (error) {
    if (isIntegrationError(error) && error.code === "CUSTOMER_NOT_FOUND") {
      return { outcome: "NOT_FOUND" };
    }
    return { outcome: "UNAVAILABLE", code: errorCode(error) };
  }

  const normalized = normalizeChatbotCustomer(payload, {
    contractId: customer.externalContractId,
  });

  if (normalized.outcome === "NONE") {
    return { outcome: "NOT_FOUND" };
  }
  if (normalized.outcome === "AMBIGUOUS") {
    /**
     * Múltiplos contratos e nenhum desempate. Nada é gravado — nem os campos
     * que "provavelmente" seriam iguais entre contratos, porque decidir quais
     * seriam é a mesma adivinhação por outro nome.
     */
    return { outcome: "AMBIGUOUS", contractIds: normalized.contractIds };
  }

  return applyEnrichment(companyId, actorUserId, customer, normalized.customer);
}

async function applyEnrichment(
  companyId: string,
  actorUserId: string,
  local: {
    id: string;
    document: string | null;
    phone: string | null;
    secondaryPhone: string | null;
    email: string | null;
  },
  remote: ChatbotCustomerEnrichment,
): Promise<ErpEnrichmentResult> {
  const phones = fillPhoneSlots(remote.phones, {
    phone: local.phone,
    secondaryPhone: local.secondaryPhone,
  });
  const email = normalizeCustomerEmail(remote.email);
  const coords = normalizeCoordinates(remote.latitude, remote.longitude);

  const data: Record<string, unknown> = {};

  /**
   * Endereço e nome: o provedor é a fonte. Campo ausente na resposta NÃO apaga
   * o que existe localmente — só sobrescreve quando há valor novo.
   */
  if (remote.name) data.name = remote.name;
  if (remote.address.address) data.address = remote.address.address;
  if (remote.address.number) data.number = remote.address.number;
  if (remote.address.complement) data.complement = remote.address.complement;
  if (remote.address.district) data.district = remote.address.district;
  if (remote.address.city) data.city = remote.address.city;
  if (remote.address.state) data.state = remote.address.state;
  if (remote.address.zipCode) data.zipCode = remote.address.zipCode;

  /**
   * Referência do provedor entra no `complement` APENAS quando não há
   * complemento e não há referência já registrada ali.
   *
   * O cadastro não tem campo próprio para ponto de referência, e ele é o que
   * faz o técnico achar a casa quando não há número. Anexá-lo ao complemento
   * preserva a informação sem inventar coluna; sobrescrever um complemento
   * real com ela destruiria endereço.
   */
  if (!remote.address.complement && remote.address.reference) {
    data.complement = `Ref.: ${remote.address.reference}`;
  }

  /**
   * Contato: só preenche o que está vazio. Ver `CONTACT_FILL_POLICY`.
   *
   * `fillPhoneSlots` já decidiu o que cabe nos slots livres, então aqui é só
   * gravar o que ele devolveu.
   */
  if (CONTACT_FILL_POLICY === "only-when-empty") {
    if (phones.phone) data.phone = phones.phone;
    if (phones.secondaryPhone) data.secondaryPhone = phones.secondaryPhone;
    if (!local.email && email) data.email = email;
  }

  if (coords) {
    data.latitude = coords.latitude;
    data.longitude = coords.longitude;
    data.locationSource = "IMPORTED" satisfies CustomerLocationSource;
    /**
     * Importada NUNCA é verificada. Coordenada de cadastro ajuda a chegar
     * perto; dizer que foi confirmada faria o técnico confiar nela em vez de
     * procurar o endereço quando ela estiver errada.
     */
    data.locationVerified = false;
  }

  if (remote.contractId) data.externalContractId = remote.contractId;

  await prisma.customer.updateMany({
    // Escopo de tenant viaja com a escrita, não só com a leitura anterior.
    where: { id: local.id, companyId },
    data,
  });

  const pppoe = await provisionPppoeFromErp(companyId, actorUserId, {
    customerId: local.id,
    // O Chatbot traz o login junto com a senha; o CallCenter não entra aqui.
    login: null,
    document: local.document,
    chatbotLogins: remote.logins,
  });

  await logAudit({
    companyId,
    userId: actorUserId,
    action: "CUSTOMER.ENRICHED_FROM_CHATBOT",
    entity: "Customer",
    entityId: local.id,
    /**
     * NOMES dos campos alterados, nunca os valores — a lista carrega telefone,
     * e-mail e endereço de uma pessoa.
     */
    details: `Campos atualizados: ${Object.keys(data).join(", ") || "nenhum"}`,
  });

  return {
    outcome: phones.discarded > 0 ? "PARTIAL" : "SUCCESS",
    ...(phones.discarded > 0 ? { phonesDiscarded: phones.discarded } : {}),
    pppoe,
  };
}

import type { ERPIntegrationContract } from "./contract";

/**
 * Chamados abertos do cliente no ERP — leitura, e só.
 *
 * Isto NÃO é sincronização de OS. Nada aqui cria, altera ou fecha uma Ordem de
 * Serviço do AlfaOS: é contexto para quem atende saber que o cliente já tem
 * chamado aberto do outro lado. A OS do AlfaOS continua nascendo no AlfaOS
 * (`docs/PRD.md` §121–§131).
 */

/** Um chamado aberto, normalizado. Nenhum campo bruto do provider atravessa. */
export interface ERPServiceTicket {
  /**
   * Identidade do chamado NO PROVIDER (`idSuporte`/SUP_CODIGO no CallCenter).
   * É o candidato a `externalId` se um dia houver importação — não é, e nunca
   * deve ser confundido com, o número da OS.
   */
  externalId: string;
  /**
   * Número visível da OS no ERP (`numero`/SUP_NUMERO).
   *
   * NÃO substitui `ServiceOrder.number`, que é o número local do AlfaOS. São
   * dois sistemas numerando as próprias ordens, e sobrepô-los faria o técnico
   * citar um número que o atendente não encontra.
   */
  externalNumber: string | null;
  protocol: string | null;
  description: string | null;
  /**
   * Código do tipo, como o provider o expõe. Inteiro sem tabela de significado
   * publicada — nenhum rótulo é inventado aqui.
   */
  typeCode: string | null;
  /** Previsão, como texto do provider. Não é parseada para data. */
  forecast: string | null;
  /**
   * Telefone que aparece no corpo do chamado, quando reconhecível.
   *
   * É o contato DAQUELE atendimento, não o telefone mestre do cadastro — e por
   * isso nunca é promovido a `Customer.phone`.
   */
  contactPhone: string | null;
}

export interface ERPServiceTicketsResult {
  tickets: ERPServiceTicket[];
  /**
   * O provider limita a quantidade e não pagina.
   *
   * Exposto para que a tela possa dizer que a lista pode estar truncada. Sem
   * isto, "3 chamados abertos" e "10 de talvez 14" apareceriam iguais.
   */
  cap: number | null;
}

export interface ERPServiceTicketsCapability {
  /** Chamados ABERTOS do cliente no provider. Somente leitura. */
  listOpenTickets(externalId: string): Promise<ERPServiceTicketsResult>;
}

export function supportsServiceTickets(
  adapter: ERPIntegrationContract,
): adapter is ERPIntegrationContract & ERPServiceTicketsCapability {
  return (
    typeof (adapter as Partial<ERPServiceTicketsCapability>).listOpenTickets ===
    "function"
  );
}

/**
 * Extrai o telefone de contato do corpo do chamado.
 *
 * O CallCenter **não** expõe telefone estruturado em lugar nenhum — nem em
 * `/v1/cliente`, nem em `/v1/chamados`. O que existe é uma convenção de texto
 * na `descricao`, do tipo `Contato: 18999998888`, que o próprio exemplo do
 * OpenAPI mostra.
 *
 * Por ser convenção e não contrato, o parser é deliberadamente estreito:
 *
 * - exige o rótulo `Contato:` — número solto no meio de um relato não é
 *   contato, e capturá-lo produziria um telefone inventado;
 * - aceita só o que tem cara de telefone brasileiro (10 ou 11 dígitos);
 * - devolve `null` em qualquer dúvida.
 *
 * Falhar em extrair é barato: a tela mostra o telefone do cadastro. Extrair
 * errado manda o técnico ligar para um estranho.
 */
export function parseTicketContactPhone(description: string | null): string | null {
  if (!description) {
    return null;
  }

  // O primeiro caractere pode ser `(` de uma máscara: `Contato: (18) 3333-4444`
  // é formato corriqueiro, e exigir dígito na frente descartava justamente ele.
  const match = description.match(/contato\s*:\s*([+(\d][\d\s().+-]{7,})/i);
  if (!match) {
    return null;
  }

  const digits = match[1].replace(/\D/g, "");
  // 10 = fixo com DDD, 11 = celular com DDD. Fora disso não é telefone daqui.
  if (digits.length !== 10 && digits.length !== 11) {
    return null;
  }
  return digits;
}

/** Formata para leitura. Só apresentação — o valor guardado continua cru. */
export function formatBrazilianPhone(digits: string | null): string | null {
  if (!digits) return null;
  if (digits.length === 11) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }
  return digits;
}

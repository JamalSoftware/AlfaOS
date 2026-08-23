/**
 * Capability de busca de cliente no ERP — mantida FORA do
 * `ERPIntegrationContract`, pela mesma razão de `diagnostics.ts`.
 *
 * O contrato base é o que todo adapter precisa ter. Buscar cliente é algo que
 * um provider pode ou não oferecer: o MockERP não oferece, o CallCenter sim, e
 * URA/Chatbot oferecem com filtros diferentes. Dobrar isso no contrato base
 * obrigaria todo adapter a stubar o método ou transformaria a interface num
 * balaio de opcionais não relacionados.
 */

/**
 * Filtros de busca. Nenhum é obrigatório isoladamente, mas ao menos um precisa
 * estar presente — quem valida isso é o adapter, contra o que o provider aceita.
 *
 * Nem todo provider suporta todos: o CallCenter aceita nome, telefone e
 * CPF/CNPJ; a URA aceita CPF/CNPJ, telefone e contrato, mas não nome.
 */
export interface ERPCustomerQuery {
  name?: string;
  document?: string;
  phone?: string;
}

/**
 * Resultado normalizado, provider-neutral.
 *
 * O payload bruto do provider NUNCA chega a um componente. Tudo que a tela
 * renderiza passou por aqui, então nenhum campo que ninguém validou aparece na
 * interface por acidente.
 */
export interface ERPCustomerSummary {
  /**
   * Identificador do cliente NO PROVIDER, já como string.
   *
   * Qual identificador exatamente é decisão de cada adapter e precisa estar
   * documentada nele — providers diferentes expõem semânticas diferentes para
   * "cliente" e "contrato".
   */
  externalId: string;
  name: string;
  document: string | null;
  /** Login do cliente no provider, quando ele expõe. Não é credencial. */
  login: string | null;
  address: string | null;
  district: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
}

/** Detalhe: tudo do resumo, mais o que só a consulta individual traz. */
export interface ERPCustomerDetail extends ERPCustomerSummary {
  /** Rótulo do plano, quando o provider informa. Texto, não catálogo. */
  plan: string | null;
  /**
   * Tecnologia como o provider a expõe. Fica como string porque o CallCenter
   * devolve um inteiro sem tabela de significado documentada — traduzi-lo aqui
   * seria inventar o mapeamento.
   */
  technology: string | null;
  /** Situação do contrato em texto legível, quando informada. */
  contractStatus: string | null;
  /** Servidor do cliente em manutenção, quando o provider informa. */
  serverMaintenance: boolean | null;
}

export interface ERPCustomerLookupCapability {
  /**
   * Busca clientes no provider.
   *
   * Contrato para implementadores:
   *  - lançar `IntegrationError` para qualquer falha da integração;
   *  - devolver lista vazia quando o provider respondeu e não achou nada —
   *    "não encontrei" é resposta, não erro;
   *  - nunca devolver payload bruto do provider.
   */
  searchCustomers(query: ERPCustomerQuery): Promise<ERPCustomerSummary[]>;

  /** Detalhe de um cliente pelo identificador do PRÓPRIO provider. */
  getCustomerDetail(externalId: string): Promise<ERPCustomerDetail>;
}

export function supportsCustomerLookup(
  adapter: unknown,
): adapter is ERPCustomerLookupCapability {
  return (
    typeof adapter === "object" &&
    adapter !== null &&
    typeof (adapter as ERPCustomerLookupCapability).searchCustomers ===
      "function" &&
    typeof (adapter as ERPCustomerLookupCapability).getCustomerDetail ===
      "function"
  );
}

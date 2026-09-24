/**
 * # Como a "Atividade recente" do painel fala com o operador — DASH-1a
 *
 * `AuditLog.action` e `AuditLog.entity` são CÓDIGOS, gravados por quem audita e
 * lidos por gente em tela. Esta tabela traduz o código para uma frase, e é só
 * isso: **camada de apresentação**. Nenhum código persistido muda, nenhuma
 * linha de auditoria é reescrita, e a trilha continua dizendo exatamente o que
 * aconteceu, com o código que o sistema gravou.
 *
 * ## Só códigos que existem
 *
 * Cada chave abaixo é gravada por algum caminho de produção — literal, montada
 * a partir de um enum (`CTO_CONNECTION.<ação>`, `INVENTORY.<tipo>`), ou legada e
 * ainda presente em linhas antigas (`ERP_CREDENTIAL_INVALIDATED`). Um teste
 * varre o código-fonte e cobra rótulo para todo código novo; rótulo para código
 * que ninguém grava seria texto morto se passando por cobertura.
 *
 * ## Código desconhecido não some
 *
 * Sem rótulo, a tela mostra o próprio código. É feio e é verdadeiro: esconder a
 * linha, ou trocá-la por "Atividade", faria a trilha omitir o que aconteceu.
 */

export const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  // Instalação — acontece uma vez, antes de existir qualquer sessão
  "COMPANY.BOOTSTRAPPED": "Instalação inicializada",

  // Acesso — web
  "AUTH.LOGIN": "Login realizado",
  "AUTH.LOGIN_FAILED": "Tentativa de login recusada",
  "AUTH.LOGIN_BLOCKED": "Login bloqueado",
  "AUTH.RATE_LIMITED": "Login bloqueado por excesso de tentativas",

  // Acesso — aplicativo do técnico
  "FIELD.LOGIN": "Login no aplicativo",
  "FIELD.LOGIN_FAILED": "Tentativa de login no aplicativo recusada",
  "FIELD.LOGIN_BLOCKED": "Login no aplicativo bloqueado",
  "FIELD.LOGOUT": "Saída do aplicativo",
  "FIELD.DEVICE_REGISTERED": "Aparelho registrado",
  "FIELD.DEVICE_REVOKED": "Aparelho revogado",

  // Pessoas
  "USER.CREATED": "Usuário criado",
  "USER.UPDATED": "Usuário atualizado",
  "TECHNICIAN.CREATED": "Técnico cadastrado",
  "TECHNICIAN.UPDATED": "Técnico atualizado",
  "TIME_ADJUSTMENT.APPROVED": "Correção de ponto aprovada",
  "TIME_ADJUSTMENT.REJECTED": "Correção de ponto rejeitada",

  // Ordens de serviço
  "SERVICE_ORDER.CREATED": "OS criada",
  "SERVICE_ORDER.IMPORTED": "OS importada do ERP",
  "SERVICE_ORDER.RECEITANET_SYNC": "OS sincronizadas do ReceitaNet",
  "SERVICE_ORDER.ASSIGNED": "OS atribuída",
  "SERVICE_ORDER.PRIORITY_CHANGED": "Prioridade da OS alterada",
  "SERVICE_ORDER.STARTED": "Atendimento iniciado",
  "SERVICE_ORDER.CHECKED_IN": "Check-in na OS",
  "SERVICE_ORDER.CONTACT_ATTEMPTED": "Tentativa de contato registrada",
  "SERVICE_ORDER.IMPEDIMENT_REPORTED": "Impedimento registrado",
  "SERVICE_ORDER.EXECUTION_UPDATED": "Relatório de execução atualizado",
  "SERVICE_ORDER.CHECKLIST_ANSWERED": "Checklist da OS respondido",
  "SERVICE_ORDER.EVIDENCE_ADDED": "Evidência adicionada",
  "SERVICE_ORDER.EVIDENCE_REMOVED": "Evidência removida",
  "SERVICE_ORDER.MATERIAL_ADDED": "Material registrado na OS",
  "SERVICE_ORDER.MATERIAL_UPDATED": "Material da OS alterado",
  "SERVICE_ORDER.MATERIAL_REMOVED": "Material removido da OS",
  "SERVICE_ORDER.EQUIPMENT_INSTALLED": "Equipamento instalado",
  "SERVICE_ORDER.EQUIPMENT_REMOVED": "Equipamento removido",
  "SERVICE_ORDER.SIGNATURE_CAPTURED": "Assinatura coletada",
  "SERVICE_ORDER.COMPLETED": "OS concluída",
  "SERVICE_ORDER_TYPE.CREATED": "Tipo de OS criado",
  "SERVICE_ORDER_TYPE.UPDATED": "Tipo de OS atualizado",
  "SERVICE_ORDER_TYPE.COMPLETION_POLICY_SAVED":
    "Regras de conclusão do tipo de OS salvas",
  "CHECKLIST_TEMPLATE.SAVED": "Checklist salvo",

  // Clientes
  "CUSTOMER.CREATED": "Cliente criado",
  "CUSTOMER.UPDATED": "Cliente atualizado",
  "CUSTOMER.ENRICHED_FROM_CHATBOT": "Cadastro do cliente completado pelo ERP",
  "CUSTOMER_LOCATION.CONFIRMED": "Localização do cliente confirmada",
  "CUSTOMER_LOCATION.CORRECTED": "Localização do cliente corrigida",
  "CUSTOMER_DIAGNOSTIC.REFRESHED": "Diagnóstico do cliente atualizado",
  "CUSTOMER_CONNECTION.CREATED": "Conexão do cliente criada",
  "CUSTOMER_CONNECTION.UPDATED": "Conexão do cliente atualizada",
  "CUSTOMER_CONNECTION.PASSWORD_SOURCE_CHANGED": "Origem da senha PPPoE alterada",
  "CUSTOMER_CONNECTION.AUTO_PROVISION_FAILED":
    "Preenchimento automático da conexão falhou",
  PPPOE_CREDENTIAL_VIEWED: "Senha PPPoE visualizada",

  // Rede de distribuição
  "CTO.CREATED": "CTO criada",
  "CTO.UPDATED": "CTO atualizada",
  "CTO.CAPACITY_CHANGED": "Capacidade da CTO alterada",
  "CTO.PHOTO_UPDATED": "Foto da CTO atualizada",
  "STORAGE.PHOTO_RESANITIZED": "Foto antiga limpa de metadado",
  "CTO.PORT_STATE_CHANGED": "Estado de porta alterado",
  "CTO.ACTIVATED": "CTO reativada",
  "CTO.INACTIVATED": "CTO inativada",
  "CTO_CONNECTION.CONNECTED": "Cliente conectado à porta",
  "CTO_CONNECTION.DISCONNECTED": "Cliente desconectado da porta",
  "CTO_CONNECTION.MOVED": "Cliente movido de porta",

  // Estoque
  "INVENTORY.ITEM_CREATED": "Item de estoque criado",
  "INVENTORY.WAREHOUSE_TO_TECHNICIAN": "Material entregue ao técnico",
  "INVENTORY.TECHNICIAN_TO_CUSTOMER": "Material usado no atendimento",
  "INVENTORY.TECHNICIAN_TO_WAREHOUSE": "Material devolvido ao almoxarifado",
  "INVENTORY.ADJUSTMENT_IN": "Ajuste de estoque (entrada)",
  "INVENTORY.ADJUSTMENT_OUT": "Ajuste de estoque (saída)",

  // Integração ERP
  "ERP.ACTIVE_PROVIDER_CHANGED": "ERP ativo alterado",
  "ERP.ENABLED": "Integração ERP ativada",
  "ERP.DISABLED": "Integração ERP desativada",
  "ERP.TEST_CONNECTION": "Conexão com o ERP testada",
  "ERP.SYNC_SERVICE_ORDERS": "OS sincronizadas do ERP",
  "ERP_CUSTOMER.IMPORTED": "Cliente importado do ERP",
  "ERP_CREDENTIAL.SAVED": "Credencial de ERP salva",
  "ERP_CREDENTIAL.REMOVED": "Credencial de ERP removida",
  ERP_CREDENTIAL_SAVED: "Credencial de ERP salva",
  ERP_CREDENTIAL_REPLACED: "Credencial de ERP substituída",
  ERP_CREDENTIAL_REMOVED: "Credencial de ERP removida",
  // Legado: não é mais gravado, e continua em linhas antigas da trilha.
  ERP_CREDENTIAL_INVALIDATED: "Credencial de ERP invalidada",

  // Notificações
  "OUTBOX.REQUEUED": "Notificação reenfileirada",
};

export const AUDIT_ENTITY_LABELS: Readonly<Record<string, string>> = {
  User: "Usuário",
  Technician: "Técnico",
  TimeAdjustmentRequest: "Correção de ponto",
  MobileDevice: "Aparelho",
  ServiceOrder: "OS",
  ServiceOrderType: "Tipo de OS",
  ServiceOrderCompletionPolicy: "Regras de conclusão",
  ServiceOrderExecution: "Execução da OS",
  ServiceOrderCheckIn: "Check-in",
  ServiceOrderContactAttempt: "Tentativa de contato",
  ServiceOrderImpediment: "Impedimento",
  ServiceOrderChecklistItem: "Item do checklist",
  ServiceOrderEvidence: "Evidência",
  ServiceOrderMaterialUsage: "Material da OS",
  ServiceOrderEquipment: "Equipamento da OS",
  ServiceOrderSignature: "Assinatura",
  ChecklistTemplate: "Checklist",
  Customer: "Cliente",
  CustomerLocation: "Localização do cliente",
  CustomerConnection: "Conexão do cliente",
  CustomerNetworkConnection: "Vínculo de rede do cliente",
  CTO: "CTO",
  CTOPort: "Porta de CTO",
  InventoryItem: "Item de estoque",
  InventoryMovement: "Movimentação de estoque",
  ERPIntegration: "Integração ERP",
  ERPCredential: "Credencial de ERP",
  OutboxEvent: "Notificação",
};

// `hasOwnProperty`, e não `in`: um código chamado "constructor" não pode
// devolver uma função do protótipo como se fosse rótulo.
function lookup(table: Readonly<Record<string, string>>, key: string): string | null {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
}

/** A frase da ação — ou o próprio código, quando não há rótulo. */
export function auditActionLabel(action: string): string {
  return lookup(AUDIT_ACTION_LABELS, action) ?? action;
}

/** O nome do registro afetado — ou o próprio código, quando não há rótulo. */
export function auditEntityLabel(entity: string): string {
  return lookup(AUDIT_ENTITY_LABELS, entity) ?? entity;
}

/**
 * Nome legível do provedor de ERP.
 *
 * Vive num módulo próprio porque duas telas precisam dele — o painel de
 * diagnóstico, que é Client Component, e a página da OS, que é Server
 * Component. Duplicar o mapa faria a tela administrativa e a operacional
 * divergirem no dia em que um provedor novo entrasse.
 *
 * **Dado de mock nunca é apresentado como se viesse de um ERP real.** O rótulo
 * é o que o SERVIDOR resolveu; um provedor desconhecido aparece com o próprio
 * código, e não traduzido para um nome que ninguém verificou.
 */
const PROVIDER_LABELS: Record<string, string> = {
  MOCK: "Mock ERP",
  RECEITANET: "ReceitaNet",
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/**
 * O Mock ERP existe fora de produção, e só lá (RC-OPS-03).
 *
 * Ele gera clientes e ordens de serviço inventados. Em desenvolvimento e nos
 * testes é ferramenta; numa empresa real, "Sincronizar Mock ERP" importava OS
 * falsa sem caminho de apagar, queimando números de OS para sempre.
 *
 * Um só predicado, lido pela fábrica de adapters (nenhum dado de mock sai em
 * produção, por caminho nenhum), pelo domínio da sincronização e pelas telas.
 * Sem variável de ambiente para religar: um ambiente de demonstração que
 * precise dele roda fora do modo de produção.
 */
export function isMockErpEnabled(
  nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean {
  return nodeEnv !== "production";
}

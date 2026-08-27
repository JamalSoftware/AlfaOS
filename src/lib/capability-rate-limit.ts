/**
 * Rate limit para operações que disparam chamada a provider externo.
 *
 * Existe porque um endpoint que fala com o ReceitaNet é um amplificador: um
 * clique nosso vira uma requisição lá. Sem teto, uma tela em loop ou um usuário
 * impaciente gasta a cota da EMPRESA — e a punição do provider recai sobre
 * todos os operadores dela, não sobre quem clicou.
 *
 * ## Limitação conhecida, e por que é aceitável aqui
 *
 * O estado é **em memória do processo**. Com mais de uma instância, cada uma
 * tem o seu contador, e o teto efetivo é multiplicado pelo número de
 * instâncias. Isso é deliberado nesta etapa:
 *
 * - o alvo é acidente (loop de UI, clique repetido), não um atacante decidido;
 * - a alternativa — tabela nova + escrita a cada consulta — acrescentaria uma
 *   migration e um custo de banco por leitura, para um problema que ainda não
 *   se manifestou em produção;
 * - o AlfaOS roda hoje em instância única.
 *
 * Registrado em `docs/SECURITY.md`. Se a implantação virar multi-instância, o
 * limite precisa migrar para armazenamento compartilhado antes de ser levado a
 * sério como controle.
 */

import { jsonError } from "./api";

interface Window {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Window>();

/** Teto por janela. Generoso para uso humano, apertado para loop. */
export const CAPABILITY_LIMIT = 10;
export const CAPABILITY_WINDOW_MS = 60_000;

/**
 * Nomes das capabilities que falam com o provider.
 *
 * Constantes, e não strings soltas na rota: um erro de digitação criaria um
 * balde novo em silêncio e a rota passaria a não ter teto nenhum — a falha
 * seria invisível justamente por parecer que o limite existe.
 */
export const ERP_CAPABILITIES = {
  /** `POST /api/integrations/customers/search` — busca no CallCenter. */
  CUSTOMER_SEARCH: "erp-customer-search",
  /** `POST /api/integrations/customers/import` — detalhe + enriquecimento Chatbot. */
  CUSTOMER_IMPORT: "erp-customer-import",
  /** `POST /api/integrations/test-connection` — sonda de credencial. */
  TEST_CONNECTION: "erp-test-connection",
  /** `POST /api/service-orders/:id/diagnostic` — releitura de conectividade. */
  CUSTOMER_DIAGNOSTIC: "customer-diagnostic",
  /** `POST /api/integrations/sync` — sincronização de OS. */
  ORDER_SYNC: "erp-order-sync",
  /** `GET /api/service-orders/:id/receitanet-context` — contexto operacional. */
  RECEITANET_CONTEXT: "receitanet-context",
  /**
   * `POST /api/field/v1/service-orders/:id/pppoe/reveal` — texto claro no
   * celular.
   *
   * Não fala com provider, então não protege cota de ninguém: protege contra
   * um aparelho comprometido raspando senha em série. O teto é baixo de
   * propósito — revelar senha é gesto deliberado do técnico diante do cliente,
   * não algo que aconteça dezenas de vezes por minuto.
   */
  FIELD_PPPOE_REVEAL: "field-pppoe-reveal",
} as const;

/**
 * Teto por capability, quando o padrão não serve.
 *
 * O limite tem de caber no uso REAL, senão vira defeito: um teto que barra o
 * despachante importando uma lista de clientes não protege cota nenhuma — só
 * ensina a equipe a trabalhar contra a ferramenta. Cada número abaixo é o
 * volume plausível de um minuto de trabalho humano, não um valor redondo.
 *
 * Capability ausente daqui usa `CAPABILITY_LIMIT`.
 */
const CAPABILITY_LIMITS: Record<string, number> = {
  // Busca é dirigida por digitação: o operador refaz o filtro várias vezes até
  // achar o cliente certo.
  [ERP_CAPABILITIES.CUSTOMER_SEARCH]: 20,
  // Importar uma lista de resultados é um clique por linha, em sequência.
  [ERP_CAPABILITIES.CUSTOMER_IMPORT]: 30,
  // Sincronização é operação em lote e cara do outro lado; ninguém precisa
  // disparar mais que isso por minuto.
  [ERP_CAPABILITIES.ORDER_SYNC]: 5,
  // Revelar senha na frente do cliente acontece uma vez, e no máximo repete
  // porque a tela apagou. Cinco por minuto cobre o uso real com folga.
  [ERP_CAPABILITIES.FIELD_PPPOE_REVEAL]: 5,
};

function limitFor(capability: string): number {
  return CAPABILITY_LIMITS[capability] ?? CAPABILITY_LIMIT;
}

/**
 * Chave do balde.
 *
 * Inclui a EMPRESA porque a cota consumida é dela, o USUÁRIO para que um
 * operador em loop não bloqueie os colegas, e a CAPABILITY para que consultar
 * chamados não gaste o teto de consultar cadastro.
 */
function keyOf(companyId: string, userId: string, capability: string): string {
  return `${companyId}:${userId}:${capability}`;
}

/**
 * Consome uma unidade. `false` quando o teto já foi atingido.
 *
 * Varre os baldes expirados a cada chamada — são poucos e de vida curta, e um
 * `Map` que só cresce seria um vazamento silencioso num processo longevo.
 */
export function consumeCapabilityToken(
  companyId: string,
  userId: string,
  capability: string,
  now: number = Date.now(),
): { allowed: boolean; retryAfterSeconds: number } {
  const expired: string[] = [];
  buckets.forEach((w, k) => {
    if (w.resetAt <= now) expired.push(k);
  });
  expired.forEach((k) => buckets.delete(k));

  const key = keyOf(companyId, userId, capability);
  const current = buckets.get(key);

  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + CAPABILITY_WINDOW_MS });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (current.count >= limitFor(capability)) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }

  current.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Consome uma unidade e, se o teto estourou, devolve a resposta 429 pronta.
 *
 * Existe para que as seis rotas não repitam a mensagem: uma cópia divergente
 * seria a que um dia vazasse detalhe do upstream. O corpo carrega apenas
 * quantos segundos esperar — nunca token, URL, código do provider ou o nome
 * interno da capability.
 *
 * **Chamar SEMPRE depois da autorização.** Consumido antes, uma sondagem
 * anônima ou de outra empresa gastaria a cota de quem tem direito a ela.
 */
export function enforceCapabilityLimit(
  companyId: string,
  userId: string,
  capability: string,
): Response | null {
  const quota = consumeCapabilityToken(companyId, userId, capability);
  if (quota.allowed) {
    return null;
  }
  return jsonError(
    "Muitas solicitações. Tente novamente em instantes.",
    429,
    { retryAfterSeconds: quota.retryAfterSeconds },
  );
}

/** Só para teste: zera o estado entre cenários. */
export function resetCapabilityLimits(): void {
  buckets.clear();
}

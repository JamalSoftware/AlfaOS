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

interface Window {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Window>();

/** Teto por janela. Generoso para uso humano, apertado para loop. */
export const CAPABILITY_LIMIT = 10;
export const CAPABILITY_WINDOW_MS = 60_000;

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

  if (current.count >= CAPABILITY_LIMIT) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }

  current.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Só para teste: zera o estado entre cenários. */
export function resetCapabilityLimits(): void {
  buckets.clear();
}

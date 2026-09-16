/**
 * # A política de frescor da conectividade — um lugar só
 *
 * Duas grandezas **distintas**, e confundi-las foi exatamente o defeito que esta
 * política existe para fechar:
 *
 * ```text
 * refreshTargetMs   de quanto em quanto tempo RECONFERIMOS      padrão  5 min
 * staleAfterMs      a partir de quando a confirmação está VELHA padrão 10 min
 * ```
 *
 * ## Por que elas não podem morar em dois lugares
 *
 * Antes desta política, o worker lia o alvo de uma variável de ambiente e a tela
 * derivava o limiar de uma constante compilada. Um operador que alongasse o alvo
 * para 15 minutos veria a tela avisando "Verificação atrasada" aos 10 — certa
 * sobre o contrato e errada sobre aquele ambiente, sem nada no código sugerindo
 * a divergência.
 *
 * Agora as duas saem daqui, e quem consome — o ciclo e o read model — recebe os
 * mesmos números.
 *
 * ## A tela NÃO decide
 *
 * Nenhum componente compara idade com limiar. O read model entrega
 * `verificationIsStale` já resolvido, e a tela só pinta. É a mesma razão pela
 * qual a precedência do marcador do mapa não vive no cliente: regra que aparece
 * em dois lugares diverge no primeiro dia em que alguém mexe num deles.
 *
 * ## Configuração inválida derruba
 *
 * Zero, negativo, não numérico ou absurdo não vira padrão silencioso — a mesma
 * regra que a `RC-1B` aplicou às variáveis de login, e pelo mesmo motivo: um
 * teto que se desliga sozinho quando alguém erra a digitação não é um teto.
 */

/** O limite superior de sanidade. Acima disto é erro de digitação, não escolha. */
const MAXIMO_MS = 24 * 60 * 60_000;

export interface ConnectivityPolicy {
  /** Alvo de reverificação por conexão elegível. */
  refreshTargetMs: number;
  /** A partir de quando a tela avisa que a confirmação envelheceu. */
  staleAfterMs: number;
}

export const CONNECTIVITY_POLICY_DEFAULTS: ConnectivityPolicy = {
  refreshTargetMs: 5 * 60_000,
  staleAfterMs: 10 * 60_000,
};

export const REFRESH_TARGET_ENV = "DIAGNOSTICS_REFRESH_TARGET_MS";
export const STALE_AFTER_ENV = "DIAGNOSTICS_STALE_AFTER_MS";

function duracao(nome: string, cru: string | undefined, padrao: number): number {
  if (cru === undefined || cru === "") return padrao;
  const valor = Number(cru);
  if (!Number.isFinite(valor) || !Number.isInteger(valor) || valor <= 0) {
    throw new Error(
      `${nome} inválido: esperado inteiro positivo de milissegundos, recebido "${cru}"`,
    );
  }
  if (valor > MAXIMO_MS) {
    throw new Error(
      `${nome} inválido: ${valor} ms passa do teto de sanidade de ${MAXIMO_MS} ms (24 h)`,
    );
  }
  return valor;
}

/**
 * A política vigente, validada.
 *
 * Lançar aqui é deliberado: quem chama é o comando do ciclo (na subida) e o read
 * model (no servidor). Nos dois casos, uma configuração impossível precisa
 * aparecer como falha, e não como comportamento silenciosamente diferente do
 * que o operador pediu.
 */
export function resolveConnectivityPolicy(
  env: NodeJS.ProcessEnv = process.env,
): ConnectivityPolicy {
  const refreshTargetMs = duracao(
    REFRESH_TARGET_ENV,
    env[REFRESH_TARGET_ENV],
    CONNECTIVITY_POLICY_DEFAULTS.refreshTargetMs,
  );
  const staleAfterMs = duracao(
    STALE_AFTER_ENV,
    env[STALE_AFTER_ENV],
    CONNECTIVITY_POLICY_DEFAULTS.staleAfterMs,
  );

  /*
    O limiar do aviso NUNCA pode ser menor que o alvo.

    Se fosse, uma verificação recém-feita já nasceria "atrasada" — a tela
    avisaria sempre, o aviso perderia o sentido e a operação aprenderia a
    ignorá-lo. É uma relação entre as duas, então só pode ser conferida aqui,
    onde as duas existem juntas.
  */
  if (staleAfterMs < refreshTargetMs) {
    throw new Error(
      `${STALE_AFTER_ENV} (${staleAfterMs} ms) não pode ser menor que ` +
        `${REFRESH_TARGET_ENV} (${refreshTargetMs} ms): toda verificação nasceria atrasada`,
    );
  }

  return { refreshTargetMs, staleAfterMs };
}

/**
 * A confirmação envelheceu?
 *
 * Nunca verificado (`null`) **não** é atraso: é ausência de leitura, que a tela
 * já diz com todas as letras. Marcar de atrasado quem nunca foi lido somaria um
 * aviso a um estado que já é explícito.
 */
export function isVerificationStale(
  observedAt: Date | string | null,
  now: Date,
  policy: ConnectivityPolicy,
): boolean {
  if (!observedAt) return false;
  const instante =
    observedAt instanceof Date ? observedAt.getTime() : new Date(observedAt).getTime();
  if (Number.isNaN(instante)) return false;
  return now.getTime() - instante > policy.staleAfterMs;
}

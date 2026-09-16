import { prisma } from "./prisma";
import { refreshCustomerDiagnostic } from "./customer-diagnostics";
import { resolveConnectivityPolicy } from "./connectivity-policy";

/**
 * # `DIAG-AUTO-1` — a conectividade se reconfere sozinha
 *
 * Um cliente aparecia como *"Online · última leitura há 9 dias"*, e isso não
 * prova que ele continua online — prova só que ninguém olhou desde então. Este
 * módulo é o ciclo que olha: a cada volta, os clientes **fisicamente
 * conectados** cuja última verificação passou do alvo são reconsultados no
 * provider da própria empresa.
 *
 * ## O que ele NÃO é
 *
 * Não é um estado novo, não é uma segunda autoridade e não é um daemon. A
 * autoridade continua sendo `CustomerDiagnosticSnapshot`, escrita pelo MESMO
 * `refreshCustomerDiagnostic` que o botão de atualizar da OS usa — o ciclo não
 * tem caminho de escrita próprio, então não existe regra que valha para um e
 * não para o outro. Em particular, **falha do provider continua não escrevendo
 * nada**: nem estado, nem `observedAt`. É por isso que a tela consegue dizer
 * "Online há 9 dias · verificado há 37 min" em vez de mentir um estado novo.
 *
 * ## Elegibilidade: conexão física, não cadastro
 *
 * Quem entra é quem tem `CustomerNetworkConnection` ATIVA — cabo numa porta.
 * `Customer.active` **não** filtra: um cliente cadastralmente inativo que
 * continua ligado é exatamente o caso que a operação precisa enxergar, e
 * ignorá-lo esconderia equipamento em campo. Vínculo encerrado e porta livre
 * ficam de fora, porque não há o que conferir.
 *
 * ## Por que um comando, e não um laço
 *
 * O repositório inteiro não tem agendador: o worker do outbox é um lote único
 * chamado por cron do operador (`scripts/outbox-worker.ts`), e esse é o padrão
 * que este ciclo segue. Um daemon novo precisaria de supervisor, morreria no
 * deploy e duplicaria quando a hospedagem escalasse — os mesmos motivos já
 * escritos lá.
 *
 * **Consequência declarada:** a cadência de 5 minutos depende de alguém agendar
 * o comando. Sem isso, nada se atualiza sozinho — e a tela avisa, porque a
 * verificação envelhece e o selo "Verificação atrasada" aparece.
 *
 * ## Duas execuções ao mesmo tempo
 *
 * A elegibilidade sozinha NÃO protege, e isso foi medido antes de ser
 * corrigido: dois ciclos disparados no mesmo instante leem a mesma lista antes
 * de qualquer escrita e processam as seis conexões cada um — doze chamadas ao
 * provider para seis clientes.
 *
 * A proteção é uma RESERVA por cliente (`claimCustomerForCheck`), reivindicada
 * por `updateMany` com o prazo no predicado. Nenhum mecanismo novo: é o mesmo
 * compare-and-set que o outbox usa, e o prazo existe para que um processo morto
 * devolva o cliente à fila em vez de trancá-lo.
 *
 * Fica UMA janela, declarada: quem nunca foi verificado não tem linha onde ser
 * reservado, e dois ciclos simultâneos podem consultá-lo. Acontece no máximo
 * uma vez por cliente, e o banco continua coerente porque a escrita é
 * monotônica — inventar uma linha com um estado que ninguém observou, só para
 * ter onde travar, seria pior que a janela.
 */

/** O alvo: cada conexão elegível reconferida a cada ~5 minutos. */
export const CONNECTIVITY_REFRESH_TARGET_MS =
  resolveConnectivityPolicy().refreshTargetMs;

/**
 * Quantas verificações correm ao mesmo tempo.
 *
 * O provider é consultado UM cliente por chamada — não existe lote na interface
 * (`ERPDiagnosticsCapability.fetchCustomerConnectivity` recebe um `ref`) —,
 * então a única alavanca de vazão é a concorrência. Seis é deliberadamente
 * modesto: o deadline de cada chamada é 8 s, e um ERP de provedor pequeno não
 * é um serviço elástico. Subir isso é decisão de operação, medida contra o
 * provider real, não um número a chutar.
 */
export const CONNECTIVITY_REFRESH_CONCURRENCY = 6;

/** Teto por execução, para o comando terminar e o cron poder repetir. */
export const CONNECTIVITY_REFRESH_BATCH_LIMIT = 300;

export interface ConnectivityCycleResult {
  /** Conexões ativas encontradas, antes do corte por frescor. */
  connectionsScanned: number;
  /** Quantas estavam com a verificação vencida — o trabalho do ciclo. */
  eligible: number;
  /** Quantas foram efetivamente consultadas nesta execução. */
  processed: number;
  online: number;
  offline: number;
  unknown: number;
  /** Provider recusou, caiu ou estourou o prazo. Nada foi escrito. */
  providerFailures: number;
  /** Empresas cujo ERP não oferece diagnóstico — descobertas uma vez por ciclo. */
  skippedCompanies: number;
  /** Clientes que outro ciclo já tinha reservado. Trabalho dele, não perdido. */
  claimedByOther: number;
  durationMs: number;
}

interface ConexaoElegivel {
  companyId: string;
  customerId: string;
  /**
   * Já existe snapshot deste cliente?
   *
   * Só quem tem linha pode ser RESERVADO — a reserva mora nela. Quem nunca foi
   * verificado não tem onde ser reservado, e é o único caso em que dois ciclos
   * simultâneos podem consultar o mesmo cliente. É uma vez por cliente, na
   * primeira volta da vida dele, e o banco continua coerente porque a escrita é
   * monotônica. A alternativa seria inventar uma linha com um estado que
   * ninguém observou, só para ter onde travar.
   */
  hasSnapshot: boolean;
}

/**
 * Por quanto tempo um cliente fica reservado para o ciclo que o pegou.
 *
 * Maior que o deadline de uma chamada ao provider (8 s) com folga, e muito
 * menor que o alvo de 5 minutos: um processo morto no meio do ciclo devolve o
 * cliente à fila antes da volta seguinte, em vez de trancá-lo.
 */
export const CONNECTIVITY_REFRESH_LEASE_MS = 60_000;

/**
 * Reivindica o cliente para ESTE ciclo. `true` = pode consultar o provider.
 *
 * O predicado do `where` é o mesmo que decide a elegibilidade da reserva, e é
 * isso que torna a operação um compare-and-set: o banco serializa o `UPDATE`,
 * quem casa uma linha ganha, quem casa zero desiste sem chamar ninguém. Igual à
 * reivindicação de evento do outbox — nenhum mecanismo novo.
 */
export async function claimCustomerForCheck(
  companyId: string,
  customerId: string,
  now: Date,
  leaseMs: number = CONNECTIVITY_REFRESH_LEASE_MS,
): Promise<boolean> {
  const reivindicado = await prisma.customerDiagnosticSnapshot.updateMany({
    where: {
      companyId,
      customerId,
      OR: [{ refreshLeaseUntil: null }, { refreshLeaseUntil: { lte: now } }],
    },
    data: { refreshLeaseUntil: new Date(now.getTime() + leaseMs) },
  });
  return reivindicado.count > 0;
}

/**
 * Quanto tempo a transição da PRIMEIRA verificação pode durar.
 *
 * Folga sobre o deadline de uma chamada ao provider (8 s). Se a chamada estourar
 * o prazo dela, o domínio já devolveu erro muito antes disto.
 */
const FIRST_CHECK_LOCK_TIMEOUT_MS = 20_000;
/** Espera por uma conexão do pool antes de desistir da arbitragem. */
const FIRST_CHECK_LOCK_MAX_WAIT_MS = 10_000;

/**
 * A PRIMEIRA verificação da vida de um cliente, sob exclusão mútua.
 *
 * ## O buraco que isto fecha
 *
 * A reserva de `claimCustomerForCheck` mora no snapshot. Quem nunca foi
 * verificado não tem snapshot, logo não tinha onde ser reservado — e dois ciclos
 * simultâneos chamavam o provider duas vezes para o mesmo cliente. Medido:
 * `processed=1` nos dois ciclos, **duas** chamadas, um snapshot. O banco ficava
 * coerente, e é por isso que nenhuma asserção sobre estado final via o defeito.
 *
 * ## Por que um lock do Postgres, e não uma coluna nova
 *
 * Não existe linha onde gravar a reserva, e **fabricar uma seria pior**: um
 * snapshot criado só para ter onde travar afirmaria uma observação que não
 * aconteceu, e `CustomerDiagnosticSnapshot` significa "isto foi observado".
 *
 * `IdempotencyRecord` foi avaliada e não serve: exige `userId` não-nulo (o ciclo
 * não tem sessão) e memoriza o sucesso para replay — o oposto do que uma
 * verificação periódica quer.
 *
 * O advisory lock é o mecanismo que o Postgres já oferece e que este
 * repositório já usa (`lockStock`, em `inventory.ts`). A variante **`xact`** é
 * deliberada: ela é liberada no commit e na queda da conexão, então um ciclo que
 * morra no meio não deixa ninguém trancado — sem prazo, sem expiração, sem
 * estado preso. É também a variante que sobrevive a pooler em modo transação,
 * ao contrário do lock de sessão.
 *
 * ## O preço, declarado
 *
 * A transação fica aberta durante a chamada ao provider — no máximo o deadline
 * dela. Isso vale **só para a primeira verificação de cada cliente**, que
 * acontece uma vez na vida dele; do segundo ciclo em diante existe snapshot e a
 * reserva por coluna assume, sem segurar transação nenhuma. `try` e não `lock`:
 * quem perde a disputa volta na hora e segue para o próximo, sem bloquear.
 */
export async function withFirstCheckLock<T>(
  companyId: string,
  customerId: string,
  trabalho: () => Promise<T>,
): Promise<{ obtido: boolean; resultado?: T }> {
  return prisma.$transaction(
    async (tx) => {
      const linhas = await tx.$queryRaw<Array<{ obtido: boolean }>>`
        SELECT pg_try_advisory_xact_lock(
          hashtext(${companyId}),
          hashtext(${`primeira-verificacao:${customerId}`})
        ) AS obtido
      `;
      if (!linhas[0]?.obtido) return { obtido: false };

      /*
        Reconferência DENTRO do lock: o ciclo que ganhou a disputa anterior pode
        ter acabado de gravar a primeira leitura. Sem isto, o segundo a entrar
        consultaria o provider por um cliente que já tem snapshot — trocando uma
        corrida por uma chamada desnecessária.
      */
      const jaTem = await tx.customerDiagnosticSnapshot.count({
        where: { companyId, customerId },
      });
      if (jaTem > 0) return { obtido: false };

      return { obtido: true, resultado: await trabalho() };
    },
    {
      timeout: FIRST_CHECK_LOCK_TIMEOUT_MS,
      maxWait: FIRST_CHECK_LOCK_MAX_WAIT_MS,
    },
  );
}

/**
 * As conexões ativas cuja verificação venceu.
 *
 * Duas consultas, e nunca uma por cliente: uma traz os vínculos ativos, outra
 * traz a última leitura de cada um deles. O corte por frescor acontece em
 * memória sobre esses dois conjuntos, porque a "última leitura" é o máximo de
 * `observedAt` entre providers e não se expressa como um `where` simples sem
 * subconsulta.
 */
export async function findConnectionsDueForCheck(
  now: Date,
  targetMs: number = CONNECTIVITY_REFRESH_TARGET_MS,
  limit: number = CONNECTIVITY_REFRESH_BATCH_LIMIT,
): Promise<{ scanned: number; due: ConexaoElegivel[] }> {
  /*
    Conexão ATIVA é `disconnectedAt: null` — a mesma regra do índice parcial
    que garante um cliente por porta. Vínculo encerrado é história, e história
    não se reconsulta.
  */
  const vinculos = await prisma.customerNetworkConnection.findMany({
    where: { disconnectedAt: null },
    select: { companyId: true, customerId: true },
  });

  if (vinculos.length === 0) return { scanned: 0, due: [] };

  /*
    A última leitura de cada cliente, numa consulta só.

    `observedAt desc` mais "a primeira de cada cliente vence" é a MESMA regra de
    desempate das leituras do mapa e do painel (`latestPerCustomer`): uma
    empresa que trocou de ERP tem uma linha por provider, e vale a mais recente.
  */
  const leituras = await prisma.customerDiagnosticSnapshot.findMany({
    where: { customerId: { in: vinculos.map((v) => v.customerId) } },
    select: { companyId: true, customerId: true, observedAt: true },
    orderBy: { observedAt: "desc" },
  });

  const ultima = new Map<string, Date>();
  for (const linha of leituras) {
    const chave = `${linha.companyId}:${linha.customerId}`;
    if (!ultima.has(chave)) ultima.set(chave, linha.observedAt);
  }

  const corte = new Date(now.getTime() - targetMs);
  const due: ConexaoElegivel[] = [];
  for (const vinculo of vinculos) {
    const vista = ultima.get(`${vinculo.companyId}:${vinculo.customerId}`);
    /*
      Nunca verificado entra: é o caso mais urgente, não o menos — um cliente
      ligado sobre o qual não se sabe nada.
    */
    if (!vista || vista <= corte) {
      due.push({ ...vinculo, hasSnapshot: vista !== undefined });
    }
    if (due.length >= limit) break;
  }

  return { scanned: vinculos.length, due };
}

/**
 * Uma volta do ciclo.
 *
 * Devolve contagens, e só contagens: nome de cliente, documento e coordenada
 * não entram aqui nem no log de quem chama.
 */
export async function runConnectivityRefreshCycle(options: {
  now?: Date;
  targetMs?: number;
  limit?: number;
  concurrency?: number;
  leaseMs?: number;
} = {}): Promise<ConnectivityCycleResult> {
  const now = options.now ?? new Date();
  const leaseMs = options.leaseMs ?? CONNECTIVITY_REFRESH_LEASE_MS;
  const comeco = Date.now();
  const { scanned, due } = await findConnectionsDueForCheck(
    now,
    options.targetMs ?? CONNECTIVITY_REFRESH_TARGET_MS,
    options.limit ?? CONNECTIVITY_REFRESH_BATCH_LIMIT,
  );

  const resultado: ConnectivityCycleResult = {
    connectionsScanned: scanned,
    eligible: due.length,
    processed: 0,
    online: 0,
    offline: 0,
    unknown: 0,
    providerFailures: 0,
    skippedCompanies: 0,
    claimedByOther: 0,
    durationMs: 0,
  };

  /*
    Empresa cujo ERP não faz diagnóstico é descoberta UMA vez.

    Sem esta memória, uma empresa com trezentos clientes e um provider sem a
    capability produziria trezentas tentativas idênticas por ciclo — todas
    falhando pelo mesmo motivo, todas contadas como falha de provider. O que a
    contagem diz é "esta empresa foi pulada", que é o fato.
  */
  const semDiagnostico = new Set<string>();

  /*
    Concorrência limitada por um ponteiro compartilhado: N trabalhadores puxam
    da mesma fila até ela acabar. É o distribuidor mais simples que existe e
    evita a rajada — o oposto de disparar as trezentas de uma vez.
  */
  let proximo = 0;
  async function trabalhar(): Promise<void> {
    for (;;) {
      const indice = proximo;
      proximo += 1;
      if (indice >= due.length) return;
      const alvo = due[indice];
      if (semDiagnostico.has(alvo.companyId)) continue;

      /*
        A RESERVA vem antes da chamada externa.

        Sem ela, dois ciclos disparados juntos consultam a lista inteira cada um
        — medido: seis conexões, doze chamadas ao provider. Quem não reivindica
        não consulta, e não conta como processado: o trabalho é de outro ciclo,
        não trabalho perdido.
      */
      const verificar = () =>
        refreshCustomerDiagnostic(alvo.companyId, null, alvo.customerId, {
          audit: false,
        });

      /*
        DUAS arbitragens, porque as duas situações são diferentes.

        Com snapshot: a reserva mora na linha e não segura transação nenhuma —
        é o caso de regime, o que roda a cada cinco minutos para a carteira
        inteira.

        Sem snapshot: não há linha onde reservar, e o advisory lock do Postgres
        arbitra a primeira verificação da vida do cliente. Acontece uma vez por
        cliente.
      */
      let r;
      if (alvo.hasSnapshot) {
        const meu = await claimCustomerForCheck(
          alvo.companyId,
          alvo.customerId,
          now,
          leaseMs,
        );
        if (!meu) {
          resultado.claimedByOther += 1;
          continue;
        }
        r = await verificar();
      } else {
        const arbitragem = await withFirstCheckLock(
          alvo.companyId,
          alvo.customerId,
          verificar,
        );
        if (!arbitragem.obtido || !arbitragem.resultado) {
          resultado.claimedByOther += 1;
          continue;
        }
        r = arbitragem.resultado;
      }
      resultado.processed += 1;

      if (!r.ok) {
        if (r.errorCode === "NOT_SUPPORTED") {
          semDiagnostico.add(alvo.companyId);
        } else {
          resultado.providerFailures += 1;
        }
        continue;
      }

      /*
        O estado só é contado quando a verificação DEU CERTO. Contar o snapshot
        anterior numa falha faria o log dizer que o cliente foi conferido e está
        online, quando ninguém conseguiu conferir nada.
      */
      switch (r.snapshot?.connectivityStatus) {
        case "ONLINE":
          resultado.online += 1;
          break;
        case "OFFLINE":
          resultado.offline += 1;
          break;
        default:
          resultado.unknown += 1;
      }
    }
  }

  const trabalhadores = Math.max(
    1,
    Math.min(
      options.concurrency ?? CONNECTIVITY_REFRESH_CONCURRENCY,
      due.length || 1,
    ),
  );
  await Promise.all(Array.from({ length: trabalhadores }, () => trabalhar()));

  /*
    Empresas, não tentativas. Com concorrência, a primeira onda inteira pode
    bater na mesma empresa antes de qualquer resposta chegar — contar tentativas
    diria "três empresas puladas" onde existe uma.
  */
  resultado.skippedCompanies = semDiagnostico.size;
  resultado.durationMs = Date.now() - comeco;
  return resultado;
}

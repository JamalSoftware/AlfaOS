import { createHash } from "node:crypto";
import { prisma } from "./prisma";
import { refreshCustomerDiagnostic } from "./customer-diagnostics";
import { resolveConnectivityPolicy } from "./connectivity-policy";
import { readIntegerSetting } from "./env";

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
 * **Consequência declarada:** a cadência depende de alguém agendar o comando.
 * Sem isso, nada se atualiza sozinho — e a tela avisa, porque a verificação
 * envelhece e o aviso "Leitura desatualizada" aparece.
 *
 * ## A cadência: tick de 1 minuto, alvo de 5 (`RC-1F-A`, contrato PLANEJADO)
 *
 * O alvo (5 min) e o tick do agendador são grandezas diferentes. Com tick igual
 * ao alvo, quem foi verificado segundos depois do disparo ainda não venceu no
 * disparo seguinte, e a revisita real ficava em ~10 min, na borda do aviso
 * (`DIAG-CADENCE-01`, provado por sonda). O tick é de 1 minuto: ele NÃO consulta
 * cada cliente a cada minuto — quem está dentro do alvo não é elegível, e quem a
 * lista trouxe mas outro ciclo acabou de verificar é descartado na reserva. A
 * revisita fica entre 5 e 6 min.
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
 * Quem nunca foi verificado não tem linha onde ser reservado: a primeira
 * verificação é arbitrada por advisory lock (`withFirstCheckLock`). E a lista
 * envelhece durante a volta, então a reserva, depois de obtida, confere de novo
 * se a leitura já está dentro do alvo (`DIAG-OVERLAP-01`).
 */

/**
 * O alvo vem da política, resolvida NA CHAMADA e não na carga do módulo: um
 * `DIAGNOSTICS_REFRESH_TARGET_MS` inválido derrubava o `import`, antes de o
 * comando conseguir dizer qual variável estava errada (`RC-1F-A`).
 */
function alvoDaPolitica(): number {
  return resolveConnectivityPolicy().refreshTargetMs;
}

/**
 * Quantas verificações correm ao mesmo tempo.
 *
 * O provider é consultado UM cliente por verificação — não existe lote na
 * interface (`ERPDiagnosticsCapability.fetchCustomerConnectivity` recebe um
 * `ref`) —, então a única alavanca de vazão é a concorrência. Quantas
 * requisições HTTP uma verificação custa é do adapter: no ReceitaNet são até
 * DUAS (`verificar-acesso` e `/v1/cliente`, a segunda best-effort), e a conta
 * de capacidade precisa contar as duas (`DIAG-CALLS-01`). Seis é deliberadamente
 * modesto: o deadline de cada chamada é 8 s, e um ERP de provedor pequeno não
 * é um serviço elástico. Subir isso é decisão de operação, medida contra o
 * provider real, não um número a chutar.
 */
export const CONNECTIVITY_REFRESH_CONCURRENCY = 6;

/** Teto de tentativas por execução, para o comando terminar e o cron poder repetir. */
export const CONNECTIVITY_REFRESH_BATCH_LIMIT = 300;

/**
 * Teto e concorrência da volta, lidos do ambiente (`ENV-01`, `RC-1F-A`).
 *
 * A regra da `RC-SEC-01`: AUSENTE usa o padrão; PRESENTE e inválido derruba a
 * subida. Só inteiro positivo — `6.5`, `1e6`, `Infinity` e zero passavam
 * pelo `Number()` de antes. **Sem teto superior**: um valor máximo seguro
 * depende da capacidade do provider real, que não foi medida, e escolhê-lo aqui
 * seria decisão do dono tomada no escuro.
 */
export function readConnectivityRunSettings(
  env: Record<string, string | undefined> = process.env,
): { limit: number; concurrency: number } {
  const inteiroPositivo = { min: 1, max: Number.MAX_SAFE_INTEGER };
  return {
    limit: readIntegerSetting(
      "DIAGNOSTICS_REFRESH_BATCH_LIMIT",
      env.DIAGNOSTICS_REFRESH_BATCH_LIMIT,
      CONNECTIVITY_REFRESH_BATCH_LIMIT,
      inteiroPositivo,
    ),
    concurrency: readIntegerSetting(
      "DIAGNOSTICS_REFRESH_CONCURRENCY",
      env.DIAGNOSTICS_REFRESH_CONCURRENCY,
      CONNECTIVITY_REFRESH_CONCURRENCY,
      inteiroPositivo,
    ),
  };
}

export interface ConnectivityCycleResult {
  /** Conexões ativas encontradas, antes do corte por frescor. */
  connectionsScanned: number;
  /** Quantas estavam com a verificação vencida — o trabalho do ciclo. */
  eligible: number;
  /**
   * Quantas verificações chegaram ao provider nesta execução — é o que o teto
   * conta. Não entram: reservado por outro, recém-verificado, empresa sem
   * diagnóstico.
   */
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
  /**
   * Vieram na lista, mas outro ciclo os verificou depois dela: descartados na
   * reserva, sem chamar ninguém (`DIAG-OVERLAP-01`).
   */
  skippedFresh: number;
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
 * A leitura mais nova do cliente é posterior ao corte?
 *
 * É a mesma pergunta da seleção ("a última verificação venceu?"), feita de novo
 * NO MOMENTO da reserva — porque a lista da seleção envelhece durante a volta.
 * Qualquer linha do cliente acima do corte basta: a "última leitura" é o máximo
 * de `observedAt` entre providers, a mesma regra de `latestPerCustomer`.
 */
async function verificadoDepoisDe(
  companyId: string,
  customerId: string,
  corte: Date,
): Promise<boolean> {
  const recente = await prisma.customerDiagnosticSnapshot.findFirst({
    where: { companyId, customerId, observedAt: { gt: corte } },
    select: { customerId: true },
  });
  return recente !== null;
}

/** Posição sorteada por volta: mesma entrada, mesma posição; outra volta, outra. */
function sorteio(companyId: string, customerId: string, now: Date): number {
  return createHash("sha256")
    .update(`${now.getTime()}:${companyId}:${customerId}`)
    .digest()
    .readUInt32BE(0);
}

/**
 * As conexões ativas cuja verificação venceu, NA ORDEM EM QUE DEVEM SER TENTADAS.
 *
 * Duas consultas, e nunca uma por cliente: uma traz os vínculos ativos, outra
 * traz as leituras de cada um deles. O corte por frescor acontece em memória
 * sobre esses dois conjuntos, porque a "última leitura" é o máximo de
 * `observedAt` entre providers e não se expressa como um `where` simples sem
 * subconsulta.
 *
 * ## A ordem é parte do contrato (`DIAG-STARV-01`, `RC-1F-A`)
 *
 * Falha de provider não escreve nada — é essa regra que impede um `OFFLINE`
 * inventado —, então quem falha sempre continua vencido para sempre. Com a lista
 * na ordem física da tabela e cortada no teto, quem falhava ocupava todas as
 * voltas e os saudáveis atrás dele nunca eram consultados (provado por sonda:
 * teto 1, o saudável não foi visitado em quatro voltas). Agora são duas filas,
 * intercaladas:
 *
 * ```text
 * com leitura   a tentada há MAIS tempo primeiro. A tentativa já está gravada:
 *               a reserva carimba refreshLeaseUntil e ninguém o apaga, então
 *               ele data a última tentativa, tenha ela dado certo ou não. Quem
 *               nunca foi reservado vem antes. Nenhuma coluna nova, e a reserva
 *               continua significando só "reservado até".
 * sem leitura   sorteada POR VOLTA. Aqui não há onde registrar a tentativa — e
 *               fabricar um snapshot para isso está proibido —, então nenhuma
 *               posição é fixa: a cada volta, cada cliente tem a mesma chance.
 * ```
 *
 * A intercalação começa por quem nunca foi verificado (o caso mais urgente) e
 * impede que qualquer uma das duas filas tome o teto inteiro.
 *
 * `limit` só corta a LISTA. O ciclo não o usa: o teto dele conta tentativas que
 * chegam ao provider (ver `runConnectivityRefreshCycle`).
 */
export async function findConnectionsDueForCheck(
  now: Date,
  targetMs: number = alvoDaPolitica(),
  limit: number = Number.POSITIVE_INFINITY,
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
    As leituras de cada cliente, numa consulta só.

    `observedAt desc` mais "a primeira de cada cliente vence" é a MESMA regra de
    desempate das leituras do mapa e do painel (`latestPerCustomer`): uma
    empresa que trocou de ERP tem uma linha por provider, e vale a mais recente.
    A reserva é gravada em todas as linhas do cliente, então a tentativa é a
    maior entre elas.
  */
  const leituras = await prisma.customerDiagnosticSnapshot.findMany({
    where: { customerId: { in: vinculos.map((v) => v.customerId) } },
    select: {
      companyId: true,
      customerId: true,
      observedAt: true,
      refreshLeaseUntil: true,
    },
    orderBy: { observedAt: "desc" },
  });

  const ultima = new Map<string, { observedAt: Date; tentativa: Date | null }>();
  for (const linha of leituras) {
    const chave = `${linha.companyId}:${linha.customerId}`;
    const atual = ultima.get(chave);
    if (!atual) {
      ultima.set(chave, {
        observedAt: linha.observedAt,
        tentativa: linha.refreshLeaseUntil,
      });
    } else if (
      linha.refreshLeaseUntil &&
      (!atual.tentativa || linha.refreshLeaseUntil > atual.tentativa)
    ) {
      atual.tentativa = linha.refreshLeaseUntil;
    }
  }

  const corte = now.getTime() - targetMs;
  const comLeitura: Array<ConexaoElegivel & { tentativa: number; vista: number }> = [];
  const semLeitura: Array<ConexaoElegivel & { posicao: number }> = [];
  for (const vinculo of vinculos) {
    const vista = ultima.get(`${vinculo.companyId}:${vinculo.customerId}`);
    /*
      Nunca verificado entra: é o caso mais urgente, não o menos — um cliente
      ligado sobre o qual não se sabe nada.
    */
    if (!vista) {
      semLeitura.push({
        ...vinculo,
        hasSnapshot: false,
        posicao: sorteio(vinculo.companyId, vinculo.customerId, now),
      });
    } else if (vista.observedAt.getTime() <= corte) {
      comLeitura.push({
        ...vinculo,
        hasSnapshot: true,
        tentativa: vista.tentativa?.getTime() ?? Number.NEGATIVE_INFINITY,
        vista: vista.observedAt.getTime(),
      });
    }
  }

  const desempate = (a: ConexaoElegivel, b: ConexaoElegivel) =>
    a.customerId < b.customerId ? -1 : a.customerId > b.customerId ? 1 : 0;
  comLeitura.sort((a, b) =>
    a.tentativa !== b.tentativa
      ? a.tentativa < b.tentativa ? -1 : 1
      : a.vista !== b.vista
        ? a.vista - b.vista
        : desempate(a, b),
  );
  semLeitura.sort((a, b) => a.posicao - b.posicao || desempate(a, b));

  const due: ConexaoElegivel[] = [];
  for (let i = 0; due.length < limit && (i < semLeitura.length || i < comLeitura.length); i += 1) {
    for (const fila of [semLeitura, comLeitura]) {
      const item = fila[i];
      if (item && due.length < limit) {
        due.push({
          companyId: item.companyId,
          customerId: item.customerId,
          hasSnapshot: item.hasSnapshot,
        });
      }
    }
  }

  return { scanned: vinculos.length, due };
}

/**
 * Uma volta do ciclo.
 *
 * Devolve contagens, e só contagens: nome de cliente, documento e coordenada
 * não entram aqui nem no log de quem chama.
 *
 * ## O teto conta TENTATIVAS, não candidatos
 *
 * `limit` é o número de verificações que podem chegar ao provider nesta volta.
 * Quem não chega lá devolve a vaga: reservado por outro ciclo, verificado há
 * pouco (a lista envelheceu) ou de empresa cujo ERP não faz diagnóstico. Antes,
 * o teto cortava a lista, e uma empresa sem diagnóstico com clientes ligados
 * consumia a volta inteira sem ninguém ser consultado.
 */
export async function runConnectivityRefreshCycle(options: {
  now?: Date;
  targetMs?: number;
  limit?: number;
  concurrency?: number;
  leaseMs?: number;
  /** Prazo por verificação. Ausente, o `DIAGNOSTIC_TIMEOUT_MS` de sempre. */
  timeoutMs?: number;
} = {}): Promise<ConnectivityCycleResult> {
  const now = options.now ?? new Date();
  const leaseMs = options.leaseMs ?? CONNECTIVITY_REFRESH_LEASE_MS;
  const targetMs = options.targetMs ?? alvoDaPolitica();
  const teto = options.limit ?? CONNECTIVITY_REFRESH_BATCH_LIMIT;
  const corte = new Date(now.getTime() - targetMs);
  const comeco = Date.now();
  const { scanned, due } = await findConnectionsDueForCheck(now, targetMs);

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
    skippedFresh: 0,
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

    `emUso` são as vagas do teto. A vaga é tomada ANTES da reserva (JavaScript
    não troca de trabalhador entre a conferência e o incremento) e devolvida
    quando a tentativa não chega ao provider. Um trabalhador que encontra o teto
    cheio sai; quem devolve uma vaga continua e a usa.
  */
  let proximo = 0;
  let emUso = 0;
  async function trabalhar(): Promise<void> {
    for (;;) {
      if (emUso >= teto) return;
      const indice = proximo;
      proximo += 1;
      if (indice >= due.length) return;
      const alvo = due[indice];
      if (semDiagnostico.has(alvo.companyId)) continue;
      emUso += 1;

      const verificar = () =>
        refreshCustomerDiagnostic(alvo.companyId, null, alvo.customerId, {
          audit: false,
          timeoutMs: options.timeoutMs,
        });

      /*
        DUAS arbitragens, porque as duas situações são diferentes.

        Com snapshot: a reserva mora na linha e não segura transação nenhuma —
        é o caso de regime, o que roda a cada volta para a carteira inteira.

        Sem snapshot: não há linha onde reservar, e o advisory lock do Postgres
        arbitra a primeira verificação da vida do cliente. Acontece uma vez por
        cliente, e dentro do lock a existência de leitura é conferida de novo.
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
          emUso -= 1;
          resultado.claimedByOther += 1;
          continue;
        }
        /*
          A SELEÇÃO NÃO É A AUTORIDADE FINAL (`DIAG-OVERLAP-01`, `RC-1F-A`).

          A lista foi lida no começo da volta. Numa volta longa — ou com o tick
          de 1 minuto sobrepondo voltas —, outro ciclo pode ter verificado este
          cliente depois da leitura, e a reserva dele vence em 60 s. Conferir só
          a reserva repetia a chamada (provado por sonda: duas chamadas para um
          cliente verificado segundos antes). Com a reserva na mão, a pergunta
          da seleção é feita de novo contra o banco de agora; se a leitura já
          está dentro do alvo, ninguém é chamado.
        */
        if (await verificadoDepoisDe(alvo.companyId, alvo.customerId, corte)) {
          emUso -= 1;
          resultado.skippedFresh += 1;
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
          emUso -= 1;
          resultado.claimedByOther += 1;
          continue;
        }
        r = arbitragem.resultado;
      }

      if (!r.ok && r.errorCode === "NOT_SUPPORTED") {
        // Ninguém foi chamado: a vaga volta para quem pode ser consultado.
        semDiagnostico.add(alvo.companyId);
        emUso -= 1;
        continue;
      }
      resultado.processed += 1;

      if (!r.ok) {
        resultado.providerFailures += 1;
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

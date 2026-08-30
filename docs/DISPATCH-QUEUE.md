# AlfaOS — Fila Operacional de OS: plano de implementação

Plano fechado da capability especificada no PRD **Parte XII (§308–§332)**.
Mora aqui, e não no PRD, pelo mesmo motivo que `FIELD-API.md` e
`SERVICE-ORDER-CLOSING.md` moram fora dele: o PRD é **visão de produto**, e
sequência de transação, tabela de endpoint e matriz de teste são engenharia.
As decisões de produto (`D-01`–`D-11`) continuam registradas no PRD, onde
foram levantadas; aqui está como executá-las.

> **Nada disto existe em código.** Nenhuma migration, nenhuma rota, nenhuma
> tela. Este documento é o que a fase de implementação executa.

---

## 1. As onze decisões — todas fechadas

| # | Pergunta original (PRD) | Decisão aprovada | Status | Impacto |
|---|---|---|---|---|
| **D-01** | Onde ficam `LOW` e `HIGH` numa fila de dois blocos? | Não há fila de dois blocos. **Quatro bandas**, precedência `URGENT > HIGH > NORMAL > LOW`. | `RESOLVED` | Normalização opera sobre 4 bandas; `LOW`/`HIGH` não perdem semântica |
| **D-02** | O colapso é de apresentação ou de domínio? | **Apresentação, e apenas na ação rápida.** O enum fica intacto; o dispatcher ganha um atalho `Normal ↔ Urgente` porque é o fluxo dominante, mais o seletor completo. | `RESOLVED` | Zero migration de enum. Nenhum dado existente reinterpretado |
| **D-03** | Onde mora a regra de colapso? | Não existe regra de colapso a hospedar. O que existe é o **mapa de precedência**, e ele mora no domínio (§4 deste plano), fonte única para Web, Field e normalização. | `RESOLVED` | Elimina a dependência da ordem de declaração do enum |
| **D-04** | A OS promovida entra em que ponto do bloco? | **Fim da banda de destino**, salvo alvo absoluto explícito na mesma operação. | `RESOLVED` | Não altera a ordem relativa de nenhuma outra OS |
| **D-05** | Ao rebaixar, entra onde? | **Fim da banda de destino.** Simétrico a `D-04`. | `RESOLVED` | Uma regra só para os dois sentidos |
| **D-06** | Posição de OS que saiu: liberada ou preservada? | **Liberada.** A entrada é removida e a fila renormalizada. O histórico vive no `AuditLog`, não numa posição órfã. | `RESOLVED` | Consequência direta da Opção B: não há valor sobrevivente para virar lixo |
| **D-07** | Qual unidade de concorrência? | **As duas primeiras, juntas:** `TechnicianDispatchQueue.version` como CAS de leitura→escrita, mais `FOR UPDATE` na linha da fila para serializar a transação. A terceira (unique em `position`) entra como rede de segurança, não como árbitro. | `RESOLVED` | §5 e §8 deste plano |
| **D-08** | Limitar a uma `IN_PROGRESS` por técnico? | **Não, e não nesta feature.** Continua permitido; a fila representa N em atendimento sem perda. Endurecer é decisão da máquina de estados (§20 do PRD), em trabalho separado. | `RESOLVED` | Nenhuma trava nova. Nenhum dado existente invalidado |
| **D-09** | Forma curta ou longa no evento de timeline? | **Forma curta**: `PRIORITY_CHANGED`, `DISPATCH_POSITION_CHANGED`. Registrada aqui, e é a convenção para eventos operacionais novos. | `RESOLVED` | Não aprofunda a convenção mista existente |
| **D-10** | O que é "mudança significativa" para notificar? | **Só a transição para a 1ª posição**, e só quando o ocupante da 1ª mudou de fato. Deslocamento por normalização nunca notifica. | `RESOLVED` | Mover uma OS de 5 para 1 produz **um** evento, não cinco |
| **D-11** | Posição global ou por grupo? | **Opção B (agregado próprio) + posição GLOBAL normalizada.** | `RESOLVED`, com custo declarado abaixo | Ver o parágrafo seguinte |

### O custo de `D-11`, declarado e não escondido

O PRD registrou que **Opção B + posição por grupo** era a única combinação em
que `I-11` (sem posição duplicada) e `I-12` (urgente antes de normal) ficavam
garantidas **pelo banco**. A decisão aprovada é posição **global**, porque a
fila que o usuário vê é única (1, 2, 3, 4) e guardar o que se apresenta evita
uma numeração que não existe em lugar nenhum.

A consequência é real e precisa estar escrita:

```text
I-11  continua garantida pelo banco
      unique (queueId, position)

I-12  deixa de ser estrutural e vira INVARIANTE DE APLICAÇÃO
      reestabelecida pela normalização, dentro de toda transação que
      escreve a fila
```

> **`I-12` sem estrutura só é verdade enquanto houver teste.** É a única
> invariante desta capability que o banco não defende sozinho, e por isso ela
> tem teste dedicado com prova de reversão (§14, `T-C4`).

---

## 2. Schema proposto — conceitual

`NÃO criar migration.` Proposta para a fase `DQ-1`, seguindo as convenções do
`schema.prisma` atual (`@@map` snake_case plural, `cuid()`, `companyId` em toda
entidade de empresa, `version Int @default(0)`).

```prisma
/// A fila operacional de um técnico. Uma por (empresa, técnico), criada
/// preguiçosamente na primeira atribuição — nunca em massa no cadastro.
///
/// Existe como AGREGADO, e não como coluna em ServiceOrder, por um motivo
/// só: reordenar escreve N linhas, e `ServiceOrder.version` responde por
/// uma. Sem uma linha que represente a fila inteira não há o que travar
/// nem o que comparar (PRD §318).
model TechnicianDispatchQueue {
  id           String     @id @default(cuid())
  companyId    String
  company      Company    @relation(fields: [companyId], references: [id], onDelete: Cascade)
  technicianId String
  technician   Technician @relation(fields: [technicianId], references: [id], onDelete: Cascade)

  /// Token do compare-and-set da FILA. Incrementado em toda mutação que
  /// altere composição ou ordem — inclusive quando a OS que mudou não é a
  /// que o cliente estava olhando.
  version   Int      @default(0)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  entries TechnicianDispatchQueueEntry[]

  @@unique([companyId, technicianId])
  @@map("technician_dispatch_queues")
}

/// Uma OS ocupando uma posição na fila de um técnico.
///
/// `position` é GLOBAL e normalizada: 1..N contíguo, sem buraco. A banda de
/// prioridade não aparece aqui — ela é lida da própria ServiceOrder, que
/// continua sendo a dona de `priority` (PRD §309).
model TechnicianDispatchQueueEntry {
  id      String                  @id @default(cuid())
  queueId String
  queue   TechnicianDispatchQueue @relation(fields: [queueId], references: [id], onDelete: Cascade)

  serviceOrderId String       @unique
  serviceOrder   ServiceOrder @relation(fields: [serviceOrderId], references: [id], onDelete: Cascade)

  position  Int
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([queueId, position])
  @@index([queueId, position])
  @@map("technician_dispatch_queue_entries")
}
```

### As três restrições e o que cada uma impede

```text
@@unique([companyId, technicianId])   duas filas para o mesmo técnico
@@unique  serviceOrderId             a MESMA OS em duas filas ao mesmo tempo
@@unique([queueId, position])        I-11: duas OS na mesma posição
```

A unique em `serviceOrderId` (e não um índice comum) é o que torna a
reatribuição segura por construção: inserir em B antes de remover de A falha no
banco, em vez de produzir uma OS que aparece nas duas filas.

### `onDelete` proposto

```text
Company    → Queue     Cascade    empresa apagada leva a fila junto
Technician → Queue     Cascade    a fila não sobrevive ao dono
Queue      → Entry     Cascade    entrada não existe sem fila
ServiceOrder → Entry   Cascade    OS apagada não deixa entrada órfã
```

`Cascade` em `ServiceOrder → Entry` é seguro **porque a entrada não guarda
histórico**: o histórico está no `AuditLog`, que usa `SetNull` no usuário e
sobrevive. Se a entrada guardasse o "antes/depois", `Cascade` apagaria trilha.

### Por que agregado, e não `ServiceOrder.dispatchPosition`

| | Coluna na OS | Agregado próprio |
|---|---|---|
| Migration | mínima, 1 campo | 2 tabelas, backfill |
| Leitura | sem junção | junção em toda lista ordenada |
| Concorrência de reorder | **não tem** | `version` + `FOR UPDATE` na fila |
| `I-11` | unique parcial, convivendo com `technicianId` nulo | unique natural e total |
| Saída da fila | valor sobrevive e vira lixo (`D-06`) | entrada removida |
| Código | menos | mais serviço, mais teste |

O que decide não é a contagem de tabelas: é que **posição é propriedade do par
(técnico, OS)**, não da OS (PRD §309). Guardá-la na OS obriga a inventar o
significado de `dispatchPosition` numa OS sem técnico, e deixa a reordenação
sem nada para travar.

O custo é honesto: mais tabelas, mais transação, mais código, e uma junção em
caminhos de leitura que hoje não têm nenhuma.

---

## 3. Estados que podem ter entrada na fila

Confirmado contra a máquina de estados real (`ALLOWED_STATUS_TRANSITIONS`,
`src/lib/service-orders.ts`), não assumido:

```text
PENDING sem técnico    NÃO   não existe fila a que pertencer (PRD §311)
PENDING com técnico    N/A   a atribuição já move para ASSIGNED
ASSIGNED               SIM   é exatamente a fila de próximas
IN_PROGRESS            NÃO   seção EM ATENDIMENTO, fora da disputa (D-08)
COMPLETED              NÃO   terminal
CANCELLED              NÃO   terminal
```

### O achado que muda o plano de remoção

**`CANCELLED` é um estado declarado e inalcançável.** Não existe operação de
cancelamento no código: `status: "CANCELLED"` nunca é escrito, e `cancelledAt`
só aparece numa asserção de teste. **Desatribuição também não existe**:
`technicianId: null` só aparece em fixture.

Consequência prática: a superfície de remoção tem **três chamadas reais hoje**,
não seis.

```text
REAL, existe hoje
  startServiceOrder        ASSIGNED → IN_PROGRESS     src/lib/service-orders.ts
  completeServiceOrder     IN_PROGRESS → COMPLETED    src/lib/service-order-closing.ts
  assignTechnician         troca de técnico           src/lib/service-orders.ts

HOOK, para quando existir
  cancelamento
  desatribuição
```

Os dois últimos entram como **função do serviço de fila** (`removeFromQueue`),
chamada por quem implementar aquelas operações — não como caminho especulativo
escrito agora contra um estado que ninguém consegue produzir.

As três chamadas reais já rodam dentro de `prisma.$transaction`, o que significa
que o hook cabe na transação existente sem alargar boundary nenhum.

---

## 4. Precedência e normalização

### O mapa de precedência é do domínio

```ts
// Resolve D-03. Substitui a dependência da ordem de declaração do enum.
const DISPATCH_BAND: Record<ServiceOrderPriority, number> = {
  URGENT: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3,
};
```

> **Nenhum `orderBy: { priority: "desc" }` decide fila.** Hoje a ordem depende
> da ordem de declaração do enum em Postgres (PRD §310); reordenar as linhas do
> schema reordenaria a fila de todas as empresas em silêncio. Com o mapa
> explícito, a precedência é dado do domínio e o schema volta a ser só armazenamento.

Nota: `SERVICE_ORDER_PRIORITY_ORDER` já existe em `src/lib/service-orders.ts` e
é código morto, com a orientação **invertida** (`URGENT: 3`). `DQ-1` deve
decidir entre reaproveitá-la invertendo a leitura ou substituí-la — e **não
deixar as duas coexistirem**, que é como nasce a terceira definição.

### O algoritmo

Entrada: as entradas atuais da fila, a `priority` de cada OS, e no máximo uma
intenção (`serviceOrderId` + `targetPosition`).

```text
1. montar a lista atual em ordem de position
2. aplicar a intenção, se houver:
      remover a OS alvo da lista
      inseri-la no índice (targetPosition - 1), com clamp em [0, len]
3. ORDENAÇÃO ESTÁVEL por DISPATCH_BAND[priority]
      a ordem relativa dentro da banda é preservada — é o que faz a
      sequência do dispatcher sobreviver
4. reescrever position = 1..N na ordem resultante
```

O passo 3 é o que garante `I-12` sem precisar validar nada: uma `NORMAL` que o
dispatcher tentou colocar na posição 1 termina no topo da **sua** banda, e as
urgentes continuam à frente. **A operação não é recusada, é acomodada** — e a
resposta devolve a fila resultante, então a tela mostra onde a OS realmente
foi. Recusar seria pior: o dispatcher arrastou, o cartão voltou, e ele não sabe
por quê.

`clamp` em vez de erro para `targetPosition` fora de faixa: "mover para o fim"
digitado como 99 numa fila de 6 é intenção clara, e transformar isso em 400
seria pedantismo contra o operador.

### Escrita da renumeração

`@@unique([queueId, position])` recusa a renumeração ingênua: atualizar linha a
linha colide no meio do caminho. Três saídas, e `DQ-1` escolhe:

```text
A. deslocar para uma faixa negativa temporária, depois reescrever
B. DEFERRABLE INITIALLY DEFERRED na constraint (SQL cru na migration)
C. deletar as entradas da fila e recriar em bloco
```

Recomendada: **A**. É a única que não depende de constraint deferrable (que o
Prisma não modela e viveria só no SQL da migration) e não descarta `id` de
entrada a cada reorder — o que a **C** faria, e que tornaria inútil qualquer
referência futura a `TechnicianDispatchQueueEntry.id`.

---

## 5. Concorrência

### Ordem obrigatória dentro de toda mutação de fila

```text
1. autenticar; perfil ADMIN ou DISPATCHER
2. resolver companyId da SESSÃO
3. localizar/criar a fila do técnico
      createMany({ skipDuplicates: true })  — o padrão do Workday
4. SELECT ... FOR UPDATE na linha da fila
5. reler a fila SOB O LOCK
6. validar expectedQueueVersion contra o valor relido → 409 se divergir
7. validar membership: a OS pertence a esta fila, desta empresa
8. aplicar a intenção
9. normalizar (§4)
10. gravar posições
11. queue.version += 1
12. evento de timeline + AuditLog
13. commit
```

Os passos 4 e 6 respondem perguntas diferentes e **nenhum substitui o outro**:

```text
FOR UPDATE            serializa requisição → requisição
expectedQueueVersion  protege leitura → escrita
```

Sem o lock, duas transações leem a mesma fila e as duas passam no CAS antes de
qualquer commit. Sem o CAS, o lock só ordena as escritas — o dispatcher que
arrastou sobre uma tela de dez minutos atrás vence a decisão de quem acabou de
agir. É a mesma dupla que a Jornada usa (`lockWorkdayById` + `updateMany` com
predicado), e o PRD §204 já exige que a recusa seja visível.

### `ServiceOrder.version` continua existindo, e para outra coisa

A alteração de **prioridade** escreve na `ServiceOrder`, então ela usa
`expectedVersion` da OS **e** `expectedQueueVersion` da fila: são dois
agregados tocados, e cada um responde pelo seu. Reordenação pura não toca a OS
e usa só o da fila.

---

## 6. Nova atribuição

Estende `assignTechnician`, **dentro da transação que já existe** — sem caminho
paralelo (PRD §205, §317).

```text
... assignTechnician como é hoje ...
+ abrir/travar a fila do novo técnico
+ inserir no FIM DA BANDA de priority (D-01, D-09 do escopo)
+ normalizar
+ queue.version += 1
```

Uma `URGENT` nova entra no **fim das urgentes**, nunca à frente das que o
dispatcher já ordenou. Chegar depois não é ser mais importante.

**Reatribuição (A → B)** toca duas filas na mesma transação:

```text
travar as DUAS filas em ORDEM DETERMINÍSTICA — queue.id crescente
   sem isso, A→B e B→A simultâneos travam em ordem oposta e dão deadlock
remover de A · normalizar A · A.version += 1
inserir em B pela banda · normalizar B · B.version += 1
```

A unique em `serviceOrderId` é a rede: se a remoção falhar, a inserção não
acontece, e a transação inteira volta.

---

## 7. Alteração de prioridade

```text
autenticar; ADMIN ou DISPATCHER
carregar a OS por (id, companyId)                     — tenant em SQL
recusar se terminal
travar a fila do técnico (se houver técnico)
validar expectedVersion da OS e expectedQueueVersion da fila
priorityBefore := os.priority
UPDATE ... WHERE id = ? AND version = ?               — CAS da OS
recolocar no fim da banda nova (D-04/D-05) ou no target absoluto
normalizar
queue.version += 1
ServiceOrderEvent  PRIORITY_CHANGED   { before, after }
AuditLog           SERVICE_ORDER.PRIORITY_CHANGED
commit
```

Uma OS sem técnico muda de prioridade normalmente: só não há fila a normalizar.

---

## 8. Reordenação e o cenário obrigatório

Contrato: **alvo absoluto**. `moveUp` não existe na API (PRD §318 — delta
aplicado duas vezes move duas).

Entre as duas formas de alvo absoluto:

```text
targetPosition            { serviceOrderId, targetPosition }
orderedServiceOrderIds    a fila inteira, na ordem desejada
```

Recomendado: **`targetPosition`**. `orderedServiceOrderIds` parece mais
declarativo e é pior aqui: obriga o cliente a mandar uma fila que pode ter
mudado, transforma toda divergência em erro de lista inteira e, no Field ou num
tablet, cresce com o dia do técnico. `targetPosition` diz a intenção — "esta OS,
aqui" — e deixa o servidor decidir o resto, que é exatamente a divisão de
autoridade da PRD §313.

### O cenário que o plano precisa acertar

```text
A lê a fila            queueVersion 7
B lê a fila            queueVersion 7

A move X para 1        → passa o CAS → commit → queueVersion 8
B move Y para 1        expectedQueueVersion 7
                       → predicado casa ZERO linhas
                       → conflict("A fila foi alterada...")  → HTTP 409
                       → a tela de B recarrega e mostra a fila com X em 1
```

409 é a convenção já adotada: `conflict()` de `src/lib/errors.ts` na Web, e
`CONFLICT` (com `conflict: true` derivado) no contrato do Field. **Nenhum status
novo é inventado.**

---

## 9. Endpoints propostos

Convenções seguidas: ação explícita em subcaminho (`/assign`, `/start`),
`assertSameOrigin` + `assertProfile` na Web, `Bearer` no Field, zod `.strict()`,
`companyId` sempre da sessão.

| Método · rota | Perfil | Entrada | Saída | Idem. | CAS | Erros |
|---|---|---|---|---|---|---|
| `GET /api/dispatch/technicians/[technicianId]/queue` | ADMIN, DISPATCHER | — | `DispatchQueueDto` | — | — | 401 · 403 · 404 |
| `POST /api/service-orders/[id]/priority` | ADMIN, DISPATCHER | `priority`, `expectedVersion`, `expectedQueueVersion?`, `targetPosition?` | `DispatchQueueDto` | **sim** | OS + fila | 400 · 401 · 403 · 404 · 409 |
| `POST /api/dispatch/technicians/[technicianId]/queue/reorder` | ADMIN, DISPATCHER | `serviceOrderId`, `targetPosition`, `expectedQueueVersion` | `DispatchQueueDto` | **sim** | fila | 400 · 401 · 403 · 404 · 409 |
| `GET /api/field/v1/dispatch-queue` | técnico do token | — | `FieldDispatchQueueDto` | — | — | `UNAUTHENTICATED` · `FORBIDDEN` |

### Reatribuição: evoluir, não duplicar

`POST /api/service-orders/[id]/assign` **já existe** e já tem CSRF, perfil, zod
estrito e `expectedVersion`. Ela ganha o efeito de fila **dentro do serviço**,
e opcionalmente `targetPosition` no corpo. **Nenhuma rota nova de reatribuição.**

### O Field não recebe `?technicianId=`

Mesma escolha da rota de OS existente: o dono vem de `token → MobileDevice →
User → Technician`. Um parâmetro com esse nome seria ignorado, porque a
autorização não passa por nada que o cliente escreva.

### Retorno da fila inteira, e não `204`

Toda mutação devolve o `DispatchQueueDto` resultante. Uma renumeração muda N
linhas: devolver `204` obrigaria o cliente a um `GET` imediato, e entre os dois
cabe outra mutação — a tela pintaria um estado que nunca foi resultado de nada.

---

## 10. DTOs

```ts
interface DispatchQueueDto {
  technician: { id: string; name: string; active: boolean };
  version: number;                      // volta como expectedQueueVersion
  inProgress: DispatchQueueItemDto[];   // pode ter mais de um (D-08)
  queued: DispatchQueueItemDto[];       // position 1..N, contígua
}

interface DispatchQueueItemDto {
  serviceOrderId: string;
  number: number;
  status: ServiceOrderStatus;
  priority: ServiceOrderPriority;
  position: number | null;              // null em inProgress
  type: string;
  customerName: string;
  district: string | null;
  city: string | null;
  scheduledAt: string | null;
  version: number;                      // CAS da OS
}
```

O Field reusa `FieldServiceOrderListItem`, acrescido de `position`, e **mantém
as omissões deliberadas** de `src/lib/field/dto.ts`: sem `origin`, sem
`externalProvider`, sem `externalId`, sem `externalNumber`. A ausência do dado é
o que impede um `if (RECEITANET)` no aplicativo (PRD §257).

```text
nenhum campo de PII novo
nenhum companyId de ENTRADA — ele é derivado, nunca aceito
```

---

## 11. Web — `/despacho`

Slug em PT-BR, como `ordens`, `tecnicos`, `jornada`, `dispositivos`.

```text
seletor de técnico
EM ATENDIMENTO       (N cards, sem eleger um "verdadeiro")
PRÓXIMAS             1..N com ↑ ↓ · mover para · reatribuir
ação rápida          Normal ↔ Urgente
seletor completo     LOW · NORMAL · HIGH · URGENT
```

O seletor completo não é enfeite: `LOW` e `HIGH` existem em OS já gravadas
(`D-02`), e sem ele o dispatcher não teria como sair de um `HIGH` legado.

Conflito nunca sobrescreve em silêncio:

> "A fila foi alterada por outro usuário. Atualize e tente novamente."

Arrastar é UI (PRD §204): o gesto vira comando absoluto, e `↑ ↓` são caminho
principal em tablet, não plano B.

---

## 12. Field

```text
Início           ATENÇÃO AGORA passa a ler a ordem do backend
Minhas Ordens    EM ATENDIMENTO  +  PRÓXIMAS NA FILA (1ª, 2ª, 3ª)
```

`attention_ranking.dart` é solução transitória (PRD §314). O desligamento é
**por presença de dado**, não por versão de APK:

```text
resposta traz position   → ordena pelo servidor
resposta não traz        → ranking local (APK novo contra servidor antigo)
```

Isso mantém a convivência que a §192 exige e não deixa janela em que Web e
Field tenham autoridades diferentes **sem comportamento definido**: o
comportamento está definido nos dois ramos.

Offline exibe a última fila conhecida, marcada como tal, e **nunca** reordena
(PRD §328).

---

## 13. Backfill

Só `ASSIGNED`. `IN_PROGRESS`, `COMPLETED` e sem técnico não entram (§3).

Ordenação determinística, **sem depender da ordem implícita do banco**:

```text
1. DISPATCH_BAND[priority]      explícito, não o enum
2. scheduledAt ASC NULLS LAST   quem tem hora marcada primeiro
3. assignedAt ASC               quem está com o técnico há mais tempo
4. id ASC                       desempate que nunca empata
```

`assignedAt` como terceiro critério, e não `createdAt`: o campo existe, é
gravado na atribuição, e é o que descreve **há quanto tempo a OS está com este
técnico** — que é a pergunta da fila. `createdAt` responde há quanto tempo a OS
existe, que é outra coisa. `number` foi descartado por ser sequencial de
criação, portanto o mesmo critério de `createdAt` com outro nome.

`scheduledAt ASC NULLS LAST` preserva aproximadamente o que os técnicos já
viam, em vez de embaralhar o dia da virada.

O backfill roda **por (empresa, técnico)**, criando a fila e as entradas
numeradas 1..N. Idempotente por construção: `createMany skipDuplicates` na fila
e a unique em `serviceOrderId` nas entradas.

---

## 14. Matriz de testes

### Domínio e integração

```text
T-D1  DISPATCH_BAND ordena URGENT > HIGH > NORMAL > LOW
T-D2  normalização produz 1..N contíguo, sem buraco
T-D3  ordenação é ESTÁVEL: ordem dentro da banda sobrevive
T-D4  targetPosition fora de faixa sofre clamp, não erro
T-D5  NORMAL com target 1 termina no topo da banda NORMAL, não da fila
T-D6  reordenar não altera priority, origin, externalId nem scheduledAt

T-I1  atribuir insere no fim da banda
T-I2  atribuir URGENT não ultrapassa urgentes já ordenadas
T-I3  iniciar remove da fila e renormaliza
T-I4  concluir remove da fila e renormaliza
T-I5  reatribuir A→B remove de A, insere em B, normaliza as duas
T-I6  priority NORMAL→URGENT recoloca no fim das urgentes
T-I7  backfill produz a ordem especificada em §13
T-I8  backfill roda duas vezes sem duplicar
```

### Concorrência — corrida real, `Promise.all`

```text
T-C1  dois reorder simultâneos: um 409, nenhuma posição duplicada
T-C2  reorder + priority change simultâneos: estado final coerente
T-C3  reassign A→B e reorder em A simultâneos
T-C4  I-12 SOB CORRIDA: nenhuma NORMAL termina à frente de URGENT
T-C5  reassign A→B e B→A simultâneos não dão deadlock (ordem de lock)
T-C6  mesma Idempotency-Key duas vezes: um efeito, um evento, uma linha
```

`T-C4` é o teste que sustenta a decisão `D-11`, e é o único caso em que o banco
não é a rede. **Prova de reversão obrigatória**: remover o passo de ordenação
estável tem de fazê-lo falhar.

### Tenant, RBAC e auditoria

```text
T-S1  empresa A não lê a fila de B com technicianId válido de B     → 404
T-S2  empresa A não reordena a fila de B                            → 404
T-S3  OS de B não entra na fila de A                                → 404
T-S4  TECHNICIAN recebe 403 em priority e reorder
T-S5  campo desconhecido no corpo é REJEITADO (zod .strict)
T-S6  companyId no corpo é ignorado/rejeitado, nunca honrado
T-S7  reorder de 5 OS escreve UM evento de timeline, não cinco
T-S8  AuditLog registra actor, before e after
```

`T-S1`–`T-S3` precisam de **controle positivo**: provar que o caminho
autorizado devolve a fila, senão o teste negativo pode estar passando por vazio.

### Web e Flutter

```text
W-1  arrastar emite comando absoluto, não delta
W-2  ↑ ↓ produzem o mesmo comando do arrastar
W-3  409 mostra a mensagem de recarregar, sem sobrescrever
W-4  seletor completo alcança LOW e HIGH
W-5  TECHNICIAN não vê os controles (defesa em profundidade, não o controle)

F-1  ordem do backend é respeitada; nada reordenado localmente
F-2  ausência de position cai no ranking local
F-3  ordinal 1ª/2ª/3ª visível
F-4  urgente com rótulo textual, não só cor
F-5  IN_PROGRESS em seção própria, N itens
F-6  "próxima na fila" e "próxima agendada" nunca com o mesmo rótulo
```

---

## 15. Segurança — revisão aplicada ao plano

Não é revisão de diff: **não há código**. É a checklist da
`alfaos-security-review` aplicada ao desenho.

| Superfície | Como o plano responde |
|---|---|
| Multi-tenancy | `companyId` da sessão; filtro em SQL; a fila é achada por `(companyId, technicianId)`, nunca por navegação de FK |
| IDOR | `technicianId` da rota é validado contra a empresa da sessão; **404**, não 403, para não confirmar existência |
| Ownership | Field deriva o técnico do token; sem `?technicianId=` |
| RBAC | `assertProfile([ADMIN, DISPATCHER])`, server-side; esconder botão não é controle |
| Mass assignment | zod `.strict()`; `companyId`, `position`, `version` e `status` nunca aceitos do cliente |
| CAS | dois agregados, dois tokens; `updatedAt` não serve (`timestamp(3)`) |
| Idempotência | `withIdempotency`, escopo `(empresa, usuário, operação, chave)`; alvo absoluto no contrato |
| Transações | uma por operação; o hook de remoção entra nas transações que já existem |
| Máquina de estados | a fila **não** inicia, conclui nem cancela; `I-06`, `I-07` |
| Auditoria | `AuditLog` a operação inteira; timeline só a OS nomeada (`T-S7`) |
| Erros | 400/401/403/404/409 pelos helpers existentes; nenhum status novo |

**Risco residual declarado:** `I-12` é invariante de aplicação (`D-11`). Não é
explorável por um atacante — não dá acesso a nada — mas é corrompível por
regressão, e por isso tem `T-C4` com prova de reversão.

---

## 16. Performance

Filas por técnico são pequenas (unidades a dezenas), então normalização inteira
dentro da transação é adequada para P0. **Sem LexoRank, sem posição
fracionária**: complexidade paga por um problema que este volume não tem.

Índices necessários — os do §2 bastam:

```text
@@unique([companyId, technicianId])   lookup da fila
@@unique([queueId, position])         I-11 + ordenação
serviceOrderId @unique                membership e remoção
```

**Observação pré-existente, fora do escopo desta capability:** `ServiceOrder`
não tem índice em `technicianId`. As consultas por `(companyId, technicianId,
status)` caem no índice `[companyId, status]`. Não é regressão nem bloqueio, e
o backfill (§13) varre por técnico — vale medir em `DQ-2` antes de decidir se
acrescenta um índice.

---

## 17. Fases

Cada fase é um commit, com prova de reversão e critério de saída.

| Fase | Escopo | Arquivos prováveis | Saída |
|---|---|---|---|
| **DQ-1** | Schema, migration aditiva, `DISPATCH_BAND`, normalização pura | `prisma/schema.prisma`, migration, `src/lib/dispatch-queue.ts` | `T-D1`–`T-D6` verdes; `migrate status` limpo; nada consome ainda |
| **DQ-2** | Serviço de fila + hooks nas 3 chamadas reais + backfill | `dispatch-queue.ts`, `service-orders.ts`, `service-order-closing.ts` | `T-I*`, `T-C1`–`T-C5`; backfill idempotente provado |
| **DQ-3** | Rotas administrativas | `api/dispatch/**`, `api/service-orders/[id]/priority` | `T-S*`, `T-C6`; 409 verificado por corrida real |
| **DQ-4** | Web `/despacho` | `src/app/(app)/despacho/**` | `W-1`–`W-5`; Playwright do fluxo |
| **DQ-5** | Contrato de leitura no Field | `src/lib/field/dto.ts`, `api/field/v1/dispatch-queue` | DTO sem PII nova; sem campo de provider |
| **DQ-6** | Field consome a ordem | `apps/field/lib/features/**` | `F-1`–`F-6`; fallback provado nos dois ramos |
| **DQ-7** | Endurecimento, auditoria independente, piloto | — | Auditoria por quem não implementou; piloto físico |

`DQ-1` e `DQ-2` são separados de propósito: schema sem consumidor é reversível
por `migrate resolve`; schema com serviço já tem dado escrito.

**Ordem de rollout, e a janela que ela fecha:** nenhum cliente lê `position`
antes de `DQ-5`, e o Field só passa a obedecê-la em `DQ-6`. Entre `DQ-4` e
`DQ-6` a Web já reordena e o Field ainda usa ranking local — e isso é
**definido**, não acidental: o fallback do §12 é por presença de campo, então
cada cliente tem comportamento determinado em cada momento do rollout.

---

## 18. O que este plano deliberadamente não faz

```text
não trava uma IN_PROGRESS por técnico            D-08, feature separada
não implementa cancelamento nem desatribuição    não existem; ficam hooks
não implementa FCM                               PRD §327
não implementa roteirização                      PRD §137, §187
não toca escala nem Jornada                      PRD §288, §300
não remove SERVICE_ORDER_PRIORITY_ORDER agora    DQ-1 decide (§4)
não acrescenta índice em technicianId            medir em DQ-2 (§16)
```

O polimento visual pendente do Field (destaque das métricas de OS abertas e
urgentes, repetição da mesma OS entre `ATENÇÃO AGORA` e `PRÓXIMA OS`, ajustes
da gaveta) **não pertence a esta capability** e não entra em nenhuma fase `DQ`.

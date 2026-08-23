# Ordens de Serviço — AlfaOS (v0.3-technician-execution)

Este documento descreve o núcleo operacional de Ordens de Serviço (OS),
entregue no checkpoint `v0.2-service-orders` e estendido em
`v0.3-technician-execution` com a execução do técnico (§4.1).

## 1. Modelo de dados

| Modelo | Papel |
| --- | --- |
| `Customer` | Cliente do provedor, sempre escopado por `companyId`. |
| `Technician` | Técnico vinculado a um `User` da mesma empresa. `userId` é único (um usuário só pode ser técnico uma vez) e `active` controla disponibilidade para atribuição. |
| `ServiceOrder` | OS com `number`, `customerId`, `type`, `description`, `priority`, `status`, origem opcional `externalProvider`/`externalId` (importação ERP) e `version` (token de lock otimista, ver §3.1). |
| `ServiceOrderEvent` | Timeline imutável da OS (`SERVICE_ORDER_IMPORTED`, `TECHNICIAN_ASSIGNED`, `OS_STARTED`, mudanças de status). Gravada na mesma transação das mutações. |
| `ServiceOrderExecution` | Registro de campo da OS (`diagnosis`, `workPerformed`, `notes`), 1:1 com `ServiceOrder` (`serviceOrderId @unique`), com `version` própria para lock otimista. Criada ao iniciar o atendimento — ver §4.1 e [TECHNICIAN-EXECUTION.md](TECHNICIAN-EXECUTION.md). |

Campos de origem externa (`externalProvider`, `externalId`) não aparecem nos
shapes públicos da API (`toPublicServiceOrder`).

## 2. Máquina de estados

Centralizada em `ALLOWED_STATUS_TRANSITIONS` (`src/lib/service-orders.ts`):

| Estado atual | Estados permitidos |
| --- | --- |
| `PENDING` | `ASSIGNED`, `CANCELLED` |
| `ASSIGNED` | `ASSIGNED` (troca de técnico), `IN_PROGRESS`, `CANCELLED` |
| `IN_PROGRESS` | `COMPLETED`, `CANCELLED` |

Toda mudança passa por essa máquina. Endpoints de transição implementados:

- `POST /api/service-orders/[id]/assign` — atribuição/troca (§3);
- `POST /api/service-orders/[id]/start` — `ASSIGNED → IN_PROGRESS` (§4.1).

**Não existe endpoint genérico de mudança de status**: cada transição é uma
ação de negócio nomeada, com seu próprio ator, efeitos e registro.

A máquina de estados também é o que torna o início idempotente: como
`IN_PROGRESS` não lista `IN_PROGRESS` entre seus destinos, um segundo start é
recusado com `409` em vez de reiniciar a OS.

## 3. Atribuição de técnico

### 3.1. Quem pode receber uma NOVA atribuição

Um `Technician` só é elegível quando **todas** as condições valem:

| Condição | Por quê |
| --- | --- |
| `Technician.active` | Disponibilidade operacional declarada pelo gestor. |
| O `User` vinculado existe | Sem usuário não há pessoa a quem atribuir. |
| `User.active` | Conta desativada não deve continuar recebendo trabalho. |
| `User.profile = TECHNICIAN` | Quem virou DISPATCHER/ADMIN não é mais técnico. |
| Técnico **e** usuário na empresa da OS | Isolamento multi-tenant. |

Antes só `Technician.active` era verificado, dos dois lados (atribuição e
dropdown). Como desativar um usuário ou trocar seu perfil **não** altera a linha
`Technician`, uma conta revogada continuava elegível — corrigido em
`v0.2.2-pre-v03-hardening`.

A regra vive em um lugar só (`src/lib/technicians.ts`) e é consumida pelas duas
pontas:

- `assignableTechnicianWhere(companyId)` — fragmento `where` usado por
  `listActiveTechnicianOptions` (dropdown);
- `technicianAssignmentIssue(companyId, technician)` — mesma regra, mas devolve
  o **motivo** para `assignTechnician` produzir mensagem acionável.

Assim a UI nunca oferece uma opção que a API recusaria.

**Códigos**: inelegível → `400` com o motivo; técnico de outra empresa → `404`
(não confirma existência de recurso alheio).

**Histórico é preservado.** A elegibilidade é **derivada na leitura**, nunca
sincronizada de volta para `Technician.active`. Desativar um usuário não
reescreve nada: OS já atribuídas continuam mostrando o técnico, a timeline fica
intacta e "Minhas OS" segue coerente. A regra bloqueia **apenas novas
atribuições**.

### 3.2. Controle de concorrência (lock otimista por versão)

- A atualização usa `updateMany({ where: { id, version: os.version } })` com
  `data: { ..., version: { increment: 1 } }`. Se `count !== 1`, outra requisição
  modificou a OS → `409` "A OS foi modificada por outra requisição. Recarregue e
  tente novamente."
- **Por que não `updatedAt`.** O predicado anterior era
  `updateMany({ where: { id, updatedAt: os.updatedAt } })`. `DateTime` do Prisma
  mapeia para `timestamp(3)` no Postgres — resolução de **1 ms**. Duas escritas
  concorrentes no mesmo milissegundo produziam o mesmo `updatedAt`, as duas
  passavam pelo predicado e a segunda sobrescrevia a primeira **em silêncio**
  (lost update). Um inteiro monotônico decide por identidade, não por relógio.
- A reimportação do ERP também incrementa `version` — é uma escrita real na
  linha, e ignorá-la deixaria uma atribuição com leitura anterior ao sync passar
  por cima de campos que nunca viu.
- O compare-and-set é **servidor-side**: `assignTechnician` lê e escreve dentro
  da mesma transação.
- **Lock fim-a-fim via `expectedVersion`** (resolvido em `v0.2.3`). O predicado
  server-side sozinho só cobre a janela entre duas requisições **em voo**. Como
  `version` não saía na API nem voltava do cliente, o servidor sempre relia a
  versão corrente e aceitava qualquer reatribuição: os despachantes A e B abriam
  a OS na mesma versão, A atribuía Tech1, e B — com a tela desatualizada —
  atribuía Tech2 e **vencia sem conflito nenhum**. Ficava auditado
  (`TECHNICIAN_CHANGED` guarda o técnico anterior), mas o segundo despachante
  nunca sabia que estava desatualizado. Agora:
  - `version` faz parte de `PublicServiceOrder`, então sai em
    `GET /api/service-orders/[id]` e na listagem;
  - `POST /api/service-orders/[id]/assign` aceita `expectedVersion` **opcional**
    (inteiro ≥ 0, schema `.strict()`);
  - quando enviada, ELA é o predicado: `where: { id, version: expectedVersion }`.
    Versão obsoleta casa zero linhas → mesmo `409` de conflito;
  - quando **não** enviada, o predicado continua sendo a versão relida na
    transação — comportamento anterior preservado na íntegra, nenhum chamador
    quebra.
  - A tela de detalhe da OS passa `order.version` ao `AssignTechnicianForm`, que
    a envia no POST. A prop é lida direto (nunca copiada para `useState`), para
    que o `router.refresh()` pós-sucesso traga a versão nova.
- A troca de técnico é permitida a partir de `ASSIGNED` e grava novo evento na
  timeline.
- OS + evento de atribuição são gravados na **mesma transação** Prisma.

## 4. Minhas OS (ownership do técnico)

- `GET /api/service-orders` com o perfil `TECHNICIAN` retorna apenas as OS
  atribuídas ao técnico da sessão.
- O `technician_id` é resolvido **no servidor**: `session.userId → user →
  technician`. O cliente nunca envia o vínculo.
- A página `/minhas-os` lista, nesta ordem, as OS **em atendimento**, as de
  **hoje** e as **próximas** do técnico autenticado. Um técnico de outra empresa
  não enxerga OS locais.

### 4.1. Execução (v0.3-technician-execution)

Resumo; o documento completo é
[TECHNICIAN-EXECUTION.md](TECHNICIAN-EXECUTION.md).

- `POST /api/service-orders/[id]/start` leva `ASSIGNED → IN_PROGRESS`, grava
  `startedAt`, cria a `ServiceOrderExecution` e o evento `OS_STARTED` — tudo em
  uma transação. Só o **técnico dono** (perfil `TECHNICIAN`); `expectedVersion`
  é **obrigatório**.
- `PATCH /api/service-orders/[id]/execution` salva `diagnosis`,
  `workPerformed` e `notes` (todos opcionais — "serviço realizado" só é
  obrigatório no fechamento da v0.4). `expectedVersion` refere-se à **execução**,
  não à OS: os dois locks são independentes.
- Salvar **não** muda o status e **não** gera evento de timeline; o registro
  por-save fica no `AuditLog` (`SERVICE_ORDER.EXECUTION_UPDATED`) com os nomes
  dos campos alterados e **sem** o texto livre.
- Não-dono → `404`. `ADMIN`/`DISPATCHER` → `403` para escrever, leitura
  integral (técnico, `startedAt`, os três campos e a timeline) em modo
  read-only.
- Técnico com `Technician.active = false` continua **lendo**; toda escrita é
  recusada com `403` e mensagem acionável. Nada já gravado é alterado.

## 5. Integração com Mock ERP

- `MockERPAdapter.listServiceOrders()` expõe três OS de exemplo (#10001 João da
  Silva — Manutenção/HIGH, #10002 Maria Oliveira — Instalação/NORMAL, #10003
  Carlos Souza — Suporte/NORMAL).
- `POST /api/integrations/sync` exige integração habilitada (senão `400`).
- **Idempotência**: a correspondência é feita por
  `companyId + externalProvider + externalId` (cliente via `upsert`; OS via
  `create` numa transação com fallback em `P2002`, para ficar atômica sob
  syncs concorrentes — ver [SECURITY.md §8](SECURITY.md)). Na primeira sync
  criam-se 3 OS; reimportações atualizam dados externos e reportam "0
  criadas, 3 atualizadas" — nunca duplicam, e **não** sobrescrevem
  `status`/`technicianId`/timeline locais, mesmo com duas sincronizações
  simultâneas da mesma OS.

## 6. Endpoints

| Método e rota | Perfil | Descrição |
| --- | --- | --- |
| `GET /api/customers` · `POST /api/customers` | ADMIN/DISPATCHER | Listar/criar clientes |
| `GET/PATCH/DELETE /api/customers/[id]` | ADMIN/DISPATCHER | Detalhe/edição/exclusão |
| `GET /api/technicians` · `POST /api/technicians` | ADMIN | Listar/vincular técnico |
| `PATCH/DELETE /api/technicians/[id]` | ADMIN | Ativar/desativar/excluir |
| `GET /api/service-orders` | ADMIN/DISPATCHER/TECHNICIAN | Listar (filtros por status/prioridade/técnico; técnico vê só as suas) |
| `POST /api/service-orders` | ADMIN/DISPATCHER | Criar OS manual |
| `GET /api/service-orders/[id]` | ADMIN/DISPATCHER/TECHNICIAN | Detalhe + timeline (ownership) |
| `POST /api/service-orders/[id]/assign` | ADMIN/DISPATCHER | Atribuir/trocar técnico (`expectedVersion` opcional → lock otimista fim-a-fim, §3.2) |
| `POST /api/service-orders/[id]/start` | TECHNICIAN (dono) | Iniciar atendimento, `ASSIGNED → IN_PROGRESS` (`expectedVersion` **obrigatório**, §4.1) |
| `PATCH /api/service-orders/[id]/execution` | TECHNICIAN (dono) | Salvar diagnóstico/serviço/observações (`expectedVersion` da **execução**, §4.1) |
| `POST /api/integrations/sync` | ADMIN | Importar OS do ERP (idempotente) |

Todas as rotas novas usam Zod `.strict()`, exigem sessão com perfil adequado
e são isoladas por `companyId`.

## 7. Fora do escopo deste checkpoint

Fechamento de OS (fotos, materiais, assinatura, validações, `COMPLETED`, PDF),
pausa/retomada, estoque, notificações/WhatsApp, GPS, OLT, IA, e a integração
real com a ReceitaNet (aguarda documentação oficial).

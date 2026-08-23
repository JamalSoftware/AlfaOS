# Arquitetura — AlfaOS (v0.3-technician-execution)

## Visão geral

AlfaOS é uma plataforma de Ordens de Serviço (OS) para provedores de
telecomunicações. Stack: **Next.js 14 (App Router) + TypeScript + Tailwind
CSS + PostgreSQL + Prisma 6**. Autenticação por e-mail/senha com sessão JWT
(em cookie HttpOnly) e multi-tenancy por empresa.

```
┌─────────────────────────────────────────────────────────────┐
│                     Cliente (React)                         │
│  Páginas App Router  ·  Componentes client (forms, toggles)│
└───────────────┬─────────────────────────────────────────────┘
                │ fetch / form action (same-origin)
┌───────────────▼─────────────────────────────────────────────┐
│  Server (Next.js)                                            │
│  ┌────────────┐ ┌──────────┐ ┌─────────────┐ ┌────────────┐ │
│  │ Roteadores  │ │ Guards   │ │ Serviços    │ │ Integração │ │
│  │ /api/*      │ │ profile  │ │ lib/*       │ │ ERP        │ │
│  │ páginas     │ │ /session │ │ users,      │ │ adapters   │ │
│  │             │ │          │ │ customers,  │ │            │ │
│  │             │ │          │ │ technicians,│ │            │ │
│  │             │ │          │ │ service-    │ │            │ │
│  │             │ │          │ │ orders,     │ │            │ │
│  │             │ │          │ │ erp-sync,   │ │            │ │
│  │             │ │          │ │ audit,      │ │            │ │
│  │             │ │          │ │ rate-limit  │ │            │ │
│  └──────┬──────┘ └────┬─────┘ └─────────────┘ └────────────┘ │
│         │             │                                      │
│  ┌──────▼─────────────▼──────────────────────────────────────┐│
│  │ Cross-cutting: runApi, CSRF, sanitizeAudit, validateEnv   ││
│  └───────────────────────────┬──────────────────────────────┘│
└──────────────────────────────▼────────────────────────────────┘
                Prisma ORM  →  PostgreSQL (multi-tenant)
```

## Camadas

### 1. API (`src/app/api/**`)

- Handlers por rota (`route.ts`): `auth/login`, `auth/logout`, `users`,
  `users/[id]`, `integrations`, `integrations/test-connection`,
  `customers`, `customers/[id]`, `technicians`, `technicians/[id]`,
  `service-orders`, `service-orders/[id]`, `service-orders/[id]/assign`,
  `integrations/sync`.
- Todos os handlers de escrita começam com `assertSameOrigin` (CSRF).
- Todos os handlers são envolvidos por `runApi` (erro centralizado, sem
  vazamento de stack/SQL).
- Toda rota nova valida entrada com **Zod `.strict()`** (rejeita campos
  desconhecidos, impedindo mass assignment). O frontend nunca envia
  `companyId`, `status`, timestamps nem `externalProvider` — esses valores são
  resolvidos no servidor.

### 2. Biblioteca (`src/lib/**`)

| Módulo | Responsabilidade |
| --- | --- |
| `env.ts` | `validateEnv` — validação fail-fast de configuração |
| `auth.ts` | `createSessionToken` / `verifySessionToken` (jose, HS256) |
| `session.ts` | Resolução da sessão a partir do cookie (API ou página) com revalidação no banco |
| `guards.ts` | `requirePageSession` / `requirePageProfile` + `defaultPageFor` |
| `password.ts` | Hash/verificação (bcrypt) |
| `users.ts` | CRUD de usuários com scoping multi-empresa |
| `rate-limit.ts` | Rate limit persistente (Postgres) por e-mail + IP |
| `csrf.ts` | `assertSameOrigin` para métodos de mudança de estado |
| `audit.ts` | `logAudit` + `sanitizeAuditDetails` (redação central) |
| `api.ts` | `jsonOk` / `jsonError` / `runApi` + `assertProfile` + tradução de `DomainError` |
| `errors.ts` | `DomainError` (`notFound`/`badRequest`/`conflict`/`forbidden`) |
| `constants.ts` | Constantes (cookie, janelas de rate limit) |
| `prisma.ts` | Singleton do Prisma Client |
| `dashboard.ts` | Estatísticas do dashboard (multi-empresa) |
| `navigation.ts` | Navegação por perfil + labels |
| `customers.ts` | CRUD de clientes com scoping multi-empresa |
| `technicians.ts` | CRUD de técnicos (vínculo com `User` + `userId` único) |
| `service-orders.ts` | Máquina de estados, atribuição, timeline, consulta por técnico |
| `erp-sync.ts` | `syncServiceOrdersFromERP` (idempotente, transacional por OS) |

### 3. Integração ERP (`src/integrations/**`)

- Contrato `ERPIntegrationContract` desacopla o AlfaOS do provedor. O
  `listServiceOrders()` tipado retorna OS externas para importação.
- `MockERPAdapter` (dev/teste): expõe #10001–#10003 e permite testes de
  reimportação sem duplicação.
- `ReceitanetAdapter` declara as capabilities e **recusa todas** com
  `NOT_SUPPORTED` — a integração real aguarda documentação oficial da API, e
  live auth está adicionalmente bloqueada pelo desenho de armazenamento de
  credenciais. Ver [ERP-INTEGRATIONS.md](ERP-INTEGRATIONS.md) §1.
- **Diagnóstico (v0.5)**: `ERPDiagnosticsCapability` é uma capability
  **separada** do contrato base — um provider pode não oferecê-la, e
  `supportsDiagnostics()` responde isso sem forçar todo adapter a stubar
  método. O resultado é normalizado em `CustomerDiagnosticSnapshot`
  (`ONLINE`/`OFFLINE`/`UNKNOWN`), com a regra inegociável de que **falha de
  integração nunca vira `OFFLINE`** e nunca sobrescreve um snapshot válido.
  Timeout aplicado no call site (`withIntegrationTimeout`), não dentro dos
  adapters, para que a garantia seja estrutural.
- Sincronização (`POST /api/integrations/sync`): exige integração habilitada;
  usa `externalId` para **idempotência** por empresa — reimportar nunca cria
  duplicatas nem sobrescreve `status`/`technicianId`/timeline locais.
- Teste de conexão **não habilita** a integração: ativação é uma ação
  explícita e separada (PATCH `/api/integrations`).

### 4. Banco de dados (`prisma/schema.prisma`)

Modelos atuais:

- `Company` — empresa inquilina (multi-tenancy). Possui `document`.
- `User` — credenciais, perfil (`ADMIN/DISPATCHER/TECHNICIAN`), status.
- `AuditLog` — trilha de auditoria (FK `Restrict` para preservar histórico).
- `LoginAttempt` — registro de tentativas de login (rate limit).
- `ERPIntegration` — estado de integração por empresa.
- `Customer` — clientes da empresa.
- `Technician` — técnicos vinculados a um `User` da mesma empresa
  (`userId` único, `active` para controle de disponibilidade).
- `ServiceOrder` — OS com status (`PENDING/ASSIGNED/IN_PROGRESS/COMPLETED/
  CANCELLED`), prioridade, `externalProvider`/`externalId` para origem ERP e
  `version Int @default(0)` — token de lock otimista incrementado a cada
  escrita relevante (atribuição e reimportação do ERP). Substituiu `updatedAt`
  como predicado de compare-and-set: `DateTime` mapeia para `timestamp(3)`, de
  modo que duas escritas no mesmo milissegundo passavam ambas pelo predicado e
  uma se perdia em silêncio. Migration aditiva
  `20260822234652_add_service_order_version_lock` (default `0`, não destrutiva).
- `ServiceOrderEvent` — timeline imutável da OS (importação, atribuição,
  início do atendimento, mudança de status) gravada na mesma transação das
  mutações.
- `ServiceOrderExecution` — registro de campo da OS (`diagnosis`,
  `workPerformed`, `notes`), **1:1 com `ServiceOrder`** garantido no banco por
  `serviceOrderId @unique`, com `version Int @default(0)` próprio (lock
  otimista independente do da OS) e `companyId` desnormalizado para permitir
  filtro de inquilino em SQL nas duas pontas. Migration aditiva
  `20260823013205_add_service_order_execution` (só cria a tabela nova).

Modelos **planejados** (fora do escopo deste checkpoint): fechamento de OS
(fotos, materiais, assinatura, PDF), estoque, notificações, GPS, OLT, IA e a
ReceitaNet real.

### 5. Domínio de OS (`src/lib/service-orders.ts`)

- Máquina de estados central em `ALLOWED_STATUS_TRANSITIONS`:
  `PENDING → ASSIGNED/CANCELLED`, `ASSIGNED → ASSIGNED/IN_PROGRESS/CANCELLED`,
  `IN_PROGRESS → COMPLETED/CANCELLED`.
- Atribuição/troca via `POST /api/service-orders/[id]/assign` com
  **optimistic locking por versão**: `updateMany({ id, version })` +
  `data: { version: { increment: 1 } }` → se `count !== 1` retorna `409`
  ("modificada por outra requisição"). Determinístico: decidido por identidade,
  não por resolução de relógio.
- Elegibilidade do técnico definida **uma única vez** em
  `src/lib/technicians.ts`: `technicianEligibilityReason` avalia a regra e
  devolve um **código**; `assignableTechnicianWhere` é o mesmo predicado em
  forma de `where`; `technicianAssignmentIssue` (3ª pessoa, para quem atribui)
  e `technicianExecutionIssue` (2ª pessoa, para o próprio técnico) apenas
  traduzem o código. Uma regra com dois vocabulários, consumida pelo dropdown,
  pelo serviço de atribuição e pelo serviço de execução — UI e API nunca
  discordam.
- OS + evento gravados na **mesma transação** (nunca status sem timeline).
- "Minhas OS" resolve o técnico no servidor via sessão (`technician_id` nunca
  vem do cliente) e valida que técnico e OS pertencem à mesma empresa.
- **Execução do técnico (v0.3)** — `startServiceOrder` e
  `updateServiceOrderExecution`, ambos com `expectedVersion` **obrigatório**:
  - `start` (`ASSIGNED → IN_PROGRESS`) é uma **ação explícita**, não um
    endpoint genérico de status: resolve o técnico pela sessão, valida
    elegibilidade e ownership, consulta a máquina de estados, faz
    compare-and-set em `ServiceOrder.version`, cria a `ServiceOrderExecution`
    e o evento `OS_STARTED` — tudo em uma transação.
  - `execution` faz compare-and-set em `ServiceOrderExecution.version` (lock
    **separado** do da OS) e **não** cria evento de timeline; o registro
    por-save fica no `AuditLog`, com os nomes dos campos alterados e sem o
    texto livre.
  - Não-dono recebe `404` (nunca `403`), para não confirmar a existência de
    recurso alheio.
  - Ver [TECHNICIAN-EXECUTION.md](TECHNICIAN-EXECUTION.md).

### Fechamento da OS (v0.4)

- Modelos novos: `ServiceOrderEvidence`, `ServiceOrderMaterialUsage`,
  `ServiceOrderSignature` (este 1:1 com a OS, garantido por
  `serviceOrderId @unique`). Os três desnormalizam `companyId` para permitir
  filtro de tenant em SQL, como a execução.
- **Binários não vão para o Postgres.** O domínio guarda `storageKey` e passa
  por `FileStorageContract`; `LocalFileStorageAdapter` é a implementação atual.
  Trocar por S3/R2/MinIO é escrever um adapter — schema e regras não mudam.
- A chave é gerada no servidor a partir de ids e do mime **validado**, nunca do
  nome enviado pelo cliente.
- **Claim**: toda mutação de filho faz compare-and-set na própria `ServiceOrder`
  (`status = IN_PROGRESS AND version = expectedOrderVersion`) e incrementa a
  versão, na mesma transação da escrita do filho. É isso que dá um vencedor
  único em `child × complete`.
- `completeServiceOrder` aplica **dois** compare-and-set (execução, depois OS).
- Ver [SERVICE-ORDER-CLOSING.md](SERVICE-ORDER-CLOSING.md).

## Multi-tenancy

- Toda consulta parte de `session.companyId`.
- Usuários de outra empresa retornam `404` (não revela existência).
- Auditoria e rate limit são gravados com `companyId`.

## Segurança aplicada nas bordas

- CSRF: `assertSameOrigin` em toda escrita.
- Rate limit: login (e-mail + IP).
- Erros: `runApi` com resposta genérica em 500.
- Headers: CSP, nosniff, frame/clickjacking, referrer, permissions, HSTS.
- Auditoria: sanitização central de detalhes.

## Testes

| Suíte | Ferramenta | Escopo |
| --- | --- | --- |
| Unit/integração | Vitest (handlers reais via `Request`) | auth, tenancy, authorization, rate-limit, CSRF, sanitização, revalidação, edição de usuário, integrações, env, customers, technicians, service-orders (importação, atribuição, ownership, concorrência), execução do técnico (start, máquina de estados, ownership, técnico/usuário inativos, multi-tenancy, mass assignment, concorrência da execução, unicidade no banco, KPI) |
| E2E | Playwright (Chromium headless) | login, RBAC, criação de usuário, logout, integrações, mobile 390×844, sync do Mock ERP (idempotência), critério de aceite de OS (sync → atribuição → Minhas OS), execução do técnico (iniciar → preencher → salvar → reload, ownership por URL direta, leitura read-only do ADMIN, fluxo completo em 390×844 sem overflow horizontal) |

- Banco de teste: `alfaos_test` (migrations aplicadas via globalSetup).
- E2E usa `npm run e2e` (levanta o app com `DATABASE_URL` de teste e seed).
- **Isolamento do banco no E2E** (endurecido em `v0.2.2-pre-v03-hardening`): a
  suíte sobe **sempre** o próprio servidor (`reuseExistingServer: false`) em uma
  **porta dedicada** (`E2E_PORT`, padrão `3100`), então um `next dev` do
  desenvolvedor na 3000 nunca é adotado. Antes, `reuseExistingServer:
  !process.env.CI` adotava esse servidor — que roda com o `DATABASE_URL` de
  desenvolvimento — e a suíte inteira (syncs de ERP, criação de usuários,
  atribuições) escrevia no banco de dev. Além disso, `e2e/test-db-guard.ts`
  recusa fail-fast qualquer banco cujo nome não termine em `_test`, verificando
  a alegação da connection string contra `current_database()` na conexão viva.
  O guard roda em três pontos: no preflight do `webServer` (no ambiente exato do
  servidor), no `globalSetup` (antes de qualquer operação destrutiva) e dentro
  do próprio `e2e/reset-db.ts`.

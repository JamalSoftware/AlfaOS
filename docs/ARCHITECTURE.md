# Arquitetura — AlfaOS (v0.2-service-orders)

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
- `ReceitanetAdapter` foi reduzido a `testConnection()` — a integração real
  aguarda a documentação oficial da API.
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
  CANCELLED`), prioridade, `externalProvider`/`externalId` para origem ERP.
- `ServiceOrderEvent` — timeline imutável da OS (importação, atribuição,
  mudança de status) gravada na mesma transação das mutações.

Modelos **planejados** (fora do escopo deste checkpoint): execução/fechamento
de OS (diagnóstico, fotos, materiais, assinatura, PDF), estoque,
notificações, GPS, OLT, IA e a ReceitaNet real.

### 5. Domínio de OS (`src/lib/service-orders.ts`)

- Máquina de estados central em `ALLOWED_STATUS_TRANSITIONS`:
  `PENDING → ASSIGNED/CANCELLED`, `ASSIGNED → ASSIGNED/IN_PROGRESS/CANCELLED`,
  `IN_PROGRESS → COMPLETED/CANCELLED`.
- Atribuição/troca via `POST /api/service-orders/[id]/assign` com
  **otimistic locking**: `updateMany({ id, updatedAt })` → se `count !== 1`
  retorna `409` ("modificada por outra requisição").
- OS + evento gravados na **mesma transação** (nunca status sem timeline).
- "Minhas OS" resolve o técnico no servidor via sessão (`technician_id` nunca
  vem do cliente) e valida que técnico e OS pertencem à mesma empresa.

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
| Unit/integração | Vitest (handlers reais via `Request`) | auth, tenancy, authorization, rate-limit, CSRF, sanitização, revalidação, edição de usuário, integrações, env, customers, technicians, service-orders (importação, atribuição, ownership, concorrência) |
| E2E | Playwright (Chromium headless) | login, RBAC, criação de usuário, logout, integrações, mobile 390×844, sync do Mock ERP (idempotência), critério de aceite de OS (sync → atribuição → Minhas OS) |

- Banco de teste: `alfaos_test` (migrations aplicadas via globalSetup).
- E2E usa `npm run e2e` (levanta o app com `DATABASE_URL` de teste e seed).

# Arquitetura — AlfaOS (v0.1.1-hardening)

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
│  ┌────────────┐ ┌──────────┐ ┌───────────┐ ┌──────────────┐ │
│  │ Roteadores  │ │ Guards   │ │ Serviços  │ │ Integração   │ │
│  │ /api/*      │ │ profile  │ │ lib/*     │ │ ERP (adapters)│ │
│  │ páginas     │ │ /session │ │ users,    │ │ MOCK/RECEITANET││
│  └──────┬──────┘ └────┬─────┘ │ audit,    │ └──────────────┘ │
│         │             │       │ rate-limit│                  │
│  ┌──────▼─────────────▼───────▼───────────▼────────────────┐ │
│  │ Cross-cutting: runApi, CSRF, sanitizeAudit, validateEnv  │ │
│  └───────────────────────────┬──────────────────────────────┘ │
└──────────────────────────────▼────────────────────────────────┘
                Prisma ORM  →  PostgreSQL (multi-tenant)
```

## Camadas

### 1. API (`src/app/api/**`)

- Handlers por rota (`route.ts`): `auth/login`, `auth/logout`, `users`,
  `users/[id]`, `integrations`, `integrations/test-connection`.
- Todos os handlers de escrita começam com `assertSameOrigin` (CSRF).
- Todos os handlers são envolvidos por `runApi` (erro centralizado, sem
  vazamento de stack/SQL).

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
| `api.ts` | `jsonOk` / `jsonError` / `runApi` |
| `constants.ts` | Constantes (cookie, janelas de rate limit) |
| `prisma.ts` | Singleton do Prisma Client |
| `dashboard.ts` | Estatísticas do dashboard (multi-empresa) |
| `navigation.ts` | Navegação por perfil + labels |

### 3. Integração ERP (`src/integrations/**`)

- Contrato `ERPIntegrationContract` desacopla o AlfaOS do provedor.
- `MockERPAdapter` (dev/teste) e `ReceitanetAdapter` (placeholder controlado —
  a integração real aguarda a documentação oficial da API).
- Teste de conexão **não habilita** a integração: ativação é uma ação
  explícita e separada (PATCH `/api/integrations`).

### 4. Banco de dados (`prisma/schema.prisma`)

Modelos atuais:

- `Company` — empresa inquilina (multi-tenancy). Possui `document`.
- `User` — credenciais, perfil (`ADMIN/DISPATCHER/TECHNICIAN`), status.
- `AuditLog` — trilha de auditoria (FK `Restrict` para preservar histórico).
- `LoginAttempt` — registro de tentativas de login (rate limit).
- `ERPIntegration` — estado de integração por empresa.

Modelos **planejados** (fora do escopo deste checkpoint): `Client`,
`Technician`, `ServiceOrder` e dependentes (fotos, assinatura, materiais,
estoque, notificações).

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
| Unit/integração | Vitest (handlers reais via `Request`) | auth, tenancy, authorization, rate-limit, CSRF, sanitização, revalidação, edição de usuário, integrações, env |
| E2E | Playwright (Chromium headless) | login, RBAC, criação de usuário, logout, integrações, mobile 390×844 |

- Banco de teste: `alfaos_test` (migrations aplicadas via globalSetup).
- E2E usa `npm run e2e` (levanta o app com `DATABASE_URL` de teste e seed).

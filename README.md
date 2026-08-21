# AlfaOS 1.0

Plataforma web de Ordens de Serviço para equipes técnicas, preparada para
crescimento como SaaS e para integração futura com o ERP ReceitaNet.

**Versão atual:** v0.1-foundation (fundação)

## Stack

- Next.js 14 (App Router)
- TypeScript
- Tailwind CSS
- PostgreSQL 15
- Prisma ORM 6
- Autenticação com JWT (jose) + bcrypt
- Testes com Vitest
- Validação server-side com Zod

## Começando

### 1. Requisitos

- Node.js 20+
- PostgreSQL 15+

### 2. Banco de dados

Crie o usuário e os bancos (dev e teste):

```sql
CREATE USER alfaos WITH PASSWORD 'sua_senha';
CREATE DATABASE alfaos OWNER alfaos;
CREATE DATABASE alfaos_test OWNER alfaos;
ALTER USER alfaos CREATEDB; -- necessário para a shadow database do Prisma Migrate
```

### 3. Configuração

```bash
cp .env.example .env
# edite DATABASE_URL e gere um AUTH_SECRET forte
```

Para gerar um secret:

```bash
openssl rand -base64 48
```

### 4. Instalar e migrar

```bash
npm install
npx prisma migrate deploy
npx prisma db seed
```

### 5. Rodar

```bash
npm run dev
# ou produção:
npm run build && npm start
```

## Scripts

| Comando              | Descrição                          |
| -------------------- | ---------------------------------- |
| `npm run dev`        | Servidor de desenvolvimento        |
| `npm run build`      | Build de produção                  |
| `npm run start`      | Inicia build de produção           |
| `npm run lint`       | ESLint                             |
| `npm run typecheck`  | TypeScript (`tsc --noEmit`)        |
| `npm run test`       | Testes automatizados (Vitest)      |
| `npm run test:watch` | Testes em modo watch               |
| `npx prisma db seed` | Popula dados de demonstração       |
| `npx prisma studio`  | UI para visualizar o banco         |

## Usuários de demonstração

Senha de todos: `AlfaOS@2026`

| Empresa          | Perfil     | E-mail                         |
| ---------------- | ---------- | ------------------------------ |
| Alfa Telecom     | ADMIN      | admin@alfatelecom.local        |
| Alfa Telecom     | DISPATCHER | dispatcher@alfatelecom.local   |
| Alfa Telecom     | TECHNICIAN | tech@alfatelecom.local         |
| Empresa Teste B  | ADMIN      | admin@empresatesteb.local      |

## Arquitetura

### Multi-tenancy

- Toda entidade de negócio possui `companyId`.
- A empresa é sempre determinada pelo **contexto do usuário autenticado**,
  nunca por `company_id` enviado pelo frontend.
- O isolamento é aplicado na camada de acesso a dados (`src/lib/users.ts`) e
  em todos os queries. Um usuário da Empresa A jamais acessa dados da
  Empresa B.
- Testes automatizados comprovam o isolamento (listar, buscar por ID e editar).

### Autenticação e autorização

- Login por e-mail + senha com hash bcrypt (12 rounds).
- Sessão via JWT em cookie `httpOnly` (12h).
- Usuários inativos não autenticam nem acessam APIs protegidas.
- Autorização por perfil (`ADMIN`, `DISPATCHER`, `TECHNICIAN`):
  - **ADMIN:** dashboard, usuários, integrações, configurações, perfil.
  - **DISPATCHER:** dashboard, módulos operacionais (OS, técnicos, clientes), perfil.
  - **TECHNICIAN:** apenas "Minhas OS" e perfil.
- Guards server-side em páginas (`src/lib/guards.ts`) e em APIs.
- Validação server-side com Zod em todos os endpoints.

### Integração ERP (desacoplada)

```
AlfaOS → ERPIntegrationContract → Adapter
```

- `src/integrations/contract.ts` — contrato (`ERPIntegrationContract`).
- `src/integrations/MockERPAdapter.ts` — adapter funcional para dev/testes.
- `src/integrations/ReceitanetAdapter.ts` — placeholder estrutural (a
  integração real será feita após o recebimento da documentação oficial da
  API do ReceitaNet; nenhum endpoint foi inventado).
- `src/integrations/index.ts` — factory `getERPAdapter(provider)`.

### Logs de auditoria

Toda ação relevante (login, login bloqueado/falho, criação/edição de usuário,
teste de integração ERP) é registrada em `audit_logs`, vinculada à empresa e
ao usuário que executou a ação.

## Estrutura de pastas

```
prisma/
  schema.prisma          # Modelo de dados
  migrations/            # Migrations
  seed.ts                # Dados de demonstração
src/
  app/
    (app)/               # Páginas protegidas (layout com sidebar)
    login/               # Login
    api/                 # Route handlers
  components/            # UI (sidebar, ícones, placeholders)
  integrations/          # Arquitetura ERP (contrato + adapters)
  lib/                   # auth, session, guards, prisma, audit, users, dashboard
  tests/                 # Testes automatizados (Vitest)
```

## API

| Método | Rota                              | Perfil  | Descrição                            |
| ------ | --------------------------------- | ------- | ------------------------------------ |
| POST   | `/api/auth/login`                 | pública | Autentica e cria sessão (cookie)     |
| POST   | `/api/auth/logout`                | pública | Encerra a sessão                     |
| GET    | `/api/users`                      | ADMIN   | Lista usuários da própria empresa    |
| POST   | `/api/users`                      | ADMIN   | Cria usuário na própria empresa      |
| GET    | `/api/users/:id`                  | ADMIN   | Busca usuário (escopo por empresa)   |
| PATCH  | `/api/users/:id`                  | ADMIN   | Atualiza usuário (escopo por empresa)|
| POST   | `/api/integrations/test-connection` | ADMIN  | Testa conexão com adapter ERP        |

## Segurança

- Senhas com hash bcrypt; nunca armazenadas em texto puro.
- JWT assinado com secret do ambiente (`AUTH_SECRET`).
- Cookie de sessão `httpOnly`; `secure` em produção.
- `company_id` sempre derivado do contexto autenticado (nunca do frontend).
- Nenhuma credencial exposta no frontend.
- Secrets apenas em `.env` (fora do Git). Exemplo: `.env.example`.

## Testes

14 testes em `src/tests/`:

1. Usuário válido consegue autenticar.
2. Senha errada é rejeitada.
3. Usuário inativo não acessa (login e API).
4. Empresa A não lista usuários da Empresa B.
5. Empresa A não busca usuário da Empresa B por ID.
6. Empresa A não edita usuário da Empresa B.
7. ADMIN consegue gerenciar usuários.
8. DISPATCHER não acessa configurações críticas.
9. TECHNICIAN não acessa administração.
10. MockERPAdapter executa `testConnection()` com sucesso.

O banco de teste (`alfaos_test`) é migrado automaticamente pelo Vitest
(`globalSetup`).

## Roteiro (próximas versões)

- Fluxo real de Ordens de Serviço (criação, execução, fechamento).
- Módulos de clientes e técnicos.
- Integração real com o ERP ReceitaNet (após documentação oficial da API).
- Fotos, assinatura, materiais, estoque, GPS/mapa, PDF, WhatsApp,
  notificações, integração OLT e IA.

## Limitações da v0.1

- Fluxo de OS ainda não implementado (apenas fundação).
- Integração ReceitaNet apenas como placeholder estrutural.
- Senha de recuperação/confirmação de e-mail ainda não implementados.
- Sem rate-limiting dedicado no login (recomendado para produção).

# Auditoria da Fundação — AlfaOS (v0.1-foundation → v0.1.1-hardening)

Este documento registra a auditoria do checkpoint `v0.1-foundation` e o que
foi corrigido no checkpoint `v0.1.1-hardening`.

## Escopo da auditoria

A auditoria avaliou seis dimensões: **Segurança**, **Multi-tenancy**,
**Estados do ERP**, **Layout mobile**, **Testes** e **Documentação**. A
conclusão foi: fundação estruturalmente sólida, com lacunas de hardening que
foram endereçadas sem reconstrução.

## Achados e correções

### Segurança

| # | Achado | Correção |
| --- | --- | --- |
| S1 | `AUTH_SECRET` sem validação de tamanho; valor padrão aceito em produção | `validateEnv` exige ≥ 32 chars, rejeita padrão em produção, falha cedo |
| S2 | Erros internos podiam vazar stack/SQL/Prisma | `runApi` — loga mensagem no servidor, responde 500 genérico |
| S3 | Sem rate limit de login (brute-force) | `LoginAttempt` + rate limit por e-mail (5/15min) e IP (20/15min) |
| S4 | Sem proteção CSRF nas rotas de escrita | `assertSameOrigin` em POST/PATCH |
| S5 | Sem headers de segurança | CSP, `nosniff`, `X-Frame-Options: DENY`, Referrer-Policy, Permissions-Policy, HSTS (prod) |
| S6 | Auditoria podia gravar valores sensíveis (senhas/tokens) | `sanitizeAuditDetails` (redação central) antes de qualquer gravação |
| S7 | Sessão JWT dependente de claims | Sessão revalidada no banco a cada request (perfil/status atual) |
| S8 | Logout com redirect estático | Redirect dinâmico via `new URL("/login", request.url)` |
| S9 | Teste de conexão ERP podia ser confundido com ativação | Teste não habilita integração; ativação é PATCH explícito |
| S10 | `AuditLog.company` em Cascade podia apagar histórico | FK alterada para `Restrict` |

### Multi-tenancy (validado, sem mudanças)

- Scoping por `session.companyId` em todas as consultas.
- Recursos de outra empresa retornam `404` (não revela existência).
- Coberto por testes (`tenancy.test.ts`).

### Estados do ERP (validado, sem mudanças)

- `lastTestStatus` (OK/ERROR/null) e `enabled` tratados como dimensões
  independentes: **Habilitado ≠ Conexão OK**.
- Novo endpoint PATCH `/api/integrations` para habilitação explícita.
- Testes de integração cobrem o comportamento (não auto-habilita; apenas
  admin altera).

### Layout mobile (correção)

- Sidebar fixa `w-64` quebrava em 390px → refatorada para **AppShell com
  drawer**: header mobile com menu hambúrguer, drawer deslizante + backdrop,
  sidebar desktop em `md:flex`.
- Tabelas com `overflow-x-auto` (usuários), grids responsivos (dashboard).
- Testes E2E com viewport 390×844.

### Testes (novos)

- Unit/integração (Vitest): rate limit (e-mail, IP, janela), sanitização de
  auditoria, CSRF/origin, revalidação imediata de perfil/status, edição de
  usuário, toggle de integração, validação de ambiente.
- E2E (Playwright): login → dashboard, RBAC técnico, criação de usuário,
  logout, integrações, mobile 390×844 (drawer + tabela).

### Documentação

- `docs/SECURITY.md`, `docs/ARCHITECTURE.md` e este documento.
- `.env.example` com as novas variáveis de rate limit.

## Fora de escopo (decisões conscientes)

Não foram implementados neste checkpoint (por escopo da fundação):
Clientes, Técnicos, OS (criação/execução/fechamento), fotos, assinatura,
materiais, PDF, estoque, GPS, notificações, integração real ReceitaNet, OLT
e IA. A arquitetura já está pronta para recebê-los (contrato de integração,
migrations incrementais, multi-tenancy).

## Comandos de verificação

```bash
npm run lint
npm run typecheck
npm run test        # Vitest (unit + integração) — usa alfaos_test
npm run e2e         # Playwright (Chromium headless) — sobe o app + seed
npm run build
```

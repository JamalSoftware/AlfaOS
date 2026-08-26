# AlfaOS — Claude Code Project Instructions

Este é um produto real em desenvolvimento.

## Antes de qualquer tarefa

Leia obrigatoriamente, em toda sessão nova:

1. `CLAUDE.md` (este arquivo)
2. Estado do Git: `git status`, `git branch --show-current`, `git log --oneline --decorate -10`, `git tag`
3. `docs/CONTEXT-MAP.md`

Depois, carregue **somente** a documentação relevante ao módulo/área da tarefa atual — siga o roteamento descrito em `docs/CONTEXT-MAP.md`. Não leia documentação de módulos não relacionados só por precaução.

Se houver documento de auditoria da versão atual e a tarefa tocar segurança, autorização, concorrência ou arquitetura crítica, leia-o antes de alterar código.

Não releia arquivos grandes na íntegra se já foram lidos nesta sessão e não mudaram desde então (confira com `git diff`/`git status` em vez de reler tudo).

Somente depois proponha alterações.

## Fonte de verdade

Use esta prioridade:

1. `docs/PRD.md`
2. `docs/ARCHITECTURE.md`
3. `docs/SECURITY.md`
4. documentação específica do módulo (roteada por `docs/CONTEXT-MAP.md`)
5. código e testes existentes

Se houver conflito, não decida silenciosamente. Informe antes de alterar arquitetura ou regra importante.

## Regras permanentes

Nunca:

* reconstruir o projeto do zero sem autorização;
* trocar a stack arbitrariamente;
* remover mecanismos de segurança;
* editar migrations históricas;
* mover ou recriar tags existentes;
* remover testes para obter build verde;
* mascarar erros;
* inventar endpoints externos;
* confiar em `company_id` enviado pelo frontend;
* permitir acesso cross-tenant;
* aceitar mass assignment;
* expor secrets;
* executar `npm audit fix --force`.

## Multi-tenancy

Toda entidade de empresa deve ser isolada server-side por `company_id`.

Empresa A nunca pode consultar, listar, alterar, vincular ou inferir recursos da Empresa B.

## Technician ownership

Um técnico somente pode acessar recursos operacionais autorizados para seu próprio registro Technician.

Nunca confiar em `technician_id` enviado pelo cliente para determinar autorização.

## Processo de desenvolvimento

Para cada tarefa:

1. analisar;
2. apresentar plano;
3. implementar apenas o escopo autorizado;
4. criar ou atualizar testes;
5. executar quality gates;
6. atualizar documentação relevante;
7. informar riscos e pendências.

## Quality gates

Antes de considerar uma tarefa concluída:

* `npm run lint`
* `npx tsc --noEmit`
* `npm test`
* Playwright E2E relevante
* `npm run build`
* `npx prisma validate` / `npx prisma migrate status` quando houver migration
* `npm audit` quando houver mudança de dependência

## Estratégia de testes

Durante o desenvolvimento, ciclo curto e focado:

mudança → teste focado (arquivo/módulo afetado) → mudança → teste focado.

Não rode a suíte inteira a cada edição pequena — isso é para o final.

Ao finalizar a tarefa (quality gates):

* testes do módulo afetado;
* `npm test` completo (Vitest);
* Playwright E2E necessário — o(s) fluxo(s) tocado(s), e a suíte crítica completa quando a mudança envolver autenticação, autorização ou concorrência;
* `npm run lint`;
* `npx tsc --noEmit`;
* `npm run build`;
* demais gates obrigatórios listados acima.

Nunca remover, reduzir ou pular quality gates para economizar tokens ou tempo.

## Context and Token Efficiency

* Usar o menor contexto suficiente para executar a tarefa corretamente.
* Não reler arquivos grandes na íntegra quando já foram lidos nesta sessão e não mudaram.
* Não carregar diretórios inteiros — localize com busca direcionada (símbolo, referência, padrão) antes de abrir arquivos.
* Pesquisar símbolos e referências antes de abrir muitos arquivos.
* Preferir `git diff`, `git show`, `git log` e busca direcionada a releitura exaustiva de código já conhecido.
* Durante o desenvolvimento, executar testes focados (ver "Estratégia de testes"); reservar a suíte completa para os quality gates finais.
* Não repetir o conteúdo inteiro do PRD (ou de outro doc extenso) em relatórios — referencie a seção.
* Não repetir arquitetura/documentação já existente nos relatórios — linke ou cite, não copie.
* Usar Sonnet como padrão para implementação comum, quando o escopo está claro e a arquitetura já foi decidida.
* Reservar Opus para: segurança, arquitetura crítica, concorrência, migrations delicadas, bugs difíceis (quando uma correção já tentada não resolveu) e auditoria adversarial independente.
* Não criar múltiplos subagentes para tarefas simples (CRUD, ajuste de UI pontual, documentação) — ver "Subagentes".
* A auditoria final de uma versão deve continuar sendo feita por quem não implementou aquela mudança.
* **Limite inegociável**: economia de tokens nunca pode reduzir segurança, validação, testes ou isolamento multi-tenant. Nenhuma regra desta seção justifica pular uma verificação de autorização, um teste de regressão ou um quality gate.

## Subagentes

Use subagentes somente quando houver ganho real:

* auditoria independente (sempre uma sessão/agente que não implementou a mudança sendo auditada);
* investigação complexa que consumiria muito contexto no fluxo principal;
* tarefa de segurança/superfície crítica que justifique um modelo mais forte (Opus);
* paralelismo verdadeiro (tarefas independentes que podem rodar ao mesmo tempo).

Não use agente separado para CRUD simples, ajuste pontual de UI ou documentação — faça no fluxo principal.

## Skills futuras

Skills específicas do AlfaOS podem ser criadas no futuro, quando reduzirem repetição real ou erros recorrentes observados em tarefas de fato repetidas — não antecipadamente. Candidatas identificadas até agora (não criar ainda):

* `alfaos-security-review`
* `alfaos-service-orders`
* `alfaos-testing`
* `alfaos-flutter`
* `alfaos-integrations`
* `alfaos-release`

## Git

Git é a fonte oficial do histórico.

Não alterar tags existentes.

Não fazer push remoto sem autorização explícita.

## Estado atual

O projeto possui:

* `v0.1-foundation`
* `v0.1.1-hardening`
* `v0.2-service-orders`
* `v0.2.1-audit-fixes`
* `v0.2.2-pre-v03-hardening`
* `v0.2.3-pre-v03-hardening`
* `v0.3-technician-execution`
* `v0.4-service-order-closing`
* `v0.5-receitanet-diagnostics`
* `v0.5.1-pilot-readiness`
* `v0.6-receitanet-callcenter`
* `v0.6.1-receitanet-hardening`
* `v0.6.2-erp-provider-binding`

**Baseline tagueada: `v0.6.2-erp-provider-binding`** — auditada e endurecida.

A trilha v0.6 entregou a integração ReceitaNet **CallCenter read-only**: busca de cliente, detalhe, diagnóstico de conectividade e chamados abertos por cliente, com a credencial de ERP vinculada criptograficamente a `(companyId, provider)`.

Depois dela, **concluído e sem tag** — a trilha v0.7, capability **Chatbot**:

* credenciais independentes por API (`CALLCENTER` e `CHATBOT`), com AAD versionado por linha (`v1`/`v2`);
* enriquecimento cadastral real do cliente — telefones, e-mail, endereço com número e referência, coordenadas, `externalContractId`;
* credencial PPPoE real do provider, com hierarquia de procedência (`MANUAL` nunca sobrescrita automaticamente);
* máscara de comprimento fixo da senha PPPoE e os dois telefones do cliente na OS.

E a **v0.7.3 — design system e temas** (também sem tag): tokens semânticos em `src/app/globals.css`, temas Claro/Escuro/Sistema com padrão `system`, seletor no rodapé da Sidebar, e `StatusPill` como componente de estado operacional. **Não escrever cor de paleta direto no componente** — use os tokens; ver `docs/PRD.md` §149 e `docs/CONTEXT-MAP.md`.

Também sem tag, **documentação apenas**: a Parte VI do PRD (§196–§209) — mapeamento geográfico da carteira, precedência entre origens de coordenada, cobertura de mapeamento, geocodificação, escalabilidade do mapa, fronteira com o FiberMap, Central de Despacho com arrastar e soltar, e Smart Dispatch. Nada disso existe em código, e **nada disso bloqueia o primeiro APK do Field** (§209).

E a **v0.7.4 — UX operacional do técnico** (sem tag): a OS do técnico passou a mostrar contato, endereço e navegação (Google Maps/Waze), diagnóstico enxuto e a descrição do serviço com peso próprio; saíram dela id interno, origem, número no ERP, card ReceitaNet e as ações administrativas de conexão. **A simplificação é do TECHNICIAN — ADMIN e DISPATCHER mantêm a tela completa.** Navegação contextual entre OS e cadastro usa `returnTo` com allowlist fechada mais verificação de tenant (`docs/SECURITY.md` §8.11).

Também sem tag, **documentação apenas, sem código**:

* geolocalização e mapa operacional (PRD Parte III, §133–§139);
* ReceitaNet operacional, UX do técnico e design system (Parte IV, §140–§149);
* **AlfaOS Field, toolkit do técnico e fundações de backend (Parte V, §150–§195)** — aplicativo Flutter, notificações push, `MobileDevice`, transactional outbox, fila de jobs, offline-first, evidências estruturadas, checklist dinâmico, `ToolExecution`, inventário como ledger. Nada disso existe em código.

**Checkpoint de segurança da v0.7.x — CONCLUÍDO, aguardando tag.** A auditoria independente encontrou 3 MEDIUM e ficou `BLOCKED`; os três bloqueadores (PPPOE-01, RATE-01, GATE-01) foram corrigidos em `3bfdf43`, `d7e51b3` e `d83648f`. A reauditoria focal em `d83648f` deu **`APPROVED WITH RISKS`** — 0 CRITICAL, 0 HIGH, 0 MEDIUM, 3 INFO aceitos — com todos os gates verdes (903 Vitest, 89 Playwright, lint, tsc, build, Prisma). Registro em `docs/V0.7-AUDIT.md`. **Nenhuma tag foi criada.**

Também sem tag, **documentação apenas**: a Parte VII do PRD (§210–§223) — custódia de patrimônio do técnico: `Asset`, `AssetCustody`, termo de cautela, conferência periódica, ocorrências e devolução. Um ledger só, compartilhado com o inventário (§211, §215); sem QR para ferramenta (§222); e o AlfaOS documenta sem julgar nem descontar (§219). Nada existe em código.

**Baseline publicada: `v0.7.5-audited-checkpoint`** — auditada, `APPROVED WITH RISKS`, no remoto.

Depois dela, **concluído e sem tag** — a **v0.8, sincronização de OS do ReceitaNet**: `/v1/chamados` → `ServiceOrder` EXTERNAL, **por cliente conhecido** (PRD §142). Ação explícita de ADMIN/DISPATCHER na tela do cliente, sem cron. **Nenhuma migration** — a unique de identidade externa e os campos já existiam.

Quatro invariantes da v0.8, todos cobertos por regressão:

* importação idempotente e à prova de corrida, pela unique `(companyId, externalProvider, externalId)`;
* **o AlfaOS é a fonte de verdade da execução** — re-sync não toca técnico, status, execução, evidências, materiais nem timeline;
* **ausência não é fechamento** — chamado que some não é cancelado nem apagado;
* `ServiceOrder.number` continua local; o número do provedor vive em `externalNumber`.

Três decisões fechadas na implementação: `protocolo` não é persistido, `tipo` não é traduzido (rótulo `Chamado ReceitaNet`, `typeId` nulo) e `data_previsao` não vira `scheduledAt`.

**Não existe descoberta global de OS.** Confirmado pelo suporte do ReceitaNet: nenhuma API pública lista as OS da empresa. É limitação do provider, não dívida do AlfaOS — não retomar a investigação, não fuzzar endpoint (PRD §141).

Geolocalização é capability oficial registrada e **não** entra na v0.7.x nem na v0.8 (PRD §131).

**A trilha Field não começou e não começa sozinha.** Nenhuma linha de Flutter, nenhum FCM, nenhum outbox, nenhum `ToolExecution` — a Parte V é especificação, e a §119 se aplica: estar no PRD não autoriza implementar. Duas escalas de prioridade convivem e precisam ser conferidas juntas: §117 classifica o produto (MVP/IMPORTANTE/DIFERENCIAL/FUTURO), §194 classifica a trilha Field (P0/P1/P2).

## Princípios

Integridade > velocidade

Segurança > conveniência

Regras de negócio > CRUD genérico

Testes confiáveis > quantidade de testes

Manutenibilidade > atalhos

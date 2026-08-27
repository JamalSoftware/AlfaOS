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
* `v0.7.5-audited-checkpoint`
* `v0.8-receitanet-service-orders`

**Baseline tagueada: `v0.8-receitanet-service-orders`** — auditada, reauditada e homologada em piloto real.

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

Checkpoint anterior: **`v0.7.5-audited-checkpoint`** — auditado, `APPROVED WITH RISKS`, no remoto.

**Baseline publicada: `v0.8-receitanet-service-orders`** — a **v0.8, sincronização de OS do ReceitaNet**: `/v1/chamados` → `ServiceOrder` EXTERNAL, **por cliente conhecido** (PRD §142). Ação explícita de ADMIN/DISPATCHER na tela do cliente, sem cron. **Nenhuma migration** — a unique de identidade externa e os campos já existiam. Implementada, auditada, corrigida, reauditada e **homologada em piloto real contra o ReceitaNet de produção**.

Seis invariantes da v0.8, todos cobertos por regressão:

* importação idempotente e à prova de corrida, pela unique `(companyId, externalProvider, externalId)`;
* **o AlfaOS é a fonte de verdade da execução** — re-sync não toca técnico, status, execução, evidências, materiais nem timeline;
* **ausência não é fechamento** — chamado que some não é cancelado nem apagado;
* `ServiceOrder.number` continua local; o número do provedor vive em `externalNumber`;
* **`idSuporte` inválido recusa o lote inteiro** — inteiro positivo ou `INVALID_RESPONSE`, sem importação parcial e sem identidade adivinhada;
* **no-op não escreve** — releitura idêntica não gera `UPDATE` nem move `version`; mudança real do provider ainda incrementa.

Três decisões fechadas na implementação: `protocolo` não é persistido, `tipo` não é traduzido (rótulo `Chamado ReceitaNet`, `typeId` nulo) e `data_previsao` não vira `scheduledAt`. **Nenhum dos três é guardado em metadata** — o código chegou a afirmar que `tipo` e `data_previsao` ficavam lá, e não ficavam.

**Auditoria focal da v0.8:** `APPROVED WITH RISKS` — 1 MEDIUM (SYNC-01) e 2 LOW (SYNC-02, SYNC-03), corrigidos em `8cb890d` e `36cee27`. A **reauditoria independente** fechou os três: 0 CRITICAL, 0 HIGH, 0 MEDIUM, 0 LOW, 2 INFO aceitos — `APPROVED WITH RISKS`, liberando o piloto real.

**Piloto real — 2026-08-27, `PILOT PASS`.** Um cliente real com chamado aberto, pela UI oficial, contra o ReceitaNet de produção. `POST /v1/chamados` foi o único endpoint tocado; nenhuma rota mutante. Primeiro sync: 1 chamado → 1 OS EXTERNAL, `PENDING`, sem técnico, número local próprio, `externalNumber` do provedor, 1 evento `SERVICE_ORDER_IMPORTED`, Customer inalterado. Segundo sync do mesmo chamado: `unchanged=1`, com `version`, `updatedAt` e contagem de eventos **inalterados** — **SYNC-03 validado fora do laboratório**. Registro em `docs/RECEITANET-HOMOLOGATION.md`. Três caminhos não ocorreram ao vivo e seguem só com regressão: `INVALID_RESPONSE`, resposta com exatamente 10 chamados e mudança real de campo provider-owned entre syncs.

**Não existe descoberta global de OS.** Confirmado pelo suporte do ReceitaNet: nenhuma API pública lista as OS da empresa. É limitação do provider, não dívida do AlfaOS — não retomar a investigação, não fuzzar endpoint (PRD §141).

Geolocalização é capability oficial registrada e **não** entra na v0.7.x nem na v0.8 (PRD §131).

Depois dela, **concluída e sem tag** — a **v0.9, fundação de backend do Field**: a superfície que o aplicativo Flutter vai consumir. **Nenhuma linha de Flutter foi escrita.**

O princípio que a governa: **o Field é outro cliente do MESMO AlfaOS**. Máquina de estados, posse, tenancy, elegibilidade, CAS, timeline e auditoria são os serviços que a web já usa — a camada Field autentica, desduplica, projeta e chama. Nenhuma regra de negócio foi duplicada.

* namespace `/api/field/v1` (versão no caminho: APKs antigos convivem em campo);
* **token opaco preso a `MobileDevice`**, guardado como SHA-256, com revogação server-side imediata. **Não é o cookie da web** (JWT sem estado é irrevogável) e **não é um JWT novo** (não pagaria por si mesmo, já que a consulta ao banco acontece de qualquer forma);
* só `Authorization: Bearer` — nunca cookie, nunca query string. É o que elimina CSRF nesta superfície e por que ela não usa `assertSameOrigin`;
* contrato de erro com `code` estável + `retryable`/`conflict` derivados, para o Flutter nunca interpretar mensagem humana;
* `Idempotency-Key` escopada por `(empresa, usuário, operação, chave)`; **só o sucesso é memorizado**;
* `expectedVersion`/CAS para conflito — as duas proteções respondem perguntas diferentes e não se substituem;
* `Notification` + `OutboxEvent` na **mesma transação** da atribuição; worker por comando (`npm run outbox:work`), sem Redis; push é abstração inerte, sem FCM real;
* DTOs próprios: sem CPF, sem senha, sem `externalProvider` — a ausência do dado de provider é o que impede um `if (RECEITANET)` no aplicativo.

Uma migration **aditiva**: `MobileDevice`, `Notification`, `OutboxEvent`, `IdempotencyRecord`. Nenhum dado da v0.8 foi tocado.

Documentação: `docs/FIELD-API.md` (contrato) e `docs/SECURITY.md` §8.13 (segurança). A §8.9 continua descrevendo o que **não** existe.

**Endurecimento pós-auditoria independente (sem tag).** A auditoria apontou 2 MEDIUM e 5 LOW; todos foram reproduzidos antes de qualquer mudança e corrigidos:

* **OBX-01** — `OutboxEvent` em `PROCESSING` ficava preso para sempre (nada procurava por esse estado, e o requeue só aceita `FAILED`). Agora a reivindicação tem **lease de 5 min**, prazo vencido volta à fila, e o teto de tentativas vale também no reclaim. Entrega é **at-least-once**, declarada.
* **REV-01** — `revokeDevice` e `requeueFailedOutboxEvent` não tinham rota: o ADMIN não conseguia cortar o acesso de um celular perdido pela aplicação. Agora existe `/dispositivos` e as rotas `ADMIN` de revogação e requeue.
* **REV-02** — o login **reativava** aparelho revogado. Agora recusa com `DEVICE_REVOKED`; instalação nova continua registrando, então revogar não bloqueia a pessoa.
* **IDM-01** — reserva `IN_FLIGHT` travava a chave por 24 h se o processo morresse. **Lease de 2 min** com tomada arbitrada pelo banco; a tomada re-executa, e quem impede a mutação dupla é o domínio (CAS + máquina de estados).
* **START-01** — o `start` relia a OS depois do commit e devolvia 404 se ela fosse reatribuída no intervalo. A resposta agora vem da própria mutação.
* **TEST-01** — a corrida de idempotência só era testada pela rota, onde o CAS mascarava regressão. Teste direto de `withIdempotency` com handler-contador; provado por reversão (10 execuções em vez de 1).
* **OPS-01** — o worker rodava com `tsx`, devDependency: quebrava após `npm prune --omit=dev`. Agora é compilado por `npm run build` e executado com `node`.

Reversão verificada nos dois sentidos para OBX-01, TEST-01 e START-01.

**A trilha Flutter não começou.** Nenhum APK, nenhum FCM real, nenhum offline no cliente, nenhuma conclusão de OS pelo Field, nenhuma evidência estruturada, nenhum `ToolExecution`, nenhum item do toolbox — a §119 se aplica ao resto da Parte V: estar no PRD não autoriza implementar. Duas escalas de prioridade convivem e precisam ser conferidas juntas: §117 classifica o produto (MVP/IMPORTANTE/DIFERENCIAL/FUTURO), §194 classifica a trilha Field (P0/P1/P2).

## Princípios

Integridade > velocidade

Segurança > conveniência

Regras de negócio > CRUD genérico

Testes confiáveis > quantidade de testes

Manutenibilidade > atalhos

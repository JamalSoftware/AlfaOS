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
* `v0.9-field-backend-foundation`
* `v0.10-field-execution-closing`
* `v0.11-employee-time-clock`

**Baseline tagueada: `v0.11-employee-time-clock`** — auditada em clean-room e publicada. As anteriores continuam válidas e não são renumeradas.

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

Depois dela, **publicada: `v0.9-field-backend-foundation`** — a **v0.9, fundação de backend do Field**: a superfície que o aplicativo Flutter vai consumir. **Nenhuma linha de Flutter foi escrita.**

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

**Endurecimento pós-auditoria independente.** A auditoria apontou 2 MEDIUM e 5 LOW; todos foram reproduzidos antes de qualquer mudança e corrigidos:

* **OBX-01** — `OutboxEvent` em `PROCESSING` ficava preso para sempre (nada procurava por esse estado, e o requeue só aceita `FAILED`). Agora a reivindicação tem **lease de 5 min**, prazo vencido volta à fila, e o teto de tentativas vale também no reclaim. Entrega é **at-least-once**, declarada.
* **REV-01** — `revokeDevice` e `requeueFailedOutboxEvent` não tinham rota: o ADMIN não conseguia cortar o acesso de um celular perdido pela aplicação. Agora existe `/dispositivos` e as rotas `ADMIN` de revogação e requeue.
* **REV-02** — o login **reativava** aparelho revogado. Agora recusa com `DEVICE_REVOKED`; instalação nova continua registrando, então revogar não bloqueia a pessoa.
* **IDM-01** — reserva `IN_FLIGHT` travava a chave por 24 h se o processo morresse. **Lease de 2 min** com tomada arbitrada pelo banco; a tomada re-executa, e quem impede a mutação dupla é o domínio (CAS + máquina de estados).
* **START-01** — o `start` relia a OS depois do commit e devolvia 404 se ela fosse reatribuída no intervalo. A resposta agora vem da própria mutação.
* **TEST-01** — a corrida de idempotência só era testada pela rota, onde o CAS mascarava regressão. Teste direto de `withIdempotency` com handler-contador; provado por reversão (10 execuções em vez de 1).
* **OPS-01** — o worker rodava com `tsx`, devDependency: quebrava após `npm prune --omit=dev`. Agora é compilado por `npm run build` e executado com `node`.

Reversão verificada nos dois sentidos para OBX-01, TEST-01 e START-01.

**Checkpoint da v0.9 — PUBLICADO.** A reauditoria independente focal, feita por uma sessão que não implementou nem endureceu, atacou os sete achados com testes próprios contra Postgres real e fechou em **`APPROVED WITH RISKS`** — 0 CRITICAL, 0 HIGH, 0 MEDIUM, 0 LOW, 5 INFO aceitos —, com quatro provas de reversão e todos os gates verdes (1095 Vitest, 89 Playwright, lint, tsc, build, Prisma, 17 migrations). Decisão: `GO`. Registro em `docs/V0.9-AUDIT.md`. Tag anotada **`v0.9-field-backend-foundation`**, no remoto.

Os cinco INFO aceitos, todos não bloqueantes: o `now` do outbox não governa a escrita do lease (nenhum caller o passa hoje); não há expurgo de outbox `PROCESSED` nem de reserva vencida; `/dispositivos` não tem teste permanente próprio; `DEVICE_REVOKED` acontece antes de `recordLoginAttempt`; e `zod` em `devDependencies` é pré-existente e não afeta o worker.

Depois dela, **publicada: `v0.10-field-execution-closing`** — a **v0.10, execução e fechamento em campo**, backend e Flutter. O aplicativo do técnico existe e executa o atendimento inteiro: localização, check-in, relatório, checklist dinâmico como snapshot, evidências categorizadas, materiais sob lock, equipamento instalado, assinatura vinculada ao conteúdo e conclusão validada por tipo de OS. Três regras nasceram nela: **a identificação do equipamento é a FOTO da etiqueta** (série e MAC viraram opcionais), a etiqueta passa por estágio `TEMPORARY` → `COMMITTED` com TTL, e o vínculo foto↔equipamento é 1:1. Inventário do que entrou: PRD **§225**.

**Jornada / Ponto — Fase 1 `PUBLISHED`.** Tag anotada **`v0.11-employee-time-clock`**, no commit `f057ee1`, no remoto. Entregou `Workday`, `TimeEntry` imutável, `TimeAdjustmentRequest`, `Company.timezone`, as rotas `/api/field/v1/time-clock/*` e `/api/time-clock/*`, a tela `/jornada` com a página por funcionário e a jornada no Field — batida, espelho do dia, histórico e correção com aprovação/rejeição. Homologada em piloto físico, endurecida e **auditada em clean-room de forma independente**: `APPROVED WITH RISKS`, `RELEASE GO` — 0 CRITICAL, 0 HIGH, 0 MEDIUM, 1 LOW, 3 INFO. Registro: PRD **§252**.

Das pendências registradas na PRD **§253**, **três foram fechadas no endurecimento final**: quem abre uma correção não a decide quando a jornada é a própria (LOW-1); a criação administrativa web passou a exigir `Idempotency-Key`, na mesma infraestrutura do Field (LOW-2); e o horário solicitado é montado no fuso da **empresa**, que agora viaja no DTO como `WorkdayView.utcOffset` (LOW-3). No mesmo endurecimento, o Field passou a ter **uma única** porta de correção (§258). A auditoria clean-room final encontrou mais quatro. **Dois foram fechados no patch focal v0.11.1**: **JOR-A1** (`LOW`) — dia histórico deixado `WORKING` acumulava `workedMinutes` até `now()` a cada leitura, e agora só conta intervalo com as **duas pontas provadas**, com o parcial até agora valendo só para o **dia corrente** decidido pelo fuso da empresa (`summarize` virou função pura, recebendo `openEndsAt`); e **JOR-A2** (`INFO`) — as inconsistências passaram a aparecer no Field e no **espelho web individual** (`/jornada/[userId]`, que navega por dia), sem CTA novo, e o sinal deixou de disparar para quem está trabalhando agora. Isso **levantou o `BLOCKED BY JOR-A1`** do Attendance Report (PRD §303) sem promovê-lo a implementado: ele continua `P1`/`PLANNED`. **Continuam pendentes: JOR-A3** e **JOR-A4** (`INFO`), e **JOR-05** — `Company.timezone` não tem superfície administrativa; o padrão `America/Sao_Paulo` atende e não bloqueia.

A auditoria focal sobre o v0.11.1 encontrou mais cinco, todos `INFO`, registrados na PRD **§253**: **JOR-B1** — a lista da equipe (`/jornada`) tem o campo e o JSX de `inconsistencies`, mas a página nunca pede um dia diferente do corrente, então o alerta nunca renderiza em produção lá (só no espelho individual, que navega por dia); **JOR-B2** — o parcial do dia corrente ganhou teste permanente com tolerância curta, sem `sleep`; **JOR-B3** — `openPeriodEnd` decide "é hoje?" pelo fuso ATUAL da empresa, não pelo fuso sob o qual o dia foi vivido; **JOR-B4** — pela mesma razão, **bloqueia JOR-05**: uma UI de configuração de fuso não deve nascer antes de o lookup de `Workday` por instante parar de depender do fuso atual para achar dia histórico; **JOR-B5** — a instabilidade Flutter sob paralelismo relatada no patch anterior não se reproduziu nesta auditoria.

Também sem código, **documentação apenas**: as **Partes IX e X do PRD (§252–§287)** — o Field como **workspace do técnico** e não como app de OS (§254), o App Shell híbrido e a gaveta categorizada (§255, §256), o dashboard `Início` (§257), a porta única da correção de jornada (§258), mapa/agenda/estoque no Field (§259–§263), o hub de ferramentas e o assistente de roteador (§264, §265), e a **plataforma de contratos e assinatura eletrônica** inteira (§266–§287): modelos versionados, dicionário de variáveis, PDF multipágina, assinatura vinculada ao hash, validador público e entrega. **Nada disso existe em código.**

Depois dela, **documentação apenas, sem código**: a **Parte XI do PRD (§288–§307)** — **Escala de Trabalho e Espelho de Jornada**, addendum aprovado sobre plantão, folga, DSR, sábado alternado (regra recorrente × ocorrência, com exceção auditada), troca de plantão, escala por equipe, "Minha Escala" no Field, notificações, planejado × realizado e o Attendance Report em PDF/CSV. A regra que atravessa a Parte inteira: **Escala é planejado, Jornada/Ponto é realizado — `PLANTAO`/`FOLGA`/`DSR` nunca criam `TimeEntry`** (§288, §300). O Attendance Report não pode implementar cálculo de horas próprio — consome o mesmo `resolveEffectiveTimeEntries` de `src/lib/time-clock.ts` (§302); o `BLOCKED BY JOR-A1` (§303) foi levantado na v0.11.1, e mesmo assim **nada disso existe em código**.

**App Shell do Field + Device UX Hardening — entregues, `main` local, sem tag e sem push.** O Field deixou de ter a Jornada escondida na terceira aba ("Mais") e ganhou a navegação híbrida que o PRD §255 já descrevia: barra principal com **Início, OS e Jornada**, gaveta global, sino de notificações no cabeçalho, e o dashboard `Início`. **Mapa não é destino da barra** — o próprio §255 previa isso ("fica vago ou traz Agenda" enquanto o módulo não existe), e nem Mapa nem Agenda têm código.

**O primeiro piloto físico aprovou arquitetura e navegação, e reprovou o visual.** O hardening que respondeu a ele trouxe: a gaveta como **mapa do Workspace inteiro** (seis categorias, 21 itens) com o planejado marcado por selo `EM BREVE`; um **HERO** no Início com saudação, empresa e resumo do dia; o bloco **`ATENÇÃO AGORA`** com até três OS que pedem ação; e `NavigationBar` tematizada.

**A política do §256 foi REVISTA por causa desse piloto** — antes "item que não existe não aparece", agora a barra só recebe implementado e a gaveta apresenta o roadmap com o planejado marcado. A honestidade saiu da omissão e foi para o selo **e a ausência de rota**: item planejado tem `route == null`, abre **uma** folha genérica ("Módulo em preparação"), e um teste permanente prova que nenhum dos 15 carrega rota.

Duas regras que não podem ser desfeitas: **"Próxima OS" continua exigindo `scheduledAt` real** — o bloco `ATENÇÃO AGORA` existe justamente para a OS **sem** agendamento (o caso real do ReceitaNet no piloto), sem chamar nada de "próxima"; e **o card de OS não mostra origem de provedor**, porque o DTO do Field omite `origin`/`externalProvider` de propósito (`src/lib/field/dto.ts`) — a ausência do dado é o que impede um `if (RECEITANET)` no aplicativo. Um badge exigiria mudança de contrato no backend, não de tela.

Dois achados corrigidos durante a implementação, não só relatados: a gaveta nasceu presa ao `Scaffold` de cada tela e colidia com a barra inferior (corrigido dando a ela um dono único); e o teste de responsividade que escrevi encontrou **três overflows reais** em tela de 360dp — hero chip, linha do card de Jornada e linha do card de OS. Auditoria focal (não clean-room, compensada com ataques novos): `APPROVED WITH RISKS`, 0 CRITICAL/HIGH/MEDIUM. Nenhuma migration; nenhum arquivo web/backend tocado. Gates verdes: 1423 Vitest e 99 Playwright inalterados, 269 Flutter no momento daquele commit — **hoje 280**, depois do Visual Polish —, APK debug construído. **Aguarda SEGUNDO piloto em aparelho físico antes de tag e push** — patch visual não se aprova por widget test.

**Visual Polish do Field Workspace — terceiro commit local (`da86c8f`), sem tag e sem push.** O piloto descreveu o aplicativo como "monocromático, muito próximo do Material padrão", e a causa não era falta de cor espalhada: era falta de decisão em três lugares que só existem no tema — `TextTheme` de fábrica, `ColorScheme.fromSeed` cru e metade dos componentes sem tema. Corrigido no tema, não nas telas; a cor continua **contida** (marca ação e estado, nunca decora). Contrato registrado em `apps/field/DESIGN.md`. Gates verdes, APK construído. **Continua aguardando o segundo piloto físico.**

Também sem código, **documentação apenas**: a **Parte XII do PRD (§308–§332)** — **Fila Operacional de OS**: prioridade × posição, fila por `(empresa, técnico)`, posição explícita com o backend como autoridade, alteração de prioridade, reordenação, reatribuição, concorrência, idempotência, invariantes, eventos, fila no Field e no despacho Web, offline, opções de schema, aceite e casos de borda. A regra que atravessa a Parte: **prioridade responde criticidade, posição responde sequência** (§309) — e hoje o AlfaOS não tem como expressar a segunda, então a operação a escreveria por cima de `priority` ou de `scheduledAt`, corrompendo dado para expressar ordem (§308).

Três achados registrados na auditoria do modelo atual (§310), **nenhum corrigido**: `priority` é gravada na criação e **não tem caminho de alteração**; a ordenação depende da ordem de declaração do enum em Postgres, não de regra escrita; e `SERVICE_ORDER_PRIORITY_ORDER` (`src/lib/service-orders.ts`) é **código morto**. Um quarto, na §321: o AlfaOS **permite** hoje mais de uma OS `IN_PROGRESS` por técnico — não é estado legado.

**Plano de implementação fechado: `docs/DISPATCH-QUEUE.md`** — ainda sem código. As onze decisões (`D-01`–`D-11`) foram todas resolvidas: **quatro bandas** de precedência (`URGENT > HIGH > NORMAL > LOW`, enum intacto, colapso só na ação rápida `Normal ↔ Urgente`), **agregado próprio** `TechnicianDispatchQueue` + `Entry` com `version` de fila, e **posição global normalizada** 1..N. O documento traz schema conceitual, algoritmo de normalização, as sequências de transação, os endpoints (a reatribuição **evolui** `/assign`, não duplica), DTOs, backfill, matriz de teste e as fases `DQ-1`–`DQ-7`.

Duas coisas do plano que não podem se perder: o `expectedVersion` da OS **não** protege uma reordenação — ela escreve N linhas e o CAS responde por uma —, então a fila tem `version` própria mais `FOR UPDATE`, o mesmo par que a Jornada usa; e a decisão por posição **global** tem um preço declarado: a invariante "urgente precede normal" **deixa de ser garantida pelo banco** e vira invariante de aplicação, reestabelecida pela normalização e sustentada por teste de concorrência com prova de reversão.

**`DQ-1` ENTREGUE — commit local, sem tag e sem push.** A fundação de persistência: `TechnicianDispatchQueue` + `TechnicianDispatchQueueEntry`, migration **aditiva** (`20260830120000`, 2 tabelas, 4 uniques, 5 FKs, zero `DROP`, zero dado tocado), e as primitivas puras em `src/lib/dispatch-queue.ts`. **Nada consome a fila**: sem rota, sem tela, sem serviço, sem backfill — nenhuma fila é criada por caminho nenhum.

Três coisas que o código corrigiu no plano: `Technician → Queue` é **`Restrict`**, não `Cascade` (toda relação do Technician no schema é Restrict, e desativar é a operação suportada); a entrada ganhou **`companyId` próprio**, para filtrar tenant em SQL em vez de navegar a FK; e a unique `(companyId, technicianId)` **sozinha não bastava** — ela aceita duas filas do mesmo técnico sob companyIds diferentes, então entrou também uma unique em `technicianId`.

`SERVICE_ORDER_PRIORITY_ORDER` foi **removida** (grep provou zero consumidores). A precedência agora é `DISPATCH_BAND`, com orientação ascendente (`URGENT: 0`) — a mesma do ranking do Field. `ORDER BY priority` continua acertando por coincidência da ordem de declaração do enum, e deixou de ser autoridade.

Gates: 1459 Vitest (era 1423), 99 Playwright, 280 Flutter, lint, tsc, build, 23 migrations. Três provas de reversão executadas e revertidas, sem drift.

**`DQ-2` ENTREGUE — commit local, sem tag e sem push.** A fila passou a acompanhar as operações de OS: `placeAssignedOrder` no `assignTechnician` (atribuição e reatribuição), `removeOrderFromQueue` no `startServiceOrder` e no `completeServiceOrder`, tudo **dentro das transações que já existiam**. Mais as primitivas de reorder e de mudança de prioridade — **sem rota**, que é DQ-3 — e o backfill idempotente (`npm run dispatch:backfill`), validado contra o banco de dev real: segunda execução devolveu `0/0/0`.

**O teste de deadlock encontrou um defeito real da minha implementação, antes de ele sair da fase.** `placeAssignedOrder` travava a fila de **destino** primeiro e só depois ordenava o par por `id` — e ordenar depois de travar é o mesmo que não ordenar. Agora os dois `id` são descobertos **antes** de qualquer `FOR UPDATE`. Se a OS escapar para uma terceira fila nesse intervalo, a resposta é 409, não um lock fora de ordem.

**E a sabotagem de tenancy expôs um teste meu que passava pelo motivo errado**: sem a validação, `moveOrderToPosition` ainda devolvia 404 por outro caminho e a transação inteira voltava, então a fila cruzada nunca persistia. O ataque que o rollback não esconde é `placeAssignedOrder`, que **concluiria** gravando fila com `companyId` de A e técnico de B. O teste foi reescrito para lá.

Três decisões que não podem ser desfeitas: `version` só anda quando houve **mudança real** (por isso o backfill deixa em 0 a fila que ele mesmo criou — ninguém tinha token de CAS para invalidar); a renumeração é em **duas fases** (negar tudo, depois reescrever 1..N), porque a unique `(queueId, position)` não é `DEFERRABLE`; e o backfill ordena por `assignedAt`, não `createdAt`/`number` — a pergunta da fila é há quanto tempo a OS está **com este técnico**.

**Índice em `ServiceOrder.technicianId` NÃO foi adicionado**: a única consulta nova que filtra por ele é o backfill, que **quer** varredura completa e roda uma vez, offline.

Gates: 1498 Vitest (era 1459), 99 Playwright, 280 Flutter, lint, tsc, build, 23 migrations — **nenhuma nova**. Cinco sabotagens, cinco detectadas.

**`DQ-3` ENTREGUE — commit local, sem tag e sem push.** Três rotas administrativas: `GET /api/dispatch/technicians/[id]/queue`, `POST .../queue/reorder` e `POST /api/service-orders/[id]/priority`. A quarta do plano — a leitura do Field — é **DQ-5** pela tabela de fases, e não foi antecipada.

**A rota de prioridade fecha uma lacuna que não era da fila**: até aqui `priority` era gravada na criação e nunca mais mudava, porque a rota de detalhe só expunha `GET`. Ela aceita os **quatro** valores do enum, não dois — OS reais já têm `HIGH` e `LOW`, e sem o enum inteiro não haveria como tirar uma delas de um `HIGH` legado. A ação rápida `Normal ↔ Urgente` é atalho de UI, não contrato de API.

Três decisões que não podem ser desfeitas: **dois agregados exigem dois CAS** (`expectedVersion` da OS e `expectedQueueVersion` da fila), e o segundo é exigido **pelo domínio, não pelo schema** — uma OS sem técnico não tem fila a comparar, e torná-lo obrigatório no zod bloquearia esse caso; a API **não expõe `moveUp`/`moveDown`**, só alvo absoluto; e `/assign` foi **evoluída**, não duplicada — ganhou `targetPosition` opcional e manteve a resposta exatamente como era.

**O teste de corrida falhou e a culpa era dele, não do código**: eu havia montado duas reordenações para a posição 1, mas uma caía onde a OS **já estava** depois da acomodação de banda — e no-op não incrementa `version`, então o segundo CAS passava legitimamente. A montagem foi corrigida, e a propriedade descoberta virou teste próprio: um clique que não mexe na fila não invalida o CAS de mais ninguém.

Gates: 1543 Vitest (era 1498), 99 Playwright, 280 Flutter, lint, tsc, build, **nenhuma migration**. Seis sabotagens, seis detectadas. Nenhuma UI, nenhum Dart, nenhum push.

**`DQ-4` ENTREGUE — commit local, sem tag e sem push.** A tela `/despacho`, sobre as rotas da DQ-3: fila por técnico, `EM ATENDIMENTO` como coleção, posição `1ª/2ª/3ª`, ação rápida `Normal ↔ Urgente`, seletor completo dos quatro valores, `↑ ↓`, `Mover para…`, arrastar e reatribuir. **Nenhuma API nova, nenhum schema, nenhum Dart.**

O princípio: **a tela não é autoridade**. Toda ação substitui o estado local pela resposta — `queueVersion` nunca é incrementada no cliente, e promover não é presumido como "vai para a 1ª": o servidor acomoda dentro da banda e a posição efetiva é a que voltou. Arrastar usa HTML5 nativo, **sem dependência nova**, e não é a única forma de operar — as setas funcionam só com teclado.

**Um defeito real de bundle, achado pelo E2E**: o componente cliente importava os rótulos de `@/lib/service-orders`, que alcança `node:crypto`, e o webpack derrubava a página de **login** inteira. Os rótulos foram para `src/lib/service-order-labels.ts` (só `import type` do Prisma); `service-orders.ts` reexporta, então nada mais mudou.

**Duas sabotagens passaram — porque faltavam os testes.** Reutilizar `queueVersion` velha não falhava (nenhum teste fazia duas mutações seguidas), e o double-submit também não (a proteção é em duas camadas). Os dois testes foram escritos, e só então as sabotagens caíram.

**Três falhas que só a suíte inteira mostra**, todas do meu spec: ele deixava OS `ASSIGNED` e vínculos de `Technician` para trás, quebrando `technician-execution`, `team-workday` e `service-orders` — cuja tela "novo técnico" só lista usuários **não** vinculados. Isolados, os testes passavam. O spec agora devolve o banco como o encontrou.

**Um defeito latente pré-existente, sem relação com a fase**: `time-clock-routes` usava `Date.now() - 30min` como horário de correção, o que cai no dia civil **anterior** entre a meia-noite e as 00:30 no fuso da empresa. A rota devolvia 404 corretamente e o teste falhava por outro motivo. Corrigido com piso no início do dia civil.

Gates: 1543 Vitest, **116 Playwright** (era 99), 280 Flutter, lint, tsc, build, **nenhuma migration**. Risco registrado: **`/assign` continua sem `Idempotency-Key` obrigatória** — a proteção do painel é de tela e cobre duplo clique, não reenvio após timeout.

**`DQ-5` ENTREGUE — commit local, sem tag e sem push.** `GET /api/field/v1/dispatch-queue`: a fila do técnico autenticado, na ordem que o despachante definiu. **Backend apenas — nenhum arquivo Dart mudou**, e o aplicativo continua no ranking local até DQ-6.

Quatro decisões que não podem ser desfeitas: **não existe `?technicianId=`** (o dono vem do token, e há teste enviando `technicianId` e `companyId` de outro tenant para provar que não são lidos); **somente leitura** (um teste afirma que a rota exporta só `GET` — o técnico recebe a ordem, não a negocia); **sem fallback no servidor** (técnico sem fila devolve **vazio**, porque esconder o fallback no backend faria o aplicativo achar que obedece ao despacho quando ele não disse nada — a decisão é do cliente, pela presença de `position`); e **o Field não reordena** (a fila persistida já nasceu com a precedência aplicada; reaplicá-la na leitura criaria uma segunda autoridade).

`no-store` **explícito**, ao contrário das demais leituras do Field: uma lista servida do cache mostra dado velho e a pessoa percebe; uma **fila** servida do cache faz o técnico trabalhar na **ordem errada** sem nenhum sinal.

O teste central é o de **integração Web → Field**: reordenar pela rota administrativa que o painel usa, commitar, e ler pela rota do Field — nos dois sentidos. É exatamente o que o piloto observou.

Gates: 1561 Vitest (era 1543), 116 Playwright, 280 Flutter, lint, tsc, build, **nenhuma migration**. Cinco sabotagens, cinco detectadas.

**Bug bloqueante do piloto físico, registrado para DQ-6: o `Voltar` do Android FECHA o aplicativo** em várias telas principais, em vez de navegar. Regra aprovada: detalhe → anterior; gaveta aberta → fecha a gaveta; modal → fecha o modal; OS/Jornada sem pilha → Início; **só no Início na raiz** o Android sai. **Não corrigido em DQ-5**, que é backend.

Também sem código, **documentação apenas**: a **Parte XIII do PRD (§333–§341)** e `docs/CTO-NETWORK-DISTRIBUTION.md` — **CTOs e Rede de Distribuição**: a caixa, suas portas, o vínculo do cliente e o histórico da movimentação, mais a reutilização do status de conectividade que já existe.

**Esta Parte REVÊ a §202**, que proibia cadastro de CTO no AlfaOS ("o AlfaOS não duplica topologia de rede"). A revisão está escrita, não é silenciosa: a regra prescrevia **consultar** o FiberMap, que é `FUTURO` sem código e sem data — e **duplicação exige dois cadastros**. Não havendo integração, não havia dois, havia **nenhum**, e o técnico ia ao poste sem saber a caixa. A fronteira deixou de ser "não cadastrar" e passou a ser **precedência**: com FiberMap integrado, ele manda na topologia **física** (cabo, splitter, PON, OLT) e o AlfaOS no vínculo **operacional** (quem está em qual porta, desde quando, por qual OS). As quatro seções que afirmavam o contrário — §107, §202, §234 e §259 — foram corrigidas na mesma tarefa.

Quatro decisões que não podem ser desfeitas: **`Customer.ctoId` não serve** (responde "onde está agora" e destrói "onde estava", e não representa porta livre); **a porta é o ponto de concorrência e quem arbitra é o banco**, não a aplicação — dois técnicos, dois celulares, a mesma porta 4; **nenhuma integração nova de status** (a CTO lê o `CustomerDiagnosticSnapshot` que a OS já usa); e **movimentação preserva história** — fechar o vínculo antigo e abrir o novo, nunca `UPDATE` destrutivo.

**O limite que decide o escopo de CTO-5 e CTO-6**, levantado no código: o refresh do diagnóstico é **sob demanda com gatilho na OS** (sem cron), e a capability usa o teto padrão de **10 chamadas por minuto por empresa** — uma CTO de 8 portas consumiria 8 delas. Por isso a CTO apresenta o **último estado conhecido com a IDADE da leitura**, e não promete tempo real. "Possível falha coletiva" (CTO-6) é a fase que mais depende de resolver esse frescor.

**QR é OPCIONAL, e o padrão é desligado** — com ele off, nenhuma função principal fica indisponível.

**Isto NÃO muda o próximo passo: continua sendo `DQ-6`** (Field consumindo a fila autoritativa + Android Back). CTO entra depois da sequência da fila estar concluída e publicada. *(Registro do momento em que a Parte XIII foi escrita. A fila fechou e foi publicada na `v0.12`, o gate caiu, e a CTO é hoje a trilha ativa — ver o bloco de estado no fim deste arquivo.)*

**`DQ-6` ENTREGUE — commits locais, sem tag e sem push. `DEVICE PILOT PASSED`.** O Field passou a obedecer à fila do despacho, e o `Voltar` do Android parou de fechar o aplicativo. **Flutter apenas — nenhum arquivo web, backend, schema ou migration foi tocado**; nenhuma rota nova.

O aplicativo **não decide mais a ordem**. `Início` e `Minhas Ordens` leem a mesma `GET /api/field/v1/dispatch-queue`, mostram `EM ATENDIMENTO` como coleção e `PRÓXIMAS NA FILA` com `1ª/2ª/3ª`, e **nada é reordenado no cliente** — nem por `number`, nem por `priority`, nem por `scheduledAt`. O teste central é o do piloto: o despachante põe a Nº 7 em 1ª e a Nº 5 em 2ª, a tela mostra `7, 5`; ele inverte no servidor, o técnico puxa para atualizar, a tela mostra `5, 7`.

Três desfechos que **não se misturam**, e a distinção entre os dois últimos é o ponto da fase: fila presente → ordem do servidor; **404** (servidor anterior à DQ-5) → ranking local **marcado na tela**; qualquer outra falha → **nada é ordenado**, com opção de tentar de novo. Cair no ranking local porque a rede falhou apresentaria uma ordem inventada com a mesma cara da do despachante.

**A revisão de segurança encontrou o próprio fallback silencioso e ele foi corrigido, não só relatado.** O ranking local estava isolado, documentado e testado — e invisível: sem marcação, a sequência calculada pelo aplicativo tinha exatamente a aparência da sequência do despacho. Nasceu daí o `LocalOrderNote`, com três testes permanentes e prova de reversão.

O **Android Back** virou uma função pura (`resolveShellBack`), testada fora da árvore e pelo pop real do sistema (`handlePopRoute`, o mesmo caminho do botão e do gesto): gaveta fecha, modal fecha, aba sem pilha volta ao Início, e **só o Início na raiz** deixa o Android sair. O deep link do detalhe (`/orders/os-7` sem pilha) usa `Navigator.canPop`, **não** `context.canPop()` do GoRouter — a tela é montada sozinha em teste, e acoplá-la ao router quebrava 26 testes existentes.

**Sabotagem G passou porque faltava o teste**, não porque o código estava certo: remover a métrica de urgência do Hero não falhava nada. Os testes `F-7` foram escritos, e só então a sabotagem caiu. Oito provas de reversão no total (`A`–`H`), todas restauradas.

Duas correções de overflow real, achadas por teste de responsividade: a linha do card de Jornada em 390dp (`Row` + `Spacer` → `Wrap`) e o item longo da gaveta (`maxLines: 2`).

Gates: 1561 Vitest, 116 Playwright, **316 Flutter** (era 280), lint, tsc, build, `dart format`, `flutter analyze`, **nenhuma migration**, APK debug construído. **Widget test não aprova gesto de sistema: a fase só fecha com piloto em aparelho físico** — nem o Voltar nem o visual se aprovam por teste de widget.

Mais dois achados do levantamento, fora do escopo da fila e válidos por si: **não existe operação de cancelamento nem de desatribuição de OS** — `status: "CANCELLED"` nunca é escrito em produção e `technicianId: null` só aparece em fixture, de modo que `CANCELLED` é estado declarado e inalcançável —, e **`ServiceOrder` não tem índice em `technicianId`**.

O polimento visual que estava pendente **foi feito dentro da DQ-6**, porque as quatro pendências eram das mesmas telas que a fila reescreveu: as métricas de OS abertas e urgentes viraram número grande com rótulo, a urgência ganhou hierarquia própria, a repetição da mesma OS entre `ATENÇÃO AGORA` e a antiga `PRÓXIMA OS` acabou (a segunda virou `PRÓXIMA AGENDADA`, e é uma **linha**, não um card), e a gaveta deixou de cortar item longo.

**`DQ-7` CONCLUÍDA — auditoria independente clean-room, commits locais, sem tag e sem push.** Feita por uma sessão que não implementou nenhuma fase `DQ-1`–`DQ-6`, sem aceitar relatório anterior como evidência. Veredito **`APPROVED WITH RISKS`**: 0 CRITICAL, 0 HIGH, 0 MEDIUM, **1 LOW e 3 INFO**, nenhum bloqueador. Registro completo em `docs/DISPATCH-QUEUE.md` §19. **Nenhuma correção de código foi aplicada** — o único achado não bloqueia a liberação, e o mandato era corrigir só o que bloqueasse.

**O piloto físico passou.** Web altera a ordem → Field respeita a mesma ordem; `1ª`/`2ª` e `Urgente` corretos; `OS → Voltar → Início` e `Jornada → Voltar → Início` funcionam; detalhe volta à superfície anterior; gaveta fecha; claro e escuro inspecionados. **`FIELD DESIGN FREEZE` está `ACTIVE`** até uma rodada própria de Design Refresh: nesta fase só defeito, acessibilidade crítica, overflow, segurança e regressão funcional justificam mudança visual.

O achado `LOW` — **`BKF-01`** — é do backfill: `backfillOne` renumera só as entradas presentes na lista de candidatos, então uma entrada cuja OS deixou de ser `ASSIGNED` fica com **posição negativa** persistida, e `ORDER BY position ASC` a joga para o topo da fila. Reproduzido de forma determinística. Mesma raiz, **deduzido do código e não observado**: a varredura de candidatos acontece fora da transação por técnico e nunca é revalidada, então uma OS que saia de `ASSIGNED` na janela seria recriada como entrada. **Não bloqueia porque `backfillDispatchQueues` é alcançado por um único arquivo — `scripts/dispatch-queue-backfill.ts` — e por nenhuma rota, job ou cron**: só um operador rodando `npm run dispatch:backfill` contra base viva chega lá. Cura sozinho na mutação seguinte da fila.

Duas hipóteses do auditor foram **refutadas pelas próprias provas**, e ficam registradas para não voltarem: o `canPop` obsoleto do `PopScope` **não** faz o aplicativo fechar com a gaveta aberta no Início (o `DrawerController` registra um `LocalHistoryEntry` e o pop é consumido antes de qualquer `PopScope`); e `/assign` **sem `Idempotency-Key` não permite mutação dupla** — o reenvio literal é recusado por duas regras independentes, o CAS de `ServiceOrder.version` e a igualdade `os.technicianId === technicianId`.

Gates reexecutados do zero: **1561 Vitest, 116 Playwright, 316 Flutter**, lint, tsc, build, `dart format`, `flutter analyze`, `prisma validate`, 23 migrations em dia, APK debug construído. Mais **33 provas adversariais próprias** (temporárias, removidas ao final): 32 passaram, 1 virou o `BKF-01`.

**`DQ-7.1` ENTREGUE — `BKF-01` `RESOLVED`. Commits locais, sem tag e sem push.** Patch focal sobre o único achado não-`INFO` da auditoria DQ-7. **Nenhuma migration, nenhuma rota, nenhuma feature nova, zero arquivo Dart.**

O backfill **passou a reconciliar**. Ele nasceu perguntando "o que falta na fila?", e a pergunta certa é "o que a fila deveria ser?" — a diferença é a entrada que **sobra**. Agora `existente - elegível` sai, `elegível - existente` entra, e a interseção é renumerada 1..N.

A raiz, e não só o sintoma: **a elegibilidade é lida DEPOIS do `FOR UPDATE`**, dentro da transação. A varredura de fora responde só *quem visitar*. É o lock que serializa o backfill contra `start`, `complete` e `assign`, que mudam status e mexem na fila na mesma transação — quem chega primeiro decide a ordem dos fatos, e nenhum dos dois desfechos deixa `IN_PROGRESS` na fila.

**Dois caminhos que a implementação encontrou e o plano não previa.** A varredura de OS **não encontra todas as filas**: um técnico cuja fila só tem entrada obsoleta não tem nenhuma `ASSIGNED`, então nunca era visitado e a entrada morta sobreviveria a quantas execuções fossem — entrou uma segunda varredura, sobre as filas existentes. E a **remoção precisa vir antes de toda inserção**, porque `serviceOrderId` é único entre entradas: uma OS reatribuída de A para B só cabe na fila de B depois de sair da de A. O backfill roda em dois passos, poda e preenchimento; inverter dá violação de unique, e foi o teste de reatribuição que achou isso.

**Um defeito meu, corrigido antes de ser testado:** reduzir o offset do espaço negativo pela contagem de removidas colide com uma posição negada de magnitude maior (tirar a `1ª` de `[1,2,3]` deixa `-2` e `-3` vivos). A conta é sobre posições ocupadas, nunca sobre quantidade de linhas.

**Duas das cinco sabotagens passaram, e a culpa era dos meus testes.** `B` (ler elegibilidade antes do lock) rodava o backfill inteiro, e o passo de poda consumia o bloqueio sem inserir nada — passou a atacar `reconcileTechnicianQueue` diretamente. `E` (sem tenant no predicado) reconciliava com o `companyId` trocado, e a **unique global em `technicianId`** recusava o par cruzado antes de o predicado ser consultado — passou a usar o vetor real: uma OS da empresa B apontando um técnico da A, que o schema permite porque `ServiceOrder.technicianId` é FK simples, sem constraint `(companyId, technicianId)`. Reescritos, os dois derrubam a sabotagem.

Uma guarda nova: posição não positiva só existe **dentro** da transação, e uma contagem no fim faz a transação inteira voltar se alguma sobreviver. Um `BKF-01` futuro vira falha, não fila torta.

**Observação pré-existente, registrada e não corrigida nela:** o backfill **descarta ordenação manual do despachante** — numa fila sem entrada faltando nem sobrando, mas reordenada à mão, ele renumera de volta para a ordem de backfill. Reproduzido em sonda temporária e confirmado **idêntico no código anterior**, então é semântica do comando desde a DQ-2, não regressão. **Corrigido na DQ-7.2.**

Gates: **1571 Vitest** (era 1561), 116 Playwright, 316 Flutter, lint, tsc, build, `dart format`, `flutter analyze`, `prisma validate`, 23 migrations — **nenhuma nova**. Registro em `docs/DISPATCH-QUEUE.md` §20.

**`DQ-7.2` ENTREGUE — commits locais, sem tag e sem push.** Corrige a observação que a DQ-7.1 levantou. **Nenhuma migration, nenhuma rota, nenhuma UI, nenhuma feature nova, zero arquivo Dart.**

O invariante novo: **depois que uma fila existe, o backfill não é autoridade sobre a ordem dela.** Passaram a existir duas regras, e a distinção é o ponto — **BOOTSTRAP** (fila que ainda não existe: banda, `scheduledAt`, `assignedAt`, `id`, inalterado) e **RECONCILIAÇÃO** (fila já operada: preserva a ordem relativa dentro da banda). Um comando de manutenção que reescreve a decisão operacional é pior que um comando que não roda.

**Precedência continua sendo reparada**, e quem faz isso é o **`normalizeQueue`** que o serviço já usa em toda mutação de fila: ele ordena por posição, aplica ordenação **estável** por banda e renumera. A estabilidade é o que repõe a banda sem embaralhar quem já estava dentro dela. Escrever uma segunda implementação de precedência no backfill criaria uma segunda autoridade. A inserção do que falta usa `appendPositionForBand`, a mesma política de `placeAssignedOrder`: fim da própria banda (`D-04`/`D-05`).

**Limite declarado, não mascarado:** uma OS que trocou de banda por fora vai para o ponto que a posição persistida dela implica — o **fim** da banda ao promover, numa fila coerente; ao rebaixar, pode cair antes do fim. A banda **anterior** não é persistida, então "esta OS mudou de banda" não é pergunta que o estado responda, e adivinhar seria a ordenação arbitrária que a fase existe para tirar do caminho.

**A sabotagem `E` passou, e a culpa era dos testes.** O backfill roda em **dois passos**, e uma transformação que inverte a ordem é aplicada duas vezes: a segunda desfaz a primeira, e a asserção sobre a ordem final passava com o código quebrado. Entrou a afirmação forte — **uma fila já válida não é sequer reescrita** (`queuesChanged === 0`) — na `PRESERVE-01` e na `PRESERVE-05`. A primeira versão de `E` também estava errada por outro motivo: trocava `position` pelo índice do array, e `existing` é lido **sem `orderBy`**, então sabotava algo que o código correto não usa.

Gates: **1578 Vitest** (era 1571), 116 Playwright, 316 Flutter, lint, tsc, build, `dart format`, `flutter analyze`, `prisma validate`, 23 migrations — **nenhuma nova**. Registro em `docs/DISPATCH-QUEUE.md` §21.

**A trilha da Fila Operacional está FECHADA e PUBLICADA: `DQ-1` a `DQ-7.2` existem em código**, com `WEB PILOT` e `DEVICE PILOT` `PASSED` e auditoria clean-room `APPROVED WITH RISKS` — 0 CRITICAL, 0 HIGH, 0 MEDIUM, **0 LOW pendente**, e três INFO aceitos (`DQV-01`, `RSP-01`, `ASG-01`). Tag anotada **`v0.12-operational-dispatch-queue`**, no commit `ce41fb7`, no remoto.

**Trilha `FIELD NOTIFICATION FOUNDATION` — PUBLICADA em `v0.13`; o texto abaixo é o registro de como ela nasceu.** Plano fechado em `docs/FIELD-NOTIFICATIONS.md`; PRD §153–§157.

**O levantamento derrubou a premissa de que a fundação estava por fazer.** Verificado arquivo por arquivo: o vertical slice `SERVICE_ORDER_ASSIGNED` **já é completo no backend** — `assignTechnician` grava `ServiceOrder` + `Notification` + `OutboxEvent` na **mesma transação**, o worker reivindica com lease e backoff, e o handler relê a notificação filtrando por `companyId`, busca os aparelhos `ACTIVE`/`revokedAt: null`/`pushToken != null` e limpa **só o `pushToken`** dos recusados, sem revogar o aparelho. `MobileDevice.pushToken` já existe e as rotas de login e `devices/register` já o aceitam. A abstração `PushNotificationProvider` já existe, com um `NoopPushProvider` que devolve `delivered: 0` e **não finge entrega**. A central de notificações é real, e o sino do Field consome o estado verdadeiro.

**`NF-1` ENTREGUE — commits locais, sem tag e sem push.** O lado do **servidor** está pronto: `FcmPushProvider` real, seleção por configuração uma vez por processo, fail-safe, mapper central de erro e a correção do defeito de logout. **Backend e worker apenas — zero Dart, zero código nativo Android, zero migration, zero schema.** Uma dependência nova, `firebase-admin`, e nenhuma outra.

**Nenhum push chega a um aparelho ainda**, e isso é declarado: o Flutter não obtém token (`PushRegistrationService` continua sendo o `Noop`), não há `firebase_messaging`, não há permissão de Android e não há deep link. Isso é `NF-2` a `NF-5`.

**A extensão mínima do contrato:** `PushDeliveryResult` ganhou **`retryableFailures`**, obrigatório. O contrato sabia dizer "entreguei" e "este token morreu", e não sabia dizer "tente de novo" — um provider que falhasse de forma transitória faria o handler concluir o evento e o aviso sumiria em silêncio. Obrigatório e não opcional porque campo opcional convida esse esquecimento; o compilador cobrou os dois fakes na hora.

**A ordem no sucesso parcial é a regra da fase:** envia → **limpa os tokens permanentemente inválidos** → só então lança, se houve falha transitória. Se a exceção viesse antes da limpeza, o token morto sobreviveria a cada tentativa e o evento gastaria as seis contra um aparelho desinstalado. Limpando antes, cada retentativa tem estritamente menos destinos condenados — a fila avança mesmo quando falha.

**Na classificação de erro, o desconhecido é TRANSITÓRIO**, e a assimetria é a razão: chamar transitório de permanente **apaga o token** e cala aquele aparelho para sempre, em silêncio; chamar permanente de transitório gasta seis tentativas e aparece como `FAILED`, com motivo. O primeiro erro é silencioso e definitivo, o segundo é barulhento e reversível.

**O isolamento do bundle foi verificado, não afirmado:** `grep -rl firebase .next/server .next/static` devolve **zero** arquivos, e `firebase-admin` aparece só em `dist/src/lib/push/fcm.js`. A credencial de serviço não existe no runtime web. E o módulo de push inteiro tem **zero** ocorrências de `companyId` — o provider estruturalmente não decide tenant.

**O defeito latente do `NF-0` foi corrigido:** `logoutField` zerava `tokenHash` e **não limpava `pushToken`**, mantendo `status: ACTIVE` — exatamente o predicado do worker. Como o token é da instalação e não da pessoa, o técnico **seguinte** no mesmo aparelho leria a notificação do anterior. Agora o logout limpa o token **sem revogar**, para o próximo login continuar funcionando.

**Risco de dependência, medido — e a medição foi CORRIGIDA na revisão de checkpoint.** `npm audit` reporta hoje 15 vulnerabilidades: **8 `high` pré-existentes** (Next, Prisma, ESLint), que só saem com upgrade MAJOR, e **7 `moderate` que chegaram com o `firebase-admin`**. Importar `firebase-admin/app` e `firebase-admin/messaging` carrega 98 módulos, e a afirmação anterior — de que **nenhum** deles é da cadeia vulnerável — **estava errada**: `@google-cloud/storage`, `teeny-request`, `retry-request`, `qs` e `uuid` de fato não são carregados, mas **`gaxios` é (14 módulos)**. Ele é `moderate` e, ao contrário dos `high`, **corrigível sem breaking change**. Nenhum upgrade foi feito; o risco segue aceito e registrado, agora com o alcance certo.

Gates: **1612 Vitest** (era 1578), 116 Playwright, 316 Flutter, lint, tsc, build, `build:worker`, `dart format`, `flutter analyze`, `prisma validate`, 23 migrations — **nenhuma nova**. Sete sabotagens detectadas, mais uma verificada por inspeção. Registro em `docs/FIELD-NOTIFICATIONS.md` §24.

**`NF-2` ENTREGUE — commits locais, sem tag e sem push.** O **aparelho** ficou preparado: `firebase_core` + `firebase_messaging`, `POST_NOTIFICATIONS` no manifesto, permissão pedida com contexto depois do primeiro login, token obtido e rotação observada. **Flutter e Android apenas — zero TypeScript, zero Prisma, zero migration, zero alteração de backend.**

**E ainda assim nenhum push chega.** O token existe no aplicativo e **não é enviado ao AlfaOS** — isso é `NF-3`, e a fronteira está em `PushCoordinator.tokenRefresh`. Antecipá-la faria o registro nascer sem os testes de idempotência que a fase seguinte prevê.

**A descoberta que decidiu a estratégia do Gradle:** o plugin `com.google.gms.google-services` **falha o build quando o `google-services.json` falta**. Aplicado sem condição, ninguém compilaria o Field sem antes ter acesso ao projeto Firebase da plataforma — nem para rodar em emulador. Ele passou a ser aplicado **condicionalmente**, e o APK foi construído sem o arquivo, com `android/app/build/generated/res/google-services/` **inexistente** provando que o plugin foi pulado.

**`unavailable` não é `denied`.** Um é ausência de infraestrutura, o outro é decisão da pessoa; colapsá-los faria a tela dizer "você recusou" para quem nunca foi perguntado — que é exatamente o estado enquanto o projeto Firebase não existir. Já `deniedPermanently` **é** colapsado em `denied`: a conduta é a mesma, e estado a mais só se justifica quando muda o que o aplicativo faz.

**A permissão é pedida UMA vez, depois do primeiro login, com contexto.** Pedido sem contexto é recusado, e no Android a recusa é lembrada — a partir da segunda negativa o sistema nem exibe o diálogo. Perguntar cedo demais não adianta a permissão: gasta a única boa chance de obtê-la. A marca de "já perguntamos" é **um booleano** em `SharedPreferences`, e nada além dele é gravado.

**A costura inerte foi REMOVIDA, não mantida ao lado.** `PushRegistrationService` nunca teve consumidor, e deixar duas costuras para a mesma coisa faria a fase seguinte ter de escolher entre elas. `FieldPushService` é a única.

**Nada disso derruba o aplicativo:** toda chamada ao Firebase é protegida, a oferta roda **fora** do `try` do login, e a inicialização não bloqueia a subida. O token **não é persistido** (o SDK é a autoridade) e **não é impresso** em lugar nenhum.

Gates: 1612 Vitest, 116 Playwright, **339 Flutter** (era 316), lint, tsc, build, `build:worker`, `dart format`, `flutter analyze`, `prisma validate`, 23 migrations — **nenhuma nova** —, APK debug construído. Sete sabotagens detectadas, mais uma por inspeção. Registro em `docs/FIELD-NOTIFICATIONS.md` §25.

**Pendência do operador, e ela não é código:** criar o projeto Firebase da plataforma, registrar o Android com o `applicationId` **`com.jamalsoftware.alfaos.field`** e colocar o `google-services.json` em `apps/field/android/app/` — **fora do Git**, e o `.gitignore` já o cobre.

**A escolha de SDK (`firebase-admin`, só no worker) depende de um fato do grafo de imports:** `outbox-handlers.ts` é alcançado apenas por `scripts/outbox-worker.ts` e pelos testes — **nenhuma rota do Next**. Por isso a credencial de serviço nunca existe no runtime web. Se uma rota passar a importá-lo, a decisão precisa ser reavaliada, não herdada.

**`NF-3` ENTREGUE — commits locais, sem tag e sem push.** O token do FCM chega ao `MobileDevice.pushToken` e continua chegando quando o Firebase o rotaciona. **Nenhuma migration, nenhuma dependência nova, nenhum endpoint novo** — `POST /api/field/v1/devices/register` já aceitava `pushToken` desde a NF-0, e o que faltava era o aplicativo mandá-lo.

**Ainda assim nenhum push chega a um aparelho**, e a razão deixou de ser o encanamento: sem o `google-services.json` da plataforma, o provedor não emite token nenhum.

**Nenhuma segunda abstração.** O enunciado citava um `PushRegistrationService` que **não existe** — a NF-2 o removeu por ser costura inerte. A responsabilidade foi para o `PushCoordinator`, que já era o dono do ciclo de vida do push; o destino é uma **função** (`PushTokenSink`), não o repositório, porque quem está ali decide **quando** há token para registrar, e nada mais.

**A assimetria entre ligar e desligar é a regra da fase.** `startSession()` **não é esperado**: com `await`, o `login()` **nunca retornava** em ambiente sem Firebase, e a tela ficava com o indicador girando — `Firebase.initializeApp()` não completa em teste de widget e nada garante que complete num aparelho sem Google Play. `stopSession()` **é esperado**, porque é ele que garante que o registro em voo termina **antes** de o logout limpar o servidor. Pelo mesmo motivo o `cancel()` da assinatura **não é esperado**: é chamada de canal nativo que pode não responder, e esperá-la pendurava o `logout()` — sair do aplicativo é justamente a operação que precisa funcionar quando nada mais funciona. **Quem foi apontar isso foram dois testes de widget que já existiam**, não os da fase.

Quatro decisões que não podem ser desfeitas: **`pushToken: null` nunca é enviado** pelo aplicativo (o servidor lê isso como revogação, e o provedor devolve `null` por motivo banal); **permissão negada não registra** (no Android o `getToken()` responde mesmo sem permissão, e registrar faria `pushToken != null` significar "existe endereço" em vez de "dá para avisar esta pessoa"); os envios em voo são um **mapa por token**, não uma future só (uma future só deixaria o envio anterior órfão, e a resposta atrasada regravaria o token depois do logout); e a memória de "já registrei" **é zerada ao sair**, senão o técnico seguinte no mesmo aparelho nunca registraria.

**O registro passou a soltar o token da linha antiga da mesma empresa.** Um token endereça UMA instalação; o par que divide o aparelho da empresa — com um `logout` que não alcançou o servidor, porque sair funciona offline — receberia a notificação do outro, com número de OS e nome de cliente na tela de bloqueio. A limpeza para no tenant, e a janela residual entre empresas diferentes está declarada em `docs/SECURITY.md` §8.13. E `registerDevice` deixou de auditar o que não mudou: cinco registros iguais, uma linha de auditoria.

**A auditoria independente deu `APPROVED WITH RISKS`** — 0 CRITICAL, 0 HIGH, 0 MEDIUM, 3 LOW, 5 INFO — e os três LOW foram corrigidos. **O mais importante era um teste meu que não provava o que dizia:** o `NF3-10` comparava índices na lista de requisições do transporte falso, preenchida no **despacho**; a asserção **passava com a ordem do `logout()` invertida**, verificado invertendo de fato. O transporte falso ganhou linha do tempo com despacho e conclusão.

**Três provas passaram antes de os testes serem corrigidos**, e as três eram culpa dos testes: a sabotagem `G` (revogado reativado) recebia 401 por outra porta, porque `revokeDevice` apaga o `tokenHash` junto — nasceram daí dois testes, um sobre o login e outro montando `REVOKED` com `tokenHash` vivo; a reversão da ordem do logout, acima; e a reversão do guarda de token já em voo, que não disparava porque a rotação era emitida antes de a assinatura existir e um `Stream.broadcast` descarta evento sem ouvinte.

**Falha de suíte que NÃO era da fase:** `time-clock-effective` usa `Date.now() - 60_000` como horário de correção, que no primeiro minuto depois da meia-noite cai no dia civil anterior — a execução começou 23:56 e atravessou a virada. Mesma bomba-relógio que a `DQ-4` desarmou com `- 30min`; as três ocorrências restantes foram travadas no início do dia civil.

Gates: **1689 Vitest** (era 1670), 116 Playwright, **360 Flutter** (era 339), lint, tsc, build, `build:worker`, `dart format`, `flutter analyze`, `prisma validate`, **24 migrations** — nenhuma nova —, APK debug construído sem `google-services.json`. Oito sabotagens e quatro reversões próprias. Registro em `docs/FIELD-NOTIFICATIONS.md` §26.

**`NF-4` ENTREGUE — commits locais, sem tag e sem push.** O toque numa notificação leva à OS. **Zero migration, zero dependência, zero endpoint novo, zero mudança de backend** — o diff do servidor tem apenas testes. Nenhuma notificação local, nenhum banner, nenhum redesenho: o `FIELD DESIGN FREEZE` continua valendo.

**Um parser, e ele é allowlist.** `PushDestination.fromData` é o único lugar que interpreta payload — `type` + `resourceType` + formato do `resourceId`. **A validação do identificador é segurança, não capricho**: ele preenche UM segmento de `/orders/:id`, e sem a regra `resourceId = "abc/execucao"` montaria `/orders/abc/execucao`, fazendo o payload **escolher a tela**. A central de notificações passou a usar o mesmo parser — ali é defesa em profundidade, e **não** fechamento de vetor explorável: existe uma única escrita de `Notification.resourceId` em produção, e ela grava o `id` da OS. A auditoria corrigiu essa afirmação minha, que estava forte demais.

**Push indica destino; não autoriza.** O único dado que sobrevive é o identificador na rota, e `getFieldServiceOrder` continua filtrando por `companyId` e `technicianId` sem saber que a navegação veio de um aviso. OS reatribuída entre o envio e o toque → 404; OS de outra empresa → 404. Ambos com controle positivo.

**"Chegou mensagem" ≠ "a pessoa tocou".** `getInitialMessage` e `onMessageOpenedApp` navegam; `onMessage` **nunca** navega — atualiza fila do despacho, lista de OS e contagem do sino, e só isso. Trocar a tela debaixo da mão de quem está no meio de uma execução é a pior coisa que um aplicativo de campo pode fazer.

**O defeito que a auditoria encontrou era real, e falhava em silêncio.** O `routerProvider` é recriado a cada troca de fase, e o destino pendente é consumido exatamente nessa troca: o `push` acertava um `GoRouter` cujo delegate ainda não fora anexado, e a resolução da rota inicial **descartava** o empilhamento. O técnico tocava o aviso, entrava, e caía no Início — sem erro, sem log. **Os 34 testes de unidade passavam**, porque todos injetam roteador falso; quem pegou foi o teste com o `GoRouter` real, escrito para fechar a lacuna que o auditor classificara como `LOW`. Corrigido com `addPostFrameCallback` + `ensureVisualUpdate`, provado nos dois sentidos.

**A sabotagem `G` passou na primeira rodada, e a culpa era do teste.** A deduplicação do coordenador e a guarda de "já estou lá" **mascaram** ouvintes duplicados: o comportamento visível continua correto e o vazamento segue vivo. Passou a contar assinaturas VIVAS, não navegações. Pela mesma razão, o teste de deduplicação foi reescrito para repetir a mensagem **longe** da OS — antes, a segunda guarda o descartaria sozinha.

Auditoria independente: **`APPROVED WITH RISKS`** — 0 CRITICAL, 0 HIGH, 0 MEDIUM, 3 LOW, 7 INFO. Os três LOW corrigidos; dois INFO viraram código.

Gates: **1694 Vitest** (era 1689), 116 Playwright, **399 Flutter** (era 360), lint, tsc, build, `build:worker`, `dart format`, `flutter analyze`, `prisma validate`, **24 migrations** — nenhuma nova —, APK debug construído sem `google-services.json`. Oito sabotagens e três reversões próprias. Registro em `docs/FIELD-NOTIFICATIONS.md` §27.

**`NF-5` — `PHYSICAL PILOT PASSED`.** O piloto em aparelho real foi executado: o aplicativo pede a permissão depois do login, o técnico concede, o FCM entrega, o push chega e o toque abre a OS. A §27.5 continua sendo o argumento de por que ele era obrigatório — gesto de sistema, toque em notificação real e ordem de subida não se aprovam por teste de widget —, e o piloto provou isso duas vezes, encontrando dois defeitos que 400 testes verdes não viam: a permissão que nunca era pedida e o sino que não atualizava no cold start. Os commits da NF-1 a NF-5 são locais, não publicados, e **não devem ser reescritos, amendados nem squashados**.

**`PC-1` — `EXIF-01` `CLOSED` e câmera física `PASS`.** As duas pendências que faltavam para o checkpoint do Field foram fechadas. **Nenhuma migration, nenhuma dependência nova, zero Dart.**

**Toda foto de evidência subia com o GPS do EXIF intacto**, e o que tornava isso grave é de quem era a permissão: o GPS é escrito pelo **aplicativo de câmera**, sob a permissão dele — o técnico que negou localização ao AlfaOS continuava enviando coordenada em cada foto. Agora a limpeza é do **servidor**, antes do hash e do tamanho, nos dois pontos que persistem imagem. Qualquer cliente pode enviar imagem; o Flutter não pode ser a única barreira de privacidade. Detalhes em `docs/SECURITY.md` §8.16.10.

**Sem dependência, e a razão não é economia:** metadado vive em **segmentos de contêiner**, ao lado dos dados comprimidos e não dentro deles — removê-lo é percorrer a estrutura, sem decodificar nem recomprimir. `sharp` faria o oposto, cobrando binário nativo no deploy e degradando a evidência a cada upload.

A política preserva `Orientation` (o AlfaOS não decodifica a imagem, então é a tag que endireita a foto) e o perfil ICC; sai todo o resto, **inclusive o que vem depois do `EOI`** — é ali que Samsung e Google anexam o MP4 da Motion Photo, cujo `moov/udta/©xyz` guarda coordenada.

**A auditoria independente encontrou dois `MEDIUM` na primeira versão, ambos reais e ambos corrigidos:** o percurso virava **arma de CPU** (8 MB de marcadores isolados = 1452 ms de event loop bloqueado, 726× o normal — em Node isso é a aplicação inteira parada, para todos os tenants), fechado com teto de segmentos; e o trailer depois do `EOI` **sobrevivia**, alcançável pela web onde o `<input type="file">` envia o arquivo cru.

**Efeito colateral declarado:** a validação apertou de "tem os bytes mágicos certos" para "é um contêiner que fecha", e arquivo malformado passa a receber 400 em vez de ser gravado corrompido. O preço apareceu na hora — os fixtures de imagem de **sete** arquivos de teste eram assinatura mais enchimento e nunca foram imagem nenhuma.

**Câmera física `PASS`**, pela mesma tela que o técnico usa: o prompt nativo aparece **ao escolher a categoria da foto**, não no login; negar não quebra nada; permitir abre a câmera; e a foto real gravada volta sem EXIF (`26406 → 25267` bytes, marca e MakerNote removidos). O 500 que bloqueava a Execução era **estado do servidor de desenvolvimento**, não defeito de rota — nada de autorização, tenancy, posse ou CAS foi tocado.

**Auditoria de permissões do Android — CONCLUÍDA.** Matriz definitiva em `docs/SECURITY.md` §8.16. O achado que a governa: **o manifesto de fonte não é o que vai no aparelho** — declaramos 5 permissões e o APK tem 9, porque o `firebase_messaging` injeta 4 (`WAKE_LOCK`, `ACCESS_NETWORK_STATE`, `c2dm.RECEIVE`, `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`). Nenhuma é de runtime, nenhuma foi removida, nenhuma sobrava. Um teste chegou a afirmar que o app **não** usava `WAKE_LOCK`: era verdade sobre a fonte e mentira sobre o artefato, e foi corrigido. A fronteira agora é testada por **igualdade** de conjunto, na fonte e no manifesto **fundido** (`apps/field/test/android_permissions_test.dart`) — lista de proibidas só pega o que alguém já imaginou. **Nada é pedido na subida**; localização e câmera pedem dentro da própria funcionalidade, e negar não bloqueia nada (provado em aparelho: ponto registrado com a permissão negada, sem coordenada). `ACCESS_BACKGROUND_LOCATION` não existe e não deve ser acrescentada.

**Trilha `PLATAFORMA DE ERPs PLUGÁVEIS` — `ERP-1` e `SGP-1` PUBLICADAS em `v0.13`; `ERP-0R` continua só planejada.** Plano em `docs/ERP-INTEGRATIONS.md` §13–§27, inventário do provider em `docs/ERP-SGP.md`, PRD §352–§361 (Parte XV).

**A regra, e ela é definitiva:** `Company → ERPIntegration 0..1 → provider`. **Cada empresa tem ZERO OU UM ERP ativo.** O AlfaOS suporta vários *tipos* de ERP globalmente — `SGP` é provider **`APPROVED / PLANNED`**, `ReceitaNet` é o existente e implementado —, mas **não existe** provider por capability, dual-provider operacional nem principal+secundário. `ERPIntegration.companyId @unique` **preservada**; não trocar por `@@unique([companyId, provider])`.

**Uma tentativa anterior foi DESCARTADA, e o registro importa mais que o código.** O `ERP-0`/`ERP-1` chegou a ser planejado, implementado, testado e commitado com **múltiplos ERPs ativos simultâneos** (autoridade por capability, `ERPCapabilityBinding`, `Company.primaryErpProvider`, `resolveProviderFor`, migration aditiva). A premissa foi recusada como decisão de produto, e os seis commits saíram da `main` por `git reset --hard 0a8c596`. Ficaram na branch **local** `backup/erp-multiprovider-discarded` (`1331e84`), sem push. **Não ressuscitar aquelas peças.**

O que a experiência mediu, e por isso vale registrar: o modelo descartado prometia migração gradual por capability, e cobrava uma tabela nova, uma unique nova, uma camada de resolução nova, uma tela que vira matriz — e um modo de falha novo: **acreditar que se está no provedor A enquanto uma capability ainda responde pelo B**. Nada disso paga por si para o caso real, que é **trocar de ERP uma vez**.

**Duas coisas do trabalho descartado sobreviveram como achado válido, e as duas viraram a `ERP-1`, agora ENTREGUE.**

**`ERP-1` ENTREGUE — commits locais, sem tag e sem push.** Corrige dois defeitos que existiam desde antes da trilha ERP. **Nenhuma migration, nenhuma alteração de schema, nenhuma dependência nova, zero Dart.** O SGP continua sem existir.

**As três ações deixaram de compartilhar efeito colateral:** salvar credencial grava segredo e não ativa nada; **testar conexão é consulta** — não altera o ERP ativo, não apaga credencial e não cria integração; e **alterar ERP ativo** é `POST /api/integrations/active-provider`, a **única** operação que escreve `ERPIntegration.provider`, com confirmação na tela, `ERP.ACTIVE_PROVIDER_CHANGED` e compare-and-set.

Três escritas saíram do `test-connection`: o `upsert` que gravava `provider` (testar um candidato **ativava** aquele ERP, e toda a operação passava a falar com outro sistema por causa de um clique de diagnóstico), o `deleteMany` sobre as credenciais do provider anterior, e o `CLEARED_CREDENTIAL_FIELDS`. Junto foi a **criação** da integração: o `upsert` fazia de "testar" um caminho de configuração, e uma empresa sem ERP que clicasse em testar acabava configurada em MOCK.

**Credencial armazenada não é ERP ativo.** A troca preserva a credencial do anterior, cifrada e ociosa, isolada pelo AAD — é o que permite `RECEITANET → MOCK → RECEITANET` sem recadastrar token em passo nenhum. E credencial ociosa **não cria provider secundário**: ERP ativo sem a capability responde `NOT_SUPPORTED`, sem fallback.

Quatro decisões que não podem ser desfeitas: **a precondição de credencial é genérica** — "o provider de destino resolve para um adapter utilizável?", respondida por `resolveCompanyAdapter`, sem `if` por provider, então um provider futuro herda a regra; **trocar para o provider já ativo é recusado**, não é no-op, porque um 200 gravaria `ERP.ACTIVE_PROVIDER_CHANGED` para uma troca que não aconteceu; **`lastTestedAt`/`lastTestStatus` só são gravados ao testar o ATIVO**, porque não há coluna para saúde de candidato e nenhuma foi inventada; e **concorrência sem coluna nova** — o `updateMany` é compare-and-set sobre o provider lido, e a auditoria vai na mesma transação por `logAuditWithin`.

**Um teste meu passava pelo motivo errado.** A sabotagem que faz o `companyId` do corpo virar autoridade **passou**: o `ERP1-13` mandava o `companyId` da empresa B, mas B não tinha credencial do provider de destino — a troca falhava por precondição e o 400 aparecia mesmo com o ataque bem-sucedido. O teste passou a preparar a empresa B inteira, de modo que obedecer ao corpo *funcionaria*, e só então a asserção tem o que proibir.

**Perdi a correção do `test-connection` no meio da fase** ao rodar `git checkout` no arquivo para desfazer uma sabotagem — o arquivo voltou ao estado do HEAD, que é o código com o defeito. Refiz e passei a guardar cópia dos arquivos corrigidos antes de sabotar. `git checkout` não desfaz sabotagem em arquivo com trabalho não commitado.

Gates: **1634 Vitest** (era 1612), 116 Playwright, **339 Flutter** inalterados, lint, tsc, build, `build:worker`, `dart format`, `flutter analyze`, `prisma validate`, **23 migrations** — nenhuma nova. Oito sabotagens (`A`–`H`), oito detectadas, todas restauradas. Registro em `docs/ERP-INTEGRATIONS.md` §28.

**`SGP-1` ENTREGUE — commits locais, sem tag e sem push. `SGP SANDBOX VALIDATION REQUIRED` + `PRODUCTION ACTIVATION GUARDED`.** A ativação em produção é travada por `SGP_ACTIVATION_ENABLED` (padrão `false`, comparação exata com `"true"`), decidida no DOMÍNIO e antes de qualquer leitura, reteste, cifragem ou transação — testar continua liberado, porque é diagnóstico e é o que a homologação precisa. Registro em `docs/SECURITY.md` §8.18. O provider SGP existe no domínio, autentica e é ativável — **e nada além disso**. Migration **aditiva de duas linhas** (`20260903120000`: `ERPProvider.SGP` e `ERPCredentialKind.PUBLIC_API`), zero coluna, zero tabela, zero unique alterada, zero dependência, zero Dart. Registro em `docs/ERP-INTEGRATIONS.md` §29.

**A superfície foi escolhida, não herdada.** `ADOTADA`: `/api/ura/` com **Token e App no CORPO**, `application/x-www-form-urlencoded`. `NOT ADOPTED / NEED VALIDATION`: a `/api/v1/` com `Authorization`, vista no site do fabricante e ausente das 275 requisições catalogadas — e **não se assume que o token de uma vale na outra**.

**A sonda MUDOU de endpoint por causa da reconfirmação, e é o mecanismo funcionando.** A `ERP-0R` sugeriu `consultaplano`; a revalidação da coleção oficial mostrou que ele é **`GET` com corpo `form-data`**, que proxies descartam — e a alternativa seria token na query string. A sonda adotada é **`POST /api/ura/planoscontas/`**: `POST`, só `token`+`app`, devolve plano de contas — sem cliente, sem valor, sem PII. Descartados com motivo: `fatura2via` tem `nao_gerar_os` e pode **abrir OS**; `cpemanager/.../command/ping/` executa comando em equipamento.

**O SGP não tem `/ping` anônimo**, então `reachable` e `credentialValidated` são derivados: sucesso → os dois; `401`/`403` → alcançável com credencial recusada (um 401 **é** resposta); timeout/5xx → não alcançável, e nada se sabe da credencial.

**Configuração candidata não é persistida em lugar nenhum.** Testar o SGP enquanto o ReceitaNet atende monta o adapter **em memória**; nada é gravado — nem integração, nem credencial, nem `lastTestedAt`, nem `localStorage`. Os dois caminhos alternativos foram recusados por escrito: gravar `baseUrl`/`config` do SGP na linha ativa **corromperia a configuração do ERP que está atendendo**, e criar uma segunda `ERPIntegration` quebraria a regra de um ERP ativo.

**A ativação reexecuta o teste NO SERVIDOR.** O resultado que o browser viu não é prova: o corpo da confirmação é reenviável, e sem reteste um `POST` forjado ativaria o SGP com credencial que nunca funcionou. Falhou → nada é trocado. A atomicidade é real porque `encryptCredential` é **pura** e roda fora da transação; só as escritas entram nela, então não existe `provider = SGP` sem credencial.

**SSRF com resolução de DNS, porque regex não bastaria.** `http://127.0.0.1` se barra por texto; `https://host.exemplo` apontando para `127.0.0.1` não. `safe-outbound-url.ts` recusa esquema fora de `https` (com `http` só fora de produção, porque o token viaja no corpo), credencial na URL, fragmento, IP privado literal, e nome que resolve para loopback, link-local (inclusive `169.254.169.254`), RFC1918, CGNAT ou multicast — verificando **todos** os endereços resolvidos, não só o primeiro. Redirecionamento não é seguido. **DNS rebinding fica declarado como janela não fechada**: fechá-la exige fixar o IP na conexão, o que atravessa a camada de transporte.

**Duas correções que o código impôs, e uma delas corrige uma afirmação minha.** A precondição da troca usava `resolveCompanyAdapter`, que lê as sobreposições **gravadas** — então voltar do SGP para o ReceitaNet **falhava**, porque a linha ainda tinha o host do SGP e o `ReceitanetCallCenterClient` tem allowlist **exata** de host. O operador recebia "não foi possível autenticar", como se o token estivesse errado. Corrigido com `assertProviderUsableAfterSwitch`, que avalia o estado **depois** da troca. **E a limpeza de `baseUrl` não é proteção contra vazamento de token** — a allowlist já impedia isso; eu havia escrito que era, e o defeito real é de operabilidade, não de segurança. A segunda correção: o SGP **não entra pela rota genérica** de troca, porque precisa de `baseUrl`, `app` e token — passar por ali o ativaria com o host de outro provider.

**Nenhuma capability de negócio.** A API do SGP documenta cliente, contratos, financeiro, OS, ONU e CPE — e **a existência do endpoint não é a capability**. O adapter não declara interface e não tem os métodos, então os type guards respondem `false` estruturalmente. Dois testes guardam: um estrutural e um **sobre o fonte**, que proíbe até a declaração — porque um método vazio adicionado às pressas compilaria.

**Recomendação ao operador:** o token do SGP deve ser **somente leitura** nesta fase — `Permite Baixar Título` e `Permite Cancelar Título` em `OFF`. A API expõe esses caminhos; um token que não pode chamá-los transforma "não chamamos" em "não conseguimos".

**O que falta é validação real:** nenhum teste automático chama o SGP, e um detalhe de transporte depende de sandbox — a coleção cataloga `multipart/form-data` e a documentação diz que "o uso de form-data é opcional"; implementei `urlencoded`. Se o SGP recusar, muda o `Content-Type` e a serialização, e nada mais.

Gates: **1670 Vitest** (era 1634), 116 Playwright, **339 Flutter** inalterados, lint, tsc, build, `build:worker`, `dart format`, `flutter analyze`, `prisma validate`, **24 migrations**. Dez sabotagens (`A`–`J`), dez detectadas, restauração conferida por `diff` byte a byte.

**O schema já sustenta a regra, e é isso que torna `ERP-1` pequena.** `companyId @unique` **já é** a invariante principal; `baseUrl` e `config Json?` (hoje sem nenhum consumidor) já existem; `ERPCredential` já é `(companyId, provider, kind)`. Falta apenas `SGP` no enum de provider e um valor de `ERPCredentialKind` para a API única do SGP — migration **aditiva de duas linhas**, que pertence à `SGP-1`. **Não reutilizar `CALLCENTER` para o SGP** (a linha mentiria sobre qual API a credencial abre) e **não renomear** os existentes (estão no AAD `v2` de linhas reais).

**O SGP autentica com Token + App no CORPO da requisição**, não em header — diferença estrutural em relação ao ReceitaNet —, e a `Base URL` é **por empresa**. Só o `Token` é segredo. Fontes oficiais revalidadas ao vivo em 2026-09-03.

**Duas coisas que a documentação oficial NÃO resolve:** existe uma segunda superfície (`/api/v1/`, credencial em header) no site do fabricante, ausente da coleção oficial de 275 endpoints — **confirmar no sandbox antes de escrever o transporte**; e **restrição de host e usuário associado ao token não aparecem no texto documentado**. Rate limit do SGP: `UNKNOWN`.

**Cuidado com o verbo HTTP nessa API:** `GET /api/fttx/onu/{id}/reset/` e `.../deauth/` **derrubam ou removem uma ONU**. E `fatura2via` não é leitura — tem `nao_gerar_os`, ou seja, pode **abrir OS**; a sonda de conexão recomendada é `consultaplano`, que não envia documento nenhum.

**Três achados que tocam seções já escritas, e nenhum promove nada.** O SGP **tem descoberta global de OS** — o que não revoga a §141, que é sobre o ReceitaNet e que **já previu** a entrada de uma estratégia de descoberta nova sem trocar o motor de importação da v0.8. O SGP **tem CTO**, o que remove a premissa de "não há fonte" da Parte XIII **sem alterá-la** — a §334 já decidiu que a fronteira é precedência. E ONU/OLT/PON/CPE existem lá, então a frase de `ERP-INTEGRATIONS.md` §1 foi **qualificada** para dizer "em nenhuma API do ReceitaNet".

**`externalProvider` é HISTÓRICO, não seleção.** OS antiga do ReceitaNet continua ReceitaNet depois da troca; OS nova nasce SGP. **Nenhum registro é convertido** — reescrever apagaria de qual sistema veio cada atendimento.

Depois dela existiam **três** trilhas documentadas e nenhuma promovida — **Escala de Trabalho P0** (§307), **CTOs e Rede de Distribuição** (§333–§341) e **Colaboração entre Técnicos** (§342–§351). A ordem entre elas não estava decidida: são addenda aprovados em momentos diferentes, e escolher em silêncio seria decisão de produto tomada por omissão.

**Decidida na `CTO-0.1`: a trilha ativa é CTOs e Rede de Distribuição** — ver o bloco de estado no fim deste arquivo. **Escala de Trabalho** e **Colaboração entre Técnicos** continuam documentadas e não promovidas, sem ordem entre si.

Também sem código, **documentação apenas**: a **Parte XIV do PRD (§342–§351)** e `docs/FIELD-COLLABORATION.md` — **Colaboração entre Técnicos**. Uma OS tem **um** responsável e **0..N** colaboradores, e a regra que atravessa o módulo inteiro é: **colaborar acrescenta participante SEM trocar o responsável**; **transferir troca o responsável** e por isso mexe na fila de despacho. Nunca são sinônimos, e "repasse" não é palavra desta capability. Habilitável por empresa. **Nada disso existe em código.**

Cinco achados do **código real** que a especificação registrou e que decidem o custo das fases:

* **A posse tem UM portão.** Toda mutação-filha — evidência, material, equipamento, assinatura, checklist, impedimento — passa por `loadInProgressOwnedOrder` → `loadOwnedServiceOrder`, que recusa quando `order.technicianId !== technician.id`. A permissão do colaborador se resolve **estendendo um predicado**, não espalhando verificações; em compensação, errar essa função erra todas as escritas de uma vez.
* **A autoria já existe em cinco superfícies e falta em duas.** `ServiceOrderEvent`, `ServiceOrderEvidence`, `ServiceOrderMaterialUsage`, `ServiceOrderSignature` e `AuditLog` gravam o autor; **`ServiceOrderExecution` e `ServiceOrderEquipment` não**. A `Execution` é registro **único por OS**, então dois técnicos no mesmo diagnóstico não são duas linhas — `COL-6` não é uniforme.
* **A fila já PROÍBE a OS em duas filas.** `TechnicianDispatchQueueEntry.serviceOrderId` é `@unique` global, então "colaborador não entra na fila autoritativa" (`COL-AC03`) é **estrutural**, não uma regra que alguém precisa lembrar.
* **O `409` de `expectedVersion` deixa de ser raro.** Hoje só um técnico escreve numa OS; com dois participantes o CAS de `claimOrderForChildMutation` dispara em uso normal. É o mecanismo funcionando, e o Field precisa tratá-lo como recarregar-e-tentar, não como erro vermelho.
* **Não existe tabela genérica de capability.** O precedente do projeto é coluna de política em `Company` (`pppoePasswordPolicy`, `timezone`).

**Modelagem recomendada:** manter `ServiceOrder.technicianId` como responsável e acrescentar relação própria de colaboração. A alternativa uniforme (`ServiceOrderParticipant` com role) exigiria refatorar a fila de despacho inteira, o predicado de posse de todas as mutações-filhas, a atribuição e a listagem do Field — a superfície mais testada e mais recentemente auditada do projeto — sem ganho para quem está em campo.

Sete decisões abertas (`COL-01`–`COL-07`), nenhuma resolvida em silêncio; a mais pesada é `COL-01`, de qual estoque sai o material que o colaborador registra. **Esta Parte não promove nada na ordem** — a §119 vale, e a Fila Operacional continua fechada e pronta para release.

A §119 continua valendo para tudo o que é só especificação: FCM real, offline no cliente, `ToolExecution`, toolbox, custódia de patrimônio, mapa operacional, Central de Despacho, rede interna do cliente, contratos, escala de trabalho e espelho de jornada, CTOs e rede de distribuição, **colaboração entre técnicos** e as **capabilities de negócio do SGP** — busca de cliente, contratos, financeiro e OS (a plataforma e o `SgpAdapter` existem em código: `ERP-1` e `SGP-1`; o adapter só faz `testConnection`). (A **fila operacional de OS** saiu desta lista: `DQ-1` a `DQ-7.2` existem em código. O **push FCM** também, do servidor ao toque que abre a OS: `NF-1` a `NF-5` existem, com piloto físico aprovado.) Duas escalas de prioridade convivem e precisam ser conferidas juntas: §117 classifica o produto (MVP/IMPORTANTE/DIFERENCIAL/FUTURO), §194 classifica a trilha Field (P0/P1/P2).


**Baseline publicada: `v0.13-field-push-notifications`** — tag anotada no commit `3c1805e`, no remoto. Ela fecha, num checkpoint só, tudo o que estava acumulado como "commits locais, sem tag e sem push": a **Field Notification Foundation** (`NF-1` a `NF-5`, do provider FCM real ao toque que abre a OS, com **piloto físico aprovado**), a **`ERP-1`**, a **`SGP-1`**, o endurecimento de privacidade de foto (`PC-1`/`EXIF-01`, com câmera física `PASS`), a auditoria de permissões do Android e a trava de ativação do SGP (`RC-1`). As frases "sem tag e sem push" nas seções acima descrevem o estado **no momento de cada entrega** e continuam válidas como registro histórico — a publicação é esta.

**A `SGP-1` é fundação publicada, não homologação.** O SGP autentica e é ativável, e a ativação em produção continua **travada** por `SGP_ACTIVATION_ENABLED` (padrão `false`, comparação exata com `"true"`). `SGP SANDBOX VALIDATION REQUIRED` e `PRODUCTION ACTIVATION GUARDED` seguem valendo: publicar a fundação não homologou o provider contra instalação real.

**Trilha atual: `CTOs E REDE DE DISTRIBUIÇÃO` — `CTO-0` e `CTO-0.1` concluídas, `CTO-1` executável, NADA em código.** Especificação em `docs/CTO-NETWORK-DISTRIBUTION.md`; PRD §333–§341 (Parte XIII).

**O gate histórico caiu.** A §341 condicionava a CTO a "depois de a sequência da fila estar concluída **e publicada**", e a `v0.12` está no remoto. Cair o gate não implementou nada: a §119 vale linha por linha.

A **`CTO-0`** reconciliou a especificação com o código e encontrou uma contradição dentro do próprio documento oficial, mais um buraco num critério de aceite. A **`CTO-0.1`** fechou as doze decisões (`C-01`–`C-12`) e congelou o contrato de schema. **Documentação apenas — zero migration, zero Prisma, zero dependência, zero código.**

Cinco decisões que não podem ser desfeitas em silêncio:

* **Ocupação é DERIVADA, nunca persistida.** `CTOPort.administrativeState` tem três valores — `AVAILABLE · RESERVED · DAMAGED` — e `OCCUPIED` **não é gravável**. O documento listava quatro estados incluindo `OCUPADA` enquanto a seção seguinte recusava `CTOPort.state` como autoridade justamente por criar "um segundo lugar que precisa concordar com a existência do vínculo". Persistir `OCUPADA` **é** esse segundo lugar; a contradição foi resolvida a favor de uma fonte só.
* **São DUAS uniques parciais**, não uma: `(ctoPortId)` e **`(customerId)`**, ambas `WHERE disconnectedAt IS NULL`. A segunda faltava — e `CTO-AC05` prometia que "o cliente fica em exatamente UMA porta ativa" sem nada no banco que garantisse isso. Duas movimentações concorrentes do mesmo cliente para portas **diferentes** satisfaziam a unique de porta e deixavam o cliente em duas caixas.
* **`Company.ctoNetworkEnabled`, default `false`** — uma coluna, **não** um framework de feature flag; o precedente do projeto é `pppoePasswordPolicy` e `timezone`. E **capability não é permissão**: as duas verificações são independentes e as duas continuam obrigatórias em toda rota, inclusive de leitura.
* **Nada de `equipmentId` no vínculo.** `ServiceOrderEquipment` é linha **por OS** e `serial`/`macAddress` são opcionais desde a v0.10 — não existe identidade estável de equipamento fora da OS, e amarrar a topologia a ela faria a rede herdar o ciclo de vida de uma ordem de serviço. Nenhuma entidade `Equipment` global é inventada.
* **A foto da CTO não ganha um terceiro `stripImageMetadata`.** A `CTO-1` **primeiro extrai** a fronteira comum de upload (sniff de MIME real, teto, sanitização, tradução de falha em 400) e converte os dois pontos existentes; só então acrescenta consumidor. Foi exatamente um ponto novo nascendo fora da política que criou o `EXIF-01`.

Mais quatro que valem registro: a redução de capacidade **não apaga porta** (as posições acima viram histórico, e `capacity` deixa de ser a contagem de linhas), é recusada também com `RESERVED` ou `DAMAGED` — mais estrita que o `N-12`, que continua sendo o piso; `CTO.code` é **imutável** depois da criação enquanto `name` é editável; a `CTO-2` implementa **só `source: FIELD`**, porque criar rota para `WEB`/`IMPORT` "já que o enum tem o valor" é superfície de escrita sem caso de uso; e `ServiceOrder` **não recebe** `ctoId`, `ctoPortId` nem `customerNetworkConnectionId`, como `Customer` não recebe `ctoId` — a direção é sempre `CustomerNetworkConnection → Customer/CTOPort/ServiceOrder`, e `serviceOrderId` é **procedência, não posse**.

**Dois riscos que o congelamento NÃO fecha, e a implementação não pode errar.** **`R-02`** — tenancy cruzada: o vínculo cruza quatro FKs de três agregados, e `ServiceOrder.technicianId` é FK simples sem `(companyId, technicianId)`; a `DQ-7.1` já explorou esse vetor, então a verificação é do serviço, em SQL, com `companyId` da sessão. **`R-13`** — porta histórica acima da capacidade **continua sendo um `ctoPortId` válido**: a unique parcial diz "no máximo um", não "esta posição é ofertável", e se a faixa `1..capacity` for validada só na listagem, a redução de capacidade vira sugestão. **A validação é na escrita**, e não pode ser CHECK de banco (seria cross-table e contradiria a própria política de preservar histórico).

**Sequência ativa: `CTO-1 → CTO-2 → CTO-4 → CTO-5`.** `CTO-3` segue bloqueada pelo Mapa Operacional (§136, sem código), `CTO-6` por estratégia de frescor (`C-03`, o teto de 10 chamadas por minuto por empresa), `CTO-7` é opcional e o QR nasce **desligado**. `C-03` e `C-04` continuam abertas, com fase dona declarada, e **nenhuma das duas bloqueia `CTO-1` ou `CTO-2`**.

**`CTO-1` ENTREGUE — commits locais, sem tag e sem push.** A fundação de cadastro da rede de distribuição: `Company.ctoNetworkEnabled`, `CTO`, `CTOPort`, portas automáticas, capacidade, localização, estados administrativos da porta, foto opcional, a tela de ADMIN e auditoria. **Uma migration aditiva** (`20260906195222`: 1 coluna, 2 tabelas, 1 enum, 2 uniques, 3 FKs, 2 CHECKs, zero `DROP`, zero dado tocado). **Zero dependência, zero Dart.**

**Nada da `CTO-2` foi antecipado:** não existe `CustomerNetworkConnection`, vínculo cliente↔porta, superfície no Field, mapa, status `ONLINE/OFFLINE` nem QR. `ServiceOrder` e `Customer` não foram tocados — a direção é sempre do vínculo para eles, e o vínculo é da fase seguinte.

**`OCCUPIED` continua DERIVADO.** Ele existe como valor de apresentação e **não** existe no enum do Prisma: não há coluna capaz de recebê-lo, e um teste sentinela prova que o banco recusa o `UPDATE`. A contagem de ocupadas é `0` e a tela **diz por quê**, em vez de esconder a linha ou inventar um número.

**A capability vem ANTES do perfil, e inverter vaza informação.** Com o perfil primeiro, um `DISPATCHER` de empresa sem o módulo receberia 403 — "isto existe, você é que não pode" — e a empresa descobriria pela mensagem de erro que há um módulo CTO que ela não contratou. O par de testes que fixa isso usa o **mesmo** perfil: 404 com a capability desligada, 403 com ela ligada, o que prova de qual das duas verificações cada resposta veio. `requireCtoAccess` é o portão único; espalhar a sequência por seis rotas garantiria que a sétima esquecesse uma etapa.

**A fronteira de imagem foi EXTRAÍDA antes do terceiro consumidor.** `src/lib/media/image-upload.ts` passou a ser o único lugar que decide o que é uma imagem aceitável e o que sai dela; `addEvidence` e `putSignature` foram **convertidos** a ela, e a foto da CTO é o terceiro consumidor, não a terceira cópia. Acrescentar primeiro e refatorar depois significaria três cópias por um intervalo — e o intervalo é exatamente quando o release sai. A prova de que a fronteira é uma só: devolver os bytes originais derruba **12 testes de uma vez**, entre evidência, assinatura e CTO.

**Uma corrida real, encontrada na implementação e corrigida, não só relatada.** Mudar o estado de uma porta parece isolado — um campo, numa linha — e disputa com a redução de capacidade, que decide olhando o estado de **todas** as portas acima do novo limite: a redução lê a porta 12 como disponível, o outro caminho grava `RESERVED`, a redução commita `capacity = 8`, e sobra uma porta reservada acima da capacidade. Cada operação respondeu por metade da pergunta e nenhuma respondeu pela caixa. As duas passaram a travar a **CTO**, e a leitura da porta acontece **depois** do lock — o estado lido antes de travar é uma fotografia que já envelheceu, e é dela que sai o "de → para" da auditoria.

**Um teto que o contrato congelado não tinha:** o banco garante `capacity > 0` e sozinho aceita `capacity = 1_000_000`, o que abre uma transação inserindo um milhão de linhas e segurando o lock. É um campo numérico num formulário, e um zero a mais o produz sem má intenção. `CTO_MAX_CAPACITY = 256`.

**O contrato de rotas do §19 tinha uma lacuna, e ela foi COMPLETADA, não improvisada.** Ele previa três arquivos e a fase precisa de três operações que nenhum deles endereçava — capacidade, inativação e estado da porta. Elas não entraram como campos de um `PATCH` genérico: o projeto não tem endpoint de mudança de estado que aceite `{ status }` ao lado de qualquer outro campo, e o precedente é `POST /api/service-orders/:id/priority`. **Não existe `DELETE` em rota nenhuma** — a ausência é a `N-13` expressa em superfície, reforçada por `Restrict` em `CTO → CTOPort`.

Três decisões menores que não devem ser desfeitas: o tipo da foto é derivado da **extensão da chave** (que o servidor construiu) em vez de ganhar coluna, porque uma coluna seria uma segunda memória do mesmo fato; a chave **nunca sai na resposta** (o DTO expõe `hasPhoto`); e `updateCto` compara **cada** campo com o gravado antes de auditar, porque a tela manda o formulário inteiro a cada "Salvar" e sem isso a auditoria diria que as coordenadas mudaram em toda visita.

**Limite declarado:** a verificação de **vínculo ativo** na redução de capacidade não existe, porque `CustomerNetworkConnection` não existe — criar a tabela agora só para consultá-la seria antecipar a `CTO-2` com uma superfície que nenhum caminho escreve. O ponto exato onde a condição entra está marcado no código. E o blob da foto anterior **não é apagado** numa substituição: sem política documentada de remoção, apagar por suposição é como se perde evidência; órfão custa disco.

Registro em `docs/CTO-NETWORK-DISTRIBUTION.md` §20 e `docs/SECURITY.md` §8.19.

**`CTO-1.1` ENTREGUE — commits locais, sem tag e sem push.** Patch focal sobre as duas ambiguidades que a `CTO-1` deixou, e as duas tinham **metade** fechada. Uma migration aditiva (`20260906210000`, um `ADD CONSTRAINT`), zero dependência, zero Dart.

**A faixa de capacidade passou a valer em três camadas.** Ela existia no `zod` e em `assertCapacity`, as duas de aplicação; entrou o `CHECK` do banco, que é o que sobrevive a um caminho de escrita novo e o que torna `CTO_CAPACITY_MAX` fato da tabela — mudá-lo passa a exigir migration, porque um teto que a aplicação afrouxa sozinha não é teto. **Migration nova, não edição da anterior:** a de CTO-1 já fora aplicada em bancos locais, e reescrever o SQL de uma migration aplicada quebra o checksum e obriga a resetar.

**A guarda de coordenada do cliente estava pela metade, e a metade aberta era minha.** Ela usava `Number.isNaN`, que fecha `"abc"` e **deixa `"Infinity"` passar inteiro**. O motivo de a guarda viver no cliente é do transporte: `JSON.stringify` converte `NaN` **e** `Infinity` em `null`, e `null` é a forma legítima de dizer "remova a coordenada" — o servidor recebe os dois casos como a mesma mensagem e **não tem como distingui-los**. O predicado correto é `Number.isFinite`, o único que corresponde ao que o `JSON.stringify` descarta. O E2E é o único teste capaz de alcançar essa camada, e a reversão o derruba no caso `Infinity`.

**O domínio tinha uma lacuna própria, por outro motivo:** comparação com `NaN` é sempre falsa, então `NaN < -90` e `NaN > 90` são os dois `false` e um teste de faixa **sozinho deixa `NaN` passar** — a verificação parecia total e não cobria o único valor que não se compara.

**Limite declarado:** a migration do `CHECK` **falharia** num banco que já tivesse `capacity` fora da faixa, verificado por ataque e não por suposição. Hoje o risco é nulo — zero linhas assim, a aplicação sempre limitou, e a `CTO-1` nunca foi publicada.

Gates: **1840 Vitest** (era 1817), **121 Playwright** (era 120), lint, tsc, build, `build:worker`, `prisma validate`, **26 migrations**. Três sabotagens (`J`, `K`, `L`), três detectadas.

**`CTO-1.2` — a coordenada fantasma da validação humana era o PLACEHOLDER.** O operador criou uma CTO sem coordenada e viu `-23.5505199` / `-46.6333094` no detalhe. **Não havia nada persistido:** o banco tinha `NULL` nas duas, confirmado por client do Prisma e por SQL cru, com `createdAt == updatedAt` provando que a linha nunca fora editada. Doze testes escritos **antes** de qualquer correção passaram de primeira — é essa a prova de que o backend nunca inventou coordenada, em nenhum caminho (create sem os campos, edição de nome/observações/referência, alteração de capacidade, gravação de foto). Nenhuma migration, nenhuma mudança de backend, zero Dart.

**E ainda assim o defeito é real, e é de apresentação:** o placeholder usava uma coordenada real, completa e plausível, o que em texto cinza num campo não preenchido é indistinguível de valor gravado. **Um exemplo que se parece com o dado não é exemplo, é ambiguidade.** A correção tem duas metades: prefixo `ex.:` nos placeholders, que remove a leitura como valor, e uma nota que **diz** que a caixa não tem coordenada — a segunda é a que fecha o defeito, porque a primeira só tira a dúvida e a segunda entrega a informação.

O teste que fixa isso é de navegador e afirma `toHaveValue("")`: é o valor que iria no submit, e não o texto do placeholder, que é atributo. Um `defaultValue` com coordenada derruba a asserção; o placeholder não — provado por reversão. **Nada foi corrigido no dado**, porque não havia o que corrigir. Revisão focada junto: a web não usa `navigator.geolocation` em lugar nenhum, e não existe default de coordenada em produção.

**`CTO-1.3` — a recusa silenciosa da redução de capacidade.** O operador tentou reduzir 16 → 8 com a porta 14 reservada, clicou, e **nada apareceu**. O backend estava certo: `409`, `capacity` ainda 16, porta 14 ainda `RESERVED`, `updatedAt` inalterado, zero auditoria nova. O erro era renderizado — **num bloco único no topo**, com a lista de portas (até 256 linhas) entre ele e o botão. Nascia fora da viewport de quem clicou. **Uma recusa invisível é indistinguível de um botão quebrado**, e foi assim que o operador a leu.

A correção é da boundary comum: o estado de erro passou a carregar o **escopo** e cada seção renderiza o seu, ao lado do botão que o provocou — as quatro ações da tela ganharam isso de uma vez, porque o problema nunca foi só da capacidade. Junto: depois da recusa o campo volta ao valor autoritativo (com a capacidade atual escrita ao lado), a validação nativa do navegador foi desligada no formulário (`noValidate` — o balão do Chrome aparecia só em alguns casos, sem `role="alert"` e no idioma dele, fazendo a tela falar ora pelo padrão do AlfaOS ora pelo do navegador), e a mensagem do domínio passou a concordar em número.

**Duas hipóteses minhas foram derrubadas pelos dados durante a investigação:** o componente declarado dentro do pai era anti-padrão real e **não** era a causa; o que quebrava era **hidratação** — um `fill` disparado logo após a navegação escreve no DOM, não chega ao estado do React, e o primeiro render devolve o campo ao valor inicial. Instrumentei o componente para ler o estado (`cap=16|err=null`) em vez de seguir supondo. A hipótese da viewport ficou provada por reversão: devolver o erro ao topo derruba o teste **exatamente** em `toBeInViewport`.

Gates: **1852 Vitest**, **124 Playwright** (era 122), lint, tsc, build, `build:worker`, 26 migrations. Zero migration, zero schema, zero Dart.

**Incidente operacional depois da `CTO-1.4`: a aplicação abriu sem CSS, e NÃO era regressão de código.** O commit tocou cinco arquivos e **nenhum** deles é CSS, layout, config, `package.json` ou lockfile — e o componente alterado é da rota `/ctos/[id]`, enquanto o sintoma estava em `/dashboard`. Com o `.next` limpo e **um** servidor de dev, o mesmo commit serve o CSS em 200.

A causa foi provada por reprodução determinística: **`next dev`, `next build` e o Playwright compartilham o mesmo diretório `.next`**. Com o dev no ar, rodar `npm run build` leva o CSS de **200 para 404** e esvazia `.next/static/css/app` — exatamente o sintoma relatado. Dois `next dev` sobre o mesmo `.next` produzem a mesma família de falhas, de forma intermitente. **Fui eu quem causou**, ao rodar os gates com o servidor de validação ativo. Regra e detalhes em `docs/CONTEXT-MAP.md`.

**Isso também corrige uma explicação que dei antes:** atribuí as falhas intermitentes de Playwright durante a `CTO-1.3`/`1.4` a "contenção de recursos". A causa precisa é o compartilhamento do `.next`, não disputa de CPU.

**`CTO-1.5` — a mensagem de capacidade inválida existia; faltava ela PARECER um erro.** O operador digitou `0`, clicou, viu o campo voltar a 16 e não registrou mensagem nenhuma. Reproduzido com hidratação detectada explicitamente (`__reactFiber$`) e digitação por teclado: nenhuma requisição sai, o campo volta ao autoritativo, e o `<p role="alert">` **está no DOM com o texto certo**. A validação local sempre funcionou.

**O defeito era a cor, e era meu:** escrevi `text-danger-text`, e o design system define `danger.fg`. Tailwind ignora classe desconhecida em silêncio, então o texto herdava a cor normal — **preto sobre fundo rosa claro**, que não lê como alerta. Os **dois únicos arquivos do projeto** com a classe inventada eram os meus, e o mesmo erro atingia `success` e `warning`, deixando os selos **Livre/Reservada/Danificada** sem cor de texto. Corrigido: `rgb(15,23,42)` → `rgb(185,28,28)`.

**Por que nenhum teste pegou:** todos afirmavam existência e texto (`toBeVisible`, `toContainText`, `toBeInViewport`) — e a mensagem sempre esteve visível, no lugar certo, com o conteúdo certo. **Nenhuma asserção olhava para a aparência**, que era a única coisa quebrada. Agora duas olham, sem fixar hex: o alerta precisa ter o canal vermelho dominando, e o selo de porta precisa diferir da cor do texto comum.

O teste passou a **digitar como gente** — foco, `Ctrl+A`, teclas — depois de hidratação **explícita**. O helper anterior repetia `fill` até o valor grudar; converge e esconde de qual lado veio a demora. E a mensagem virou a regra, não o lado violado: **"A capacidade deve ser um número inteiro entre 1 e 256 portas."**, uma só, no domínio e nas duas telas.

Gates: **1852 Vitest**, **126 Playwright** (era 124), lint, tsc, build, `build:worker`, 26 migrations.

**`CTO-1.6` — a recusa de coordenada passou a dizer QUAL campo e POR QUÊ.** Latitude `91` com longitude válida era recusada corretamente e a tela dizia só **"Dados inválidos."**. A causa era **autoridade duplicada**: rota e domínio conheciam a faixa `-90..90`, e a da rota chegava primeiro — o `zod` barrava com `"Invalid input"`, a resposta saía genérica, e a mensagem boa, que já existia no domínio, nunca era alcançada. Duas camadas sabiam a mesma regra, e quem falava era a que tinha menos a dizer.

Agora o **`zod` valida FORMA** (número finito) e o **domínio valida REGRA** (faixa), nomeando o campo. Nada foi relaxado — todo caminho de escrita atravessa o domínio, e há teste provando pelas duas portas. `DomainError` ganhou **`field`**, que carrega o nome do campo público que o cliente enviou, nunca coluna, id ou caminho; a alternativa seria a tela adivinhar pelo texto da mensagem, e parsing de frase humana quebra na primeira melhoria de redação. O **par incompleto não nomeia campo** de propósito: o erro é da combinação, e apontar um dos dois sugeriria que o problema está nele.

Campo inválido ganhou `aria-invalid`, `aria-describedby` e borda de erro — a cor nunca é o único sinal.

**Duas armadilhas de Tailwind nesta fase, e as duas custam o mesmo: uma classe que não pinta nada.** A primeira é a da `CTO-1.5` (classe inexistente); aqui os tokens foram conferidos antes, e o CSS gerado confirma que as quatro usadas existem e que nenhuma inventada aparece. A segunda é nova e mais sutil: **concatenar `border-danger-border` a uma base que já traz `border-input-border` não pinta a borda de vermelho** — as duas produzem `border-color`, e vence a ordem em que o Tailwind as emite no CSS, não a ordem na string. O campo ficava com `aria-invalid="true"` e borda cinza.

**E o teste que escrevi primeiro era fraco:** ele exigia que a borda *mudasse*, e a sabotagem `Q` passou por essa fresta — sem a classe normal, a borda cai para o padrão e "muda" mesmo assim. Passou a exigir o **canal vermelho dominando**, e aí a sabotagem cai dizendo o porquê.

Gates: **1868 Vitest** (era 1852), **127 Playwright** (era 126), lint, tsc, build, `build:worker`, 26 migrations. Zero migration, zero schema, zero Dart.

**`CTO-1.7` — a troca de foto FUNCIONAVA e era invisível.** Provado antes de tocar em código, contra o ambiente real: a referência muda, o conteúdo servido muda, existe uma única referência ativa, e o resto da CTO fica intacto. O que faltava era a tela dizer isso — escolher o arquivo já o enviava, e a única mudança visível era o input voltar a "Nenhum arquivo escolhido". **Uma operação que acontece sem sinal é pior que uma que falha com aviso**: quem falha sabe que precisa tentar de novo. Passou a ter miniatura, botão próprio ("Enviar foto"/"Substituir foto"), estado "Enviando…" e confirmação. E a seção da foto foi para **dentro** do formulário, antes do botão, que virou "Salvar alterações". Unificar os dois envios exigiria o `PATCH` de JSON carregar arquivo — mudança de contrato de API para resolver um problema de ordem visual.

**`CTO-1.8` — a foto respondia 200 e não abria, e o dado quebrado fui eu que pus lá.** O blob corrente tinha **141 bytes**: `SOI → APP0 → APP1/Exif → DQT → SOS → 12 34 56 78 → EOI`. Assinatura correta, contêiner que fecha, e **nenhum `SOF`, nenhuma tabela de Huffman** — não há quadro para decodificar. É a saída sanitizada de `montarJpeg`, o fixture de sondagem de EXIF, que **enviei à CTO de QA durante a verificação da `CTO-1.7`** para provar que o GPS saía, e deixei como foto corrente ao declarar o ambiente pronto. O relatório daquela fase citou a mudança de hash **como prova de que a substituição funcionava**: funcionava mesmo, e o destino nunca foi uma imagem.

**A rota estava certa, e isso foi medido.** Corpo HTTP byte a byte igual ao do storage, `Content-Type` acompanhando o formato real, e `naturalWidth`/`naturalHeight` corretos num navegador com imagem de verdade — na primeira foto, na substituição e depois do F5. **`Content-Disposition: attachment` não impede subrecurso de renderizar**, então a troca para `inline` foi avaliada e **recusada**: não corrige nada e enfraquece a defesa que começa recusando SVG no upload. Os três blobs órfãos da mesma CTO — uploads reais do operador — são PNGs íntegros, então a pipeline não corrompeu nada.

**Por que 129 testes verdes não viam.** O `montarJpeg` diz no próprio docstring que não precisa ser decodificável — *"nada no AlfaOS decodifica imagem"*. Era verdade até a `CTO-1.7` acrescentar o primeiro consumidor que **abre**. A partir dela, "os bytes chegaram" e "a imagem apareceu" viraram afirmações diferentes, e todo teste existente respondia só a primeira: presença, atributo, identidade de bytes — **e um `<img>` de origem quebrada satisfaz os três**. A asserção que os separa é a dimensão natural, que só existe depois da decodificação. **Regra que fica:** para afirmar que a imagem ABRE, use `montarPngReal` ou pinte uma no navegador; nunca envie o fixture de EXIF a um ambiente onde alguém vai olhar a tela.

Mudança de produto, uma só: **foto que não abre passou a dizer que não abriu**, com a ação de substituir ao lado e o `<img>` ainda montado para que um carregamento posterior desminta o diagnóstico sem exigir F5.

**Checkpoint final da `CTO-1` — `APPROVED WITH INFO RISKS`.** Consolidação sobre `7011180` (`3c1805e..7011180`, 16 commits), com bateria adversarial própria de oito ataques — **declaradamente não clean-room**, já que quem auditou implementou. Sete barrados; o oitavo virou o único achado, `CTO1-INFO-01`: `setPortAdministrativeState` **não consulta `isPortOfferable`**, então uma porta histórica exibida com o selo "Fora da capacidade" aceita `RESERVED` — e passa a bloquear a redução seguinte. Tenancy e integridade intactas, direção do erro conservadora (recusa, nunca apaga). **Não corrigido de propósito:** é pergunta de produto que o contrato congelado não respondeu — *uma porta danificada continua danificada quando deixa de ser ofertada?* —, e responder em silêncio seria decidir produto por omissão. **A `CTO-2` não pode herdar a suposição de que um estado administrativo prova checagem de faixa**: o `R-13` continua exigindo `isPortOfferable` dentro da transação que grava o vínculo. Registro em `docs/CTO-NETWORK-DISTRIBUTION.md` §22.

**`CTO-1.9` — porta fora da capacidade é histórica e READ-ONLY.** Decisão do dono, fechando o `CTO1-INFO-01`. Enquanto `number > capacity`, a porta não aceita mutação administrativa nenhuma — nem reservar, nem danificar, **nem liberar**; a linha nunca é apagada nem resetada, e voltando a capacidade ela volta a ser operável com o estado que tinha.

**São DOIS predicados, e trocá-los quebra a tela.** `isPortWithinCapacity` responde só a faixa e autoriza a mutação; `isPortOfferable` a consome e acrescenta `AVAILABLE`, respondendo se a porta pode receber cliente. Usar a ofertabilidade como autorização pareceria mais rigoroso e **congelaria toda porta reservada ou danificada**: `RESERVED` dentro da capacidade não é ofertável, e liberar uma reserva é exatamente o que a operação precisa poder fazer. A faixa tem **uma** definição, e três testes existem para derrubar a troca.

**A capacidade vem do lock.** `lockCto` já devolvia `{ id, capacity }`, e é esse valor que a comparação usa — nada de arquitetura nova. A janela fechada é real: reduzir 16→8 e reservar a porta 12 ao mesmo tempo, as duas lendo 16, produziria a histórica reservada. O teste roda a corrida seis vezes e **proíbe** o híbrido em vez de tolerá-lo. Ordem preservada: tenant → CTO → porta → faixa, porque o 409 de faixa nomeia posição e capacidade e confirmaria existência a quem não deveria saber.

**O `no-op` foi movido para depois da regra**: uma porta histórica cujo estado pedido é o que ela já tem sairia com 200, e a tela concluiria que a ação existe.

**Um teste existente mudou de preparo, não de afirmação:** ele marcava a porta 12 como danificada estando fora da capacidade, apoiado numa frase que eu escrevera no domínio — *"marcar histórico como danificado é legítimo"*. Esse caminho deixou de existir; a afirmação ("reaumento não reseta linha reutilizada") continua, agora provada com a porta marcada **dentro** da capacidade que sobrevive à redução.

**Isto NÃO substitui o `R-13`:** a `CTO-2` só pode vincular porta **ofertável**, com `isPortOfferable` dentro da transação que grava. Estar na faixa é necessário e não suficiente. Registro em `docs/CTO-NETWORK-DISTRIBUTION.md` §23.

**Publicada: `v0.14-cto-network-foundation`** — tag anotada em `c9ccf74`, no remoto. Fecha a `CTO-1` inteira: capability por empresa, cadastro, portas automáticas, capacidade 1..256, redução e aumento seguros, histórico preservado, **portas fora da capacidade read-only**, os três estados administrativos com `OCCUPIED` derivado, coordenadas com erro por campo, foto segura com preview decodificável, tenancy e concorrência. `CTO-2` em diante não existe em código.

**`CTO-2` — DOMÍNIO CONGELADO, zero código.** Registro em `docs/CTO-NETWORK-DISTRIBUTION.md` §24. Duas decisões do dono fecharam a fase de desenho.

**`source` é `FIELD · WEB`** — e isso **supera** o trecho publicado que dizia "a `CTO-2` implementa `FIELD`, e só". A operação administrativa Web entrou; `IMPORT` caiu. O princípio que sustentava a regra antiga continua e é o que mata `IMPORT`: endpoint só nasce com caso de uso. O trecho velho ficou marcado como superado no próprio documento, não apagado.

**Porta com vínculo ativo aceita `AVAILABLE` e `DAMAGED`, jamais `RESERVED`** — `RESERVED` significa posição separada para uso futuro e não convive com alguém dentro; `DAMAGED` com cliente ligado é situação real de campo. **A regra é sobre o ALVO, nunca sobre o estado atual**, e isso é deliberado: "porta ocupada não muda de estado" criaria um beco sem saída onde uma porta consertada não pode voltar a `AVAILABLE`, e uma linha legada `active + RESERVED` nunca poderia sair de lá.

**O contador de danificadas MENTE hoje, e o achado é do código.** `effectivePortState` devolve `OCCUPIED` sempre que há vínculo, e `toPublicDetail` conta `damaged` por `effectiveState` — então uma porta `DAMAGED` **ocupada** sai da contagem de danificadas justamente no estado que a decisão do dono tornou legítimo. A precedência publicada não muda (`OCCUPIED` continua vencendo como rótulo); o que passa a ser obrigatório é o DTO carregar as **duas dimensões** e o resumo contar por `administrativeState`. As categorias deixam de somar `capacity`, e é correto que deixem.

Também congelado: modelo sem `equipmentId`, `updatedAt`, `version`, `externalProvider` nem nada de topologia; **duas uniques parciais** (`ctoPortId` e `customerId`, ambas `WHERE disconnectedAt IS NULL`) pelo padrão de SQL cru que `checklist_templates_company_default_key` já usa; ordem de lock **`Customer` → CTOs por id**, sem lock de porta, com ids resolvidos antes do `FOR UPDATE`; `ServiceOrderEvent` **só** quando a origem é `FIELD`; `withIdempotency` reaproveitado, sem mecanismo paralelo; CTO inativa recusa `CONNECT`/`MOVE-IN` e permite `DISCONNECT`/`MOVE-OUT`; e **mutação de porta é online-only**, sem fila offline.

**Trilha `CTO-2` — `2.0` a `2.3` em código, validadas pelo dono; `2.4` (Field) e `2.6` PENDENTES.** Registro em `docs/CTO-NETWORK-DISTRIBUTION.md` §24–§28.

**`CustomerNetworkConnection`** é o registro histórico de *"este cliente esteve nesta porta durante este intervalo"*: desconectar preenche `disconnectedAt` e **nunca apaga**, mover **fecha e abre** numa transação e jamais faz `UPDATE` de porta. Duas **uniques parciais** (`ctoPortId` e `customerId`, ambas `WHERE disconnectedAt IS NULL`) por SQL cru — o DSL do Prisma não expressa a cláusula, e `@@unique` sozinho proibiria o histórico.

**`administrativeState` e `occupied` são dimensões INDEPENDENTES**, e o resumo conta por `administrativeState`. `free + reserved + damaged + occupied` **pode passar de `capacity`** — uma porta pode ser danificada **e** ocupada. Quem apresentar as quatro como fatias de um todo estará errado. O defeito que isso corrigiu era real: `effectivePortState` colapsa em `OCCUPIED`, e contar `damaged` a partir dele fazia uma porta quebrada **com cliente dentro** sumir da contagem.

**O `:id` da rota É a guarda de obsolescência.** `disconnect` e `move` exigem `expectedConnectionId`, comparado **depois** do lock do cliente: sem isso, a tela que mostra o cliente na porta A encerraria o vínculo em B, criado por outra pessoa entre a leitura e o clique.

**Três lições de tela que se repetiram e não podem voltar.** Conflito **fecha** o diálogo e a mensagem sobe para fora dele — a releitura remove a premissa da caixa aberta e levaria a mensagem junto. Confirmação de porta aparece **na linha em que se clicou**: na seção de resumo ela media `viewport ratio 0` numa CTO de 16 posições, que é a `CTO-1.3` renascida. E é **selo**, não bloco de largura inteira: `w-full` no `flex-wrap` crescia a lista e empurrava a seção de capacidade para fora da tela, derrubando um teste da `CTO-1.5`.

**Mover NUNCA é desconectar+conectar** em duas requisições — abriria janela sem vínculo. E a prova disso é a **história auditada**, não a contagem de linhas: as duas formas produzem duas linhas, e só uma registra `MOVED`.

**`CTO-2.4` ENTREGUE — commits locais, sem tag e sem push.** O técnico passou a operar a rede pelo Field, sempre **através de uma OS `IN_PROGRESS` que é dele**. Seis rotas sob `/api/field/v1/service-orders/:id/network`. **Zero migration, zero schema, zero dependência, zero Dart** — `CTO-2.5` é a tela.

**O cliente não é campo de payload, e essa é a proteção.** Ele é derivado da OS do caminho, de modo que *OS legítima do meu técnico usada para mexer em outro cliente* deixa de ter onde ser escrita — não por uma comparação que alguém precisa lembrar de fazer, mas porque não existe campo. O mesmo para `companyId`, `source`, `technicianId`, `serviceOrderId` e todo carimbo de tempo: schemas `.strict()`, e cada um deles é `400`.

**A autorização roda DENTRO da transação do domínio**, por um gancho novo (`ConnectionContext.authorizeWithin`): `loadInProgressOwnedOrder` mais `claimOrderForChildMutation`, o mesmo portão de evidência, material, equipamento, assinatura e checklist. Fora dela, a OS poderia ser concluída entre a conferência e a escrita e o `ServiceOrderEvent` nasceria **depois do fechamento**. A ordem de lock vira `ServiceOrder → Customer → CTO`, sem ciclo, porque nada que trave `Customer` pede `ServiceOrder` exclusivo depois — a origem `WEB` sequer toca OS.

**A leitura também exige `IN_PROGRESS`, e isso DIVERGE de `../diagnostic`** — que é consultado com a OS ainda `ASSIGNED`. A razão está escrita: o que esta leitura abre não é o cliente da OS, é a **rede da empresa**, e nenhuma outra leitura do Field tem esse alcance. Consequência aceita: o técnico não vê a caixa antes de dar início.

**Medido por reversão, não suposto: a escrita tem posse em DOIS portões e a leitura em UM.** Removendo a posse só de `resolveOwnedOrderCustomer`, a escrita continuou recusando (o `loadOwnedServiceOrder` de dentro da transação a pegou) e quem caiu foi a leitura. O mesmo padrão vale para o `IN_PROGRESS`: três portões na escrita, um na leitura. Por isso `F-A1` e `FIELD-R13` são permanentes.

**A sabotagem `AY` passou, e a culpa era do meu teste**: ele mandava `customerId` e `technicianId` **juntos**, e a recusa do segundo pelo `.strict()` chegava primeiro — a asserção passava com o ataque bem-sucedido. Um teste que agrega dois ataques só prova que ALGUM deles foi barrado. Agora é um campo por vez.

**Um achado real da revisão de segurança, corrigido:** string com byte `NUL` atravessava `z.string().min(1)`, chegava ao Postgres e voltava `22021`, traduzido em `INTERNAL` — que é **retentável**, então o aplicativo reenviaria em laço uma requisição impossível. `fieldResourceId` recusa antes, com a **mesma** classe de caracteres de `clientMutationId`. **A classe do defeito é PRÉ-EXISTENTE e maior que a fase** — medido em `serviceOrderEvidence` e `timeEntry` —, e fica como INFO do codebase.

Duas decisões menores que não devem ser desfeitas: o vínculo **não** entra no caminho da rota (ele não é filho da OS — `serviceOrderId` é procedência, `SET NULL`), viaja como `expectedConnectionId`; e o DTO do Field **não tem `effectiveState`**, que colapsa em `OCCUPIED` e apagaria `DAMAGED` de uma porta com cliente dentro.

Registro em `docs/CTO-NETWORK-DISTRIBUTION.md` §29, `docs/SECURITY.md` §8.20 e `docs/FIELD-API.md` §3.4.

**`CTO-2.5` ENTREGUE — commits locais, sem tag e sem push. AGUARDA PILOTO FÍSICO.** O técnico vê e opera a porta da CTO pelo aplicativo. **Zero backend, zero schema, zero migration, zero dependência, zero permissão nova** — o diff é Flutter e documentação, e o manifesto Android tem exatamente as mesmas cinco permissões de antes.

**A rede é SEÇÃO da OS, e não destino da barra.** O técnico não navega pela rede da empresa: ele atende um cliente, e uma superfície fora da OS faria a pergunta *para qual cliente?* voltar a precisar de resposta — que é o que a `CTO-2.4` eliminou ao derivar o cliente da própria OS.

**Fora de `IN_PROGRESS` a seção NEM LÊ.** A leitura da `CTO-2.4` também exige atendimento em andamento; chamar assim mesmo daria um `409` garantido a cada abertura de OS. Há teste afirmando **zero** requisições nesse caso, e outro provando que a seção **fecha sozinha** quando a OS deixa de estar em atendimento com a tela aberta. O portão é de UX; quem recusa continua sendo o servidor.

**`effectiveState` não existe no modelo Dart.** Ele colapsa em `OCCUPIED` e apagaria `DAMAGED` de uma porta com cliente dentro — o defeito que a `CTO-2.2` corrigiu no resumo administrativo, aqui impedido por **ausência de campo**. As duas dimensões chegam e são exibidas separadas, inclusive no legado `RESERVED + ocupada`.

**ONLINE ONLY, e a mensagem não mente.** Nada de fila offline, reserva local ou "sincronizamos depois". A prova é estrutural: um teste lê o **código** do módulo, com os comentários removidos, e exige zero `PendingOperation`/`SyncStatus`. **Nenhuma dependência de conectividade foi adicionada** — trazer um pacote só para desabilitar um botão seria superfície de terceiro em troca de nada, e a falha de rede já chega tipada.

**A chave de idempotência inclui o DESTINO** (`connect:<porta>`, `move:<vínculo>:<porta>`). Presa só à operação, seria reapresentada quando o técnico desistisse e escolhesse outra porta, e o servidor recusaria uma operação legítima. Três regras de descarte, e a do meio é a menos óbvia: sucesso descarta, conflito descarta, **sem rede PRESERVA** — e sem rede a OS **não** é relida, porque reler traria uma `version` nova e a retentativa viraria `IDEMPOTENCY_CONFLICT` em vez do replay que deve ser.

**Três testes estruturais meus falharam nas minhas PRÓPRIAS frases**: eles grepavam o arquivo cru e liam *"não chamamos /api/cto-connections"* como se fosse uma chamada — e o mesmo no manifesto, cujo comentário diz que `ACCESS_BACKGROUND_LOCATION` **não** é pedida. Agora removem comentários antes de olhar, e o do manifesto virou **igualdade de conjunto**. Mais dois defeitos de teste: `FU-18` procurava "PPPoE" na tela inteira e caía na seção de PPPoE, que é legítima; e o teste de 390×844 **passou duas vezes pelo motivo errado** — a `MediaQuery` ficava fora do `MaterialApp` do harness e, corrigido isso, o widget nem era construído porque estava fora da viewport.

Duas decisões que não devem ser desfeitas: **mover é UMA requisição** (o teste conta: um `move`, zero `disconnect`, zero `connect`) e a porta atual não é oferecida como destino **sem regra própria** — ela chega `occupied` do servidor, e `isPortOfferable` não foi copiado para o Dart.

Registro em `docs/CTO-NETWORK-DISTRIBUTION.md` §30 e `apps/field/DESIGN.md`.

**`CTO-2.6` ENTREGUE — commits locais, sem tag e sem push.** As duas proteções que faltavam, e as duas são sobre o mesmo erro: uma decisão administrativa passar por cima de um cliente conectado. **Zero migration, zero schema, zero rota, zero UI, zero Dart** — o diff de produção é `src/lib/cto.ts`.

**A regra do estado é sobre o ALVO, nunca sobre o estado atual.** `RESERVED` é proibido enquanto há vínculo ativo; `AVAILABLE` e `DAMAGED` continuam permitidos. *"Porta ocupada não muda de estado"* criaria um beco sem saída: porta consertada nunca voltaria a `AVAILABLE`, e a linha legada `ativa + RESERVED` ficaria presa para sempre. `DAMAGED` com cliente ligado é situação real de campo — o cabo quebra com o cliente conectado. O **no-op recusa junto** (lição da `CTO-1.9`): um `200` mudo anunciaria uma ação indisponível.

**Redução de capacidade com cliente acima do novo limite recusa**, e nada é feito por conta própria: nenhum vínculo encerrado, nenhum cliente movido, nenhuma porta apagada, nenhuma alteração parcial. É reportada ANTES da regra da `CTO-1` porque é a mais dura de destravar — estado se resolve num clique, cliente conectado exige decisão de operação.

**O LUGAR da regra é a regra.** As duas consultas vêm depois do `FOR UPDATE` da CTO, no mesmo `lockCto` da `CTO-1`: nenhum lock novo, nenhuma ordem nova, nenhum lock de `CTOPort`.

**As corridas da primeira versão PASSAVAM com a regra removida, e a culpa era do teste.** Disparadas juntas, a operação administrativa sempre vence o lock — o `CONNECT` faz mais trabalho antes dele. A ordem perigosa nunca acontecia. Agora cada corrida roda nas **duas** ordens e conta quantas vezes o vínculo venceu, exigindo pelo menos uma. Foi essa correção que tornou possível a prova mais importante: mover a consulta para ANTES do lock derruba exatamente `RACE-02` e `RACE-04`.

**`S5` não derrubou nada, e isso está registrado:** o `companyId` dessas duas consultas é **defesa em profundidade, não fechamento de vetor** — o `ctoPortId` já foi provado da empresa pelo `lockCto`. Medido: linha corrompida com tenant cruzado não bloqueia a redução.

Um teste da `CTO-2.2` mudou de **preparo**, não de afirmação: ele montava a linha legada pelo serviço, caminho que a fase proíbe, e passou a gravá-la direto no banco — que é como dado antigo existe.

Registro em `docs/CTO-NETWORK-DISTRIBUTION.md` §31.

**`CTO-2.7` `APPROVED` — e com ela a trilha `CTO-2` está `DONE`. Commits locais, sem tag e sem push.** Fase de validação, **zero diff de produção**: nasceu um arquivo de teste e nada mais.

**Validação do dono `PASS` em 2026-09-09**, na interface real sobre `CTO QA FIELD 01`: os onze passos do roteiro, incluindo as três regras que a `CTO-2.6` acrescentou — `RESERVED` recusado em porta ocupada, e as reduções `8 → 4` e `8 → 6` recusadas pela ocupação. O passo que mais importa é o quinto: **liberar tirou `DAMAGED` sem remover o vínculo**, que é a prova, fora do teste, de que a regra é sobre o ALVO e não sobre o estado atual.

**A conferência do banco depois da restauração mostrou o que só a leitura mostra:** o histórico guardou **cada passo** do roteiro em vez de ser sobrescrito, as linhas `FIELD` do piloto de aparelho da `CTO-2.5` continuam intactas ao lado das novas, e o `MOVE` de volta para a porta 03 criou linha **nova** — a caixa registra que o cliente esteve lá, saiu e voltou.

**Onze dos quinze critérios de aceite pertencem ao `CTO-2` e estão rastreados** (matriz em §32); os outros quatro são de `CTO-3` (mapa), `CTO-5` (status/idade) e `CTO-7` (QR), que não existem em código.

**A única lacuna era de COBERTURA, não de comportamento.** O invariante *"o vínculo não pertence ao ciclo de vida da OS"* era estruturalmente verdadeiro — único escritor (`cto-connections.ts`), **zero `delete` em produção**, FK da OS `SetNull` — e não tinha teste nenhum. `LIFE-02` compara **todas** as linhas da empresa por igualdade profunda, porque conferir só a que a OS criou deixaria passar exatamente o defeito que preocupa: uma limpeza escrita por empresa.

**Duas medições das sabotagens que não se redescobrem.** Removendo o pré-check de porta ocupada (`T1`), as **corridas continuam passando** — o índice parcial segura a integridade, e o que cai é o `409` limpo do caso sequencial: pré-check dá a mensagem, índice dá a integridade, e cada um tem detector próprio. E a sabotagem de TOCTOU (`T3`) é detectada em 4/4 execuções sempre por `RACE-04`, e só em 2/4 por `RACE-02`, porque o caminho pré-lock do `MOVE` é mais longo e a dianteira de 25 ms leva à ordem perigosa com mais frequência. O par cobre; nenhuma sozinha é garantia.

**A UI Web não tem tela de histórico de vínculo.** `getCustomerNetworkView` devolve `current` **e** `history`, e a tela consome só `current`, dentro do diálogo, para trocar a ação para *Mover*. É decisão registrada, não defeito — o histórico vive no backend e é provado por `CN-12`, `CN-14` e `LIFE-01`.

Seis sabotagens (`T1`–`T6b`), seis detectadas, todas restauradas. Registro em `docs/CTO-NETWORK-DISTRIBUTION.md` §32. **`CTO-6` (frescor do diagnóstico) e `CTO-7` (QR) seguem sob a §119.**

**`CTO-3.0` — discovery do mapa. `DISCOVERY / PLANNED`, nada em código.** Zero produção: nasceu um teste de caracterização e nada mais. Registro em `docs/CTO-NETWORK-DISTRIBUTION.md` §33.

**Há uma DIVERGÊNCIA aberta, e ela é decisão do dono.** O PRD §339 diz que *"a CTO é entidade do Mapa Operacional (§136), que não existe; **CTO-3 depende dele**"* — e a §136 é o mapa do **despacho** (técnicos, clientes, OS), não um mapa de CTOs. A §207 quer o mapa *"ao lado do quadro e da agenda, sobre o mesmo motor"*. Um mapa só de CTOs criaria a segunda superfície que a §207 existe para evitar. **Recomendação:** motor agnóstico de camada, com a camada de CTO primeiro — o trabalho é o mesmo, muda a ordem de entrega.

Quatro fatos do inventário que não se redescobrem: **não existe biblioteca de mapa, componente de marker, cluster nem consulta por bounding box** em lugar nenhum do repositório; **`TechnicianLocation` não existe** (§135 é `[DIFERENCIAL]` sem código), então o mapa web não tem posição de técnico a mostrar; a §339 já decidiu que no Field **a proximidade ORDENA a lista e não escolhe**, de modo que a primeira entrega lá é ordenação e não mapa; e **`listCompanyCtos` não tem teto nem cursor** — serve à tela de gestão e não serve ao mapa (§200).

**A fonte da verdade da coordenada da caixa já está decidida em código**: `CTO.latitude/longitude`, e o schema diz por quê — *"coordenada da CAIXA, não do cliente; a da caixa é pública por natureza, porque ela fica no poste"*. Falta `accuracy`, `source`, confirmação e histórico. **Proposta: colunas na própria `CTO`, não uma `CTOLocation`** — `CustomerLocation` virou tabela separada porque `Customer.latitude/longitude` já existia e não podia ser removida; a `CTO` não tem esse legado, e criar tabela ao lado reproduziria a duplicação em vez de evitá-la. **Sem `version` próprio:** a CTO serializa por `lockCto`, e um segundo CAS não teria pergunta a responder.

**A precedência com o FiberMap NÃO precisa ser proposta — a §334 já a fixou**, e o ponto que a `CTO-3` não pode enfraquecer é que divergência entre os dois é fato a **exibir**, nunca merge automático.

Lacuna encontrada e fechada sem tocar produção: **`src/lib/geo.ts` não tinha teste direto** — haversine e os dois validadores, que são a primitiva da ordenação por proximidade.

**As duas decisões que bloqueavam a fase foram TOMADAS pelo dono:** um **motor de mapa compartilhado**, com a CTO como primeira camada — nem §136 inteira antes, nem mapa isolado de CTO —, e **Leaflet + React Leaflet** aprovados para a `3.2`, com o provedor de tiles **configurável**, nunca acoplado ao código.

**`CTO-3.1` ENTREGUE — commits locais, sem tag e sem push.** `GET /api/ctos/map` e `src/lib/cto-map.ts`: a primeira camada do Mapa Operacional, **sem mapa**. **Zero migration, zero schema, zero dependência, zero Dart, zero UI.**

**Uma autoridade para a contagem:** `summarize` virou **`summarizePortCounts`, exportada**, e o mapa chama a MESMA função do detalhe administrativo. O `GROUP BY` em SQL seria mais rápido e criaria uma segunda verdade — a `CTO-2.2` já mostrou como essa divergência se esconde. O preço está medido: 1.600 a 3.200 linhas de porta por consulta no uso real, 51.200 no pior caso teórico; se pesar, a saída é `GROUP BY` **com teste de consistência**, nunca reescrita silenciosa.

**Três decisões que não devem ser desfeitas.** Recorte que cruza o antimeridiano é **RECUSADO**, não tratado: uma rede de distribuição é local, e um `200` vazio faria o mapa concluir que não há caixas na região. `missingLocationCount` é **da empresa, não do recorte**, porque caixa sem coordenada não está em região nenhuma — e nada de `0,0` inventado. E o status do marcador é derivado na precedência `INACTIVE > DAMAGED > FULL > AVAILABLE`, com **`DAMAGED` antes de `FULL`** porque lotada é informação de capacidade e defeito é informação de manutenção — manutenção é o que faz alguém se deslocar.

**Duas das cinco sabotagens PASSARAM, e as duas eram culpa dos testes.** Filtrar o recorte em memória produz **exatamente a mesma lista** — nenhum teste de resultado distingue os dois, e o que muda é o banco devolver a carteira inteira antes; nasceu daí o `MAP-20`, que afirma sobre a **consulta**. E remover o teto do domínio passou porque todos os testes de teto pediam pela **rota**, que limita antes; o guarda de dentro nunca era exercido, e ele é a única coisa entre um mapa e a carteira inteira para quem chamar `getCtoMapView` direto.

**Leitura aberta ao `DISPATCHER`**, dentro do que o `C-07` já previa (*"por fase que precise dela"*). Nenhum perfil novo, nenhuma capability nova, nenhuma escrita ampliada — `CONNECT`, `MOVE` e `DISCONNECT` seguem como a `CTO-2` os entregou.

**Nenhum índice novo**, e a razão está registrada: no volume atual o `companyId` já reduz a varredura, e um índice espacial só se paga quando a faixa de coordenada for o filtro seletivo.

Registro em `docs/CTO-NETWORK-DISTRIBUTION.md` §34. **`3.3` e `3.4` continuam sob a §119.**

**`CTO-3.2` ENTREGUE — `READY FOR OWNER VALIDATION`. Commits locais, sem tag e sem push.** A primeira superfície visual do Mapa Operacional, com a CTO como primeira camada: `/mapa`, Leaflet + React Leaflet, marcadores, popup, busca global no tenant e contador de caixas sem localização. **Zero migration, zero schema, zero Prisma, zero Dart.** Duas dependências novas, e elas acrescentaram **zero vulnerabilidades** — medido contra o lockfile de `c494307`, que já tinha 16, incluindo o `critical`, todas de `next` e `firebase-admin`.

**A superfície se chama Mapa Operacional, nunca "Mapa de CTOs".** As camadas de técnico, cliente e OS entram sobre o mesmo motor (§136, §207), e nomear pela primeira camada faria a segunda nascer como uma segunda tela. Existe fronteira real — `OperationalMap` e `MapCanvas` não importam nada de CTO — e **nenhuma abstração para camada que não existe**: sem registro de camadas, sem seletor, sem interface `MapLayer`.

**O achado que decidiu a arquitetura da configuração: a CSP bloqueava todo tile.** `img-src 'self' data:` recusa imagem de outro host, e tile é imagem. O modo de falha é traiçoeiro — a página carrega, os controles funcionam, os marcadores aparecem, e só o fundo some, porque violação de CSP apaga a imagem em vez de quebrar a página. Por isso o provedor mora em `src/lib/map-tiles.config.mjs`: `next.config.mjs` roda em Node puro, antes de qualquer transpilação, e **não importa TypeScript**. Com a configuração só no `.ts`, a CSP teria de repetir o host, e a primeira troca de provedor deixaria a URL certa no `TileLayer` e o host velho na política. **Uma configuração de tiles que não alimenta a CSP não é configurável.**

**Leaflet entra por uma porta só.** Ele toca `window` na carga do módulo, e componente de cliente ainda é renderizado no servidor pelo Next — `import` estático derrubaria o `next build`. Entra apenas por `dynamic(..., { ssr: false })`, e isso foi **verificado no artefato**: `grep -rl leaflet .next/server` devolve zero arquivos; ele aparece só num chunk de cliente.

**A busca é um contrato SEPARADO** (`GET /api/ctos/map/search`, teto 10, DTO de cinco campos), por decisão do dono: procurar vale em toda a rede, não no recorte. Ensinar `/api/ctos/map` a varrer a carteira quando um parâmetro aparece transformaria a única superfície com teto garantido numa com teto **condicional**. O mínimo de dois caracteres conta caracteres **que não são `%` nem `_`**, e isso fecha vetor real: um teste de caracterização **mediu** que o `contains` do Prisma não escapa curinga, então `%%` satisfaria o mínimo e casaria com tudo.

**Estado nunca viaja só como cor:** forma, glifo e rótulo por estado, com a cor em quarto lugar. E **nada é recalculado no cliente** — `status` e as contagens chegam prontos da `CTO-3.1`; a tela conhece a tradução, não a precedência.

**O teste de navegador encontrou um defeito real da minha implementação:** com a API falhando, o aviso de erro cobria o mapa e a linha de baixo continuava dizendo *"0 CTOs nesta área"* — a frase exata que a fase existe para não dizer. Corrigido com dois elementos distintos, para que um teste possa afirmar a **ausência** da contagem e não apenas que o texto dela mudou.

**E um teste meu passava pelo motivo errado**, na mesma classe das corridas da `CTO-2.6`: o `UI-MAP-06` disparava o arrasto antes de o atraso de 350 ms vencer, então o temporizador pendente era substituído e existia **uma** requisição em vez de duas — a ordem perigosa nunca acontecia. Agora ele espera a primeira leitura estar comprovadamente em voo.

**Permissões inalteradas:** `ADMIN` e `DISPATCHER` leem o mapa, como na `CTO-3.1`. `/ctos/[id]` continua de `ADMIN`, e por isso o botão **Abrir CTO** não é oferecido ao `DISPATCHER` — um botão que redireciona sem explicação é pior que a ausência dele. `CONNECT`, `MOVE` e `DISCONNECT` seguem como a `CTO-2` os entregou.

**O placeholder *"Mapa Operacional — EM BREVE"* que o enunciado citava está no FIELD**, com `route == null`; a web não tinha entrada de mapa nenhuma. Esta fase é web e zero Dart, então o item do Field ficou como está — o mapa dele é outra fatia (§339, onde a proximidade **ordena a lista** e não desenha mapa).

Sete sabotagens, **sete detectadas**, e duas medições valem mais que o placar: **`S7` tem um único detector, e é de navegador**; e **`S2` cai no Vitest e não no navegador**, porque ali o `AbortController` rejeita a leitura anterior antes de ela chegar — no navegador o bilhete de sequência é defesa em profundidade atrás do aborto, não o mecanismo principal.

**Aviso operacional registrado:** a política de uso dos tiles públicos do OpenStreetMap **não** é infraestrutura de produção. Antes de produção, `MAP_TILE_URL` aponta para provedor contratado ou tiles próprios — nenhuma linha de código muda.

Registro em `docs/CTO-NETWORK-DISTRIBUTION.md` §35.

**`CTO-3.2.1` ENTREGUE — `READY FOR OWNER VALIDATION`. Commits locais, sem tag e sem push.** A validação da `CTO-3.2` foi **suspensa pelo dono a um passo do fim**: o mapa abriu, o Leaflet funcionou, a busca achou a `CTO QA FIELD 01` — e apareceram um defeito de UX e três melhorias aprovadas para a primeira versão. **Zero migration, zero schema, zero Prisma, zero Dart, zero dependência nova.**

**O defeito: `Mapa Operacional → Abrir CTO → Voltar` caía em `/ctos`.** O operador perdia o bairro, o zoom e a caixa em destaque. **`router.back()` foi recusado** — ele responde *"a página anterior do navegador"*, que não é a mesma pergunta que *"de onde este fluxo veio"*: `F5`, link colado, aba nova e um `back` depois de três navegações produzem históricos diferentes. A origem é explícita, viaja na URL e **estende a allowlist que já existia** (`return-to.ts`) em vez de criar um segundo mecanismo — entrando como **caminho puro**, com a vista em parâmetros próprios validados um a um e o destino **remontado**, de modo que nada do que o cliente escreveu é ecoado na `href`.

**Três bases num único `MapContainer`:** `NORMAL` (OSM), `SATELLITE` (Esri World Imagery) e `HYBRID` (satélite + rótulos da CARTO). Remontar o mapa a cada clique no controle jogaria fora centro e zoom — o oposto do que a fase conserta. Os dois provedores novos foram **testados ao vivo antes de virarem padrão**. E **o Esri usa `{z}/{y}/{x}`**, linha antes de coluna: escrever na ordem habitual devolve tiles de outro lugar do planeta, com o mapa carregando e mostrando a cidade errada.

**`MAP_SATELLITE_ENABLED=false` remove os dois modos e encolhe a CSP sozinho** — o híbrido cai por consequência, porque ele **é** o satélite com rótulos. O que se perde é um botão; a base cartográfica não depende disso. As três origens saem de `tileImageSources`, derivadas da mesma configuração, e **nunca de curinga**.

**O marcador virou uma caixa óptica em SVG próprio, sem dependência nova.** A silhueta é idêntica nos quatro estados — é a identidade da CTO —, e o **selo** carrega forma **e** glifo (`+ 0 ! ×`). A legenda mostra o selo e não redesenha a caixa: o que não varia não precisa de legenda.

**A vista vive na URL** (centro, zoom, modo, busca, seleção), espelhada por `history.replaceState` e nunca pelo `router`, que trataria cada arrasto como navegação. Marcador nenhum entra ali: a URL é o endereço de uma vista, não um cache.

**Dois defeitos que só o navegador encontrou, e os dois valem para qualquer tela futura com Leaflet.** `replaceState(null, …)` **apaga o estado de roteamento do App Router**, e o sintoma é um link que simplesmente não faz nada, sem erro no console — repasse sempre `window.history.state`. E uma prop derivada da câmera chegando aos marcadores fecha um **laço de realimentação**: o popup re-renderiza, o `autoPan` do Leaflet move o mapa, o `moveend` muda a prop de novo — `Maximum update depth exceeded`, e **o popup para de abrir**. A cura foi ler a vista da barra de endereço e `memo` nos marcadores, com array vazio estável e `onReady` estável.

**Limite declarado:** abrir o popup e **arrastar** o mapa sem fechá-lo deixa a `href` com a vista de antes do arrasto, e a volta cai alguns metros ao lado. Fechar a fresta custaria interceptar o clique, tirando do link o "abrir em nova aba".

Oito sabotagens, **oito detectadas** — e o `S4` cobrou um teste fraco meu antes de cair inteiro: o glifo do `FULL` é `"0"`, e `viewBox="0 0 40 40"` já contém um zero, então `toContain(glyph)` passava com o `<text>` removido.

**Decisão aprovada e NÃO implementada (`CTO-3.2.2`):** camadas `CTOs` (ligada), `OS abertas` (ligada) e `Clientes` (desligada); cliente com OS aberta destacado; selo de OS abertas por CTO; busca alcançando CTO, cliente e número de OS. O motor continua **sem registro de camadas, sem seletor e sem interface `MapLayer`**. FiberMap segue `FUTURO`.

**Divergência de nome, declarada:** o enunciado cita `/mapa-operacional`; a rota real, já validada pelo dono, é **`/mapa`**.

Registro em `docs/CTO-NETWORK-DISTRIBUTION.md` §36. **Aguarda validação do dono pela interface antes de qualquer tag.**

**ESCOPO DA V1 CONGELADO — PRD Parte XVI (§362–§391). Execução documental, zero produção.** O AlfaOS tinha mais visão registrada do que cabe num primeiro lançamento, e agora tem uma fronteira. **`docs/PRD.md` continua sendo a fonte canônica** — a Parte XVI diz o que entra na V1, não descreve funcionalidade nova por descrever. A §119 continua valendo linha por linha.

**O que a V1 promove:** camada de clientes ativos e de OS abertas no Mapa Operacional, Online/Offline reaproveitado da OS, busca operacional, timeline do cliente, dashboard acionável e pacote técnico de evidências. **O que fica fora, nomeado:** §388 é V2 (falha coletiva, incidentes, NOC, manutenção preventiva, camada de técnico, métricas) e §389 é V3 (FiberMap e rede física).

**Quatro premissas do enunciado foram corrigidas por medição, e valem mais que o resto:**

* **`STALE` não existe.** `ConnectivityStatus` tem três valores — `ONLINE`, `OFFLINE`, `UNKNOWN`. Não há limiar de frescor em lugar nenhum; o que existe é `observedAt`, a **idade** da leitura, que viaja junto do estado (§370). Inventar um limiar seria uma regra que ninguém definiu para um provider cuja cadência ninguém mediu.
* **O checklist por tipo de OS JÁ EXISTE** desde a v0.10 — `ChecklistTemplate`, único por `(companyId, serviceOrderTypeId)`, com superfície administrativa e aplicado como snapshot na execução. Foi apresentado como escopo novo por engano; o trabalho real é verificar cobertura (§382).
* **A máquina de estados da OS tem CINCO valores** (`PENDING · ASSIGNED · IN_PROGRESS · COMPLETED · CANCELLED`). *Agendada* é o campo `scheduledAt`, não um estado; *em deslocamento* e *pausada* não existem; e `CANCELLED` continua declarado e inalcançável. Os gaps ficaram registrados em §385 **sem inventar enum** que contradiga o código.
* **O pacote de evidências já tem todas as peças** — execução, treze categorias de evidência (incluindo medição óptica, speedtest e etiqueta), assinatura, equipamento, check-in e snapshot de checklist. Falta a **reunião**, não o dado (§383).

**O contrato mais importante da Parte é a autoridade única de Online/Offline (§370).** Ela já existe em código, e um invariante dela também: **falha de integração é afirmação sobre a integração, nunca sobre o cliente** — nenhum caminho de erro escreve `OFFLINE`. O que a fase seguinte precisa é **extrair uma leitura em LOTE** sobre a mesma tabela e o mesmo DTO, porque hoje a leitura é de um cliente por chamada e um mapa faria `N+1`. **O mapa lê; ele não dispara refresh** — o teto de 10 chamadas por minuto por empresa é da OS, e um mapa que atualizasse por marcador o queimaria num arrasto.

**Nasceu `docs/MASTER-PLAN.md`** — ele **não existia**: havia planos por trilha e nenhum lugar que respondesse "o que vem depois, e por quê" olhando o produto inteiro. Traz a sequência até o lançamento e cinco fatias propostas (`CTO-3.2.2`, `DASH-1`, `TL-1`, `EV-1`, `GS-1`), cada uma com dependências, entregas, testes, segurança e risco. **Não é um segundo PRD**: onde divergirem, o PRD vence.

Duas decisões marcadas como `DECISION UPDATED`, sem apagar histórico (§390): a **§136** era `[DIFERENCIAL]` e o subconjunto CTO + clientes + OS abertas passou a `V1 MUST HAVE` — a camada de **técnico** continua `FUTURO` e continua dependendo de `TechnicianLocation`, que não existe; e a **§339** dizia que a `CTO-3` dependia do §136 existir, o que o dono resolveu na `CTO-3.0` com motor compartilhado e camada de CTO primeiro.

**`CTO-3.2.1b` ENTREGUE — `READY FOR OWNER VALIDATION`. Commits locais, sem tag e sem push.** A validação funcional da `CTO-3.2.1` **passou**; ficaram quatro problemas de UX, e esta fase resolve só eles. **Zero produto novo, zero migration, zero Prisma, zero Dart, zero dependência.** O PRD V1 continua `FROZEN`.

**Altura em pixels, nunca em viewport.** Com `vh` o mapa crescia com a tela e empurrava busca, contadores e legenda para fora da primeira dobra. **Altura de mapa não é fração de tela** — é faixa de leitura: 380 / 440 / 500 / 560 px. A proibição vale para **qualquer** unidade de viewport, porque `60vh` produz o mesmo defeito mais devagar.

**A placa "Map data not yet available" foi MEDIDA, provedor por provedor.** Buscando quatro tiles vizinhos por nível e comparando bytes — quatro idênticos significa placa, não imagem: o OSM tem `z19` em todo lugar; o **Esri tem `z19` só em São Paulo e `z18` em cidade média e área rural**; a CARTO tem `z19`. **O que torna o satélite traiçoeiro é ele responder `200 image/jpeg`** com uma placa de 2.521 bytes byte-idêntica em qualquer região — o Leaflet não tem como saber que aquilo não é imagem, então desenha. Um `404` teria feito um buraco visível; um `200` faz uma mentira.

A cura é **`maxNativeZoom` por camada** (19 · **18** · 19) mais **um `maxZoom` de mapa** (20): acima do nativo o Leaflet amplia o último nível real em vez de pedir um que não existe. **O valor do satélite é o pior caso medido, de propósito** — adotar 19 devolveria a placa para a maior parte do país, e adotar 18 custa um nível de nitidez nas capitais. Um defeito é cosmético; o outro faz o mapa afirmar que não há dado onde há. **Esconder com CSS seria o oposto**: o tile continuaria sendo pedido e o mapa mentiria em silêncio. O híbrido não precisou de regra própria — cada camada amplia a partir do próprio nativo, e nenhuma quebra enquanto a outra continua.

**O marcador virou uma caixa óptica de verdade.** A primeira versão desenhava as portas como duas fileiras de três pontos, e o dono recusou pelo motivo certo: no tamanho real aquilo lê como teclado. Agora é corpo com linha de tampa, **bandeja com uma régua de traços verticais contíguos** — contiguidade lê como conector, pontos espalhados leem como botão — e **prensa-cabo** com a fibra descendo, que é o que remove a leitura de "roteador" ou "caixa de luz".

**O botão "Abrir CTO" era um defeito de ESPECIFICIDADE.** `leaflet.css:264` pinta todo `<a>` do mapa com `#0078A8` (`0,1,1`) e vence a utility do Tailwind (`0,1,0`) — o texto saía **azul sobre azul, 1,05:1**, medido no navegador. **Nenhuma asserção existente pegaria**: o elemento estava lá, com o texto certo, no lugar certo, visível. É a `CTO-1.5` com outra causa. O teste que fecha isso **calcula o contraste WCAG** a partir do `getComputedStyle`, nos dois temas, e reproduz o número exato do defeito.

**Uma regressão de bundle nasceu e morreu no mesmo dia.** Ao centralizar as constantes de zoom, `MapCanvas` passou a importar **valor** de `map-config`, que importa `prisma` — o defeito da `DQ-4` renascendo um commit depois de ser prevenido. O teste estrutural escrito na `CTO-3.2` pegou; as constantes passaram a vir do `.mjs` puro.

Oito sabotagens, **oito detectadas**. A mais informativa é a do botão: o teste devolveu `contraste 1.05:1 entre rgb(0, 120, 168) e rgb(37, 99, 235)` — o defeito do dono reproduzido em número.

**INFO pré-existente, medido e não corrigido:** o bundle de cliente contém o **shim de navegador** do Prisma (~58 KB), porque componentes de cliente importam o enum `AccessProfile`. Não é o cliente real — `getPrismaClient`, `libquery_engine`, `datasources` e `$connect` estão ausentes, e os construtores de erro são stubs que lançam "unable to run in this browser". Sem engine, sem credencial, sem capacidade de consulta.

Registro em `docs/CTO-NETWORK-DISTRIBUTION.md` §38.

**`CTO-3.2.1c` ENTREGUE — `READY FOR OWNER VALIDATION`. Commits locais, sem tag e sem push.** A validação da `CTO-3.2.1b` passou no resto — altura, zoom, as três bases, retorno, popup, botão e persistência —, e ficaram dois pontos: o **nome da CTO por cima dela** no mapa, e um marcador que ainda não convencia. **Zero produto novo, zero migration, zero Prisma, zero Dart, zero dependência.** O PRD V1 continua `FROZEN`.

**A plaqueta é um `Tooltip` `permanent` do react-leaflet, e o texto NUNCA entra no `divIcon`.** `divIcon` recebe HTML cru e o injeta no DOM, e nome de caixa é digitado por gente; o `Tooltip` renderiza os filhos por **portal do React**, que escapa texto — uma caixa batizada de `<img src=x onerror=…>` aparece com esse nome escrito. Injetar no ícone economizaria um elemento e abriria uma porta de HTML cru para dado de usuário. Ela usa os **tokens do popup** (`surface` + `fg`), que o dono já validou sobre as três bases, e é **opaca de propósito**: com alfa, o contraste do texto passaria a depender do pixel do tile atrás e deixaria de haver um número para afirmar.

**A densidade foi MEDIDA, e o que havia para medir era geometria — não dado.** O banco de desenvolvimento tem **uma** caixa com coordenada, então não existe densidade real para observar, e isso fica dito em vez de suposto. Pela projeção do Web Mercator, duas plaquetas de 112px colidem abaixo de `z16,7` a 150 m e abaixo de `z15,7` a 300 m. Adotado **`MAP_LABEL_MIN_ZOOM = 16`**, com **duas cláusulas e nada além**: no zoom operacional todas as caixas do recorte mostram o nome, e a **selecionada** mostra em qualquer zoom — é a segunda que torna a primeira usável, porque quem achou uma CTO na busca precisa saber qual mancha é a dela. **Limite declarado:** o limiar não evita colisão, evita a **parede**; duas caixas a 40 m continuam encostadas em `z16`, e esconder rótulo por sobreposição foi recusado de propósito — seria uma regra que o operador não consegue prever.

**Um BOOLEANO atravessa a fronteira, e nunca o zoom.** É a realimentação da `CTO-3.2.1` de novo: prop derivada da câmera chegando aos marcadores fecha o laço `popup → autoPan → moveend → render`, que custou `Maximum update depth exceeded` e o popup parando de abrir. Um número muda a cada micro-movimento; `showLabels` só muda ao **cruzar** o limiar, e o `memo` bloqueia o resto. `MAP_LABEL_MIN_ZOOM` mora no `.mjs` puro, junto das outras constantes de zoom, para nenhum componente de cliente importar valor de módulo que alcança Prisma.

**No marcador, o defeito era a PROPORÇÃO — não a falta de detalhe.** O corpo media **29 × 21**, deitado, e caixa deitada com uma faixa dentro lê como aparelho de mesa. Agora é **20 × 27** com cúpula quase semicircular (raio 8,5 numa largura 20), costura de tampa com **fecho**, **quatro** adaptadores em vez de seis — seis ficavam a 2,6px um do outro no tamanho real e se fundiam num borrão de radiador —, uma placa de prensa-cabos estreita e tucada, e a **drop saindo em curva** contra o tronco reto: fibra nunca corre em ângulo reto, e é a curva que faz o desenho ler como telecom.

**Duas tentativas foram DESCARTADAS na própria fase, e o motivo fica registrado:** **orelhas** de fixação nas laterais e **dois prensa-cabos** separados embaixo leem como **pés** a 5×, e as orelhas ainda somavam largura justamente onde a fase tentava estreitar, anulando a única mudança que importava. As duas foram reprovadas **olhando o desenho renderizado**, não por inspeção de código — marcador é peça visual, e a única forma de reprovar um desenho é olhar para ele.

**A geometria virou DADO exportado (`CTO_MARKER_GEOMETRY`), e o SVG é montado a partir dela.** Antes o teste extraía coordenadas com expressão regular, e quando o corpo virou `<path>` por causa da cúpula a `UXP-09b` quebrou **sem que nada estivesse errado** — pior seria o caso simétrico, uma regex que continua passando por casar com outro trecho.

**Dez sabotagens, dez detectadas — e a `S5` passou na primeira rodada**, por um motivo que é achado e não acaso: a `ML-09` recarregava uma URL que já carregava `mode=HYBRID`, então o modo voltava da **URL** e a preferência do aparelho nunca era consultada. Um teste chamado *"a persistência não regrediu"* cobrindo metade do assunto é pior que a ausência dele; ele passou a entrar também pela porta **sem query**, com queda provada nos dois sentidos.

Registro em `docs/CTO-NETWORK-DISTRIBUTION.md` §39.

**Próxima fatia: `CTO-3.2.2` — clientes e OS abertas no mapa.** Não iniciada.

## Princípios

Integridade > velocidade

Segurança > conveniência

Regras de negócio > CRUD genérico

Testes confiáveis > quantidade de testes

Manutenibilidade > atalhos

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

**Isto NÃO muda o próximo passo: continua sendo `DQ-6`** (Field consumindo a fila autoritativa + Android Back). CTO entra depois da sequência da fila estar concluída e publicada.

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

**A trilha da Fila Operacional está FECHADA: `DQ-1` a `DQ-7.2` existem em código**, com `WEB PILOT` e `DEVICE PILOT` `PASSED` e auditoria clean-room `APPROVED WITH RISKS` — 0 CRITICAL, 0 HIGH, 0 MEDIUM, **0 LOW pendente**, e três INFO aceitos (`DQV-01`, `RSP-01`, `ASG-01`). Checkpoint de release **proposto**: `v0.12-operational-dispatch-queue`. **A tag ainda não existe** — está aguardando aprovação de publicação, e `origin/main` continua em `f8bdfd6`.

**Próxima fase separada: `FIELD NOTIFICATION FOUNDATION`** (PRD §153) — `backend → notification event → device token → FCM → Android → deep link da OS`. Nada de push existe hoje, e o sino não fabrica badge. A fundação de backend (`Notification`, `OutboxEvent`, `MobileDevice`) já existe desde a v0.9; o que falta é o provedor real.

Depois dela existem **três** trilhas documentadas e nenhuma promovida — **Escala de Trabalho P0** (§307), **CTOs e Rede de Distribuição** (§333–§341) e **Colaboração entre Técnicos** (§342–§351). **A ordem entre elas não foi decidida**: são addenda aprovados em momentos diferentes, e escolher agora seria decisão de produto tomada em silêncio. O CTO tinha gate explícito — entrava "depois de a sequência da fila estar concluída e **publicada**" —, então publicar a v0.12 o torna **elegível**, o que não é o mesmo que promovê-lo.

Também sem código, **documentação apenas**: a **Parte XIV do PRD (§342–§351)** e `docs/FIELD-COLLABORATION.md` — **Colaboração entre Técnicos**. Uma OS tem **um** responsável e **0..N** colaboradores, e a regra que atravessa o módulo inteiro é: **colaborar acrescenta participante SEM trocar o responsável**; **transferir troca o responsável** e por isso mexe na fila de despacho. Nunca são sinônimos, e "repasse" não é palavra desta capability. Habilitável por empresa. **Nada disso existe em código.**

Cinco achados do **código real** que a especificação registrou e que decidem o custo das fases:

* **A posse tem UM portão.** Toda mutação-filha — evidência, material, equipamento, assinatura, checklist, impedimento — passa por `loadInProgressOwnedOrder` → `loadOwnedServiceOrder`, que recusa quando `order.technicianId !== technician.id`. A permissão do colaborador se resolve **estendendo um predicado**, não espalhando verificações; em compensação, errar essa função erra todas as escritas de uma vez.
* **A autoria já existe em cinco superfícies e falta em duas.** `ServiceOrderEvent`, `ServiceOrderEvidence`, `ServiceOrderMaterialUsage`, `ServiceOrderSignature` e `AuditLog` gravam o autor; **`ServiceOrderExecution` e `ServiceOrderEquipment` não**. A `Execution` é registro **único por OS**, então dois técnicos no mesmo diagnóstico não são duas linhas — `COL-6` não é uniforme.
* **A fila já PROÍBE a OS em duas filas.** `TechnicianDispatchQueueEntry.serviceOrderId` é `@unique` global, então "colaborador não entra na fila autoritativa" (`COL-AC03`) é **estrutural**, não uma regra que alguém precisa lembrar.
* **O `409` de `expectedVersion` deixa de ser raro.** Hoje só um técnico escreve numa OS; com dois participantes o CAS de `claimOrderForChildMutation` dispara em uso normal. É o mecanismo funcionando, e o Field precisa tratá-lo como recarregar-e-tentar, não como erro vermelho.
* **Não existe tabela genérica de capability.** O precedente do projeto é coluna de política em `Company` (`pppoePasswordPolicy`, `timezone`).

**Modelagem recomendada:** manter `ServiceOrder.technicianId` como responsável e acrescentar relação própria de colaboração. A alternativa uniforme (`ServiceOrderParticipant` com role) exigiria refatorar a fila de despacho inteira, o predicado de posse de todas as mutações-filhas, a atribuição e a listagem do Field — a superfície mais testada e mais recentemente auditada do projeto — sem ganho para quem está em campo.

Sete decisões abertas (`COL-01`–`COL-07`), nenhuma resolvida em silêncio; a mais pesada é `COL-01`, de qual estoque sai o material que o colaborador registra. **Esta Parte não promove nada na ordem** — a §119 vale, e a Fila Operacional continua fechada e pronta para release.

A §119 continua valendo para tudo o que é só especificação: FCM real, offline no cliente, `ToolExecution`, toolbox, custódia de patrimônio, mapa operacional, Central de Despacho, rede interna do cliente, contratos, escala de trabalho e espelho de jornada, CTOs e rede de distribuição, e **colaboração entre técnicos**. (A **fila operacional de OS** saiu desta lista: `DQ-1` a `DQ-7.2` existem em código.) Duas escalas de prioridade convivem e precisam ser conferidas juntas: §117 classifica o produto (MVP/IMPORTANTE/DIFERENCIAL/FUTURO), §194 classifica a trilha Field (P0/P1/P2).

## Princípios

Integridade > velocidade

Segurança > conveniência

Regras de negócio > CRUD genérico

Testes confiáveis > quantidade de testes

Manutenibilidade > atalhos

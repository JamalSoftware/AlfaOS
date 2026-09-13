# AlfaOS — Context Map

Roteador de contexto para sessões do Claude Code neste projeto. Objetivo: carregar o mínimo de contexto necessário para executar cada tarefa corretamente, sem reler documentação de módulos não relacionados nem repetir leitura já feita na mesma sessão.

Regra geral: leia a seção "Sempre" em toda sessão nova, depois **só** as seções abaixo que se aplicam à tarefa atual. Quando terminar de decidir o que ler, não volte a reler o mesmo arquivo se ele não mudou.

## Sempre

* `CLAUDE.md`
* Estado do Git: `git status`, `git branch --show-current`, `git log --oneline --decorate -10`, `git tag`

**Baseline publicada: `v0.13-field-push-notifications`.** Ela fecha a Field Notification Foundation (`NF-1`–`NF-5`, com piloto físico aprovado), a `ERP-1` e a `SGP-1`, mais o endurecimento de privacidade de foto (`PC-1`/`EXIF-01`) e a trava de ativação do SGP (`RC-1`). **Trilha de produto ativa: CTO / Rede de Distribuição** — decisões congeladas na `CTO-0.1`, e a **`CTO-1` existe em código** (cadastro de caixas e portas). Da `CTO-2` em diante, nada.

## Um servidor de dev por vez — e nunca durante um build

**`next dev`, `next build` e o Playwright compartilham o MESMO diretório
`.next`.** Rodar dois deles ao mesmo tempo corrompe o que o outro está
servindo, e o sintoma não se parece com um conflito: parece um defeito da
aplicação.

Reproduzido de forma determinística, com o servidor de dev no ar:

```text
antes de `npm run build`   CSS 200 · .next/static/css/app tem 1 arquivo
depois de `npm run build`  CSS 404 · .next/static/css/app VAZIO
```

O HTML continua referenciando `/_next/static/css/app/layout.css`, o arquivo
deixou de existir, e a tela abre **sem estilo nenhum, com ícones gigantes**. O
build de produção emite o CSS em outro caminho (`.next/static/css/<hash>.css`)
e limpa o do dev ao passar.

Dois `next dev` sobre o mesmo `.next` produzem a mesma família de falhas, de
forma intermitente: rotas que respondiam 200 passam a dar 404 e voltam sozinhas
conforme cada processo recompila.

> **Regra:** antes de rodar `npm run build`, `npm test` ou `npx playwright
> test`, encerre o servidor de dev. Depois de um build, `rm -rf .next` antes de
> subir o dev de novo — senão ele nasce sobre artefatos de produção.

No Windows, `taskkill` pelo Git Bash falha com *acesso negado* em processos que
não são da sessão; `Stop-Process -Force` do PowerShell funciona. Conferir a
porta antes de subir evita o pior caso, que é **dois servidores escutando a
mesma porta** — aí o tráfego alterna entre eles e o diagnóstico fica sem chão.

## `localhost` não é `127.0.0.1` quando o Postgres está no Docker

**Sintoma:** `P1001: Can't reach database server at localhost:5432`, com o
contêiner de pé, `pg_isready` respondendo *accepting connections* e
`Test-NetConnection` devolvendo `TcpTestSucceeded: True`. Tudo indica que o
banco está no ar — e está.

**Causa, medida:** no Windows, `localhost` resolve para **`::1` primeiro**, e a
ponte IPv6 do Docker Desktop aceita a conexão TCP sem encaminhá-la. Um
handshake cru mostra os dois caminhos lado a lado:

```text
127.0.0.1  ->  RESPONDEU "N"        (SSLRequest respondido: é o Postgres)
::1        ->  TIMEOUT              (conecta e nunca responde)
```

Por isso o TCP "conecta": quem aceita é o proxy, não o banco. O cliente fica
esperando bytes que nunca chegam e reporta *servidor inalcançável*.

> **Regra:** ao ver `P1001` com o contêiner saudável, **não recrie contêiner e
> não troque volume** — teste `::1` e `127.0.0.1` separadamente antes de
> qualquer coisa. Para destravar sem tocar no `.env`, sobreponha as três URLs
> por comando: `DATABASE_URL` (aplicação e Prisma), `TEST_DATABASE_URL`
> (Vitest) e `E2E_DATABASE_URL` (Playwright), trocando `@localhost:` por
> `@127.0.0.1:`.

**Lição de diagnóstico, e ela custou caro:** a primeira conclusão foi que o
contêiner tinha sido removido, porque ele não aparecia em `docker ps -a`. Ele
aparecia — estava além do `head -10` do próprio comando. **Truncar a saída e
concluir pela ausência** é como um contêiner de 43 horas de uptime vira
"sumiu".

## Produto / roadmap

**Carregar:** `docs/PRD.md` — preferencialmente só a(s) seção(ões) relevante(s) à tarefa, não o arquivo inteiro (é longo).
**Quando:** a tarefa envolve decisão de escopo, prioridade de versão, ou dúvida sobre o que uma feature deveria fazer.
**Quando NÃO:** implementação técnica de algo já especificado em outro doc mais específico (ex.: a regra de máquina de estados de OS já está detalhada em `SERVICE-ORDERS.md`, não precisa voltar ao PRD para isso).

**O ESCOPO DA V1 ESTÁ CONGELADO: PRD Parte XVI (§362–§391).** Antes de propor qualquer funcionalidade nova, leia **§386** (o que é `MUST HAVE` e qual o estado real de cada item) e **§119** (estar no PRD nunca foi autorização para implementar). O que fica de fora está nomeado: §388 é V2 (falha coletiva, incidentes, NOC, manutenção preventiva, camada de técnico, métricas) e §389 é V3 (FiberMap e rede física).

Quatro coisas dessa Parte que não se redescobrem: **`STALE` não existe** no AlfaOS — a conectividade tem três estados e o que viaja junto é a **idade** da leitura (§370); **o checklist por tipo de OS já está implementado** desde a v0.10, e foi apresentado como escopo novo por engano (§382); **a máquina de estados da OS tem cinco valores**, e *agendada*, *em deslocamento* e *pausada* **não são estados** — os gaps estão registrados em §385 sem inventar enum; e **`CANCELLED` é declarado e inalcançável**.

**Carregar também:** `docs/MASTER-PLAN.md` — a sequência até o lançamento e as fatias V1, cada uma com dependências, entregas, testes, segurança e risco. Concluídos: Mapa Operacional V1, `DASH-1` + `DASH-1a`, `HOTFIX-FIELD-01`, `TL-1` e `EV-1`. **Próxima fatia ativa do Core V1: `GS-1`** — não iniciada. Os débitos conhecidos fora das fatias estão no §12 dele. Ele **não é um segundo PRD**: onde os dois divergirem, o PRD vence.

**O DASHBOARD OPERACIONAL V1 TAMBÉM ESTÁ CONGELADO** (`DASH-1a` `APPROVED`, 2026-09-12): nenhuma feature nova entra nele, salvo correção crítica de defeito.

**O MAPA OPERACIONAL V1 ESTÁ CONGELADO — PRD §392** (`CTO-3.2.2e` `APPROVED`, 2026-09-12). Antes de propor qualquer coisa no mapa, leia a §392 e a **§393**, o critério contra o feature creep: ideia nova que não bloqueia a operação V1 vai para o backlog, e o código do mapa só reabre por **correção crítica de defeito**. Não existe `CTO-3.2.2f`. A **Central de Retenção e Recuperação** (inadimplência, patrimônio em risco, recolhimento, churn, cobrança, WhatsApp) é a **PRD Parte XVII (§394–§401)** — backlog sem versão, **nada em código**, e não é fatia do Master Plan.

**Antes de tocar em Online/Offline, leia PRD §370.** A autoridade é `CustomerDiagnosticSnapshot` + `getCustomerDiagnostic` (`src/lib/customer-diagnostics.ts`), e o invariante já está no código: **falha de integração é afirmação sobre a integração, nunca sobre o cliente** — nenhum caminho de erro escreve `OFFLINE`. A leitura individual continua sendo `getCustomerDiagnostic`, e desde a `CTO-3.2.2` existe **`getConnectivityForCustomers`**, o **lote** sobre a mesma tabela devolvendo o mesmo DTO — não é uma segunda semântica, é a mesma amplificada. O que torna isso possível é que **`getCustomerDiagnostic` é leitura pura de banco**: se ela falasse com provider, um lote seria um lote de chamadas externas. E **o mapa lê, não atualiza** — o refresh tem teto de 10 chamadas por minuto por empresa (§337).

## Plataforma SaaS modular — Core × módulos opcionais — FUTURE / NOT IMPLEMENTED

**Carregar:** PRD **Parte XVIII (§402–§414)**; o backlog está em `docs/MASTER-PLAN.md` §11. Complementa: §114 (SaaS multiempresa), §73 (blocos do produto), Parte XVII (Collections, Recovery e Retention na forma conceitual).
**Quando:** a tarefa fala em módulo, plano, entitlement, feature flag por tenant, WhatsApp de atendimento ou cobrança, Collections, Recovery, Retention, AI Assistant, NOC, OLT, ACS/TR-069 ou Analytics — ou quando alguém propuser pôr qualquer uma dessas coisas "dentro" de uma fatia V1.
**Quando NÃO:** implementação do Core V1. **Nada desta seção existe em código**: não há Module Registry, entitlement, plano, billing, Super Admin, provider de mensageria, de pagamento ou de IA. Não descreva nenhum deles como arquitetura implementada.

A fronteira: **Core** é tudo o que a PRD §386 lista como V1 MUST HAVE — nada sai dele por causa da decisão modular —, e **módulo opcional** é o que um tenant contrata por cima. O Core não depende de módulo; a ausência de módulo nunca o quebra (§407).

**Três conceitos, e não se misturam (§405):** *entitlement* é o direito da **empresa** a um módulo; *feature flag* é disponibilidade **técnica** (rollout); *capability* é permissão do **usuário**. Acesso efetivo exige os três mais as regras de domínio. **O que já existe é lido assim, sem renomear nada:** `Company.ctoNetworkEnabled` e o que `requireCtoAccess` chama de "capability da empresa" são, em substância, entitlement/política do tenant; as `capabilities` do `GET /api/field/v1/me` são capability do usuário, derivada hoje do `AccessProfile` e da posse; `SGP_ACTIVATION_ENABLED` e `MAP_SATELLITE_ENABLED` são feature flags de **ambiente**; "capability do adapter" (§355) é um terceiro eixo; e o `CHATBOT` do ReceitaNet é uma API do provider, **não** o AI Assistant.

**Quando um módulo for implementado, o primeiro trabalho é a camada central** (§406): `if (tenant.hasModule(...))` espalhado e `if (plan === "PRO")` no domínio são os defeitos a evitar. O precedente de portão único é o `requireCtoAccess`.

## Arquitetura

**Carregar:** `docs/ARCHITECTURE.md`.
**Quando:** a tarefa muda o modelo de dados, adiciona uma entidade nova, mexe em camadas/estrutura do projeto, ou é uma decisão estrutural cross-module.
**Quando NÃO:** bugfix pontual, ajuste de UI, ou qualquer tarefa que não altera como os módulos se relacionam.

## Segurança

**Carregar:** `docs/SECURITY.md` + a seção de arquitetura relacionada (se houver) + os testes de segurança do módulo tocado (ex.: os arquivos relevantes em `src/tests/`).
**Quando:** a tarefa toca autenticação, autorização, rate limit, CSRF, mass assignment, concorrência/lock otimista, ou qualquer coisa de superfície crítica.
**Quando NÃO:** mudança sem implicação de autorização ou dado sensível (ex.: texto de label, cor de botão, copy de UI).

**Skill de auditoria:** `.claude/skills/alfaos-security-review/SKILL.md` — o método adversarial do projeto (invariantes, severidade, evidência, template de relatório).
* **Carregar quando:** auditoria adversarial, segurança, multi-tenancy, ownership, concorrência, transações críticas ou gate de release de versão.
* **NÃO carregar para:** UI, CRUD comum, documentação normal, ou qualquer tarefa sem implicação de segurança/integridade.
* **Manutenção:** se um invariante de segurança relevante do `CLAUDE.md` mudar, revisar essa skill na mesma tarefa — as duas descrevem a mesma regra sob papéis diferentes (`CLAUDE.md` proíbe violar; a skill ensina a tentar violar) e podem divergir em silêncio.

## Service Orders / Execução do técnico

**Carregar:** `docs/SERVICE-ORDERS.md` (inclui origem INTERNAL/EXTERNAL e catálogo `ServiceOrderType`, §1.1 e §1.2, e o número operacional da OS, §1.3 — `id` é identidade técnica, `number` é identidade operacional humana); e `docs/TECHNICIAN-EXECUTION.md` se a tarefa envolver o fluxo de atendimento do técnico (iniciar atendimento, diagnóstico, serviço realizado, observações); e `docs/SERVICE-ORDER-CLOSING.md` se envolver o fechamento (evidências/fotos, materiais, assinatura, `COMPLETED`, storage/upload, imutabilidade pós-conclusão).
**Quando:** qualquer tarefa que toque Ordem de Serviço, atribuição de técnico, máquina de estados da OS, ou a experiência do técnico em campo.
**Quando NÃO:** tarefas de outros módulos sem relação com OS (ex.: só cadastro de cliente, configurações da empresa). Não carregue os três documentos de uma vez — execução e fechamento são fases distintas.

**`/minhas-os` — "Hoje" é o dia civil da EMPRESA** (`HOTFIX-FIELD-01` `APPROVED`): `Company.timezone` → `resolveTimezone` → `civilDayBoundsIn`, intervalo `[início, início do dia seguinte)`. O defeito antigo — `new Date(ano, mês, dia)`, o fuso do processo — está resolvido; contrato em `docs/TECHNICIAN-EXECUTION.md` §9. **Débito registrado e não corrigido:** a seção "Próximas" também contém OS sem agendamento e OS com agendamento vencido, então o nome é impreciso. As opções estão no mesmo §9 e **nenhuma foi escolhida** — não renomear, não reagrupar e não mexer na query fora da fase do fluxo do técnico.

**Fixture de QA que grava OS direto no banco usa `allocateServiceOrderNumber`, nunca número próprio.** O contador por empresa (`service_order_counters`) e a unique `(companyId, number)` não se reconciliam sozinhos: número gravado por fora deixa o contador para trás, e a próxima OS criada pela aplicação colide e falha — sempre, porque a falha desfaz o próprio incremento. O banco de **dev** chegou a ter isso (13/09/2026: contador da Alfa Telecom em 11 com OS até a Nº 13, fixtures do mapa da `CTO-3.2.2`). **DEV-DATA-01 resolveu: Alfa Telecom counter = 13, MAX OS = 13, next = 14** — ajuste só de dado, só dessa empresa, com dry-run antes; nenhum código mudou, e as outras empresas foram só lidas. Fixture nova que grave OS direto no banco continua obrigada a usar `allocateServiceOrderNumber` (como `e2e/evidence-package.spec.ts` faz), senão o descompasso volta.

## Dashboard operacional — `DASH-1` + `DASH-1a` (APPROVED · FROZEN)

**Carregar:** PRD **§380** (contrato e as decisões do dono) e `docs/MASTER-PLAN.md` §4. Não há documento de módulo: o contrato é curto e está nos comentários do código abaixo.
**Quando:** a tarefa toca `/dashboard`, um cartão do painel, ou um dos filtros de destino (`/ordens?recorte=`, `/tecnicos?emAtendimento=`, `/clientes?conectividade=`, `/ctos?situacao=`).
**Quando NÃO:** análise histórica, séries, rankings ou BI — isso é o módulo Analytics, futuro e não implementado (PRD §410). O painel responde "o que está acontecendo agora".

**A regra que não se desfaz: o cartão é a listagem.** Nenhum número é calculado no painel — cada um vem da função `count…` do módulo da listagem que o cartão abre, com o MESMO filtro que o link leva:

| Cartão | Contagem (= destino) | Destino |
|---|---|---|
| OS abertas / atrasadas / de hoje / pendentes | `countCompanyServiceOrders({ slice })` — `src/lib/service-order-slices.ts` | `/ordens?recorte=abertas\|atrasadas\|hoje\|pendentes` |
| Técnicos em atendimento | `countCompanyTechnicians({ inService })` — `technicianInServiceWhere` | `/tecnicos?emAtendimento=true` |
| Clientes offline (`ADMIN`) | `countCompanyCustomers({ active, connectivity: "OFFLINE" })` → `getCompanyConnectivityStatuses` | `/clientes?active=true&conectividade=OFFLINE` |
| CTOs com defeito / com OS abertas (`ADMIN` + capability) | `getCompanyCtoStates` + `matchesCtoAttention` — `src/lib/cto-attention.ts` | `/ctos?situacao=defeito\|com-os-abertas` |

**Código:** `src/lib/dashboard.ts` (leitura, uma por visita, seções independentes), `src/lib/dashboard-cards.ts` (apresentação pura: erro → "—", "Sem leitura", cor, destino), `src/app/(app)/dashboard/page.tsx` (só desenha), `src/components/ListSliceBanner.tsx` (a faixa do recorte nas listas). **`DASH-1a`:** `src/lib/dashboard-slice-copy.ts` (nome, singular/plural e estado vazio dos oito recortes — cartão, faixa e vazio leem a mesma linha), `src/components/BackToDashboardLink.tsx` (a volta: `Link` para `/dashboard`, nunca histórico), `src/lib/audit-presentation.ts` (códigos de auditoria → frase; o código gravado não muda), `src/lib/company-datetime.ts` (data/hora no fuso da empresa). Testes: `src/tests/dashboard.test.ts`, `dashboard-cards.test.ts`, `dashboard-context.test.ts`, `service-order-slices.test.ts`, `civil-day-bounds.test.ts`, `e2e/dashboard.spec.ts`.

**`DASH-1a` — a linha explica o recorte, pela MESMA leitura que o decidiu.** O contexto por linha é extra do resultado da listagem, só com o recorte ativo e só para as linhas da página: `CustomerListResult.connectivity` (a leitura vencedora, do mesmo lote que filtrou — `getCompanyConnectivityStatuses` devolve `{ status, observedAt }`), `TechnicianListResult.inServiceCounts` (UM `groupBy` sobre os ids da página, tenant no `where`) e `CtoOperationalState.damagedPortCount` (o `damaged` do mesmo `summarizePortCounts` que decidiu o estado). "Agendada para" usa o relógio que a página já leu para filtrar (`companySliceClock`, uma vez). Um teste varre o fonte e cobra rótulo para todo código de auditoria gravado em produção.

Cinco coisas que não se redescobrem:

* **"Hoje" é o da EMPRESA**: `civilDayBoundsIn` em `src/lib/workday.ts` (a autoridade de fuso, junto de `civilDateIn`), com dia de 23/25 h e meia-noite pulada. `new Date(ano, mês, dia)` usa o fuso do processo — é o defeito que o antigo "Concluídas hoje" tinha e que `/minhas-os` teve até o `HOTFIX-FIELD-01`, quando `listServiceOrdersForTechnician` passou a usar a mesma autoridade (`companySliceClock` + `civilDayBoundsIn`; teste: `src/tests/minhas-os-today.test.ts`).
* **Atrasada exclui a OS em atendimento, e OS sem agendamento nunca é atrasada** (decisão do dono). `NOT_STARTED_SERVICE_ORDER_STATUSES` é derivado de `OPEN_SERVICE_ORDER_STATUSES`, nunca listado.
* **O recorte entra por `AND`** no `where` da listagem: juntar as chaves deixaria o filtro de status da tela sobrescrever o do recorte em silêncio.
* **"Em atendimento" põe `companyId` DENTRO da relação** técnico → OS: `ServiceOrder.technicianId` é FK simples, e uma OS de outra empresa poderia pôr um técnico nosso "em atendimento" (vetor da `DQ-7.1`).
* **O estado da CTO é montado com as primitivas exportadas do mapa** (`isPortWithinCapacity`, `summarizePortCounts`, `getCtoOperationalSummaries`, `deriveCtoMapStatus`) sem tocar o código congelado do mapa — e um teste de paridade compara, caixa a caixa, com o marcador. A leitura de conectividade da empresa usa o MESMO desempate (`latestPerCustomer`) do lote do mapa.

**Seção que falha é `error`, nunca `0`**, e a tela a mostra como "—". A falha transitória `P1001` do Docker Desktop (seção acima) já apareceu assim no painel, na primeira leitura depois de subir o servidor: só a seção afetada ficou em "—".

## Timeline do cliente — `TL-1` (APPROVED · FROZEN)

**Customer Timeline V1 — `FROZEN` / `APPROVED` (13/09/2026).** Validada pelo dono na interface real. Só reabre por defeito crítico, vazamento de tenancy, problema de segurança, perda de histórico ou decisão explícita do dono; tipo de evento novo é backlog (PRD §393). O conjunto de tipos aprovado é exatamente o da PRD §381 — não acrescentar nem tirar sem fase própria.

**Carregar:** PRD **§381** (contrato congelado e as quatro decisões do dono) e `docs/MASTER-PLAN.md` §5. Não há documento de módulo: o contrato é a PRD e o cabeçalho de `src/lib/customer-timeline.ts`.
**Quando:** a tarefa toca a seção "Histórico do cliente" de `/clientes/[id]/editar`, acrescenta ou tira um tipo de item, ou muda o que um escritor grava numa das fontes abaixo (principalmente `customer-locations.ts` e `cto-connections.ts`).
**Quando NÃO:** a timeline POR OS (`/ordens/[id]`, `ServiceOrderEvent` em ordem crescente) — é outra tela, pré-existente, fora da `TL-1`. E `AuditLog`, que é trilha técnica e não é fonte.

**Customer Timeline ≠ Service Order Timeline — não confundir.** A `TL-1` congela a do **cliente**, que tem apresentação própria (`customer-timeline-presentation.ts`) e nunca mostra código cru. A da **OS** (`EVENT_LABELS` em `src/app/(app)/ordens/[id]/page.tsx`) rotula só 7 códigos e imprime os demais crus — `PRIORITY_CHANGED`, visto pelo dono na validação, e também `CHECKED_IN`, `CTO_PORT_*`, `EQUIPMENT_INSTALLED`, `LOCATION_*`, `SIGNATURE_CAPTURED` e outros. É débito de UX **da tela da OS**, para release hardening (`docs/MASTER-PLAN.md` §12), e corrigi-lo **não** reabre a `TL-1`.

**A regra que não se desfaz: uma fonte por fato, e nada escrito.** A timeline é visão derivada; não existe tabela, e acrescentar um tipo é acrescentar uma LEITURA da tabela que já é a autoridade dele — nunca uma segunda gravação. Os códigos de `ServiceOrderEvent` que repetem o fato de tabela própria (`CHECKED_IN`, `EQUIPMENT_INSTALLED`, `SIGNATURE_CAPTURED`, `CTO_PORT_*`, `LOCATION_*`…) ficam fora de propósito: o equipamento removido no atendimento apaga a linha e deixa o evento.

**Código:** `src/lib/customer-timeline.ts` (leitura em lotes `$transaction([...])` numa conexão só — empresa+cliente, as fontes num instante só com `RepeatableRead`, cada uma com `take = limit + 1`, e a segunda leva só pelos ids da primeira: observações das concluídas, categorias e OS das fotos; união ordenada por instante desc e `id` desc, corte em `limit`; `loadCustomerTimeline` converte falha em `error`), `src/lib/customer-timeline-presentation.ts` (pura: item → categoria, título e descrição; rótulos = os do Field, cobrados por teste que lê o Dart), `src/components/CustomerTimelineSection.tsx` (servidor: erro · vazio · lista por dia civil da empresa), `src/app/(app)/clientes/[id]/editar/page.tsx` (`?historico=` e o link "Ver eventos anteriores", que remonta `returnTo` e a vista do mapa dos valores validados), `src/lib/company-datetime.ts` (`formatCompanyLongDate`). Testes: `src/tests/customer-timeline.test.ts`, `customer-timeline-presentation.test.ts`, `customer-timeline-page.test.ts`, `e2e/customer-timeline.spec.ts`.

Cinco coisas que não se redescobrem:

* **Uma conexão por visita — nunca `Promise.all` de fontes.** A primeira versão abria treze consultas em paralelo: mais que o pool padrão, e, com o pool frio, treze conexões NOVAS de uma vez. Pelo Docker Desktop isso deu `P1001` intermitente (a seção caía em erro, e o `TL-AUTH-03` falhava cerca de 1 vez em 15 execuções); em lotes sequenciais, 25 de 25 limpas. `TL-CONN-01` fixa o formato dos lotes e `TL-CONN-02` mantém `Promise.all` fora do módulo.
* **Tenant em toda fonte, e o da OS também**: `{ companyId, serviceOrder: { companyId, customerId } }`. `ServiceOrder.customerId` é FK simples — uma OS da empresa B pode apontar para o cliente de A (vetor da `DQ-7.1`) —, e o teste `TL-DOM-03` monta exatamente isso. Cliente fora do tenant devolve histórico vazio mesmo com linhas corrompidas apontando para ele.
* **CTO e porta só para `ADMIN` com `ctoNetworkEnabled`** — o histórico de vínculo (`GET /api/cto-connections`) já era `ADMIN`; sem permissão, a consulta nem é feita. O perfil vem da SESSÃO, na página.
* **A localização é classificada pela assinatura de cada um dos quatro escritores** de `CustomerLocationHistory`, nunca pelo texto da nota: a divergência vinda da integração grava o ponto do PROVEDOR em `new*` sem aplicá-lo, e só o motivo (`OTHER` × `INCOMPLETE_REGISTRATION`) a separa da atualização. `TL-SRC-06` passa pelos escritores reais — mudar o motivo lá quebra aqui.
* **Contagem de consultas é constante** (≤ 16 por visita, igual para 2 ou 32 itens — `TL-PAGE-05`), e o teto por fonte é afirmado sobre os argumentos da consulta (`TL-PAGE-04`), porque o corte depois da união esconderia uma fonte sem `take` de qualquer teste de resultado.

**Limite declarado:** uma correção em campo para o MESMO ponto, com a MESMA origem, sobre localização não verificada e com motivo `OTHER` tem a mesma assinatura de uma confirmação, e aparece como "Localização confirmada em campo" — o efeito gravado é idêntico ao da confirmação.

## Pacote técnico de evidências — `EV-1` (APPROVED · FROZEN)

**Pacote Técnico de Evidências V1 — `FROZEN` / `APPROVED` (13/09/2026).** Validado pelo dono. Só reabre por defeito crítico, vazamento de tenancy, problema de segurança ou decisão explícita do dono; ideia nova sobre o pacote é backlog (PRD §393).

**Carregar:** PRD **§383** (contrato e as quatro decisões do dono) e `docs/MASTER-PLAN.md` §6; `docs/SERVICE-ORDER-CLOSING.md` se a tarefa mexer no que o fechamento grava (hash, evidência, assinatura). Não há documento de módulo: o contrato é a PRD e o cabeçalho de `src/lib/service-order-evidence-package.ts`.
**Quando:** a tarefa toca `/ordens/[id]/pacote`, o botão "Ver pacote técnico" da OS concluída, ou muda o que o fechamento grava numa das fontes do pacote.
**Quando NÃO:** PDF, ZIP, download ou compartilhamento — fora da V1 (PRD §383, §387); a timeline da OS (`/ordens/[id]`); a timeline do cliente (`TL-1`, FROZEN).

**A regra que não se desfaz: o pacote é derivado e só existe na OS `COMPLETED`.** Nada é escrito; cada item vem da tabela que é a autoridade dele, e só o CONFIRMADO entra (`COMMITTED_EVIDENCE`, o mesmo filtro do fechamento). A conferência não promete imutabilidade — ela compara o hash gravado no fechamento (`ServiceOrderCompletion.contentHash`) com `closingContentHash` de agora, e a assinatura com o conteúdo que ela assinou. Não existe selo de completude: a política de conclusão é mutável e não é gravada com o fechamento.

**Código:** `src/lib/service-order-evidence-package.ts` (leitura: portão de perfil e posse ANTES da consulta; uma transação interativa `RepeatableRead` numa conexão só; `take` em toda lista; `loadServiceOrderEvidencePackage` converte falha em `error` e loga só o tipo do erro), `src/lib/service-order-evidence-package-presentation.ts` (pura: frases da conferência, do check-in — as MESMAS do Field — e da mudança de ponto — `presentTimelineItem` da `TL-1`, reutilizado sem mudar contrato), `src/components/ServiceOrderEvidencePackageView.tsx` (servidor: erro · não concluída · pacote), `src/app/(app)/ordens/[id]/pacote/page.tsx` (os perfis da OS; `not-found` → 404), e o botão em `src/app/(app)/ordens/[id]/page.tsx`. As imagens usam as rotas que já existiam: `/api/service-orders/:id/evidence/:eid/content` e `/api/service-orders/:id/signature`. Testes: `src/tests/service-order-evidence-package.test.ts` (atendimento inteiro pelas rotas reais do Field), `service-order-evidence-package-presentation.test.ts`, `service-order-evidence-package-page.test.ts`, `e2e/evidence-package.spec.ts`.

Quatro coisas que não se redescobrem:

* **Medição é FOTO.** Teste de velocidade e leitura óptica não têm valor estruturado no modelo; o pacote mostra a foto do resultado e diz isso. Nenhum número é digitado, calculado ou extraído.
* **Etiqueta aparece uma vez, junto do equipamento.** A foto `EQUIPMENT_LABEL` ligada a um equipamento sai da galeria; a do equipamento REMOVIDO volta a `TEMPORARY` (a remoção apaga a linha) e por isso não entra em lugar nenhum. Item de foto do checklist é satisfeito pela categoria confirmada — a mesma regra de `pendingChecklistItems`.
* **Localização sem coordenada.** O check-in entra como hora, com/sem GPS, distância ao ponto cadastrado (congelada no check-in) e precisão; a mudança de ponto entra só se feita NESTA OS e para ESTE cliente. Latitude e longitude não são nem selecionadas.
* **A série e o MAC saem como o domínio gravou** (`normalizeHardwareId`), não como foram digitados — é o que o Field mostra também.

## Auditorias

**Carregar:** somente a auditoria da versão relevante à tarefa atual — não releia o histórico completo de auditorias.
* `docs/FOUNDATION-AUDIT.md` — contexto histórico da v0.1, raramente necessário hoje.
* `docs/V0.2-AUDIT.md` — achados e correções do ciclo v0.2/v0.2.1/v0.2.2/v0.2.3. Útil para entender decisões de concorrência (`version`/`expectedVersion`) e elegibilidade de técnico antes de mexer nessas áreas.
* `docs/V0.7-AUDIT.md` — checkpoint da trilha v0.7: os três bloqueadores (PPPOE-01, RATE-01, GATE-01), as correções, a reauditoria focal e os riscos aceitos. **Leia antes de mexer em procedência de credencial PPPoE, rate limit de capability ou procedência do diagnóstico** — as três áreas já regrediram uma vez, e o documento registra por quê. Traz também os três INFO aceitos e a lacuna dos LOW históricos.
* `docs/V0.9-AUDIT.md` — checkpoint da Field Backend Foundation: os sete achados (OBX-01, REV-01, REV-02, IDM-01, START-01, TEST-01, OPS-01), o endurecimento, a reauditoria focal e os cinco INFO aceitos. **Leia antes de mexer em lease/reclaim do outbox, revogação de aparelho, tomada de reserva de idempotência ou na resposta do `start`** — o documento registra o que cada mecanismo existe para impedir e o que a reversão provou. O contrato correspondente é `docs/FIELD-API.md`; a segurança, `docs/SECURITY.md` §8.13.
* Auditoria da v0.3, quando existir (ex.: `docs/V0.3-AUDIT.md`) — carregar antes de iniciar `v0.4`, ou ao investigar algo relacionado à execução do técnico.

**Quando:** a tarefa é uma nova rodada de auditoria, ou precisa entender o que já foi encontrado/corrigido antes de mexer numa área historicamente sensível.
**Quando NÃO:** implementação de feature nova sem relação com achados anteriores.

Para *conduzir* uma auditoria (não apenas consultar as anteriores), use a skill descrita na seção Segurança.

## Integrações (ERP)

**Carregar:** `docs/ERP-INTEGRATIONS.md` — contrato/capabilities, modelo normalizado de diagnóstico, snapshot, modelo de erros, timeout, cenários do MockERP e o estado de implementação da integração ReceitaNet. O fluxo de sync de OS continua em `docs/SERVICE-ORDERS.md`.
**Quando:** a tarefa envolve adapters de ERP, diagnóstico de conectividade do cliente, sincronização, ou a futura integração real com o ReceitaNet.
**Quando NÃO:** tarefas que não tocam a camada de integração. **Antes de implementar qualquer chamada ReceitaNet**, ler a seção 1 de `docs/ERP-INTEGRATIONS.md` — ela separa o que está IMPLEMENTADO (CallCenter read-only v0.6 **e Chatbot v0.7.2**), o que está documentado e deliberadamente fora, e o que não existe em nenhuma API **do ReceitaNet**. Complementam: `docs/PRD.md` §140 (as duas capabilities e suas credenciais independentes), §141 (por que não existe descoberta global de OS), §142 (escopo da sincronização na v0.8) e §121–§131 (propriedade da OS e posição dos ERPs). O §129 descreve as APIs **como lidas em spec** e tem duas conclusões superadas — ler a nota no topo dele antes de citar. O §64 continua valendo — nenhuma chamada fora do que o OpenAPI descreve.

**O documento tem quatro partes.** As seções **1–12** descrevem a integração ReceitaNet. As **13–27** são o plano da plataforma de ERPs plugáveis (`ERP-0R`). A **§28** registra a **`ERP-1`** e a **§29** a **`SGP-1`**. O que continua sendo só plano são as **capabilities de negócio do SGP**: o `SgpAdapter` implementa apenas `testConnection`.

## ERPs plugáveis e SGP — `ERP-1` e `SGP-1` PUBLICADAS em `v0.13`

> **A `SGP-1` é FUNDAÇÃO publicada, não homologação.** O provider existe, autentica e é ativável — e a ativação em produção é **travada** por `SGP_ACTIVATION_ENABLED` (padrão `false`, comparação exata com `"true"`, decidida no domínio antes de qualquer leitura, reteste, cifragem ou transação). Testar a conexão continua liberado, porque é diagnóstico e é o que a homologação precisa. **Validação contra instalação real de cliente continua pendente** — `docs/SECURITY.md` §8.18.

**Carregar:** `docs/ERP-INTEGRATIONS.md` §13–§29 (regra, resolução, troca de ERP, migração, testes, roadmap e o registro das duas entregas) e `docs/ERP-SGP.md` (inventário do provider SGP). Complementa: `docs/PRD.md` §352–§361.
**Quando:** a tarefa toca escolha de ERP por empresa, troca de provider, credencial de um ERP que não seja o ReceitaNet, ou qualquer coisa relacionada ao SGP.
**Quando NÃO:** tarefas do ReceitaNet já implementado — para essas, as seções 1–12 bastam.

* **O SGP autentica e é ativável, e NADA além disso.** `SgpAdapter` implementa só `testConnection`; `supportsCustomerLookup`, `supportsDiagnostics` e `supportsServiceTickets` respondem `false` **estruturalmente**. `sgp-boundary.test.ts` proíbe até a declaração das interfaces no fonte — abrir capability exige abrir a fase.
* **A superfície ADOTADA é `/api/ura/` com Token+App no CORPO**, `urlencoded`. A `/api/v1/` com `Authorization` é `NOT ADOPTED / NEED VALIDATION`, e **não se assume que o token de uma vale na outra**.
* **A sonda é `POST /api/ura/planoscontas/`**, não `consultaplano` — este é `GET` com corpo, que proxies descartam. Sonda sem PII, sem preço e sem parâmetro capaz de disparar efeito.
* **Configuração candidata NÃO é persistida.** Testar monta o adapter em memória; nada é gravado, nem no banco nem no navegador. A ativação **reexecuta o teste no servidor** e grava provider, `baseUrl`, `config`, credencial cifrada e `AuditLog` **numa transação**.
* **`baseUrl` fornecida pelo ADMIN passa por validação de SSRF** (`src/lib/safe-outbound-url.ts`), que **resolve DNS** — regex não bastaria. Rebinding fica declarado como janela não fechada.
* **A precondição da troca avalia o estado DEPOIS dela** (`assertProviderUsableAfterSwitch`). Usar `resolveCompanyAdapter` ali bloqueia o rollback: a linha ainda tem o host do provider que sai, e a allowlist do ReceitaNet o recusa — ver §29.7.

* **A regra é `Company → ERPIntegration 0..1 → provider`.** Cada empresa tem **zero ou um** ERP ativo; o AlfaOS suporta vários *tipos* globalmente. **Não existe** provider por capability, dual-provider operacional nem principal+secundário. `ERPIntegration.companyId @unique` é o que sustenta isso e **não deve ser trocado** por `@@unique([companyId, provider])`.
* **Uma tentativa anterior (`ERP-0`/`ERP-1`) implementou o modelo multi-provider e foi DESCARTADA** por decisão de produto. Os commits ficaram na branch local `backup/erp-multiprovider-discarded`. Não ressuscitar `resolveProviderFor`, `ERPCapabilityBinding` nem `Company.primaryErpProvider`.
* **A resolução que existe basta:** `resolveCompanyAdapter(companyId, provider)`. Capability continua sendo pergunta ao **adapter**, pelos type guards (`supportsDiagnostics`, `supportsCustomerLookup`, `supportsServiceTickets`).
* **Os dois defeitos foram CORRIGIDOS na `ERP-1`** (§28). Três ações não compartilham mais efeito colateral: **salvar credencial** grava segredo e não ativa nada; **testar conexão** é consulta e não altera o ERP ativo, não apaga credencial e não cria integração; **alterar ERP ativo** é `POST /api/integrations/active-provider`, a única rota que escreve `ERPIntegration.provider`.
* **Credencial armazenada NÃO é ERP ativo.** A troca preserva a credencial do provider anterior, cifrada e ociosa — é isso que permite `A → B → A` sem recadastrar token. E credencial ociosa **não cria provider secundário**: ERP ativo sem a capability responde `NOT_SUPPORTED`, sem fallback.
* **`lastTestedAt`/`lastTestStatus` só são gravados ao testar o provider ATIVO.** Não há coluna para saúde de candidato, e nenhuma foi inventada — exigir "último teste bem-sucedido" antes da troca fica para a `SGP-1`.
* **A troca usa compare-and-set sobre o provider lido**, sem coluna `version`, e grava a auditoria na mesma transação (`logAuditWithin`).
* **`docs/ERP-SGP.md` só contém endpoint com fonte oficial.** Onde a documentação não cobre, está `NÃO DOCUMENTADO` ou `NEED SGP ACCESS` — não é convite a supor (§64).
* **Duas superfícies de API do SGP não resolvidas:** `/api/ura/` com Token/App no corpo, e `/api/v1/` com header. Confirmar no sandbox **antes** de escrever o transporte.
* **Método HTTP não é garantia de segurança nessa API:** `GET /api/fttx/onu/{id}/reset/` derruba uma ONU.
* **O SGP tem descoberta global de OS, CTO e ONU — o ReceitaNet não.** Isso **não** revoga a §141 nem promove a Parte XIII; ver `ERP-SGP.md` §5.

## Sincronização de OS do ReceitaNet

**Carregar:** `src/lib/receitanet-order-sync.ts` (o serviço), `src/lib/service-orders.ts` (`importServiceOrderForCustomer` e o núcleo `persistImportedServiceOrder`) e `docs/PRD.md` §142.
**Quando:** a tarefa envolve importar, reimportar ou exibir OS vindas do provedor.
**Quando NÃO:** OS interna, execução do técnico, ou qualquer coisa que não atravesse a fronteira do ERP.

Quatro invariantes que já custaram caro e são fáceis de desfazer:

* **Por cliente conhecido, nunca global.** Não existe listagem de OS da empresa (§141). Não varrer ids, não chamar `/v1/chamados` sem `idCliente`.
* **O AlfaOS é a fonte de verdade da execução.** Re-sync atualiza só campos do provedor — a allowlist está em `persistImportedServiceOrder`, e `data: normalizedChamado` seria o defeito.
* **Ausência não é fechamento.** Chamado que some não é cancelado nem concluído.
* **`ServiceOrder.number` é do AlfaOS.** O número do provedor vive em `externalNumber`, e os dois nunca se sobrepõem.

## Homologação ReceitaNet

**Carregar:** `docs/RECEITANET-HOMOLOGATION.md` — o levantamento read-only das quatro APIs oficiais (CallCenter, URA, Chatbot, Central do Assinante). Contém:

- **evidência real dos endpoints** — extraída dos OpenAPI oficiais e dos testes já executados contra a API, não de suposição;
- **divergências entre OpenAPI e comportamento real** — inclusive as duas armadilhas de `/v1/chamados`: o teto documentado de 10 registros e o `success:false` que ali significa *zero resultados*, e não erro como em `/v1/clientes`;
- **matriz READ-ONLY/MUTANTE** por rota, nas quatro APIs, com o que é proibido chamar;
- **estado da investigação de descoberta global de OS**, separado em COMPROVADO / DESCARTADO / HIPÓTESE / AGUARDANDO RECEITANET;
- **pendências com o suporte** — perguntas fechadas, cada uma amarrada a uma lacuna concreta.

**Quando:** antes de chamar qualquer rota ReceitaNet ainda não implementada; ao avaliar se uma capacidade existe de fato; ao retomar a investigação de sincronização/descoberta de OS; ao mexer em acesso PPPoE (o documento registra a política `DOCUMENT_LAST4`, a regra de que `MANUAL` nunca é sobrescrito e a validação operacional de `login` como usuário PPPoE); ou ao preparar contato com o suporte do ReceitaNet.
**Quando NÃO:** tarefas que não tocam ReceitaNet. Para o contrato interno de adapters e o modelo de erro, o documento certo continua sendo `docs/ERP-INTEGRATIONS.md` — este aqui é sobre a API do provider, não sobre a camada AlfaOS.

**Credenciais:** o armazenamento, o isolamento entre CallCenter e Chatbot, o AAD `v1`/`v2` e a fronteira do plaintext PPPoE estão em `docs/SECURITY.md` §8.7 — leia antes de tocar qualquer fluxo de token de ERP.

É o documento que registra o que **não existe**: consultar antes de assumir que uma funcionalidade é possível.

**Conclusão central, agora confirmada pelo suporte do provider (2026-08-25):** não existe API pública para listar globalmente as OS da empresa. Toda leitura de OS exige `idCliente` conhecido. A investigação está **encerrada** — não retomar, não fuzzar endpoint global. É limitação do provider, não dívida do AlfaOS (`docs/PRD.md` §141).

O documento também traz o mapeamento de identidade da sincronização da v0.8, agora implementada e homologada em piloto real (`idSuporte` → `externalId`, `numero` → `externalNumber`; `protocolo` **não é persistido**), as duas armadilhas de `/v1/chamados` que viraram requisito e o registro do piloto contra o provider.

## AlfaOS Field, toolkit do técnico e fundações de backend

**Se a tarefa toca a Field API que EXISTE, carregue primeiro `docs/FIELD-API.md`** — namespace `/api/field/v1`, autenticação por token opaco e `MobileDevice`, contrato de erro com código estável, `Idempotency-Key`, `expectedVersion`, minimização de DTO, outbox e worker. O contrato de segurança correspondente é `docs/SECURITY.md` §8.13; a §8.9 continua sendo a especificação do que ainda não existe.

**Implementado na v0.9:** login/logout, `/me`, registro de dispositivo, Minhas OS, detalhe, `start`, revelação de PPPoE, diagnóstico, central de notificações, outbox transacional com worker por comando (`npm run outbox:work`) e abstração de push (sem FCM real).

**Endurecido depois da auditoria independente:** revogação de aparelho com tela em `/dispositivos` (`ADMIN`), aparelho revogado **não** volta por login (`DEVICE_REVOKED`), lease e reclaim no outbox e na reserva de idempotência, resposta do `start` vinda da mutação, e o worker compilado para rodar com `node` em produção. Se a tarefa toca revogação, fila ou idempotência, leia `docs/SECURITY.md` §8.13 e `docs/V0.9-AUDIT.md` antes.

**Implementado na v0.10 (backend, Etapa A):** execução e fechamento em campo — `CustomerLocation` com precedência, confirmação e correção com histórico imutável, check-in, evidências categorizadas com upload, checklist dinâmico com snapshot por OS, ledger mínimo de inventário, equipamento instalado, tentativa de contato, impedimento, assinatura vinculada ao conteúdo e conclusão validada por tipo de OS. Dezesseis rotas novas; contrato em `docs/FIELD-API.md` §3, segurança em `docs/SECURITY.md` §8.14.

**Se a tarefa toca execução em campo, os arquivos são:** `src/lib/customer-locations.ts` (precedência — leia antes de mexer em qualquer escrita de coordenada), `src/lib/inventory.ts` (ledger e a corrida), `src/lib/checklists.ts` (snapshot), `src/lib/service-order-completion.ts` (validação e hash do fechamento), `src/lib/service-order-child-mutation.ts` (o preâmbulo de posse e o CAS, compartilhado por sete comandos) e `src/lib/field/command.ts` (a sequência de todo comando mutante).

Três invariantes da v0.10 que são fáceis de desfazer sem perceber:

* **Check-in NÃO confirma localização.** São entidades diferentes de propósito. Derivar `verified` de um GPS de chegada produziria uma base inteira de coordenadas "verificadas" que ninguém verificou.
* **Escrita automática de coordenada passa OBRIGATORIAMENTE por `applyImportedCustomerLocation`.** A auditoria da v0.10 encontrou essa função sem chamador de produção, com o enriquecimento gravando direto e rebaixando `verified` — ver `docs/SECURITY.md` §8.14. Se você está escrevendo `latitude` em `Customer`, está no caminho errado.
* **O checklist da OS é snapshot, não referência.** Editar o template não pode alcançar OS já iniciada.

**Implementado na v0.10 (Flutter, Etapa B) — publicado:** a execução inteira no aplicativo do técnico. Localização, check-in, relatório, checklist, fotos, materiais, equipamento, assinatura e conclusão. A **foto da etiqueta** passou a ser a identificação do equipamento (série e MAC viraram opcionais), com estágio `TEMPORARY` → `COMMITTED`, TTL, promoção transacional, vínculo 1:1 e expurgo por comando (`npm run evidence:cleanup`). O inventário do que a v0.10 entregou está em `docs/PRD.md` **§225**; a tag é `v0.10-field-execution-closing`.

**Continua só especificação:** offline no cliente, FCM real, todo o toolkit, `ToolExecution`, custódia de patrimônio, PDF de fechamento e reabertura de OS.

**Carregar:** `docs/PRD.md` **Parte V (§150–§195)** — a especificação completa do Field. Carregue apenas o bloco relevante à tarefa, não a Parte inteira:

| Assunto | Seções |
|---|---|
| Visão, tela da OS no Field, tema | §150–§152 |
| Notificações push, central, `MobileDevice` | §153–§155 |
| Transactional Outbox, fila de jobs, retry | §156, §157 |
| Offline, outbox local, idempotência, conflitos | §158–§161 |
| Evidências estruturadas e upload resiliente | §162, §163 |
| `ServiceOrderType` como motor, checklist, validação de conclusão | §164–§166 |
| Work events, check-in, contato, impedimento, reabertura, agenda | §167–§171 |
| Navegação e confirmação de localização | §172 |
| Toolbox: Wi-Fi, diagnóstico, gateway, roteador, speed test | §173–§179 |
| `ToolExecution` | §176 |
| QR/equipamentos e inventário como ledger | §180, §181 |
| Fibra, óptica, base de conhecimento, histórico, SLA, skills | §182–§185 |
| Tracking, mapa, roteirização | §186, §187 |
| Comunicação, IA, observabilidade | §188–§190 |
| Segurança do Field e contrato da Field API | §191, §192 |
| Roadmap P0/P1/P2 e fundações de backend | §194, §195 |

**Quando:** a tarefa envolve o aplicativo do técnico, notificações, sincronização offline, evidências, checklist dinâmico, ferramentas técnicas, inventário, ou qualquer fundação de backend que o Field exige.
**Quando NÃO:** tarefas do painel Web sem relação com o Field, integrações ERP, ou módulos já cobertos por doc próprio. Para segurança de token móvel, dispositivo e segredo offline, o documento é `docs/SECURITY.md` §8.9.

**Boa parte da Parte V já é código** — o aplicativo Flutter existe, o outbox existe, e a execução em campo foi publicada na v0.10. O que continua especificação está listado acima e na §194, que traz a nota do que sobrou. `ToolExecution`, o toolkit e o push real **não existem**, e para eles a §119 se aplica: estar no PRD não autoriza implementar.

**Duas escalas de prioridade convivem:** a §117 classifica o produto inteiro (MVP/IMPORTANTE/DIFERENCIAL/FUTURO); a §194 classifica a trilha Field (P0/P1/P2). Uma capability pode ser DIFERENCIAL e P0 ao mesmo tempo — conferir as duas antes de concluir que algo está ou não no escopo.

**Documentação própria do Flutter:** ainda não existe. Criar quando a trilha for autorizada, e registrar aqui.

## Geolocalização, mapa operacional e despacho

**Carregar:** dois blocos, e eles se complementam — não leia um sem saber que o outro existe.

| Bloco | Seções | O que fixa |
|---|---|---|
| **Arquitetura** | §133–§139 | `CustomerLocation` (modelo, origens, `source` × `verified`), `TechnicianLocation`, `OperationalMap`, despacho assistido, privacidade |
| **Carteira e despacho** | §196–§209 | mapa da carteira, precedência entre origens, cobertura, geocodificação, escalabilidade, filtros, fronteira com o FiberMap, Central de Despacho, Smart Dispatch, roadmap |

As seções 77–79 descrevem a experiência do técnico em campo e são complementares (a §77 foi revisada pela §134, e a §79 não é o mesmo mapa da §136).

Três regras que a Parte VI fixou e são fáceis de desfazer sem perceber:

* **A localização da carteira não depende de OS** (§196). Um mapa alimentado só por atendimento aberto mostra apenas quem está com problema.
* **Dado de menor confiança não sobrescreve o confirmado em campo** (§197). Reimportar do ERP preserva o verificado e registra a divergência.
* **Arrastar um cartão é UI** (§204). A atribuição passa pelo mesmo comando de sempre — auth, tenant, elegibilidade, `version`/CAS, transação, evento, outbox, notificação. Sem fluxo paralelo do Kanban.

**Quando:** a tarefa envolve coordenadas, GPS, mapa, rota, proximidade de técnicos, quadro de despacho ou agenda.
**Quando NÃO:** qualquer outra coisa. Nada disso está implementado — é arquitetura registrada, e a seção 119 se aplica: estar no PRD não autoriza implementar. Para a fronteira com o FiberMap (o AlfaOS **consulta** topologia de rede, não a copia), o ponto é a §202 — **revista pela §334** (Parte XIII), que trocou "não cadastrar" por precedência.

**Exceção, e ela está em código: o Mapa Operacional web** — `/mapa`, com as camadas de CTO, OS abertas e clientes ativos — existe e está **congelado** (PRD §392). Para ele, a rota é a seção de CTOs abaixo, bloco *"Mapa Operacional V1 — a arquitetura real"*. Técnico no mapa, carteira com precedência de origens, geocodificação, despacho no mapa e roteirização continuam sendo só esta arquitetura registrada.

O quadro (§203) decide **quem** atende. A ordem de execução dentro da fila de cada técnico é outra Parte — ver abaixo.

## Fila Operacional de OS — DQ-1 a DQ-7.2 ENTREGUES, publicação pendente

**Carregar:** `docs/DISPATCH-QUEUE.md` (plano — schema, algoritmo, transações, endpoints, fases `DQ-1`–`DQ-7.2`, mais o registro da auditoria e dos dois endurecimentos nas §19–§21) e PRD §308–§332 (Parte XII — o porquê e as regras de produto).

**Código que já existe:**

| Arquivo | Papel |
|---|---|
| `src/lib/dispatch-queue.ts` | Primitivas **puras**: `DISPATCH_BAND`, `normalizeQueue`, `appendPositionForBand`. Sem Prisma, de propósito |
| `src/lib/dispatch-queue-service.ts` | Serviço autoritativo: lock, CAS, normalização persistida, `placeAssignedOrder`, `removeOrderFromQueue`, `moveOrderToPosition`, `reapplyPriorityToQueue` |
| `src/lib/dispatch-queue-backfill.ts` | Backfill idempotente, e `scripts/dispatch-queue-backfill.ts` (`npm run dispatch:backfill`) |
| `src/lib/dispatch-queue-view.ts` | Projeção de leitura do despacho Web. Separada do serviço: acrescentar campo à tela não abre o arquivo que decide lock e CAS |
| `src/app/api/dispatch/technicians/[technicianId]/queue{,/reorder}` | GET da fila e reordenação por alvo absoluto |
| `src/app/api/service-orders/[id]/priority` | Mutação de prioridade — a **primeira** forma de alterá-la depois da criação |
| `src/app/(app)/despacho/` + `src/components/DispatchPanel.tsx` | O painel Web: fila por técnico, prioridade, `↑ ↓`, mover para, arrastar e reatribuir |
| `src/lib/service-order-labels.ts` | Rótulos da OS, **client-safe**. Só `import type` do Prisma — `service-orders.ts` reexporta |
| Testes | `dispatch-queue-{domain,schema,lifecycle,concurrency,api}.test.ts` e `e2e/dispatch-queue.spec.ts` |

**O Field consome a fila (DQ-6 entregue, `DEVICE PILOT PASSED`).** Os arquivos do aplicativo:

| Arquivo | Papel |
|---|---|
| `apps/field/lib/features/orders/domain/dispatch_queue.dart` | O contrato lido. `tryParse` devolve `null` quando falta `position` — **não** inventa índice |
| `apps/field/lib/features/orders/state/dispatch_queue_controller.dart` | Os três desfechos: autoritativa · indisponível (404) · erro. Falha **preserva** a fila anterior |
| `apps/field/lib/core/widgets/position_badge.dart` | `1ª`/`2ª`/`3ª`. A `1ª` pesa mais — hierarquia, não alerta |
| `apps/field/lib/core/widgets/local_order_note.dart` | A etiqueta de procedência do modo de compatibilidade |
| `apps/field/lib/app/shell_back.dart` | `resolveShellBack` — a decisão do Voltar, pura e testável fora da árvore |
| Testes | `test/dispatch_queue_test.dart`, `test/widget/{dispatch_queue_screens,android_back}_test.dart` |

Três regras do lado do cliente que são fáceis de desfazer sem perceber:

* **`attention_ranking.dart` só decide quando o servidor não oferece a fila** (404). Falha de rede **não** cai nele: ordenar sozinho e apresentar como se fosse do despacho é pior que dizer que não deu para atualizar.
* **Quando ele decide, a tela DIZ isso** (`LocalOrderNote`). Fallback isolado no código e silencioso na tela ainda faz o técnico atender na ordem errada com confiança.
* **Nada é reordenado no aplicativo.** Nem por `number`, nem por `priority`, nem por `scheduledAt` — `F-1` monta a armadilha de propósito.

O **Android Back** (o aplicativo fechava em vez de navegar, achado no piloto físico) foi corrigido no mesmo escopo: gaveta e modal fecham primeiro, aba sem pilha volta ao Início, e **só o Início na raiz** deixa o Android sair. **Widget test não aprova gesto de sistema** — a fase só fecha com piloto em aparelho.

Quatro regras que o código já impõe e são fáceis de desfazer sem perceber:

* **Toda função do serviço recebe um `tx`** e nenhuma abre transação própria. A fila é efeito da operação de OS e tem de commitar ou voltar junto com ela.
* **Os dois `id` de fila são descobertos ANTES de qualquer `FOR UPDATE`** (§ "A ordem dos locks"). Travar primeiro e ordenar depois é o mesmo que não ordenar — foi um deadlock real, achado pelo `T-C5`.
* **A renumeração é em duas fases** (negar todas as posições, depois reescrever 1..N). A unique `(queueId, position)` não é `DEFERRABLE`, e a escrita ingênua colide.
* **`version` só anda quando houve mudança real.** Releitura idêntica não pode invalidar o CAS de quem está com a tela aberta — por isso o backfill deixa em 0 a fila que ele mesmo criou, e um reorder acomodado para onde a OS já está não consome versão de ninguém.
* **A API não expõe `moveUp`/`moveDown`.** Alvo absoluto sempre; delta aplicado duas vezes move duas posições. Arrastar e as setas produzem o MESMO comando.
* **Prioridade toca DOIS agregados**, então exige dois tokens: `expectedVersion` (OS) e `expectedQueueVersion` (fila) — este último só quando a OS está em fila, porque uma OS sem técnico não tem fila a comparar.
* **A tela substitui o próprio estado pela resposta.** Nunca `queueVersion + 1` local, nunca "deveria estar na posição 1": o servidor acomoda dentro da banda, e a posição efetiva é a que voltou.
* **Um componente `"use client"` nunca importa `@/lib/service-orders`** — aquele módulo alcança `node:crypto` e quebra o bundle do navegador. Rótulos vêm de `service-order-labels.ts`.
* **`e2e/dispatch-queue.spec.ts` limpa o que cria.** A suíte E2E divide um banco só, num worker: OS e vínculos de técnico deixados para trás derrubam `technician-execution`, `team-workday` e `service-orders` — e só na suíte inteira, nunca isolados. Para entender o modelo que já existe, também `prisma/schema.prisma` (`ServiceOrderPriority`, `ServiceOrder`) e `src/lib/service-orders.ts` (rótulos, ordenação da fila do técnico, `assignTechnician`).

**Qual dos dois abrir:** o PRD responde *por que* e *qual é a regra*; o `DISPATCH-QUEUE.md` responde *como executar*. Para implementar, o segundo — as onze decisões (`D-01`–`D-11`) estão fechadas lá, com tabela.

| Assunto | Seções |
|---|---|
| Capability, prioridade × posição | §308, §309 |
| Auditoria do modelo de prioridade atual e as decisões pendentes | §310 |
| Fila por `(empresa, técnico)`, composição, posição explícita | §311–§313 |
| Ranking local do Field como estado temporário | §314 |
| Alteração de prioridade, reordenação, entrada e saída da fila | §315–§317 |
| Concorrência, idempotência e invariantes | §318–§320 |
| OS em atendimento, eventos, auditoria e histórico | §321, §322 |
| Fila no Field e no despacho Web | §323–§325 |
| ReceitaNet, notificações, offline | §326–§328 |
| Opções de schema, aceite, casos de borda, roadmap | §329–§332 |

Quatro regras que a Parte XII fixou e são fáceis de desfazer sem perceber:

* **Prioridade responde criticidade; posição responde sequência** (§309). Não são a mesma coisa, e nenhum número de níveis de prioridade produz uma sequência.
* **O `expectedVersion` da OS não protege uma reordenação** (§318). Ela escreve N linhas; o CAS responde por uma. A fila precisa da própria unidade de concorrência.
* **Delta não é idempotente** (§318). "Subir uma posição" aplicada duas vezes sobe duas. O contrato usa alvo absoluto, mais `Idempotency-Key`.
* **Posição nunca vira `scheduledAt`** (§324). Fabricar horário a partir de ordem produz, um dia depois, um horário que alguém acha que foi prometido ao cliente.

Dois achados do levantamento que o plano depende e que valem fora dele: **não existe operação de cancelamento nem de desatribuição de OS** — `status: "CANCELLED"` nunca é escrito e `technicianId: null` só aparece em fixture —, e **`ServiceOrder` não tem índice em `technicianId`**.

**Quando:** a tarefa envolve ordem de atendimento, prioridade de OS, reordenação de fila ou o painel de despacho por técnico.
**Quando NÃO:** qualquer outra coisa. **Nada disso existe em código** — nenhuma migration, nenhuma rota, nenhuma tela. A §119 se aplica: o plano estar fechado não autoriza implementar.

## Experiência do técnico na OS

**Carregar:** `src/app/(app)/ordens/[id]/page.tsx` (a tela, com as diferenças por perfil), `src/components/CustomerContactCard.tsx` (contato, endereço e navegação), `src/lib/map-links.ts` (Google Maps/Waze e validação de coordenada) e `src/lib/return-to.ts` (allowlist do destino de volta).
**Quando:** a tarefa muda o que o técnico vê na OS, o contato do cliente, a navegação até o endereço, ou a navegação contextual entre OS e cadastro.
**Quando NÃO:** backend sem superfície visível, integrações, ou o painel administrativo de clientes.

Duas regras que a v0.7.4 fixou e são fáceis de desfazer sem perceber:

* **A simplificação é do TECHNICIAN, não do produto.** ADMIN e DISPATCHER continuam vendo id interno, origem, número no ERP e contexto ReceitaNet — é com isso que se abre chamado com o provedor. Ver PRD §145 e §151.
* **`returnTo` passa por allowlist fechada e por verificação de tenant.** As duas, não uma. Detalhe em `docs/SECURITY.md` §8.11.

## Custódia de patrimônio do técnico

**Carregar:** `docs/PRD.md` §210–§223 — `Asset`, `AssetCustody`, termo de cautela, assinatura do recebimento, conferência periódica, ocorrências, devolução e permissões.
**Quando:** a tarefa envolve ferramenta, EPI ou equipamento de trabalho cedido ao técnico.
**Quando NÃO:** material consumido no atendimento — isso é inventário (§90, §181). A fronteira entre os dois está na §211.

Três decisões que são fáceis de desfazer sem perceber:

* **Um ledger só** (§215). Custódia usa os movimentos da §181 e acrescenta cinco que consumível não faz. Não criar enum concorrente.
* **Sem QR para ferramenta** (§222). A decisão é ESTRITA a patrimônio do técnico e **não** revoga a §180 — leitura de QR/serial/MAC continua P0 do Field para equipamento instalado no cliente.
* **O AlfaOS documenta, não julga** (§219). Nada de desconto automático, cobrança ou atribuição de culpa: o processo trabalhista fica fora.

Nada disso está implementado — é especificação, e a §119 se aplica.

## Jornada / Ponto do funcionário — FASE 1 PUBLICADA (v0.11-employee-time-clock)

**Carregar:** `docs/PRD.md` §226–§233 — marcações, evidência da batida, histórico imutável e pedido de ajuste, espelho, painel do gestor, ponto offline e LGPD. Se a tarefa toca autorização, quem decide ou fuso, leia junto `docs/SECURITY.md` **§8.15**. Código: `src/lib/workday.ts` (dia, estado e **sequência efetiva**) e `src/lib/time-clock.ts` (domínio).
**Quando:** a tarefa envolve jornada de trabalho, batida de ponto, espelho, banco de horas ou aprovação de ajuste.
**Quando NÃO:** check-in de OS — **não é a mesma coisa** (§226). Check-in é `docs/TECHNICIAN-EXECUTION.md` e a §167. Escala/plantão/folga/DSR é módulo **separado**, ainda `PLANNED` — ver a entrada logo abaixo.

Quatro regras que serão fáceis de desfazer sem perceber:

* **Ponto não é check-in.** Derivar entrada do primeiro check-in do dia deixaria sem jornada quem passou o dia no almoxarifado (§226).
* **O relógio do servidor é a autoridade.** O carimbo do aparelho é metadata, e existe porque diverge (§227).
* **A marcação original nunca é editada.** Correção é pedido com aprovação, e o registro derivado aponta para ele (§229).
* **Só existe UMA noção de "marcação atual".** A correção aprovada **supera** a original sem apagá-la, e as duas linhas convivem na tabela. Quem lê o histórico bruto lê um dia que não existe: estado, ação permitida, validação de sequência e espelho passam todos por `resolveEffectiveTimeEntries`. Ler `timeEntry.findMany` direto para decidir qualquer coisa é o defeito, não o atalho.

**Estado do release: `PUBLISHED`.** Tag anotada `v0.11-employee-time-clock`, no commit `f057ee1`, publicada no remoto. Auditoria clean-room final: `APPROVED WITH RISKS`, `RELEASE GO` — 0 CRITICAL, 0 HIGH, 0 MEDIUM, 1 LOW, 3 INFO. O inventário do que entrou, o registro do piloto e os riscos residuais estão em `docs/PRD.md` **§252** e **§253**.

**O que JÁ existe:** `Workday`, `TimeEntry`, `TimeAdjustmentRequest` e `Company.timezone`; as rotas `/api/field/v1/time-clock/*` e `/api/time-clock/*`; a tela `/jornada`, a página por funcionário e a tela do Field. **Não existe** banco de horas, escala prevista, folha, engine offline no cliente nem tela de configuração de fuso — `Company.timezone` só tem o default. A §119 se aplica ao que falta.

**Das pendências registradas (§253), três foram fechadas no endurecimento final** — e as três viraram regra que dá para desfazer sem perceber:

* **Quem abre não decide, quando a jornada é a própria** (LOW-1). Abrir continua permitido; a recusa é 403, vem **depois do lock e antes de qualquer escrita**, e não deixa `TimeEntry`, `updateMany` nem `AuditLog`. A tela esconder o botão é UX — a autoridade é `decideTimeAdjustment`.
* **A criação administrativa exige `Idempotency-Key`** (LOW-2), na **mesma** infraestrutura do Field, com nome de operação próprio (`time-clock.admin-adjustment`). Criar uma segunda idempotência para a web é o defeito, não o atalho.
* **O fuso do horário solicitado é o da EMPRESA** (LOW-3). `WorkdayView.utcOffset` vai no DTO e o Field o usa para ler e montar horário. O relógio do aparelho não é autoridade sobre jornada, e uma tabela de fusos dentro do APK envelhece na primeira mudança de lei.

**Quatro achados da auditoria clean-room final, todos residuais e aceitos** (não corrigir sem tarefa própria):

* **JOR-A1 (`LOW`) — RESOLVIDO** (v0.11.1). Só conta intervalo com as **duas pontas provadas**; o parcial até agora vale só para o **dia corrente**, e quem decide se o dia ainda está acontecendo é o fuso da empresa. `summarize` recebe `openEndsAt` e virou função **pura** — `Date.now()` por dentro dela era o defeito. Nada de assumir saída às 23h59, criar `CLOCK_OUT` ou tocar `TimeEntry`.
* **JOR-A2 (`INFO`) — RESOLVIDO** (v0.11.1). As inconsistências aparecem no Field (cartão do dia e histórico) e no **espelho web individual** (`/jornada/[userId]`, que navega por dia), **sem CTA novo** — a porta única continua na seção `Correções` (§258). O sinal deixou de disparar para quem está trabalhando agora: um alerta que aparece sempre não é alerta.
* **JOR-B1 (`INFO`) — pendente.** A **lista da equipe** (`/jornada`) tem o campo `inconsistencies` e o JSX que o exibiria, mas a página chama `getTeamWorkday(session.companyId)` sem instante — sempre lê o dia corrente, que nunca é sinalizado por desenho. O ramo é código morto em produção, não removido; ver `docs/PRD.md` §253.
* **JOR-B4 (`INFO`) — bloqueia JOR-05.** O lookup de `Workday` por instante (`getWorkdayView`, `getTeamWorkday`, `getWorkdayHistory`) usa o fuso **atual** de `Company.timezone`, não o fuso sob o qual o dia foi vivido. Uma UI de configuração de fuso (JOR-05) não deve nascer antes disso ser resolvido — troca de fuso pode fazer dia histórico "sumir", localizar `Workday` no dia vizinho, ou recusar `CLOCK_OUT` por `Workday` errado. Risco teórico hoje porque `Company.timezone` só tem o padrão.
* **JOR-A3 (`INFO`)** — `pendingAdjustments` do painel do gestor não é limitado ao dia consultado.
* **JOR-A4 (`INFO`)** — `$executeRawUnsafe` só no reset de banco de teste, protegido pelo guard de ambiente.

**Continua pendente: JOR-05** — `Company.timezone` não tem superfície administrativa. Não bloqueia: o padrão `America/Sao_Paulo` atende, e o campo já cai no padrão quando o valor gravado é inválido. **`BLOCKED BY JOR-B4`**: antes de dar à empresa como trocar o fuso, o lookup de `Workday` por instante precisa parar de depender do fuso ATUAL para achar dias históricos.

## Escala de trabalho e espelho de jornada — PLANNED

**Carregar:** `docs/PRD.md` **Parte XI (§288–§307)** — escala, plantão, folga, DSR, sábado alternado, troca de plantão, planejado × realizado e o Attendance Report (PDF/CSV).
**Quando:** a tarefa envolve escala de trabalho, plantão, folga, DSR, recorrência de escala, troca entre técnicos, "Minha Escala" no Field, ou exportação de espelho de jornada em PDF/CSV.
**Quando NÃO:** jornada/ponto em si — isso é a entrada **acima**, e as duas nunca se fundem (§288). Contrato assinado é a Parte X (§266–§287); o Attendance Report **não é** `SignedContract` (§304).

**Nada disso existe.** A regra que não pode ser desfeita ao implementar:

* **Escala é planejado; Jornada/Ponto é realizado.** `PLANTAO` nunca cria `CLOCK_IN`; `FOLGA` e `DSR` nunca criam `TimeEntry` (§288, §300). Um despacho ou uma tela "inteligente" que abrisse ponto a partir da escala violaria a mesma garantia que sustenta o módulo inteiro.
* **`ScheduleRule` gera `ScheduleOccurrence`; a exceção altera a ocorrência, nunca a regra** (§290, §293) — a mesma separação fato/correção que a Jornada já fez entre `TimeEntry` e `TimeAdjustmentRequest`.
* **O Attendance Report não pode implementar cálculo de horas próprio.** PDF, CSV, dashboard, Field e painel web consomem o MESMO motor — hoje `resolveEffectiveTimeEntries` e `src/lib/time-clock.ts` (§302). O bloqueio por `JOR-A1` foi **levantado** na v0.11.1 (§303), o que não promove o relatório a implementado: ele continua `P1`/`PLANNED`, sem gerador, rota, tela nem CSV.

## Field Workspace, App Shell e Dashboard — FASE 1 ENTREGUE, RELEASE PENDENTE

**Carregar:** `docs/PRD.md` §254–§258 — a visão do Field como **workspace do técnico** (e não como app de OS), a navegação híbrida, a gaveta categorizada, o dashboard `Início` e a decisão de porta única para a correção de jornada. Código: `apps/field/lib/app/router.dart`, `home_shell.dart`, `widgets/workspace_menu.dart` (o registry da gaveta), `widgets/app_drawer.dart`, `widgets/planned_module_sheet.dart`, `widgets/notifications_bell.dart`, `widgets/shell_drawer_button.dart`, `features/dashboard/ui/dashboard_screen.dart`, `features/dashboard/domain/attention_ranking.dart`.
**Quando:** a tarefa muda a navegação do aplicativo, adiciona destino novo, mexe no dashboard `Início`, na gaveta ou no cabeçalho.
**Quando NÃO:** backend sem superfície no aplicativo, painel web, ou uma tela isolada do Field que não altera a navegação — essas continuam sem carregar esta entrada.

**Estado do release: entregue, sem tag e sem push.** Dois piloto físicos previstos: o **primeiro já aconteceu** e aprovou arquitetura e navegação, mas reprovou o visual; o hardening que respondeu a isso **aguarda o segundo**. Seis decisões que são fáceis de desfazer sem perceber:

* **OS e Jornada não podem viver só na gaveta** (§255). São as duas ações mais frequentes do dia — e por isso são abas da barra, não itens de menu.
* **A política do menu foi REVISTA depois do primeiro piloto** (§256). Antes: "item que não existe não aparece". Agora: **a barra principal** só recebe o que está implementado; **a gaveta** apresenta o Workspace inteiro com o planejado marcado por selo `EM BREVE`. A honestidade mudou de lugar — saiu da omissão e foi para o selo **e a ausência de rota**, que é estrutural: item planejado tem `route == null`, e um teste permanente prova que nenhum dos 15 carrega rota.
* **Item planejado abre UMA folha genérica, nunca uma tela própria** (§256). `planned_module_sheet.dart` é local, sem rota, e serve os quinze — quinze telas placeholder seriam quinze lugares onde alguém, meses depois, poderia ligar um botão a uma API inexistente.
* **O dashboard não decide o que é permitido** (§257). O card de Jornada apresenta `allowedActions`, que já vem do servidor derivado da sequência efetiva — recalcular no cliente faz o aplicativo discordar do domínio na primeira correção aprovada. Tocar a ação **navega** para `/jornada`; não bate ponto inline, porque duplicar o diálogo de confirmação ali criaria um segundo lugar para a mesma proteção divergir.
* **"Próxima OS" continua exigindo `scheduledAt`; "Atenção agora" não** (§257). O bloco novo existe porque uma OS sem agendamento — o caso real do ReceitaNet no piloto — não é "próxima" de ninguém e sumia do Início. As duas seções respondem perguntas diferentes, e nenhuma inventa cronologia. O ranking vive em `attention_ranking.dart`, testado sem widget.
* **A gaveta pertence a UM `Scaffold` só — o do shell.** Cada tela da barra abre essa MESMA instância por referência (`shellScaffoldKeyProvider`), nunca a própria: uma `Drawer` por tela nasceria aninhada no espaço que o `Scaffold` do shell já reduziu para a `NavigationBar`, e colidiria com ela. Achado corrigido, por falha real de teste.

**Origem do provedor NÃO aparece no card de OS, e não é esquecimento.** O DTO do Field omite `origin`/`externalProvider`/`externalNumber` de propósito (`src/lib/field/dto.ts`): uma OS importada tem de ser indistinguível de uma interna, e é a ausência do dado que impede um `if (RECEITANET)` no aplicativo. Um badge "ReceitaNet" exigiria o backend passar a enviar campo autoritativo — decisão de contrato, não de tela.

A porta única da correção (§258) **já foi aplicada** no endurecimento final da Fase 1 da Jornada: a tela de jornada do Field oferecia "SOLICITAR CORREÇÃO" em dois lugares, e ficou só o da seção `Correções`. O cartão de hoje responde estado, trabalhado, última marcação e correções pendentes, e mais nada. O teste que segura isso conta o RÓTULO, não a chave.

**Mapa NÃO é destino da barra nesta fase.** O §255 já prescrevia isso: "fica vago ou traz Agenda" enquanto o módulo não existe — nenhum dos dois tem código, e a barra fica com três destinos (Início, OS, Jornada), não quatro com um placeholder.

**"Minha Escala" é destino separado de "Minha Jornada"** (§298, Parte XI) — mesma gaveta, mesmo App Shell, entidades diferentes. O dashboard `Início` ganha um card de próximo plantão/folga sem reordenar os blocos já especificados no §257.

## Mapa operacional no Field, agenda e estoque do técnico — PLANNED

**Carregar:** `docs/PRD.md` §259–§263 — mapa do técnico, ação no pin, privacidade/GPS, agenda de compromissos e "Meu Estoque". Leia junto o bloco correspondente já existente: mapa é a Parte VI (§196–§209), agenda estende a §171, estoque estende a §181.
**Quando:** a tarefa envolve mapa dentro do aplicativo, compromisso do técnico, lembrete, ou saldo de material do técnico.
**Quando NÃO:** Central de Despacho — isso é **web** (§203, §204). Ferramenta cedida ao técnico é custódia (§211).

**Nada disso existe.** Três regras que são fáceis de desfazer:

* **Não é um segundo mapa** (§259). É a mesma `CustomerLocation` e a mesma precedência da §197.
* **GPS `while-in-use`, evento é um ponto** (§261). Tracking durante a jornada só existe se a política da empresa habilitar, e nunca fora dela.
* **A OS na agenda é projeção, não cópia** (§262). Guardar horário próprio criaria duas respostas para "quando é o atendimento".

O plantão da Escala (§298, Parte XI) entra na agenda pela mesma regra de projeção — nunca com horário próprio guardado ali.

## Ferramentas do técnico e configuração de roteador — PLANNED

**Carregar:** `docs/PRD.md` §264 e §265, **junto com** §173–§179 (o toolbox já especificado) e §178 (a arquitetura de roteador, que **não muda**).
**Quando:** a tarefa adiciona ferramenta ao Field, mexe no hub de ferramentas ou no assistente de roteador.
**Quando NÃO:** diagnóstico de conectividade via ERP — isso é `docs/ERP-INTEGRATIONS.md`.

**Nada disso existe.** Três limites:

* **O scanner de LAN é controlado** (§264): só na rede do atendimento em curso, com OS aberta e registro de quem executou.
* **A §222 continua estrita**: não há QR para ferramenta do técnico; QR de equipamento instalado no cliente continua `P0` (§180).
* **O Flutter não fala direto com integração crítica quando o backend pode mediar** (§265). Credencial de ACS ou de fabricante dentro de um APK é credencial publicada — a mesma fronteira da §191.

## Contratos, assinatura eletrônica, validador e entrega — PLANNED

**Carregar:** `docs/PRD.md` **Parte X (§266–§287)**. Carregue apenas o bloco relevante, não a Parte inteira:

| Assunto | Seções |
|---|---|
| Capability, dados contratuais da empresa | §266, §267 |
| Variáveis: dicionário oficial, system × custom, UX | §268–§270 |
| Editor, modelo e versionamento | §271, §272 |
| Multipágina, modo de assinatura, componentes | §273, §274 |
| Pipeline de geração, hash, prévia e variável inválida | §275, §276 |
| `SignedContract`, evidências, OTP | §277–§279 |
| Validador e o limite ICP-Brasil | §280, §281 |
| Entrega — WhatsApp, e-mail, web | §282 |
| Contrato por tipo de OS e política de conclusão | §283 |
| Tipos de documento, segurança, UX do técnico | §284–§286 |
| Roadmap do workspace e dos contratos | §287 |

**Quando:** a tarefa envolve contrato, termo, modelo de documento, variável de template, assinatura eletrônica do cliente, PDF gerado, validação de documento ou entrega ao cliente.
**Quando NÃO:** a assinatura de **fechamento da OS** — essa já existe desde a v0.10 e é `docs/SERVICE-ORDER-CLOSING.md`. **Não são a mesma assinatura** (§286). Assinatura de recebimento de ferramenta é a §214.

**Nada disso existe:** não há modelo, rota, tela, gerador de PDF, motor de assinatura, QR nem validador. A §119 se aplica integralmente.

Cinco regras que a Parte X fixou e são fáceis de desfazer sem perceber:

* **Publicar versão nova nunca altera contrato assinado** (§272). Versão `PUBLISHED` é imutável; mudar é criar `DRAFT` novo.
* **Snapshot, não referência** (§275). O documento guarda os valores resolvidos; cliente que muda de endereço amanhã não altera o contrato de ontem.
* **Nunca confiar em filename** (§275). Identidade é `id`, integridade é hash, autorização é RBAC.
* **Placeholder não resolvido nunca chega ao documento final** (§276). A validação é na **publicação** do modelo, não na geração.
* **O validador não é ICP-Brasil** (§281). É mecanismo próprio de integridade e evidência — nenhuma tela, PDF ou texto pode sugerir equivalência com assinatura qualificada.

E duas de privacidade: o validador público **não expõe dado pessoal completo** (§280), e a senha do Wi-Fi **não entra em contrato automaticamente** (§268).

## Rede interna do cliente e equipamentos — PLANNED

**Carregar:** `docs/PRD.md` §234–§246 — papel na rede separado do tipo físico, topologia, política por empresa, IP de gerenciamento, backhaul, local, propriedade, patrimônio, credencial de acesso, perfil de rede e histórico. A ponta administrativa é a §224.
**Quando:** a tarefa envolve topologia da casa do cliente, repetidor, IP de gerenciamento, propriedade do equipamento ou o painel web de equipamentos.
**Quando NÃO:** **CTO e portas** são outra capability — ver a seção abaixo. Traçado de fibra (cabo, splitter, PON, OLT) é FiberMap. Material consumido no atendimento é inventário (§181); ferramenta cedida ao técnico é custódia (Parte VII, §211).

**O que JÁ existe (v0.10):** `ServiceOrderEquipment` com tipo, fabricante, modelo, série e MAC opcionais, e a foto da etiqueta com estágio e vínculo 1:1. **Não existe** papel na rede, topologia, IP, propriedade, política por empresa nem histórico de troca — tudo isso é `PLANNED`.

Duas decisões que o PRD já fixou e não devem ser desfeitas na implementação:

* **`equipmentType` e `networkRole` são campos diferentes** (§235). Nem toda ONT roteia, e o tipo não muda quando o modo de operação muda.
* **O padrão de repetidor da Alfa Telecom é configuração, não código** (§237). Hardcode transformaria a regra de um provedor em regra do produto.

## CTOs e Rede de Distribuição — `CTO-1`, `CTO-2` e o Mapa Operacional V1 em código; mapa FROZEN

**Carregar:** `docs/CTO-NETWORK-DISTRIBUTION.md` (especificação técnica — modelo, concorrência de porta, fluxos, fases `CTO-1`–`CTO-7`, aceite, casos de borda) e PRD §333–§341 (visão, invariantes e a revisão da §202). Para entender a fonte de status, também `src/lib/customer-diagnostics.ts` e o modelo `CustomerDiagnosticSnapshot`.

**Leia a §334 antes de qualquer outra coisa: ela REVÊ a §202**, que proibia cadastro de CTO no AlfaOS. O motivo é que a regra prescrevia consultar o FiberMap, que é `FUTURO` sem data — sem integração não há dois cadastros, há nenhum, e o técnico ia ao poste sem saber a caixa. A precedência para o dia em que o FiberMap existir está escrita: ele manda na topologia física, o AlfaOS no vínculo operacional.

Quatro coisas que a especificação fixou e são fáceis de desfazer sem perceber:

* **`Customer.ctoId` não serve** (§335). Responde "onde ele está agora" e destrói "onde ele estava" — e não representa porta livre.
* **A porta é o ponto de concorrência**, e quem arbitra é o **banco** (unique parcial), não uma checagem de aplicação. Dois técnicos, dois celulares, a mesma porta 4.
* **Nenhuma integração nova de status** (§336). A CTO lê o `CustomerDiagnosticSnapshot` que a OS já usa. Uma segunda leitura criaria dois estados para o mesmo cliente.
* **O diagnóstico atual não sustenta tempo real** (§337): refresh é sob demanda com gatilho na OS, e o teto é **10 chamadas por minuto por empresa** — uma CTO de 8 portas consumiria 8. Por isso a CTO mostra o último estado conhecido **com a idade da leitura**.

### Mapa Operacional V1 — a arquitetura real (`CTO-3.1` a `CTO-3.2.2e`, **FROZEN**)

**Contrato:** PRD §392 (consolidado) e §364–§379. **Medições e armadilhas:** `docs/CTO-NETWORK-DISTRIBUTION.md` §34–§46 — a seção mais recente vence onde um número mudou. **Não mexer sem decisão explícita do dono**; ideia nova vai para o backlog (PRD §393), e só correção crítica de defeito reabre este código.

| Superfície | Quem | Código |
|---|---|---|
| `/mapa` (página) | `ADMIN`, `DISPATCHER` | `src/app/(app)/mapa/page.tsx` — decide `canOpenDetail`, `canEditPosition`, `canSeeCustomers` (os três `ADMIN`) |
| `GET /api/ctos/map` — camada de CTO | `ADMIN`, `DISPATCHER` | `src/lib/cto-map.ts` (recorte, teto, estado derivado) |
| `GET /api/map/service-orders` — camada de OS abertas | `ADMIN`, `DISPATCHER` | `getServiceOrderMapView` em `src/lib/operational-map.ts` |
| `GET /api/map/customers` — camada de clientes | `ADMIN` | `getCustomerMapView` em `src/lib/operational-map.ts` |
| `GET /api/map/search` — busca global no tenant | `ADMIN`, `DISPATCHER` (resultados de cliente só `ADMIN`, cortados no servidor) | `src/lib/map-search.ts` — CTO por nome/código, cliente ativo por nome, OS aberta por número |
| `GET /api/ctos/[id]/customers` — clientes por porta | `ADMIN` | `getCtoPortCustomers` em `src/lib/operational-map.ts` |
| `PATCH /api/ctos/[id]` — ajuste de posição | `ADMIN` | `updateCto` em `src/lib/cto.ts`, payload só `{latitude, longitude}`; **nenhuma rota `/location`** |

Todas as rotas entram por **`requireCtoAccess`** (`src/lib/cto-access.ts`): sessão → capability de rede da empresa → perfil. `companyId` é sempre o da sessão, no predicado SQL.

**Quem é dono de cada pergunta — uma autoridade por pergunta, e o mapa só consome:**

* **Conectividade** — `src/lib/customer-diagnostics.ts`: `getCustomerDiagnostic` (um cliente) e `getConnectivityForCustomers` (lote, mesmo DTO). Leitura pura de banco; o mapa **nunca** chama ERP nem provider.
* **OS aberta** — `OPEN_SERVICE_ORDER_STATUSES` em `src/lib/service-order-labels.ts`, derivado dos estados terminais. **Urgência** — `ServiceOrder.priority === "URGENT"` e só ela.
* **Agregação de OS por cliente** — um `groupBy` por `(customerId, priority)` em `src/lib/operational-map.ts` alimenta a contagem de OS do cliente, `hasUrgentOpenServiceOrder` e o resumo operacional da CTO (`getCtoOperationalSummaries`: `activeCustomerCount · onlineCount · offlineCount · unknownCount · openServiceOrderCount`, derivados).
* **Contagem de portas** — `summarizePortCounts` em `src/lib/cto-read-model.ts`, a mesma do detalhe da CTO.
* **Coordenada** — da CTO: `CTO.latitude/longitude`, escrita só por `updateCto`; do cliente: `CustomerLocation`. A OS herda a do cliente. Sem coordenada → contador, nunca marcador falso.
* **Vista e volta** — `src/lib/map-view-params.ts` (`lat · lng · z · mode · q · sel · layers · cf`) e `src/lib/return-to.ts` (variante `operational-map`, aceita pelo detalhe da CTO, pela OS e pelo cadastro do cliente).
* **Tiles e CSP** — `src/lib/map-tiles.config.mjs`, lido por `next.config.mjs` e pelo TypeScript.
* **Tela** — `src/components/map/`: `OperationalMap` (moldura genérica, sem saber o que é CTO), `MapCanvas` (Leaflet, só por `dynamic(..., { ssr: false })`), `CtoMapLayer` (orquestra camadas, leituras, edição, legenda), `CtoMarkers`, `OperationalMarkers` (cliente e OS), `cto-marker-icon.ts`, `popup-clearance.ts`. Apresentação pura em `src/lib/map-activity-indicator.ts`, `src/lib/customer-presentation.ts` (primeiro nome), `src/lib/connectivity-presentation.ts` e `src/lib/cto-map-presentation.ts`.
* **Testes** — `e2e/operational-map.spec.ts`, `src/tests/operational-map.test.ts`, `src/tests/cto-map*.test.ts`, `src/tests/map-activity-indicator.test.ts`, `src/tests/customer-presentation.test.ts`.

**Continua aberto e é do dono:** CTO e cliente na mesma coordenada exata (PRD §371). **Não existe:** registro de camadas / interface `MapLayer`, clustering, seleção de cliente ou de OS, camada de técnico, qualquer leitura do FiberMap.

**A `CTO-3.1` EXISTE em código** — `GET /api/ctos/map`, `src/lib/cto-map.ts`. É a primeira camada do Mapa Operacional, **sem mapa**: o contrato de dados, onde moram tenancy, teto e `N+1`. Quatro coisas que não se redescobrem: a contagem sai de **`summarizePortCounts`, a MESMA função do detalhe administrativo** — um `GROUP BY` em SQL seria mais rápido e criaria segunda verdade; o recorte que cruza o antimeridiano é **recusado**, porque um `200` vazio faria o mapa concluir que não há caixas na região; `missingLocationCount` é **da empresa, não do recorte**, porque caixa sem coordenada não está em região nenhuma; e o teto existe em **duas** camadas (rota e domínio), com teste próprio para cada — a sabotagem que removeu o do domínio passou por 40 testes porque todos pediam pela rota. Leitura aberta ao **DISPATCHER**, dentro do que o `C-07` previa. **`CTO-3.3` (proximidade Field) e `3.4` (coordenada em campo) não existem.**

**A `CTO-3.2` EXISTE em código** — `/mapa`, `src/components/map/**`, `src/lib/map-config.ts`, `src/lib/map-tiles.config.mjs`, `src/lib/cto-map-presentation.ts`, `GET /api/ctos/map/search` (**movida** para `/api/map/search` na `CTO-3.2.2`), `e2e/operational-map.spec.ts`. É a primeira superfície visual do motor de mapa, com Leaflet + React Leaflet. **Zero migration, zero schema, zero Prisma, zero Dart.** Seis coisas que não se redescobrem: **a CSP bloqueava todo tile** (`img-src 'self' data:`), e por isso o provedor mora num **`.mjs`** que `next.config.mjs` e o TypeScript leem juntos — `next.config.mjs` roda em Node puro e não importa `.ts`, então uma configuração só no `.ts` obrigaria a CSP a repetir o host, e a primeira troca de provedor deixaria a URL certa no `TileLayer` e o host velho na política, com o mapa abrindo **cinza e sem erro nenhum**; **Leaflet entra só por `dynamic(..., { ssr: false })`**, porque ele toca `window` na carga do módulo e um `import` estático derruba o `next build` — verificado no artefato, `grep -rl leaflet .next/server` devolve zero; **a busca é contrato SEPARADO** (teto 10, DTO de cinco campos; hoje em `/api/map/search`), porque ensinar o endpoint do recorte a varrer a carteira transformaria o único teto garantido num teto condicional; o mínimo de dois caracteres da busca conta caracteres **que não são `%` nem `_`**, e isso fecha vetor real — está **medido** que o `contains` do Prisma não escapa curinga, então `%%` casaria com tudo; **o `DISPATCHER` não recebe o botão "Abrir CTO"**, porque `/ctos/[id]` é de `ADMIN` e um botão que redireciona sem explicação é pior que a ausência dele; e **falha de API não pode virar contagem** — o teste de navegador pegou a tela dizendo *"0 CTOs nesta área"* por baixo do aviso de erro. A superfície se chama **Mapa Operacional**, nunca "Mapa de CTOs": as camadas de técnico, cliente e OS entram no mesmo motor, e o nome pela camada faria a segunda nascer como segunda tela.

**A `CTO-3.2.1` estendeu a superfície** — `src/lib/map-view-params.ts`, `src/components/map/cto-marker-icon.ts`, `src/lib/return-to.ts` (variante `operational-map`). Ela nasceu de um defeito que a validação do dono encontrou: **abrir uma CTO pelo mapa e voltar caía em `/ctos`**, e o operador perdia bairro, zoom e contexto. Seis coisas que não se redescobrem: a origem viaja na URL como **caminho puro** na allowlist que já existia, com a vista em parâmetros próprios validados um a um e o destino **remontado** (nada do cliente é ecoado na `href`) — `router.back()` foi recusado porque responde "a página anterior do navegador", que não é "de onde este fluxo veio"; existem **três bases num único `MapContainer`** (`NORMAL` OSM · `SATELLITE` Esri · `HYBRID` = satélite + rótulos CARTO), porque remontar o mapa a cada clique jogaria fora centro e zoom; **o satélite do Esri usa `{z}/{y}/{x}`**, linha antes de coluna — a ordem habitual devolve tiles de outro lugar do planeta, com o mapa parecendo funcionar; `MAP_SATELLITE_ENABLED=false` **remove os dois modos e encolhe a CSP sozinho**, porque o híbrido É o satélite com rótulos; o marcador é uma **caixa óptica em SVG próprio**, idêntica nos quatro estados, com o **selo** carregando forma e glifo; e a vista (centro, zoom, modo, busca, seleção) é espelhada por **`history.replaceState`**, nunca pelo `router` — que trataria cada arrasto como navegação.

**A `CTO-3.2.1b` corrigiu quatro pontos de UX, e três achados dela não se redescobrem.** **A placa "Map data not yet available" do satélite é um `200 image/jpeg`** — uma imagem de 2.521 bytes byte-idêntica em qualquer região e zoom, que o Leaflet desenha porque não tem como saber que não é imagem. A cura é `maxNativeZoom` por camada (**OSM 19 · Esri 18 · CARTO 19**, medidos buscando quatro tiles vizinhos por nível e comparando bytes) mais um `maxZoom` de mapa (20): acima do nativo o Leaflet amplia o último nível real. **O valor do Esri é o pior caso medido de propósito** — ele chega a `z19` só em São Paulo. **Altura de mapa é faixa de leitura, nunca fração de tela**: qualquer unidade de viewport traz de volta o mapa que empurra o resto da página para fora da primeira dobra. E **`leaflet.css` pinta todo `<a>` do mapa com `#0078A8`, vencendo utility do Tailwind por especificidade** — foi assim que o botão "Abrir CTO" ficou azul sobre azul com contraste de 1,05:1, visível e ilegível; qualquer ação futura dentro de um popup precisa de uma regra com especificidade suficiente, e o teste que fecha isso **calcula o contraste**, não afirma presença.

**Dois defeitos que só o navegador encontrou na `CTO-3.2.1`, e os dois valem para qualquer tela futura com Leaflet:** `replaceState(null, …)` **apaga o estado de roteamento do App Router** e o sintoma é um link que não faz nada, sem erro no console — repasse sempre `window.history.state`; e uma prop derivada da câmera chegando aos marcadores fecha um **laço de realimentação** (popup re-renderiza → `autoPan` move o mapa → `moveend` muda a prop), que se manifesta como `Maximum update depth exceeded` e **popup que não abre**. A cura foi ler a vista da barra de endereço e `memo` nos marcadores, com array vazio estável e `onReady` estável.

**A `CTO-3.2.1c` pôs o nome da CTO por cima dela e refez o marcador; quatro coisas dela não se redescobrem.** **A plaqueta é um `Tooltip` `permanent` do react-leaflet, e o nome NUNCA entra no `divIcon`** — `divIcon` recebe HTML cru e o injeta no DOM, enquanto o `Tooltip` renderiza os filhos por portal do React, que escapa texto; qualquer rótulo futuro sobre marcador segue por essa porta. **A densidade é decidida por `MAP_LABEL_MIN_ZOOM = 16`**, medido pela projeção (duas plaquetas de 112px colidem abaixo de `z16,7` a 150 m e de `z15,7` a 300 m), com a caixa **selecionada** rotulada em qualquer zoom; o limiar não evita colisão, evita a **parede** de texto, e esconder rótulo por sobreposição foi recusado por ser regra que o operador não consegue prever. **O que atravessa a fronteira para os marcadores é um BOOLEANO, nunca o zoom** — é a mesma realimentação da `CTO-3.2.1`, e um número reabriria o laço que fez o popup parar de abrir. E **no marcador o defeito era a PROPORÇÃO**: 29 × 21 é deitado e lê como aparelho de mesa; 20 × 27 com cúpula lê como caixa de poste. **Orelhas laterais e dois prensa-cabos separados foram testados e leem como pés** — não voltar a eles. A geometria é exportada em `CTO_MARKER_GEOMETRY` e o SVG é montado a partir dela, para o teste afirmar sobre número em vez de casar expressão regular contra SVG.

**No delta visual da `CTO-3.2.1c`, o CORPO da caixa passou a carregar o estado, e três coisas ficam.** O contorno usa **o mesmo token do selo** (`success-fg`/`warning-fg`/`danger-fg`/`neutral-fg`) — token próprio para o contorno criaria duas fontes de verdade para o mesmo estado. **A inativa apaga a FIGURA e nunca o selo**, e é por isso que o desenho vive num `<g class="cto-box__figure">` com o selo fora dele; ela ganha quatro sinais que não são cor (dessaturação, tracejado exclusivo, selo cheio, e a palavra **INATIVA** na plaqueta — porque "apagado" é vocabulário de controle desabilitado pela interface, e aqui é fato da rede). **Seleção e estado são camadas distintas**: `outline` por fora do ícone para seleção, `stroke` no corpo para estado — se a seleção pintasse o corpo, clicar apagaria a informação que fez clicar. E um fato de CSS que custou uma sabotagem passando: **`opacity` não é herdada, ela COMPÕE** — para afirmar que um filho não apagou, multiplique a opacidade dele até a raiz, porque a leitura direta devolve `1` enquanto o ancestral o apaga na tela.

**A `CTO-3.2.1d` deu ao ADMIN a correção de posição pelo mapa, e cinco coisas dela não se redescobrem.** **Não existe rota nova:** `PATCH /api/ctos/[id]` mandando só `{latitude, longitude}` **já é** a operação estreita — `updateCto` monta `data` campo a campo, então os outros campos nem são lidos; uma rota `/location` seria a segunda autoridade sobre a regra de coordenada. **O marcador é arrastável só em modo de edição declarado** — gravar no `dragend` é o defeito que a fase existe para não cometer. **`dragend`, nunca `drag`**, porque a posição é prop e atualizá-la por quadro reabre o laço `popup → autoPan → moveend → render`; a plaqueta acompanha de graça, porque o Leaflet move o tooltip com o marcador. **Painel de edição vive DENTRO do mapa**: no fluxo da página ele descia o mapa 206px, e o `autoPan` do popup já desloca 138px — medir posição de marcador em teste exige tomar a referência depois disso. E **`updateCto` tem DOIS guardas de tenant** (leitura e `updateMany`), cada um redundante sozinho: só removendo os dois o ataque cruzado passa.

**Armadilha de harness, medida:** rodar a suíte de navegador por mutação **sem limpar `.next`** faz o dev server servir chunk velho e o laço reportar detecção falsa. Limpe `.next` entre sabotagens.

**Decisão aprovada na `CTO-3.2.1` — implementada pela `CTO-3.2.2`, logo abaixo:** camadas `CTOs` (ligada) · `OS abertas` (ligada) · `Clientes` (desligada), cliente com OS aberta destacado, selo de OS abertas por CTO e busca alcançando CTO, cliente e número de OS. O motor continua **sem registro de camadas, sem seletor e sem interface `MapLayer`**.

**A `CTO-3.2.2` completou o Mapa Operacional V1** — `src/lib/operational-map.ts`, `src/lib/map-search.ts`, `src/lib/connectivity-presentation.ts`, `src/lib/service-order-labels.ts`, `src/components/map/OperationalMarkers.tsx`, `GET /api/map/customers`, `/api/map/service-orders`, `/api/map/search`, `GET /api/ctos/[id]/customers`. **Zero migration, zero schema, zero dependência, zero Dart.** Sete coisas que não se redescobrem: **a OS ABERTA é derivada dos estados TERMINAIS**, e não listada — com uma lista de abertos, um estado novo nasceria fechado e invisível, enquanto derivando dos terminais ele nasce aberto e alguém reclama no mesmo dia; **o `N+1` é medido por contagem de consultas**, não por comentário (40 clientes → 1 consulta; lista vazia → zero), e o resumo da CTO foi unido numa consulta só devolvendo `{ summaries, occupiedPortIds }`; **o `DISPATCHER` não recebe a camada de clientes**, e a busca, que é compartilhada, remove os resultados `CUSTOMER` **no servidor**; **o DTO do cliente é afirmado por igualdade de chaves**, porque uma lista de campos proibidos só pega o que alguém já imaginou; **`map-search.ts` é módulo próprio** porque `cto-map` já depende de `operational-map` e uma busca que alcança os dois de dentro de qualquer um fecharia um ciclo; **o marcador da OS nasce na coordenada do CLIENTE**, então os dois ocupam o mesmo pixel e o Leaflet lhes dá o mesmo `z-index` (medido: 239) — sem `zIndexOffset` o popup que abre é o da resposta HTTP que chegou primeiro, e a decisão gravada é que **a OS vence**, porque o popup dela leva ao cliente e o do cliente não levaria à OS; e **o arrasto do ponteiro em teste precisa ser calculado da caixa medida do contêiner** — ele começa em `y=343` e é mais alto que o viewport de 720, então coordenadas fixas caem fora do mapa e fazem três testes passarem sem provar nada.

**O controle de CAMADAS mora DENTRO do mapa, e isso foi medido** *(estado da `CTO-3.2.2`; revertido na `CTO-3.2.2b`, dois parágrafos abaixo)*. Fora dele custava **82px** de altura de página, e a legenda ficava exatamente 82px abaixo da primeira dobra em 1440×900 — quebrando a regra da `CTO-3.2.1b` de que altura de mapa é **faixa de leitura, nunca fração de tela**. Ele fica no canto **esquerdo**, oposto ao seletor de base (`Mapa`/`Satélite`/`Híbrido`, à direita): cantos opostos são o que impede "Satélite" e "Clientes" de parecerem alternativas entre si. Os **avisos por camada** ficaram no fluxo, por razão oposta — mensagem de erro em cima do mapa tapa justamente o que a pessoa está tentando ver.

**Medir posição de marcador em pixels de VIEWPORT não funciona neste mapa**, e a `MAPEDIT` foi reescrita por causa disso. Três coisas quebram a conta, todas medidas: a página rola (41px), o mapa se desloca sozinho no meio de uma sequência de arrastos (a vista mudou de `-20.397441` para `-20.397129` durante o terceiro), e o centro só é reescrito na URL no `moveend` — ler antes disso compara centro velho com marcador novo (25,9px de erro puro). A grandeza certa é **o marcador estar sobre a coordenada gravada**: projete-a em Web Mercator, compare o desvio, e o enquadramento deixa de importar. E o ponteiro **não alcança o que está fora do viewport**: com a altura fixa do mapa mais o `autoPan` do popup, o marcador foi parar em `y=761` com `elementFromPoint` devolvendo NADA — teste de arrasto precisa de janela alta.

**A `CTO-3.2.2b` estabilizou o mapa, e o achado dela é o mais reaproveitável da trilha: o recorte pedido ao servidor NÃO pode ser o viewport cru.** Com `map.getBounds()` puro, o dado vira função do pixel — e o caso comum não é o operador arrastar, é o `autoPan` do popup: clicar numa caixa empurrava a vista 291px, a releitura ia com o recorte novo, a caixa clicada não voltava nele, o marcador era desmontado e **o popup morria junto**, 750ms depois do clique. Era o mesmo defeito por trás de "a CTO abre e some", "os pontos somem no zoom" e "o mapa se mexe sozinho". A cura é `MAP_VIEWPORT_PADDING_RATIO` (0,25 por lado, área 2,25×), e a segunda metade é o TAMANHO do popup: 520px num mapa de 558 forçava o empurrão; com 321px ele caiu para 111px. **Desligar o `autoPan` foi medido e recusado** — o mapa para, e o popup nasce 236px acima da borda, cortado.

**Três armadilhas de TESTE que essa fase deixou registradas.** A prova por sintoma ficou fraca sozinha: depois de encolher o popup, zerar a folga **não derrubava** mais o teste do popup, então existe um teste do CONTRATO (`STAB-04`: o recorte pedido é maior que o visível, por Web Mercator contra centro e zoom da URL). A legenda desenha os **mesmos SVGs** dos marcadores, então `svg.cto-dot` deixou de significar "ponto no mapa" e passou a casar com os símbolos dela — `toHaveCount(3)` recebeu 7; seletor de marcador é do `.leaflet-marker-pane`. E **o zoom do teste é função da altura do mapa**: com a faixa em 400px, uma caixa a 444m do centro cai a 15px do topo em z16 e a plaqueta dela é recortada.

**O controle de camadas mora FORA do canvas, e isso inverteu a decisão da `CTO-3.2.2`.** Dentro, ele cobria os botões `+`/`−` do Leaflet. Fora, custa altura — e a conta foi paga na faixa do mapa, então `320/360/380/400` (era `380/440/500/560`; a faixa atual é a do bloco da `CTO-3.2.2e`). Em 1440×900 o documento fecha em 900px exatos. **A regra que não mudou:** altura de mapa em pixels, nunca fração de tela.

**A `CTO-3.2.2c` deu escala por zoom aos marcadores, e a arquitetura dela é o que não se redescobre.** São TRÊS camadas por marcador: o contêiner do Leaflet (que recebe `translate3d` e a âncora), uma camada de **clique** que não escala, e uma camada de **escala** com o `transform`. Escalar o contêiner sobrescreve o posicionamento do Leaflet e tira o marcador do lugar geográfico; escalar a camada de clique encolhe o alvo junto com o desenho. A escala é **variável CSS** escrita no contêiner do mapa a cada `zoomend` — nenhum marcador é re-renderizado, e é por isso que trocar de zoom não recria ícone, não fecha popup e não custa requisição. Medido: alvo de **30px em qualquer zoom**, com o desenho indo de 68% a 114%. A caixa tem curva própria e reduz menos, para o mapa não perder a referência de infraestrutura de longe.

**Duas medições sobre a camada de clique, e a segunda corrige a primeira.** Com `pointer-events: none` nela, o **ponto do cliente fica inclicável** (`POP-03` cai) e o **arrasto da CTO continua funcionando** (`MAPEDIT` inteira passa) — são comportamentos diferentes. Uma leitura anterior desta fase atribuiu à camada a quebra do arrasto da caixa; a causa real daquela falha era o marcador saindo pela borda de baixo com o mapa em 400px.

**Urgência de OS tem UMA autoridade: `ServiceOrder.priority === "URGENT"`.** `HIGH` é "Alta" e não é urgente. Nada no mapa deduz urgência de tipo, status, título, tempo em aberto ou SLA. O DTO do mapa carrega `priority` desde esta fase; o rótulo do marcador traz o **número do domínio**, nunca o id de banco. **Vermelho tem dois significados** — urgência na OS, `OFFLINE` no cliente — e quem separa são forma, rótulo e dois grupos na legenda, nunca a cor sozinha.

**O cliente mostra o PRIMEIRO NOME no mapa (`CTO-3.2.2d`), e ele vem por `Tooltip`, nunca pelo `divIcon`.** As iniciais da `CTO-3.2.2c` podiam ir no ícone porque `[A-Z]{0,2}` não tem caractere com significado em HTML; um primeiro nome pode conter `<`, `&` ou aspas, e o `Tooltip` renderiza por portal do React, que escapa. `customerFirstName` (`src/lib/customer-presentation.ts`) pula conector de ponta (`de`, `da`, `dos`…) e normaliza a caixa — `ROSELI JESUNO DE SOUZA TEIXEIRA` → `Roseli`. Nome completo só no popup, aberto por ação explícita. `customer-initials.ts` foi removido (sem consumidor).

**Cada família de rótulo tem uma DIREÇÃO, e no mesmo ponto elas não se cruzam:** caixa ACIMA, OS à DIREITA, cliente à ESQUERDA. A OS herda a coordenada do cliente, e com os dois à direita o nome e o número nasciam a **1px** um do outro (medido). Abaixo foi descartado pela conta: a plaqueta da caixa sobe 59px, e um cliente 80m ao norte a cruzaria. Colisão entre pontos DIFERENTES e próximos continua sendo densidade (limite da `CTO-3.2.1c`). As caudas `::before` de `right`/`left` são repintadas com `--surface` — a padrão do Leaflet é branca e aparece no tema escuro.

**O popup da OS pousa FORA dos controles do mapa**, por `autoPanPaddingTopLeft = [52, 50]`. Os controles ficam acima dos painéis do Leaflet, e um popup embaixo deles perde cabeçalho e "×" — foi o que a prova de borda achou (o seletor de base interceptava o "×" na borda direita). Topo ≥ 50 limpa o seletor (termina em 42), esquerda ≥ 52 limpa o zoom (termina em 44); um topo de 82 limparia os dois sozinho e não caberia no mapa de 320px. **O popup da CAIXA não foi mudado** nessa fase (fora do escopo, aprovado pelo dono) — e passou a ler a mesma constante na `CTO-3.2.2e`, abaixo.

**O `Esc` do Leaflet NÃO fecha popup depois de um clique em marcador:** o handler de teclado só é ligado com o foco no CONTÊINER, e o marcador (`tabindex=0`) toma o foco. Teste fecha pelo "×", como a pessoa.

**Três armadilhas de medição da `CTO-3.2.2d`.** (1) **"Parou" pela URL não cobre animação:** ela muda no `moveend`, no FIM do empurrão — duas leituras iguais logo depois do clique são duas leituras da vista velha (medido: 9px de popup ainda andando; 185px de "erro" num Cancelar que estava certo). Espere o **objeto** parar (três leituras iguais), ou faça `poll` da URL. (2) **`getBoundingClientRect` de `<circle>` inclui o traço** — o disco de 14px mede 15,5. (3) **Rótulos moram no painel de TOOLTIPS**, não no de marcadores: uma asserção de privacidade sobre `.leaflet-marker-pane` nunca vê nome vazado; use `.leaflet-map-pane`.

**A `CTO-3.2.2e` fechou a UX do Mapa Operacional, e cinco causas-raiz dela não se redescobrem.** (1) **O flicker eram DOIS indicadores:** `OperationalMap` desenhava "Carregando CTOs…" sem atraso (medido: ~80 ms de vida por arrasto) ao lado do "Atualizando mapa…" da camada, que tinha atraso e nunca aparecia. Ficou um só, da camada, com cadência em função pura (`src/lib/map-activity-indicator.ts`: 250 ms para aparecer, 300 ms mínimo na tela) — o pedido sai na hora, só o aviso espera. (2) **O espaço vazio dos popups era `.leaflet-popup-content p { margin: 1.3em 0 }`**, mais específico que o reset do Tailwind e que qualquer `mt-*`: nome da CTO a 31 px do topo, cabeçalho da OS com 104 px, conectividade da OS FORA da área rolável. Reset escopado a `.cto-map-popup--compacto`, e os popups compactos não usam `<p>` com margem; o popup do cliente ficou como o dono aprovou. CTO 321 → 229 px; OS mostra tudo sem rolar. (3) **Os dois popups leem a MESMA constante de respiro** (`popup-clearance.ts`, `[52, 50]`/`[24, 24]`): a geometria dos controles é do mapa, não de uma camada. (4) **A caixa "lá embaixo" na edição vinha do `autoPan` do popup**, que empurra o marcador para o rodapé para o popup caber acima; entrar em edição chama `panInside` com respiros medidos (topo 106, esquerda 64, direita 40, base 48) e um retângulo a evitar (o painel, 332 × 250) — move o mínimo, só se precisar, e nunca grava. (5) **A altura do mapa ganhou um degrau por altura de janela**: 410 no desktop comum (em 720 de altura, com clientes ligados, é o teto: o mapa termina a 1 px da dobra) e 440 com `[@media(min-width:1024px) and (min-height:860px)]` — o maior que deixa resumo e legenda inteiros na dobra de 900 com as três camadas (legenda em 895; a `LAYER-21` guarda isso). Pixels, discreto, e a regra "nenhuma unidade de viewport" continua. 460 custaria 15 px de legenda fora da dobra: decisão do dono, não tomada.

**Urgência no cliente sai da MESMA consulta:** o `groupBy` de OS abertas agrupa por cliente **e** prioridade, e `hasUrgentOpenServiceOrder` é "há grupo `URGENT` entre os abertos" — zero consulta a mais (medido: oito clientes, um `groupBy`). No desenho é sinal ADICIONAL: anel vermelho no lugar do âmbar (nunca os dois) e selo `!` fora do disco; o miolo não muda e nada anima. "Sem leitura" ganhou halo, preenchimento claro, contorno tracejado escuro e centro — quatro sinais, contraste ≥ 7:1 nos dois temas, mesma área aparente (razão 1,04).

**Armadilha de medição registrada:** `esperarMapaParar` pela URL sai no meio de um `panInside`/`autoPan` (a URL só muda no `moveend`); quem prova que parou é o próprio marcador — três leituras iguais. E a "cadência" de um indicador só se prova com cronômetro no navegador (`performance.now()` no `MutationObserver`), nunca com `toBeVisible`.

**Aberto para o dono na `CTO-3.2.2`, e NÃO decidido:** quando uma caixa e um cliente ocupam **exatamente** a mesma coordenada, qual popup abre. O par cliente↔OS é estrutural (a OS herda a coordenada do cliente) e foi resolvido; CTO↔cliente exige igualdade exata, que é construção de fixture e não condição de dado real — decidir em silêncio seria escolher produto por omissão.

**Divergência de nome, declarada:** o enunciado da `CTO-3.2.1` cita `/mapa-operacional`; a rota real, validada pelo dono, é **`/mapa`** — renomear depois da validação quebraria links salvos sem mudar nada para quem usa.

**O placeholder *"Mapa Operacional — EM BREVE"* está no FIELD**, em `apps/field/lib/app/widgets/app_drawer.dart`, com `route == null` — a web nunca teve entrada de mapa. A `CTO-3.2` criou a da web e **não tocou no Field**: o mapa dele é outra fatia, e a §339 já decidiu que lá a proximidade **ordena a lista, não desenha mapa**.

**O discovery da `CTO-3` registrou uma DIVERGÊNCIA, hoje RESOLVIDA pelo dono: motor de mapa compartilhado, camada de CTO primeiro; Leaflet + React Leaflet aprovados para a `3.2`, com o provedor de tiles configurável.** O PRD §339 diz que *"a CTO é entidade do Mapa Operacional (§136), que não existe; CTO-3 depende dele"*, e a §136 é o mapa do DESPACHO — técnicos, clientes e OS —, não um mapa de CTOs. Construir um mapa só de CTOs criaria a segunda superfície que a §207 evita. Recomendação registrada em §33: motor de mapa **agnóstico de camada**, com a camada de CTO primeiro. Três fatos do inventário que poupam a próxima sessão: **não existe biblioteca de mapa** nem consulta por bounding box em lugar nenhum do repositório; **`TechnicianLocation` não existe**; e no Field a §339 já decidiu que proximidade **ordena a lista, não escolhe** — a primeira entrega lá é ordenação, não mapa, e falta apenas a coordenada no DTO, que a `CTO-2.4` omite de propósito. A fonte da verdade da coordenada da caixa **já está decidida em código**: `CTO.latitude/longitude`.

**A `CTO-2` está DONE: `CTO-2.7` `APPROVED`, com validação do dono `PASS` em 2026-09-09.** Os onze passos do roteiro passaram na interface real sobre `CTO QA FIELD 01`, incluindo as três regras que a `CTO-2.6` acrescentou — `RESERVED` recusado em porta ocupada e as duas reduções de capacidade recusadas. **Sem tag e sem push.** `CTO-3`, `CTO-5`, `CTO-6` e `CTO-7` continuam sob a §119. Fase de validação, com **zero diff de produção**: onze dos quinze critérios de aceite pertencem ao `CTO-2` e estão rastreados (matriz em `docs/CTO-NETWORK-DISTRIBUTION.md` §32), e os outros quatro são de `CTO-3`/`CTO-5`/`CTO-7`, que não existem em código. A única lacuna encontrada era de **cobertura, não de comportamento**: o invariante "o vínculo não pertence ao ciclo de vida da OS" era estruturalmente verdadeiro — único escritor, zero `delete` em produção, FK `SetNull` — e não tinha teste. Duas medições que não se redescobrem: removendo o pré-check de porta ocupada as **corridas continuam passando**, porque o índice parcial segura a integridade e o que cai é o `409` limpo do caso sequencial; e a sabotagem de TOCTOU é detectada sempre por `RACE-04` e só em metade das vezes por `RACE-02`, porque o caminho pré-lock do `MOVE` é mais longo. **A UI Web não tem tela de histórico de vínculo** — `getCustomerNetworkView.history` existe e não tem consumidor de tela; é decisão, não defeito.

**A `CTO-2.6` EXISTE em código** — duas regras em `src/lib/cto.ts`, e o diff de produção é esse arquivo só. `RESERVED` é proibido enquanto há vínculo ativo, e a regra é sobre o **ALVO**: "porta ocupada não muda de estado" criaria beco sem saída — porta consertada nunca voltaria a `AVAILABLE`, e a linha legada `ativa + RESERVED` ficaria presa. `DAMAGED` com cliente ligado continua permitido, porque o cabo quebra com o cliente conectado. Redução de capacidade com cliente acima do novo limite recusa, sem desconectar, mover ou apagar nada. **As duas consultas vêm DEPOIS do `FOR UPDATE` da CTO** — mesmo `lockCto` da `CTO-1`, nenhum lock novo —, e é o lugar que fecha as corridas com `CONNECT`/`MOVE`. O que não se redescobre: as corridas da primeira versão **passavam com a regra removida**, porque a administrativa sempre vencia o lock; elas só provam alguma coisa rodando nas DUAS ordens. E o `companyId` dessas consultas é defesa em profundidade — removê-lo não derruba teste nenhum, porque o `ctoPortId` já foi provado da empresa.

**A `CTO-2.5` EXISTE em código** — `apps/field/lib/features/network/` e uma linha em `order_detail_screen.dart`. A rede é **seção da OS**, não destino da barra: o técnico não navega pela rede da empresa, ele atende um cliente. Quatro coisas que não se redescobrem lendo o diff: fora de `IN_PROGRESS` a seção **nem lê** (a leitura da `CTO-2.4` também exige atendimento, e chamar daria 409 garantido — há teste afirmando zero requisições); `effectiveState` **não existe** no modelo Dart, para que `DAMAGED` não suma numa porta ocupada; as três mutações são **ONLINE ONLY**, provado por teste que lê o CÓDIGO do módulo e exige zero `PendingOperation`; e a chave de idempotência inclui o **destino**, senão o técnico que trocasse de porta reapresentaria a chave e levaria `IDEMPOTENCY_CONFLICT` numa operação legítima. **Sem mapa, sem QR, sem edição administrativa de porta.** Falta o **piloto físico**. `CTO-2.6` continua pendente.

**A `CTO-2.4` EXISTE em código** — `src/lib/field/cto.ts` e as seis rotas em `src/app/api/field/v1/service-orders/[id]/network/`. O técnico opera a rede **através de uma OS `IN_PROGRESS` que é dele**, e quatro coisas dela não se redescobrem lendo o diff: **`customerId` não é campo de payload** — ele vem da OS, e é por não haver campo que "OS legítima usada para mexer em outro cliente" deixa de existir; a autorização roda **dentro** da transação do domínio (`ConnectionContext.authorizeWithin`), senão a OS poderia ser concluída entre a conferência e a escrita e o evento nasceria depois do fechamento; a **leitura também exige `IN_PROGRESS`**, divergindo de `../diagnostic` de propósito, porque o que ela abre é a rede da EMPRESA e não o cliente da OS; e o DTO **não tem `effectiveState`**, que colapsaria `DAMAGED` numa porta ocupada. Medido por reversão, não suposto: a **escrita tem posse em dois portões e a leitura em um** — remover só o externo derruba a leitura e não a escrita. **Continua sem Flutter: `CTO-2.5` é a tela, `CTO-2.6` a integração de capacidade/estado.**

**A `CTO-2.1`, a `CTO-2.2` e a `CTO-2.3` EXISTEM em código.** A `2.3` foi **validada manualmente pelo dono** e endurecida em dois patches, ambos da mesma família: confirmação que não se anunciava, e confirmação que existia **fora da viewport** (`viewport ratio 0`) — a `CTO-1.3` num lugar novo. Toda confirmação de porta aparece hoje **na linha em que se clicou**, como selo ao lado dos botões: `w-full` ali crescia a lista e empurrava a seção de capacidade para fora da tela, derrubando um teste da `CTO-1.5`. **Uma confirmação não pode expulsar da tela a recusa de outra operação.** A `2.3` é a tela: vincular, mover e desconectar pelo painel do ADMIN (`src/app/(app)/ctos/[id]/PortConnectionPanel.tsx`). Duas coisas dela que não se redescobrem: o **conflito fecha o diálogo e a mensagem sobe para a PÁGINA**, porque a releitura remove a premissa da caixa aberta e uma mensagem presa lá dentro sumiria junto — recusa invisível é indistinguível de botão quebrado; e **mover nunca é desconectar+conectar** em duas requisições, o que abriria janela sem vínculo. Prova disso é a HISTÓRIA AUDITADA, não a contagem de linhas: as duas formas produzem duas linhas, e só uma delas registra `MOVED`. **Continua sem Field e sem Flutter.**

**A `CTO-2.1` e a `CTO-2.2` EXISTEM em código.** A `2.2` acrescentou a API administrativa (`/api/cto-connections`, `src/lib/cto-read-model.ts`) e as **duas dimensões** no detalhe da CTO: `administrativeState` e `occupied` são independentes, o resumo conta por `administrativeState`, e `free + reserved + damaged + occupied` **pode passar de `capacity`** — quem apresentar as quatro como fatias de um todo estará errado. O `:id` da rota **é** a guarda de obsolescência: `disconnect` e `move` exigem `expectedConnectionId`, senão uma tela velha encerra um vínculo que ninguém viu. **Continua sem UI e sem Field.**

**A `CTO-2.1` EXISTE em código** — `src/lib/cto-connections.ts`, migration `20260907214839`, e os testes `cto-connections*.test.ts`. **Sem rota, sem tela, sem Field**: o domínio não é alcançável por usuário nenhum, e `CTO-2.2` em diante não existe. Três coisas que as sabotagens mediram e que não se deduzem do desenho: a unique parcial de porta **não** é o que faz a corrida de dois clientes passar (o pré-check dentro do `lockCto` já serializa — o índice pega quem NÃO passa pelo serviço, provado por INSERT direto); o lock de cliente é hoje sobretudo o **portão de tenant**, e removê-lo derruba o teste de tenancy, não os de concorrência; e o teste de ordem de lock precisou de **seis rodadas**, porque com uma só a sabotagem passava em 1 de 20 vezes.

**O domínio foi CONGELADO antes** — `docs/CTO-NETWORK-DISTRIBUTION.md` §24. Três coisas dele que não se redescobrem: **`source` é `FIELD · WEB`** (a decisão antiga de `FIELD`-only foi superada pelo dono; `IMPORT` caiu por não ter caso de uso); **porta com vínculo ativo aceita `AVAILABLE` e `DAMAGED`, nunca `RESERVED`** — e a regra é sobre o ALVO, para que `active + DAMAGED` possa voltar a `AVAILABLE`; e **o contador de danificadas mente hoje**, porque `effectivePortState` colapsa em `OCCUPIED` e o resumo conta por `effectiveState` — a `CTO-2.2` precisa contar por `administrativeState`, senão uma porta quebrada com cliente dentro some da tela.

**Quando:** a tarefa envolve CTO, porta óptica, vínculo do cliente à rede de distribuição ou o status na visão da caixa.
**Quando NÃO:** qualquer outra coisa. `CTO-1` a `CTO-2.7` e `CTO-3.1` a `CTO-3.2.2e` existem em código — o mapa web é o Mapa Operacional V1, **FROZEN** (PRD §392); `CTO-3.3`/`3.4` (proximidade e coordenada em campo), `CTO-6` (frescor de diagnóstico) e `CTO-7` (QR) seguem sob a §119.

**Código da `CTO-1`:** `src/lib/cto.ts` (domínio), `src/lib/cto-access.ts` (o portão de autorização), `src/lib/media/image-upload.ts` (fronteira de upload, compartilhada com evidência e assinatura), `src/app/api/ctos/**`, `src/app/(app)/ctos/**`, `src/tests/cto.test.ts`, `src/tests/cto-routes.test.ts`, `src/tests/cto-photo-bytes.test.ts`, `e2e/ctos.spec.ts`. Registro em `docs/CTO-NETWORK-DISTRIBUTION.md` §20–§22 e `docs/SECURITY.md` §8.19.

**Fixture de imagem: escolha o certo.** `src/tests/support/jpeg-exif.ts` monta um JPEG que o servidor aceita e **nenhum navegador abre** — ele existe para afirmar sobre EXIF, e o docstring sempre disse que não precisava ser decodificável. Isso deixou de bastar quando a `CTO-1.7` acrescentou o preview, o primeiro consumidor que **decodifica**: para qualquer afirmação sobre a imagem ABRIR, use `montarPngReal` (`src/tests/support/png-real.ts`) ou pinte uma no navegador com `canvas.toDataURL`. E **nunca** envie o fixture de EXIF a um ambiente onde alguém vai olhar a tela — foi assim que a `CTO-1.8` nasceu.

**O que a `CTO-1` NÃO trouxe:** `CustomerNetworkConnection`, vínculo cliente↔porta, qualquer superfície no Field, mapa, status `ONLINE/OFFLINE` e QR. `ServiceOrder` e `Customer` não foram tocados. Sequência ativa daqui: `CTO-2 → CTO-4 → CTO-5`; `CTO-3` segue bloqueada pelo Mapa Operacional, `CTO-6` por estratégia de frescor, `CTO-7` é opcional.

**Três coisas da `CTO-1` que a `CTO-2` precisa herdar, não reinventar:** o portão é `requireCtoAccess` (a ordem sessão → **capability** → perfil não é estética: capability depois do perfil faz um `DISPATCHER` de empresa sem o módulo receber 403, que confirma a existência dele); são **dois** predicados e trocá-los quebra a tela — `isPortWithinCapacity` responde só a faixa `1..capacity` e autoriza a mutação administrativa, enquanto `isPortOfferable` a consome e acrescenta `AVAILABLE`, respondendo se a porta pode receber um cliente (é ele que a `CTO-2` chama **na transação que escreve**, `R-13`); usar a ofertabilidade como autorização congelaria toda porta reservada, que precisa continuar podendo ser liberada. **Porta fora da capacidade é histórica e read-only** (`CTO-1.9`): a redução preserva as linhas e nada mais as toca até a capacidade voltar; e toda operação que decide olhando o conjunto de portas trava a **CTO** com `FOR UPDATE` — foi uma corrida entre mudar o estado de uma porta e reduzir a capacidade que impôs isso.

Cinco coisas que a `CTO-0.1` congelou e não devem ser reabertas em silêncio (§16 e §17 da especificação):

* **Ocupação é DERIVADA, nunca persistida.** `CTOPort.administrativeState` tem três valores — `AVAILABLE · RESERVED · DAMAGED` —, e `OCCUPIED` **não é gravável**. A versão anterior do documento listava quatro estados incluindo `OCUPADA` enquanto a seção seguinte recusava exatamente isso; a contradição foi resolvida a favor de uma fonte só.
* **São DUAS uniques parciais.** `(ctoPortId)` e **`(customerId)`**, ambas `WHERE disconnectedAt IS NULL`. A segunda faltava, e sem ela `CTO-AC05` era promessa sem mecanismo.
* **`Company.ctoNetworkEnabled`, default `false`** — coluna, não framework de feature flag; o precedente é `pppoePasswordPolicy`/`timezone`. **Capability não é permissão**, e as duas são verificadas em toda rota.
* **Sem `equipmentId` no vínculo** (`C-05`): `ServiceOrderEquipment` é linha por OS, e série/MAC são opcionais desde a v0.10 — não existe identidade estável de equipamento fora da OS.
* **A foto da CTO não ganha um terceiro `stripImageMetadata`.** A `CTO-1` extrai a fronteira comum de upload e converte os dois pontos existentes antes de acrescentar consumidor — foi um ponto novo nascendo fora da política que criou o `EXIF-01`.

Dois riscos que o contrato **não** fecha e a implementação não pode errar: tenancy cruzada entre as quatro FKs do vínculo (`R-02`, com precedente explorado na `DQ-7.1`) e porta histórica acima da capacidade continuar sendo `ctoPortId` válido (`R-13`) — a faixa `1..capacity` é regra de **escrita**, não de listagem.

## Field Notification Foundation — PUBLICADA em `v0.13`, piloto físico PASSED

**Carregar:** `docs/FIELD-NOTIFICATIONS.md` (plano — inventário do que já existe, arquitetura, escolha de SDK, ciclo do token, payload, deep link, fases `NF-1`–`NF-7`, testes, plano adversarial, decisões `NP-01`–`NP-05`) e PRD §153–§157. Código: `src/lib/push/provider.ts`, `src/lib/outbox.ts`, `src/lib/outbox-handlers.ts`, `src/lib/notifications.ts`, `scripts/outbox-worker.ts`, `src/lib/field/devices.ts`.

**Servidor pronto (`NF-1`), aparelho preparado (`NF-2`), token registrado (`NF-3`), deep link do toque (`NF-4`) e piloto físico aprovado (`NF-5`).** O push chega ao aparelho e o toque abre a OS. O piloto encontrou dois defeitos que 400 testes verdes não viam — a permissão que nunca era pedida e o sino que não atualizava no cold start —, e ambos foram corrigidos. O `google-services.json` continua fora do Git e é pendência de configuração do operador, não de código.

**O parser de payload é `PushDestination` (`core/push/push_destination.dart`), e ele é ALLOWLIST** — `type` + `resourceType` + formato do `resourceId` (`^[A-Za-z0-9_-]{1,64}$`). Nenhum listener consulta `data['type']` por conta própria. A validação do identificador é **segurança**: ele preenche UM segmento de `/orders/:id`, e sem ela `resourceId = "abc/execucao"` faria o payload ESCOLHER a tela. A central de notificações usa o mesmo parser.

**Push indica destino; não autoriza.** A tela de detalhe busca a OS pelo caminho autenticado, e `getFieldServiceOrder` filtra por `companyId` E `technicianId` — OS reatribuída e OS de outra empresa dão 404, com controle positivo em `src/tests/field-push-deeplink.test.ts`.

**Três estados, e "chegou" ≠ "tocou":** `getInitialMessage` e `onMessageOpenedApp` navegam (é intenção da pessoa); `onMessage` **nunca navega** — atualiza fila, lista de OS e contagem do sino, e nada mais.

**Armadilha registrada (`NF-4` §27.5):** o `routerProvider` é recriado a cada troca de fase, e o destino pendente é consumido exatamente nessa troca. Empilhar rota ali acerta um `GoRouter` cujo delegate ainda não foi anexado, e o empilhamento é DESCARTADO em silêncio. A navegação vai por `addPostFrameCallback` + `ensureVisualUpdate`. Todos os testes de unidade passavam com o defeito vivo, porque injetam roteador falso — quem o pegou foi `test/widget/push_deeplink_route_test.dart`, com o `GoRouter` real.

Código: no servidor, `src/lib/push/fcm.ts` (provider e mapper de erro) e `src/lib/push/bootstrap.ts` (a escolha, uma vez por processo). No aplicativo, `apps/field/lib/core/push/` — `field_push_service.dart` (a costura e a implementação Firebase), `push_coordinator.dart` (quando perguntar **e para onde o token vai**), `push_prompt_memory.dart` e `push_permission_sheet.dart`.

**O `PushCoordinator` é a ÚNICA costura de push do aplicativo** (`NF-3`). Ele recebe um `PushTokenSink` — uma função, não o repositório — e o `SessionController` liga e desliga o registro por **um** ponto, o `_apply`. Não criar `PushTokenManager`, `DevicePushManager` nem equivalente: duas costuras para a mesma coisa divergem no primeiro logout. O `PushRegistrationService` citado em textos antigos **não existe**; o `NF-2` o removeu por ser inerte.

**A assimetria entre ligar e desligar é regra, não estilo:** `startSession()` **não é esperado** (com `await`, o `login()` nunca retorna em ambiente sem Firebase — `Firebase.initializeApp()` não completa em teste de widget e pode não completar num aparelho sem Google Play), e `stopSession()` **é esperado**, porque é ele que garante a ordem "registro em voo termina antes de o logout limpar o servidor". Pelo mesmo motivo, o `cancel()` da assinatura **não é esperado**: é chamada de canal nativo que pode não responder, e esperá-la pendurava o `logout()`.

**O Field compila SEM o `google-services.json`**, e isso é deliberado: o plugin `com.google.gms.google-services` falha o build quando o arquivo falta, então ele é aplicado **condicionalmente** em `android/app/build.gradle.kts`. Sem o arquivo o push fica `unavailable`; com ele, funciona. **Não versionar o arquivo** — o `.gitignore` já o cobre.

**`unavailable` não é `denied`**: um é ausência de infraestrutura, o outro é decisão da pessoa, e colapsá-los faria a tela dizer "você recusou" para quem nunca foi perguntado. E a permissão é pedida **uma vez, depois do primeiro login**, com contexto — no Android a recusa é lembrada, e perguntar cedo demais gasta a única boa chance.

O levantamento do `NF-0` verificou arquivo por arquivo, e continua valendo:

* **O vertical slice `SERVICE_ORDER_ASSIGNED` já é completo no backend.** `assignTechnician` grava `ServiceOrder` + `Notification` + `OutboxEvent` na **mesma transação**; o worker reivindica com lease e backoff; o handler relê a notificação filtrando por `companyId`, busca os aparelhos `ACTIVE`/`revokedAt: null`/`pushToken != null`, envia, e limpa **só o `pushToken`** dos recusados — sem revogar o aparelho.
* **`MobileDevice.pushToken` já existe**, e `POST /devices/register` e `POST /auth/login` já o aceitam. **Nenhuma migration é necessária em `NF-1`–`NF-5`.**
* **A abstração de provider já existe** (`PushNotificationProvider`, `PushMessage`, `PushDeliveryResult`), com `NoopPushProvider` que devolve `delivered: 0` — ele **não finge entrega**, de propósito. `setPushProvider` é a costura que os testes já usam.
* **A central de notificações é real**: `GET /api/field/v1/notifications`, e o sino do Field consome o estado verdadeiro. Não é placeholder.
* **Falta**: o piloto físico (`NF-5`). Envio do token (`NF-3`) e deep link do toque (`NF-4`) foram entregues.

**Três regras da `NF-3` que não podem ser desfeitas:** `pushToken: null` **nunca** é enviado pelo aplicativo (o contrato do servidor lê isso como revogação, e o provedor devolve `null` por motivo banal); **permissão negada não registra** (no Android o `getToken()` responde mesmo sem permissão, e registrar faria `pushToken != null` significar "existe endereço" em vez de "dá para avisar esta pessoa"); e o registro **solta o token de qualquer outra linha da mesma empresa**, porque um token endereça UMA instalação — o par que divide o aparelho da empresa, com um `logout` que não alcançou o servidor, receberia a notificação do outro. A limpeza para no tenant, e a janela residual está declarada em `SECURITY.md` §8.13.

**Um defeito latente, encontrado no `NF-0` e CORRIGIDO no `NF-1`:** `logoutField` zerava `tokenHash` e **não limpava `pushToken`**, mantendo `status: ACTIVE`. O predicado do handler é exatamente `ACTIVE + revokedAt null + pushToken != null`, então o aparelho de onde o técnico saiu continuava sendo alvo do push do usuário **anterior** — e o token é da instalação, não da pessoa, então o técnico SEGUINTE no mesmo aparelho leria a notificação do primeiro. Era inócuo enquanto o Noop não entregava; viraria vazamento entre contas no dia do FCM. Agora o logout limpa o `pushToken` **sem revogar**, para o próximo login do mesmo aparelho continuar funcionando — três testes `LOGOUT-PUSH-*` e uma prova de reversão sustentam isso.

**A escolha de SDK depende de um fato do grafo de imports:** `outbox-handlers.ts` é alcançado só por `scripts/outbox-worker.ts` e pelos testes — **nenhuma rota do Next**. Por isso `firebase-admin` fica confinado ao worker, e a credencial de serviço nunca existe no runtime web. Se algum dia uma rota importar esse arquivo, a decisão precisa ser reavaliada, não herdada em silêncio.

**Quando:** a tarefa envolve push, FCM, token de aparelho, outbox de notificação, deep link vindo de notificação, ou permissão de notificação no Android.
**Quando NÃO:** notificação do painel web (outro assunto) ou qualquer coisa que não atravesse o provider. **`NF-1` a `NF-4` estão entregues; `NF-5` (piloto físico) não foi iniciada, e `NF-6`/`NF-7` seguem `FUTURO`.**

## Colaboração entre Técnicos — PLANNED, nada em código

**Carregar:** `docs/FIELD-COLLABORATION.md` (especificação técnica — ciclo do convite, matriz de permissão, concorrência, opções de modelagem, fases `COL-1`–`COL-9`, aceite `COL-AC01`–`COL-AC15`, decisões abertas `COL-01`–`COL-07`) e PRD §342–§351 (visão, invariantes `I-C01`–`I-C12`, roadmap). Para entender a superfície que ela estende, também `src/lib/service-order-child-mutation.ts` e `loadOwnedServiceOrder` em `src/lib/service-orders.ts`.

**A distinção que a especificação inteira sustenta:** **colaborar acrescenta participante SEM trocar o responsável; transferir troca o responsável** e por isso mexe na fila de despacho. Os dois nunca são sinônimos, e "repasse" não é palavra desta capability — ela sugere que a OS mudou de dono, que é exatamente o que a colaboração não faz.

Cinco achados do código real que a §4 registrou e que decidem o custo das fases:

* **A posse tem UM portão.** Toda mutação-filha (evidência, material, equipamento, assinatura, checklist, impedimento) passa por `loadInProgressOwnedOrder` → `loadOwnedServiceOrder`, que recusa quando `order.technicianId !== technician.id`. A permissão do colaborador se resolve **estendendo um predicado**, não espalhando verificações — e errar essa única função erra todas as escritas de uma vez.
* **A autoria já existe em cinco superfícies e falta em duas.** `ServiceOrderEvent`, `ServiceOrderEvidence`, `ServiceOrderMaterialUsage`, `ServiceOrderSignature` e `AuditLog` já gravam o autor; **`ServiceOrderExecution` e `ServiceOrderEquipment` não**. A `Execution` é registro **único por OS**, então dois técnicos no mesmo diagnóstico não são duas linhas — é decisão de arquitetura, não detalhe (`COL-6`).
* **A fila já PROÍBE a OS em duas filas.** `TechnicianDispatchQueueEntry.serviceOrderId` é `@unique` global, então `COL-AC03` é **estrutural** e não depende de alguém lembrar dele.
* **O `409` de `expectedVersion` deixa de ser raro.** Com dois participantes escrevendo, o CAS de `claimOrderForChildMutation` passa a disparar em uso normal — é o mecanismo funcionando, e o Field precisa tratá-lo como recarregar-e-tentar, não como erro.
* **Não existe tabela genérica de capability.** O precedente é coluna de política em `Company` (`pppoePasswordPolicy`, `timezone`); as `capabilities` do `GET /me` do Field são derivadas e não-autoritativas.

**Modelagem recomendada (§19 do documento):** manter `ServiceOrder.technicianId` como responsável e acrescentar relação própria de colaboração. A alternativa uniforme (`ServiceOrderParticipant` com role) exigiria refatorar a fila de despacho inteira, o predicado de posse de todas as mutações-filhas, a atribuição e a listagem do Field — a superfície mais testada e mais recentemente auditada do projeto — sem ganho operacional para quem está em campo.

**Quando:** a tarefa envolve colaboração entre técnicos, convite/aceite, permissões do colaborador, autoria por participante, ou a distinção entre colaborar e transferir responsabilidade.
**Quando NÃO:** reatribuição administrativa comum (isso é a Fila Operacional, entrada própria), execução do técnico responsável sozinho, ou qualquer coisa que não tenha dois participantes. **Nada disso existe em código**, e a §119 se aplica: escrever a especificação não a promove na ordem.

## Contatos do cliente — PLANNED

**Carregar:** `docs/PRD.md` §247–§249 — múltiplos contatos, correção em campo, precedência ERP × campo e painel de qualidade cadastral.
**Quando:** a tarefa envolve telefone, WhatsApp, contato alternativo ou confirmação de dado cadastral pelo técnico.
**Quando NÃO:** endereço e coordenada — isso é `CustomerLocation` (§133–§139, §197), já implementado.

**O que JÁ existe:** `Customer.phone`, `Customer.secondaryPhone` e `Customer.email` — campos soltos, sem tipo, sem procedência, sem histórico. **Não existe** `CustomerContact`, correção em campo nem trilha de alteração.

A precedência é a mesma da localização (§197): **contato confirmado em campo não é destruído por importação automática posterior**. E não existe endpoint de escrita no ReceitaNet — a divergência fica registrada no AlfaOS (§248).

## Design system e temas

**Carregar:** `src/app/globals.css` (os tokens) e `tailwind.config.ts` (como eles viram classe). `docs/PRD.md` §149 registra as decisões; `docs/SECURITY.md` §8.10, a allowlist.
**Quando:** a tarefa toca cor, contraste, tema, ou adiciona componente visual novo.
**Quando NÃO:** lógica de domínio, integração, backend.

Regra que evita o problema que o sistema existe para resolver: **não escrever cor de paleta direto no componente** (`bg-white`, `text-slate-900`, `bg-red-50`). Use o token semântico. Cor crua não tem contraparte no outro tema, e a divergência só aparece quando alguém troca de tema. O codebase tem **zero** utilitário de cor crua hoje — a única exceção deliberada é `SignatureCanvas`, que fixa branco e tinta escura porque produz uma imagem renderizada fora do aplicativo.

Estado operacional usa `StatusPill`, com ponto e rótulo: **cor nunca é o único sinal**.

## Experiência do técnico e design system

**Carregar:** `docs/PRD.md` §145–§149 — prioridade de informação na tela do técnico, apresentação do diagnóstico, separação de administração por papel, navegação contextual (`returnTo`) e o sistema de temas claro/escuro/sistema.
**Quando:** a tarefa muda a tela do técnico, decide o que aparece ou some por papel, mexe em navegação entre OS e cadastro, ou toca cor, token de design e tema.
**Quando NÃO:** backend sem superfície visível, integração, ou qualquer módulo sem UI. Para a regra de autorização por trás do que a tela esconde, o documento é `docs/SECURITY.md` — **esconder botão é UX, não controle de acesso**.

Nada de §145–§149 está implementado além do que a v0.7.2 já entregou em PPPoE e telefones; é requisito registrado, e a §119 se aplica.

## Quando usar Context7

Usar Context7 quando a tarefa depender de documentação externa atual de bibliotecas/frameworks, por exemplo: Next.js, React, Prisma, Playwright, Tailwind, Flutter no futuro, SDKs/APIs externos, bibliotecas adicionadas ao projeto.

Especialmente quando: a API pode ter mudado; a sintaxe depende da versão atual; houver dúvida sobre comportamento oficial; for necessário confirmar boas práticas da biblioteca.

## Quando NÃO usar Context7

Não usar Context7 para: descobrir como o AlfaOS funciona; regras de negócio internas; multi-tenancy do AlfaOS; arquitetura própria; ServiceOrder; Technician ownership; decisões registradas no PRD; histórico Git; segurança específica do AlfaOS.

Para isso usar: `CLAUDE.md` → CONTEXT-MAP → documentação modular → código/Git → skills AlfaOS quando aplicáveis.

Context7 deve complementar o projeto, não substituir suas fontes internas.

**Economia de contexto:** não consultar documentação externa automaticamente se o código e os documentos locais já forem suficientes. Consultar somente a biblioteca e o tópico necessários. Evitar buscas amplas.

---

Atualize este mapa sempre que um documento relevante novo for criado (ex.: quando a auditoria da v0.3 for concluída, quando a integração ReceitaNet ganhar doc próprio, quando Rede Interna do Cliente, Contatos, Field Workspace, Mapa no Field, Ferramentas ou Contratos saírem de `PLANNED` e ganharem código ou doc próprio, e quando a Jornada receber tag e deixar de estar com release pendente).

**Seções marcadas `PLANNED`** descrevem o que foi aprovado no PRD e **não** existe em código. Nenhuma delas aponta para arquivo de implementação, porque não há. Ao implementar uma, troque a marcação e liste os arquivos reais — um mapa que aponta para o que não existe é pior que um mapa incompleto.

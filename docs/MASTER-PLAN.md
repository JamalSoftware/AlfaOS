# AlfaOS — Master Implementation Plan

> **Criado em 2026-09-09, junto do congelamento do escopo da V1 (PRD Parte XVI).**
>
> Este arquivo **não existia**. O projeto tinha planos por trilha —
> `DISPATCH-QUEUE.md`, `FIELD-NOTIFICATIONS.md`, `ERP-INTEGRATIONS.md`,
> `CTO-NETWORK-DISTRIBUTION.md` — e nenhum lugar que respondesse *"o que vem
> depois, e por quê"* olhando o produto inteiro. Ele nasce para responder isso,
> e para nada além disso.
>
> **Ele não é um segundo PRD.** A fonte canônica de visão e de contrato continua
> sendo `docs/PRD.md`. Aqui só existem sequência, dependências e o que cada
> fatia precisa entregar. Onde este documento e o PRD divergirem, o PRD vence.

---

## 1. Onde o produto está

Publicado e com tag:

```text
v0.10  execução e fechamento em campo
v0.11  jornada / ponto
v0.12  fila operacional de OS
v0.13  notificações push do Field · ERP-1 · SGP-1 · privacidade de foto
v0.14  CTO — cadastro, portas, capacidade, vínculo do cliente
```

Entregue, local, **sem tag e sem push**:

```text
CTO-2                   vínculo cliente ↔ porta, Web e Field          DONE
MAPA OPERACIONAL V1     CTO-3.1 → CTO-3.2.2e                          APPROVED · FROZEN
                        CTOs · OS abertas · clientes · conectividade
                        em lote · busca · navegação · posição da CTO
DASHBOARD V1            DASH-1 → DASH-1a                              APPROVED · FROZEN
                        oito cartões acionáveis · contexto por recorte
HOTFIX-FIELD-01         "Hoje" de /minhas-os no fuso da empresa       APPROVED
TIMELINE DO CLIENTE V1  TL-1                                          APPROVED · FROZEN
                        histórico na ficha do cliente · 50 por vez até 500
PACOTE TÉCNICO V1       EV-1                                          APPROVED · FROZEN
                        página da OS concluída · conferência pelo hash
BUSCA GLOBAL V1         GS-1                                          APPROVED · FROZEN
                        campo no menu → /busca · predicado das listagens
```

**`CORE FUNCTIONAL V1 — FEATURE COMPLETE` (13/09/2026).** As fatias funcionais da
primeira versão estão concluídas — toda linha da PRD §386 está implementada. Isso
**não** é `PRODUCTION READY`: faltam Release Candidate, hardening, os débitos do
§12, segurança, produção e piloto real. **Fase atual: `RC-1` — Release
Candidate / Hardening.** A `RC-1A` (auditoria e plano, zero código) terminou em
`OWNER DECISION REQUIRED`; a **`RC-1B`** (segurança, configuração, tenancy e
isolamento de teste) está **`APPROVED` / `CLOSED`** — `docs/SECURITY.md` §8.21;
e a **`RC-1C`** (o contrato de localização do cliente que o dono aprovou)
continua **aberta**: a validação física gravou um ponto a mais de 1 km do lugar,
a **`RC-1C-HOTFIX`** (captura de GPS recente e com precisão ≤ 50 m, no
aplicativo e no servidor) reprovou na segunda validação física pela regra de
frescor, e a **`RC-1C-HOTFIX-2`** (frescor pela idade da leitura) está
**`READY FOR OWNER VALIDATION`** — §12, `docs/TECHNICIAN-EXECUTION.md` §13, §13.5
e §13.6, `docs/SECURITY.md` §8.22 e §8.22.1.

O escopo do primeiro lançamento está congelado em **PRD §362–§393**, e o estado
de cada item está em **§386**. O contrato final do mapa é a **PRD §392**.

**O AlfaOS será uma plataforma SaaS modular** — Core mais módulos opcionais por
tenant (PRD Parte XVIII, §402–§414). **Este plano cobre o Core V1**; os módulos
futuros são backlog separado (§11) e não entram nas fatias abaixo.

---

## 2. A sequência até o lançamento

```text
CTO-3.2.1 · 3.2.1b · 3.2.1c   bases, marcador, navegação           ← concluído
PRD V1 Launch Scope Freeze                                          ← concluído
CTO-3.2.1d   ADMIN corrige a posição da CTO no mapa                 ← APPROVED
CTO-3.2.2    clientes + OS abertas + Online/Offline em lote         ← concluído
CTO-3.2.2b · c · d · e   estabilização e acabamento de UX           ← concluído
   ↓  validação do dono — CTO-3.2.2e APPROVED
MAPA OPERACIONAL V1 — FROZEN (PRD §392)                             ← 2026-09-12
   ↓
DASH-1 · DASH-1a               dashboard acionável       ← APPROVED · FROZEN (2026-09-12)
HOTFIX-FIELD-01                "Hoje" de /minhas-os      ← APPROVED (2026-09-13)
   ↓
TL-1                           timeline do cliente       ← APPROVED · FROZEN (2026-09-13)
   ↓
EV-1                           pacote de evidências      ← APPROVED · FROZEN (2026-09-13)
   ↓
GS-1                           busca global              ← APPROVED · FROZEN (2026-09-13)
   ↓
CORE FUNCTIONAL V1 — FEATURE COMPLETE   fatias funcionais: COMPLETE   ← 2026-09-13
   ↓
RC-1   Release Candidate / Hardening                     ← em andamento
       RC-1A  auditoria e plano                          ← OWNER DECISION REQUIRED
       RC-1B  segurança · configuração · tenancy · teste ← APPROVED · CLOSED (2026-09-14)
       RC-1C  CustomerLocation — contrato do dono        ← ABERTA (validação física)
       RC-1C-HOTFIX  captura de GPS · precisão ≤ 50 m    ← reprovada no frescor (2ª validação física)
       RC-1C-HOTFIX-2  frescor pela idade da leitura     ← READY FOR OWNER VALIDATION
       RC-1D  copy · timeline da OS · acessibilidade     ← próxima recomendada, não iniciada
   ↓
LANÇAMENTO V1 — produção e piloto real
   ↓
V2 (PRD §388)  →  V3 (PRD §389)
```

**A ordem das fatias foi decidida pelo dono, fatia a fatia, como este plano
previa.** Elas eram independentes entre si e todas dependiam apenas do que já
existia. **`DASH-1` veio primeiro** e foi aprovada com a `DASH-1a`; o
**`HOTFIX-FIELD-01`** fechou um defeito conhecido do técnico; a **`TL-1`** foi
aprovada pelo dono e congelada (§5, PRD §381); a **`EV-1`** também (§6, PRD
§383); e a **`GS-1`**, última fatia funcional do Core V1, foi validada pelo dono
em ADMIN, DISPATCHER, TECHNICIAN e web no celular e congelada (§7, PRD §384).

**Com isso o Core V1 está `FEATURE COMPLETE`, e a próxima fase é a `RC-1`.** Ela
é aberta por decisão do dono; o que ela recebe está no §12. **`FIELD-MAP-1` não
entra nessa linha:** é backlog pós-V1, avaliado depois do RC e do piloto (§9).

---

## 3. Mapa Operacional V1 — CONCLUÍDO · FROZEN

> **`CTO-3.2.2e` — APPROVED. Mapa Operacional V1 — FROZEN.** Validado pelo dono
> na interface real em 2026-09-12. **Fora da lista de trabalho ativo.**

O que ele entregou, sobre um motor só: as bases Mapa/Satélite/Híbrido; as
camadas de CTOs, OS abertas e clientes ativos; conectividade em lote sobre a
mesma autoridade da OS; destaque de OS aberta e de OS urgente no cliente; busca
global no tenant (CTO, cliente, OS); navegação de ida e volta com a vista
preservada; e a correção manual da posição da CTO pelo `ADMIN`. Zero migration
em toda a trilha.

```text
contrato       PRD §392 (consolidado) · §364–§379 · decisões que mudaram em §390
medições       docs/CTO-NETWORK-DISTRIBUTION.md §34–§46
arquitetura    docs/CONTEXT-MAP.md — "Mapa Operacional V1 — a arquitetura real"
```

**Regra daqui em diante.** Não existe `CTO-3.2.2f`. Ideia nova de mapa vai para
o backlog (PRD §393); o código do mapa só reabre por **correção crítica de
defeito**. Uma decisão fica aberta e é do dono — CTO e cliente na mesma
coordenada exata (PRD §371) —, e não bloqueia a V1.

Duas coisas que o plano original desta fatia não previa e que a implementação
trouxe, e que valem para qualquer tela futura com mapa: o empate de
empilhamento entre o ponto do cliente e o marcador da OS, que fazia o popup
aberto depender de qual resposta HTTP chegava primeiro; e o recorte pedido ao
servidor, que **não pode** ser o viewport cru — senão o próprio popup tira da
tela o que o operador está olhando. O plano original, fase a fase, está no
histórico do Git deste arquivo e no registro da `CTO-3.2.2` (§41 da nota
técnica).

---

## 4. `DASH-1` — Dashboard operacional acionável

> **Estado: ENTREGUE — `APPROVED` (com a `DASH-1a`).** Commits locais, sem tag
> e sem push. Zero migration, zero schema, zero dependência, zero Dart, zero
> rota de API. As definições que o PRD não trazia — "OS atrasada", "OS de
> hoje" e o conjunto de cartões — foram decididas pelo dono e registradas na
> PRD §380; o mapa do código está em `docs/CONTEXT-MAP.md`. O que segue é o
> plano como foi escrito.
>
> **`DASH-1a` — refinamento de UX.** O dono validou a `DASH-1` funcionalmente;
> a microfase fez cada listagem aberta pelo cartão explicar por que a linha está
> no recorte (volta ao painel, faixa nos oito recortes, contexto por linha,
> vazio contextual, atividade humanizada). Sem indicador novo, sem migration —
> decisões na PRD §380.
>
> **`DASH-1a` — `APPROVED`. Dashboard Operacional V1 — `FROZEN` (2026-09-12).**
> Fora da lista de trabalho ativo.

**Objetivo.** Transformar os cartões de contagem que já existem em indicadores
que levam a algum lugar, e acrescentar os que faltam.

**Dependências.** Nenhuma sobre fatia não entregue. Consome OS, fila, CTO e —
para "clientes offline" — a leitura em lote da `CTO-3.2.2`.

```text
backend   agregações do painel, tenant-scoped
web       cartões navegáveis; filtros correspondentes nas listagens de destino
Field     nenhuma alteração
migration nenhuma esperada
```

**Estado medido:** o dashboard atual tem cartões e **zero links**. A lacuna é a
navegabilidade.

**Testes.** Cada indicador leva ao filtro correspondente; contagem do cartão
bate com a contagem da tela de destino — é essa igualdade que impede o painel
de virar decoração.

**Risco.** *Baixo.* Nenhum contrato novo; a atenção é não deixar o painel
implementar contagem própria em vez de consumir as leituras existentes.

---

## 5. `TL-1` — Timeline do cliente

> **Estado: CONCLUÍDO — `TL-1` `APPROVED`. Timeline do Cliente V1 — `FROZEN`
> (13/09/2026).** Validada pelo dono na interface real. Commits locais, sem tag
> e sem push. Zero migration, zero schema, zero rota de API, zero Dart. O
> contrato congelado — as quatro decisões do dono, a fonte de cada fato e o que
> ficou fora — está na PRD §381; o mapa do código, em `docs/CONTEXT-MAP.md`.
> **Fora da lista de trabalho ativo:** só reabre por defeito crítico, vazamento
> de tenancy, problema de segurança, perda de histórico ou decisão do dono, e
> tipo de evento novo é backlog. A timeline **da OS** (`/ordens/[id]`) é outra
> tela e tem débito próprio (§12). O que segue é o plano como foi escrito.
>
> Três coisas que o plano não previa e a implementação encontrou: o vínculo de
> porta feito pelo **painel** não grava `ServiceOrderEvent` — só a linha de
> `CustomerNetworkConnection` o conta, então a fonte é ela; a **divergência**
> de localização vinda da integração grava o ponto do PROVEDOR como "novo" sem
> aplicá-lo, então comparar coordenadas a confundiria com uma atualização — o
> que as separa é o motivo que cada escritor grava; e ler as fontes em
> **paralelo** abria uma conexão por fonte, o que no Docker Desktop derrubava a
> seção de forma intermitente — a leitura passou a ser em lotes numa conexão só.

**Objetivo.** Uma leitura consolidada da vida operacional do cliente:
instalação, OS, visitas, fotos, assinaturas, medições, CTO e porta, mudanças de
porta, equipamentos e observações.

**Dependências.** Nenhuma. A matéria-prima já está gravada.

```text
backend   read model derivado — ServiceOrderEvent, evidências, assinaturas,
          equipamentos, CustomerNetworkConnection (com histórico), localização
web       aba/seção na tela do cliente
Field     nenhuma alteração nesta fatia
migration nenhuma esperada
```

**Estado medido:** existe timeline **por OS** (`ServiceOrderEvent`); **não**
existe leitura consolidada por cliente.

**Testes.** Nenhum evento é inventado nem omitido; ordenação estável;
tenant-scoped com controle positivo; o histórico de vínculo aparece inteiro —
inclusive as saídas e os retornos à mesma porta, que a `CTO-2.7` provou serem
linhas distintas.

**Risco.** *Baixo-médio.* O risco real é de escopo: a timeline atrai "só mais um
evento" indefinidamente. A lista de tipos fica congelada no início da fatia.

---

## 6. `EV-1` — Pacote técnico de evidências

> **Estado: `APPROVED` / `CLOSED` — Pacote Técnico de Evidências V1 `FROZEN`
> (2026-09-13). Commits locais, sem tag e sem push.** Validado pelo dono; só
> reabre por defeito crítico, tenancy, segurança ou decisão explícita do dono.
> Contrato, decisões do dono e o que ficou fora: PRD §383. Mapa do código:
> `docs/CONTEXT-MAP.md`, seção *Pacote técnico de evidências*. O plano abaixo é o
> registro de como a fatia foi escrita; ele se cumpriu sem migration, sem rota de
> API e sem Dart — e os quatro testes que ele pedia existem.

**Objetivo.** Reunir num lugar conferível tudo o que a conclusão de uma OS
produziu.

**Dependências.** Nenhuma. Todas as peças existem.

```text
backend   leitura consolidada por OS
web       visão do pacote na OS concluída
Field     nenhuma alteração
migration nenhuma esperada
```

**Estado medido:** `ServiceOrderExecution`, `ServiceOrderEvidence` (treze
categorias, incluindo medição óptica, speedtest e etiqueta do equipamento),
`ServiceOrderSignature`, `ServiceOrderEquipment`, check-in com coordenada e o
snapshot do checklist. Falta a reunião.

**PDF não entra.** A Parte X do PRD já tem sequência própria para geração de
documento; antecipá-la aqui duplicaria o mecanismo.

**Testes.** O pacote não omite categoria presente; assinatura continua vinculada
ao hash do conteúdo; foto continua sem EXIF (`PC-1`); nenhuma chave de storage
sai no DTO.

**Risco.** *Baixo.*

---

## 7. `GS-1` — Busca global do AlfaOS

> **Estado: `APPROVED` / `CLOSED` — Busca Global V1 `FROZEN` (2026-09-13).
> Commits locais, sem tag e sem push.** Validado pelo dono — ADMIN, DISPATCHER,
> TECHNICIAN e web no celular, todos `PASS`; só reabre por defeito crítico,
> tenancy, segurança ou decisão explícita do dono. Contrato, as três decisões do
> dono (equipamento fora da V1, técnico sem busca, campo no menu + página), o que
> a busca não é e o que ficou fora: PRD §384. Mapa do código:
> `docs/CONTEXT-MAP.md`, seção *Busca global*. O plano abaixo é o registro de como
> a fatia foi escrita; ela se cumpriu sem migration, sem rota de API e sem Dart.

**Objetivo.** Uma busca operacional única: cliente, telefone, endereço, OS, CTO,
técnico e equipamento quando aplicável.

**Dependências.** Nenhuma. Beneficia-se da busca do mapa já existente.

```text
backend   leitura de busca tenant-scoped, com teto pequeno e DTO mínimo por tipo
web       superfície única de busca
Field     fora desta fatia
migration nenhuma esperada
```

**Estado medido:** não existe. Há a busca de cliente **no ERP**
(`/api/integrations/customers/search`) e a busca do mapa (`/api/map/search`:
CTO por nome/código, cliente ativo por nome, OS aberta por número), ambas com
escopo próprio. **Endereço, telefone e documento ficaram fora da busca do mapa
por decisão (PRD §374)** — são desta fatia, com a revisão de privacidade que ela
já prevê.

> **Avaliar reuso antes de construir, e não introduzir motor externo de busca
> sem necessidade medida.** Postgres responde bem a esse volume; um serviço de
> busca a mais é um serviço a mais para operar, sincronizar e ver divergir.

**Testes.** Nenhuma enumeração global; termo vazio não vira listagem; teto por
tipo; tenancy com controle positivo em cada tipo de resultado.

**Segurança.** É a superfície que mais concentra dado pessoal de uma vez. DTO
mínimo por tipo, e documento/telefone só conforme a permissão que a listagem
correspondente já exige (PRD §201).

**Risco.** *Médio.* O risco é de escopo e de privacidade, não técnico.

---

## 8. Regras que atravessam todas as fatias

```text
Nenhuma segunda autoridade      conectividade, contagem de porta, precedência
                                de estado e ordem de fila têm uma implementação
                                cada — extrair, nunca duplicar

Tenancy em SQL                  companyId da sessão, no predicado, com controle
                                positivo em todo teste de negação

Recorte e teto                  nenhuma leitura de mapa ou de busca carrega a
                                carteira inteira (PRD §200)

Derivado, nunca persistido      status de mapa, contagem de online/offline,
                                ocupação de porta

Validação do dono               toda fatia com UI real termina em
                                READY FOR OWNER VALIDATION, nunca em APPROVED
                                automático

Escopo congelado                ideia nova que não bloqueia a operação V1 vai
                                para o backlog (PRD §393); o mapa congelado só
                                reabre por correção crítica de defeito (§392)

Git                             sem push e sem tag sem autorização explícita
```

---

## 9. O que este plano NÃO cobre

V2 e V3 (PRD §388, §389): falha coletiva, central de incidentes, modo NOC,
manutenção preventiva, camada de técnico ao vivo, métricas de técnico, FiberMap
e rede física.

Qualquer ideia nova de **mapa** depois do freeze (PRD §392), a **Central de
Retenção e Recuperação** (§10 abaixo) e os **módulos SaaS futuros** (§11).

Trilhas documentadas e não promovidas: **Escala de Trabalho** (PRD §288–§307),
**Colaboração entre Técnicos** (§342–§351), **custódia de patrimônio**
(§210–§223), **contratos e assinatura eletrônica** (Parte X) e as **capabilities
de negócio do SGP**.

Elas continuam sob a §119: estar no PRD não é autorização para implementar.

**Atualização automática do diagnóstico na OS aberta — `DIAG-AUTO-01`,
`DEFERRED BY PRD SCOPE` (sugestão do dono, 13/09/2026).** Hoje o
"Atualizar diagnóstico" é um clique; a ideia é repetir a leitura sozinha,
de tempos em tempos, enquanto a tela da OS estiver aberta. **Não entra na V1**:
a PRD descreve o refresh como **sob demanda, com gatilho na OS**, e diz que
atualizar "continua sendo ação explícita" (§337, §370); não está em §386 nem em
§387, e pelo critério da §393 não é bloqueador da operação. Implementá-la seria
mudar essa decisão, e isso é `DECISION UPDATED` do dono, nunca efeito colateral
de uma tela. Nada foi escrito em código.

```text
se voltar         decisão explícita do dono, atualizando §337/§370 (§390)
pesa na decisão   cada ciclo é uma chamada real ao provider (hoje, o ReceitaNet
                  CallCenter; o SGP não tem a capability); o balde de 10/min
                  é por (empresa, usuário, capability), e a empresa não tem
                  teto agregado — a divergência com o texto antigo da §337
                  foi resolvida em DIAG-RATE-01 (mantido por usuário, PRD
                  §370) —, então a carga no provider cresce com o número de
                  telas abertas; e o frescor da conectividade é a decisão
                  aberta C-03 (CTO-6)
guarda-corpos     o MESMO POST do botão · só com a aba visível · sem chamada
                  sobreposta · falha mantém a última leitura e nunca vira
                  OFFLINE · sem STALE · nenhum evento de timeline · nenhum
                  job, cron ou worker · o botão manual continua
não é             NOC, monitoramento de rede, "offline há N dias" — V2 e
                  Parte XVII
```

**`FIELD-MAP-1` — Mapa de Campo do Técnico: conceito aprovado pelo dono,
`FUTURE` / pós-V1 / não implementado (13/09/2026).** Especificação conceitual na
**PRD Parte XIX (§415–§421)**: CTOs próximas, clientes e OS abertas no mapa do
técnico, com a conectividade conhecida e navegação — ativado por empresa pelo
`ADMIN`, sobre as autoridades do Core, sem provider por marcador, com a posição
da CTO só por sugestão aprovada pelo `ADMIN`, e um contrato para a web no celular
e o Field. **Não é fatia, não é bloqueador do lançamento e não reabre o Mapa
Operacional V1 nem a `GS-1`.**

```text
quando        depois do RC e do piloto, por decisão do dono — nunca durante a
              RC-1 sem nova ordem dele
antes dela    as sete decisões abertas da PRD §421 (ativação, alcance de
              clientes, de OS e de CTOs, sugestão de CTO, telefone, nome)
não é         GS-1 para técnico · Mapa Operacional V1 · FiberMap · editor de
              topologia
```

---

## 10. Backlog futuro — Central de Retenção e Recuperação

> **BACKLOG. NÃO É FATIA, NÃO É ROADMAP IMEDIATO, NÃO TEM VERSÃO.** Registrada em
> 2026-09-12, no freeze do Mapa Operacional V1. Especificação conceitual:
> **PRD Parte XVII (§394–§401)**. Nada existe em código.

Objetivo: reduzir perdas financeiras e patrimoniais do provedor. As peças:

```text
inadimplência e patrimônio em risco           PRD §395
recuperação e OS de recolhimento              PRD §396
risco de churn — offline não é cancelamento   PRD §397
Recovery Risk Score                           PRD §398
cobrança, lembrete de fatura e WhatsApp       PRD §399
financeiro por contrato normalizado de ERP    PRD §400
"Ver casos no mapa" — opcional                PRD §401
```

**Por que não entra na sequência acima.** Não é bloqueador da operação V1
(PRD §393), e três dependências que o código já mostra tornariam qualquer fatia
agora prematura:

```text
identidade e valor do equipamento   hoje o equipamento é linha por OS, sem
                                    identidade estável nem valor (PRD §395)
frescor da conectividade            "offline há N dias" não é pergunta que o
                                    snapshot sob demanda responde (PRD §397)
capability financeira no ERP        nenhum adapter lê financeiro hoje; entraria
                                    como capability do adapter, nunca por
                                    formato de um ERP (PRD §400)
```

Promover qualquer peça daqui para o roadmap é **decisão explícita do dono**, e
ela volta a este plano como fatia própria — com dependências, entregas, testes,
segurança e risco, como as outras.

**Evoluída pela plataforma modular (PRD §410):** a "Central" é a composição de
três módulos opcionais futuros — **Collections** (receita, §399), **Recovery**
(patrimônio, §395–§396) e **Retention** (churn, §397) —, com o WhatsApp como
canal e não como parte deles. As dependências acima continuam valendo para os
três. Eles estão listados, com os demais, em §11.

---

## 11. Future SaaS Modules — backlog separado

> **BACKLOG. NENHUM MÓDULO É FATIA, NENHUM TEM VERSÃO, PRAZO OU COMPROMISSO DE
> V1.** Decisão registrada em 2026-09-12: o AlfaOS é **Core + módulos opcionais
> por tenant**. Especificação conceitual: **PRD Parte XVIII (§402–§414)**. Nada
> existe em código.

```text
WhatsApp / Customer Messaging   canal com o assinante            PRD §410
Collections                     recuperar receita                PRD §410 · §399
Recovery                        recuperar patrimônio             PRD §410 · §395–§396
Retention                       evitar churn                     PRD §410 · §397
AI Assistant                    atender por ferramentas          PRD §411
NOC                             operar incidentes de rede        PRD §410 · §388
Network Management — OLT        gerência da rede óptica          PRD §410 · §104
ACS / Wi-Fi                     gerência remota do CPE           PRD §410 · §106
Analytics                       indicadores de negócio           PRD §410
```

**As fatias V1 não mudam.** Com a `DASH-1`, a `TL-1`, a `EV-1` e a `GS-1`
concluídas e o Core V1 `FEATURE COMPLETE`, **nenhum módulo entra no Core V1** —
nem como "já que estamos mexendo aqui" (PRD §393), nem durante a `RC-1`.

**O que um módulo precisa antes de virar fatia**, além da decisão do dono: a
camada central de acesso — Module Registry, entitlement por tenant e capability
do usuário como conceitos separados (PRD §404–§406) —, porque o primeiro módulo
construído sem ela espalharia `if (tenant.hasModule(...))` pelo código, e é esse
o defeito que a Parte XVIII existe para evitar. Também valem as dependências já
medidas da §10 e as decisões abertas da PRD §414.

---

## 12. Débitos registrados — fora das fatias

> **Registro, não fatia.** Nenhum destes itens está sendo corrigido, nenhum
> reabre uma entrega aprovada, e cada um tem a fase em que deve ser tratado.

**A `RC-1` recebe esta lista inteira**, mais três itens registrados em outro
lugar: `DIAG-AUTO-01` (§9 — backlog de produto, não débito), o contador do teto
de diagnóstico **em memória do processo** e a **ausência de teto agregado por
empresa** (`docs/SECURITY.md` §8.7, *Rate limit de capability*; PRD §370).
Preservados em 13/09/2026, no fechamento da `GS-1`: nenhum foi resolvido ali.

**`RC-1C-HOTFIX-2` — `READY FOR OWNER VALIDATION` (15/09/2026).** A segunda
validação física, já com a localização precisa concedida, terminava toda captura
em "Localização não obtida": com o aparelho parado, o provedor fundido do Google
entregou só 13 localizações em seis capturas, e a captura recusou todas porque
a regra de frescor também exigia que a leitura tivesse nascido no máximo 2 s
antes da abertura. O dono fixou o frescor na **idade** da leitura (≤ 10 s),
não no instante de abertura. Só Flutter, com um gancho de diagnóstico sem
coordenada no `logcat` de depuração (`docs/TECHNICIAN-EXECUTION.md` §13.6). A
`RC-1C` só fecha com a validação física desta hotfix.

**`RC-1C-HOTFIX` — reprovada no frescor (15/09/2026), corrigida na HOTFIX-2.** A validação
física da `RC-1C` gravou, por "Corrigir localização" com GPS, um ponto a mais de
1 km do lugar em que o Google Maps pôs o mesmo telefone. Causa provada no
aparelho e no banco: permissão só **aproximada** (o Android a entrega com 2000 m
de precisão — o número gravado) e `getCurrentPosition` aceitando a primeira
posição, sem ninguém olhar precisão ou idade. O dono aprovou precisão ≤ 50 m
(PRD §172 `DECISION UPDATED`). O aplicativo passou a capturar leituras novas
(≤ 10 s, precisão ≤ 50 m, até ~20 s, a primeira aceitável encerra, a ruim nunca
vira posição; pede a localização precisa quando só a aproximada foi concedida),
e o servidor exige a mesma precisão em confirmar e em corrigir com coordenada
(`docs/TECHNICIAN-EXECUTION.md` §13.5; `docs/SECURITY.md` §8.22.1). **Zero
migration, zero dependência, zero permissão nova.** A `RC-1C` só fecha com a
validação física desta hotfix.

**`RC-1C` — `READY FOR OWNER VALIDATION` (14/09/2026).** O contrato de
localização que o dono aprovou (PRD §172 `DECISION UPDATED`;
`docs/TECHNICIAN-EXECUTION.md` §13; `docs/SECURITY.md` §8.22), cada regra com
teste que falhava antes e sabotagem que o derruba: `RC-LOC-01` (confirmar exige
GPS e vale até 100 m, arbitrado pelo servidor; o aplicativo mostra distância e
precisão e leva a "Corrigir" quando longe), `RC-LOC-02` (a timeline do cliente
diz a distância da confirmação), `RC-LOC-03` (cartão "Localização do cliente",
somente leitura, `ADMIN`), `RC-LOC-05` (teste de autoridade do mapa e o E2E
"corrigir → o marcador muda e fica") e `RC-LOC-06` estendido aos fluxos novos.
Correção: coordenada só pelo GPS — `MANUAL` e meia coordenada recusados. A
posição do aparelho fica no servidor (a leitura da OS a remove). **Zero
migration, zero dependência.** `RC-LOC-04` foi analisado e depende do dono —
item abaixo.

**`RC-1B` — `APPROVED` / `CLOSED` (14/09/2026).** Validada pelo dono em uso real
(upload de foto pelo Field e pela web, troca da foto da CTO: `PASS`) e
publicada no GitHub, sem tag. Resolvidos, cada um com teste que falhava antes e
sabotagem que o derruba (`docs/SECURITY.md` §8.21):
`RC-STO-01` (corpo multipart com teto antes de ser lido — o proxy continua
precisando de limite de corpo), `RC-LOG-01` (log de erro sem mensagem),
`RC-SEC-01` (`LOGIN_*` inválido derruba a subida), `RC-OPS-03` (Mock ERP
indisponível em produção — o item "Sincronizar Mock ERP" abaixo), `RC-OPS-04`
(seed recusa em produção), `RC-DB-02` (guarda dos índices parciais), `RC-DB-01`
/ `RC-TEN-01` (técnico anterior lido no tenant, testes de id de outra empresa),
`RC-TEST-01` (redirecionamentos do técnico e download de assinatura),
`RC-STO-02` (storage isolado em Vitest e E2E — a metade de teste do item
"Storage órfão" abaixo) e `RC-LOC-06` (localização × conclusão). **Não
tocados, por escopo:** `RC-LOC-01`–`05` (entregues depois, na `RC-1C`) e o resto
desta lista.

```text
CustomerLocation legado — projeção sem autoridade (RC-LOC-04)
  o quê    Customer.latitude/longitude gravados pelo enriquecimento do ERP
           ANTES da v0.10, sem CustomerLocation. Dry-run de 14/09/2026 (banco
           de dev, só leitura): 1 cliente — real, ReceitaNet, locationSource
           IMPORTED, não verificado, 3 OS, nenhuma linha de histórico
  hoje     o mapa e o cartão do ADMIN o tratam como SEM localização (leem a
           autoridade); o Field também (a seção pede "Corrigir", que cria o
           ponto com GPS); só o link de navegação da OS ainda lê a projeção
  proposta backfill pelo escritor automático que já existe
           (applyImportedCustomerLocation): cria a autoridade como IMPORTED,
           não verificada, e só onde ela não existe — idempotente e com a
           procedência preservada. NÃO executado
  fase     decisão do dono
  junto    no banco de dev, 4 fixtures de QA do mapa (11/09) têm o inverso —
           autoridade sem projeção, gravadas direto em teste manual; nenhum
           escritor de produção produz isso. Não tocadas

Precisão do GPS — limite aprovado (RC-1C)          RESOLVIDO na RC-1C-HOTFIX
  o quê    confirmar e corrigir registravam e mostravam a precisão sem bloquear
  hoje     precisão ≤ 50 m (valor real), exigida no Field e no servidor; decisão
           do dono de 15/09/2026, depois da validação física

Histórico de precisão por correção (RC-1C-HOTFIX, observação)
  o quê    CustomerLocation.accuracyMeters guarda só a precisão da ÚLTIMA
           escrita; a trilha não tem coluna para ela, e o evento
           LOCATION_CORRECTED não a registra. Foi o que impediu saber a
           precisão da primeira correção da validação física
  fase     backlog — não é contrato desta hotfix

/minhas-os — "Próximas"
  o quê    também contém OS sem agendamento e OS com agendamento vencido
           (validação do dono, 13/09/2026: OS de 06/09 em "Próximas")
  opções   A/B/C registradas SEM decisão — docs/TECHNICIAN-EXECUTION.md §9
  fase     fluxo do técnico

"Sincronizar Mock ERP"                                   RESOLVIDO na RC-1B
  o quê    visível ao ADMIN em /ordens, sem condição de ambiente
  hoje     indisponível em produção — botão, sincronização, adapter e opção
           em /integracoes (RC-OPS-03, docs/SECURITY.md §8.21)

Datas gerais no fuso do servidor
  o quê    "Criada em", "Vinculado em" e o "Agendada:" dos cartões de /minhas-os
  apoio    o helper do fuso da empresa já existe (src/lib/company-datetime.ts)
  fase     release hardening

Timeline DA OS — código cru (validação da TL-1, 13/09/2026)
  o quê    a timeline da OS (/ordens/[id]) rotula 7 códigos e mostra os outros
           crus: o dono viu PRIORITY_CHANGED; no banco de dev aparecem também
           CHECKED_IN, CTO_PORT_*, EQUIPMENT_INSTALLED, LOCATION_CORRECTED e
           SIGNATURE_CAPTURED, e o código grava ainda CONTACT_ATTEMPTED,
           IMPEDIMENT_REPORTED, LOCATION_CONFIRMED, ADDRESS_CORRECTED e
           MATERIAL_USED
  onde     EVENT_LABELS em src/app/(app)/ordens/[id]/page.tsx
  não é    a timeline do CLIENTE (TL-1), que tem apresentação própria e está FROZEN
  fase     release hardening

E2E do mapa — MAPEDIT-05/06/07 intermitente (achado na TL-1, 13/09/2026)
  o quê    o arrasto registra no painel, e a medição do marcador dá desvio 0;
           isolado, falhou 2 de 6; no grupo MAPEDIT, 10 de 10; na suíte inteira,
           1 falha numa rodada e 308/308 na seguinte; nos gates da EV-1,
           314/314 numa rodada só
  também   MAPEDIT-08/14 (gates da RC-1C-HOTFIX, 15/09/2026): o valor gravado
           depois de "Salvar" era o de antes do arrasto — 1 falha na suíte
           (330/331), e 10/10 no grupo MAPEDIT isolado, três rodadas seguidas.
           Mesma família: o arrasto que às vezes não chega
  alcance  código do mapa idêntico ao de antes da TL-1 — nenhum arquivo do
           caminho de /mapa mudou (nem na RC-1C-HOTFIX)
  aberto   se é corrida da medição ou o marcador voltando ao ponto gravado
  fase     investigação própria; o mapa está FROZEN e só reabre por defeito provado

Fotos gravadas antes do PC-1 com GPS no arquivo (achado na EV-1, 13/09/2026)
  o quê    a limpeza de EXIF (PC-1, 06/09) roda no UPLOAD; a foto gravada antes
           dela continua com os bytes originais. No banco de dev: 1 de 1 foto
           confirmada de OS concluída — a do piloto da OS Nº 6, de 28/08 — ainda
           tem IFD de GPS
  alcance  pré-existente: a mesma rota autorizada já servia esse arquivo na OS
           concluída (ServiceOrderClosingReadOnly); o pacote não amplia quem vê
  fase     release hardening — re-sanitizar o storage legado, sem mexer no hash
           do fechamento (ele não inclui os bytes)

PRD — menções antigas a comprovante em PDF (achado na EV-1)
  o quê    §34, §38 e §117 citam PDF/comprovante sem marca de superado; a §383
           (escopo V1, posterior) diz que PDF não é obrigatório na V1
  fase     higiene documental — marcar na §390, sem mudar decisão

Configurações — copy antiga de "próximas versões"
  o quê    /configuracoes promete que "mais opções de configuração serão
           adicionadas nas próximas versões" — promessa sem data numa tela
           de produto
  onde     src/app/(app)/configuracoes/page.tsx
  fase     release hardening

Storage órfão                             (1) RESOLVIDO na RC-1B · (2) aberto
  o quê    (1) suítes de teste — três de Vitest e o servidor do E2E — gravavam
           no .storage real; (2) a foto de CTO substituída deixa o blob
           anterior sem referência — INFO aceito,
           docs/CTO-NETWORK-DISTRIBUTION.md §20 e §23
  hoje     (1) Vitest e E2E usam storage temporário, apagado ao fim
           (RC-STO-02). O resíduo antigo NÃO foi apagado: dry-run de
           14/09/2026 — 1.886 diretórios no .storage de dev, 1.884 de empresas
           inexistentes (2.032 arquivos, 1,5 MB); das empresas vivas, 10
           arquivos referenciados e 5 órfãos (as fotos de CTO trocadas)
  fase     limpeza do resíduo de teste: decisão do dono sobre o dry-run;
           (2) remover blob só com política própria, porque apagar por
           suposição é como se perde evidência

Busca global — telefone/documento gravados com máscara (achado na GS-1)
  o quê    o termo com máscara acha o gravado só em dígitos; o inverso —
           gravado "(28) 99948-2862", digitado só em dígitos — não acha
  alcance  fechar exige normalizar a coluna: migration, decisão própria
  fase     RC-1, se o dono decidir — a GS-1 está FROZEN (PRD §384)

Técnico sem página individual (achado na GS-1)
  o quê    o resultado de técnico da busca global abre /tecnicos filtrada pelo
           nome — a web não tem tela própria do técnico
  fase     RC-1 decide se é débito ou backlog: tela nova é escopo, não correção

Equipamento sem identidade própria
  o quê    ServiceOrderEquipment é linha da OS, com série e MAC opcionais; não
           há entidade, rota nem ciclo de vida — por isso a busca de
           equipamento é FUTURE (PRD §384, §393), e a Parte XVII depende disso
           (§10)
  fase     trilha própria, por decisão do dono — não se cria Equipment só para
           a busca
```

O `HOTFIX-FIELD-01` corrigiu **só** o fuso de "Hoje" em `/minhas-os`; a
semântica de "Próximas" não é continuação dele. Os demais INFO continuam onde
foram registrados — PRD §253 (jornada), as notas técnicas de cada trilha e
`docs/SECURITY.md` — e esta lista não os substitui.

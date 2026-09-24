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
e a **`RC-1C`** (o contrato de localização do cliente que o dono aprovou) está
**`APPROVED` / `CLOSED`** (15/09/2026): depois de três correções da captura de
GPS — precisão ≤ 50 m (`RC-1C-HOTFIX`), frescor pela idade da leitura
(`RC-1C-HOTFIX-2`) e a precisão que o plugin do Android perdia
(`RC-1C-HOTFIX-3`) —, a validação física final do dono passou. Contrato final
congelado em `docs/TECHNICIAN-EXECUTION.md` §13.8; §12, `docs/SECURITY.md`
§8.22 e §8.22.1. Depois dela vieram a **`RC-1D`** (UX, copy e observabilidade da
CTO) e o **`DIAG-AUTO-1`**, **`APPROVED` / `CLOSED`** em 16/09/2026 — §13 e §14,
`docs/CTO-NETWORK-DISTRIBUTION.md` §47 e §48, `docs/SECURITY.md` §8.23 e §8.24;
a **`RC-1E`** (fotos e storage), **`APPROVED` / `CLOSED`** — §15; e a **`RC-1F`**
(§16 a §18), com a `RC-1F-A` e a `RC-1F-B` **`APPROVED` / `CLOSED`** em
17/09/2026. A sequência completa, com o estado de cada uma, está no §2.

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
       RC-1C  CustomerLocation — contrato do dono        ← APPROVED · CLOSED (2026-09-15)
       RC-1C-HOTFIX  captura de GPS · precisão ≤ 50 m    ← CLOSED (reprovada no frescor → HOTFIX-2)
       RC-1C-HOTFIX-2  frescor pela idade da leitura     ← CLOSED (noAccuracy → HOTFIX-3)
       RC-1C-HOTFIX-3  precisão perdida no plugin        ← APPROVED · CLOSED (validação física PASS)
       RC-1D  UX · copy · observabilidade da CTO        ← APPROVED · CLOSED (2026-09-16)
       DIAG-AUTO-1  verificação automática            ← CODE APPROVED · CLOSED
                                                           scheduler PENDING RC-1F
       RC-1E  fotos e storage                            ← APPROVED · CLOSED (2026-09-16)
                                                           apply legado e expurgo: NÃO executados
       RC-1F  produção · agendadores · storage           ← OWNER DECISION REQUIRED (descoberta,
                                                           2026-09-17) · §16
       RC-1F-A  motor de diagnóstico: justiça · cadência ← APPROVED · CLOSED (2026-09-17)
                · prazo · configuração                     scheduler CODE READY, não ACTIVE · §17
       RC-1F-B  VPS: deploy · storage · backup · cron   ← APPROVED · CLOSED (2026-09-17) · §18
                                                           VPS PROVISIONING: ADIADO até a
                                                           publicação · DEPLOY: NÃO EXECUTADO
       RC-1G  release hardening dos débitos §12         ← READY FOR OWNER VALIDATION
              fuso da empresa · multi-EXIF · §382          (2026-09-17) · §19
              · ZOOMVIS · login-flood · status dos docs
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

> **SUPERADO em 15/09/2026 — o dono autorizou, e ela foi implementada como
> `DIAG-AUTO-1` na `RC-1D`.** O adiamento abaixo fica como registro de por que
> ela não entrou antes, e continua correto sobre o refresh MANUAL da OS, que
> segue sendo ação explícita. O que mudou não foi o critério: foi um fato
> operacional que a validação da tela da CTO tornou visível — "Online · última
> leitura há 9 dias" não prova que o cliente continua online. Contrato em
> PRD §370 e §390; nota técnica em `docs/CTO-NETWORK-DISTRIBUTION.md` §48.

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

**`RC-1C-HOTFIX-3` — `APPROVED` / `CLOSED` (15/09/2026).** A terceira
validação física, com o frescor já corrigido, mostrou no `logcat` toda leitura
recusada como `noAccuracy` (`accuracyMeters=-`, ~5 s de idade), com o sistema
medindo de 7 a 27 m. Causa lida no código do plugin instalado: o
`geolocator_android` 4.6.2 reconstrói cada leitura sem repassar
`Position.hasAccuracy` (campo que a interface 4.3.0 criou com padrão `false`),
e a captura confiava na bandeira — nenhuma captura de Confirmar ou Corrigir
podia passar no Android. A precisão passou a ser a **medida**
(`measuredAccuracyMeters`), sem fonte alternativa, sem dependência nova e sem
mudar o contrato ou o servidor. Os testes da captura pulavam a conversão do
plugin; a borda agora é testada por ela (`docs/TECHNICIAN-EXECUTION.md` §13.7).
**Validação física final do dono `PASS`:** leitura de ~15,2 m aceita na hora
(`verdict=accepted`, `outcome=acquired`), `CustomerLocation` corrigida pelo
Field, marcador no lugar certo no Mapa Operacional, e o ponto preservado depois
de recarregar e de sair e entrar (`docs/TECHNICIAN-EXECUTION.md` §13.8).

**`RC-1C-HOTFIX-2` — `CLOSED` (15/09/2026): reprovada por `noAccuracy`, corrigida na HOTFIX-3.** A segunda
validação física, já com a localização precisa concedida, terminava toda captura
em "Localização não obtida": com o aparelho parado, o provedor fundido do Google
entregou só 13 localizações em seis capturas, e a captura recusou todas porque
a regra de frescor também exigia que a leitura tivesse nascido no máximo 2 s
antes da abertura. O dono fixou o frescor na **idade** da leitura (≤ 10 s),
não no instante de abertura. Só Flutter, com um gancho de diagnóstico sem
coordenada no `logcat` de depuração (`docs/TECHNICIAN-EXECUTION.md` §13.6). Foi
esse gancho que mostrou, no teste seguinte, a segunda causa escondida atrás do
frescor.

**`RC-1C-HOTFIX` — `CLOSED` (15/09/2026): reprovada no frescor, corrigida na HOTFIX-2.** A validação
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
migration, zero dependência, zero permissão nova.** A `RC-1C` fechou com a
validação física da HOTFIX-3.

**`RC-1C` — `APPROVED` / `CLOSED` (15/09/2026; entregue em 14/09/2026).** O contrato de
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
item abaixo. Fechada com a validação física final do dono, depois das três
correções da captura acima; o contrato final do GPS está congelado em
`docs/TECHNICIAN-EXECUTION.md` §13.8.

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
  fase     decisão do dono — não bloqueou o fechamento da RC-1C
           (15/09/2026); dívida pós-RC-1C
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

/minhas-os — "Próximas"                                  RESOLVIDO na RC-1D
  o quê    também continha OS sem agendamento e OS com agendamento vencido
           (validação do dono, 13/09/2026: OS de 06/09 em "Próximas")
  hoje     cinco seções exclusivas — Em atendimento · Atrasadas · Hoje ·
           Próximas · Sem agendamento —, com a regra de atrasada vinda do
           painel (§13, docs/TECHNICIAN-EXECUTION.md §9)

"Sincronizar Mock ERP"                                   RESOLVIDO na RC-1B
  o quê    visível ao ADMIN em /ordens, sem condição de ambiente
  hoje     indisponível em produção — botão, sincronização, adapter e opção
           em /integracoes (RC-OPS-03, docs/SECURITY.md §8.21)

Datas gerais no fuso do servidor            RESOLVIDO no RC-1 release hardening
  o quê    "Criada em", "Vinculado em" e o "Agendada:" dos cartões de /minhas-os
           saíam no fuso do PROCESSO — em produção, UTC
  hoje     toda tela formata pelo fuso da EMPRESA (company-datetime.ts, com a
           leitura em company-timezone.ts); o fuso é argumento obrigatório, e um
           teste estrutural recusa `Intl.DateTimeFormat` sem `timeZone` em
           src/app. E2E com a empresa em Asia/Tokyo prova as três superfícies

Timeline DA OS — código cru (validação da TL-1, 13/09/2026)
  o quê    a timeline da OS (/ordens/[id]) rotula 7 códigos e mostra os outros
           crus: o dono viu PRIORITY_CHANGED; no banco de dev aparecem também
           CHECKED_IN, CTO_PORT_*, EQUIPMENT_INSTALLED, LOCATION_CORRECTED e
           SIGNATURE_CAPTURED, e o código grava ainda CONTACT_ATTEMPTED,
           IMPEDIMENT_REPORTED, LOCATION_CONFIRMED, ADDRESS_CORRECTED e
           MATERIAL_USED
  onde     EVENT_LABELS em src/app/(app)/ordens/[id]/page.tsx
  não é    a timeline do CLIENTE (TL-1), que tem apresentação própria e está FROZEN
  hoje     RESOLVIDO na RC-1D: tabela central em src/lib/service-order-event-labels.ts,
           "Evento registrado" para o desconhecido, código cru no `title`, e uma
           varredura do fonte que exige rótulo para todo `event:` gravado

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
  hoje     RESOLVIDO na RC-1D (§13): o react-leaflet 4 compara `position` por
           REFERÊNCIA e o array era recriado a cada render, então a releitura do
           recorte no meio do gesto chamava `setLatLng` no marcador que estava na
           mão. Corrigido com `stablePosition`, reproduzido sem sorte
           (MAPEDIT-15) e com o invariante do sucesso coberto (MAPEDIT-16)

Vitest — login-flood sensível a CARGA (achado na DIAG-AUTO-1, 16/09/2026)
  o quê    "flood em voo não impede o login legítimo disparado junto" dispara 13
           logins concorrentes pagando bcrypt de verdade. Numa rodada da suíte
           inteira, UMA das 12 requisições do flood voltou 500 em vez de 401 —
           a rota lançou
  medido   isolado: 3 de 3 passa. Junto do arquivo do ciclo de conectividade:
           2 de 2 passa. Suíte inteira: 1 falha em 4 rodadas (2915/2915,
           2922/2923, 2923/2923 e a das sabotagens). PICO de conexões no
           Postgres durante a suíte: 19 de 100 — o que essa medição descarta é
           `max_connections`, e SÓ isso; ela não fala do pool do cliente, que
           é 9 e é onde a falha acontece (correção de RC-1)
  alcance  a DIAG-AUTO-1 não toca login, sessão nem limitador. Ela acrescentou
           transações interativas à suíte (o advisory lock da primeira
           verificação segura uma conexão enquanto o refresh usa outra), e foi
           por isso que a medição de pico foi feita em vez de suposta
  hoje     MECANISMO PROVADO no RC-1, e não é do login: a rajada de 13 com o
           pool FRIO abre ~8 conexões de uma vez, os handshakes atravessam o
           port proxy do Docker Desktop e um é recusado — `P1001`, que a rota
           traduz em 500 CORRETAMENTE (banco fora do ar não é regra de negócio).
           Sonda com controle: rajada 1495 consultas → 2 falhas; sequencial 975
           → 0. O teste passou a aquecer o pool antes da rajada, sem afrouxar
           asserção, e LOGIN-TRANSPORT-01..05 fixa que erro de transporte
           continua 500 — nunca 401
  aberto   a identidade do erro DAQUELA rodada não foi capturada (a linha
           `[api:error]` diria), e a taxa sob a suíte (~25%) é ~20× a medida
           com a máquina ociosa (~1%). Se voltar, capturar a saída antes de
           teorizar

E2E do mapa — ZOOMVIS-08/09 intermitente (gates da DIAG-AUTO-1, 16/09/2026)
  o quê    "a escala não move a coordenada nem o transform do Leaflet" falhou
           UMA vez na suíte inteira — "a área de clique encolheu junto com o
           desenho", Expected: 32
  medido   isolado: 1 de 1 passa; na suíte inteira seguinte, 351/351. No RC-1,
           NÃO reproduzido: sonda amostrando a largura do alvo a cada 25 ms,
           ociosa e com a CPU estrangulada em 20×, mediu 32 px estáveis e a
           escala do zoom já aplicada em todas as amostras
  alcance  nenhum arquivo do caminho de /mapa mudou na DIAG-AUTO-1; não é o
           MAPEDIT (causa provada e resolvida na RC-1D, §13)
  hoje     RESOLVIDO no RC-1 (§20): CLOSED / TEST HARNESS. A medição lê
           marcadores de DUAS camadas — a caixa e a OS — e o teste só esperava
           `svg.cto-box`, que prova a camada de CAIXAS. Com a de OS atrasada em
           4 s, `querySelector` devolve null e o `getBoundingClientRect` estoura
           dentro do `page.evaluate` — reproduzido sem sorte, corrigido
           esperando as duas camadas, e a sabotagem que tira a espera derruba o
           teste de novo. PRODUÇÃO INALTERADA; o mapa segue FROZEN
  ressalva  a assinatura da ocorrência histórica nunca foi capturada, então o
           que está provado é um defeito real DESTE teste com o mesmo perfil —
           não que aquela falha de 16/09 tenha sido esta

E2E de fechamento mobile — toBeInViewport ratio 0 (gates do RC-1, 17/09/2026)
  o quê    "fluxo completo cabe na tela e é utilizável" (390x844) falhou UMA vez
           com viewport ratio 0 por 10 s, no botão de concluir
  medido   1 falha em 4 rodadas completas válidas; 0 em 5 repetições isoladas;
           NÃO reproduzido com o refresh RSC atrasado 3 s nem 9 s (9 s produz
           outra assinatura, `element(s) not found`)
  corrida  MEDIDA e real: `run()` faz `setNotice(...)` e dispara
           `router.refresh()` sem esperar, então `signAndSave` volta antes de o
           refresh chegar; quando ele chega, o bloco "Assinatura registrada
           por…" nasce ACIMA do botão e o empurra 68 px (620,75 → 688,75),
           depois do único `scrollIntoViewIfNeeded()`
  por que  não corrigido: 688,75 + 56 = 744,75 ainda cabe na viewport de 844,
  aberto   então a corrida medida NÃO explica o ratio 0. Correção especulativa
           exigiria um detector que nenhum teste tem — proteção que ninguém
           derruba é proteção que alguém apaga
  status   OPEN / NON-BLOCKING KNOWN DEBT
  aberto   causa não isolada — uma observação só não classifica
  fase     investigação própria; o mapa está FROZEN e só reabre por defeito
           provado

E2E EV-E2E-01 no next dev FRIO (gates do SEC-003 / Next 15, 21/09/2026)
  o quê    "o ADMIN abre a OS concluída, abre o pacote…": o toHaveURL de 10 s
           depois do clique em "Ver pacote técnico" estoura no primeiro acesso
           à rota, num servidor de desenvolvimento frio
  medido   frio: a navegação do cliente sai em 92 ms, o JS da rota chega aos
           8,8 s e a URL muda aos 9,3 s; com a rota fria, falhou em 4 de 6
           rodadas. Quente: 1,1 e 1,6 s. Build de produção: passa
  causa    compilação sob demanda do next dev 15 — a OS concluída dispara ao
           mesmo tempo a compilação das rotas de foto e de assinatura, e a do
           pacote espera na fila
  status   ACCEPTED DEV-ONLY / NON-BLOCKING (decisão do dono, 21/09/2026) —
           produção não é afetada
  não      o teste NÃO foi afrouxado: um limite maior esconderia também uma
  feito    navegação que de fato não saísse
  opções   aquecer rotas no setup do E2E, ou o dev com Turbopack — decisão do
           dono, fora do SEC-003

Fotos gravadas antes do PC-1 com GPS no arquivo (achado na EV-1, 13/09/2026)
                            FERRAMENTA APROVADA na RC-1E · APPLY NÃO EXECUTADO
  o quê    a limpeza de EXIF (PC-1, 06/09) roda no UPLOAD; a foto gravada antes
           dela continua com os bytes originais. No banco de dev: 1 de 1 foto
           confirmada de OS concluída — a do piloto da OS Nº 6, de 28/08 — ainda
           tem IFD de GPS
  alcance  pré-existente: a mesma rota autorizada já servia esse arquivo na OS
           concluída (ServiceOrderClosingReadOnly); o pacote não amplia quem vê
  hoje     npm run storage:audit (só leitura) acha 3, não 1: a contagem acima
           olhava só OS concluída — as outras duas são etiquetas de uma OS
           ainda em atendimento, todas de 28/08. O dono rodou a auditoria duas
           vezes em 16/09/2026, com os mesmos números (com-gps=3). A
           re-sanitização grava a versão limpa numa chave nova e NÃO sobrescreve
           a original (docs/SECURITY.md §8.25); o hash do fechamento e o
           conteúdo assinado não mudam, porque usam id e categoria, nunca bytes
           — o que NÃO autoriza executá-la
  estado   LEGACY RE-SANITIZATION: DRY-RUN COMPLETE · APPLY NOT EXECUTED ·
           PENDING OWNER OPERATIONAL DECISION
  depois   a cópia ORIGINAL, com GPS, fica no disco sem linha. Manter ou apagar
           essa cópia exige política explícita de retenção — nada a apaga
           automaticamente

PRD — menções antigas a comprovante em PDF (achado na EV-1)
  o quê    §34, §38 e §117 citam PDF/comprovante sem marca de superado; a §383
           (escopo V1, posterior) diz que PDF não é obrigatório na V1
  fase     higiene documental — marcar na §390, sem mudar decisão

Configurações — copy antiga de "próximas versões"        RESOLVIDO na RC-1D
  o quê    /configuracoes prometia que "mais opções de configuração serão
           adicionadas nas próximas versões" — promessa sem data numa tela
           de produto
  onde     src/app/(app)/configuracoes/page.tsx

Storage órfão                             (1) RESOLVIDO na RC-1B · (2) política na RC-1E
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
  política (RC-1E) órfão = chave reconhecida que nenhuma linha de nenhuma
           empresa referencia, com mais de 24 h; o expurgo reconsulta o banco
           antes de cada exclusão (docs/SECURITY.md §8.25). Auditoria repetida
           pelo dono em 16/09/2026, números estáveis: 2.057 arquivos, 2.037
           candidatos, 0 recentes sem linha, 0 não reconhecidos
  grupos   A — 2.032 candidatos de empresas de teste que não existem mais
           (resíduo de teste)
           B — 5 candidatos de empresa EXISTENTE, todos sob o escopo de UMA CTO
           dela: fotos antigas da caixa, substituídas (conferido no banco de
           dev, só leitura, em 16/09/2026). É histórico da caixa, e decidir
           por eles é decisão de RETENÇÃO, própria
  estado   ORPHAN AUDIT: COMPLETE · ORPHAN PURGE: NOT EXECUTED · PENDING OWNER
           OPERATIONAL DECISION — uma decisão por grupo, nunca uma só para os
           2.037
  comando  o expurgo exige escopo (addendum de 16/09/2026): --apply sem escopo
           é recusado; --scope missing-company é o único que apaga (grupo A);
           --scope active-company é recusado até decisão de retenção (grupo
           B); não existe escopo "todos" (docs/SECURITY.md §8.25)

Expurgo de órfãos — o comando não separava os grupos        RESOLVIDO no addendum da RC-1E
  o quê    purgeOrphanFiles / --purge-orphans --apply percorria TODOS os
           candidatos. Os 2.037 do dev têm duas naturezas — resíduo de teste
           (grupo A) e fotos antigas de CTO de empresa existente (grupo B) —, e
           o dono decidiu que cada grupo tem decisão própria
  alcance  nada foi executado; o risco só existe se o comando rodar com --apply
  hoje     o escopo é obrigatório e validado na função: só missing-company
           apaga, active-company é recusado, não existe "todos" — commit
           2c9daf3. Nenhum expurgo real foi executado

Auditoria de storage — volume e adapter futuro (registrado no fechamento da RC-1E)
  o quê    (1) storage:audit carrega TODAS as referências das três colunas numa
           leitura só e percorre o storage inteiro numa execução — serve para o
           tamanho do piloto (20 referências, 2.057 arquivos no dev), não foi
           medido em carteira grande; (2) FileStorageContract.list() e a
           gravação atômica existem só no adapter LOCAL
  requisito um adapter de objeto (S3/R2/MinIO) precisa implementar list(),
           preservar "a chave final ou não existe, ou tem o arquivo inteiro" e
           não seguir nada fora do prefixo — ou declarar o que não preserva
           (docs/CONTEXT-MAP.md, regras da RC-1E)
  fase     KNOWN DEBT — paginação da auditoria quando o volume pedir; adapter de
           objeto só com a decisão de storage de produção (RC-1F)

RC-IMG-DEBT — MULTIPLE EXIF ORIENTATION (achado nos testes da RC-1E)
  status   RESOLVIDO no RC-1 release hardening: vence o PRIMEIRO `Orientation`
           válido do arquivo, e bloco posterior sem a tag não apaga nada —
           ausência não é decisão. Conflito resolve no primeiro, que é o que um
           decodificador honra (o Exif é o primeiro APP1 depois do SOI).
           RC-IMG-01..05 e prova de decodificação no Chromium
           (DECODE-JPEG-MULTI-EXIF)
  o quê    num JPEG com mais de um bloco APP1/Exif, o sanitizador guarda a
           Orientation do ÚLTIMO bloco lido. Se o primeiro tem Orientation e o
           segundo não, a orientação do primeiro deixa de ser preservada, e a
           foto pode aparecer deitada
  medido   visto ao montar o fixture: a base dele já tinha um EXIF sem
           orientação, e o bloco injetado antes perdia a orientação. A
           auditoria de storage do dev não indicou ocorrência real (ela não
           conta blocos EXIF por arquivo; não houve relato de foto deitada)
  onde     stripJpeg em src/lib/media/image-metadata.ts
  fase     correção própria; não bloqueia a RC-1E. A dívida irmã — FF D9
           incidental entre scans de JPEG progressivo — está em
           docs/SECURITY.md §8.25

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

---

## 13. `RC-1D` — UX, copy e observabilidade da CTO

**Estado: `APPROVED` / `CLOSED` (validação do dono em 16/09/2026; entregue em
15/09/2026).** Sem tag; publicação autorizada pelo dono no fechamento, só
fast-forward. **Zero migration, zero dependência, zero rota nova, zero Dart.**

Ela recebeu os débitos de UX do §12 e uma melhoria pequena aprovada pelo dono na
abertura: ao abrir uma CTO, enxergar como estão os clientes dela.

```text
CTO — clientes da caixa      docs/CTO-NETWORK-DISTRIBUTION.md §47, PRD §372
timeline da OS — código cru  RESOLVIDO (rótulo central + varredura do fonte)
copy antiga                  RESOLVIDA (fechamento da OS, "próximas versões",
                             provedor, perfil, plataforma, tipo de conexão)
/minhas-os — "Próximas"      RESOLVIDO (docs/TECHNICIAN-EXECUTION.md §9)
MAPEDIT intermitente         RESOLVIDO (causa provada, §47.6)
acessibilidade               auditoria em e2e/accessibility.spec.ts + 10 campos
                             que só tinham placeholder
```

**A CTO não ganhou autoridade nova.** O resumo é a MESMA função do popup do mapa
e a lista por porta é a MESMA de "Ver clientes" — detalhe e popup não têm como
divergir, e há teste comparando número a número. Nada é persistido, nada é
consultado no provedor, nada é escrito, e as consultas são constantes.

**O MAPEDIT tinha uma causa só para os dois sintomas:** o react-leaflet compara
`position` por REFERÊNCIA, e o array era recriado a cada render — uma releitura
do recorte que chegasse no meio do arrasto devolvia a caixa ao ponto gravado, e
o `dragend` lia o ponto antigo. Reproduzido de forma determinística (`MAPEDIT-15`,
segurando a resposta com o botão do mouse apertado) antes de qualquer correção.

**"Próximas" virou o que o nome diz.** A seção juntava futuro, sem data e
vencido; agora são cinco seções exclusivas, com "Hoje" na frente de "Atrasadas"
(o contrato do `HOTFIX-FIELD-01` continua intacto) e a regra de atrasada vinda do
painel — a mesma, em SQL e em memória, com teste comparando as duas.

**Continua fora:** o storage legado com EXIF, as datas gerais no fuso do
servidor, o botão "Sincronizar Mock ERP", a busca por telefone com máscara, o
`RC-LOC-04` e os demais itens do §12 que não são de UX.

---

## 14. `RC-1D` — o addendum de UX e o `DIAG-AUTO-1`

**Estado: `RC-1D` `APPROVED` / `CLOSED`; `DIAG-AUTO-1` `CODE APPROVED` /
`CLOSED` (validação do dono em 16/09/2026; entregue em 15/09/2026).** Sem tag;
publicação autorizada pelo dono no fechamento, só fast-forward.
**`PRODUCTION SCHEDULER` continua `PENDING RC-1F`** —
o código está aprovado, e a verificação automática **não** está ativa em
produção. **Duas migrations aditivas (uma coluna cada), zero dependência, zero
rota nova, zero Dart.**

A validação da §13 aprovou o conceito de conectividade na CTO e reprovou a
organização visual. No mesmo passo, o dono apontou uma lacuna operacional real:
*"Online · última leitura há 9 dias"* não prova que o cliente continua online.

```text
card "Clientes"          REMOVIDO — repetia a lista e enterrava as portas
                         no celular; o resumo rápido é o popup do MAPA
filtros                  uma faixa que quebra linha, duas unidades separadas
                         por um traço em vez de dois blocos titulados
hierarquia da porta      "Ocupada" e o estado do cliente na MESMA linha
"Cadastro ativo"         não é mais dito; só a exceção aparece
duração × frescor        statusSince (novo) × observedAt — dois campos
leitura desatualizada    aviso de tela, NUNCA um estado; STALE não existe
ciclo automático         npm run diagnostics:refresh, alvo ~5 min
```

**A regra que atravessa a fase:** duração do estado e idade da verificação são
perguntas diferentes. Com o ciclo reconferindo de cinco em cinco minutos,
derivar a primeira de `observedAt` faria todo cliente parecer ter mudado de
estado agora há pouco — e a tela continuaria plausível. É por isso que o teste
central da fase não é de worker, é o de **confusão do técnico**.

**Duas coisas foram medidas antes de serem afirmadas:** dois ciclos simultâneos
duplicavam o trabalho inteiro (seis conexões, doze chamadas ao provider), o que
produziu a reserva; e a capacidade com 600 conexões elegíveis — seleção em 85 ms
com duas consultas, ciclo completo em 6,9 s com concorrência 6.

**Limite declarado, e ele é de operação:** a cadência de 5 minutos depende de o
operador agendar o comando. O repositório não tem agendador — nunca teve —, e
criar um daemon para isto foi recusado pelos mesmos motivos escritos em
`scripts/outbox-worker.ts`. Sem o cron, nada se atualiza sozinho e a tela
**avisa**, em vez de afirmar um estado que ninguém confirmou.

**Continua fora:** flapping e métricas de queda, alerta automático, WhatsApp,
NOC, e os demais itens do §12 que não são de UX. A detecção de instabilidade e a
correlação de incidentes ficaram **registradas** na PRD Parte XX (§422–§429),
`PLANNED` / `POST-V1` / `NOT IMPLEMENTED` — inclusive a decisão de **não**
criar agora a tabela de histórico de transições que elas exigiriam.

**Agendamento em produção: PENDENTE, e não é defeito de código.** O ciclo é um
comando pronto para ser agendado; nenhum agendador existe no repositório — não
há Dockerfile, CI, Procfile nem cron versionado —, e a infraestrutura de
produção é decisão aberta do dono desde a `RC-1A` (junto com o storage de
produção). O contrato de agendamento está em `.env.example`. Até alguém
agendá-lo, **a produção não verifica nada automaticamente**, e a tela diz isso
com "Leitura desatualizada".

---

## 15. `RC-1E` — PHOTOS & STORAGE HARDENING

**Estado: `APPROVED` / `CLOSED` (16/09/2026).** Commits locais, sem tag e sem
push. **Zero migration, zero dependência, zero rota nova, zero Dart.**

**Fechada NÃO significa** re-sanitização legada executada, expurgo de órfãos
executado nem storage de produção resolvido — os três são estados separados,
abaixo.

**Escopo entregue:**

- limpeza de metadado endurecida em JPEG, PNG e WebP (lista de permitidos nos
  três; WebP até o tamanho do RIFF; estrutura mínima exigida);
- auditoria de metadado e GPS em fotos já gravadas;
- mecanismo seguro de re-sanitização legada (chave nova, original preservada);
- auditoria de órfãos, com definição e carência;
- autoridade única de "referenciado" (`src/lib/storage/references.ts`);
- ordem de expurgo endurecida (linha antes do arquivo; limpeza verificada);
- gravação local atômica;
- segurança de caminho e de tenant, provada.

**Validação manual do dono (16/09/2026) — `PASS`:** upload JPEG, PNG e WebP;
exibição da imagem; `npm run storage:audit` executado duas vezes, com os mesmos
números (referências 20 · examinadas 20 · limpas 17 · com metadado 3 · com GPS
3 · ilegíveis 0 · arquivo ausente 0; storage: arquivos 2.057 · órfãos
candidatos 2.037 · de empresa inexistente 2.032 · recentes sem linha 0 · não
reconhecidos 0). **Nenhuma ação destrutiva foi executada.**

```text
STORAGE AUDIT — OWNER VALIDATION   PASS
DRY-RUN REPEATABILITY              PASS
LEGACY RE-SANITIZATION             DRY-RUN COMPLETE · APPLY NOT EXECUTED
                                   PENDING OWNER OPERATIONAL DECISION
ORPHAN AUDIT                       COMPLETE
ORPHAN PURGE                       NOT EXECUTED · PENDING OWNER OPERATIONAL
                                   DECISION (grupo A: 2.032 · grupo B: 5)
PRODUCTION STORAGE                 OWNER DECISION REQUIRED · RC-1F
SCHEDULERS (evidence:cleanup,
  diagnostics:refresh)             PENDING RC-1F
```

O escopo não tinha seção própria nos documentos: ele veio da auditoria `RC-1A`
(que atribuiu à `RC-1E` a re-sanitização legada, a política de órfãos, PNG/WebP
e a ordem de expurgo) e das duas dívidas de storage do §12. O storage de
PRODUÇÃO (`RC-STO-03`) ficou na `RC-1F`, onde a `RC-1A` o pôs.

```text
PNG/WebP (RC-EXIF-09)          lista de PERMITIDOS nos três formatos; WebP para
                               onde o RIFF diz; estrutura mínima exigida
foto legada (RC-EXIF-02)       storage:audit só lê; re-sanitização com --apply
                               grava em chave nova e não destrói a original
órfãos                         definição, carência de 24 h, reconsulta antes de
                               apagar; expurgo só com --apply
expurgo de etiqueta (STO-06)   LINHA antes do arquivo — o banco arbitra a corrida
limpeza de falha (STO-05/07)   só apaga blob que nenhuma linha referencia
gravação local                 atômica: temporário + rename
```

**Uma correção foi achada pelo próprio teste, não pela auditoria:** oito bytes
de assinatura de PNG com lixo curto eram aceitos e gravados como um arquivo de
oito bytes.

**O que depende do dono, e nada disso foi executado:** a re-sanitização das 3
fotos legadas com GPS (e, depois dela, a retenção da cópia original com GPS); o
expurgo do grupo A (2.032 arquivos de resíduo de teste); a retenção ou o
expurgo do grupo B (5 fotos antigas de uma CTO existente) — decisão própria; e o
storage de produção, na `RC-1F`. O comando de expurgo exige escopo desde o
addendum de segurança: só `missing-company` apaga, e o grupo B é recusado até a
decisão de retenção (§12). Detalhe e contrato em `docs/SECURITY.md` §8.25.

**Gates:** 2971 Vitest (143 arquivos), 365 Playwright, lint, tsc, build,
`build:worker`, `prisma validate`, 29 migrations — nenhuma nova. **20 sabotagens, 20
detectadas** — e uma delas cobrou um teste meu antes: voltar a apagar o arquivo
antes da linha passava pelo caso "etiqueta promovida", porque a promoção era
feita ANTES de o expurgo conferir o vínculo, e a conferência já protegia. A
corrida real é a promoção entre a conferência e a exclusão; o teste passou a
promovê-la exatamente ali.

---

## 16. `RC-1F` — PRODUCTION READINESS · descoberta

**Estado: `OWNER DECISION REQUIRED` (17/09/2026).** Descoberta de escopo, **zero
código**: nenhuma migration, nenhuma dependência, nenhum arquivo de
infraestrutura, nenhum agendador ativado e **nenhuma chamada ao provider real**.

**O escopo que os documentos dão à `RC-1F`:**

- storage de produção — raiz, volume, backup (`RC-STO-03`; §15,
  `docs/SECURITY.md` §8.25), e a decisão de adapter de objeto (§12);
- agendamento de `diagnostics:refresh` (§14) e de `evidence:cleanup` (§15,
  `docs/SECURITY.md` §8.25, PRD §250 `CLEANUP-01`);
- calibração do provider real (`docs/CTO-NETWORK-DISTRIBUTION.md` §48.5).

A auditoria `RC-1A` — registrada na sessão, não em documento — pôs mais itens na
`RC-1F`: proxy e variáveis (`RC-SEC-02`), o limitador de diagnóstico em memória
(`RC-DIAG-01`), leituras sem teto no painel e em listas (`RC-PERF-01/02`), o
cron do outbox e o pipeline de deploy (`RC-OPS-01/02`), tiles contratados
(`RC-MAP-02`, PRD §365), a regressão completa, o plano de validação móvel e o
piloto. **Quais desses entram é decisão do dono.**

**Não existe ambiente de produção decidido.** Nenhum documento nomeia
hospedagem, e o repositório não tem Dockerfile, CI, Procfile, unit de systemd,
configuração de proxy nem cron versionado. O que o código exige de qualquer
hospedagem:

```text
runtime     Node 20+ · next build + next start (sem output standalone)
instância   UMA — o limitador de diagnóstico e a fila do bcrypt vivem no processo
banco       PostgreSQL 15+ · prisma migrate deploy (a CLI é devDependency)
storage     disco persistente · STORAGE_ROOT hoje é relativo ao cwd (.storage)
agendador   três comandos one-shot, com o MESMO .env e o MESMO storage:
            outbox:work (1 min) · diagnostics:refresh (5 min) ·
            evidence:cleanup (diário)
proxy       HTTPS · limite de corpo no maior teto de upload (§8.21) ·
            TRUSTED_PROXY_HOPS e APP_ORIGINS
saída       HTTPS para o ERP, o FCM e o provedor de tiles
```

**Dry-run no banco de desenvolvimento (17/09/2026):** `vinculos=14
elegiveis=14`, todos de uma empresa com ReceitaNet **de produção** e credencial;
2 nunca verificados; **3 com `externalId`** — só esses chegariam à rede (até 6
requisições); os outros 11 falham antes dela. Tabela de snapshots idêntica antes
e depois.

**Achados da descoberta** — registrados como estavam; tratados na `RC-1F-A` (§17):

```text
DIAG-OVERLAP-01  a reserva confere só o prazo, não o frescor. Um ciclo cuja lista
                 foi lida antes de outro verificar o cliente o consulta de novo
                 depois dos 60 s da reserva: chamada duplicada ao provider.
                 PROVADO por sonda fora do repositório. O .env.example chama o
                 intervalo menor de seguro: é seguro para o dado, não para o
                 número de chamadas — mais voltas sobrepostas, mais duplicatas
DIAG-STARV-01    verificação que sempre falha (sem externalId, cliente que o ERP
                 não conhece, erro persistente) não grava nada e continua
                 elegível. Com a lista sem ordem e cortada no teto (300), 300
                 desses ocupam todas as voltas e os demais nunca são visitados.
                 PROVADO por sonda. Também inflam falhasProvider
DIAG-CADENCE-01  com cron de 5 min e alvo de 5 min, o cliente verificado segundos
                 depois do disparo NÃO é elegível no disparo seguinte (a última
                 leitura é posterior ao corte): a revisita real fica em ~10 min,
                 e o aviso "Leitura desatualizada" (> 10 min) pode acender por
                 segundos antes da volta seguinte. PROVADO por sonda. Cron de 1
                 min resolve a cadência e agrava DIAG-OVERLAP-01
DIAG-CALLS-01    uma verificação ReceitaNet são DUAS requisições
                 (verificar-acesso + /v1/cliente, a segunda best-effort): o teto
                 de 300 é até 600 requisições, e a conta do §48.5 supõe uma.
                 Deduzido do código
DIAG-ORPHAN-01   o prazo de 8 s solta a vaga e não cancela a requisição, e a
                 segunda pode sair depois do prazo: com o provider lento, há mais
                 requisições em voo que a concorrência. Deduzido do código
ENV-01           DIAGNOSTICS_REFRESH_BATCH_LIMIT/CONCURRENCY aceitam fração e
                 expoente, sem teto ("60" no lugar de "6" passa);
                 OUTBOX_BATCH_LIMIT não é validado nem documentado; STORAGE_ROOT
                 não está no .env.example; TRUSTED_PROXY_HOPS inválido vira 0 em
                 silêncio; CUSTOMER_CREDENTIAL_ENCRYPTION_KEY não é conferida na
                 subida
```

**Backup — o que independe da hospedagem (proposto, não adotado):** banco e
storage juntos, e as chaves de cifra **fora** do backup (sem
`ERP_CREDENTIAL_ENCRYPTION_KEY` e `CUSTOMER_CREDENTIAL_ENCRYPTION_KEY`, o banco
restaurado tem credenciais ilegíveis). A ordem é **banco primeiro, storage
depois**: o arquivo é gravado antes da linha e a linha sai antes do arquivo, então
a cópia posterior do storage contém tudo o que o dump referencia — menos o que
`evidence:cleanup` ou um expurgo apagar no intervalo, por isso nenhum dos dois
roda durante o backup. Depois de restaurar, `npm run storage:audit` (só leitura)
conta arquivos ausentes. Frequência, retenção e local são do dono.

**Decisões do dono:** hospedagem; storage de produção (disco persistente ou
objeto); backup (frequência, retenção, local, teste de restauração); o escopo da
`RC-1F` diante dos itens da `RC-1A`; `DIAG-OVERLAP-01`, `DIAG-STARV-01` e
`DIAG-CADENCE-01` antes de ativar o ciclo (decidido: corrigidos na `RC-1F-A`,
§17); a CLI do Prisma na
implantação; o provedor de tiles; e a primeira validação real do provider, com
quantidade mostrada antes.

---

## 17. `RC-1F-A` — DIAGNOSTICS SCHEDULER CORRECTNESS / FAIRNESS / CADENCE

**Estado: `READY FOR OWNER REVIEW` (17/09/2026).** Commits locais, sem push e sem
tag. **Zero migration, zero dependência, zero UI, zero Dart, e nenhuma chamada a
provider real** (ReceitaNet e SGP). Registro técnico em
`docs/CTO-NETWORK-DISTRIBUTION.md` §48.10.

```text
DIAG-OVERLAP-01   RESOLVIDO    a reserva relê o frescor antes de chamar (skippedFresh)
DIAG-STARV-01     RESOLVIDO    ordem justa: com leitura, tentada há mais tempo primeiro
                               (carimbo de refreshLeaseUntil, sem coluna nova); sem
                               leitura, sorteio por volta; o teto conta tentativas
                               que chegam ao provider
DIAG-CADENCE-01   CONTRATO     tick 1 min · alvo 5 min · aviso 10 min — PLANEJADO,
                               revisita entre 5 e 6 min
DIAG-CALLS-01     DOCUMENTADO  até 2 requisições por verificação ReceitaNet; volta
                               ≤ teto × 2; em voo ≤ concorrência
DIAG-ORPHAN-01    RESOLVIDO    o prazo cancela a rede (adapter ReceitaNet) e o
                               cliente HTTP o mantém até ler o corpo
ENV-01            RESOLVIDO    teto, concorrência e lote do outbox: inteiro positivo,
                               saída 2 nomeando a variável; TRUSTED_PROXY_HOPS e
                               CUSTOMER_CREDENTIAL_ENCRYPTION_KEY conferidas na subida
                  PENDENTE     STORAGE_ROOT — depende da hospedagem (RC-1F-B)
```

```text
DIAGNOSTICS SCHEDULER       CODE READY — não ACTIVE; ativação é a RC-1F-B
PRODUCTION HOSTING          OWNER DECISION REQUIRED (§16)
SGP REAL VALIDATION         PENDING API ACCESS
PROVIDER CAPACITY           NOT YET MEASURED
```

**Gates:** 3050 Vitest (147 arquivos; eram 2984), lint, tsc, build, `build:worker`,
`prisma validate`, 29 migrations — nenhuma nova. Playwright não repetido: nenhum
arquivo web mudou (365/365 da `RC-1E`). **14 sabotagens, 14 detectadas.** Na primeira
rodada, as duas que removem o cancelamento caíram só nos testes do prazo e
atravessaram o teste de concorrência do ciclo, que passava sem usar a rede;
corrigido, ele as derruba também. Dry-run no banco de dev com o código novo: 14
vínculos, 14 elegíveis, snapshots idênticos antes e depois.

**Limites declarados:**

- **Sem leitura, a justiça é probabilística.** Não há onde registrar a tentativa
  de quem nunca foi verificado sem fabricar snapshot (proibido); o sorteio por
  volta dá a cada um a mesma chance, sem garantia de pior caso.
- **O cancelamento é do adapter, não da interface.** `ERPDiagnosticsCapability`
  não recebe sinal; um adapter novo que fale HTTP precisa honrar o prazo sozinho.
- **Sem teto superior** para teto, concorrência e lote do outbox — só inteiro
  positivo.

**Decisões do dono:**

- `OWNER DECISION REQUIRED — DIAGNOSTICS LIMITS`: tetos superiores. Proposta, não
  adotada: concorrência ≤ 12 (o maior valor medido, sinteticamente, no §48.5),
  teto por volta ≤ 1.000, lote do outbox ≤ 500.
- `OWNER DECISION REQUIRED — DIAGNOSTICS PROVIDER CONTRACT CHANGE`: passar o sinal
  de cancelamento pela interface, para a garantia valer para qualquer adapter.
- As do §16 continuam abertas: hospedagem, storage, backup, escopo da `RC-1F`,
  CLI do Prisma, tiles e a primeira validação real do provider.

### 17.1. Addendum final — as três decisões do dono (17/09/2026)

**Estado: `APPROVED` / `CLOSED` (17/09/2026).** Aprovado pelo dono: justiça
determinística, contrato de cancelamento do provider, cancelamento no ReceitaNet,
os três tetos e a cadência planejada. Sem tag; publicação em `origin/main`
autorizada pelo dono no fechamento, só fast-forward. **Aprovar o código não ativa
nada:** `DIAGNOSTICS SCHEDULER — CODE READY`, não `ACTIVE`, e nenhum cron existe.
Zero migration, zero dependência, zero UI, zero Dart, **nenhuma chamada a provider
real**. Os três "limites declarados" acima foram fechados:

```text
A  TETOS          concorrência 1..12 (padrão 6) · teto do ciclo 1..1000 (300)
                  · lote do outbox 1..500 (50); padrões inalterados
B  CANCELAMENTO   contrato multi-provider: fetchCustomerConnectivity(ref,
                  context) com AbortSignal de runWithDiagnosticDeadline
C  JUSTIÇA        nunca verificados em ordem estável por id, girada por tick —
                  sem sorteio, com limite: ceil(N / passo) ticks
```

**Justiça determinística, sem migration.** Não há onde registrar a tentativa de
quem nunca foi verificado (snapshot falso continua proibido), então o progresso
vem do relógio da volta: a fila é ordenada por id e o começo anda `passo`
posições por tick. Toda volta que termina consome pelo menos `ceil(teto/2)`
posições dessa fila e o passo nunca passa disso, então **com uma volta por tick e
conjunto estável todo candidato é tentado em no máximo `ceil(N / passo)` ticks**
(teto 1 → N ticks). O passo é primo com N para que um cron mais espaçado que o
contrato não volte sempre ao mesmo começo; a garantia com agendamento a cada
`k` ticks exige que a janela cubra `mdc(k, N)`. **Limite declarado:** a garantia
supõe o conjunto estável; entradas novas a cada tick podem adiar um candidato.

**O cancelamento virou contrato.** `ERPDiagnosticsRequestContext` é argumento
obrigatório; `runWithDiagnosticDeadline` cria o sinal, aborta no prazo, deixa um
adapter que o honra responder na mesma volta do event loop (um estado já lido
vale, sem os extras) e dá `TIMEOUT` logo depois a quem o ignora. O ReceitaNet
passou a usar o sinal do contrato nas duas requisições, sem relógio próprio. **SGP
REAL VALIDATION — PENDING API ACCESS:** o `SgpAdapter` não tem diagnóstico, e
quando tiver recebe o mesmo contexto.

```text
DIAGNOSTICS SCHEDULER   CODE READY — não ACTIVE (RC-1F-B)
CADÊNCIA PLANEJADA      tick 1 min · alvo 5 min · aviso 10 min
PROVIDER CAPACITY       NOT YET MEASURED
```

**Gates:** **3066 Vitest** (148 arquivos; eram 3050), lint, tsc, build, `build:worker`, `prisma validate`, 29 migrations — nenhuma nova; Playwright não repetido (nenhum arquivo web mudou). A primeira rodada completa teve lint e build vermelhos por uma variável não usada no teste de justiça (corrigida) e a falha conhecida do `login-flood` (um 500 no flood, §12; 3 de 3 isolado); a segunda rodada saiu toda verde. **Nove sabotagens, nove detectadas** — justiça sorteada, rotação parada, contexto não repassado, sinal que nunca aborta, ReceitaNet ignorando o sinal, os três tetos removidos e a tolerância depois do aborto removida.

**Continuam abertas (§16):** hospedagem, storage, backup, escopo da `RC-1F`, CLI
do Prisma, tiles e a primeira validação real do provider.

### 17.2. Diagnóstico de um cliente e a primeira validação real (17/09/2026)

**`--customer-id` — `APPROVED` pelo dono como ferramenta oficial de diagnóstico
controlado.** `npm run diagnostics:refresh -- --customer-id <id interno>` roda a
MESMA volta com a seleção estreitada em SQL a um cliente. Reserva, frescor,
primeira verificação, prazo, cancelamento e escrita são os da volta normal; o
filtro **não força nada** — cliente recente, reservado ou desligado não é
consultado, e nenhum outro é escolhido no lugar. `teto=1` não servia: limita
quantos, não QUEM. Sem nome de provider, sem id de ERP, sem busca por nome; flag
malformada sai com 2. Testes `SINGLE-DIAG-01..05` e `CMD-ENV-04`; duas
sabotagens, duas detectadas (filtro removido do SQL; comando que não repassa a
flag).

**REAL PROVIDER VALIDATION — RECEITANET.** Com autorização do dono, um cliente de
validação (Ademir / QA validation), o PPPoE alternado no ERP pelo dono:

```text
ONLINE  -> OFFLINE   PASS   provider status 2 · statusSince novo
OFFLINE -> ONLINE    PASS   provider status 1 · statusSince novo
verificações reais   2      requisições HTTP 4 (verificar-acesso + detalhe)
outros clientes      0      os demais snapshots idênticos antes e depois
```

Cada execução teve prévia sem rede, um guarda externo que bloquearia a terceira
requisição, host ou caminho inesperado, e leitura do read model da CTO. A
"primeira validação real do provider" da lista acima está feita — para UM
cliente, nos dois sentidos. **Não está medida a capacidade**
(`PROVIDER CAPACITY — NOT YET MEASURED`), e **`DIAGNOSTICS SCHEDULER` continua
`CODE READY`, não `ACTIVE`.** SGP: `REAL VALIDATION — PENDING API ACCESS`.

---

## 18. `RC-1F-B` — VPS LINUX: IMPLANTAÇÃO, STORAGE, BACKUP E AGENDADORES

**Estado: `READY FOR VPS PROVISIONING` (17/09/2026).** Commits locais, sem tag e
sem push. **Nenhum deploy aconteceu**: não existe VPS, domínio, certificado,
banco de produção nem cron instalado, e nenhuma chamada a provider real foi
feita. Zero migration, zero dependência nova. O contrato inteiro está em
`docs/DEPLOYMENT.md`; os modelos, em `deploy/`.

**Arquitetura aprovada pelo dono:** VPS Linux (Ubuntu 24.04 LTS), instância
ÚNICA, Nginx com HTTPS, `systemd` para o web, PostgreSQL no próprio VPS, storage
local persistente, `cron` do sistema para os comandos one-shot, backup com cópia
externa. Sem Docker, sem Kubernetes, sem painel, sem armazenamento de objeto.

```text
runtime      Node 24 LTS (piso 20.11) · next build + next start
instância    UMA — limitadores e fila de bcrypt vivem na memória do processo
banco        PostgreSQL 16, só em loopback · prisma migrate deploy
storage      /srv/alfaos/storage — FORA do release, exigido pela aplicação
ambiente     /etc/alfaos/alfaos.env — a MESMA fonte para web e comandos
agendadores  outbox 1 min (ativo) · diagnóstico 1 min (COMENTADO) ·
             expurgo de etiqueta 03:15 · backup 02:00
```

**O único código de produção da fase é a raiz de armazenamento.** Ela era lida
direto do ambiente com `.storage` como padrão relativo; em produção isso cai
DENTRO do release, e o deploy seguinte deixa fotos, assinaturas e fotos de CTO
para trás com o banco ainda apontando para elas — descoberto meses depois, ao
abrir uma OS antiga. Agora `resolveStorageRoot` é a autoridade única (adapter e
subida) e, em produção, exige caminho **absoluto**, fora da aplicação (e que não
a contenha) e fora do temporário. A subida falha nomeando a variável; a única
exceção é `next build`, que não grava arquivo nenhum.

**O que os testes prendem.** Os modelos não rodam aqui — rodam num servidor que
ninguém nesta fase vê —, então `OPS-*` confere cada afirmação contra o código:
`ExecStart` chama script que existe; o teto de corpo do Nginx é calculado dos
tetos reais de upload (8 MiB + 64 KiB); os cabeçalhos encaminhados correspondem
ao que o limitador lê com `TRUSTED_PROXY_HOPS=1`; toda linha do cron aponta para
comando real, pelo invólucro que carrega o ambiente autoritativo; nenhuma
operação destrutiva é agendada; e o storage não tem `location` no Nginx.

**Decisões que não devem ser desfeitas:** o expurgo de etiqueta **não** é o
expurgo de órfãos (o segundo continua manual, com escopo e decisão do dono); a
exclusão por `flock` existe **só** entre backup e expurgo de etiqueta, porque
outbox e diagnóstico já se arbitram no banco; e as chaves de cifra ficam **fora**
do backup, guardadas à parte — sem elas, o banco restaurado tem credencial
ilegível.

### 18.1. Addendum: o backup precisa de uma janela (17/09/2026)

**A afirmação anterior estava ERRADA e foi corrigida.** Este plano dizia que
copiar o banco primeiro e o storage depois, com o web no ar, só podia produzir
arquivo órfão — nunca linha sem arquivo. O contraexemplo é banal: o dump grava
a linha da evidência X, o técnico apaga essa evidência pela aplicação, a
aplicação apaga o arquivo X (`removeEvidence`) e o `tar` roda depois. Restaurar
dá um banco que referencia uma foto que o backup não tem, e ninguém percebe até
abrir a OS. A assinatura substituída tem a mesma forma.

**Decisão do dono: janela de manutenção curta na V1.** O backup trava contra o
expurgo de etiqueta, **para o `alfaos-web`**, prova que parou (se não provar,
ABORTA sem copiar nada), faz o dump, arquiva o storage, **sobe o serviço**, só
então promove a geração e faz a cópia externa. Um `trap` de saída sobe o serviço
em qualquer caminho de falha, e um serviço que não volta é falha crítica com
saída diferente de zero — nunca um aviso. Nada de lock distribuído, modo de
manutenção, tabela nova ou dependência.

**Cada execução é uma GERAÇÃO:** um id para os dois artefatos mais um manifesto
com `sha256`, tamanhos e `status=COMPLETE`, escrito por último — a retenção
(7/4/3) só rotaciona gerações completas, e a restauração escolhe **uma**
geração, nunca mistura. **Parar unidade é de root**, então o backup saiu do
`crontab` do usuário de serviço e virou `alfaos-backup.service` + `.timer`
(02:00); o `alfaos` continua **sem sudo**, e os backups ficam de root em
`/var/backups/alfaos`.

**Inventário de quem mexe no storage** (e um teste de cobertura que falha se
aparecer superfície nova): web — evidência, assinatura, foto de CTO e limpeza de
blob sem linha; worker — `evidence:cleanup`; manual — expurgo de órfãos e
re-sanitização. **`outbox:work` e `diagnostics:refresh` não tocam arquivo**,
verificado no código, e por isso podem continuar rodando durante a janela.

**O que a janela garante, dito com precisão.** O PostgreSQL **não** é congelado.
O `pg_dump` é um retrato consistente do banco; o que a janela acrescenta é que
**toda linha desse retrato que aponta para um arquivo tem o arquivo dentro do
`tar`**. O resultado é uma **geração consistente em REFERÊNCIAS DE STORAGE**, e
não um congelamento geral — por isso diagnóstico e outbox podem continuar: o que
eles gravarem depois do dump não está naquela geração, e isso é correto.

### 18.2. Fechamento: aprovada, e nada provisionado (17/09/2026)

**`RC-1F-B` — `APPROVED` / `CLOSED`.** O dono aprovou a arquitetura (VPS Linux,
instância única, Nginx, systemd, PostgreSQL, `STORAGE_ROOT` persistente, cron do
sistema, backup externo obrigatório) e o contrato de backup com janela.
**Aprovar não provisionou nada:** a VPS não será contratada agora, e a produção
será ativada quando o aplicativo estiver perto da publicação.

```text
RC-1F-B                 APPROVED · CLOSED — código e documentação prontos
VPS PROVISIONING        DEFERRED UNTIL PUBLICATION READINESS
PRODUCTION DEPLOY       NOT EXECUTED
CRONS                   NOT ACTIVE
DIAGNOSTICS SCHEDULER   CONFIGURADO — NÃO ATIVO (linha comentada; fase F)
RESTORE DRILL           PENDING VPS/STAGING VALIDATION
OFF-SITE BACKUP         OWNER DECISION REQUIRED — DESTINO NÃO ESCOLHIDO
HEALTH ENDPOINT         DEFERRED — NÃO REQUERIDO PARA A V1 (decisão do dono);
                        operação usa systemctl status, journalctl e o Nginx
PROVIDER CAPACITY       NOT YET MEASURED
RECEITANET ROUND-TRIP   PASS (um cliente, §17.2) · SGP PENDING API ACCESS
```

**Gates:** ver o relatório da fase. **Dez sabotagens, dez detectadas** — e duas
cobraram os testes antes de cair: o backup que copia o diretório errado passava
por uma asserção que aceitava qualquer `tar`, e a restauração sem as chaves
passava porque o nome delas aparecia noutra seção do documento.

**Continua com o dono:** VPS e domínio, destino do backup externo, a rota de
saúde, e a ativação do diagnóstico recorrente — que só acontece depois de ele
ver o `dry-run` no servidor (fase F de `docs/DEPLOYMENT.md`).

---

## 19. `RC-1G` — RELEASE HARDENING DOS DÉBITOS DO §12

**Estado: `READY FOR OWNER VALIDATION` (17/09/2026).** Commits locais, sem tag e
sem push. **Zero migration, zero dependência, zero produto novo, zero Dart.** A
`RC-1` continua ABERTA: falta a revisão de segurança independente, e depois
produção e piloto.

**Escopo, e só ele:** os débitos do §12 que são desenvolvimento, mais a
verificação de cobertura da PRD §382 e a correção de status desta lista. Os
itens de decisão do dono (backfill `RC-LOC-04`, re-sanitização legada, expurgo
de órfãos, normalização de telefone/documento, tela do técnico, identidade de
`Equipment`) e tudo o que é pós-V1 continuam fora.

```text
A  fuso da empresa        RESOLVIDO — toda tela formata pelo relógio da empresa
B  RC-IMG-DEBT            RESOLVIDO — vence o PRIMEIRO Orientation do arquivo
C  login-flood            MECANISMO PROVADO (pool frio, não é o login);
                          teste aquece o pool · LOGIN-TRANSPORT fixa o 500
D  ZOOMVIS-08/09          FECHADO no §20 — leitura sem guarda de uma camada
                          nunca esperada; produção INALTERADA
E  PRD §382               FECHADO no §20 — a cobertura era 0/9 e não havia
                          como configurar pelo produto; hoje 9/9
F  status dos documentos  §12 e §1 corrigidos
```

**A data da tela é o relógio da EMPRESA.** `Intl.DateTimeFormat` sem `timeZone`
formata no fuso do PROCESSO — em produção, UTC. `/minhas-os` já decidia "Hoje"
e "Atrasadas" por `Company.timezone` e escrevia ao lado a data do servidor: a
mesma OS aparecia em "Hoje" com a data de amanhã. Agora `company-datetime.ts`
formata (com o fuso como argumento OBRIGATÓRIO — esquecer não compila) e
`company-timezone.ts` é o único leitor da coluna para tela, com
`companySliceClock` delegando a ele. Um teste estrutural recusa
`Intl.DateTimeFormat` sem `timeZone` em `src/app`, e o E2E põe a empresa em
`Asia/Tokyo` — doze horas de distância, para a data mudar de DIA e o teste não
passar por acidente.

**Um JPEG pode ter mais de um bloco EXIF**, e a limpeza sobrescrevia a
orientação a cada um: o segundo bloco, SEM a tag, apagava a do primeiro e a foto
vinha deitada — justamente o que a limpeza existe para preservar, já que o
AlfaOS não decodifica imagem. Vence o primeiro valor válido, que é o que um
decodificador honra; ausência posterior não apaga nada; conflito resolve no
primeiro. Provado também em JPEG real, decodificado pelo Chromium.

**O 500 do `login-flood` não é do login.** Rajada de 13 requisições com o pool
do Prisma FRIO abre ~8 conexões de uma vez; neste ambiente elas atravessam o
port proxy do Docker Desktop, um connect é recusado, e o `P1001` vira 500 —
corretamente, porque banco fora do ar não é regra de negócio. Sonda com
controle: rajada 1495 consultas → 2 falhas; sequencial 975 → 0. O teste passou a
aquecer o pool, **sem afrouxar asserção nenhuma**, e `LOGIN-TRANSPORT-01..05`
fixa o contrato que protege o produto: erro de transporte é 500, nunca 401 e
nunca 429, com controle positivo de que senha errada continua 401. **Nada de
retry no caminho do login** — em produção o Postgres é local, sem proxy, e
mascarar `P1001` esconderia indisponibilidade real.

**`ZOOMVIS-08/09` NÃO foi reproduzido** — nem ocioso nem com a CPU estrangulada
em 20×, com uma sonda amostrando a largura do alvo a cada 25 ms. O que mudou é
só a sincronização do teste: em vez de dormir 400 ms, ele espera a animação
acabar e a escala do zoom novo estar aplicada. **Produção inalterada**, e a
causa continua registrada como aberta — higiene de teste não é explicação.

**PRD §382 — cobertura de checklist.** O mecanismo existe desde a v0.10 e a §382
pede verificação, não reimplementação. O que decide cobertura é a precedência
`template do tipo → template PADRÃO da empresa`, e ela não tinha teste: agora
`CHK-COV-01..07` a fixa, incluindo que o padrão cobre o catálogo inteiro e a OS
importada (que não tem `typeId`), que template inativo não cobre e que template
de outra empresa nunca alcança. **Nenhum nome de tipo é afirmado** — nomes são
dado da empresa. **Auditoria do banco de desenvolvimento (só leitura):** a
empresa real tem 9 tipos e **nenhum** template; a configuração do conteúdo é do
provedor, não do código.

**Continua aberto e é do dono:** a decisão sobre os débitos do §12 que exigem
decisão; a revisão de segurança independente, que é a próxima fase da `RC-1` e
tem de ser feita por quem não implementou estas correções.

---

## 20. `RC-1` — PRD §382 FECHADO, E O QUE ELE COBRAVA NÃO ERA CÓDIGO

`READY FOR OWNER VALIDATION` (18/09/2026). **Zero migration, zero dependência,
zero Dart, zero chamada a provider.**

**A verificação que a §19 deixou pendente reprovou: 0 de 9 tipos cobertos** — e
a medição seguinte mostrou que faltavam DUAS coisas, não uma. Template ausente
é metade; a outra é `ServiceOrderCompletionPolicy.requireChecklist`, sem a qual
`validateServiceOrderCompletion` sai depois do relatório e não exige checklist
nenhum. As duas dimensões passaram a ser medidas juntas.

**A causa da cobertura zero era de PRODUTO:** as duas superfícies existiam só
como API. `/tipos-os` administrava tipos e não citava checklist, o seed não cria
template, e nenhuma tela chamava `PUT /api/checklist-templates`. Um provedor não
configura cobertura por `curl` — então a §382 não tinha como ser atendida em
produção, por mais correto que o motor estivesse.

**O que entrou:** o editor de checklist dentro de `/tipos-os` (padrão da empresa
e por tipo, item obrigatório, reordenar, desativar) e o interruptor *Exigir
checklist para concluir*. Mais duas peças que o domínio não tinha: a leitura por
empresa — que a rota passou a usar também, para não existirem duas verdades — e
a **desativação** de um template, porque salvar sempre reativa e sem ela o único
caminho de volta era apagar os itens.

**O interruptor de política reenvia todos os campos que leu.** A API substitui a
política inteira; mandar só `requireChecklist` apagaria em silêncio a exigência
de assinatura, de evidência e de equipamento daquele tipo.

**`CHK-NULL-01` — dívida de compatibilidade aceita.** OS sem tipo recebe o
padrão como ORIENTAÇÃO e não é bloqueada por ele: a política é chaveada por
tipo. Não se inventou tipo falso, não se reescreveu OS histórica, não se mexeu
no schema. A cópia da tela diz isso ao operador.

**Configuração do tenant de DEV pelo caminho de domínio** (os mesmos serviços
que a tela chama, nunca SQL): 0/9 → **9/9**, padrão da empresa ativo com 4
itens. Reexecutada, não duplicou nada — 10 templates, 54 itens, 9 políticas.

**Sete sabotagens, sete detectadas**, cada uma com o diff provado entrando e
saindo. A que mais importa é a `S5`: a tela anuncia "Checklist salvo." e não
persiste — o detector é a RELEITURA, e ela acusa "Sem checklist". Uma tela que
mente sobre ter salvo é pior que uma que falha.

**Débito registrado, sem correção:** o intermitente do fechamento mobile
(`toBeInViewport` ratio 0) continua `OPEN / NON-BLOCKING`. A corrida está
MEDIDA — `signAndSave` volta antes de o `router.refresh()` chegar, e o bloco de
assinatura empurra o botão 68 px depois do scroll —, mas 68 px não tiram o botão
de uma viewport de 844, então a falha observada não está explicada e nenhuma
correção especulativa foi aplicada.

---

## 21. `RC-1` — VALIDAÇÃO FÍSICA DO §382 E O SELO DE ESTADO DAS SEÇÕES

`READY FOR FINAL OWNER VALIDATION` (20/09/2026). **Zero migration, zero
dependência, zero rota, zero schema; o diff de produção é Flutter.**

**PRD §382 — validação física do dono: `PASS`.** No aparelho real, com o APK
existente: o conteúdo editado do checklist persistiu depois do F5, chegou ao
Field, a Instalação mostrou os 6 itens, 5 de 6 bloquearam a conclusão, o erro
**nomeou o item que faltava**, e com 6 de 6 o fechamento liberou e a OS foi
concluída. É a prova de ponta a ponta que nenhum teste substitui: configuração
na web → snapshot no aparelho → bloqueio → liberação.

**O achado da validação era de UX, e era mais largo do que pareceu.** O dono
apontou que "Equipamentos instalados" não dizia se estava pendente ou
concluído. O inventário mostrou que **só o Relatório tinha selo**: check-in,
checklist, fotos, materiais, equipamento e assinatura não tinham nenhum.

**O estado vem do SERVIDOR, e o atalho óbvio estaria errado.** `requirements`
(a política do tipo) diz o que é exigido e `pendencies` (o resultado de
`validateServiceOrderCompletion`) diz o que falta — os dois já vinham no pacote
da execução. "Lista vazia = pendente" pintaria de âmbar um equipamento vazio
numa OS que não exige equipamento, que é um atendimento correto; e o aviso que
aparece onde não é preciso é o aviso que o técnico aprende a ignorar.

A condição de "satisfeito" do equipamento é a do servidor, letra por letra:
`requireEquipment` com `count === 0` produz `EQUIPMENT_REQUIRED`. **A barra de
progresso passou a ler os MESMOS getters**, então barra e selos não têm como
discordar — antes eram duas derivações do mesmo fato.

**Três sabotagens, três detectadas**, cada uma com o diff provado entrando e
saindo: exigido+vazio virar neutro, não exigido+vazio virar pendente, e o selo
de concluído sumir da tela.

**Auditoria de conectividade — DEFEITO DE COPY ENCONTRADO, NÃO CORRIGIDO.** A
tela de OS do **Field** escreve o estado e a idade lado a lado e produz
*"Online há 25 d"*. O número sai de **`observedAt`** (a idade da última
observação), e não de `statusSince` (desde quando o estado dura) — e a frase é
lida como duração. O DTO do Field (`src/lib/field/service-orders.ts`) manda
**só** `connectivityStatus` e `observedAt`: `statusSince` **não chega ao
aplicativo**, e não existe nenhum conceito de frescor lá — nem limiar, nem
sinal. A web não tem o defeito: a `CustomerDiagnosticPanel` rotula o valor como
*"Última atualização"*, e o detalhe da CTO usa `connectivityStatusDuration`,
que existe justamente para forçar a distinção no tipo. **Nada foi alterado**:
a correção é decisão de produto (rótulo e/ou envio de `statusSince` ao Field),
e §11 do enunciado manda reportar o comportamento atual antes de mexer.

---

## 22. `RC-1` — CONECTIVIDADE NA OS: DURAÇÃO DO ESTADO ≠ IDADE DA VERIFICAÇÃO

`READY FOR FINAL OWNER VALIDATION` (20/09/2026). **Zero migration, zero
dependência, zero rota nova, zero schema.**

**O defeito, visto em aparelho real:** a OS do Field escrevia *"Online há
25 d"*. A frase afirma há quanto tempo o cliente está no ar, e o número saía de
`observedAt` — quando o provedor CONFERIU pela última vez. Com o ciclo
reconferindo de 5 em 5 minutos, *"online há 25 dias"* e *"verificado há 3
minutos"* são verdadeiros ao mesmo tempo, e a tela dizia a segunda coisa com as
palavras da primeira.

**O aplicativo não tinha como acertar:** `statusSince` **não era enviado** a
ele, e não havia nenhum sinal de frescor no DTO. Não era escolha de redação —
era ausência de dado.

```text
statusSince   desde quando o estado atual dura     "Online há 25 d"
observedAt    quando o provedor confirmou          "Verificado há 3 min"
stale         a confirmação envelheceu (SERVIDOR)  "Leitura desatualizada"
```

**Quem decide o frescor é o SERVIDOR**, como já era na web: `connectivity-
policy.ts` é dona do alvo e do limiar, e a tela só pinta. Um limiar compilado
no APK discordaria de um ambiente que alongasse o alvo por variável — e o
aparelho em campo é exatamente o que não se atualiza junto com a configuração.

**`stale` NÃO é um quarto estado.** Os estados continuam `ONLINE`, `OFFLINE` e
`UNKNOWN`. Um quarto valor faria a tela escolher entre mostrar o estado e
mostrar que a leitura é velha, quando os dois fatos são verdadeiros juntos — e
é por isso que o aviso é uma linha ao lado, nunca um rótulo no lugar.

**`UNKNOWN` continua "Desconhecido" na OS, e isso é a regra canônica**, não
esquecimento: `connectivity-presentation.ts` guarda as duas grafias na mesma
linha de propósito — *"Sem leitura"* é a do MAPA, onde se varrem dezenas de
pontos, e *"Desconhecido"* é a da tela de OS, onde se fala de um cliente por
vez. `UNKNOWN` nunca ganha duração: não saber não é um estado que dure.

**O formatador de idade mudou de casa**, e essa é a parte estrutural: ele vivia
na tela, a um caractere de distância de ser aplicado à data errada. Agora mora
em `OrderDiagnostic`, junto das duas datas, e cada frase só aceita a sua.

**Quatro sabotagens, quatro detectadas, com o detector conferido um a um** —
a primeira leitura do placar estava errada, listando todos os casos porque o
extrator varria a saída inteira: `S1` (duração volta a sair de `observedAt`) cai
em `CONN-COPY-E` e `CONN-COPY-G`, e **não** nos casos que têm as duas datas, o
que é correto — a troca só aparece quando `statusSince` falta; `S2` (o aviso
some) cai em `CONN-UI-02`; `S3` (o servidor inventa o estado `STALE`) cai em
`FIELD-CONN-03/04`; e `S4` (falha do provedor vira `OFFLINE`) cai no teste que
já existia, *"falha ao atualizar NÃO vira offline falso"*. Todas compilaram —
sabotagem que não compila não é detecção.

**Invariante preservado (§9):** falha de integração continua não mexendo no
estado. "Não conseguimos falar com o provedor" e "o provedor diz que o cliente
está fora" continuam fatos diferentes.

---

## 23. `RC-1` — A INSTALAÇÃO EXIGE EQUIPAMENTO, E A FOTO CONFIRMA QUE SUBIU

**`RC-1 FINAL PHYSICAL UX FIX` — `READY FOR OWNER VALIDATION` (20/09/2026).**
Commits locais, sem tag e sem push. **Zero migration, zero dependência, zero
rota nova, zero schema.**

### 23.1 Conectividade — validação física do dono: `PASS`

O dono conferiu em aparelho real, antes de atualizar: *"Online"*, *"Online há
26 d"*, *"Leitura desatualizada"*, *"Verificado há 26 d"*. Depois da
atualização manual: *"Online"*, *"Online há 26 d"*, *"Verificado agora"* — o
`statusSince` parado, o `observedAt` renovado, o aviso sumindo e o estado
continuando `ONLINE`. É exatamente o contrato do §22, observado fora do
laboratório. **A conectividade está fechada e não se mexe mais nela.**

### 23.2 O equipamento: o defeito NÃO era da tela

O dono viu uma OS de Instalação com "Equipamentos instalados / Nenhum
equipamento registrado", sem selo âmbar, e a OS fechou. A hipótese dele estava
certa, e foi **provada antes de qualquer mudança**: no banco de
desenvolvimento, os nove tipos da empresa tinham `requireChecklist = true` (o
que a §382 configurou) e **todo o resto `false`** — inclusive
`requireEquipment`.

Ou seja: a tela e o fechamento **concordavam**. O aplicativo não tinha o que
avisar, porque nada era exigido. Pintar âmbar ali teria sido a pior saída
possível — um aviso que o servidor desmente, numa OS que fecha assim mesmo.

**Decisão do dono:** uma instalação não está operacionalmente concluída
enquanto o equipamento do cliente não estiver registrado. Aplicada pelo
`putCompletionPolicy`, o mesmo serviço que a tela `/tipos-os` chama, com a
empresa e o tipo vindo por argumento — nenhum id gravado em código, nenhum SQL
direto, nenhuma outra empresa e nenhum outro tipo tocado (conferido por
retrato dos nove tipos antes e depois).

**A armadilha da configuração é a mesma da §382, e por isso ela virou teste:**
`putCompletionPolicy` **substitui** a política inteira — ligar um campo sem
reenviar os outros os apaga em silêncio. A receita é "ler o que está gravado,
mudar um campo, reenviar tudo", e `EQPOL-01` a prova com uma política em que
**todos** os campos estão fora do padrão, de modo que esquecer qualquer um cai
apontando qual.

Os casos não afirmam nada sobre "Alfa Telecom" nem sobre "Instalação": nome de
empresa e nome de tipo são dado digitado no catálogo, e um teste que os
fixasse quebraria numa renomeação sem defeito nenhum no produto.

### 23.3 A foto: dois verdes que respondem perguntas diferentes

O técnico tira a foto em cima do telhado e não tinha como saber que ela
chegou. Agora a seção confirma — e a confirmação vem de `evidences`, que é a
lista do **servidor**: o pacote traz só evidência `COMMITTED`, e a foto ainda
subindo vive em `pendingPhotos`, que nem chega ao modelo. Um verde tirado do
seletor local apareceria antes do upload e sumiria quando ele falhasse, que é
o oposto de confirmar.

**`SectionStatus` ganhou um quarto valor, `recorded`**, e o motivo é a barra de
progresso. `done` afirma *"a exigência foi cumprida"* e `recorded` afirma
*"isto foi gravado"*; os dois são o mesmo ✓ verde na tela, e o que muda é a
palavra que o leitor de tela anuncia — "Concluído" e "Registrado". Colapsá-los
num valor só pareceria economia e faria o **denominador do progresso crescer
enquanto o técnico trabalha**: registrar uma foto que ninguém pediu levaria
"1 de 1" a virar "1 de 2".

```text
exigido + pendente      → âmbar  !   "Pendente"
exigido + satisfeito    → verde  ✓   "Concluído"
opcional + vazio        → nada       (a seção NÃO é exigida)
opcional + persistido   → verde  ✓   "Registrado"
```

`registrado` só é consultado quando a seção **não** é exigida: com exigência,
quem responde é a pendência do servidor, e "existe uma foto" jamais satisfaz um
`minEvidenceCount` de três. Material e contato/impedimento **não** entram nessa
regra — marcar tudo devolveria o ruído que o selo existe para evitar.

### 23.4 O que a implementação encontrou

**O teste de idempotência da configuração falhou, e a falha era verdadeira:**
`putCompletionPolicy` faz `upsert` incondicional, então reaplicar reescreve a
linha e `updatedAt` anda. Isso é o comportamento, não defeito a esconder — o
que precisa ser idempotente é a **exigência**, que é o que decide se a OS
fecha. O caso passou a comparar os sete campos da política, e não a linha
inteira; comparar a linha falaria do carimbo de tempo e não da regra.

**Dirigir o upload real num teste de widget exigiu intercalar tempo real e
quadros falsos**, e as duas tentativas anteriores falharam por motivos que
valem para qualquer teste de foto ou assinatura daqui em diante. O envio lê um
arquivo do disco e o transporte falso drena esse mesmo fluxo: são duas
operações de I/O de verdade, que só avançam sob `runAsync`. Mas a **continuação**
delas é agendada na zona falsa, e quem a executa é o `pump`. Com o toque dentro
do `runAsync`, a requisição nem saía (`posts=0`); com uma volta só de cada, a
requisição saía e a resposta ficava pelo caminho, com a linha parada em
"Enviando…". Oito voltas alternadas resolvem. `pumpAndSettle` não serve em
nenhum dos casos: a foto em upload mostra um `CircularProgressIndicator`, e
animação infinita o faz estourar por tempo sem dizer o que houve.

**O finder do selo precisa parar na `Row` do título:** cada foto persistida
desenha o próprio `check_circle` na lista, então um finder que apanhasse o
cartão inteiro passaria com o cabeçalho sem selo nenhum.

### 23.5 Sabotagem

Dez ataques, **dez detectados**, todos compilando — sabotagem que não compila
não prova que algum teste olhava para a regra. O verificador lê só a seção
`Failing tests:` e recusa arrancar com a árvore suja.

| | Ataque | Detector |
|---|---|---|
| `S1` | a política grava `requireEquipment: false` | `EQPOL-01/02/06/07` |
| `S2` | seção exigida e vazia volta a neutra | `EQUIP-UX-01`, `FOTO-UX-03/05`, +8 |
| `S3` | equipamento fica âmbar depois de registrado | `EQUIP-UX-02/07/10`, `SECSTATUS-02` |
| `S4` | seção opcional e vazia vira âmbar | `EQUIP-UX-03/04/05`, `FOTO-UX-01`, +7 |
| `S5` | foto opcional persistida não vira verde | `FOTO-UX-02`, `FOTO-UI-02/06` |
| `S6` | **verde otimista** (foto local conta) | `FOTO-UI-05` — detector único |
| `S7` | uma foto satisfaz `minEvidenceCount > 1` | `FOTO-UX-03/05`, `FOTO-UI-03` |
| `S8` | o progresso volta a contar a foto opcional | `FOTO-UX-06` |
| `S9` | "Registrado" passa a anunciar "Concluído" | `FOTO-UI-02/06` |
| `S10` | a receita apaga o campo que não mudou | `EQPOL-01/02/04` |

**`S6` tem um detector só, e isso é o ponto:** `FOTO-UI-05` é a única coisa
entre o produto e um verde que aparece antes de o servidor ter a foto. Ele
dirige o upload de verdade e o servidor **recusa**.

### 23.6 Estado e pendências

* **`FIELD CONNECTIVITY` — `OWNER VALIDATED` / `PASS`.** Fechada.
* **`Instalação.requireEquipment = true`** — aplicado no DEV da Alfa Telecom
  pelo caminho de domínio, idempotente, sem tocar os outros oito tipos.
* **UX do equipamento** e **confirmação de foto** — `PENDING NEW APK OWNER
  VALIDATION`.
* **Follow-up reportado e NÃO implementado:** a tela `/tipos-os` expõe só o
  interruptor de `requireChecklist`; `requireEquipment` e os demais campos são
  lidos e preservados, mas não editáveis. Enquanto for assim, ligar a exigência
  para outro tipo depende de quem tem acesso ao domínio — que é exatamente o
  que a §382 fechou para o checklist (*"ninguém configura cobertura por
  `curl`"*). Estender o painel para os outros campos da política é decisão do
  dono, não foi pedida nesta fase e não foi feita.

---

## 24. `RC-1` — RELEASE HARDENING: VALIDAÇÃO DO DONO E PUBLICAÇÃO

**`RC-1 RELEASE HARDENING DEBTS` — `OWNER VALIDATION PASS` (20/09/2026).**
Publicado em `origin/main`, sem tag. **Fase de fechamento: zero código de
produto, zero migration, zero dependência.**

### 24.1 O que o dono validou em aparelho e navegador reais

* **Checklist** — persistência na web depois do F5, chegada ao Field, item
  obrigatório **bloqueando** a conclusão com o nome do que falta, e a OS
  fechando quando o checklist é completado.
* **Equipamento** — exigido e vazio → âmbar; registrado → selo verde da
  seção; **linha persistida → ✓ verde próprio**; várias linhas → um ✓ em cada;
  remover continua funcionando.
* **Foto** — evidência persistida → confirmação verde.
* **Conectividade** — a separação `statusSince` (duração do estado) ×
  `observedAt` (idade da verificação) × aviso de leitura desatualizada;
  atualização manual do diagnóstico; o aviso sumindo após verificação fresca;
  e o estado `ONLINE` preservado.

### 24.2 Estados finais registrados

| Item | Estado |
|---|---|
| PRD §382 | `CLOSED` / `OWNER VALIDATED` |
| UX administrativa do checklist | `PASS` |
| Imposição do checklist no Field | `PASS` |
| Política e UX de equipamento | `PASS` |
| Confirmação positiva de foto | `PASS` |
| Semântica de conectividade no Field | `PASS` |
| `ZOOMVIS-08/09` | `CLOSED` / `TEST HARNESS` |
| `UXP-06` | `CLOSED` / `TEST HARNESS` |

### 24.3 Dívidas conhecidas, aceitas e NÃO bloqueantes

* **Intermitente do fechamento no celular** — `OPEN` / dívida conhecida. A
  corrida está medida e **não explica** o `ratio 0`; nenhuma correção
  especulativa foi aplicada.
* **`execution_forms_lifecycle` intermitente (Flutter)** — `OPEN` / dívida
  conhecida. Falhou 1 vez em 2 execuções completas sob carga, 15/15 isolado, e
  o arquivo não foi tocado pelas fases que o observaram.
* **`P1001` do Docker Desktop** — `ENVIRONMENT`, não produto: o proxy recusa
  conexão com o pool frio sob rajada. Nenhum retry foi acrescentado ao login.
* **`CHK-NULL-01`** — dívida de compatibilidade aceita, não bloqueante para a
  V1: OS sem tipo recebe o checklist padrão como ORIENTAÇÃO e não é bloqueada
  por ele, porque a política é chaveada por tipo.

### 24.4 Produção — nada foi ativado

`VPS PROVISIONING — DEFERRED UNTIL PUBLICATION READINESS` ·
`PRODUCTION DEPLOY — NOT EXECUTED` ·
`DIAGNOSTICS SCHEDULER — CONFIGURADO, NÃO ATIVO` ·
`RESTORE DRILL — PENDING VPS/STAGING` ·
`SGP — PENDING API ACCESS` ·
`ReceitaNet round trip real — PASS` (ONLINE → OFFLINE → ONLINE, autorizado e
pontual).

### 24.5 A `RC-1` continua ABERTA

Publicar o endurecimento **não fecha a `RC-1`**. Falta a **revisão de
segurança independente**, que por regra do projeto não pode ser feita pela
sessão que implementou — e depois dela, produção e piloto seguem adiados até
a prontidão de publicação.

## 25. `RC-1` — REMEDIAÇÃO DA REVISÃO DE SEGURANÇA INDEPENDENTE

> **Estado: `SECURITY REMEDIATION — OWNER VALIDATED / READY FOR INDEPENDENT
> RE-REVIEW` (21/09/2026). Sem tag; publicação em `origin/main` autorizada pelo
> dono no fechamento, só fast-forward.**
> A revisão independente sobre `6bfd7b7` fechou `SECURITY REVIEW FAIL` com
> treze achados. Registro técnico completo em `docs/SECURITY.md` §8.27.

**Remediados em código, com teste que falhava antes e sabotagem detectada:**
`SEC-001` (backup sem alvo de banco), `SEC-002` (percurso de PNG/WebP sem
teto), `SEC-004` (metadado depois do scan do JPEG), `SEC-005` (Next ouvindo em
todas as interfaces), `SEC-006` (arquivo de ambiente executado como shell pelo
root), `SEC-007` (faixas IPv6 no guarda de SSRF), `SEC-008` (chamada ao vivo
para ERP desativado), `SEC-010` (reflexão de `Host` no Nginx), `SEC-011`
(`/opt` gravável pelo serviço), `SEC-012` (falha de faixa de backup reportada
como sucesso), `SEC-013` (release do Field com URL de laboratório) e o INFO
`SEC-038` (`APP_ORIGINS` obrigatória em produção).

**`SEC-003` — remediado por versão**, com decisão do dono: `next@14.2.35` →
**`next@15.5.25`**, a menor versão prática corrigida (a linha 14 não tem versão
corrigida; a 15 tem, então a 16 não foi necessária). React 19 e
`react-leaflet@5`, porque o App Router do 15 já roda React 19 vendorizado e o
`react-leaflet@4` quebrava o mapa nele — achado pelo E2E. O upgrade exigiu a migração assíncrona de `params`/`searchParams`/
`cookies()` em rotas e páginas, feita de forma mecânica e sem mover nenhuma
regra de autorização. Registro no PRD §13 (`DECISION UPDATED`).

**Residual `postcss` — `ACCEPTED / NON-BLOCKING V1`** (decisão do dono,
21/09/2026): o `postcss@8.4.31` que o `next@15.5.25` fixa sai
`high` no `npm audit` — avisos de COMPILAÇÃO sobre CSS controlado pelo
atacante, e o CSS do AlfaOS é do repositório — e só sai com `next@16`
(`docs/SECURITY.md` §8.27.9).

**`SEC-009` — `ACCEPTED V1 RESIDUAL RISK`**, decisão do dono: a amplificação de
memória no upload (~57 MiB de pico por upload de 8 MiB) fica como dívida não
bloqueante da V1. **Restrição que a provisão do VPS (`RC-1F`) precisa honrar:**
dimensionar a memória contando uploads simultâneos de técnicos, e tratar
concorrência limitada ou parser em fluxo **antes de qualquer escala
horizontal**.

**Gates do upgrade (21/09/2026)**, num worktree isolado — o `next dev` do dono
na `:3000` não foi tocado. Vitest, lint, `tsc`, `build`, `build:worker`,
`prisma validate` e 29 migrations, nenhuma nova. **Playwright, nos dois
modos:** contra o **build de produção**, a suíte inteira passou em tudo o que
não depende do Mock ERP (364; os 9 restantes dependem dele, que não existe em
produção desde a `RC-1B`, e passaram em desenvolvimento); em
**desenvolvimento**, em duas metades com
servidor novo, porque a suíte inteira num `next dev` só esgota a memória deste
host (`docs/CONTEXT-MAP.md`). Cada falha do dev foi triada: o `LOADUX-07` era
defeito do teste (corrigido, com reprodução e sabotagem — a metade do mapa
passou 126 de 126 depois); o `EV-E2E-01` é
compilação fria do `next dev` (§12, `ACCEPTED DEV-ONLY`); e as do fim da metade
longa acompanharam o servidor acima de 4 GB — a mesma sequência passou 97 de
98 com servidor novo. **Nenhum teste foi afrouxado.**

### 25.1 Fechamento — validação do dono (21/09/2026)

**Smoke físico do dono no Next 15: `PASS`** — login, dashboard, cliente e
histórico, OS, pacote técnico, `/tipos-os`, CTO, mapa, marcadores, popups,
camadas e Ajustar posição → Cancelar.

| Item | Estado |
|---|---|
| `SEC-003` | `APPROVED` / `REMEDIATED` — `next@15.5.25` |
| Residual `postcss@8.4.31` (`high` no `npm audit`, só sai com `next@16`) | `ACCEPTED` / `NON-BLOCKING V1` |
| `SEC-009` | `ACCEPTED V1 RESIDUAL` |
| `EV-E2E-01` no `next dev` frio (§12) | `ACCEPTED DEV-ONLY` / `NON-BLOCKING` |

Nenhuma tag, nenhum deploy, nenhum VPS, nenhum cron e nenhuma chamada a
provider nesta fase.

**A `RC-1` continua ABERTA.** O próximo passo é a **reauditoria independente**
da remediação, feita por uma sessão que não a implementou.

---

## 26. `APP-R1` — INICIALIZAÇÃO DA INSTALAÇÃO (`APP-001`)

**Estado: `READY FOR OWNER VALIDATION` (24/09/2026).** Commits locais, sem tag e
sem push. **Zero migration, zero schema, zero dependência, zero rota, zero UI,
zero Dart.**

Vem da **revisão de produto da V1** (Web + Field, discovery), que encontrou um
`P0` de publicação: numa base de produção recém-migrada **não havia como criar a
primeira empresa e o primeiro ADMIN**. Os dois se exigiam — criar usuário pela
aplicação pede um `ADMIN` de sessão, e nenhuma rota cria empresa —, o seed de
demonstração recusa em produção (`RC-OPS-04`, e corretamente: ele cria contas
com senha conhecida no código-fonte), e nenhum script ou passo de runbook
cobria a lacuna. O único caminho restante era SQL na mão, com um hash de bcrypt
montado por fora.

**Escopo entregue, e só ele:** `npm run tenant:bootstrap` — uma empresa, um
ADMIN, o fuso e a capability inicial. Não é cadastro de empresas, não é Super
Admin, e o seed continua sendo de desenvolvimento e continua recusando em
produção.

```text
migrate deploy → build → tenant:bootstrap → primeiro login
```

Cinco decisões que não devem ser desfeitas:

* **A operação é definida sobre a base VAZIA.** Existindo qualquer empresa ou
  qualquer usuário, ela recusa com saída 2 e não altera nada — não cria segundo
  tenant, não reativa conta e não troca senha. A contagem é **global**, porque a
  pergunta é "esta instalação já foi inicializada?"; um escopo por empresa
  responderia outra pergunta e viraria criação de tenant, que é escopo recusado.
* **A senha não entra em `argv`.** `--password` é recusado antes de qualquer
  leitura, e o valor recebido não é lido nem ecoado: argumento de linha de
  comando aparece em `ps`, no histórico do shell e nos logs do sistema. O
  caminho normal é prompt com **eco mascarado** e confirmação, sem dependência
  nova (a saída do `readline` é um `Writable` que descarta o eco). Para
  automação existe `ALFAOS_BOOTSTRAP_PASSWORD`, apagada do processo depois de
  lida — o que não substitui o `unset`, e o runbook diz isso.
* **Nenhuma autoridade nova.** Senha por `hashPassword` (o bcrypt do login),
  fuso por `isValidTimezone` de `workday.ts` (que é quem já decide o dia
  operacional), capability na coluna `Company.ctoNetworkEnabled` (§8.19). A
  faixa da senha é a mesma da tela `/usuarios` — um mínimo próprio aqui criaria
  duas políticas para o mesmo campo.
* **Validação inteira ANTES do hash e da transação.** Fuso inválido e senha
  inválida precisam sair com zero escrita; validar no meio da transação faria a
  recusa depender do rollback.
* **Empresa, ADMIN e auditoria na MESMA transação**, com **lock consultivo**
  (`pg_advisory_xact_lock`, o mesmo mecanismo do consumo de estoque): duas
  execuções simultâneas contra a base vazia leriam `empresas=0` as duas e
  criariam dois tenants. Empresa sem administrador seria uma instalação em que
  ninguém entra — e que a própria recusa impediria de consertar.

**A mensagem de recusa carrega as DUAS contagens** (`empresas=N usuarios=M`), e
isso é o que dá detector à verificação de usuários: um usuário só existe com uma
empresa (`User.companyId` é FK obrigatória), então a verificação de empresa
sempre chegaria primeiro e apagar a de usuários não quebraria teste nenhum. Por
isso `BOOT-06` afirma sobre a mensagem, e um teste chama o guarda direto com
`{companies: 0, users: 3}` — estado que o banco não produz, e cuja regra é do
guarda, não do schema.

**Um erro meu que só o gate de tipos pegou:** `new DomainError("msg", 400)` —
a assinatura real é `(status, message)`. Vitest e `tsx` não conferem tipos, então
os 32 testes passavam com a chamada invertida. Corrigido usando `badRequest`,
que é o idiom do projeto.

**Testes (`BOOT-01`–`BOOT-12`, 32 casos):** base vazia cria empresa e ADMIN com
hash `$2…$12$` verificável; **login real pela rota** com a senha digitada, e
`401` com a senha errada; e-mail normalizado para minúsculas (sem isso o ADMIN
não entraria); fuso persistido e confirmado por `resolveTimezone`; segunda
execução recusada sem alterar byte nenhum; duas execuções simultâneas produzindo
UMA instalação; empresa existente e instalação povoada recusadas; fuso e senha
inválidos com inventário `{0,0}`; o **comando real em processo separado** criando
o ADMIN sem imprimir a senha; `--dry-run` com zero escrita; o seed continuando
bloqueado em produção; e falha depois da empresa criada não deixando empresa sem
ADMIN.

**Sete sabotagens, sete detectadas**, cada uma restaurada por cópia e conferida
byte a byte (nunca `git checkout` sobre trabalho não commitado — lição da
`ERP-1`): tirar a verificação de empresa, tirar a de usuário, criar a empresa
fora da transação, imprimir a senha no CLI, aceitar fuso inválido, dry-run
escrevendo, e remover o lock consultivo — esta última derruba exatamente o teste
de corrida.

**Artefato compilado, não `tsx`:** o comando roda por `node dist/…` como os
demais operacionais (`OPS-01`), e foi exercido compilado — `--help`, recusa de
`--password` e `--dry-run` contra a base de desenvolvimento, que respondeu
`RECUSADO: empresas=3 usuarios=6` com **zero escrita** (conferido depois:
3 empresas, 6 usuários, nenhuma linha `COMPANY.BOOTSTRAPPED`).

**Dívidas que esta fase NÃO fecha**, e que continuam sendo produto: não existe
superfície administrativa para trocar `Company.timezone` depois (`JOR-05`, e
`JOR-B4` continua sendo o motivo de ela não nascer antes) nem para ligar
`ctoNetworkEnabled` fora do bootstrap. O runbook diz as duas coisas em vez de
prometer tela.

Registro operacional: `docs/DEPLOYMENT.md` §5.1 (e o passo a mais na §8).

### 26.1 Correção de contrato — o fuso é EXPLÍCITO (24/09/2026)

A primeira entrega caía em `America/Sao_Paulo` quando `--timezone` era omitido.
**Decisão do dono: isso é desvio de contrato, e foi corrigido antes da
validação.** O fuso passou a ser **obrigatório**, sem padrão e sem inferência —
nem do servidor, nem do sistema operacional, nem do locale, nem do documento da
empresa, que respondem todos onde a MÁQUINA está quando a pergunta é qual é o
dia operacional da EMPRESA.

Ele não é preferência de apresentação: decide a que dia civil pertence uma
batida das 23h50, o que entra em "OS de hoje" e o que conta como atrasado. Um
padrão assumido gravaria essa autoridade sem ninguém ter escolhido, e o
provedor de Manaus só descobriria a escolha quando a jornada do técnico caísse
no dia errado — com a agravante de que trocar o fuso depois ainda não tem
superfície administrativa (`JOR-05`), então a correção seria operação de banco.

**A regra é do DOMÍNIO, e mora num lugar só.** `validateBootstrapInput` recusa
ausente, vazio e só-espaços; o tipo de entrada deixou de ser opcional
(`timezone: string`) para o chamador TypeScript, e a recusa em tempo de execução
continua existindo porque `argv` e JSON não têm tipo. O CLI **não ganhou `if`
próprio**: ele repassa o que recebeu (ausente vira string vazia) e quem recusa é
o domínio — um segundo lugar validando seria a regra que diverge, e a que
divergisse seria a que ninguém revisou. Um teste afirma isso sobre o fonte do
CLI.

Seis casos novos (`BOOT-TZ-01`–`06`): ausente recusa; ausente, vazio e
só-espaços com inventário `{0,0}` e zero auditoria; `America/Sao_Paulo`
explícito aceito e persistido; `Mars/Olympus` recusado sem escrita; o `dry-run`
exigindo o fuso, inclusive pelo comando real (saída 2, sem `SIMULADO`); e a
recusa provada pelo domínio, não pelo CLI.

**Sabotagem `S8`:** restaurar o padrão silencioso
(`bruto.length === 0 ? "America/Sao_Paulo" : bruto`). Ela **compila** — o que
importa, porque erro de compilação não seria detecção — e derruba exatamente
`BOOT-TZ-01`, `02`, `05` e `06`. Restaurada byte a byte.

O `DEFAULT_TIMEZONE` de `workday.ts` continua existindo e continua certo no
lugar dele: `resolveTimezone` responde por coluna já gravada que veio nula ou
inválida, para não derrubar a batida do técnico. O que a `26.1` proíbe é usar
esse padrão numa ESCRITA — a própria docstring dele já dizia que quem valida o
valor é quem o grava.

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
TL-1                    timeline do cliente                           READY FOR OWNER VALIDATION
```

O escopo do primeiro lançamento está congelado em **PRD §362–§393**, e a lista
do que falta está em **§386**. O contrato final do mapa é a **PRD §392**.

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
TL-1                           timeline do cliente       ← READY FOR OWNER VALIDATION
EV-1 · GS-1                    depois da TL-1            ← não iniciadas
   ↓
LANÇAMENTO V1
   ↓
V2 (PRD §388)  →  V3 (PRD §389)
```

**A ordem das fatias foi decidida pelo dono, fatia a fatia, como este plano
previa.** Elas continuam independentes entre si e todas dependem apenas do que
já existe. **`DASH-1` veio primeiro** e foi aprovada com a `DASH-1a`; o
**`HOTFIX-FIELD-01`** fechou um defeito conhecido do técnico; e a **`TL-1`** foi
implementada e **aguarda a validação do dono** (§5, PRD §381). **`EV-1`** e
**`GS-1`** continuam não iniciadas, e nenhuma delas começa antes dessa
validação.

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

> **Estado: `READY FOR OWNER VALIDATION`.** Commits locais, sem tag e sem push.
> Zero migration, zero schema, zero rota de API, zero Dart. O contrato congelado
> — as quatro decisões do dono, a fonte de cada fato e o que ficou fora — está na
> PRD §381; o mapa do código, em `docs/CONTEXT-MAP.md`. O que segue é o plano
> como foi escrito.
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

**As fatias V1 não mudam.** Com a `DASH-1` concluída, `TL-1 → EV-1 → GS-1`
continuam sendo o próximo trabalho do Core V1, e **nenhum módulo entra dentro
delas** — nem como "já que estamos mexendo aqui" (PRD §393).

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

```text
/minhas-os — "Próximas"
  o quê    também contém OS sem agendamento e OS com agendamento vencido
           (validação do dono, 13/09/2026: OS de 06/09 em "Próximas")
  opções   A/B/C registradas SEM decisão — docs/TECHNICIAN-EXECUTION.md §9
  fase     fluxo do técnico

"Sincronizar Mock ERP"
  o quê    visível ao ADMIN em /ordens, sem condição de ambiente
  fase     release hardening

Datas gerais no fuso do servidor
  o quê    "Criada em", "Vinculado em" e o "Agendada:" dos cartões de /minhas-os
  apoio    o helper do fuso da empresa já existe (src/lib/company-datetime.ts)
  fase     release hardening

E2E do mapa — MAPEDIT-05/06/07 intermitente (achado na TL-1, 13/09/2026)
  o quê    o arrasto registra no painel, e a medição do marcador dá desvio 0;
           isolado, falhou 2 de 6; no grupo MAPEDIT, 10 de 10; na suíte inteira,
           1 falha numa rodada e 308/308 na seguinte
  alcance  código do mapa idêntico ao de antes da TL-1 — nenhum arquivo do
           caminho de /mapa mudou
  aberto   se é corrida da medição ou o marcador voltando ao ponto gravado
  fase     investigação própria; o mapa está FROZEN e só reabre por defeito provado
```

O `HOTFIX-FIELD-01` corrigiu **só** o fuso de "Hoje" em `/minhas-os`; a
semântica de "Próximas" não é continuação dele. Os demais INFO continuam onde
foram registrados — PRD §253 (jornada), as notas técnicas de cada trilha e
`docs/SECURITY.md` — e esta lista não os substitui.

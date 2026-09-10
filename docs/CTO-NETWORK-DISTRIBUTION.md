# AlfaOS — CTOs e Rede de Distribuição: especificação técnica

Detalhamento da capability aprovada no PRD **Parte XIII (§333–§341)**.

Mora aqui, e não no PRD, pelo mesmo motivo que `DISPATCH-QUEUE.md` e
`FIELD-API.md` moram fora dele: o PRD é **visão de produto**, e modelo de
dados, concorrência de porta, matriz de teste e fases são engenharia.

> **Estado: `CTO-1` IMPLEMENTADA (§20).** Cadastro de CTO, portas, capacidade,
> localização, estados administrativos da porta, foto e tela de ADMIN existem em
> código.
>
> **`CTO-2` a `CTO-7` NÃO existem.** Sem `CustomerNetworkConnection`, sem
> vínculo cliente↔porta, sem Field, sem mapa, sem status `ONLINE/OFFLINE`, sem
> QR. Onde este documento fala do vínculo, ele descreve o que a `CTO-2` vai
> fazer — não o que o sistema faz hoje.
>
> **Decisões de produto congeladas na `CTO-0.1`** (§16) e contrato de schema
> congelado (§17). Reabrir qualquer um dos dois exige decisão explícita e
> registro aqui. A §119 continua valendo: as fases seguintes não estão
> autorizadas por estarem escritas.

---

## 1. O que a capability resolve

O técnico chega ao poste e precisa saber **em qual caixa e em qual porta** o
cliente está conectado. Hoje o AlfaOS não sabe: a informação existe na cabeça
de quem instalou, num caderno, ou num sistema que o AlfaOS não consulta.

```text
CTO A16
Capacidade 8 portas · 6 ocupadas · 2 livres

01  Cliente A    ONLINE
02  Cliente B    OFFLINE
03  LIVRE
04  Cliente C    ONLINE
```

`A16` é **exemplo**, não contrato. Uma empresa nomeia `CTO-001`, outra `CX-45`,
outra `NAP-12`. Nada nesta especificação depende da nomenclatura da Alfa
Telecom.

---

## 2. A fronteira com o FiberMap — a §202 foi REVISTA

Esta é a parte que precisa ser lida antes de qualquer outra, porque a
especificação **contraria uma decisão anterior do PRD** e o motivo importa.

### O que a §202 dizia

> **O AlfaOS não duplica topologia de rede.**
>
> "Um cadastro de CTO dentro do AlfaOS divergiria do FiberMap na primeira
> manutenção de rede, e o técnico levaria a informação errada para o poste."

A regra estava certa **sobre o problema que ela imaginava**: dois cadastros da
mesma caixa, mantidos por sistemas diferentes, divergem — e o pior momento para
descobrir isso é com o técnico já no poste.

### Por que ela não se sustenta hoje

A regra prescreve **consultar** o FiberMap. Só que:

```text
FiberMap no AlfaOS      integração FUTURO (PRD §107, §202)
código                  nenhum
rota                    nenhuma
data prevista           nenhuma
```

Duplicação exige **dois** cadastros. Como não há integração, não há dois — há
**nenhum**, e o técnico trabalha sem o dado. A §202, aplicada ao estado real do
sistema, não impede divergência: impede **ter a informação**.

> **A regra continua válida no que ela protege; muda o que ela proíbe.** O
> AlfaOS passa a manter o cadastro operacional de CTO que a operação precisa
> hoje, e a fronteira deixa de ser "não cadastrar" para ser "**quem manda
> quando os dois existirem**".

### A precedência, decidida agora e não no dia da integração

Deixar isso para depois é o erro que a §202 tentava evitar. A regra:

```text
enquanto NÃO houver FiberMap integrado
  AlfaOS é autoridade operacional de CTO, porta e vínculo

quando houver FiberMap integrado
  FiberMap é autoridade de TOPOLOGIA FÍSICA
    (existência da caixa, capacidade, splitter, cabo, PON, OLT)
  AlfaOS é autoridade do VÍNCULO OPERACIONAL
    (qual cliente está em qual porta, desde quando, por qual OS)
```

Os dois não competem porque respondem perguntas diferentes: o FiberMap responde
*por qual fibra o sinal passa*; o AlfaOS responde *quem o técnico instalou ali e
quando*. O vínculo cliente↔porta nasce numa OS do AlfaOS e é o AlfaOS que tem o
ator, o horário de servidor e a evidência.

**O que a integração futura NÃO pode fazer:** sobrescrever o vínculo
operacional em silêncio. Divergência entre os dois é **fato a exibir**, não
merge automático — pela mesma razão que a §197 já fixou para localização de
cliente: dado de menor confiança não sobrescreve o confirmado em campo.

> Se a empresa **já tem** FiberMap e o integra antes de CTO-1, esta capability
> deve ser reavaliada em vez de implementada. A decisão aqui vale para o estado
> em que o produto está.

---

## 3. Modelo conceitual

> **CONGELADO na CTO-0.1.** Deixou de ser proposta: o contrato de schema desta
> seção é o que a `CTO-1` implementa, e as decisões que o fecharam estão
> registradas na §16. Continua valendo `NÃO criar migration` **fora** da fase
> que a executa.

### Opção A — três entidades explícitas (recomendada)

```text
CTO                          a caixa física
CTOPort                      uma posição dentro dela
CustomerNetworkConnection    o vínculo cliente↔porta, com história
```

### Opção B — ponto de distribuição genérico

```text
NetworkDistributionPoint  +  subtype (CTO | NAP | CX | ...)
  → port
  → connection
```

### Recomendação: **A**

O requisito é CTO. A Opção B antecipa um tipo que ninguém pediu, e o custo
aparece cedo: toda consulta ganha um filtro por subtipo, toda tela ganha um
"que tipo de ponto é este?", e a primeira migração para acrescentar um subtipo
real ainda vai acontecer. Nomear o que existe é mais barato que generalizar o
que não existe.

**Se um dia houver outro tipo de ponto**, a evolução é acrescentar a entidade —
não é reescrever CTO. E o nome `CTO` é o que a operação fala; um cadastro
chamado `NetworkDistributionPoint` na tela obrigaria a traduzir em toda
conversa.

### Esboço conceitual

```text
CTO
  companyId            tenant, sempre da sessão
  name                 "A16" — manual, obrigatório, único por empresa
  code                 opcional
  capacity             inteiro, por empresa — nunca fixo em 8
  latitude/longitude   opcionais: uma CTO sem GPS ainda é útil
  addressReference     "poste em frente ao nº 340"
  notes                opcional
  photo                opcional (evidência, não requisito)
  status               ativa / inativa
  createdAt/updatedAt

CTOPort
  ctoId
  companyId            redundante de propósito: filtro de tenant em SQL
  number               posição; único por CTO
  administrativeState  AVAILABLE · RESERVED · DAMAGED
  notes                opcional
                       ← NÃO existe OCUPADA. Ver "Ocupação é derivada".

CustomerNetworkConnection
  companyId
  customerId
  ctoPortId
  serviceOrderId       a OS que criou o vínculo, quando houve uma
  technicianId         quem instalou
                       ← SEM equipmentId. Ver §16, decisão C-05.
  connectedAt
  disconnectedAt       NULO enquanto ativo
  source               FIELD · WEB · IMPORT
  reason               opcional, na desconexão
```

`companyId` repetido em toda linha segue a convenção do projeto
(`ServiceOrderExecution`, `TimeEntry`, `TechnicianDispatchQueueEntry`): permite
filtrar tenant **num predicado SQL** em vez de navegar a FK até a CTO.

### Ocupação é DERIVADA, e nunca persistida

A primeira versão desta seção listava `state` com quatro valores —
`LIVRE · OCUPADA · RESERVADA · DANIFICADA` — enquanto a §4, a duas telas de
distância, recusava `CTOPort.state` como autoridade justamente por criar *"um
segundo lugar que precisa concordar com a existência do vínculo"*. As duas
coisas não convivem: persistir `OCUPADA` **é** o segundo lugar.

> **`administrativeState` responde "esta posição pode receber alguém?".
> A ocupação responde "tem alguém aqui agora?", e quem responde é a existência
> de `CustomerNetworkConnection` com `disconnectedAt IS NULL`.**

O estado que a tela mostra é calculado, sempre, nesta ordem:

```text
existe vínculo ativo nesta porta ?
  SIM  → OCCUPIED                      (vence qualquer administrativeState)
  NÃO  → AVAILABLE → FREE
         RESERVED  → RESERVED
         DAMAGED   → DAMAGED
```

`OCCUPIED` **não existe como valor gravável**. Não há coluna que o aceite, então
não há como duas fontes divergirem: um rollback parcial que perca o vínculo
devolve a porta a `FREE` por construção, em vez de deixar uma linha marcada
`OCUPADA` sem ninguém dentro.

`RESERVED` e `DAMAGED` continuam **fora da contagem de portas livres** (§11).
Uma porta danificada não está livre, e nunca esteve ocupada.

---

## 4. A porta é o ponto de concorrência

Dois técnicos, dois celulares, a mesma `CTO A16 / porta 4`, no mesmo minuto. É
o caso realista, não o exótico: duas instalações no mesmo condomínio saem
juntas.

### O que garante a exclusividade

São **duas** uniques parciais, e elas respondem perguntas opostas:

```text
(ctoPortId) WHERE disconnectedAt IS NULL    uma porta, um cliente
(customerId) WHERE disconnectedAt IS NULL   um cliente, uma porta
```

A primeira sempre esteve escrita aqui. **A segunda faltava**, e a ausência dela
era um buraco no próprio critério de aceite: `CTO-AC05` promete que *"o cliente
fica em exatamente UMA porta ativa"*, e a unique de porta não diz nada sobre
isso. Duas movimentações concorrentes do mesmo cliente para portas
**diferentes** satisfazem a primeira e deixam o cliente com dois vínculos
ativos, em duas caixas. Fechado na CTO-0.1 (§16, `C-11`).

É o **banco** que arbitra as duas — não uma checagem de aplicação, que perde a
corrida por construção.

> Postgres suporta unique parcial; o Prisma não a modela em `@@unique`. A
> implementação escreve os dois índices no SQL da migration, como o projeto já
> faz com o CHECK de identidade externa da OS
> (`service_orders_external_identity_check`).

A terceira unique é da porta, e não é parcial:

```text
UNIQUE (ctoId, number)
```

Sem ela, duas edições concorrentes de capacidade criam a porta 9 duas vezes, e a
CTO passa a ter duas posições com o mesmo número — cada uma com direito ao
próprio vínculo ativo, porque a unique parcial é por `ctoPortId`.

**A alternativa `CTOPort.state` com CAS foi DESCARTADA**, não é mais uma opção
em aberto: a coluna deixou de guardar ocupação (§3, "Ocupação é derivada"), de
modo que não existe segundo lugar para divergir.

### A resposta ao perdedor é explícita

```text
409 · "A porta 4 da CTO A16 foi ocupada por outro atendimento.
       Atualize e escolha outra porta."
```

Nunca silêncio, nunca "deu certo" para os dois. Vale a mesma regra da fila
(PRD §204): falhar precisa ser visível.

### O Flutter não decide disponibilidade

"Livre" na tela é uma **leitura**, não uma reserva. O aplicativo pode mostrar o
que sabe; quem confirma é o servidor, na transação que grava o vínculo.

---

## 5. Movimentação preserva história

Mover `A16/4 → A18/7` **não** é um `UPDATE` que troca a porta.

```text
1. fechar o vínculo atual   disconnectedAt = agora, reason
2. abrir o novo             connectedAt = agora, nova porta
3. auditar                  ator, OS, antes, depois, horário do SERVIDOR
```

O vínculo anterior continua legível para sempre. É a mesma escolha que a
Jornada fez com `TimeEntry` (correção cria linha nova, não edita a original) e
que a §197 fez com localização.

**Consequência que precisa estar escrita:** "a porta 4 da A16 está livre" e "a
porta 4 da A16 nunca foi usada" são frases diferentes, e a segunda só se
responde pelo histórico.

---

## 6. Online / Offline — reusa o que existe, e o que existe tem limite

### A fonte autoritativa de hoje

Levantada no código, não suposta:

| | |
|---|---|
| Modelo | `CustomerDiagnosticSnapshot` |
| Serviço | `src/lib/customer-diagnostics.ts` |
| Leitura | `getCustomerDiagnostic` — lê o **último snapshot local**, sem rede |
| Atualização | `refreshCustomerDiagnostic` — chama o provider; falha **não** destrói o snapshot anterior |
| Estados | `ONLINE · OFFLINE · UNKNOWN` (enum `ConnectivityStatus`) |
| Frescor | `observedAt` (quando o AlfaOS observou) e `sourceUpdatedAt` (quando o provider diz que mudou) |
| Escopo | por **cliente**, e por `ERPProvider` |

> **`UNKNOWN` já é valor de primeira classe**, e não código de erro. "Não
> conseguimos falar com o ERP" e "o ERP diz que está fora" são fatos
> diferentes; colapsar o primeiro em `OFFLINE` mandaria um técnico ao endereço
> por causa de uma integração instável. A CTO herda isso inteiro.

**Nenhuma integração nova é criada para a CTO.** A projeção da CTO lê os
snapshots que já existem.

### As três limitações reais — e por que CTO-5 depende delas

**1. O refresh é sob demanda, e o gatilho é a OS.**
Não há cron, não há poller. Um snapshot só existe, e só envelhece menos, quando
alguém abre a OS daquele cliente. Numa CTO de 8 clientes, é normal que os
`observedAt` estejam a meses de distância entre si — e que **clientes sem OS
recente não tenham snapshot nenhum**, o que é `UNKNOWN` legítimo.

**2. O teto de chamadas ao provider inviabiliza "atualizar a CTO inteira".**

```text
ERP_CAPABILITIES.CUSTOMER_DIAGNOSTIC   sem limite próprio
CAPABILITY_LIMIT (padrão)              10 por 60 s, POR EMPRESA
```

Uma CTO de 8 portas consumiria **8 das 10** atualizações da empresa no minuto.
Duas CTOs abertas em sequência estouram o limite e a segunda vem `UNKNOWN` —
não por falha de rede, mas pela própria tela.

**3. Não existe consulta em lote no provider.** O diagnóstico é por cliente, e
a §141 já registrou que o ReceitaNet não expõe listagem. Um lote seria N
chamadas.

### O que isso obriga

> **CTO-5 apresenta o ÚLTIMO ESTADO CONHECIDO, com a idade dele. Não promete
> tempo real, e não atualiza a CTO inteira ao abrir.**

```text
01  Cliente A   ONLINE     há 2 min
02  Cliente B   OFFLINE    última leitura 22:07
03  LIVRE
04  Cliente C   DESCONHECIDO
```

A idade ao lado do estado não é enfeite: sem ela, `ONLINE` de três meses atrás
é indistinguível de `ONLINE` de agora, e alguém decide subir num poste com base
nisso.

Atualizar continua sendo **ação explícita** do operador, cliente a cliente,
pelo caminho que já existe. Se um dia a operação exigir "atualizar a CTO
inteira", isso é uma decisão de **capacidade de integração** — teto próprio,
chamada em lote no provider, ou fila de atualização — e não uma tela.

### O Flutter nunca fala com o provider

```text
ERRADO   Flutter → provider (uma chamada por cliente)
CERTO    Flutter → AlfaOS → projeção da CTO → clientes + status, agregado
```

Uma resposta só. É a mesma regra que a Field API já segue em toda superfície
(`docs/FIELD-API.md`): nenhuma chamada `Flutter → ReceitaNet`.

---

## 7. ONT, equipamento e potência óptica

**CTO não é `Equipment`.** A CTO é infraestrutura de distribuição do provedor; a
ONT, o roteador e o repetidor são equipamentos. Colapsar os dois faria a caixa
do poste aparecer na mesma listagem do roteador do cliente.

A ONT entra por **vínculo**, quando ele existir: `CustomerNetworkConnection`
pode apontar para o equipamento já registrado (`ServiceOrderEquipment`, v0.10).
Sem vínculo autoritativo, a CTO simplesmente não mostra série nem modelo —
**não inventa telemetria**.

**Potência óptica** (`-19.4 dBm`) é evidência de instalação, não campo
obrigatório universal. Se virar exigência, é por **política da empresa**, ao
lado da política de conclusão de OS que já existe
(`ServiceOrderCompletionPolicy`) — nunca uma regra global fixa no produto.

---

## 8. Capabilities por empresa

O AlfaOS é SaaS: uma empresa usa CTO com mapa e status, outra só quer o
cadastro. Conceitualmente:

```text
CTO_MODULE                o módulo existe para esta empresa
CTO_MAP                   CTOs aparecem no mapa operacional
CTO_PORT_MANAGEMENT       gestão de portas e vínculo
CTO_LIVE_STATUS           status do cliente na visão da CTO
CTO_QR_IDENTIFICATION     identificação por QR
```

Nenhuma flag física é decidida aqui.

### QR é OPCIONAL, e o padrão é desligado

Empresas que identificam a caixa por nome — `A16`, `A17` — não precisam de QR e
não devem ser obrigadas a colar etiqueta em centenas de postes para usar o
módulo.

> **`CTO_QR_IDENTIFICATION = OFF` por padrão.** Com ele desligado, **nenhuma**
> função principal fica indisponível: o técnico acha a CTO pelo nome, pela
> busca, pelo mapa ou pela proximidade.

---

## 9. Fluxos

### Instalação

```text
REDE DO CLIENTE

CTO      [ Selecionar CTO ]      busca · mapa · proximidade GPS
PORTA    [ Selecionar porta ]    livres e ocupadas, do servidor
Potência [ conforme política ]

[ CONFIRMAR VINCULAÇÃO ]
```

A proximidade GPS **ordena a lista**; ela não escolhe. O técnico confirma a
caixa física — e a distância é auxiliar porque duas CTOs a 30 m uma da outra
são indistinguíveis por GPS de celular.

### Reparo

O cliente já tem vínculo: a tela **mostra** `CTO A16 · Porta 04`, com `VER NO
MAPA` e `ABRIR CTO`. Não pede cadastro de novo — repetir a vinculação a cada
reparo é como o histórico vira ruído.

### O vínculo sobrevive à OS

Ele nasce numa OS e **não depende dela**. OS concluída, o cliente continua na
porta 4. `serviceOrderId` é procedência, não dono.

---

## 10. Segurança

| Superfície | Requisito |
|---|---|
| Tenant | `companyId` sempre da sessão. CTO, porta, cliente, técnico e OS **da mesma empresa** — verificado no serviço, porque o schema sozinho não cruza isso |
| IDOR | Id de CTO/porta de outra empresa → **404**, nunca 403 |
| Concorrência | Unique parcial no banco; conflito explícito, nunca last-write-wins |
| Transação | Fechar o vínculo antigo e abrir o novo **na mesma** transação |
| Auditoria | CTO criada/editada/inativada · cliente conectado/movido/desconectado · porta alterada. Ator, empresa, horário do **servidor**, antes/depois, OS quando houver |
| Provider | **Nenhuma** chamada direta do Flutter |
| PII | A projeção da CTO leva nome do cliente e estado. **Não** leva CPF, telefone, endereço completo nem credencial |
| Coordenada | Dado operacional da CAIXA, não do cliente — e a da CTO é pública por natureza (fica no poste) |

---

## 11. Casos de borda

```text
CTO lotada                        oferecer, não esconder: o técnico precisa
                                  ver que está cheia
CTO inativa                       não aceita vínculo novo; os existentes ficam
porta ocupada em corrida          409 explícito
cliente já vinculado              é MOVIMENTAÇÃO, não vínculo novo
CTO removida                      inativar, nunca apagar com histórico
capacidade reduzida               ver abaixo
cliente sem ONT                   vínculo vale sem equipamento
status indisponível               UNKNOWN, nunca OFFLINE
técnico offline                   ver §12
CTO sem coordenada                continua utilizável; só não entra no mapa
porta danificada/reservada        estado próprio, fora da contagem de livres
OS concluída                      o vínculo permanece
cliente vindo do ERP              o ERP origina o Customer, não a topologia
técnico escolhe a CTO errada      corrige movendo — e a história registra as duas
```

### Capacidade — aumentar e reduzir

Baixar uma CTO de 16 para 8 portas com vínculos ativos em 9–16 **desconectaria
oito clientes por um campo de formulário**.

**Ao criar**, `capacity = N` cria as portas `1..N` **na mesma transação** da
CTO. Não existe criação manual porta a porta: uma CTO cuja gravação de porta
falhou pela metade é uma caixa que a operação enxerga como incompleta sem
saber por quê. Falhou uma, a CTO inteira não nasce.

**Ao aumentar**, `8 → 16` cria `9..16` na mesma transação. Se alguma dessas
linhas já existir — porque a CTO já foi maior antes —, ela é **reutilizada**,
nunca duplicada; `UNIQUE (ctoId, number)` é o que torna isso uma invariante em
vez de uma esperança.

**Ao reduzir, nenhuma `CTOPort` é apagada.** As posições acima da nova
capacidade continuam no banco, com o histórico delas intacto, e apenas saem da
seleção. Apagar linha de porta apagaria junto a resposta para *"quem já esteve
na porta 12?"*.

> Invariante: a redução é **recusada** se qualquer porta acima da nova
> capacidade tiver vínculo ativo, estiver `RESERVED` ou estiver `DAMAGED`.
> Liberar aquelas portas é operação administrativa explícita, com auditoria
> própria.

Isto é **mais estrito** que o `N-12` do PRD, que só falava de porta ocupada.
`N-12` continua verdadeiro e vira o piso: uma reserva ou uma avaria são
declarações de que alguém contava com aquela posição, e sumir com elas por um
campo de formulário tem o mesmo defeito que desconectar cliente.

**Consequência que precisa estar escrita:** `capacity` corrente **não** é a
contagem de linhas de `CTOPort`. Depois de uma redução, existem linhas com
`number > capacity`; elas são histórico, não posições ofertáveis. Um relatório
que contar linhas para dizer "esta CTO tem 16 portas" estará errado.

> Por isso a faixa `1..capacity` é regra de **aplicação**, e não um CHECK de
> banco. Um CHECK entre `CTOPort.number` e `CTO.capacity` seria cross-table
> (exigindo trigger) e, pior, seria **incompatível com a própria política
> acima**, que exige que linhas com `number > capacity` sobrevivam. O banco
> garante o que é imutável por linha — unicidade e `number > 0`; a faixa
> ofertável muda com o tempo e é decidida na seleção.

---

## 12. Offline

O Field pode exibir a última topologia conhecida, marcada como tal. **Não pode
reservar porta offline.**

Reservar sem servidor cria uma promessa que ninguém garantiu: dois técnicos sem
sinal escolhem a mesma porta 4 e os dois "conseguem". A vinculação
autoritativa exige confirmação do servidor — e é aceitável que ela espere
sinal, porque ocupar a porta errada custa uma visita a mais.

---

## 13. Fases

| Fase | Escopo |
|---|---|
| **CTO-1** | Web: cadastro de CTO, capacidade, portas, localização |
| **CTO-2** | Field: vincular cliente a CTO/porta em instalação e reparo |
| **CTO-3** | CTOs no Mapa Operacional |
| **CTO-4** | Detalhe da CTO: ocupação e clientes |
| **CTO-5** | Status `ONLINE/OFFLINE/UNKNOWN` reusando a fonte existente, **com a idade da leitura** |
| **CTO-6** | Análise de impacto / possível falha coletiva |
| **CTO-7** | Opcional: identificação por QR e inventário avançado |

**CTO-3 depende do Mapa Operacional**, que não existe (PRD §136, `FUTURO`).
CTO-1, CTO-2 e CTO-4 não dependem dele.

**QR não é requisito de CTO-1 a CTO-6.**

### Possível falha coletiva (CTO-6) — o que ela não pode dizer

Seis de sete clientes da mesma CTO `OFFLINE` é **sinal**, não diagnóstico.

> Nunca chamar de "rompimento" sem evidência adicional. E, dada a §6, o sinal é
> ainda mais fraco do que parece: seis snapshots velhos e um recente não são
> seis clientes fora agora. **CTO-6 depende de frescor que hoje não existe** —
> é a fase que mais depende de resolver o teto de atualização.

---

## 14. Critérios de aceite

```text
CTO-AC01  empresa cadastra a CTO pelo nome que ela usa
CTO-AC02  a CTO tem capacidade e portas
CTO-AC03  o técnico encontra a CTO pelo nome
CTO-AC04  o técnico vê portas livres e ocupadas, vindas do servidor
CTO-AC05  o cliente fica em exatamente UMA porta ativa
CTO-AC06  dois técnicos não ocupam a mesma porta: um recebe conflito
CTO-AC07  mover A16/4 → A18/7 preserva o vínculo anterior legível
CTO-AC08  o mapa mostra a localização da CTO
CTO-AC09  abrir a CTO mostra os clientes vinculados
CTO-AC10  o status vem da fonte autoritativa existente, sem integração nova
CTO-AC11  provider indisponível ou sem leitura → UNKNOWN
CTO-AC12  a empresa A não enxerga CTO da empresa B
CTO-AC13  com QR desligado, nenhuma função principal fica indisponível
CTO-AC14  reduzir capacidade abaixo da maior porta ocupada é recusado
CTO-AC15  o status exibido carrega a IDADE da leitura
```

---

## 15. Pendências — situação depois da CTO-0.1

```text
C-01  arbitragem da porta            FECHADA   §16
C-02  capability por empresa         FECHADA   §16
C-03  teto de 10/min do diagnóstico  ABERTA    dona: CTO-5
C-04  potência óptica                ABERTA    dona: CTO-2 / política
C-05  vínculo da ONT                 FECHADA   §16
C-06  renomear CTO com histórico     FECHADA   §16
C-07  quem gerencia a CTO            FECHADA   §16
C-08  autorização do vínculo Field   FECHADA   §16
C-09  criação das portas             FECHADA   §16
C-10  alteração de capacidade        FECHADA   §16
C-11  um cliente, uma porta          FECHADA   §16
C-12  foto da CTO                    FECHADA   §16
```

**As duas que continuam abertas não bloqueiam `CTO-1` nem `CTO-2`**, e cada uma
tem fase dona declarada em vez de ficar sem endereço:

* **`C-03`** — o teto de 10 chamadas por minuto por empresa serve à CTO, ou a
  capability precisa de limite próprio? A pergunta só ganha consequência quando
  existir tela que agregue status (`CTO-5`) e sinal de falha coletiva
  (`CTO-6`). `CTO-1` e `CTO-2` não chamam o provider.
* **`C-04`** — potência óptica entra em `ServiceOrderCompletionPolicy` (que já
  tem `requiredEvidenceCategories[]`) ou em política própria da CTO? Continua
  sendo evidência de instalação, nunca campo obrigatório universal (§7).

---

## 16. Decisões congeladas — CTO-0.1

Fase de fechamento de produto, executada sobre `v0.13-field-push-notifications`.
**Nenhuma linha de código, nenhuma migration, nenhuma alteração de Prisma.** O
que segue deixou de ser recomendação e passou a ser contrato: reabrir qualquer
item exige decisão explícita e registro aqui, não uma escolha silenciosa dentro
de uma fase de implementação.

### `C-01` — arbitragem da porta

Unique parcial no SQL da migration, `(ctoPortId) WHERE disconnectedAt IS NULL`.
**O banco arbitra.** Perdedor recebe **409** com a mensagem da §4, e **não há
auto-retry** — reservar de novo por conta própria é decidir pelo técnico qual
porta ele vai usar. `CTOPort` não é segunda autoridade.

### `C-02` — capability por empresa

```text
Company.ctoNetworkEnabled   Boolean   default false
```

Uma coluna, e **nenhum framework genérico de feature flag**. O precedente do
projeto é exatamente esse: `pppoePasswordPolicy` e `timezone` são políticas por
empresa em colunas próprias. Uma tabela genérica de flags criaria infraestrutura
para um consumidor só, e o dia em que a segunda capability aparecer é o dia de
decidir se ela merece tabela.

`default false` é o padrão seguro: empresa que nunca ouviu falar do módulo não
o recebe por omissão. Durante o desenvolvimento, a empresa piloto é habilitada
**explicitamente**.

> **Capability não é permissão.** `ctoNetworkEnabled = true` diz que o módulo
> existe para aquela empresa; ele **não** diz que quem chamou pode agir. As duas
> verificações são independentes e as duas continuam obrigatórias — a
> autorização de perfil (`C-07`) roda igual, com a capability ligada.

### `C-05` — a ONT NÃO entra em `CustomerNetworkConnection`

Sem `equipmentId` na `CTO-2`. O motivo é do código, não de preferência:
`ServiceOrderEquipment` é uma linha **por OS** (`serviceOrderId` obrigatório,
apagada em cascata com a OS) e `serial`/`macAddress` são **opcionais** desde a
v0.10, quando a identificação passou a ser a foto da etiqueta. Não existe, hoje,
identidade estável do equipamento fora da OS: uma troca de ONT numa segunda OS
cria outra linha, e um aparelho sem série nem MAC não tem chave nenhuma.

Amarrar o vínculo de rede a essa tabela faria a topologia herdar o ciclo de vida
de uma ordem de serviço. **Nenhuma entidade `Equipment` global é inventada
nesta fase.** CTO e porta funcionam sem ONT — e a CTO continua não mostrando
série nem modelo, como a §7 já autorizava.

### `C-06` — renomear a CTO

`CTO.name` é **editável**; continua único por empresa. `CTO.code`, quando
usado, é **imutável depois da criação** — é ele que serve de âncora estável
para quem precisa de identificador que não muda.

Renomear **não** cria CTO nova, **não** altera conexões históricas, **não**
troca `id` e **não** reescreve histórico. Trocar a etiqueta da caixa no poste
não muda quem está ligado nela. `AuditLog` registra `before`, `after`, ator,
empresa e horário do **servidor**.

### `C-07` — quem gerencia a CTO na `CTO-1`

| Perfil | Na `CTO-1` |
|---|---|
| `ADMIN` | criar, editar, inativar, alterar capacidade, gerenciar `administrativeState`, enviar e substituir foto |
| `DISPATCHER` | **não altera CTO** |
| `TECHNICIAN` | **não altera CTO** |

Leitura é aberta **por fase que precise dela**, não por antecipação: a `CTO-2`
abre o que o técnico precisa para escolher porta, a `CTO-4` o que a tela de
detalhe precisa. Conceder privilégio amplo agora, "porque depois vai precisar",
é como um perfil ganha permissão que ninguém revisou.

### `C-08` — autorização do vínculo pelo Field (fecha para a `CTO-2`)

O técnico cria ou move vínculo pelo Field somente quando **todas** valem:

```text
autenticado como técnico válido e ativo
mesma Company                          (sessão, nunca payload)
a OS pertence à mesma Company
a OS está IN_PROGRESS
a OS está sob autoridade daquele técnico, pela regra que já existe
o Customer do vínculo é EXATAMENTE o Customer da OS
```

A última linha é a que impede o vetor mais barato: uma OS legítima do próprio
técnico usada para conectar **outro** cliente a uma porta.

O predicado de posse é o que o projeto já usa — `loadInProgressOwnedOrder`
(`src/lib/service-order-child-mutation.ts`), que chama `loadOwnedServiceOrder`
(`src/lib/service-orders.ts`). É o mesmo portão de evidência, material,
equipamento, assinatura e checklist. **Não se escreve um segundo:** errar essa
função erra todas as escritas de uma vez, e é exatamente por isso que ela é
uma só.

Campos cuja autoridade é do **servidor**, e que são ignorados no payload:

```text
companyId          da sessão
technicianId       do vínculo usuário→técnico
serviceOrderId     do contexto da OS
source             FIELD, definido pelo servidor
connectedAt        horário do servidor
disconnectedAt     horário do servidor
```

### `C-09` — criação das portas

Automática: `capacity = N` cria `1..N` na **mesma transação** da CTO. Sem
criação manual porta a porta. Falhou uma, a CTO inteira não nasce. Detalhes e
o caso do aumento estão na §11.

### `C-10` — alteração de capacidade

Aumentar cria as faltantes e **reutiliza** linha histórica preexistente;
reduzir **não apaga** nada e é recusada com vínculo ativo, `RESERVED` ou
`DAMAGED` acima da nova capacidade. `capacity` corrente não é a contagem de
linhas. §11.

### `C-11` — um cliente, uma porta

Segunda unique parcial, `(customerId) WHERE disconnectedAt IS NULL`. Fecha o
buraco de `CTO-AC05`, que era promessa sem mecanismo. §4.

> **A `CTO-2` deve provar isso por corrida real**, não por afirmação: o mesmo
> cliente movido simultaneamente para duas portas diferentes, com asserção que
> **proíbe** o desfecho ruim (exatamente um vínculo ativo), e a corrida
> repetida — se o vencedor é sempre o mesmo, não houve corrida.

### `C-12` — foto da CTO

Opcional, e **somente pela Web/Admin** na `CTO-1`. Nenhum upload pelo Field
nesta fase.

Qualquer upload de imagem da CTO passa pela **mesma política de servidor** já
endurecida no `PC-1`: MIME real por sniff (não o declarado), sanitização de
metadado, GPS fora, XMP/IPTC/comentário fora, trailer depois do `EOI` fora,
teto de tamanho e teto de segmentos.

> **Nada de copiar `stripImageMetadata` para um terceiro lugar.** Hoje a
> limpeza é chamada em exatamente dois pontos (`addEvidence` e `putSignature`,
> em `src/lib/service-order-closing.ts`), e foi assim — um ponto novo nascendo
> fora da política — que o `EXIF-01` existiu. A `CTO-1` **primeiro extrai** a
> fronteira comum (sniff + teto + sanitização + tradução de falha em 400) para
> um módulo compartilhado e converte os dois pontos existentes a ela; só então
> acrescenta o terceiro consumidor.

O cliente **não** envia caminho de armazenamento: a chave é construída no
servidor a partir de tenant e recurso, como `buildStorageKey` já faz.

### Origem do vínculo — `source`

> **SUPERADO pela decisão do dono na `CTO-2.0.1`. Ver §24.** O enum congelado é
> **`FIELD · WEB`**: a operação administrativa Web passou a fazer parte da
> `CTO-2`, e `IMPORT` caiu por não ter caso de uso. O parágrafo abaixo fica como
> registro do que se decidiu antes, e **não** deve ser seguido.

~~O enum permanece `FIELD · WEB · IMPORT` conceitualmente. A `CTO-2` implementa
**`FIELD`**, e só. `WEB` e `IMPORT` ficam reservados: **não se cria endpoint
porque o enum tem o valor** — um caminho de escrita sem caso de uso é superfície
de ataque sem dono.~~

O princípio que sustentava a frase **continua valendo** e é o que mata `IMPORT`:
endpoint só nasce com caso de uso. O que mudou foi o fato — `WEB` ganhou um.

### Fronteira com `ServiceOrder` e `Customer` — congelada

```text
ServiceOrder   NÃO recebe ctoId, ctoPortId nem customerNetworkConnectionId
Customer       NÃO recebe ctoId
```

A direção é sempre a mesma, e é ela que faz o vínculo sobreviver à OS
(`N-14`):

```text
CustomerNetworkConnection → Customer
                          → CTOPort → CTO
                          → ServiceOrder   (procedência, opcional)
```

`serviceOrderId` é **procedência, não posse**.

### Movimentação — requisito obrigatório da `CTO-2`

Mover `porta antiga → porta nova` fecha o vínculo anterior e abre o novo **na
mesma transação**, preservando histórico. Além disso:

* **travar o estado autoritativo** antes de decidir. Transação sozinha **não**
  resolve: sem lock, duas movimentações do mesmo cliente leem o mesmo vínculo
  aberto e as duas tentam fechá-lo;
* **ordem determinística de locks quando duas CTOs são tocadas.** A `DQ-2` já
  pagou esse preço: travar o destino primeiro e ordenar depois é o mesmo que
  não ordenar. Os identificadores são descobertos e ordenados **antes** de
  qualquer `FOR UPDATE`.

Fica registrado como requisito de design da `CTO-2`. **Não se implementa
agora.**

### Offline — congelado

Porta **nunca** é reservada offline. A `CTO-2` é **online-only para mutação**.

Isso hoje não custa esforço nenhum: o motor offline do Field não existe —
`apps/field/lib/core/sync/pending_operation.dart` se declara contrato preparado
e não construído, e não há banco local no aplicativo. **Nenhum motor offline é
construído para viabilizar a CTO.** O cache da última topologia conhecida (§12)
pertence à fundação de offline, quando ela existir.

### QR — congelado

`CTO_QR_IDENTIFICATION`: opcional, **desligado por padrão**, fase `CTO-7`.
Nenhum código de QR em fase nenhuma antes disso.

### Sequência ativa

```text
CTO-1 → CTO-2 → CTO-4 → CTO-5
```

`CTO-3` continua bloqueada pelo Mapa Operacional (PRD §136, sem código);
`CTO-6`, por estratégia de frescor (`C-03`); `CTO-7` é opcional. **Nenhuma das
três é promovida aqui.**

---

## 17. Contrato de schema congelado

Duas migrations separadas, uma por fase. **A `CTO-1` não cria a tabela de
vínculo**: uma tabela sem escrita é superfície que ninguém exercita, e a unique
parcial que a protege só se prova com o caminho que a usa.

### Migration da `CTO-1` — aditiva

```text
ALTER Company
  ctoNetworkEnabled   Boolean  NOT NULL  DEFAULT false

CREATE ctos
  id                  cuid, PK
  companyId           FK Company        Cascade
  name                text              obrigatório
  code                text?             imutável após criação (regra de serviço)
  capacity            int               > 0
  latitude            Decimal(10,7)?
  longitude           Decimal(10,7)?
  addressReference    text?
  notes               text?
  photoStorageKey     text?             construída no servidor
  active              Boolean           default true
  createdAt/updatedAt

  UNIQUE (companyId, name)
  INDEX  (companyId)
  CHECK  capacity > 0

CREATE cto_ports
  id                  cuid, PK
  ctoId               FK CTO            Restrict
  companyId           FK Company        Cascade
  number              int               > 0
  administrativeState enum              default AVAILABLE
  notes               text?
  createdAt/updatedAt

  UNIQUE (ctoId, number)
  INDEX  (companyId)
  CHECK  number > 0

CREATE ENUM CtoPortAdministrativeState
  AVAILABLE · RESERVED · DAMAGED
```

`CTO → CTOPort` é **`Restrict`**, não `Cascade`: `N-13` proíbe apagar CTO com
histórico, e a operação suportada é inativar. É a mesma escolha que
`Technician → TechnicianDispatchQueue` fez na `DQ-1`, pelo mesmo motivo.

`Company → CTO` permanece `Cascade` porque apagar a empresa inteira é a
operação de saída do tenant, e ela já leva tudo.

### Migration da `CTO-2` — aditiva

```text
CREATE customer_network_connections
  id                  cuid, PK
  companyId           FK Company        Cascade
  customerId          FK Customer       Restrict
  ctoPortId           FK CTOPort        Restrict
  serviceOrderId      FK ServiceOrder?  SetNull    procedência
  technicianId        FK Technician?    Restrict
  connectedAt         timestamptz
  disconnectedAt      timestamptz?
  source              enum
  reason              text?
  createdAt/updatedAt

  UNIQUE PARCIAL (ctoPortId)  WHERE "disconnectedAt" IS NULL     SQL cru
  UNIQUE PARCIAL (customerId) WHERE "disconnectedAt" IS NULL     SQL cru
  INDEX (companyId, customerId)
  INDEX (companyId, ctoPortId)

CREATE ENUM NetworkConnectionSource
  FIELD · WEB · IMPORT
```

`serviceOrderId` é `SetNull` porque é **procedência**: perder a OS não pode
apagar o vínculo de rede (`N-14`). `customerId` e `ctoPortId` são `Restrict` —
apagar cliente ou porta com vínculo histórico destruiria a resposta que a
capability inteira existe para dar.

> Nenhum destes dois blocos autoriza escrever migration fora da sua fase. Este
> é o contrato que a fase vai implementar, e existir aqui é o que impede que a
> fase o invente diferente.

---

## 18. Revisão de segurança do contrato congelado

Aplicado o checklist de `alfaos-security-review` ao **contrato**, não a código.

> **Limitação declarada, e ela é dura:** não existe implementação para atacar.
> Nada aqui foi provado por execução, corrida real ou resposta HTTP. Isto é
> revisão de design: reclassifica o que o congelamento fecha **por
> construção** e separa o que continua dependendo de a implementação acertar.
> Nenhum item abaixo substitui a auditoria da fase.

### Reclassificação dos riscos levantados na `CTO-0`

| # | Risco | Situação |
|---|---|---|
| `R-01` | cliente com dois vínculos ativos | **FECHADO por construção** — segunda unique parcial `(customerId) WHERE disconnectedAt IS NULL` (`C-11`). O banco recusa; a `CTO-2` prova por corrida real |
| `R-02` | tenancy cruzada entre as quatro FKs | **CONTINUA CRÍTICO.** O congelamento **não** fecha isto: `ServiceOrder.technicianId` é FK simples, sem `(companyId, technicianId)`, e a `DQ-7.1` já explorou esse vetor. O `C-08` exige que CTO, porta, cliente, técnico e OS sejam verificados **no serviço**, em predicado SQL com `companyId` da sessão. **Requisito número um da implementação** |
| `R-03` | terceiro ponto de upload fora da limpeza de EXIF | **FECHADO por política** (`C-12`): a `CTO-1` extrai a fronteira comum e converte os dois pontos existentes **antes** de acrescentar o terceiro. Sem a extração, volta a abrir |
| `R-04` | dupla fonte de verdade da ocupação | **FECHADO por construção** — `OCCUPIED` não é valor gravável (§3) |
| `R-05` | mass assignment | **MITIGADO, não fechado.** O `C-08` lista os seis campos cuja autoridade é do servidor; a implementação ainda precisa de whitelist que **rejeita** campo desconhecido, não que o remove em silêncio |
| `R-06` | PII na projeção da CTO | **CONTINUA.** Dono: `CTO-4`. A §10 autoriza nome e estado; um DTO por spread de `Customer` vazaria CPF, telefone e endereço de vários clientes numa tela só |
| `R-07` | enumeração na busca por nome | **CONTINUA.** `N-03` manda 404, não 403; o filtro de tenant vai no predicado SQL, nunca por navegação de FK |
| `R-08` | porta duplicada sob corrida | **FECHADO por construção** — `UNIQUE (ctoId, number)` mais criação na mesma transação (`C-09`) |
| `R-09` | cascade apagando histórico | **FECHADO por construção** — `Restrict` em `CTO → CTOPort`, `Customer`, `CTOPort` e `Technician`; a operação suportada é inativar (`N-13`) |
| `R-10` | auto-DoS do teto de 10/min | **CONTINUA, não bloqueia.** Dono: `CTO-5` via `C-03`. `CTO-1` e `CTO-2` não chamam o provider |
| `R-11` | foto da CTO fora do ciclo de posse da OS | **FECHADO por escopo** — só `ADMIN`, só Web, na `CTO-1` (`C-07`, `C-12`) |

### Três riscos NOVOS, introduzidos pelo próprio contrato

Congelar decisões cria superfícies que antes não existiam. Estas são delas.

**`R-13` — porta histórica acima da capacidade continua sendo um `ctoPortId`
válido.** É o mais sério dos três, e é consequência direta do `C-10`.

Reduzir a capacidade **não apaga** a porta 12; ela sobrevive como histórico.
Nada no banco a impede de receber um vínculo novo — a unique parcial só diz
"no máximo um", não "esta posição é ofertável". Se a validação de faixa viver
apenas na **listagem** que a tela consome, um payload com o `ctoPortId` da
porta 12 conecta o cliente a uma posição que a empresa declarou não existir
mais, e a redução de capacidade vira sugestão.

> **A validação `number <= capacity` é obrigatória na ESCRITA do vínculo, não
> só na listagem.** A UI não é controle de segurança; ela é a lista de opções.

E ela **não pode** ser um CHECK de banco: seria cross-table (`CTOPort.number`
contra `CTO.capacity`) e contradiria o próprio `C-10`, que exige linhas com
`number > capacity` sobrevivendo. O banco garante o imutável por linha
(unicidade, positividade); a faixa ofertável muda no tempo e é decidida na
transação que escreve.

**`R-12` — capability e permissão precisam ser verificadas nas DUAS pontas.**
O `C-02` diz que capability não é permissão, e o inverso também vale: uma rota
que checa só o perfil opera um módulo que a empresa não contratou. Com
`ctoNetworkEnabled = false`, toda rota do módulo — leitura inclusive — responde
como se ele não existisse. Verificar a capability só no componente de página
deixaria a API aberta; é o mesmo erro de tratar UI como controle.

**`R-15` — `code` imutável é regra de serviço, e o schema não a expressa.**
Postgres não tem coluna "somente escrita na criação". Sem uma verificação
explícita no caminho de update, `code` vira editável na primeira rota que
aceitar o campo inteiro do formulário — e ele existe justamente para ser a
âncora que não muda (`C-06`).

### O que continua sem cobertura possível nesta fase

Concorrência real, IDOR real, resposta HTTP real e comportamento de transação
**não** foram exercitados, porque não há o que exercitar. A prova de `R-01`,
`R-02`, `R-13` e da movimentação é da auditoria das fases, com corrida real
(`Promise.all`), controle positivo e asserção que **proíbe** o desfecho ruim.

**Veredito do design:** `APPROVED WITH RISKS`. Nenhum bloqueador para iniciar a
`CTO-1`. `R-02` e `R-13` são os dois que a implementação não pode errar, e os
dois já têm requisito escrito.

---

## 19. Contrato de implementação da `CTO-1`

O que a próxima fase entrega, e o que ela **não** entrega.

### Escopo

```text
ENTRA   Company.ctoNetworkEnabled · CTO · CTOPort · portas automáticas
        capacidade (criar, aumentar, reduzir) · administrativeState
        inativação · foto opcional · tela web de ADMIN · auditoria

NÃO ENTRA
        CustomerNetworkConnection      é CTO-2
        qualquer superfície no Field   é CTO-2
        mapa                           é CTO-3, bloqueada
        status ONLINE/OFFLINE          é CTO-5
        QR                             é CTO-7
        endpoint WEB/IMPORT de vínculo  reservado, sem caso de uso
```

### Arquivos esperados

```text
prisma/schema.prisma                          Company + CTO + CTOPort + enum
prisma/migrations/<ts>_add_cto_network/       aditiva; SQL da §17

src/lib/cto.ts                                serviço do domínio
src/lib/media/image-upload.ts                 fronteira comum extraída (C-12)
src/lib/service-order-closing.ts              convertido à fronteira comum

src/app/api/ctos/route.ts                     GET lista · POST cria
src/app/api/ctos/[id]/route.ts                GET detalhe · PATCH edita
src/app/api/ctos/[id]/photo/route.ts          POST foto
src/app/(app)/ctos/page.tsx                   lista
src/app/(app)/ctos/[id]/page.tsx              detalhe e portas

src/tests/cto.test.ts                         domínio, tenancy, capacidade
src/tests/cto-routes.test.ts                  autorização, capability, IDOR
e2e/ctos.spec.ts                              fluxo de ADMIN
```

Nomes são a convenção do projeto, não contrato: o que é contrato é a separação
entre serviço, rota e tela, e o fato de a **fronteira de imagem ser extraída
antes** de ganhar o terceiro consumidor.

### Autorização — as três verificações, nesta ordem

```text
1. sessão válida                          401
2. companyId da sessão                    nunca do payload
3. Company.ctoNetworkEnabled === true     404 quando desligada
4. perfil ADMIN                           403
```

A capability responde **404**, não 403: 403 confirmaria que o módulo existe
para quem não o contratou. Recurso de outra empresa: **404** (`N-03`).

### Auditoria

`CTO.CREATED` · `CTO.UPDATED` · `CTO.INACTIVATED` · `CTO.CAPACITY_CHANGED` ·
`CTO.PORT_STATE_CHANGED` · `CTO.PHOTO_UPDATED`, com ator, empresa, entidade,
horário do **servidor** e antes/depois. Nomes de campo alterados, nunca o
conteúdo inteiro; nenhum segredo, nenhuma coordenada de cliente.

### Concorrência da `CTO-1`

Duas edições simultâneas de capacidade na mesma CTO. A criação de portas é
transacional e `UNIQUE (ctoId, number)` arbitra; o perdedor recebe conflito
explícito, nunca porta duplicada. **A corrida precisa ser real** (`Promise.all`)
e a asserção precisa proibir o desfecho ruim — contar portas e exigir o número
exato, não "pelo menos".

### Testes obrigatórios

```text
tenant           empresa A não lê, edita nem inativa CTO de B — 404, com
                 controle positivo provando que o caminho autorizado devolve
capability       desligada → 404 em TODAS as rotas, inclusive leitura
perfil           DISPATCHER e TECHNICIAN não alteram CTO
portas           capacity=N cria 1..N na mesma transação; falha → nada nasce
aumento          8→16 cria 9..16 e REUTILIZA linha histórica existente
redução          recusada com vínculo ativo, RESERVED ou DAMAGED acima
histórico        redução não apaga CTOPort; capacity != contagem de linhas
corrida          duas alterações de capacidade simultâneas → sem duplicata
name             único por empresa; renomear não altera id nem histórico
code             imutável depois da criação                        (R-15)
imagem           EXIF/GPS/XMP/trailer removidos no servidor; MIME real;
                 teto de tamanho; storageKey construída no servidor
mass assignment  companyId, id, createdAt e number rejeitados no payload
```

### Gates

`npm run lint` · `npx tsc --noEmit` · `npm test` · Playwright do fluxo tocado ·
`npm run build` · `npx prisma validate` · `npx prisma migrate status`.
Sem dependência nova, então sem `npm audit` obrigatório — **se alguma for
proposta, ela é decisão à parte, justificada antes de instalar**.

### Definition of Done

```text
1. migration aditiva aplica em banco vazio e em banco com dados; zero DROP
2. as três verificações de autorização provadas por teste, com controle positivo
3. R-02 e R-13 fechados com teste dedicado, não por inspeção
4. a fronteira de imagem EXTRAÍDA e os dois pontos existentes convertidos —
   zero cópia nova de stripImageMetadata
5. todos os gates verdes, com os números registrados
6. docs/CONTEXT-MAP.md e CLAUDE.md atualizados: CTO-1 deixa de ser PLANNED
7. relatório com sabotagens e prova de reversão, no padrão das fases anteriores
8. nenhuma tag, nenhum push, sem autorização explícita
```

**Validação física:** não se aplica à `CTO-1` (web, sem Field). Ela é
obrigatória na `CTO-2`, onde `CTO-AC06` só se prova com dois aparelhos
disputando a mesma porta.

---

## 20. `CTO-1` — IMPLEMENTADA

Cadastro de CTO, portas, capacidade, localização, estados administrativos da
porta, foto opcional, tela de ADMIN e auditoria. **Uma migration aditiva.**

**O que continua não existindo:** `CustomerNetworkConnection`, vínculo de
cliente a porta, qualquer superfície no Field, mapa, status `ONLINE/OFFLINE` e
QR. `ServiceOrder` e `Customer` não foram tocados.

> **`OCCUPIED` permanece DERIVADO.** Ele existe como valor de apresentação
> (`CtoPortEffectiveState`) e **não** existe no enum do Prisma — não há coluna
> capaz de recebê-lo. Ele só passa a ser produzido quando a `CTO-2` trouxer
> `CustomerNetworkConnection`, a partir de `disconnectedAt IS NULL`. Até lá,
> a contagem de ocupadas é `0` e a tela diz por quê, em vez de esconder a linha.

### O contrato de rotas foi COMPLETADO, e o registro importa

A §19 previa três arquivos de rota — `/api/ctos`, `/api/ctos/[id]` e
`.../photo` — e a fase precisou de três operações que nenhum deles endereçava:
**alterar capacidade**, **inativar** e **mudar o estado administrativo de uma
porta**. A lacuna era do contrato, não do enunciado da fase, que pede as três.

Elas **não** entraram como campos de um `PATCH` genérico. O projeto não tem
endpoint de mudança de estado que aceite `{ status }` ao lado de qualquer outro
campo — é assim que `companyId` e `status` entram de carona —, e o precedente é
`POST /api/service-orders/:id/priority` (DQ-3) e
`POST /api/dispatch/technicians/:id/queue/reorder`. Ações explícitas, cada uma
com auditoria própria.

Superfície final:

```text
GET    /api/ctos                                lista
POST   /api/ctos                                cria (com as portas)
GET    /api/ctos/:id                            detalhe + portas
PATCH  /api/ctos/:id                            campos descritivos
POST   /api/ctos/:id/capacity                   aumentar / reduzir
POST   /api/ctos/:id/active                     inativar / reativar
POST   /api/ctos/:id/ports/:portId/state        AVAILABLE · RESERVED · DAMAGED
POST   /api/ctos/:id/photo                      enviar / substituir
GET    /api/ctos/:id/photo                      servir os bytes
```

**Não existe `DELETE`**, em rota nenhuma. A ausência é a `N-13` expressa em
superfície, e o schema a reforça com `Restrict` em `CTO → CTOPort`.

### A sequência de autorização vive num lugar só

`requireCtoAccess` (`src/lib/cto-access.ts`), e todas as rotas passam por ela.
Espalhá-la por seis arquivos garantiria que o sétimo esquecesse uma etapa.

```text
sessão ausente        401
capability desligada  404      ← antes do perfil
perfil errado         403
recurso de outra empresa 404   (no domínio, por predicado SQL)
```

**A capability vem antes do perfil, e inverter vaza informação:** com o perfil
primeiro, um `DISPATCHER` de empresa que não contratou o módulo receberia 403 —
"isto existe, você é que não pode" —, e a empresa descobriria pela mensagem de
erro que há um módulo CTO. Há um par de testes para isso: o mesmo perfil recebe
404 com a capability desligada e 403 com ela ligada, o que prova de qual das
duas verificações cada resposta veio.

A capability é lida do **banco** a cada requisição, nunca da sessão: o token é
emitido no login e carregaria o valor de então, de modo que desligar o módulo
só teria efeito quando cada pessoa reautenticasse.

### A fronteira de imagem foi EXTRAÍDA antes do terceiro consumidor

`src/lib/media/image-upload.ts` passou a ser o único lugar que decide o que é
uma imagem aceitável e o que sai dela: vazio, teto, sniff do tipo real,
allowlist, concordância declarado × detectado, e a sanitização de metadado.
`addEvidence` e `putSignature` foram **convertidos** a ela; a foto da CTO é o
terceiro consumidor, e não a terceira cópia.

As mensagens continuam sendo de cada superfície, por parâmetro: "Assinatura
vazia." orienta onde "Arquivo vazio." confundiria. Unificá-las teria trocado
uma duplicação de lógica por uma regressão de texto em superfícies homologadas.

**A prova de que a fronteira é uma só:** devolver os bytes originais em
`processImageUpload` derruba **12 testes de uma vez** — os de evidência, os de
assinatura e o da foto da CTO.

### O que a implementação encontrou e o plano não previa

**Uma corrida entre mudar o estado de uma porta e reduzir a capacidade.** A
mudança de estado parece isolada — um campo, numa linha — e disputa com a
redução, que decide se pode reduzir olhando o estado de todas as portas acima do
novo limite:

```text
redução lê a porta 12 como AVAILABLE
estado da porta grava RESERVED na 12
redução commita capacity = 8
→ porta reservada ACIMA da capacidade
```

Cada uma respondeu por metade da pergunta e ninguém respondeu pela caixa — é o
mesmo formato do problema que a fila operacional resolveu com `version` própria
mais `FOR UPDATE`. Aqui as duas operações passaram a travar a **CTO**, e a
leitura da porta acontece **depois** do lock: o estado lido antes de travar é
uma fotografia que já envelheceu quando se age sobre ela, e é dela que sai o
"de → para" da auditoria.

Depois da redução, marcar como reservada uma posição já fora da capacidade
continua permitido — é linha real, e registrar que ela está danificada é
legítimo. O que não pode é a redução acontecer *apesar* da reserva.

**Um teto de capacidade que o contrato não tinha.** O banco garante
`capacity > 0`, e sozinho isso aceita `capacity = 1_000_000`: a criação abre uma
transação que insere um milhão de linhas e segura o lock enquanto isso. Não é
hipótese exótica — é um campo numérico num formulário, e um zero a mais o
produz sem nenhuma má intenção. `CTO_MAX_CAPACITY = 256`.

**O tipo da foto não ganhou coluna.** Ele é derivado da extensão da chave, que
`buildStorageKey` escolheu a partir do tipo já sniffado — a chave é registro do
servidor sobre o servidor. Uma coluna separada seria uma segunda memória do
mesmo fato.

**`buildStorageKey` teve um parâmetro renomeado.** Chamava-se `serviceOrderId`
quando a OS era o único dono possível, e o nome passou a mentir. Só o nome
mudou: a função sempre foi um concatenador de segmentos.

### Riscos do design, na implementação

| | |
|---|---|
| `R-02` tenancy | `companyId` **sempre** da sessão; filtro em predicado SQL, nunca por navegação de FK. Nenhum `findUnique({ id })` sem tenant no módulo. Cross-tenant → 404 em leitura, edição, capacidade, inativação, porta e foto, cada um com controle positivo |
| `R-12` capability | verificada na API **e** na página; a página usa `notFound()` em vez de uma tela de "indisponível", que anunciaria o módulo a quem não o tem |
| `R-13` ofertabilidade | `isPortOfferable` é função exportada e testada **diretamente**, não um `where` de listagem. A `CTO-2` a chama na transação que escreve |
| `R-05` mass assignment | todo schema é `.strict()`: campo desconhecido é **rejeitado**, não descartado em silêncio — descartar deixaria quem tentou achando que funcionou |
| `R-15` `code` imutável | recusa explícita, inclusive ao **preencher** um código que era nulo; reenviar o mesmo valor é aceito, senão salvar sem mexer no código viraria erro |

### Limite declarado

A verificação de **vínculo ativo** na redução de capacidade não existe, porque
`CustomerNetworkConnection` não existe. Criar a tabela agora só para poder
consultá-la seria antecipar a `CTO-2` com uma superfície que nenhum caminho
escreve. O ponto exato onde a condição entra está marcado no código, ao lado
das duas que já valem.

**O blob da foto anterior não é apagado.** Substituir aponta a linha para a
chave nova e a antiga fica órfã. É o comportamento conservador: não há política
documentada de remoção, e apagar por suposição é como se perde evidência. O
custo é disco, uma imagem por substituição; a alternativa custaria dado. Um
coletor de órfãos é trabalho próprio, com política própria.

### `CTO-1.1` — a faixa no banco, e a metade que faltava da guarda de coordenada

Patch focal sobre duas ambiguidades que a `CTO-1` deixou. As duas tinham
**metade** fechada, e é a metade aberta que interessa.

**A faixa de capacidade agora vale em três camadas.** Ela existia no `zod` das
rotas e em `assertCapacity`, ambas de aplicação. Entrou o `CHECK` do banco
(`ctos_capacity_max_check`), que é o que sobrevive a um caminho de escrita novo
que esqueça as duas primeiras — e o que torna o limite fato da tabela em vez de
convenção. Mudar `CTO_CAPACITY_MAX` passa a exigir migration, de propósito: um
teto que a aplicação afrouxa sozinha não é teto.

> **Migration NOVA, não edição da anterior.** `20260906120000_add_cto_network`
> já fora aplicada em bancos locais, e reescrever o SQL de uma migration
> aplicada quebra o checksum e obriga a resetar. `20260906210000` é aditiva:
> aplica em base vazia e em base com dados pelo mesmo caminho.

**A guarda de coordenada do cliente estava pela metade, e a metade aberta era
minha.** Ela usava `Number.isNaN`, que fecha `"abc"` e **deixa `"Infinity"`
passar inteiro** — `Number.isNaN(Infinity)` é `false`.

O motivo de a guarda existir no cliente é do transporte, não da tela:

```text
JSON.stringify(NaN)       → null
JSON.stringify(Infinity)  → null
null nos dois campos      → "remova a coordenada", que é legítimo
```

O servidor recebe os dois casos como a mesma coisa e **não tem como
distingui-los**. Por isso a validação precisa acontecer antes de o JSON ser
montado, e o predicado correto é `Number.isFinite` — o único que corresponde ao
que o `JSON.stringify` de fato descarta. Provado por reversão: voltar para
`Number.isNaN` derruba o caso `Infinity` do E2E, que é o único teste capaz de
alcançar essa guarda.

**E o domínio tinha uma lacuna própria, por um motivo diferente.** Comparação
com `NaN` é sempre falsa: `NaN < -90` e `NaN > 90` são os dois `false`, então um
teste de faixa **sozinho deixa `NaN` passar**. A verificação parecia cobrir tudo
e não cobria o único valor que não se compara. `assertCoordinates` passou a
verificar finitude **antes** da faixa. O `zod` já recusava os dois; a guarda
existe para a chamada direta ao serviço, que é superfície pública do módulo e
será o caminho da `CTO-2`.

**Nenhum valor inválido vira `null` em lugar nenhum**, e nenhuma coordenada
gravada é apagada por entrada malformada.

**Recusa antes do trabalho.** `assertCapacity` roda antes da transação e antes
do `Array.from({ length: capacity })`, então `capacity = 1_000_000` é recusado
sem alocar nada e sem segurar lock. Testado pelas duas pontas: zero linhas
criadas e recusa imediata.

**Limite declarado:** a migration do `CHECK` **falharia** num banco que já
tivesse linha com `capacity` fora da faixa — verificado por ataque, não por
suposição. Hoje o risco é nulo: há zero linhas assim, a aplicação sempre
limitou a 256, e a `CTO-1` nunca foi publicada. Fica registrado para quem
aplicar a migration num banco de origem desconhecida.

### `CTO-1.2` — a coordenada fantasma era o placeholder

Achado da validação humana em navegador real: uma CTO criada **sem** coordenada
aparentava, na tela de detalhe, ter latitude `-23.5505199` e longitude
`-46.6333094`.

**Não havia coordenada persistida.** O banco tinha `NULL` nas duas, confirmado
por duas leituras independentes — o client do Prisma e SQL cru — e com
`createdAt == updatedAt` provando que a linha nunca fora editada depois de
criada. Doze testes escritos **antes** de qualquer correção passaram de
primeira, o que é a prova de que o backend nunca inventou coordenada: nem no
`create` sem os campos, nem ao editar nome, observações ou referência, nem ao
alterar capacidade, nem ao gravar foto.

O que a tela mostrava era o `placeholder`. Tecnicamente correto — `placeholder`
não é serializado no submit e o servidor recebia `NULL` —, e ainda assim o
defeito é real:

> **Um exemplo que se parece com o dado não é exemplo, é ambiguidade.** O
> placeholder usava uma coordenada real, completa e plausível. Em texto cinza,
> num campo que a pessoa não preencheu, isso é indistinguível de um valor
> gravado — e levou quem validava a concluir que o sistema inventara
> localização.

**A correção é de apresentação, e tem duas metades.** Os placeholders passaram
a ser prefixados por `ex.:`, o que os torna impossíveis de ler como valor; e a
tela passou a **dizer** que a caixa não tem coordenada, em vez de deixar a
conclusão por conta do contraste do texto. A segunda metade é a que fecha o
defeito de verdade: a primeira remove a ambiguidade, a segunda entrega a
informação que faltava.

O mesmo prefixo foi aplicado aos demais campos opcionais, pela mesma razão —
qualquer campo não preenchido tinha o mesmo problema, e só as coordenadas o
manifestaram porque foram as únicas que o operador deixou em branco.

**A prova está no valor, não no que se vê.** O teste que fixa isso é de
navegador e afirma `toHaveValue("")`: é o valor do campo que iria no submit,
enquanto o texto do placeholder é atributo. Um `defaultValue` com coordenada
real derruba essa asserção; o placeholder, não. Provado por reversão,
reintroduzindo o fallback no estado inicial do componente.

**Nada foi corrigido no dado**, porque não havia o que corrigir. A `CTO QA 01`
criada durante a validação tem `latitude = NULL` e `longitude = NULL` desde a
criação.

Revisão focada de privacidade de localização, no mesmo passo: a web **não usa**
`navigator.geolocation` em lugar nenhum, não existe default de coordenada em
código de produção, e nenhuma operação além da edição explícita de coordenada
escreve nesses dois campos.

### `CTO-1.3` — a recusa silenciosa da redução de capacidade

Achado da validação humana: com capacidade 16 e a porta 14 reservada, o
operador tentou reduzir para 8, clicou em **Alterar capacidade** e **nada
aconteceu na tela**.

**O backend estava certo.** Reproduzido contra o estado real, sem alterá-lo:
`409`, mensagem em português sem detalhe interno, `capacity` ainda 16, porta 14
ainda `RESERVED`, 16 portas, `updatedAt` **inalterado** e nenhum
`CTO.CAPACITY_CHANGED` novo. A recusa era total e correta.

**O erro era renderizado — num bloco único no topo do componente.** Entre ele e
o botão ficam o cartão de ocupação e a lista de portas, que pode ter até 256
linhas. A mensagem nascia fora da viewport de quem acabara de clicar.

> **Uma recusa invisível é indistinguível de um botão quebrado.** O operador
> não relatou "a mensagem está no lugar errado"; relatou "não funcionou" — que
> é a única leitura possível de uma tela que não reage.

**A correção é a boundary comum, não um remendo.** O estado de erro passou a
carregar o escopo (`details`, `capacity`, `ports`, `photo`, `active`) e cada
seção renderiza o seu, ao lado do botão que o provocou. Todas as quatro ações
da tela ganharam isso de uma vez — o problema nunca foi só da capacidade.

Mais três decisões no mesmo passo:

* **Depois da recusa o campo volta ao valor autoritativo**, e a seção passou a
  escrever quantas portas a caixa oferece hoje. Um input dizendo 8 ao lado de
  uma caixa que tem 16 é a mesma ambiguidade do placeholder de coordenada: a
  tela mostrando um número que o servidor não tem.
* **A validação nativa do navegador foi desligada no formulário** (`noValidate`).
  Com `min`/`max` no input, o navegador bloqueava o submit sozinho e mostrava um
  balão próprio — só em alguns casos, sumindo sozinho, sem `role="alert"` e no
  idioma dele. A tela falava ora pelo padrão do AlfaOS, ora pelo do Chrome. Os
  atributos ficam pela dica visual e pelos limites do spinner; o que sai é a
  interceptação.
* **A mensagem do domínio concorda em número.** "as portas 14 estão" saía errado
  justamente no caso mais comum, o de uma porta só.

**Duas coisas que a investigação corrigiu em mim**, e as duas eram hipóteses
minhas que os dados derrubaram:

1. Achei que a mensagem sumia porque `SectionError` era um componente declarado
   dentro do pai — anti-padrão real, e **não** era a causa. Virou função que
   devolve JSX de qualquer forma, mas o sintoma continuou.
2. O que de fato quebrava o teste era **hidratação**: um `fill` disparado
   milissegundos após a navegação escreve no DOM, não chega ao estado do React,
   e o primeiro render do cliente devolve o campo ao valor inicial — o
   formulário submetia o número antigo. Um operador humano nunca digita nos
   300 ms seguintes ao carregamento; um teste digita. Instrumentei o componente
   para ler o estado (`cap=16|err=null`) em vez de continuar supondo.

A prova de que a hipótese da viewport era a certa veio por reversão: devolver o
erro ao bloco do topo derruba o teste **exatamente** em `toBeInViewport` — a
mensagem existe, e não está onde a pessoa olha.

### `CTO-1.4` — a mensagem existia; o que faltava era ela parecer um erro

Achado da validação humana: o operador digitou `0` na capacidade, clicou, viu o
campo voltar para 16 — e não registrou nenhuma mensagem na tela.

**A mensagem estava sendo renderizada.** Reproduzido no ambiente real, com
hidratação detectada explicitamente (`__reactFiber$` no nó do campo) e digitação
por teclado: nenhuma requisição sai, o campo volta ao valor autoritativo, e o
`<p role="alert">` está no DOM com o texto correto. A validação local sempre
funcionou.

**O defeito era a cor, e ele era meu.** Eu havia escrito `text-danger-text`, e o
design system define `danger.fg` — `danger.text` não existe. Tailwind ignora
classe desconhecida em silêncio, então o texto herdava a cor normal:

```text
antes   fundo rgb(254,242,242) · texto rgb(15,23,42)   preto sobre rosa claro
depois  fundo rgb(254,242,242) · texto rgb(185,28,28)  vermelho
```

Um bloco rosa com texto preto não lê como alerta. O operador olhou a tela e
concluiu, com razão, que nada havia acontecido.

> **Os dois únicos arquivos do projeto inteiro com a classe inventada eram os
> meus.** O mesmo erro atingia `text-success-text` e `text-warning-text`, então
> os selos **Livre**, **Reservada** e **Danificada** também saíam sem cor de
> texto. Todo o resto do AlfaOS usa `-fg` corretamente.

### Por que nenhum teste pegou

Todos afirmavam **existência e texto** — `toBeVisible`, `toContainText`,
`toBeInViewport` — e a mensagem sempre esteve visível, no lugar certo, com o
conteúdo certo. Nenhuma asserção olhava para a **aparência**, que era a única
coisa quebrada.

Agora há duas que olham: a cor do alerta precisa ter o canal vermelho dominando
os outros, e a cor do selo de porta precisa diferir da cor do texto comum da
página. Nenhuma delas fixa um hex — isso quebraria a cada ajuste de tema sem
que nada estivesse errado.

**E o teste passou a digitar como gente:** foco, `Ctrl+A`, teclas, depois de
hidratação **explícita**. O helper anterior repetia `fill` até o valor grudar;
ele converge, e esconde de qual lado veio a demora. Espera nomeada é melhor que
espera embutida.

### A mensagem passou a ser a regra, não o lado violado

Eram duas — "maior que zero" para o piso e "máxima é 256 portas" para o teto.
Quem digitava `0` ficava sabendo que precisa de mais, e não de quanto. Agora é
uma só, no domínio e nas duas telas: **"A capacidade deve ser um número inteiro
entre 1 e 256 portas."**

### `CTO-1.5` — a recusa passou a dizer QUAL campo e POR QUÊ

Achado da validação humana: latitude `91` com longitude válida era recusada
corretamente — e a tela dizia apenas **"Dados inválidos."**

**A causa era autoridade duplicada.** Rota e domínio conheciam a faixa
`-90..90`, e a da rota chegava primeiro:

```text
zod  latitude: z.number().min(-90).max(90)
     → "Invalid input"  →  jsonError("Dados inválidos.", 400, details)
client  lê payload.error  →  "Dados inválidos."
domínio  a mensagem específica de latitude       ← nunca alcançada
```

Duas camadas sabiam a mesma regra, e quem falava era a que tinha menos a dizer.
O detalhe existia em `details.fieldErrors`, em inglês e sem a faixa, e o cliente
nem o lia.

**Agora o `zod` valida FORMA e o domínio valida REGRA.** O schema pergunta
"isto é um número finito?"; `assertCoordinates` pergunta "este número é uma
coordenada?". Nada foi relaxado — todo caminho de escrita atravessa o domínio,
inclusive a chamada direta ao serviço, e há teste provando pelas duas portas.

**`DomainError` ganhou `field`.** A recusa carrega o nome do campo público que o
próprio cliente enviou — `latitude`, `longitude` —, nunca uma coluna, um id ou
um caminho. A alternativa seria a tela adivinhar o campo pelo texto da
mensagem, e parsing de frase humana quebra na primeira melhoria de redação.

O par incompleto **não** nomeia campo, de propósito: o erro é da combinação, e
apontar um dos dois sugeriria que o problema está nele. A tela marca os dois.

### O campo em erro é visível, e não só pela cor

`aria-invalid` no input, `aria-describedby` apontando para a mensagem da seção,
borda e fundo de erro. A cor nunca é o único sinal.

**Duas armadilhas de Tailwind foram atravessadas nesta fase**, e as duas custam
o mesmo: uma classe que não pinta nada.

A primeira é a de `CTO-1.4` — classe inexistente. Aqui os tokens foram
conferidos no `tailwind.config.ts` **antes** de escrever, e o CSS gerado
confirma que as quatro classes usadas existem (`border-danger-border`,
`bg-danger-bg`, `ring-danger-border`, `text-danger-fg`) e que nenhuma inventada
aparece.

A segunda é nova e mais sutil: **concatenar `border-danger-border` a uma base
que já traz `border-input-border` não pinta a borda de vermelho.** As duas
produzem `border-color`, e quem vence é a ordem em que o Tailwind as emite no
CSS — não a ordem na string de classes. O campo ficava com `aria-invalid="true"`
e borda cinza, visualmente idêntico a um campo correto. A classe passou a ser
montada em duas partes, com apenas uma das bordas entrando em cada render.

### O teste que eu escrevi primeiro era fraco

A asserção original comparava a borda do campo em erro com a de um campo normal
e exigia que **mudasse**. A sabotagem `Q` passou por essa fresta: trocar a
classe de erro por uma inexistente também muda a borda — ela cai para o padrão
do navegador, porque a classe normal não está mais lá.

A asserção passou a exigir o **canal vermelho dominando**, sem fixar hex (hex
quebraria a cada ajuste de tema). Com isso a sabotagem cai, e cai dizendo o
porquê: *"borda deveria ser avermelhada, veio rgb(229, 231, 235)"*.

### Copy das mensagens de coordenada — decisão de produto

A primeira versão das mensagens trazia a faixa: *"A latitude deve estar entre
-90 e 90."* A copy foi simplificada por decisão do produto para:

```text
latitude inválida    Latitude inválida. Informe o valor correto.
longitude inválida   Longitude inválida. Informe o valor correto.
par incompleto       Coordenadas incompletas. Preencha latitude e longitude
                     juntas ou deixe os dois campos vazios.
```

**Formato e faixa passaram a compartilhar a mesma mensagem por campo.** Antes
eram duas — uma para "não é número" e outra para "está fora da faixa" —, e agora
a pessoa vê a mesma frase nos dois casos.

> **Só o texto mudou.** As faixas continuam sendo `-90..90` e `-180..180` no
> domínio, o `field` estruturado continua nomeando o campo, e os testes de
> limite (`-90`, `90`, `-180`, `180`, `91`, `-91`, `181`, `-181`, `NaN`,
> `Infinity`) continuam exatamente onde estavam. O que a mensagem deixou de
> dizer, a regra continua fazendo.

### `CTO-1.6` — a troca de foto era invisível, e o botão principal vinha cedo demais

Dois achados da validação humana, e o primeiro é o mais instrutivo: **a
substituição de foto já funcionava.** Provado antes de tocar em código — a
referência muda, o conteúdo servido muda, existe uma única referência ativa e o
resto da CTO fica intacto.

O que faltava era a tela dizer isso. Escolher o arquivo já o enviava, e a única
mudança visível era o input voltar a "Nenhum arquivo escolhido". Sem preview,
sem confirmação, sem estado de progresso.

> **Uma operação que acontece sem sinal é pior que uma que falha com aviso.**
> Quem falha sabe que precisa tentar de novo; quem não recebe sinal nenhum não
> sabe sequer o que aconteceu.

**Modelo escolhido: upload com ação própria, não junto do "Salvar
alterações".** As duas opções foram consideradas. Unificar exigiria o `PATCH`
de JSON carregar arquivo, ou orquestrar dois envios num submit — mudança de
contrato da API para resolver um problema que era de ordem visual. A foto já
tem rota `multipart` própria e auditoria própria (`CTO.PHOTO_UPDATED`);
mantê-las separadas, com botão explícito, resolve o achado sem mexer na
arquitetura. **O que não se mantém é o envio silencioso.**

A seção da foto passou para **dentro** do formulário, antes do botão, que virou
**"Salvar alterações"**. A ordem agora acompanha o que a pessoa faz: percorre os
campos, olha a foto, e só então encontra a ação que fecha o trabalho.

**A miniatura reusa a rota autenticada que já servia os bytes** — sessão,
capability, perfil e tenant, sem endpoint novo e sem afrouxar nada. A chave do
storage não aparece no HTML: o `src` é o id da CTO, que a pessoa já conhece. O
`updatedAt` no fim da URL é o que faz a imagem trocar depois da substituição;
sem ele, o navegador poderia reexibir a cópia que já tinha e a troca pareceria
não ter ocorrido — que é justamente o defeito relatado.

O precedente que dispensou mudança na entrega: o projeto **já** exibe evidência
de OS em `<img src="/api/...">` com `Content-Disposition: attachment`, porque
navegadores só aplicam esse cabeçalho em navegação de topo, não em
subrecursos. A defesa extra fica de pé e o preview funciona.

**Blob antigo continua órfão**, como já estava declarado no §20 — a
substituição aponta a linha para a chave nova e não apaga a anterior. Sem
política de remoção, apagar por suposição é como se perde evidência; o custo é
disco, uma imagem por troca.

### `CTO-1.7` — o cache-buster do preview NÃO é cosmético

Registro corrigido pela `CTO-1.8`, que o mediu em vez de afirmá-lo. A frase
acima diz que sem o `updatedAt` "o navegador **poderia** reexibir a cópia que já
tinha". O condicional era prudência a mais: sem ele o navegador **não chega a
ser consultado**. Com o `src` inalterado, o React não toca o elemento e nenhuma
requisição é emitida, de modo que `Cache-Control: private, no-store` nunca entra
na conversa — ele governa o que se faz com uma resposta, e aqui não há resposta.

Provado por reversão na `CTO-1.8` (sabotagem `W`): removido o `?v=`, a
substituição de uma foto 48×24 por outra 30×60 deixa o preview em **48×24**.

### `CTO-1.8` — a foto que respondia 200 e não abria

O operador encontrou, na CTO de QA, uma foto cadastrada cuja rota respondia
`200` com `Content-Type: image/jpeg` e cujo `<img>` ficava quebrado: quadro
vazio, `alt` dentro, preview do DevTools sem renderizar.

**A rota estava certa, e isso foi medido antes de qualquer correção.** O corpo
HTTP é byte a byte o arquivo do storage — mesmo SHA-256, mesmo tamanho —, o
`Content-Type` acompanha o formato real, e um teste de navegador com imagem de
verdade mede `naturalWidth`/`naturalHeight` corretos, na primeira foto, na
substituição e depois do F5. **`Content-Disposition: attachment` não impede um
subrecurso de renderizar**: a afirmação da `CTO-1.7` era verdadeira, e agora tem
prova própria em vez de precedente.

#### O defeito era o dado, e o dado fui eu que pus lá

O blob corrente tinha **141 bytes**:

```text
SOI → APP0(16) → APP1/Exif(34) → DQT(67) → SOS → 12 34 56 78 → EOI
```

Assinatura correta, contêiner que fecha, segmentos plausíveis — e **nenhum
`SOF`, nenhuma tabela de Huffman**, com quatro bytes de scan inventados. Não há
quadro para decodificar. É a saída sanitizada de `montarJpeg`, o fixture de
sondagem de EXIF, que **eu enviei à CTO de QA durante a verificação da
`CTO-1.7`** para provar que o GPS saía na substituição — e deixei como foto
corrente ao declarar o ambiente pronto para validação.

O relatório da `CTO-1.7` chegou a citar a mudança de hash
(`95b35a75… → ef85cbe8…`) **como prova de que a substituição funcionava**. A
substituição funcionava mesmo; o que ninguém verificou é que o destino era um
arquivo que nunca foi imagem.

Os três blobs órfãos da mesma CTO — os uploads reais do operador — são PNGs
íntegros (527×879, 951×410, 975×900, CRC de todos os chunks conferindo, zero
bytes de sobra). **A pipeline não corrompeu nada**, e a foto do operador foi
restaurada pelo caminho de domínio, com auditoria.

#### Por que 129 testes verdes não viam isso

O `montarJpeg` diz, no próprio docstring, que **não precisa ser
decodificável** — *"nada no AlfaOS decodifica imagem"*. Era verdade: a pipeline
valida assinatura, tipo e estrutura de contêiner, e nunca abre a imagem.

A `CTO-1.7` acrescentou o primeiro consumidor que **abre**. A partir dela,
"os bytes chegaram" e "a imagem apareceu" deixaram de ser a mesma afirmação, e
todo teste existente respondia só a primeira: presença (`toBeVisible`), atributo
(`alt`), identidade de bytes. **Um `<img>` de origem quebrada satisfaz os
três** — continua visível, continua tendo `alt`, continua devolvendo bytes
estáveis.

A asserção que separa os dois casos é a **dimensão natural**, que só existe
depois da decodificação. Ela agora existe, com imagem pintada pelo próprio
navegador (`canvas.toDataURL`) para que a dimensão esperada seja um número que o
teste possa exigir, e não "algum número".

#### O que mudou no produto

Uma coisa só, e é a §14 do enunciado: **foto que não abre passou a dizer que não
abriu**. Antes, o retângulo vazio com `alt` dentro era indistinguível de um bug
de layout ou de uma tela ainda carregando — foi assim que o operador o
encontrou, sem ter como interpretá-lo. Agora o `onError` do `<img>` produz um
aviso nomeado, com a ação de substituir logo ao lado, e o elemento **permanece
montado** para que um carregamento posterior possa desmentir o diagnóstico sem
exigir F5.

Não é máscara: o aviso aparece porque o arquivo realmente não abriu, e some
porque outra imagem realmente abriu.

#### Decisão sobre `Content-Disposition`

**Mantido `attachment`.** O enunciado autorizava avaliar `inline` como
semanticamente mais apropriado, e a evidência tirou a base do argumento: o
preview decodifica com `attachment`, então trocar não corrige nada e enfraquece
a metade da defesa que começa recusando SVG e HTML no upload (`SECURITY.md`
§8.19). Corrigir o corpo primeiro, como o enunciado pedia, mostrou que não havia
corpo a corrigir.

#### `Content-Type` não é presumido

Ele vem da extensão da chave, que vem do tipo **sniffado** no upload — PNG entra
e `image/png` sai. Um `image/jpeg` fixo passaria despercebido em qualquer teste
que só enviasse JPEG, e o AlfaOS aceita três formatos; a sabotagem `V` fixa o
header e cai em exatamente um teste.

#### Testes

Dez no nível de rota (`src/tests/cto-photo-bytes.test.ts`), sobre o corpo HTTP:
não-vazio, magic byte concordando com o header, hash igual ao do storage,
binário que não passa por string (provado pelo byte **alto**, não pelo tamanho:
uma conversão UTF-8 o trocaria por `EF BF BD`), estrutura completa com dimensões
reais, substituição, preservação na falha, tenant cruzado com controle positivo,
chave e caminho fora dos cabeçalhos, e GPS ausente com `Orientation` preservada.

Dois de navegador (`e2e/ctos.spec.ts`): decodificação real com dimensões
conhecidas, e o estado de falha exercitado com o **mesmo tipo de arquivo** que o
operador encontrou.

#### Reversões

| | sabotagem | o que cai |
|---|---|---|
| `U` | corpo vazio com `200 image/jpeg` | 9 de 10 testes de bytes, `BYTES-01` à frente |
| `V` | `Content-Type` fixo em `image/jpeg` | só `BYTES-02` — o sinal é estreito de propósito |
| `W` | preview sem o cache-buster | o E2E de decodificação: 48×24 sobrevive à troca por 30×60 |

#### Limite declarado

O blob substituído continua **órfão**, como no §20 — a `CTO-1.8` acrescentou
mais um a essa lista ao restaurar a foto do operador. Não há política de
remoção, e apagar por suposição é como se perde evidência.

## 22. Checkpoint final da `CTO-1` — auditoria de consolidação

Revisão de fechamento antes da decisão de publicação, sobre `7011180`
(`3c1805e..7011180`, 16 commits). **Não é clean-room**: quem a conduziu
implementou a fase, e a compensação foi escrever e executar ataques novos, não
reler o que já passava. A limitação fica declarada, como a skill de auditoria
exige.

### `CTO1-INFO-01` — estado administrativo em porta fora da capacidade

**Reproduzido, não deduzido.** Numa CTO reduzida de 16 para 8, a porta 12 —
histórica, exibida na tela com o selo **"Fora da capacidade"** — aceita
`RESERVED`. `setPortAdministrativeState` valida CTO, tenant e existência da
porta, e **não** consulta `isPortOfferable`. A tela mantém `Liberar`,
`Reservar` e `Danificar` habilitados nessas linhas.

A consequência prática é uma segunda: a redução seguinte (8 → 4) passa a ser
**recusada** por causa da porta 12, que já estava fora da capacidade antes e
depois. O guarda de redução pergunta "existe porta acima do novo limite em
`RESERVED` ou `DAMAGED`?", e a porta 12 satisfaz literalmente.

| | |
|---|---|
| severidade | `INFO` |
| tenancy | intacta — ADMIN da empresa dona, no próprio recurso |
| integridade | intacta — valor legítimo do enum, em linha legítima |
| direção do erro | **conservadora**: recusa a redução, nunca apaga histórico |

**Por que não foi corrigido aqui.** Não é defeito de implementação contra o
contrato congelado, é uma pergunta de produto que o contrato não respondeu:
*uma porta danificada continua danificada quando deixa de ser ofertada?* As duas
respostas são defensáveis — a etiqueta física da caixa não some porque a
capacidade cadastrada mudou —, e escolher uma em silêncio dentro de um
checkpoint seria decidir produto por omissão. Fica registrado para o operador
decidir.

**O que a `CTO-2` NÃO pode herdar disto.** O `R-13` do §17 exige que a faixa
`1..capacity` seja validada **na escrita do vínculo**. Este achado prova que
`administrativeState` não faz essa validação hoje, então a `CTO-2` não pode
assumir que "a porta já passou por checagem de faixa" só porque tem um estado
administrativo. `isPortOfferable` continua sendo a autoridade, e precisa ser
chamada dentro da transação que grava o vínculo.

### Ataques executados neste checkpoint

| | ataque | resultado |
|---|---|---|
| `A1` | `companyId` no corpo do `PATCH` | `400` pelo `.strict()`; empresa e nome intactos |
| `A2` | porta de outra CTO da **mesma** empresa pelo id | `404`, estado inalterado |
| `A3` | porta de **outro tenant** | `404`, estado inalterado |
| `A4` | `TECHNICIAN` nas seis rotas | `403` nas seis, com controle positivo de ADMIN |
| `A5` | travessia de caminho no `[id]` da foto | `404` sem vazar caminho, `ENOENT` ou barra invertida |
| `A6` | três criações concorrentes do mesmo nome | exatamente **uma** vence, com as 4 portas |
| `A7` | SVG com `<script>` declarado `image/png` | `400`, `photoStorageKey` continua nulo |
| `A8` | estado em porta fora da capacidade | **passou** → `CTO1-INFO-01` |

O `A2` chegou ao mesmo desfecho que um teste permanente já cobria — a
concordância independente é o resultado desejado, não redundância.

## 23. `CTO-1.9` — porta fora da capacidade é histórica e read-only

**Decisão do dono, fechando o `CTO1-INFO-01` do §22.** A pergunta que o contrato
congelado não respondia — *uma porta danificada continua danificada quando deixa
de ser ofertada?* — foi respondida: **não se edita histórico.**

### A regra

> Uma `CTOPort` com `number > CTO.capacity` é histórica, não ofertável e
> **read-only**. Enquanto estiver fora da capacidade não aceita mutação
> administrativa nenhuma — nem reservar, nem danificar, **nem liberar**. Voltando
> a capacidade a cobri-la, a mesma linha volta a ser operável, com o estado que
> tinha.

A linha **nunca** é apagada, resetada, recriada ou duplicada (`N-13`).

### São dois predicados, e trocá-los quebra a tela

```ts
isPortWithinCapacity(port, capacity)  // só a faixa: number <= capacity
isPortOfferable(port, capacity)       // faixa E administrativeState === AVAILABLE
```

A autorização da mutação administrativa usa **o primeiro**. Usar o segundo
pareceria mais rigoroso e congelaria toda porta reservada ou danificada no
estado em que está: `RESERVED` dentro da capacidade não é ofertável, e liberar
uma reserva é exatamente o que a operação precisa poder fazer. A tela perderia a
capacidade de desfazer o que ela mesma fez.

A faixa tem **uma** definição — `isPortWithinCapacity` — e `isPortOfferable` a
consome. Três testes (`CTO1-HIST-06/07/08`) existem para derrubar a troca.

### A capacidade vem do lock, não de antes dele

`setPortAdministrativeState` já travava a CTO com `FOR UPDATE`; `lockCto`
devolve `{ id, capacity }`, e é **esse** valor que a comparação usa. Nenhuma
arquitetura nova — é o mesmo par que a redução de capacidade sempre usou.

A janela que isso fecha é real: reduzir 16 → 8 e reservar a porta 12 ao mesmo
tempo, as duas lendo 16, produziria a porta histórica reservada. `CTO1-HIST-12`
roda a corrida seis vezes e **proíbe** o desfecho híbrido em vez de tolerá-lo;
qualquer ordem de chegada é aceitável, e o par final tem de ser coerente
(`8` + `AVAILABLE`, ou `16` + `RESERVED` com a redução recusada).

### A ordem das verificações

```text
tenant → CTO → porta pertencente à CTO → capacidade travada → mutação
```

Outro tenant e porta de outra CTO continuam respondendo **404**, e não 409: a
mensagem de faixa nomeia a posição e a capacidade, e confirmaria a existência
dos recursos para quem não deveria saber que existem. Um teste fixa isso.

### Recusa

`conflict` → **409**, o mesmo mapeamento da recusa de redução. A mensagem nomeia
a posição e a capacidade atual, que é o que resolve o problema, e nada mais —
sem id, sem tenant, sem SQL, sem caminho. Um teste afirma cada ausência.

O `no-op` foi movido para **depois** da regra de faixa. Uma porta histórica cujo
estado pedido é o que ela já tem sairia com `200`, e a tela concluiria que a
ação está disponível: read-only precisa não depender do estado guardado.

### Tela

A linha histórica continua visível, com o selo **"Fora da capacidade"**. As três
ações ficam `disabled`, e o motivo não fica só na opacidade nem só no `title`
(que leitor de tela não anuncia de forma confiável em botão desabilitado): o
`aria-label` carrega a explicação inteira. O E2E afirma `toBeDisabled`, que lê a
propriedade do elemento — não a classe.

### Efeito sobre um teste existente

`"o estado administrativo de uma linha reutilizada NÃO é resetado"` marcava a
porta 12 como danificada **estando fora da capacidade** — caminho que deixou de
existir. A afirmação continua válida e o preparo mudou: agora a porta marcada
está dentro da capacidade que sobrevive à redução, e o teste prova que o passo
de criação do reaumento não reescreve linha existente, mais a identidade da
linha histórica (`id` e `createdAt`) e que ela atravessa liberada.

### Fronteira com a `CTO-2`

**Este endurecimento não substitui o `R-13`.** `CustomerNetworkConnection` só
poderá usar porta **ofertável** — dentro da capacidade **e** `AVAILABLE` —,
verificada com `isPortOfferable` **dentro da transação que grava o vínculo**.
Estar dentro da capacidade é condição necessária e não suficiente.

### Estado do achado

| | |
|---|---|
| `CTO1-INFO-01` | **CLOSED — OWNER DECISION** |
| blobs órfãos de fotos substituídas | **INFO aceito**, sem cleanup |

### `CTO1-INFO-02` — dado legado com porta histórica não liberada

Levantado no checkpoint de release, verificado, **não bloqueante**.

Antes da `CTO-1.9`, reservar ou danificar uma porta já fora da capacidade era
permitido. Uma linha assim, sobrevivente, bloquearia a redução de capacidade
(o guarda a vê acima do novo limite e não liberada) **e** não poderia mais ser
liberada (é histórica, e histórica é read-only).

**A saída existe e é operação normal**, medida e não suposta:

```text
reduzir     409   (bloqueado pela porta histórica reservada)
liberar     409   (read-only)
reexpandir  200   ← a porta volta à capacidade
liberar     200   ← e aí sim
```

Aumentar a capacidade até cobrir a posição, liberar, reduzir. Dois passos, os
dois pela tela, nenhum caminho especial.

**Nenhum caminho de código produz o estado a partir de agora:** a redução só é
aceita com as posições de cima liberadas, e depois disso nada as toca. O vetor é
exclusivamente dado anterior à `CTO-1.9` — e a varredura da base alcançável
devolveu **zero** portas históricas, quaisquer que fossem seus estados.

Nenhum código foi alterado por causa disto. Documentar a saída é o que o achado
pede; uma exceção no guarda de redução criaria um segundo caminho para editar
histórico, que é exatamente o que a `CTO-1.9` fechou.

## 24. `CTO-2` DOMAIN FREEZE

Congelamento oficial do domínio `Customer ↔ CTOPort`, após a reconciliação da
`CTO-2.0` e as decisões do dono na `CTO-2.0.1`. **Nada disto existe em código.**

A `CTO-1` está **congelada** e é premissa, não objeto: `CTO`, `CTOPort`,
`Company.ctoNetworkEnabled`, os três estados administrativos, porta fora da
capacidade read-only, faixa `1..256`, `code` imutável, inativação sem delete e
uma foto atual continuam exatamente como a `v0.14` publicou.

### 24.1 Decisões do dono

| | |
|---|---|
| `CTO2-Q1` | **RESOLVIDA — Opção B** |
| `source` | **`FIELD · WEB`**, `IMPORT` fora |

### 24.2 `source` — `FIELD · WEB`, e o que isso supera

O trecho da §17 que dizia *"a `CTO-2` implementa `FIELD`, e só"* está
**SUPERADO**: a operação administrativa Web faz parte da `CTO-2`. `IMPORT` não
entra, e nenhum `ERP`, `SYNC` ou `SYSTEM` é criado — o princípio que originou a
regra antiga (endpoint só com caso de uso) é justamente o que os elimina.

```text
FIELD   mutação do aplicativo, SEMPRE por uma ServiceOrder IN_PROGRESS elegível
WEB     mutação administrativa do ADMIN no painel
```

Nome proposto: `CustomerNetworkConnectionSource`, seguindo `CustomerLocationSource`
e `ConnectionUsernameSource`. **O servidor deriva `source`**; o cliente nunca o
envia como autoridade — é o mesmo tratamento que `companyId`, `technicianId`,
`serviceOrderId` e os carimbos de tempo já recebem em `C-08`.

### 24.3 Vínculo ativo × estado administrativo — Opção B

A regra é sobre o **ALVO**, nunca sobre o estado atual:

```text
existe vínculo ativo na porta ?
  alvo = RESERVED    → RECUSAR   (409)
  alvo = AVAILABLE   → permitido
  alvo = DAMAGED     → permitido
```

`RESERVED` significa *posição separada para uso futuro*, e isso não convive com
alguém dentro. `DAMAGED` com cliente vinculado é situação real de campo: a
posição quebrou e a operação precisa registrar isso enquanto planeja a migração.

| transição com vínculo ativo | |
|---|---|
| `AVAILABLE → DAMAGED` | permitido |
| `DAMAGED → AVAILABLE` | permitido |
| `AVAILABLE → RESERVED` | `409` |
| `DAMAGED → RESERVED` | `409` |

#### O beco sem saída que NÃO pode ser criado

A regra simplista *"porta ocupada não muda de estado"* seria **errada** e está
proibida: uma porta `active + DAMAGED` **precisa** poder voltar a `AVAILABLE`
quando o defeito for corrigido, sem desconectar ninguém.

E se algum dia aparecer uma linha legada `active + RESERVED`, a aplicação
**permite SAIR** dela para `AVAILABLE` ou `DAMAGED`. O que ela proíbe é
**entrar** — ou permanecer por mutação nova — em `RESERVED` havendo vínculo
ativo. Predicado só sobre o alvo, jamais sobre a origem.

#### Onde a verificação mora

Dentro da transação de `setPortAdministrativeState`, **depois** do `lockCto` que
já existe, junto da regra de faixa da `CTO-1.9`. Consultar vínculo ativo fora do
lock reabriria a mesma janela que a `CTO-1.9` fechou: conectar e reservar em
paralelo, as duas lendo "sem vínculo".

### 24.4 O contador de danificadas MENTE — e isso é da `CTO-2.2`

Consequência direta da Opção B, levantada no código e não deduzida:

```ts
// src/lib/cto.ts — hoje
if (hasActiveConnection) return "OCCUPIED";       // effectivePortState
damaged: inRange.filter((p) => p.effectiveState === "DAMAGED").length
```

`effectiveState` colapsa em `OCCUPIED` sempre que há vínculo, então uma porta
`DAMAGED + ocupada` **desaparece da contagem de danificadas** e é contada como
ocupada. O resumo da CTO diria `damaged: 0` com uma posição fisicamente quebrada
e um cliente nela — exatamente o estado que a Opção B tornou legítimo e
operacionalmente útil.

**A precedência publicada (§3) não muda**: `OCCUPIED` continua vencendo como
RÓTULO, e continua sendo derivado. O que passa a ser obrigatório é o DTO
carregar as **duas dimensões separadas**, e o resumo contar por
`administrativeState`, não por `effectiveState`:

```text
damaged  = portas na faixa com administrativeState = DAMAGED   (ocupadas ou não)
reserved = portas na faixa com administrativeState = RESERVED
occupied = portas na faixa com vínculo ativo
free     = na faixa, AVAILABLE e sem vínculo ativo
```

As categorias deixam de somar `capacity`, e é correto que deixem: uma porta pode
ser danificada **e** ocupada. Uma tela que apresente as quatro como fatias de um
todo estará errada a partir daqui.

### 24.5 Read model congelado

```text
withinCapacity        number <= capacity
administrativeState   AVAILABLE · RESERVED · DAMAGED
occupied              existe vínculo ativo
activeConnection?     quando ocupada
customer?             quando ocupada E o perfil pode ver
effectiveState        rótulo de conveniência — LOSSY, ver §24.4
```

`effectiveState` **nunca** é persistido, e nenhuma tela pode depender só dele
para decidir se a porta está danificada.

| combinação | leitura |
|---|---|
| `AVAILABLE` + ocupada | cliente conectado normalmente |
| `DAMAGED` + ocupada | cliente conectado em porta com defeito |
| `RESERVED` + ocupada | **inconsistência/legado** — inválida para escrita nova |

### 24.6 O modelo, congelado

```text
CustomerNetworkConnection
  id                cuid
  companyId         redundante de propósito — filtro de tenant em SQL
  customerId
  ctoPortId
  serviceOrderId?   PROCEDÊNCIA, nunca posse
  technicianId?     Technician, jamais User
  connectedAt
  disconnectedAt?   NULL enquanto ativo
  source            FIELD · WEB
  reason?           opcional, na desconexão
  createdAt
```

**Fora, e cada ausência tem motivo:**

| ausente | por quê |
|---|---|
| `equipmentId` | `C-05`. `ServiceOrderEquipment` é linha por OS, e `serial`/`macAddress` são opcionais desde a v0.10: não existe identidade estável de equipamento fora da OS |
| `updatedAt` | a linha é escrita duas vezes — nasce e fecha —, e `disconnectedAt` já carimba a segunda. Seria uma segunda memória do mesmo fato |
| `version` | ver §24.13 |
| `externalProvider` / `externalId` | ERP não é autoridade de porta (§24.19) |
| ONU · MAC · serial · router · OLT · PON · splitter · fibra | fronteira do FiberMap (§24.20) |

**Obrigatoriedade por `source`, e a distinção importa:** as colunas são
**anuláveis no schema** porque `WEB` não tem OS nem técnico; a obrigatoriedade é
**invariante de domínio**, verificada no serviço.

```text
FIELD   serviceOrderId OBRIGATÓRIO   technicianId OBRIGATÓRIO
WEB     serviceOrderId NULO          technicianId NULO
```

`WEB` **não inventa técnico**: o ator administrativo é auditável pelo `AuditLog`,
que já grava `userId`. Preencher `technicianId` com o `User` do ADMIN seria
afirmar que alguém foi ao poste.

### 24.7 Uniques parciais — a última barreira

```sql
CREATE UNIQUE INDEX "customer_network_connections_active_port_key"
  ON "customer_network_connections"("ctoPortId")
  WHERE "disconnectedAt" IS NULL;

CREATE UNIQUE INDEX "customer_network_connections_active_customer_key"
  ON "customer_network_connections"("customerId")
  WHERE "disconnectedAt" IS NULL;
```

**Precedente real do projeto**, não invenção: `checklist_templates_company_default_key`
já é um índice único parcial, criado por SQL cru no fim da migration
(`20260827180000`) com bloco de comentário, e documentado por `///` no
`schema.prisma` explicando que o DSL não o expressa. A `CTO-2` repete esse
padrão exato.

Validação em código de aplicação **não** substitui as duas: lock protege quem
passa pelo serviço, o índice protege contra todo o resto.

### 24.8 História

Desconectar **preenche `disconnectedAt`** e nunca apaga. Reconectar cria linha
nova. Mover fecha a antiga e abre a nova. **Jamais `UPDATE ctoPortId`** numa
linha histórica — isso faria o passado afirmar que o cliente sempre esteve na
porta nova.

### 24.9 Ocupação

Derivada, sempre: existe vínculo com `disconnectedAt IS NULL`. Sem `OCCUPIED` no
enum, sem `isOccupied`, sem contador autoritativo na CTO.

```text
occupiedPorts(cto) = COUNT(vínculos ativos nas portas da CTO)
```

### 24.10 CTO inativa

```text
CONNECT     recusado
MOVE-IN     recusado
DISCONNECT  permitido
MOVE-OUT    permitido
```

Sem conflito com a `CTO-1`, cuja §11 diz *"não aceita vínculo novo; os
existentes ficam"* — "ficam" é não-remoção automática, não imutabilidade. O
inverso aprisionaria a operação numa caixa desativada.

### 24.11 `CONNECT` · `DISCONNECT` · `MOVE`

**`CONNECT`** — precondições, todas na transação: sessão · tenant · capability ·
perfil ou autorização Field · `Customer` da empresa · `CTO` da empresa · `CTOPort`
pertencente à CTO · CTO ativa · `isPortOfferable(porta, capacity)` · porta sem
vínculo ativo · cliente sem vínculo ativo. Cria a linha com `disconnectedAt = NULL`.

`isPortOfferable` exige `AVAILABLE`, então **não existe** conexão nascendo em
`RESERVED` ou `DAMAGED`: `active + DAMAGED` só surge de uma mudança
administrativa **depois** de o vínculo existir.

**`DISCONNECT`** — localiza o vínculo ativo dentro do tenant, trava, reconfirma
que ainda está ativo e preenche `disconnectedAt`. Nunca `delete`. Repetição sem
`Idempotency-Key` responde `409` explícito ("já desconectada"), não `200` mudo —
um `200` faria o cliente acreditar que desconectou agora.

**`MOVE`** — **não é `UPDATE ctoPortId`**. É, numa transação: fechar o vínculo
antigo **e** criar o novo. Falhou qualquer etapa, nada muda. Depois: linha antiga
com `disconnectedAt != NULL`, linha nova com `NULL`. Entre CTOs diferentes da
mesma empresa funciona; a CTO **destino** precisa estar ativa e a porta destino
ofertável; a CTO **origem** pode estar inativa, que é o `MOVE-OUT` da §24.10.

### 24.12 Ordem de lock

```text
1. Customer
2. CTOs envolvidas, ordenadas por id ASC
```

**Sem lock de `CTOPort`.** A `CTO-1` decidiu deliberadamente travar a **CTO** e
não a linha da porta; um segundo nível teria de coexistir com o lock da
capacidade, que é o que se quer evitar.

**Ids resolvidos ANTES de qualquer `FOR UPDATE`** — lição literal da `DQ-2`:
ordenar depois de travar é o mesmo que não ordenar.

**Prova de ausência de ciclo:** as classes formam ordem total
`Customer(1) → CTO(2, por id)`, e toda operação toma um prefixo consistente.
`changeCtoCapacity` e `setPortAdministrativeState` tomam **apenas** o lock de
CTO — nunca o de Customer —, então não podem ser a segunda metade de um ciclo.
`CONNECT` e `DISCONNECT` tocam uma CTO; `MOVE` toca uma ou duas, sempre em ordem
crescente de id.

### 24.13 Concorrência, e por que não há `version`

| | cenário | quem garante |
|---|---|---|
| `C1` | dois clientes, mesma porta | unique parcial de `ctoPortId` + lock de CTO |
| `C2` | mesmo cliente, duas portas | unique parcial de `customerId` |
| `C3` | dois `MOVE` do mesmo cliente | lock de Customer, primeiro na ordem |
| `C4` | redução × `CONNECT` | lock de CTO compartilhado; faixa lida depois do lock |
| `C5` | mudança de estado × `CONNECT` | mesmo lock; `isPortOfferable` dentro da transação |
| `C6` | `DISCONNECT` × `MOVE` | lock de Customer; o perdedor vê o vínculo já fechado |

**Sem `version`/CAS.** `ServiceOrder.version` existe porque o Field faz muitas
escritas-filhas numa sessão e precisa de um token entre leitura e escrita. A
conexão não tem sessão multi-escrita: cada operação lê e escreve dentro da mesma
transação travada, e a duplicidade é proibida pelo banco. Acrescentar `version`
por hábito criaria um segundo compare-and-set sem pergunta a responder — e a
`DQ-3` já mostrou o custo de dois CAS quando são dois agregados de verdade.

**As corridas se provam por execução repetida**, com asserção que **proíbe** o
desfecho ruim. Vencedor sempre igual = não houve corrida.

### 24.14 Capacidade e estado

Redução recusa quando qualquer porta acima do novo limite estiver `RESERVED`,
`DAMAGED` **ou com vínculo ativo** — a terceira condição é o que a `CTO-2`
acrescenta ao `C-10`. **Nenhuma desconexão automática, nenhum move automático,
nenhum vínculo apagado.** A mensagem diz que há cliente conectado acima do novo
limite.

### 24.15 Tenancy · Permissões · Autorização Field

`companyId` **sempre** da sessão. Todas as relações conferidas no mesmo tenant:
conexão, `Customer`, `CTO` e `CTOPort → CTO`. Porta **nunca** resolvida só por
`portId`: `empresa → CTO → CTOPort pertencente à CTO`, como a `CTO-1` congelou.

**Sem FK composta de tenant.** O projeto não usa esse padrão — `ServiceOrder.technicianId`
é FK simples sem `(companyId, technicianId)`, vetor que a `DQ-7.1` explorou. O
padrão é `companyId` redundante mais predicado SQL no serviço, e inventar aqui
uma exceção criaria um segundo modelo de tenancy.

| perfil | READ | CONNECT | DISCONNECT | MOVE |
|---|---|---|---|---|
| `ADMIN` | sim | sim | sim | sim |
| `DISPATCHER` | não | não | não | não |
| `TECHNICIAN` | pelo Field, na OS elegível | sim | sim | sim |

`DISPATCHER` segue o `C-07` (*"não altera CTO"*) e **não** ganha leitura por
inferência: o `C-07` abre leitura *"por fase que precise dela"*, e a `CTO-2`
precisa da leitura do ADMIN e da do técnico. **`GESTOR` não existe** — os perfis
reais são `ADMIN · DISPATCHER · TECHNICIAN`.

**Field (`C-08`, inalterado):** técnico válido e ativo · mesma empresa pela
sessão · OS da mesma empresa · OS `IN_PROGRESS` · OS sob autoridade daquele
técnico por `loadInProgressOwnedOrder` · **o `Customer` do vínculo é exatamente
o `Customer` da OS**. A última linha impede o vetor mais barato: OS legítima do
próprio técnico usada para conectar outro cliente.

**Não se escreve um segundo predicado de posse.** `loadInProgressOwnedOrder` é o
mesmo portão de evidência, material, equipamento, assinatura e checklist.

Derivados pelo servidor, ignorados no payload: `companyId` · `technicianId` ·
`serviceOrderId` · `source` · `connectedAt` · `disconnectedAt`.

### 24.16 `AuditLog` e `ServiceOrderEvent`

Auditoria em **toda** mutação, no formato `ENTIDADE.ACAO` já usado:

```text
CTO_CONNECTION.CONNECTED · DISCONNECTED · MOVED
```

Registrar cliente, CTO/porta, ação, ator, `source` e a OS quando houver. Sem
segredo.

**`ServiceOrderEvent` só quando a origem é `FIELD`.** O padrão do projeto
discrimina, e não por acaso: eventos são fatos da *narrativa da visita*
(`CHECKED_IN`, `MATERIAL_USED`, `EQUIPMENT_INSTALLED`, `SIGNATURE_CAPTURED`),
enquanto edição incremental fica só na auditoria (`EVIDENCE_ADDED`,
`CHECKLIST_ANSWERED`, `EXECUTION_UPDATED`). Conectar um cliente durante um
atendimento é da primeira classe. `WEB` não tem OS: só `AuditLog`, e criar uma
timeline sem visita seria inventar uma.

### 24.17 Idempotência

Reutilizar `withIdempotency` (`src/lib/field/idempotency.ts`), que **já serve
rotas Web** — `dispatch/.../reorder`, `service-orders/[id]/priority`,
`time-clock/.../adjustments`. Nenhum mecanismo paralelo.

Operações: `cto.connect` · `cto.disconnect` · `cto.move`. Escopo
`(empresa, usuário, operação, chave)`. **Só o sucesso é memorizado** — replay
devolve a resposta gravada; falha não fica lembrada e pode ser tentada de novo.

### 24.18 Migration — desenho, não arquivo

Nova, **aditiva**, sem tocar nenhuma publicada e sem `migrate dev` nesta fase:
enum `CustomerNetworkConnectionSource` · tabela `customer_network_connections` ·
FKs · índices normais (`(companyId, customerId)`, `(companyId, ctoPortId)`) ·
os **dois índices únicos parciais** em SQL cru · **zero backfill**.

**`onDelete`:**

| relação | política | por quê |
|---|---|---|
| `Company` | `Cascade` | padrão do schema |
| `Customer` | **`Restrict`** | histórico não some porque o cliente foi removido |
| `CTOPort` | **`Restrict`** | idem; `CTO → CTOPort` já é `Restrict` |
| `Technician` | **`Restrict`** | desativar é a operação suportada, e desativar não apaga |
| `ServiceOrder` | **`SetNull`** | procedência, não posse: perder a OS não pode apagar o vínculo |

Nenhum `delete` físico de `ServiceOrder`, `Customer` ou `Technician` existe em
produção hoje — as políticas acima são cinto e suspensório.

**Backfill: zero.** A tabela é nova, e nada existente representa vínculo de
porta. `CustomerConnection` é **PPPoE** (`type`, `username`, credencial cifrada)
e **não** será convertido; `EvidenceCategory.CTO` é categoria de **foto**. Não
inferir vínculo por endereço, texto ou PPPoE.

### 24.19 Fronteira com o ERP

ReceitaNet e SGP **não** controlam `CustomerNetworkConnection`. O ERP fornece
dado de `Customer`; conectar, desconectar e mover é operação do AlfaOS. Sem
`externalProvider`/`externalId` na conexão.

### 24.20 Fronteira com o FiberMap

AlfaOS: autoridade **operacional** `Customer ↔ CTOPort`. FiberMap: topologia
**física** — fibra, splitter, OLT, PON, trajeto óptico. A `CTO-2` **não** cria
`OLT`, `PON`, `splitter`, `fiber`, `route`, `fiber trace` nem motor de topologia.

### 24.21 Sem mutação offline

`CONNECT`, `DISCONNECT` e `MOVE` **não** entram em fila offline. Não existe
"reservei a porta offline e sincronizo depois": duas pessoas fariam isso na
mesma porta e a reconciliação teria de escolher um perdedor **depois** de os dois
terem ido ao poste. Sem rede, a ação fica **indisponível com mensagem clara** —
o Field pode, no futuro, exibir topologia conhecida em cache, mas mutação exige
servidor.

### 24.22 Threat model

`T1`–`T4` IDOR e tenant → resolução `sessão → Customer → CTO → CTOPort ∈ CTO`,
`404`. `T5` mass assignment → zod `.strict()`. `T6`–`T9` spoofing de
`technicianId`, `serviceOrderId`, `source` e carimbos → todos derivados no
servidor. `T10`/`T11` dupla ocupação → uniques parciais mais locks, com corrida
real repetida. `T12` move parcial → transação única. `T13` replay offline →
mutação é online-only. `T14` colisão de chave → escopo mais fingerprint.
`T15`/`T16` corridas de capacidade e estado → lock de CTO compartilhado. `T17`
CTO inativa → verificada na transação. `T18` mutação de histórico → sem `UPDATE`
de porta, sem delete, `Restrict` em toda FK.

| novo | ataque | controle |
|---|---|---|
| `T19` | `active link → RESERVED` por fora | `setPortAdministrativeState` consulta vínculo ativo **dentro** da mesma transação e do mesmo `lockCto` |
| `T20` | `active + DAMAGED` presa sem volta | a regra proíbe **o alvo `RESERVED`**, nunca toda mutação — voltar a `AVAILABLE` continua permitido |

### 24.23 Fatias

```text
CTO-2.1  schema + migration + serviço de domínio
CTO-2.2  API Admin + read models
CTO-2.3  Web: conectar / desconectar / mover
CTO-2.4  API Field via OS IN_PROGRESS
CTO-2.5  UI Field
CTO-2.6  integração capacidade/estado + endurecimento de concorrência
CTO-2.7  validação do dono + checkpoint de release
```

A `CTO-2.1` traz as duas uniques parciais: a barreira de banco entra na primeira
fatia, não na última.

> **`CTO-2` DOMAIN FREEZE — APROVADO.** Nenhuma decisão de produto pendente.
> Nada disto existe em código: a §119 do PRD vale linha por linha até a `CTO-2.1`.

## 25. `CTO-2.1` — persistência e domínio transacional

Implementa o §24. **Nenhuma rota, nenhuma tela, nenhum Field, nenhum Dart**: ao
final desta fase o domínio existe e não é alcançável por usuário nenhum.

### Migration

`20260907214839_add_customer_network_connections`, **aditiva**: um enum, uma
tabela, 4 índices normais, 5 FKs e os **2 índices únicos parciais** em SQL cru.
Revisão do SQL antes de aplicar: **zero `DROP`, zero `TRUNCATE`, zero `DELETE`,
zero `RENAME`**, e os 5 `ALTER TABLE` são todos sobre a tabela nova. **27
migrations**, nenhuma publicada editada, zero backfill.

### Índices — o que cada um faz, e o mais fraco declarado

| índice | por quê |
|---|---|
| `(companyId, customerId)` | o histórico do cliente, que é a leitura da `CTO-2.2` |
| `(companyId, ctoPortId)` | ocupação de todas as portas de uma CTO numa consulta — evita o `N+1` numa caixa de até 256 posições |
| `active_port_key` parcial | *a* barreira contra dois clientes na mesma porta |
| `active_customer_key` parcial | *a* barreira contra um cliente em duas portas |
| `serviceOrderId` | procedência, e o `SET NULL` da FK |
| `technicianId` | **o mais fraco**: hoje só serve à checagem da FK `Restrict`, e `Technician` não é apagado em produção. Fica declarado como candidato a remoção se a `CTO-2.2` não encontrar leitor |

### O que os testes descobriram sobre QUEM protege o quê

As sabotagens não confirmaram o desenho — corrigiram a leitura dele.

**A unique parcial de porta não é o que faz `C1` passar.** Derrubar
`active_port_key` e rodar a corrida "dois clientes, a mesma porta" continua
dando exatamente um vencedor: o pré-check dentro do `lockCto` já serializa quem
passa pelo serviço. Quem detecta a queda do índice é o **`CN-27`**, que insere
direto no banco. O índice é a barreira para o que **não** passa pelo serviço, e
é assim que ele deve ser descrito — não como a proteção da corrida.

**O lock de cliente é, hoje, principalmente o portão de TENANT.** Removê-lo não
derrubou `C2` nem `C3` (a unique parcial de `customerId` os carrega); derrubou o
**`CN-18`**, porque `lockCustomer` é também a única resolução tenant-safe do
cliente. A contribuição dele à concorrência é converter violação de índice em
erro de domínio limpo; a contribuição à segurança é impedir que um `customerId`
de outra empresa seja alcançado. As duas são reais, e são diferentes do que eu
teria afirmado sem medir.

**O `CN-30` passou com a sabotagem `AE` aplicada, e a culpa era dele.** Ele
rodava **uma** vez. Medido depois: sem `sort()` nas CTOs, **19 de 20** rodadas
produzem `40P01 deadlock detected` — a rodada única caiu justamente na exceção.
Passou a rodar seis vezes, e aí a sabotagem cai com a mensagem do Postgres.

### Reversões

| | sabotagem | quem cai |
|---|---|---|
| `AA` | derrubar `active_port_key` | `CN-27` (INSERT direto). **Não** `C1` — ver acima |
| `AB` | derrubar `active_customer_key` | `CN-27`, na linha exata do segundo vínculo do mesmo cliente |
| `AC` | `MOVE` vira `UPDATE ctoPortId` | `CN-14`: a linha antiga fica sem `disconnectedAt` |
| `AD` | remover o lock de cliente | `CN-18` — **tenancy**, não concorrência |
| `AE` | não ordenar as CTOs | `CN-30`, com `deadlock detected` |
| `AF` | ignorar `isPortOfferable` | `CN-08/09`: conexão nasce em `RESERVED`/`DAMAGED` |

Restauradas por `diff` byte a byte. `AA` e `AB` deixaram linhas duplicadas na
base de teste — limpas antes de reconferir, senão a falha seguinte não provaria
nada.

### Efeito no harness

`onDelete: Restrict` em `Customer`, `CTOPort` e `Technician` **quebrou a limpeza
da fixture**, e isso é a constraint funcionando: histórico operacional não some
porque alguém apagou o cliente. `resetDatabase` passou a apagar o vínculo — e,
por consequência, portas e CTOs — antes de técnico e cliente, por escopo e na
ordem que as FKs exigem.

### Limites declarados, não escondidos

**`C4` (conectar × reduzir capacidade)** prova apenas o que hoje é provável: o
lock da CTO serializa as duas, e não se cria vínculo olhando capacidade velha. A
regra "redução recusa porta com vínculo ativo acima do limite" **não existe
ainda** — é `CTO-2.6`, e sem endpoint exposto nada a alcança. A corrida está
escrita e proíbe o único desfecho realmente ruim.

**`C5` (conectar × mudar estado)** idem: a serialização existe, e
`RESERVED + ocupada` continua alcançável quando a reserva chega **depois**. É a
`CTO-2.6` que fecha isso em `setPortAdministrativeState`.

Os dois requisitos têm **marcadores de contrato** em
`src/tests/cto-connections-contract-markers.test.ts`, que afirmam o
comportamento de hoje e dizem, no lugar onde alguém vai olhar, o que precisa
mudar. Um requisito registrado só em documento se perde; um teste que já falha
vira ruído que se desabilita.

### A obrigação da `CTO-2.2`

O marcador do resumo mostra que a contagem de danificadas **acerta hoje pelo
motivo errado**: o read model da `CTO-1` não consulta vínculo, então
`hasActiveConnection` é sempre `false` e `effectiveState` nunca colapsa. No
instante em que a `CTO-2.2` ligar a ocupação real ao read model — que é o
trabalho dela —, `damaged` cai para `0` se a contagem continuar derivando de
`effectiveState`. A contagem tem de passar a vir de `administrativeState`.

### Gates

`diff --check` · `prisma validate` · `migrate status` (**27**) · lint · tsc ·
**1937 Vitest** (era 1897, 93 arquivos) · **132 Playwright** · build ·
build:worker.

## 26. `CTO-2.2` — API administrativa e read models

**Nenhuma migration, nenhuma tela, nenhum Field, nenhum Dart.** O modelo da
`CTO-2.1` continua autoritativo e não ganhou campo nenhum.

### Rotas

```text
POST /api/cto-connections                  conectar
GET  /api/cto-connections?customerId=      onde está e onde esteve
POST /api/cto-connections/:id/disconnect   encerrar ESTE vínculo
POST /api/cto-connections/:id/move         mover ESTE vínculo
```

Namespace próprio e não `customers/:id/connections` — aquele caminho já existe
e é a credencial **PPPoE**. Pendurar topologia ao lado do segredo de acesso
faria as duas parecerem a mesma capability.

Precedente reutilizado sem inventar convenção paralela: `POST` de ação com
`.strict()`, `assertSameOrigin`, `requireCtoAccess` (sessão → capability →
perfil), `parseIdempotencyKey` + `withIdempotency`, `runApi` e `jsonOk/jsonError`
— o mesmo desenho de `POST /api/service-orders/:id/priority`.

As rotas são **adaptadores finos**: autenticam, validam forma, montam a
procedência `WEB` e chamam o domínio. Nenhuma regra vive nelas.

### A guarda de obsolescência — a única regra que nasceu aqui

O `:id` no caminho **é** a identidade esperada do vínculo ativo. A operação não
é *"desconecte o que este cliente tiver agora"*, é *"encerre ESTE vínculo"*.

A diferença decide um desastre real: o operador vê o cliente na porta A, outra
pessoa o move para B, e o clique na tela velha chega. Sem a identidade, o
servidor encerraria B — um vínculo que ninguém viu.

Isso exigiu **endurecer o domínio da `CTO-2.1`**: `expectedConnectionId` passou
a ser **obrigatório** em `disconnect` e `move`. Opcional seria pior que ausente —
quem esquecesse de mandar reabriria o buraco sem nenhum sinal. A comparação
acontece **depois** do lock do cliente, então lê o estado autoritativo e não uma
fotografia. Tornar obrigatório fez o compilador apontar todos os chamadores, que
era o objetivo.

### As duas dimensões

`src/lib/cto-read-model.ts` existe separado porque `cto-connections.ts` já
importa `cto.ts`: se `cto.ts` passasse a importar o vínculo, o ciclo fecharia.
`getCto` — publicado na `v0.14` — não mudou.

```text
withinCapacity · administrativeState · occupied · availableForConnection
activeConnection? · effectiveState (rótulo, LOSSY)
```

`availableForConnection` é **advisory**: a transação revalida tudo com a caixa
travada, e um cliente que confiasse nele estaria autorizando com uma fotografia.

**O resumo passou a contar por `administrativeState`:**

```text
damaged   administrativeState = DAMAGED    (ocupada ou não)
reserved  administrativeState = RESERVED   (ocupada ou não)
occupied  existe vínculo ativo
free      AVAILABLE E sem vínculo ativo
```

`free + reserved + damaged + occupied` **pode passar de `capacity`**, e há teste
afirmando isso. Uma tela que apresente as quatro como fatias de um todo estará
errada — anotado para a `CTO-2.3`, único consumidor restante.

`RESERVED + ocupada` legado conta nas duas e não é corrigido automaticamente:
esconder inconsistência é pior que exibi-la.

### Dois defeitos que a implementação encontrou em mim

**`effectiveState` sobrevivia ao `spread`.** O read model montava a porta com
`...p`, e `p.effectiveState` vinha de `getCto`, calculado com
`hasActiveConnection = false`. A tela mostraria **"Livre" numa porta com cliente
dentro**, e nada acusaria. Passou a ser recalculado com a ocupação real.

**As rotas de mutação devolviam o DTO menor.** A tela substitui o estado inteiro
pela resposta, então `occupied` e `activeConnection` sumiriam depois de salvar —
e o defeito só apareceria quando a `CTO-2.3` os exibisse: um selo que desaparece
ao clicar em salvar. As cinco mutações da CTO passaram a responder pelo mesmo
read model da leitura.

### Sem `N+1`

Uma `findMany` por caixa, e não uma por porta — 256 posições seriam 257
requisições. A prova é **estrutural e afirmada sobre o fonte**: o corpo do `map`
de portas não pode conter `await prisma`, e o módulo faz exatamente duas
`findMany`. A sabotagem que move a consulta para dentro do laço derruba o teste.

### Reversões

| | sabotagem | quem cai |
|---|---|---|
| `AG` | `damaged` volta a contar por `effectiveState` | o teste de `DAMAGED + ocupada`, com `expected +0 to be 1` |
| `AH` | remover a guarda de obsolescência | 4 testes, incluindo os dois cenários de tela velha |
| `AI` | tirar o `.strict()` | os dois testes de mass assignment |
| `AJ` | `MOVE` sem `withIdempotency` | o replay vira `409` em vez de `200` |
| `AK` | resolver vínculo sem `companyId` | **passou** na primeira rodada — ver abaixo |
| `AL` | consulta de ocupação dentro do laço | o teste estrutural de `N+1` |

**`AK` passou porque faltava uma asserção, não porque o código estivesse certo.**
Sem o tenant no resolvedor, o domínio ainda barra pelo `lockCustomer` — mas as
mensagens **divergem**: id inexistente responde *"Vínculo não encontrado"*, id de
outra empresa responde *"Cliente não encontrado"*. Dois `404` com corpos
diferentes formam um **oráculo de enumeração**: basta comparar o texto para
descobrir quais ids existem. Eu só afirmava o status. O ataque `A1` passou a
comparar o **corpo** com o de um id inventado, e aí a sabotagem cai mostrando as
duas frases lado a lado.

Restauração conferida por `diff` byte a byte nos cinco arquivos.

### Limites mantidos

`setPortAdministrativeState` **não** ganhou a regra de `RESERVED` com vínculo
ativo, e `changeCtoCapacity` **não** ganhou a de vínculo acima do limite: as
duas são `CTO-2.6`, e antecipá-las violaria a fatia congelada. Os marcadores de
contrato continuam de pé.

### Gates

`diff --check` · `prisma validate` · `migrate status` (**27, nenhuma nova**) ·
lint · tsc · **1976 Vitest** (era 1937, 95 arquivos) · **132 Playwright** ·
build · build:worker.

## 27. `CTO-2.3` — a operação do vínculo pela tela

**Nenhuma migration, nenhuma rota nova, nenhum Field, nenhum Dart.** A `CTO-2.1`
e a `CTO-2.2` continuam autoritativas; esta fase consome o que elas expõem.

### O que foi reutilizado, e o que precisou nascer

`GET /api/customers?search=` **já existia** — server-side, paginado, tenant-safe
e aberto a ADMIN. Nenhum endpoint de busca foi criado. A chave de idempotência
segue o padrão do ajuste de jornada: um `ref` que só troca quando a **assinatura
semântica** da ação muda, de modo que retry reenvia a mesma chave.

O que faltava era um **diálogo modal** — o projeto não tinha nenhum. Ele nasceu
mínimo, sem dependência nova: `role="dialog"`, `aria-modal`, rótulo, foco levado
para dentro ao abrir, `Esc` fecha e o foco volta a quem abriu.

### As duas dimensões, na linha da porta

O selo principal continua sendo `effectiveState`, que colapsa em **Ocupada**. Ao
lado dele aparece o selo administrativo **quando as duas coisas são verdade ao
mesmo tempo**:

```text
Ocupada + Danificada   → os dois selos, cliente visível, sem "Vincular"
Ocupada + Reservada    → idem (legado), sem "Vincular"
```

Colapsar é aceitável para o rótulo; **apagar não é**. Uma porta danificada com
cliente dentro precisa continuar dizendo que está danificada — é justamente a
informação que fez alguém marcá-la.

O resumo diz, em texto, que **as categorias se sobrepõem e a soma pode passar da
capacidade**. Sem isso, quem soma as colunas conclui que há erro; e um gráfico de
fatias exclusivas estaria simplesmente errado.

### Operações

`Vincular` só aparece quando `availableForConnection` — que é **advisory**. A
autoridade é a transação do servidor, e `isPortOfferable` **não** foi copiado
para o cliente.

Ao escolher um cliente já conectado, a tela **diz onde ele está** e a ação vira
**Mover para esta porta**. Nunca desconectar e conectar em duas requisições: isso
abriria uma janela sem vínculo e perderia a atomicidade que o domínio garante
numa transação só.

Porta ocupada oferece `Mover` e `Desconectar` **mesmo em CTO inativa e mesmo
sendo histórica** — desativar uma caixa ou reduzir capacidade não pode aprisionar
quem está dentro. O que some é apenas o `Vincular`.

`Desconectar` envia o **id do vínculo que a tela viu**, nunca o do cliente.

### O defeito que o teste encontrou, e é o mais importante da fase

No conflito eu chamava `router.refresh()` e mantinha a mensagem **dentro do
diálogo**. A releitura remove a premissa da caixa aberta — a porta deixa de estar
ocupada —, o diálogo desmonta e **leva a mensagem junto**. O operador via um
clique sem resposta: exatamente a `CTO-1.3`, em que recusa invisível é
indistinguível de botão quebrado.

O teste de obsolescência passou algumas vezes por **temporização** — o `refresh`
ainda não tinha chegado quando a asserção rodou — e falhou na suíte inteira.
Agora conflito **fecha** o diálogo e entrega a mensagem à PÁGINA, que sobrevive à
releitura. Erro de payload ou permissão **não** fecha: ali a premissa continua de
pé e a pessoa tem o que corrigir.

### Duas vezes o mesmo erro meu de escopo em teste

`E2E-DUPLO-CLIQUE` e `E2E-MOVE` contavam auditoria **por empresa**, e testes
irmãos do mesmo arquivo já gravavam antes. Os dois passavam isolados e falhavam
na suíte — que é o sinal exato de escopo errado. Passaram a contar pelos
**vínculos daquele cliente**.

No `E2E-MOVE` havia um agravante: o filtro que escrevi (`entityId !== null`) era
inócuo e não filtrava nada.

### Reversões

| | sabotagem | quem cai |
|---|---|---|
| `AM` | esconder o estado administrativo | `DAMAGED` e `RESERVED` ocupadas |
| `AN` | desconectar pelo cliente, não pelo vínculo | obsolescência: o vínculo NOVO é encerrado |
| `AO` | mover como desconectar + conectar | **passou** — ver abaixo |
| `AP` | chave nova a cada envio, sem guard visual | duplo clique |
| `AQ` | sem releitura após conflito | a tela não se corrige |
| `AR` | oferecer por `administrativeState`, ignorando ocupação | porta ocupada e CTO inativa voltam a oferecer |

**`AO` passou porque meu teste contava LINHAS.** Desconectar+conectar produz
exatamente as mesmas duas — a diferença não está na quantidade, está no que o
registro **diz ter acontecido**. Passou a afirmar a história auditada: um
movimento é `CTO_CONNECTION.MOVED`, o par é `DISCONNECTED` + `CONNECTED`. Aí a
sabotagem cai.

### Gates

`diff --check` · `prisma validate` · `migrate status` (**27, nenhuma nova**) ·
lint · tsc · **1976 Vitest** (inalterado — a fase é de tela) · **147 Playwright**
(era 132) · build · build:worker.

## 28. `CTO-2.3` — checkpoint final, validado pelo dono

`CONNECT`, `MOVE`, `DISCONNECT`, `DAMAGED + occupied`, os três com `F5`, e
mobile 390×844 sem estouro: **validados manualmente na tela**. Dois patches
saíram dessa validação, e os dois são da mesma família.

### `CTO-2.3.1` — a ação de porta não se anunciava

Numa porta ocupada, clicar em **Danificada** mudava o estado corretamente e a
tela seguia exibindo o banner verde da operação **anterior**. Pior que silêncio:
uma mensagem **errada** ocupando o lugar da certa.

Causa: `send()` limpava o erro e não tocava as mensagens de sucesso, e
`handlePortState` não produzia confirmação própria. Duas metades faltando. Agora
toda mutação apaga o feedback anterior — a mensagem mais recente é a única
autoridade visual — e a ação nomeia porta e efeito.

### `CTO-2.3.2` — a confirmação existia e ninguém via

`MOVE` e `DISCONNECT` pareciam não confirmar nada. A hipótese óbvia estava
errada: a mensagem **era** criada, com o texto certo. Era **posição**.

```text
toBeInViewport() failed — Received: viewport ratio 0
```

O banner vivia na seção "Ocupação", acima da lista; numa CTO de 16 posições a
ação acontece dezenas de linhas abaixo. **É a `CTO-1.3` num lugar novo.**

A confirmação passou a aparecer **na linha da porta em que se clicou**, como
selo ao lado dos botões — e a da mudança de estado foi junto, porque tinha o
mesmo problema latente e só passara na validação por sorte de posição. Um
mecanismo, não dois.

**Selo, e não bloco de largura inteira**, e isso quem ensinou foi um teste: com
`w-full` num contêiner `flex-wrap`, a mensagem forçava quebra e **crescia a
lista**, empurrando a seção de capacidade para fora da viewport. Um teste da
`CTO-1.5` caiu exatamente aí. *Uma confirmação não pode expulsar da tela a
recusa de outra operação.*

**Copy:** `"da CTO CTO QA 011"` saía assim porque a operação nomeia as caixas
começando por "CTO". A saída **não** é `startsWith("CTO")` — quebraria na
primeira caixa chamada "CX-45" —, é tratar o nome como nome, em linha própria.

**Abrir um diálogo apaga a confirmação anterior, e isso não vai ao servidor.** A
primeira versão chamava `router.refresh()` ali e criou uma corrida: a releitura
podia pousar enquanto a pessoa montava a operação. Releitura é para quando o
estado autoritativo mudou.

### Uma instabilidade PRÉ-EXISTENTE, encontrada e atribuída

`"a foto vem ANTES de Salvar"` clicava em salvar e **recarregava sem esperar o
`PATCH`**. Atribuição por medição, não por suposição: contra o código anterior à
fase falha **2 de 3** com `.next` frio; com a mudança da fase, 1 de 3. Não era
regressão. `preencherEstavel` **não** resolveu, e foi isso que localizou a causa
no `reload` em vez da digitação.

### O que continua PENDENTE

| | |
|---|---|
| `CTO-2.6` · alvo `RESERVED` com vínculo ativo → `409` | não implementado, e verificado por teste no checkpoint |
| `CTO-2.6` · redução bloqueada por vínculo acima do limite | idem |
| `CTO-2.4` · Field | zero rota, zero Dart |

### Contratos reconferidos no checkpoint

`ADMIN` é o único perfil (`MANAGE_PROFILES`), e o `TECHNICIAN` com sessão
legítima recebe `403` nas **quatro** rotas — a tela não é a barreira.
`companyId` nunca é lido de entrada; `source: "WEB"` é fixado nas três
mutações; `expectedConnectionId` é obrigatório em `disconnect` e `move`;
`Idempotency-Key` é exigida nas três. `isPortOfferable` aparece na UI **apenas
em comentário** — não foi copiado.

A chave de idempotência **não atravessa usuários** da mesma empresa: o escopo é
`(empresa, usuário, operação, chave)`, e dois ADMINs com a mesma chave executam
operações distintas.

O nome do cliente **não** viaja na visão da rede do cliente — ela devolve caixa,
porta e carimbos. Ele aparece no detalhe da CTO, como JSON escapado.

## 29. `CTO-2.4` — a rede pela API do Field

**Nenhuma migration, nenhuma alteração de schema, nenhuma dependência, zero
Dart.** A `CTO-2.5` é quem faz a tela; esta fase termina com a API pronta para
consumo.

### O que foi reutilizado, e o que precisou nascer

Nada de framework novo. As rotas usam `fieldOrderCommand`, que já fixa a ordem
`autenticar → elegibilidade → chave → corpo → dedup → domínio`; a posse e o
estado saem de `loadInProgressOwnedOrder` e `claimOrderForChildMutation`, os
mesmos de evidência, material, equipamento, assinatura e checklist; a
idempotência é `withIdempotency`; o contrato de erro é `FieldError`; e a rede é
`src/lib/cto-connections.ts`, intacto nas suas regras.

Três coisas nasceram, e as três são pequenas:

| | por quê |
|---|---|
| `ConnectionContext.authorizeWithin` | o domínio abre a própria transação; sem um gancho, a autorização ficaria **fora** dela |
| `FieldCommandOptions.precondition` | a capability precisa ser verificada antes até da reserva de idempotência |
| `resolveOwnedOrderCustomer(..., { requireInProgress })` | um parâmetro, não uma segunda resolução de posse |

### O namespace, e por que a OS está no caminho

```text
GET  /api/field/v1/service-orders/:id/network
GET  /api/field/v1/service-orders/:id/network/ctos?search=&limit=
GET  /api/field/v1/service-orders/:id/network/ctos/:ctoId
POST /api/field/v1/service-orders/:id/network/connect
POST /api/field/v1/service-orders/:id/network/disconnect
POST /api/field/v1/service-orders/:id/network/move
```

A OS é a autorização, então ela é o `:id` do caminho — **não** um campo do corpo
que o servidor depois resolve confiar. Uma rota global `/api/field/cto-connections`
receberia `serviceOrderId` no payload, e a diferença entre as duas formas não é
estética: no caminho, a autorização é estrutural.

O vínculo, ao contrário, **não** entra no caminho. Ele não é filho da OS —
pertence ao cliente, e `serviceOrderId` é procedência (`SET NULL`), não posse.
Pendurá-lo em `/network/:connectionId/disconnect` sugeriria uma propriedade que o
modelo não tem; ele viaja como `expectedConnectionId`, que é o nome do que ele
de fato é.

### O cliente não é campo de payload

`customerId` não existe nos três schemas. Ele é derivado da OS, e a classe
inteira de *OS legítima do meu técnico usada para mexer em outro cliente* deixa
de ter onde ser escrita — não por uma comparação que alguém precisa lembrar de
fazer, mas porque não há campo. O mesmo vale para `companyId`, `source`,
`technicianId`, `serviceOrderId` e todo carimbo de tempo: os schemas são
`.strict()` e qualquer um deles devolve `400`.

### `authorizeWithin` — por que dentro da transação

A autorização acontece duas vezes, e as duas contam. Fora, para descobrir o
cliente e recusar cedo o que nunca vai passar. **Dentro**, porque é ela que
decide: `claimOrderForChildMutation` segura a linha da OS até o commit, e sem
isso a OS poderia ser concluída entre a conferência e a escrita — o
`ServiceOrderEvent` nasceria depois do fechamento, numa OS que o snapshot de
conclusão já declarou encerrada.

A ordem de lock passa a ser **`ServiceOrder → Customer → CTO`**, e é consistente:
nada que trave `Customer` pede `ServiceOrder` exclusivo depois, porque a origem
`WEB` sequer toca OS. O `INSERT` do evento já pegava `FOR KEY SHARE` na OS
depois dos outros dois locks; com a reivindicação antes, essa aquisição vira
no-op para nós.

### `expectedVersion` responde uma pergunta, os locks respondem outra

O CAS da OS **não** protege a ocupação da porta — isso é do lock da CTO e das
duas uniques parciais. Ele protege a **sessão operacional** da visita, e é o
mesmo token que o aplicativo já usa em toda escrita-filha. As duas proteções não
se substituem, e a `DQ-3` já pagou para aprender que dois agregados exigem dois
mecanismos.

### Leitura também exige `IN_PROGRESS`, e isso DIVERGE do precedente

O parente mais próximo é `../diagnostic`: exige posse e **não** exige
`IN_PROGRESS`, porque é consultado a caminho do cliente. Aqui a decisão é a
oposta, por duas razões declaradas:

* o que esta leitura abre não é o cliente da OS, é a **rede da empresa** — as
  caixas, as posições e quais estão livres. Nenhuma outra leitura do Field tem
  esse alcance; todas as demais param no que já é do próprio técnico;
* as três mutações exigem `IN_PROGRESS`. Uma leitura mais permissiva ofereceria
  ao aplicativo uma tela que ele não teria como usar.

Consequência aceita e registrada: o técnico não vê a caixa do cliente antes de
dar início ao atendimento.

### O que o Field NÃO recebe

O ocupante de qualquer porta que não seja a do cliente da OS. Uma caixa de 16
posições costuma ter 15 clientes de outras pessoas, e `occupied: true` responde a
pergunta operacional inteira — *posso usar esta porta?* — sem entregar nome
nenhum. Também ficam fora `companyId`, coordenadas, foto, observações
administrativas e tudo de PPPoE.

E **`effectiveState` não existe no DTO do Field**. Ele colapsa em `OCCUPIED` e
apagaria `DAMAGED` de uma porta com cliente dentro — o defeito que a `CTO-2.2`
corrigiu no resumo administrativo. O aparelho recebe `administrativeState` e
`occupied` separados e decide o rótulo.

### Sem `N+1`, e sem devolver a rede inteira

A lista de candidatas **não** traz portas: 50 caixas de até 256 posições seriam
milhares de linhas para uma tela que precisa de uma. O técnico acha a caixa e
depois pede as portas dela, que é como ele trabalha no poste. A ocupação da
página inteira sai de **uma** consulta agrupada, e há teste que conta as chamadas
em vez de confiar na leitura do código.

### Online, e só

`CONNECT`, `DISCONNECT` e `MOVE` não entram em fila offline (§24.21). Nenhum DTO
de sincronização, nenhum job, nenhuma reserva local. Sem servidor, a operação não
acontece.

### O que as reversões mediram, e não o que eu suporia

| | sabotagem | quem cai |
|---|---|---|
| `AY` | cliente vindo do corpo | `FIELD-C05b`, `FIELD-C11` |
| `AZ` | posse do técnico removida | `F-A1` |
| `BA` | `ASSIGNED` aceita | `FIELD-C07` (total), `FIELD-R13` (parcial) |
| `BB` | `disconnect` sem guarda de obsolescência | `FIELD-D04` |
| `BC` | `move` sem guarda de obsolescência | `FIELD-M06` |
| `BD` | `technicianId` vindo do corpo | `FIELD-C05b` |
| `BE` | procedência `WEB` na rota do Field | `FIELD-C02`, `F-A2`, `FIELD-D03`, `FIELD-M01` |
| `BF` | sem idempotência | `FIELD-D08`, `FIELD-M11` |
| `BG` | OS fora da impressão digital da chave | `F-A7` |
| `BH` | autorização só FORA da transação | `FIELD-C20` |

**A `AY` passou na primeira rodada, e a culpa era do meu teste.** O `FIELD-C05b`
mandava `customerId` e `technicianId` **juntos**, e a recusa do segundo pelo
`.strict()` chegava primeiro: a asserção passava com o ataque bem-sucedido. Um
teste que agrega dois ataques só prova que ALGUM deles foi barrado. Agora é um
campo por vez.

**A escrita tem posse em dois portões; a leitura, em um.** Removendo a posse só
de `resolveOwnedOrderCustomer`, a escrita **continuou** recusando — o
`loadOwnedServiceOrder` de dentro da transação a pegou —, e quem caiu foi a
leitura. O mesmo vale para o `IN_PROGRESS`: três portões na escrita
(`resolveOwnedOrderCustomer`, `loadInProgressOwnedOrder` e o predicado do
`claim`), um só na leitura. Por isso `F-A1` e `FIELD-R13` são permanentes: são
eles que cobrem o caminho de gate único.

**A `BF` não produz duplicata, produz `409`.** Sem idempotência, o replay é
recusado pelo CAS — o que significa que uma retentativa depois de um timeout
diria "conflito" para uma operação que já tinha dado certo. A idempotência não é
a segunda barreira contra escrita dupla; é o que torna o replay legível.

**O limite que nenhuma reversão fecha:** a corrida *OS concluída entre a
autorização e a escrita* não tem teste determinístico. O que existe é a prova
estrutural — a reivindicação está dentro da transação e segura a linha —, e
`BH` mostra que retirá-la derruba o CAS. A janela em si fica declarada, não
afirmada como testada.

### Um achado da revisão de segurança, corrigido

Uma string com byte `NUL` atravessava `z.string().min(1)`, chegava ao Postgres e
voltava `22021`, que a fronteira do Field traduzia em `INTERNAL`. E `INTERNAL` é
**retentável**: o aplicativo reenviaria em laço uma requisição que nunca teria
como dar certo. A recusa correta é `VALIDATION_ERROR`.

`fieldResourceId` usa a **mesma** classe de caracteres de `clientMutationId` e
`installationId` — não uma terceira inventada —, e cobre o formato de `cuid()`.
Não é controle de acesso: quem chama continua resolvendo o recurso sob a empresa
da sessão.

**A classe do defeito é pré-existente e maior que esta fase**, e isso foi medido,
não suposto: `serviceOrderEvidence` e `timeEntry` se comportam igual. Fica como
`INFO` sobre o codebase, e não como regressão da `CTO-2.4`.

### O que continua fora

`CTO-2.5` (tela Flutter), `CTO-2.6` (integração capacidade/estado — alvo
`RESERVED` com vínculo ativo e redução bloqueada por vínculo acima do limite),
mapa, QR, ERP e FiberMap. Nenhum desses serviços foi tocado.

## 30. `CTO-2.5` — a rede no aparelho do técnico

**Zero backend, zero schema, zero migration, zero dependência, zero permissão
nova.** O diff é Flutter e documentação. A `CTO-2.6` continua pendente.

### O que foi reutilizado, e o que nasceu

Nada de arquitetura paralela: Riverpod com `StateNotifierProvider.autoDispose.family`,
`FieldApiClient` (Bearer, timeouts, contrato de erro, redação de log em um lugar
só), `IdempotencyKey`, `FieldException`, `SectionCard`, `showModalBottomSheet` no
mesmo formato de `execution_forms.dart`, e o padrão de conflito do
`OrderDetailController` — recusa recarrega, não reenvia.

Nasceu um módulo, `lib/features/network/`, com as quatro camadas que o projeto
já usa (`domain`, `data`, `state`, `ui`), e **uma linha** na tela do detalhe.

### A seção vive DENTRO da OS

Não há destino "Rede" na barra nem na gaveta. O técnico não navega pela rede da
empresa: ele atende um cliente, e a operação de porta existe porque há uma
visita. Uma superfície fora da OS faria a pergunta *para qual cliente?* voltar a
precisar de resposta — que é exatamente o que a `CTO-2.4` eliminou ao derivar o
cliente da própria OS.

### O portão de status é de UX, não de segurança

Fora de `IN_PROGRESS` a seção **nem lê**. A leitura da `CTO-2.4` também exige
atendimento em andamento; chamar assim mesmo produziria um `409` garantido a
cada abertura de OS. Há teste afirmando **zero** requisições nesse caso.

Quem recusa continua sendo o servidor, e isso é testado dos dois lados: a
`FU-05` prova que a tela não oferece, e a `UI-A11` prova que a seção **fecha
sozinha** quando a OS deixa de estar em atendimento com a tela aberta.

### As duas dimensões, sempre

`administrativeState` e `occupied` chegam separados e são exibidos separados.
`effectiveState` **não existe** no modelo Dart: ele colapsa em `OCCUPIED` e
apagaria `DAMAGED` de uma porta com cliente dentro — o defeito que a `CTO-2.2`
corrigiu no resumo administrativo, aqui impedido por ausência de campo.

```text
AVAILABLE + ocupada  →  Ocupada
DAMAGED   + ocupada  →  Ocupada · Danificada       ← e continua Mover/Desconectar
RESERVED  + ocupada  →  Ocupada · Reservada        ← legado, idem
desconhecido         →  Ocupada · Estado desconhecido
```

Um enum que este APK não conhece vira `unknown`, ganha selo e **não** é
oferecido — em vez de estourar num aparelho em campo.

### Online, e a mensagem não mente

`CONNECT`, `DISCONNECT` e `MOVE` não entram em fila offline. Não existe DTO de
sincronização, job, reserva local nem promessa de "sincronizamos depois" — que
seria falsa. Sem rede: *"Esta operação precisa de internet. Nada foi enviado."*

A prova é estrutural além de comportamental: um teste lê o **código** do módulo
(com os comentários removidos) e afirma zero referências a `PendingOperation`,
`SyncStatus` e `pending_operation`.

**Nenhuma dependência de conectividade foi adicionada.** O aplicativo não tem
uma, e trazer um pacote só para desabilitar um botão seria superfície de
terceiro em troca de nada: a falha de rede já chega tipada como
`FieldErrorCode.network`.

### A chave de idempotência inclui o DESTINO

Ela nasce na intenção, é guardada e reapresentada em cada retentativa — gerada
no envio, cada retentativa seria um comando novo e a proteção não existiria.

O escopo é `connect:<porta>`, `move:<vínculo>:<porta>`, `disconnect:<vínculo>`.
Presa só à operação, ela seria reapresentada quando o técnico desistisse e
escolhesse **outra** porta, e o servidor recusaria com `IDEMPOTENCY_CONFLICT`
uma operação legítima.

Três regras de descarte, e a do meio é a menos óbvia:

| desfecho | chave | OS relida? |
|---|---|---|
| sucesso | descartada — a próxima ação é outra | sim |
| conflito | descartada — a intenção não existe mais | sim |
| **sem rede** | **preservada** | **não** |

A OS não é relida sem rede porque, se o comando tiver chegado e só a resposta se
perdido, reler traria uma `version` nova; o corpo da retentativa mudaria e ela
viraria `IDEMPOTENCY_CONFLICT` em vez do replay que deve ser.

### Conflito fecha a folha e a mensagem sobe

Mesma lição da `CTO-2.3`: a releitura remove a premissa da folha aberta — a
porta foi ocupada, o vínculo mudou —, e uma mensagem presa lá dentro sumiria
junto. A recusa aparece **na seção**, ao lado dos botões que a provocaram
(`CTO-1.3`, `CTO-2.3.2`).

E o estado que fica na tela é o do **servidor**, nunca o destino que o técnico
escolheu: `FU-11` prova que depois de um `MOVE` recusado a caixa exibida é a que
o despacho gravou, e não a que ele havia selecionado.

### Mover é UMA requisição

`FU-10` conta as chamadas: um `POST .../move`, **zero** `disconnect` e **zero**
`connect`. O par abriria uma janela em que o cliente não está em porta nenhuma, e
nenhum dos dois lados poderia desfazer o outro se a rede caísse no meio.

A porta atual não aparece como destino, e **sem regra própria**: ela chega
`occupied` e o servidor já a marcou como não ofertável. `isPortOfferable` não foi
copiado para o Dart — seria uma segunda autoridade.

### Desempenho e resiliência

Lista de caixas e lista de portas são `ListView.builder`. Numa caixa de 256
posições, o teste conta os widgets construídos e exige **menos de 60** — uma
`Column` ansiosa construiria as 256. A escolha é em duas etapas (caixa, depois
portas) porque a `CTO-2.4` não devolve portas na listagem, justamente para a
resposta não ter milhares de linhas.

Nome de caixa com 100 caracteres em 320dp: sem overflow, e o **número da porta**
continua visível — é a informação que o técnico procura.

### O que os testes descobriram, e não o que eu suporia

**Três testes estruturais falharam nas minhas PRÓPRIAS frases.** A primeira
versão grepava o arquivo cru e leu *"não chamamos `/api/cto-connections`"* como
se fosse uma chamada; o mesmo com a fila offline; e o manifesto Android, cujo
comentário diz que `ACCESS_BACKGROUND_LOCATION` **não** é pedida. Um teste que
lê comentário mede o inverso do que promete. Agora eles removem comentários
antes de olhar, e o do manifesto virou **igualdade de conjunto** — lista de
proibidas só pega o que alguém já imaginou.

**`FU-18` procurava "PPPoE" na tela inteira** e caía na seção de PPPoE, que é
legítima, tem porta própria e é auditada. Passou a ser escopado à seção de rede,
com controle positivo.

**O teste de 390×844 passou duas vezes pelo motivo errado.** Ele montava a
`MediaQuery` **fora** do `MaterialApp` do harness, que a descartava; e, corrigido
isso, o widget nem era construído, porque numa `ListView` de tela real o que
está fora da viewport não existe. Só depois de rolar até a seção o teste passou a
testar alguma coisa.

**Um ataque foi descartado em vez de promovido:** ele afirmava que a projeção não
carrega campo de cliente lendo o `toString` de uma classe sem `toString` próprio
— comparava contra `Instance of ...`. Quem prova essa fronteira é a `UI-A1`, que
olha a **tela** depois de o servidor injetar `customerId`, `companyId` e
`technicianId` na resposta.

### Reversões

| | sabotagem | quem cai |
|---|---|---|
| `BI` | Field falando com a API administrativa | 8 testes de contrato e idempotência |
| `BJ` | sem portão visual de status | `FU-05`, `FU-05b` |
| `BK` | mutação na fila offline | `EST-04` |
| `BL` | esconder o estado administrativo quando ocupada | `FU-03`, `FU-04`, `FU-04b`, `FU-16` |
| `BM` | mover como desconectar + conectar | `FU-10`, `FU-11` |
| `BN` | desconectar sem `expectedConnectionId` | `API-03`, `FU-12` |
| `BO` | chave gerada no envio | `FI-02` |
| `BP` | sucesso local antes da resposta | 7 testes, entre conflito e offline |
| `BQ` | 256 portas numa `Column` ansiosa | `EST-09` |

Todas restauradas, árvore limpa.

### Fronteiras que esta fase NÃO cruzou

Sem mapa, sem QR, sem edição administrativa de porta (reservar, danificar,
liberar continuam sendo leitura no Field), sem histórico de vínculo, sem
navegação global de rede, sem evento de timeline escrito pelo cliente — o
servidor já grava. E a `CTO-2.6` continua pendente: alvo `RESERVED` com vínculo
ativo, e redução de capacidade bloqueada por vínculo acima do limite.

**A fase termina com API e tela prontas e o piloto físico ainda por fazer.** Nem
gesto de sistema nem visual se aprovam por teste de widget: a sequência de
validação está no relatório da fase.

## 31. `CTO-2.6` — integridade entre vínculo, estado da porta e capacidade

As duas proteções que faltavam, e as duas são sobre o mesmo erro: **uma decisão
administrativa passar por cima de um cliente que está conectado.**

**Zero migration, zero schema, zero dependência, zero rota nova, zero Dart, zero
alteração de UI.** O diff de produção é um arquivo: `src/lib/cto.ts`.

### Regra 1 — `RESERVED` é proibido enquanto há vínculo ativo

```text
ativo + AVAILABLE → RESERVED   409
ativo + DAMAGED   → RESERVED   409
ativo + RESERVED  → RESERVED   409   ← legado, e o no-op também recusa
ativo + qualquer  → AVAILABLE  ok
ativo + qualquer  → DAMAGED    ok
livre             → RESERVED   ok
```

**A regra é sobre o ALVO, nunca sobre o estado atual**, e a diferença decide se
ela é utilizável. *"Porta ocupada não muda de estado"* criaria um beco sem saída:
uma porta consertada nunca voltaria a `AVAILABLE`, e a linha legada
`ativa + RESERVED` — que o produto admite existir — ficaria presa para sempre.

`DAMAGED` com cliente ligado continua permitido porque é situação real de campo:
o cabo quebra com o cliente conectado. `RESERVED` significa *separei esta posição
para uso futuro* e não convive com alguém já dentro dela.

O **no-op recusa junto**, pelo mesmo motivo da `CTO-1.9`: um `200` mudo
anunciaria que reservar está disponível, o que é falso. Não aprisiona nada — as
duas saídas seguem abertas.

### Regra 2 — cliente acima do novo limite recusa a redução

```text
capacity 8, cliente ativo na porta 8, tentar 8 → 4   ⇒  409
```

E **nada é feito por conta própria**: nenhum vínculo encerrado, nenhum cliente
movido, nenhuma `CTOPort` apagada, nenhum histórico tocado, nenhuma alteração
parcial. A transação inteira volta.

É reportada **antes** da regra da `CTO-1` (`RESERVED`/`DAMAGED` acima do limite)
porque é a mais dura de destravar: estado administrativo se resolve num clique,
e um cliente conectado exige mover ou desconectar — decisão de operação, não de
formulário.

### O lugar da regra É a regra

As duas consultas acontecem **depois** do `FOR UPDATE` da CTO, no mesmo
`lockCto` que a `CTO-1` já usava. Nenhum lock novo, nenhuma ordem nova: a
arquitetura congelada da `CTO-2` continua inteira, e `CONNECT`, `MOVE`, mudança
de estado e mudança de capacidade disputam a **mesma linha de `ctos`**.

| corrida | quem commita primeiro | desfecho |
|---|---|---|
| `CONNECT` na 8 × reduzir para 4 | redução | `CONNECT` relê a capacidade do lock e recusa por faixa |
| | vínculo | a redução o encontra e recusa |
| `CONNECT` × `RESERVED` na mesma porta | reserva | `CONNECT` relê a porta e recusa por `isPortOfferable` |
| | vínculo | a reserva o encontra e recusa |

`MOVE` se comporta como `CONNECT` no destino, e trava as duas caixas ordenadas
por `id` — inalterado.

**Nenhum lock de `CTOPort` foi criado.** A `CTO-1` decidiu travar a CAIXA, e um
segundo nível teria de coexistir com ele — exatamente a complexidade que a
decisão evitava.

### O que os testes descobriram, e não o que eu suporia

**As corridas da primeira versão PASSAVAM com a regra removida.** Disparadas
juntas, a operação administrativa sempre vencia o lock, porque o `CONNECT` faz
mais trabalho antes dele: trava o cliente, resolve a porta, e só então trava a
caixa. A ordem perigosa — o vínculo commita, e a administrativa lê depois —
**nunca acontecia**.

Agora cada corrida roda nas **duas** ordens, e conta quantas vezes o vínculo
venceu, exigindo pelo menos uma. Sem essa contagem o teste voltaria a provar
metade do que afirma.

Foi essa correção que tornou possível a prova mais importante da fase: mover a
consulta para **antes** do lock (`TOCTOU`) derruba exatamente `RACE-02` e
`RACE-04`. Com as corridas antigas, essa sabotagem passaria despercebida.

**Um teste da `CTO-2.2` mudou de PREPARO, não de afirmação.** Ele montava a
linha legada `ativa + RESERVED` **pelo serviço** — caminho que esta fase
proíbe. Passou a gravá-la direto no banco, que é como o dado antigo existe de
verdade. A afirmação continua a mesma: o read model tem de mostrar as duas
dimensões da linha legada em vez de esconder a inconsistência. O próprio
comentário do teste já previa esta fase.

### Reversões

| | sabotagem | quem cai |
|---|---|---|
| `S1` | sem a regra do alvo `RESERVED` | `INT-01/02/09/10`, `RACE-02`, `RACE-04`, `RACE-05` |
| `S2` | sem a regra de capacidade | `CAP-02/05/06/07`, `RACE-01`, `RACE-03` |
| `S3` | regra sobre o estado ATUAL, não sobre o alvo | `INT-03`, `INT-04`, `INT-06` — o beco sem saída |
| `S4` | consulta ANTES do lock (`TOCTOU`) | `RACE-02`, `RACE-04` |
| `S5` | tenant fora do predicado das consultas novas | **nada cai** — ver abaixo |

### `S5` — o que o predicado de tenant faz, e o que não faz

`companyId` nessas duas consultas é **defesa em profundidade, não fechamento de
vetor**. Removê-lo não derruba teste nenhum, e a razão é estrutural: o
`ctoPortId` já foi provado da empresa antes de chegar lá —
`setPortAdministrativeState` resolve a porta por `{ id, ctoId, companyId }`, e a
redução deriva os ids das portas da própria caixa travada.

Medido, não suposto: uma linha corrompida com `companyId` de B apontando uma
porta de A **não** bloqueia a redução de A. Ela só nasce por escrita direta —
`connectCustomerToPort` usa o mesmo `companyId` para gravar e para resolver a
porta. O predicado fica porque é a convenção do projeto e porque sobrevive a uma
refatoração futura que perca o escopo; não porque feche um caminho alcançável.

### O read model não mudou

`administrativeState` e `occupied` continuam independentes, `OCCUPIED` continua
sem existir como estado gravável, e `free + reserved + damaged + occupied` pode
passar de `capacity`. `DAMAGED + ocupada` conta nos dois agregados — e agora é
um estado que a operação pode criar de propósito, o que torna a contagem por
`administrativeState` ainda mais necessária.

### O que continua fora

Nenhuma funcionalidade nova no Flutter — o Field não altera estado
administrativo nem capacidade, e não precisou de uma linha. A UI Web recebe a
mensagem de conflito pelo caminho que a `CTO-2.3.1` já construiu, sem duplicar
regra: o backend é a autoridade, e a tela apenas mostra o que ele respondeu.

## 32. `CTO-2.7` — validação do dono e checkpoint do `CTO-2`

Fase de **validação**, não de funcionalidade. O diff de produção é **zero**: um
único arquivo de teste nasceu, para fechar uma lacuna que o inventário
encontrou.

### Matriz dos critérios de aceite

| AC | prova | camada | status |
|---|---|---|---|
| `AC01` cadastro pelo nome | `cto.test.ts` · `cto-routes.test.ts` | domínio + rota | ok |
| `AC02` capacidade e portas | `cto.test.ts` *"capacity=8 cria exatamente as portas 1..8"* | domínio | ok |
| `AC03` técnico encontra pelo nome | `network_test.dart` `API-05` · `network_section_test.dart` (busca com debounce) | Flutter | ok |
| `AC04` portas livres e ocupadas, do servidor | `field-cto-connections.test.ts` `FIELD-R05/06/07/08` | API Field | ok |
| `AC05` cliente em UMA porta ativa | `cto-connections.test.ts` `CN-11` + `CN-28` (índice parcial bloqueia no banco) | domínio + banco | ok |
| `AC06` dois técnicos, uma porta | `CN-10` · `CN-27` · `cto-connections-concurrency` `C1` · `cto-integrity` `RACE-02` | domínio + banco + corrida | ok |
| `AC07` mover preserva o anterior legível | `CN-14` · `CN-15` · `LIFE-01` | domínio | ok |
| `AC08` mapa | — | — | **fora**: `CTO-3` |
| `AC09` a CTO mostra os clientes | `cto-connections-api.test.ts` (read model) · `e2e/cto-connections.spec.ts` | rota + navegador | ok |
| `AC10` status da fonte existente | — | — | **fora**: `CTO-5` |
| `AC11` provider indisponível → `UNKNOWN` | — | — | **fora**: `CTO-5` |
| `AC12` A não enxerga CTO de B | `CN-18/18b` · `cto-routes` · `cto-hardening` | domínio + rota | ok |
| `AC13` QR desligado não bloqueia nada | — | — | **fora**: `CTO-7`, e o QR não existe |
| `AC14` reduzir abaixo da porta ocupada é recusado | `cto-integrity.test.ts` `CAP-02` · `NEG-02` | domínio | ok — **fechado na `CTO-2.6`** |
| `AC15` o status carrega a IDADE | — | — | **fora**: `CTO-5` |

Onze dos quinze pertencem ao `CTO-2` e estão provados. Os quatro restantes são
de fases que não existem em código, e continuam sob a §119 do PRD.

### A lacuna que o inventário encontrou

O invariante *"o vínculo não pertence ao ciclo de vida da OS"* era
**estruturalmente verdadeiro e não tinha teste nenhum**. Verificado no código:
só `cto-connections.ts` escreve na tabela, com `create` e `update`; **não existe
`delete` em produção**; e a FK da OS é `SetNull`, de modo que apagar a ordem nem
alcançaria a linha.

Faltava dizer isso em teste, para que um `completeServiceOrder` futuro que
resolva "limpar" caia num teste em vez de numa auditoria. `LIFE-02` compara
**todas** as linhas da empresa por igualdade profunda, e não só a que a OS
criou: conferir apenas essa deixaria passar exatamente o defeito que preocupa —
uma limpeza escrita por empresa.

**Nenhuma alteração de produção.** A lacuna era de cobertura, não de
comportamento.

### Sabotagens

| | mutação | quem caiu |
|---|---|---|
| `T1` | sem o pré-check de porta ocupada | `CN-10`, `CN-29`, `API-11..14`, `API-M05/M07/M08` |
| `T2` | sem o pré-check de cliente já conectado | `CN-11`, `API-11..14`, `FIELD-C18` |
| `T3` | ocupação lida ANTES do `FOR UPDATE` | `RACE-04` (4/4 execuções), `RACE-02` (2/4) |
| `T4` | `RESERVED` permitido em porta ocupada | 10 testes, incluindo o marcador de contrato |
| `T5` | redução permitida sobre cliente conectado | 9 testes, incluindo `NEG-02` |
| `T6a` | `lockCto` sem tenant | 2 testes de cross-tenant, em dois arquivos |
| `T6b` | portão de capability removido | 6 testes, em três arquivos |

Todas restauradas; árvore limpa conferida por `git status`.

**`T1` mediu a camada, não só a regra.** Removendo o pré-check de porta ocupada,
as **corridas continuam passando** — o índice parcial impede a dupla ocupação e
`translateUniqueViolation` a traduz. O que cai é o `409` limpo do caso
sequencial. Pré-check dá a mensagem; índice dá a integridade. As duas coisas
existem, e cada uma tem um detector diferente.

**`T3` é probabilística, e isso está medido.** Ela foi detectada em 4 de 4
execuções, sempre por `RACE-04` e em metade delas também por `RACE-02`. O
caminho pré-lock do `MOVE` é mais longo, então a dianteira de 25 ms leva à ordem
perigosa com mais frequência. O par cobre; nenhuma das duas sozinha é garantia.

### O que a UI Web NÃO mostra, e é decisão, não defeito

`getCustomerNetworkView` devolve `current` **e** `history`. A tela consome
apenas `current`, dentro do diálogo de vínculo, para descobrir onde o cliente já
está e trocar a ação para *Mover*. **Não existe tela de histórico de vínculo**
na web — ele vive no backend e é provado por `CN-12`, `CN-14` e `LIFE-01`.

Fica registrado como `INFO`: um campo do read model sem consumidor de tela.
Nenhuma fase do `CTO-2` prometeu essa tela.

### Validação do dono — `PASS`, 2026-09-09

Executada pelo **dono do produto** na interface real, sobre `CTO QA FIELD 01`
(Alfa Telecom, 8 portas). Os onze passos do roteiro passaram, e as evidências
visuais foram revisadas por ele.

| | passo | resultado |
|---|---|---|
| 1–2 | CTO localizada, 8 portas, 7 livres, 03 ocupada | `PASS` |
| 3 | `RESERVED` na porta 03 ocupada **recusado** | `PASS` |
| 4 | porta 03 **Ocupada + Danificada** ao mesmo tempo | `PASS` |
| 5 | **Liberar** tirou `DAMAGED` **sem** remover o vínculo | `PASS` |
| 6 | segundo cliente vinculado à porta 05 | `PASS` |
| 7 | cliente movido da porta 03 para a 08 | `PASS` |
| 8 | redução `8 → 4` **recusada** | `PASS` |
| 9 | redução `8 → 6` **recusada** pela ocupação da porta 08 | `PASS` |
| 10 | cliente da porta 05 desconectado | `PASS` |
| 11 | cliente movido da 08 de volta para a 03 | `PASS` |

Os passos 3, 8 e 9 são as regras que a `CTO-2.6` acrescentou, e é a primeira vez
que elas são exercidas fora do teste automatizado. O passo 5 é o que prova que a
regra é sobre o **alvo**: a porta saiu de `DAMAGED` com o cliente ainda ligado.

### O que o banco confirma, além do relato

Conferência somente-leitura depois da restauração:

```text
capacity 8 · ativa · estados administrativos: AVAILABLE ×8
free 7 · occupied 1 · reserved 0 · damaged 0
porta 03 = Cliente QA Field CTO
```

O piloto foi devolvido ao estado inicial, e o **histórico guardou cada passo**
em vez de ser sobrescrito — oito linhas na caixa, das quais quatro são desta
sessão:

```text
porta 03  FIELD  …00:33 → 10:16     (fechada pela saída do MOVE)
porta 05  WEB    10:16  → 10:17     (vínculo e desconexão dos passos 6 e 10)
porta 08  WEB    10:16  → 10:18     (destino do passo 7, origem do passo 11)
porta 03  WEB    10:18  → ATIVO     (restauração)
```

Duas coisas que só a leitura mostra. As linhas `FIELD` do piloto de aparelho da
`CTO-2.5` continuam **intactas** ao lado das novas — a preservação de histórico
atravessa fases, e não só operações. E o `MOVE` de volta para a porta 03 criou
uma linha **nova**, não reabriu a antiga: a caixa registra que o cliente esteve
lá, saiu e voltou, que é o que de fato aconteceu.

`CTO QA 011` não foi tocada: `updatedAt` continua em 2026-09-07.

### Estado no fim da fase

```text
CTO-2.1  persistência e domínio                EM CÓDIGO
CTO-2.2  API Admin e read models               EM CÓDIGO
CTO-2.3  Web: vincular / mover / desconectar   EM CÓDIGO · validada pelo dono
CTO-2.4  API Field via OS IN_PROGRESS          EM CÓDIGO
CTO-2.5  UI Field                              EM CÓDIGO · validada em aparelho real
CTO-2.6  integridade estado × capacidade       EM CÓDIGO
CTO-2.7  validação e checkpoint                APPROVED · owner PASS 2026-09-09
```

> **`CTO-2` — DONE.** As sete fatias existem em código, com validação do dono na
> web e em aparelho físico. Sem tag e sem push: a publicação é decisão à parte.
>
> **`CTO-3` (mapa), `CTO-5` (status e idade da leitura), `CTO-6` (falha
> coletiva) e `CTO-7` (QR) continuam sob a §119 do PRD** — nada disso existe em
> código, e o fechamento do `CTO-2` não os promove.

## 33. `CTO-3.0` — discovery do mapa · `DISCOVERY / PLANNED`

Fase de análise. **Zero produção**: nasceu um arquivo de teste de
caracterização, e nada mais. **Nada da `CTO-3` existe em código.**

### A divergência que precisa de decisão sua

O enunciado desta fase chama a `CTO-3` de *"Mapa Operacional"* e a descreve como
um mapa **de CTOs**. O PRD decide outra coisa, e decide explicitamente:

> **§339** — *"A CTO é entidade do Mapa Operacional (§136), que **não existe**.
> **CTO-3 depende dele**; CTO-1, CTO-2 e CTO-4 não."*

E a §136 não é um mapa de CTOs: é o mapa do **despacho** — técnicos, clientes e
ordens de serviço —, classificado `[DIFERENCIAL]`. A §207 acrescenta que ele
fica *"ao lado do quadro e da agenda, sobre o mesmo motor"*.

Lidos juntos, os três dizem que a `CTO-3` é **a camada de CTO de um mapa maior**,
e não um mapa próprio. Construir um mapa só de CTOs criaria a segunda superfície
de mapa que a §207 existe para evitar — e inverteria a dependência declarada.

**Recomendação, e ela não fecha nenhuma das duas portas:** construir o **motor**
do mapa (§200 *bounding box* + §201 eixos de filtro) desde o início
**agnóstico de camada**, com a **camada de CTO como a primeira**. As demais
camadas da §136 passam a ser slices que se plugam no mesmo motor. O trabalho é o
mesmo nos dois caminhos; o que muda é a ordem de entrega.

**A decisão é sua:** camada de CTO primeiro (recomendado), ou §136 inteira antes.

### Estado da geolocalização — o que já existe

| | onde | o que carrega |
|---|---|---|
| `Customer.latitude/longitude` | `Decimal?` sem precisão declarada | legado, mantido como **projeção de leitura** |
| `CustomerLocation` | tabela própria | `accuracy`, `source`, `verified` + quem/quando, `reference`, `version` próprio |
| `CustomerLocationHistory` | tabela imutável | trilha de correção, uma linha por alteração |
| `ServiceOrderCheckIn` | `Decimal(10,7)` + `accuracyMeters` | evidência de chegada |
| `TimeEntry` | `Decimal(10,7)` + `accuracyMeters` | batida de ponto |
| `CTO.latitude/longitude` | `Decimal(10,7)?` | **a caixa** |

`src/lib/geo.ts` traz haversine (`R = 6.371.008,8 m`) e os dois validadores de
coordenada e de precisão. `src/lib/map-links.ts` monta os links de navegação
para Google Maps e Waze — **sem chave e sem SDK**.

**`TechnicianLocation` NÃO existe** (§135 é `[DIFERENCIAL]`, sem código). O mapa
web não tem posição de técnico para mostrar; o Field tem GPS do próprio aparelho,
que é coisa diferente.

**Não existe biblioteca de mapa, nenhum componente de marker, nenhum cluster,
nenhuma consulta por *bounding box*** — em lugar nenhum do repositório. A gaveta
do Field já anuncia *"Mapa Operacional"* com selo `EM BREVE` e `route == null`,
que é o contrato da §256.

### A fonte da verdade já está decidida, e está em código

`CTO.latitude/longitude` é a coordenada da caixa, e o próprio schema diz por quê:

> *"Coordenada da CAIXA, não do cliente — e a da caixa é pública por natureza,
> porque ela fica no poste. Não confundir com `CustomerLocation`, que é do
> cliente, tem histórico próprio e regra de precedência própria."*

Respondendo o inventário: a CTO **já tem** coordenada, nullable de propósito
(*"uma CTO sem GPS continua útil, só não entra no mapa"*); **não há** entidade
genérica de localização; **não há** `geometry` nem PostGIS; **não há** duplicação
para a CTO; **não há** `accuracy`, `source`, confirmação nem histórico; o
`updatedAt` é da linha inteira, e portanto **não serve** como auditoria da
coordenada; e quem altera hoje é o `ADMIN`, por `updateCto`.

**Proposta: acrescentar colunas à própria `CTO`, não criar uma `CTOLocation`.**
O motivo é concreto e está escrito no schema: `CustomerLocation` virou tabela
separada porque `Customer.latitude/longitude` já existia e não conseguia carregar
`version`, `accuracy` e `verified` — e removê-las seria migration destrutiva. A
`CTO` não tem esse legado: as colunas dela **são** as únicas, nascidas na
`CTO-1`. Criar tabela ao lado reproduziria a duplicação que a `CustomerLocation`
foi obrigada a ter, em vez de evitá-la.

**E sem `version` próprio.** A `CTO` não usa compare-and-set: capacidade e estado
de porta serializam por `lockCto` com `FOR UPDATE`, e a correção de coordenada
entraria no mesmo lock. Um segundo CAS não teria pergunta a responder — a lição
da `DQ-3`.

### Precedência com o FiberMap — já decidida, nada a propor

A §334 revisou a §202 e fixou:

```text
sem FiberMap integrado
  AlfaOS é autoridade operacional de CTO, porta e vínculo

com FiberMap integrado
  FiberMap  topologia FÍSICA — caixa, capacidade, splitter, cabo, PON, OLT
  AlfaOS    vínculo OPERACIONAL — qual cliente, em qual porta, desde quando
```

E o ponto que a `CTO-3` não pode enfraquecer: *"a integração futura não
sobrescreve o vínculo operacional em silêncio. Divergência entre os dois é fato
a **exibir**, não merge automático"* — a mesma regra que a §197 fixou para
localização.

**O que a `CTO-3` precisa deixar preparado**, sem implementar nada: a coordenada
guardar `source`, para que uma vinda do FiberMap seja distinguível de uma
confirmada em campo; e um identificador externo, quando a integração existir.
Nenhuma consulta do mapa pode depender do FiberMap para responder.

### Segurança e tenancy do mapa

O mapa é superfície de vazamento por natureza: uma coordenada isolada já é
vazamento. As proteções existentes cobrem, **desde que reutilizadas**:
`requireCtoAccess` faz capability → perfil, nessa ordem, e `companyId` sai da
sessão.

O risco novo é o *bounding box*: ele é uma consulta varrível. Com o filtro de
tenant em SQL, varrer o planeta devolve apenas as caixas da própria empresa — o
que é aceitável. **Sem** ele, o mapa vira o caminho mais curto para a rede do
concorrente. Por isso o filtro é do servidor, nunca do cliente (§200).

### Permissões — dentro do que o `C-07` já decidiu

O `C-07` diz que leitura é aberta *"por fase que precise dela"*. A `CTO-3` é a
fase que precisa da leitura do `DISPATCHER`, porque o mapa é do despacho.
`requireCtoAccess` já aceita a lista de perfis por parâmetro — **nenhum papel
novo**, nenhuma capability nova.

```text
ADMIN        mapa · detalhe · editar coordenada
DISPATCHER   mapa · detalhe                      ← aberto pela CTO-3
TECHNICIAN   proximidade pelo Field, dentro da OS · confirmar coordenada em campo
```

`CONNECT`, `MOVE` e `DISCONNECT` **não mudam de dono**: continuam como a `CTO-2`
os entregou.

### O técnico em campo — é ORDENAÇÃO, não mapa

A §339 já decidiu: *"A proximidade GPS **ordena a lista**; ela não escolhe — duas
caixas a 30 m uma da outra são indistinguíveis por GPS de celular, e quem
confirma a caixa física é quem está diante dela."*

Consequência prática: a primeira entrega da `CTO-3` no Field **não é um mapa**, é
uma ordem de lista. O que falta é pequeno e é de contrato: o DTO do Field
**omite as coordenadas da CTO** hoje, deliberadamente (`CTO-2.4`). Sem elas não
há distância a calcular.

Sem GPS, a lista cai para a ordem alfabética que já existe — e a tela precisa
dizer que caiu, pela mesma razão do `LocalOrderNote` da `DQ-6`: uma ordem
calculada não pode ter a mesma cara de uma ordem informada.

### Desempenho

`listCompanyCtos` não tem teto, cursor nem *bounding box*: devolve todas as
caixas da empresa. Serve à tela de gestão que ela alimenta e **não serve ao
mapa** (§200). A leitura do mapa precisa nascer com *bbox*, teto informado e
agregação por caixa numa consulta só — a lição de `N+1` que a `CTO-2.4` já
pagou com `findFieldCandidateCtos`.

### Status visual — derivado, e a precedência precisa de decisão

Nada de `cto.mapStatus`. Os quatro estados úteis saem do que já existe:

```text
INATIVA          active = false
SEM VAGA         nenhuma porta ofertável
COM DANIFICADA   alguma porta DAMAGED dentro da capacidade
COM VAGA         o resto
```

A precedência quando duas coexistem **não está no PRD**. Proposta:
`INATIVA > SEM VAGA > COM DANIFICADA > COM VAGA` — quem despacha pergunta
primeiro *"posso usar?"*, e só depois *"tem defeito?"*. Fica como decisão a
confirmar, não codificada.

### Plano proposto

| slice | objetivo | migration | risco |
|---|---|---|---|
| `CTO-3.1` | leitura agregada com *bbox*, busca e teto informado — **sem mapa** | não | baixo |
| `CTO-3.2` | o mapa web sobre essa leitura | não | **depende da escolha de biblioteca** |
| `CTO-3.3` | proximidade no Field: coordenada no DTO e ordenação | não | baixo |
| `CTO-3.4` | confirmação e correção de coordenada em campo | **sim** | médio |

`CTO-3.1` primeiro de propósito: o contrato de dados do mapa fica testável antes
de existir um pixel, e é nele que moram tenancy, `N+1` e o teto.

**`CTO-3.2` está bloqueada por uma decisão sua.** Não há biblioteca de mapa no
projeto, e escolher uma é decisão de arquitetura. Recomendação: **Leaflet com
tiles do OpenStreetMap** — sem chave, sem faturamento, licença permissiva, e o
projeto já usa deep link para Google Maps e Waze na **navegação**, que é outro
trabalho. Caveat honesto: a política de uso dos tiles públicos do OSM não
sustenta volume de produção; em escala, é tile próprio ou provedor pago.

As demais camadas da §136 — técnicos, clientes, OS — **não são `CTO-3`**. Elas
pertencem ao Mapa Operacional, e entram quando ele for a fase.

### O que a fase encontrou de lacuna

`src/lib/geo.ts` — haversine e os dois validadores — **não tinha teste direto**,
só cobertura indireta por `customer-locations`. É a primitiva sobre a qual a
ordenação por proximidade vai se apoiar. Fechada com caracterização, sem tocar
produção.

> **`CTO-3` — `DISCOVERY / PLANNED`.** Nada em código. `CTO-2` continua `DONE`.

## 34. `CTO-3.1` — o contrato de leitura geográfica

A primeira camada do Mapa Operacional, **sem mapa**. Uma rota, um módulo de
domínio, e a função de contagem que já existia — agora exportada.

**Zero migration, zero schema, zero dependência, zero Dart, zero UI.**

### Decisões do dono, aplicadas

Um **motor de mapa compartilhado**, com a CTO como primeira camada (PRD §136,
§207). Nada aqui é específico de CTO na forma: `BoundingBox`, o teto informado e
o contorno da resposta são o que as camadas de técnico, cliente e OS vão
reaproveitar. O que é de CTO é o conteúdo do marcador.

### O endpoint

```text
GET /api/ctos/map?north=&south=&east=&west=&limit=
```

`map` é segmento estático e vence `[id]` no roteamento do Next; os ids são
`cuid()` e nunca valem `"map"`. O nome segue a convenção que
`/api/ctos/[id]/capacity` e `.../active` já usam.

Sem `assertSameOrigin`: é `GET` puro, como as demais leituras do módulo. Uma
leitura que exigisse origem enquanto as vizinhas não exigem seria a que alguém
acabaria "consertando" tirando a verificação do lugar errado.

### Uma autoridade para a contagem

`summarize` virou **`summarizePortCounts`, exportada**. O mapa chama a mesma
função que o detalhe administrativo. A alternativa óbvia — `GROUP BY` em SQL —
seria mais rápida e criaria uma segunda verdade sobre a mesma pergunta: quando a
regra mudasse, alguém teria de lembrar do SQL. A `CTO-2.2` já mostrou como essa
divergência se esconde.

O preço está medido: com 200 caixas de 8 a 16 posições, 1.600 a 3.200 linhas de
porta por consulta; no pior caso teórico — 200 de 256 —, 51.200. Se um dia
pesar, a saída é o `GROUP BY` **com teste de consistência contra esta função**,
nunca uma reescrita silenciosa.

### Três consultas, e o número não cresce

```text
1  as CTOs do recorte    tenant + bbox + teto, tudo no banco
2  as portas delas       um IN, não uma por caixa
3  os vínculos ativos    um IN, idem
+  a contagem de caixas sem coordenada
```

O `N+1` desta superfície não seria uma tela lenta: seria uma rajada a cada
arrasto do mouse. Índices existentes bastam — `ctos(companyId)`,
`cto_ports(ctoId)` pela unique, `(companyId, ctoPortId)` nas conexões.
**Nenhum índice novo**, e nenhuma migration: no volume atual o `companyId`
já reduz a varredura a um punhado de linhas, e um índice espacial só se paga
quando a faixa de coordenada for o filtro seletivo.

### O antimeridiano é RECUSADO, não tratado

Tratá-lo custa consulta em duas faixas, e o AlfaOS não tem para quem: uma rede
de distribuição é local. Recusar é melhor que devolver vazio — um `200` com
lista vazia faria o mapa concluir que não há caixas na região.

### Status derivado, na precedência aprovada

```text
INACTIVE   a caixa saiu de operação        → nem se pergunta o resto
DAMAGED    tem posição com defeito         → alguém precisa ir lá
FULL       está inteira, e não cabe mais   → não adianta mandar instalação
AVAILABLE  cabe cliente novo
```

`DAMAGED` antes de `FULL` porque lotada é informação de **capacidade** e defeito
é informação de **manutenção** — e manutenção é o que faz alguém se deslocar. Só
posições dentro da capacidade contam: porta histórica danificada não põe a caixa
em manutenção.

Nada é persistido. Não existe `cto.mapStatus`, e um teste percorre as colunas da
tabela para provar que não nasceu nenhuma.

### Sem coordenada não vira marcador

Nem meia coordenada: `null` em qualquer dos dois eixos tira a caixa do mapa.
Elas são **contadas à parte**, em `missingLocationCount`, deliberadamente **fora
do recorte** — uma caixa sem coordenada não está em região nenhuma, e enfiá-la
num `bbox` exigiria inventar um ponto. É esse número que permite ao mapa oferecer
a coleção *sem localização* em vez de esconder o que não sabe posicionar.

### Permissões

`ADMIN` **e** `DISPATCHER` leem. O `C-07` congelou que leitura é aberta *"por
fase que precise dela"*, e o mapa é do despacho — esta é a fase. **Nenhum perfil
novo, nenhuma capability nova**: `requireCtoAccess` já recebe a lista de perfis.

`TECHNICIAN` continua fora: ele lê CTO pelo Field, dentro de uma OS dele.
`CONNECT`, `MOVE` e `DISCONNECT` seguem exatamente como a `CTO-2` os entregou.

### O que as sabotagens mediram

| | mutação | quem caiu |
|---|---|---|
| `S1` | tenant fora do predicado | 5 testes, incluindo o de coordenada isolada |
| `S2` | recorte filtrado em memória | **passou** — ver abaixo |
| `S3` | ocupação vinda do estado administrativo | `MAP-10/11/14/15/15b` |
| `S4` | teto do domínio removido | **passou** — ver abaixo |
| `S5` | precedência `DAMAGED`/`FULL` invertida | `MAP-14` |

**Duas passaram, e as duas eram culpa dos testes.**

`S2` produz **exatamente a mesma lista**: filtrar em memória depois de buscar é
indistinguível pelo resultado. O que muda é que o banco devolve a carteira
inteira antes — o oposto da §200, e um vazamento esperando uma refatoração
distraída. Nasceu daí o `MAP-20`, que afirma sobre a **consulta**: `companyId`,
`latitude`, `longitude` e `take` participam do `where`.

`S4` passou porque o `MAP-09b` pede pela **rota**, que limita antes de chamar o
domínio — o guarda de dentro nunca era exercido. Ele importa por si: quem chamar
`getCtoMapView` direto não passa pela rota, e o teto é a única coisa entre um
mapa e a carteira inteira. Nasceram daí `MAP-09d` e `MAP-09e`.

Com os testes novos, cinco de cinco caem.

### O que continua fora

Leaflet, React Leaflet, marcador, popup, agrupamento, provedor de tiles, o mapa
web, mapa no Flutter, GPS do técnico, ordenação por proximidade, edição e
histórico de coordenada, FiberMap, QR, falha coletiva e OLT/SNMP.

> **`CTO-3` — `IN PROGRESS`.** `CTO-3.1` entregue; `3.2`, `3.3` e `3.4`
> continuam sob a §119. `CTO-2` continua `DONE`.

## 35. `CTO-3.2` — o Mapa Operacional web, camada de CTO

A primeira superfície visual do motor de mapa. **Zero migration, zero schema,
zero Prisma, zero Dart.** Duas dependências novas e um endpoint novo.

### O nome é da superfície, não da camada

`Mapa Operacional`, em `/mapa`. As camadas de técnico, cliente e ordem de
serviço entram sobre o mesmo motor (§136, §207), e um item chamado *"Mapa de
CTOs"* obrigaria a segunda a nascer como uma segunda tela — que é exatamente o
que a §207 existe para evitar.

```text
OperationalMap   moldura · SSR · tiles · carregamento · erro   genérico
  MapCanvas      Leaflet · viewport · zoom/pan                 genérico
    CtoMarkers   marcadores · popup · seleção                  de CTO
CtoMapLayer      DTO · leitura · busca · contadores            de CTO
```

**Nenhuma abstração para camada que não existe.** Não há registro de camadas,
seletor nem interface `MapLayer`: hoje há uma, e inventar o mecanismo de
composição antes da segunda escolheria uma forma sem nenhum caso real para
validá-la. O que existe é a fronteira — `OperationalMap` e `MapCanvas` não
importam nada de CTO.

### O achado que decidiu onde a configuração mora

A CSP do projeto trazia `img-src 'self' data:`. **Tile é imagem de outro host, e
a política bloqueava todos.** O modo de falha é traiçoeiro: a página carrega, os
controles funcionam, os marcadores aparecem, e só o fundo some — violação de CSP
apaga a imagem em vez de quebrar a página, e nada erra o suficiente para alguém
suspeitar da política de segurança.

Por isso `src/lib/map-tiles.config.mjs` é `.mjs`, e não `.ts`: `next.config.mjs`
roda em Node puro, antes de qualquer transpilação, e não importa TypeScript. Com
a configuração só no `.ts`, a CSP teria de repetir o host — e a primeira troca de
provedor deixaria a URL certa no `TileLayer` e o host velho na política.

**Uma configuração de tiles que não alimenta a CSP não é configurável.** Ela só
parece.

O `{s}` de subdomínio vira `https://*.dominio.configurado`, e **só** ele. O
curinga fica preso ao domínio; nunca vira `https:` solto, que liberaria imagem de
qualquer lugar da internet e transformaria a CSP em decoração.

> **Aviso operacional, e não é formalidade.** A política de uso dos tiles
> públicos do OpenStreetMap **não** é infraestrutura de produção: mantida por
> doação, pede identificação de aplicação e recusa uso pesado automatizado —
> exatamente o perfil de dezenas de despachantes arrastando o mapa o dia
> inteiro. Antes de produção: `MAP_TILE_URL` para um provedor contratado ou
> tiles próprios. Nenhuma linha de código muda; é para isso que o arquivo existe.

### SSR — o Leaflet entra por uma porta só

`leaflet` toca `window` **na carga do módulo**, e componente de cliente ainda é
renderizado no servidor pelo Next. Um `import` estático derrubaria o `next build`.
Ele entra apenas por `dynamic(..., { ssr: false })`, em dois pontos: o canvas e
os marcadores.

Medido no artefato, não afirmado por comentário: `grep -rl leaflet .next/server`
devolve **zero** arquivos, e ele aparece só num chunk de cliente.

### A busca é um contrato SEPARADO

Decisão do dono: procurar por nome ou código vale em toda a rede, não no recorte.
Quem procura a `A16` quase sempre está olhando outro bairro, e uma busca limitada
ao visível responderia *"não existe"* sobre uma caixa que existe.

```text
/api/ctos/map          o recorte      bbox obrigatório · teto 200
/api/ctos/map/search   a localização  q obrigatório    · teto 10
```

Ensinar o endpoint do recorte a varrer a carteira quando um parâmetro aparece
transformaria a única superfície com teto garantido numa com teto **condicional**,
e a condição estaria num `if`. O fluxo aprovado termina no primeiro: achar →
recentralizar → **o recorte carrega**. A busca localiza; ela não desenha, e por
isso o DTO dela é menor — cinco campos, sem `summary`, sem `status`, sem `active`.

### O curinga de `LIKE` era um vetor real, e foi MEDIDO

O mínimo de dois caracteres conta caracteres **úteis** — os que não são `%` nem
`_`. Um teste de caracterização mede o comportamento do Prisma em vez de supô-lo,
e o resultado é que **`contains` NÃO escapa**: sem essa contagem, um termo de dois
caracteres `%%` satisfaria o mínimo e casaria com tudo. O teto existiria no
código e não na prática, e a busca viraria a listagem da carteira que o teto do
mapa existe para impedir.

O teste fica como alarme: se uma versão futura do Prisma passar a escapar, ele
falha e a guarda muda de categoria — de vetor fechado para defesa em profundidade.

### Estado nunca viaja só como cor

```text
AVAILABLE  círculo    +   Com vaga
FULL       quadrado   0   Sem vaga
DAMAGED    triângulo  !   Com defeito
INACTIVE   losango    ×   Inativa
```

Forma, glifo e rótulo — a cor é a **quarta** pista. O triângulo é recorte de
verdade (`clip-path`), e não um quadrado com cara de triângulo: a forma precisa
sobreviver a uma captura em preto e branco. A legenda põe os quatro rótulos em
texto na página com todos os popups fechados.

**Nada é recalculado no cliente.** `status`, `free`, `occupied`, `reserved` e
`damaged` chegam prontos da `CTO-3.1`. A tela não conhece a precedência
`INACTIVE > DAMAGED > FULL > AVAILABLE` — ela conhece a tradução de cada valor.
Uma segunda precedência divergiria, e a que ninguém revisaria seria a da tela.

O popup mostra as contagens numa **lista**, nunca numa barra ou rosca:
`livres + reservadas + danificadas + ocupadas` pode passar da capacidade, porque
uma porta danificada com cliente dentro conta nas duas (`CTO-2.2`). Um gráfico de
fatias afirmaria uma soma que o domínio não garante.

### O nome da caixa nunca entra em HTML de string

`divIcon` recebe HTML **cru** e o injeta no DOM. Por isso o ícone é montado só a
partir da tabela de apresentação — quatro formas e quatro glifos, constantes deste
repositório. Nome e código, que são digitados por gente, vão exclusivamente para
dentro do `<Popup>`, que o React escapa. Uma caixa chamada `<img src=x onerror=…>`
aparece como esse texto.

### Falha de API é DISTINTA de área vazia

Carregando: **faixa**, não cortina — cobrir o mapa a cada arrasto tiraria da tela
a referência que a pessoa usa para se localizar. Erro: **cobre**, e diz *"isto não
significa que não existam caixas aqui"*. Um mapa vazio depois de uma falha é
indistinguível de uma região sem infraestrutura, e a leitura errada é a perigosa.
Falha de rede **não limpa os marcadores** anteriores.

### Vista inicial — do banco, nunca de GPS

`min`/`max` de latitude e longitude das caixas da empresa, numa consulta de quatro
agregados que não traz linha nenhuma. Sem caixa localizada, cai num ponto de
**país** (zoom 4 sobre o Brasil), configurável — escolhido justamente por não
parecer um endereço: quem abre entende na hora que o mapa não sabe onde ele opera,
em vez de procurar a própria cidade num ponto plausível e errado. É a `CTO-1.2`
uma camada acima.

**Nada de pedir GPS para abrir o mapa.** Seria cobrar uma permissão do navegador
para responder ao que o banco já responde — e mostraria onde está quem despacha,
não onde está a rede.

### Resposta atrasada não substitui resposta nova

Arrastar do bairro A para o B dispara duas leituras. Se a de A demorar mais — e
demora, quando A tem 200 caixas e B tem três —, ela chega depois e sobrescreve o
resultado certo: o mapa fica no lugar certo com os marcadores do outro lugar, sem
nenhum erro na tela. O `AbortController` **não** basta, porque abortar é um pedido
e uma resposta em trânsito pode passar do ponto de cancelamento. Quem decide na
hora de escrever no estado é um bilhete sequencial.

### Permissões — nada foi ampliado

`ADMIN` e `DISPATCHER`, a mesma decisão da `CTO-3.1`. `TECHNICIAN` fora.
`CONNECT`, `MOVE` e `DISCONNECT` seguem como a `CTO-2` os entregou.

`/ctos/[id]` continua sendo de `ADMIN`, e por isso o botão **Abrir CTO** não é
oferecido ao `DISPATCHER`: um botão que redireciona sem explicação é pior que a
ausência dele. Isso é apresentação — quem barra continua sendo a página, e digitar
a URL termina no mesmo redirecionamento.

### O que as sabotagens mediram

| | mutação | quem caiu |
|---|---|---|
| `S1` | bbox fora da leitura do viewport | `UI-MAP-04` |
| `S2` | resposta antiga pode substituir a nova | `UI-MAP-06`, `UI-MAP-06b` |
| `S3` | precedência `DAMAGED`/`FULL` trocada | `MAP-14` |
| `S4` | CTO sem coordenada exibida em `0,0` | `SEARCH-06`, `06b`, `06c` |
| `S5` | `companyId` fora do predicado da busca | `SEARCH-03`, `03b`, `03c` + o teste da consulta |
| `S6` | URL de tile escrita no componente | o teste estrutural de configuração |
| `S7` | erro da API tratado como lista vazia | `UI-MAP-18` — **e só ele** |

**Sete de sete caíram de primeira**, e isso é consequência direta das duas que
PASSARAM na `CTO-3.1`: as lições de lá — afirmar sobre a **consulta**, e exercitar
o domínio além da rota — foram aplicadas ao escrever, em vez de depois de uma
sabotagem denunciar a lacuna.

Duas medições valem mais que o placar.

**`S7` tem UM detector, e é de navegador.** Nenhum teste de unidade alcança o
caminho de erro da tela. Fica como risco declarado: desativado o spec do mapa, a
distinção entre *"falhou"* e *"não há caixas aqui"* fica sem guarda.

**`S2` cai no Vitest e NÃO no navegador** — medido, não suposto. Com a guarda
desativada, o spec do mapa continua verde, porque o `AbortController` rejeita a
leitura anterior antes de ela chegar. No navegador o bilhete é, portanto, **defesa
em profundidade atrás do aborto**, e não o mecanismo principal; os testes de
unidade são os detectores reais. O comentário do código foi corrigido para dizer
isso.

### O placeholder que o enunciado citava está no FIELD

*"Mapa Operacional — EM BREVE"* existe em `apps/field/lib/app/widgets/app_drawer.dart`,
com `route == null`, e **a web não tinha entrada de mapa nenhuma**. Esta fase é
web e `zero Dart`, então o item do Field fica como está: o mapa dele é outra
fatia (§339, onde a proximidade **ordena a lista** e não desenha mapa).

### O que continua fora

Camadas de técnico, cliente e OS; `TechnicianLocation`; GPS do técnico e
proximidade no Field; edição, confirmação e histórico de coordenada (`CTO-3.4`);
agrupamento; heatmap; rotas; FiberMap; QR; falha coletiva; OLT/SNMP.

> **`CTO-3.2` — `READY FOR OWNER VALIDATION`.** `CTO-2` continua `DONE`,
> `CTO-3.0` `DISCOVERY DONE`, `CTO-3.1` `APPROVED`. `3.3` e `3.4` seguem sob a
> §119.

## 36. `CTO-3.2.1` — Operational Map V1: bases, marcador e estado de navegação

A validação da `CTO-3.2` foi **suspensa** pelo dono a um passo do fim: o mapa
abriu, o Leaflet funcionou, a busca achou a `CTO QA FIELD 01` — e um defeito de
UX apareceu junto com três melhorias aprovadas para a primeira versão.

**Zero migration, zero schema, zero Prisma, zero Dart, zero dependência nova.**

### O defeito que o dono encontrou

```text
Mapa Operacional → Abrir CTO → Voltar   →   CTOs
```

Do ponto de vista de quem opera, o sistema **perdia o lugar onde ele estava**. A
listagem não tem o bairro, não tem o zoom, não tem a caixa em destaque.

**Não é `router.back()`.** Ele responde *"a página anterior do navegador"*, e essa
não é a mesma pergunta que *"de onde este fluxo veio"*: `F5` no detalhe, link
colado, aba nova e um `back` depois de três navegações produzem históricos
diferentes, e em todos eles o botão precisa continuar dizendo a mesma coisa.

A origem é **explícita** e viaja na URL, estendendo a allowlist que já existia
(`src/lib/return-to.ts`, `docs/SECURITY.md` §8.11) em vez de criar um segundo
mecanismo. E ela entra como **caminho puro**: a vista viaja em parâmetros
próprios, cada um validado, e o destino é **remontado** a partir do que passou —
nada do que o cliente escreveu é ecoado na `href`.

O compilador cobrou a decisão na tela de cliente, onde um `else` silencioso
trataria a origem nova como se fosse uma OS.

### Três bases, um mapa

```text
NORMAL      OpenStreetMap
SATELLITE   Esri World Imagery
HYBRID      a imagem do satélite  +  rótulos da CARTO por cima
```

**Um `MapContainer` só.** Trocar de modo troca o `TileLayer`; remontar o mapa
jogaria fora centro e zoom a cada clique no controle — o oposto do que a fase
existe para consertar.

**Os dois provedores novos foram testados ao vivo antes de virarem padrão.** O
Esri responde `200 image/jpeg` com imagem real; a camada `dark_only_labels` da
CARTO responde `200 image/png` com rótulos reais numa área urbana e tile
praticamente vazio no oceano, que é o comportamento correto de uma camada de
rótulos. A variante `dark` é a de texto **claro** — a legível sobre imagem
escura.

**Repare na ordem dos segmentos do satélite: `{z}/{y}/{x}`.** O Esri publica
linha antes de coluna. Escrever na ordem habitual devolve tiles de outro lugar
do planeta — o pior tipo de defeito, porque o mapa carrega, parece funcionar e
mostra a cidade errada. Medido, não suposto.

> **O aviso do OSM vale para os dois, e com mais força para o satélite.** Os
> termos do ArcGIS Online não são contrato de produção para um SaaS comercial.
> Antes de produção: `MAP_TILE_SATELLITE_URL` para provedor contratado ou imagem
> própria. Nenhuma linha de código muda.

**Sem satélite o mapa continua inteiro.** `MAP_SATELLITE_ENABLED=false` remove os
dois modos — o híbrido cai por consequência, porque ele **é** o satélite com
rótulos — e o que se perde é um botão. Um botão que responde com mapa cinza é
pior que a ausência dele, a mesma escolha do "Abrir CTO" ausente para o
`DISPATCHER`.

### A CSP acompanha, e nunca por curinga

As três origens saem de `tileImageSources`, derivadas da mesma configuração.
Desligar o satélite **encolhe** a política sozinho. `img-src *` resolveria o
sintoma e destruiria a política: qualquer host da internet passaria a entregar
imagem para dentro da aplicação.

O `{s}` de subdomínio vira `https://*.basemaps.cartocdn.com` — curinga **preso ao
domínio configurado**, nunca `https:` solto.

### O marcador é uma caixa óptica

O alfinete genérico diz *"tem alguma coisa aqui"*. Num mapa que vai receber
técnico, cliente e OS, isso é exatamente a informação que não serve: quatro
camadas de alfinete são quatro camadas indistinguíveis.

SVG escrito à mão, **sem dependência** — não há biblioteca de ícone no projeto, e
trazer uma para desenhar um retângulo com pontinhos seria superfície de terceiro
em troca de nada. Cores por token, e sombra projetada porque sobre imagem de
satélite não existe fundo previsível.

A silhueta é **idêntica nos quatro estados** — ela é a identidade da CTO. O que
muda é o **selo**, e ele carrega forma **e** glifo:

```text
AVAILABLE  círculo    +
FULL       quadrado   0
DAMAGED    triângulo  !
INACTIVE   losango    ×
```

A legenda mostra o selo, e não redesenha a caixa: o que não varia não precisa de
legenda.

### A vista vive na URL

```text
lat lng z    onde o mapa está
mode         qual base está desenhada
q            o que estava digitado na busca
sel          qual caixa estava selecionada
```

Memória de componente morre na navegação — exatamente quando precisaria
sobreviver. A URL atravessa `F5`, aba nova, link colado e o botão do navegador, e
é o único lugar que o servidor consegue ler ao renderizar a página de destino.

**Marcador nenhum entra ali, e nenhum DTO.** A URL é o endereço de uma vista, não
um cache.

`history.replaceState`, e não `router.replace`: o roteador trataria cada arrasto
como navegação e refaria a consulta do servidor. `replace` e não `push`, senão
cada pan viraria entrada de histórico e o botão voltar levaria trinta cliques
para sair do mapa.

### Dois defeitos que só o navegador encontrou

**O primeiro:** `replaceState(null, ...)` **apaga o estado de roteamento do
App Router**, que ele guarda em `history.state`. O sintoma foi um link que
simplesmente não fazia nada — a URL continuava em `/mapa`, sem erro no console.
A correção é repassar `window.history.state`.

**O segundo, e o mais interessante: um laço de realimentação fechado.** A vista
viajava para os marcadores como prop, então mudava a cada micro-movimento da
câmera; isso re-renderizava o popup; o react-leaflet o atualizava; o `autoPan` do
Leaflet movia o mapa para caber; e o `moveend` mudava a prop de novo. O console
dizia `Maximum update depth exceeded` e **o popup parava de abrir**.

Dois cortes, e os dois são necessários: a `href` passou a ler a barra de
endereço, que a camada já mantém em dia, de modo que os marcadores não dependem
mais da câmera; e `CtoMarkers` virou `memo`, para que um render causado pela
câmera pare ali — o que exige um array vazio estável e um `onReady` estável para
valer de fato.

**Limite declarado:** abrir o popup e **arrastar** o mapa sem fechá-lo deixa a
`href` com a vista de antes do arrasto, e a volta cai alguns metros ao lado.
Fechar essa fresta custaria interceptar o clique, o que tiraria do link o "abrir
em nova aba" que ele hoje tem de graça.

### O que as sabotagens mediram

| | mutação | quem caiu |
|---|---|---|
| `S1` | URL de tile escrita no componente | o teste estrutural de configuração |
| `S2` | host do satélite fora da CSP | `MAPUX-06` + 2 |
| `S3` | marcador trocado por alfinete genérico | `MAPUX-07`, `08`, `09`, `10`, `11`, `S4`, `S4b` |
| `S4` | estado só por cor (glifo removido) | `MAPUX-08..11` + `S4` |
| `S5` | retorno do mapa apontando para `/ctos` | `NAVMAP-01`, `NAVMAP-09c` |
| `S6` | zoom não preservado | `NAVMAP-01/04..08` (navegador) |
| `S7` | preferência de base não gravada | `MAPUX-04` (navegador) |
| `S8` | URL crua do cliente como destino de volta | `NAVMAP-01`, `09`, `09b` |

**Oito de oito.** E o `S4` cobrou um teste fraco meu antes de cair inteiro: o
glifo do `FULL` é `"0"`, e `viewBox="0 0 40 40"` já contém um zero — o
`toContain(glyph)` passava com o `<text>` removido. A asserção passou a ler o nó
de texto, e aí os cinco detectores caem.

### Decisão já aprovada para a `CTO-3.2.2` — registrada, NÃO implementada

```text
☑ CTOs             ligada por padrão
☑ OS abertas       ligada por padrão
☐ Clientes         desligada por padrão
```

Cliente com OS aberta aparece destacado; a CTO poderá exibir selo com a
quantidade de OS abertas ligadas aos clientes dela; e a busca passa a alcançar
CTO, cliente e número de OS. **Nada disso existe em código**, e o motor continua
sem registro de camadas, sem seletor e sem interface `MapLayer` — hoje há uma
camada, e inventar o mecanismo de composição antes da segunda escolheria uma
forma sem caso real para validá-la.

O FiberMap segue `FUTURO`, e cabo, poste e topologia continuam fora (§334).

### Uma divergência de nome, declarada

O enunciado desta fase cita `/mapa-operacional`; a rota que a `CTO-3.2` entregou
e que o dono validou é **`/mapa`**. Ela ficou como está: renomear depois da
validação quebraria links salvos e não muda nada para quem usa. A **superfície**
continua se chamando Mapa Operacional em toda a interface.

### O que continua fora

Camadas de técnico, cliente e OS; `TechnicianLocation`; GPS do técnico e
proximidade no Field; edição, confirmação e histórico de coordenada (`CTO-3.4`);
agrupamento; heatmap; rotas; FiberMap; QR; falha coletiva; OLT/SNMP.

> **`CTO-3.2.1` — `READY FOR OWNER VALIDATION`.** `CTO-2` continua `DONE`,
> `CTO-3.0` `DISCOVERY DONE`, `CTO-3.1` `APPROVED`. `3.3` e `3.4` seguem sob a
> §119, e a `CTO-3.2.2` não começou.

---

## 37. O escopo da `CTO-3.2.2` foi congelado no PRD

A decisão de camadas que a §36 registrou como *"aprovada e não implementada"*
deixou de viver só aqui: ela agora é contrato de produto na **Parte XVI do PRD
(§362–§391)**, junto do resto do escopo do primeiro lançamento.

**O que muda para esta trilha, e não estava escrito antes:**

* **A autoridade de Online/Offline é única, e já existe** — PRD §370. O mapa
  reutiliza `getCustomerDiagnostic` / `CustomerDiagnosticSnapshot`, a mesma que a
  tela da OS usa. Três estados (`ONLINE`, `OFFLINE`, `UNKNOWN`), **sem `STALE`**;
  o que acompanha o estado é a **idade** da leitura.
* **A extração autorizada é uma leitura em LOTE.** A de hoje é de um cliente por
  chamada, e uma camada de mapa faria `N+1`. Ampliar a autoridade existente,
  nunca criar uma segunda.
* **O mapa LÊ; ele não atualiza.** O refresh tem teto de 10 chamadas por minuto
  por empresa (§337) — um mapa que atualizasse por marcador queimaria a cota da
  OS num arrasto.
* **Falha de integração nunca vira `OFFLINE`.** Já é invariante do código, e
  passa a ser invariante escrita do produto.
* **Cliente da CTO vem do VÍNCULO**, nunca de endereço ou proximidade (§372).
* **Contagem de online/offline por CTO é derivada** — nada de
  `cto.onlineCount` (§372).

O sequenciamento da fatia, com dependências, entregas, testes e risco, está em
`docs/MASTER-PLAN.md` §3 — incluindo o **portão de discovery** que a
implementação precisa reconfirmar contra o código antes de escrever a primeira
linha.

> **`CTO-3.2.2` — `READY FOR DISCOVERY / IMPLEMENTATION`.** Não iniciada.
> `CTO-3.3` e `CTO-3.4` seguem sob a §119.

---

## 38. `CTO-3.2.1b` — os quatro pontos que a validação do dono levantou

A validação funcional da `CTO-3.2.1` **passou**: mapa, satélite, híbrido,
persistência do modo, preservação do estado, `Mapa → CTO → Mapa`,
`CTOs → CTO → CTOs`, popup e marcador. Quatro problemas de UX ficaram, e esta
fase resolve **somente** eles.

**Zero produto novo, zero migration, zero Prisma, zero Dart, zero dependência.**
O PRD V1 continua `FROZEN`.

### 1. Altura — o mapa comia a página

Com `vh`, a moldura crescia junto com a tela e empurrava busca, contadores e
legenda para fora da primeira dobra; num notebook com barra de tarefas ela nunca
cabia inteira.

```text
celular  380px      tablet   500px
pequeno  440px      desktop  560px
```

**Altura de mapa não é fração de tela**, é uma faixa de leitura: acima de uns
560px ela deixa de acrescentar contexto e só passa a esconder o resto da página.
`100vh` ficou proibido — e a proibição é de **qualquer** unidade de viewport,
porque `60vh` produz o mesmo comportamento, só que mais devagar.

### 2. Zoom — a placa do satélite, medida provedor por provedor

O dono viu tiles com **"Map data not yet available"**. A causa foi medida em três
lugares, buscando quatro tiles vizinhos por nível e comparando os bytes: quando
os quatro são idênticos, não é imagem — é uma placa.

| provedor | São Paulo | cidade média | rural | acima disso |
|---|---|---|---|---|
| `NORMAL` (OSM) | z19 | z19 | z19 | HTTP **400**, 30 B |
| `SATELLITE` (Esri) | z19 | **z18** | **z18** | HTTP **200** + placa |
| `LABELS` (CARTO) | z19 | z20 | z19 | PNG transparente |

**O que torna o satélite traiçoeiro é o `200`.** A placa é um JPEG de 2.521
bytes, byte a byte igual em qualquer região e qualquer zoom — o Leaflet não tem
como saber que aquilo não é imagem, então desenha. Um `404` teria produzido um
buraco visível; um `200` produz uma mentira.

A cura é **`maxNativeZoom` por camada** mais **um `maxZoom` para o mapa**:

```text
NORMAL     maxNativeZoom 19
SATELLITE  maxNativeZoom 18     ← o PIOR caso medido, de propósito
LABELS     maxNativeZoom 19
mapa       maxZoom       20     ← um nível de ampliação acima do mais restritivo
```

Acima do nativo o Leaflet **amplia o último nível real** em vez de pedir um que
não existe. Adotar 19 no satélite devolveria a placa para a maior parte do país;
adotar 18 custa um nível de nitidez nas capitais. **Um defeito é cosmético; o
outro faz o mapa afirmar que não há dado onde há.**

> **Esconder a placa com CSS teria sido o oposto:** o tile continuaria sendo
> pedido, a banda continuaria sendo gasta, e o mapa mentiria em silêncio.

O híbrido não precisa de regra própria: cada camada amplia a partir do próprio
nativo, e **nenhuma quebra enquanto a outra continua** — que é o que o
enunciado exigia.

### 3. Enquadramento inicial

`fitBounds` sobre um retângulo de área zero — uma caixa só, ou várias no mesmo
poste — ia ao zoom máximo, e o operador abria o mapa olhando uma calçada. O teto
passou de `z16` para **`z17`**: a caixa, a rua dela e as quadras em volta.

### 4. O marcador — de teclado para caixa óptica

A primeira versão desenhava as portas como **duas fileiras de três pontos**.
Funcionava, e o dono a recusou pelo motivo certo: no tamanho real aquilo lê como
teclado ou calculadora.

```text
   ╭─────────────╮ ◀ tampa, com a linha de fecho
   │ ▌▌▌▌▌▌      │ ◀ régua de portas — traços verticais, contíguos
   ╰──────┬──────╯
          │        ◀ prensa-cabo e a descida da fibra
```

**A contiguidade é o ponto.** Portas ópticas ficam enfileiradas numa bandeja, e
traços lado a lado leem como conector; pontos espalhados leem como botão. O
**prensa-cabo** é o que remove a leitura de "roteador" ou "caixa de luz".

O estado continua no **selo**, com forma **e** glifo, e a silhueta é idêntica nos
quatro — ela é a identidade da CTO, não o estado dela.

### 5. "Abrir CTO" — o defeito era de ESPECIFICIDADE

```text
leaflet.css:264   .leaflet-container a { color: #0078A8 }   (0,1,1)
Tailwind          .text-primary-fg                          (0,1,0)
```

A regra do Leaflet vence. O texto do botão saía `#0078A8` sobre o `#2563eb` do
`bg-primary` — **azul sobre azul, contraste de 1,05:1**, medido no navegador.

**Nenhuma asserção existente pegaria isso**: o elemento estava lá, com o texto
certo, no lugar certo, visível. É a `CTO-1.5` de novo, com outra causa — lá uma
classe Tailwind inexistente, aqui uma regra de terceiro vencendo por
especificidade. A correção usa os **mesmos tokens** `primary`, numa regra
específica o bastante para o design system voltar a decidir dentro do mapa.

O teste que fecha isso **calcula o contraste WCAG** a partir do
`getComputedStyle`, nos dois temas. Ele reproduz o número exato do defeito:
`contraste 1.05:1 entre rgb(0, 120, 168) e rgb(37, 99, 235)`.

### Uma regressão de bundle, pega pelo teste da fase anterior

Ao centralizar as constantes de zoom, `MapCanvas` passou a importar **valor** de
`map-config` — que importa `prisma`. É o defeito da `DQ-4`, que custou a página
de login inteira, renascendo um commit depois de ser prevenido.

O teste estrutural escrito na `CTO-3.2` pegou no mesmo dia. As constantes
passaram a vir do `.mjs` puro.

### O que as sabotagens mediram

| | mutação | quem caiu |
|---|---|---|
| `S1` | limite de altura removido | `UXP-01`, `UXP-03` |
| `S2` | altura vira `100vh` | `UXP-01/02/03` + os quatro de navegador |
| `S3` | satélite acima da política | `UXP-05`, `05b`, `06`, `06b` |
| `S4` | marcador antigo restaurado | `MAPUX-07`, `UXP-09`, `09b`, `10` |
| `S5` | representação de portas removida | idem |
| `S6` | botão volta à utility | `UXP-12` estrutural **e** o de contraste |
| `S7` | retorno do mapa apontando para `/ctos` | `NAVMAP-01`, `09c` |
| `S8` | persistência do modo removida | `MAPUX-04` (navegador) |

**Oito de oito.** A mais informativa é a `S6`: o teste de contraste devolveu
`1.05:1` com as cores exatas, que é o defeito do dono reproduzido em número.

### O que NÃO mudou

Contratos de cliente, Online/Offline, OS abertas, camadas futuras, `bbox`,
tenancy, API, domínio da CTO, `CONNECT`/`MOVE`/`DISCONNECT`, `CustomerLocation`,
permissões, schema, Prisma e Dart.

> **`CTO-3.2.1b` — `READY FOR OWNER VALIDATION`.** `CTO-2` continua `DONE`,
> `CTO-3.0` `DISCOVERY DONE`, `CTO-3.1` `APPROVED`, o PRD V1 `FROZEN`. A
> `CTO-3.2.2` não começou.

---

## 39. `CTO-3.2.1c` — o nome por cima da caixa, e o marcador que faltava

A validação da `CTO-3.2.1b` **passou** no resto: altura, zoom, as três bases,
retorno ao mapa, popup, botão "Abrir CTO" e persistência do modo. Ficaram dois
pontos, e esta microfase resolve **somente** eles.

**Zero produto novo, zero migration, zero Prisma, zero Dart, zero dependência.**
O PRD V1 continua `FROZEN`.

### 1. A plaqueta com o nome da CTO

O pedido do dono foi literal: *"o nome da CTO deve aparecer por cima dela no
mapa"*. Sem clicar — e apontar também não vale, porque dica que aparece no
`mouseover` é dica passageira.

Ela é um **`Tooltip` `permanent`** do react-leaflet, com `direction="top"`. A
palavra `permanent` é o contrato inteiro: o Leaflet abre o rótulo junto com o
marcador, mantém, e deixa de fechá-lo no `preclick` — clicar no mapa não apaga
mais nada.

```text
   ╭──────────────────╮
   │ CTO BAIRRO ALTO  │  ◀ plaqueta: tokens do popup, cauda repintada
   ╰────────┬─────────╯
            ▼            ◀ a cauda é o conector; sem ela a plaqueta flutua
        [ caixa ]
```

**O texto NÃO entra no `divIcon`, e essa é a decisão de segurança da fase.**
`divIcon` recebe HTML cru e o injeta no DOM, e nome de caixa é digitado por
gente. O `Tooltip` renderiza os filhos por **portal do React**, que escapa
texto: uma caixa batizada de `<img src=x onerror=…>` aparece com esse nome
escrito. Injetar o mesmo texto no ícone economizaria um elemento no DOM e
abriria uma porta de HTML cru para dado de usuário.

**Tokens do popup, e não paleta nova.** A plaqueta flutua sobre imagem que não é
nossa — mapa claro, satélite escuro, telhado, laje, mata. Ela usa `surface` com
`fg`, exatamente o que o popup já usa, e o popup já foi validado pelo dono sobre
as três bases.

**Opaca, e isso é medição — não preferência.** O enunciado preferia fundo
semitransparente. Com alfa, o contraste do texto passa a depender do pixel do
tile atrás, e deixa de existir um número para afirmar. Opaca, o teste calcula a
razão da WCAG a partir do `getComputedStyle` e ela vale igual sobre asfalto e
sobre telhado.

### 2. A política de densidade — medida, porque não havia dado

Antes de "mostrar sempre todos os nomes", o enunciado mandou medir o impacto. E
aqui a primeira coisa honesta a dizer é que **não havia densidade real para
observar**: o banco de desenvolvimento tem **uma** caixa com coordenada. O que
existe é aritmética de projeção — no Web Mercator um pixel vale
`156543,03 · cos(latitude) / 2^zoom` metros, e duas plaquetas de 112px colidem
quando a distância entre as caixas rende menos que isso na tela.

| distância entre caixas | zoom mínimo para NÃO colidir |
|---|---|
| 40 m | z18,6 |
| 80 m | z17,6 |
| **150 m** | **z16,7** |
| **300 m** | **z15,7** |
| 600 m | z14,7 |

Uma CTO de 8 a 16 portas cobre aproximadamente uma quadra, o que põe a rede
urbana típica entre 100 e 300 m. Adotado: **`MAP_LABEL_MIN_ZOOM = 16`**.

```text
z16   a tela cobre ~1,8 km — vizinhança inteira, plaquetas separadas
z14   duas caixas a 300 m ficam a 34px: parede de texto sobre a cidade
z17   nítido, e obrigaria a aproximar mais do que o operador precisa
```

**Duas cláusulas, e nada além** — o enunciado pediu a menor solução que atenda
sem destruir a legibilidade:

1. no zoom operacional (`≥ 16`), **todas** as caixas do recorte mostram o nome;
2. a caixa **selecionada** mostra o nome em **qualquer** zoom.

A segunda é o que torna a primeira usável: quem achou uma CTO na busca, ou
voltou de uma com `sel=` na URL, precisa saber qual mancha do mapa é a dela.

**O que este número NÃO resolve, declarado:** ele não evita colisão, evita a
**parede**. Duas caixas a 40 m continuam com as plaquetas encostadas em `z16`, e
a saída é aproximar. Esconder rótulo por sobreposição foi **recusado de
propósito** — seria uma regra que o operador não consegue prever, com o nome
sumindo sem que ele tenha feito nada.

### 3. Um BOOLEANO atravessa a fronteira, e nunca o zoom

Esta é a parte que a `CTO-3.2.1` já pagou uma vez. Uma prop derivada da câmera
chegando aos marcadores fecha o laço `popup → autoPan → moveend → render`, que
custou `Maximum update depth exceeded` e o popup **parando de abrir**.

```text
zoom (número)     muda a cada micro-movimento  →  o laço volta
showLabels (bool) muda só ao CRUZAR o limiar   →  o memo bloqueia o resto
```

Arrastar o mapa a `z18` não re-renderiza marcador nenhum. `ML-DENS-03` fixa isso
estruturalmente, porque é o tipo de regressão que reaparece na primeira
refatoração que "simplifica" a prop.

### 4. O marcador — a proporção era o defeito, não a falta de detalhe

A versão da `CTO-3.2.1b` já tinha corpo, tampa, régua de portas e prensa-cabo, e
o dono ainda a recusou. O diagnóstico não é "faltava detalhe": o corpo media
**29 × 21**, ou seja **deitado**, e caixa deitada com uma faixa dentro lê como
aparelho de mesa.

```text
    ╭─────╮      ◀ cúpula quase semicircular (raio 8,5 numa largura 20)
   │       │
   │───█───│     ◀ costura da tampa, com o fecho montado sobre ela
   │ ┌───┐ │
   │ │▌▌▌▌│ │    ◀ bandeja com QUATRO adaptadores
   ╰───────╯
    ▬▬▬▬▬        ◀ placa de prensa-cabos, tucada sob a caixa
       │╰        ◀ tronco reto até o poste, drop saindo em curva
```

| pedido do dono | resposta |
|---|---|
| "corpo principal mais convincente" | proporção **em pé**, 20 × 27 |
| "silhueta menos genérica" | cúpula de raio 8,5 num corpo de largura 20 |
| "frente/tampa melhor resolvida" | costura com o **fecho** sobre ela |
| "portas ópticas mais críveis" | **quatro** adaptadores, não seis |
| "entrada/saída de cabo" | placa única, tronco **reto**, drop em **curva** |

**Seis portas viraram quatro por medição, não por gosto.** Num corpo desta
largura, seis traços ficam a 2,6px um do outro no tamanho real e se fundem num
borrão cinza — que é exatamente o que fazia a bandeja ler como grade de
radiador. O ícone não precisa contar portas: o número real está no popup.

**A curva da drop é a peça mais telecom do desenho.** Fibra nunca corre em
ângulo reto; ela sai fazendo raio. Duas retas paralelas seriam dois fios
quaisquer — uma reta e uma curva são um tronco e uma derivação.

#### Duas tentativas foram DESCARTADAS nesta mesma fase

E ficam registradas, porque são o tipo de ideia que volta:

* **orelhas de fixação** nas laterais, para quebrar a silhueta genérica. Vistas
  a 5×, leem como **pés** — e, pior, somavam largura justamente onde a fase
  tentava estreitar: o conjunto voltava a ficar mais largo que alto, anulando a
  única mudança que importava;
* **dois prensa-cabos separados** sob a caixa, pelo mesmo motivo: dois blocos
  pequenos embaixo leem como pés. Viraram uma placa só, estreita e tucada.

As duas foram encontradas **olhando o desenho renderizado a 5× e a 8×**, não por
inspeção de código. Um marcador é uma peça visual, e a única forma de reprovar
um desenho é olhar para ele.

### 5. A geometria virou DADO

`CTO_MARKER_GEOMETRY` é exportada, e o SVG é montado a partir dela. Antes o teste
extraía coordenadas do SVG com expressão regular — e quando o corpo virou
`<path>` por causa da cúpula, a `UXP-09b` quebrou **sem que nada estivesse
errado**. Pior ainda seria o caso simétrico: uma regex que continua passando por
casar com outro trecho.

Com a geometria exportada, *"a bandeja está dentro do corpo?"* vira aritmética
sobre a **mesma** fonte que desenha. Não existe segunda cópia das coordenadas
para divergir.

E a `ML-06` tem dentes de propósito: *"mais alta que larga"* aprovaria a versão
24 × 24,5 que esta própria fase descartou, então a asserção exige **um quarto a
mais de altura**, raio de cúpula perto da metade da largura, placa mais estreita
que o corpo, e tronco reto contra drop curva.

### O que as sabotagens mediram

| | mutação | quem caiu |
|---|---|---|
| `S1` | plaqueta removida | `ML-01`, `ML-02`, `ML-05`, `ML-DENS-04` |
| `S2` | plaqueta abaixo do marcador | `ML-01` **e** `ML-04` no navegador |
| `S2b` | `tooltipAnchor` zerado | `ML-04` |
| `S3` | corpo volta a ser deitado | `ML-06` |
| `S4` | régua de portas removida | `UXP-09`, `UXP-10`, `MAPUX-07`, `ML-07` |
| `S5` | preferência de base não gravada | `MAPUX-04` — e `ML-09` **só depois de corrigido** |
| `S6` | retorno apontando para `/ctos` | `NAVMAP-01`, `ML-10` |
| `S7` | limiar vira `true` | `ML-DENS-03` **e** `ML-DENS-05` no navegador |
| `S8` | plaqueta sem token de cor | `ML-03` |
| `S9` | plaqueta aceitando ponteiro | `ML-05` |

**Dez de dez** — e a `S5` é a mais informativa, porque **passou** na primeira
rodada. A razão é boa: a `ML-09` recarregava uma URL que já carregava
`mode=HYBRID`, porque a vista se espelha na barra de endereço, então o modo
voltava da URL e a preferência do aparelho nunca era consultada. Um teste com o
nome *"a persistência não regrediu"* cobrindo metade do assunto é pior que a
ausência dele. Ele passou a entrar também pela porta **sem query**, e a queda foi
provada nos dois sentidos.

### O que NÃO mudou

`bbox`, API de mapa, DTOs, política de zoom, altura do mapa, tenancy, contrato do
popup, navegação, persistência, permissões, domínio da CTO,
`CONNECT`/`MOVE`/`DISCONNECT`, schema, Prisma e Dart. Nenhuma camada de cliente,
de OS aberta ou de Online/Offline foi iniciada.

> **`CTO-3.2.1c` — `READY FOR OWNER VALIDATION`.** `CTO-2` continua `DONE`,
> `CTO-3.0` `DISCOVERY DONE`, `CTO-3.1` `APPROVED`, o PRD V1 `FROZEN`. A
> `CTO-3.2.2` não começou.

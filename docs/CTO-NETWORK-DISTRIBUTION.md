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
FiberMap no AlfaOS      integração FUTURO (PRD §107, §2650)
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

O enum permanece `FIELD · WEB · IMPORT` conceitualmente. A `CTO-2` implementa
**`FIELD`**, e só. `WEB` e `IMPORT` ficam reservados: **não se cria endpoint
porque o enum tem o valor** — um caminho de escrita sem caso de uso é superfície
de ataque sem dono.

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

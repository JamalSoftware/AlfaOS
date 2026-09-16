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
CAPABILITY_LIMIT (padrão)              10 por 60 s, por USUÁRIO dentro da empresa
```

> **Correção (13/09/2026, `DIAG-RATE-01`).** Na descoberta inicial isto foi
> registrado como **"10 por 60 s, POR EMPRESA"** — leitura errada da chave do
> balde. A implementação auditada (v0.7.x, RATE-01) e a decisão final do dono
> usam `(companyId, userId, capability)`: um operador não consome a cota dos
> colegas. As conclusões abaixo continuam valendo para a tela de quem atualiza.

Uma CTO de 8 portas consumiria **8 das 10** atualizações de quem a abriu no
minuto. Duas CTOs abertas em sequência estouram o limite dessa pessoa e a
segunda vem `UNKNOWN` — não por falha de rede, mas pela própria tela.

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

* **`C-03`** — o teto de 10 chamadas por minuto (por usuário, dentro da
  empresa) serve à CTO, ou a capability precisa de limite próprio? A pergunta só ganha consequência quando
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
  por usuário, dentro da empresa (§337, §370) — um mapa que atualizasse por
  marcador queimaria, num arrasto, a cota de que a OS de quem arrastou precisa.
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

### 6. Delta do dono: o CORPO da caixa passou a carregar o estado

Uma decisão visual não tinha ficado evidenciada, e o dono a nomeou depois da
primeira leitura desta fase: **o estado não pode viver só no selo.**

O argumento é de leitura à distância. O selo tem 14 unidades num ícone de 38
pixels; num mapa com dezenas de marcadores, o que se enxerga primeiro é a
**silhueta**, não o adesivo no canto dela.

```text
AVAILABLE   contorno verde     selo ● "+"
FULL        contorno âmbar     selo ■ "0"
DAMAGED     contorno vermelho  selo ▲ "!"
INACTIVE    contorno cinza     selo ◆ "×"   + figura apagada + "INATIVA"
```

**O contorno usa o MESMO token do selo** — `success-fg`, `warning-fg`,
`danger-fg`, `neutral-fg`. Não é economia de código: é o que impede o contorno e
o selo de discordarem. Um token próprio para o contorno criaria **duas fontes de
verdade para a mesma pergunta**, e a que divergisse seria a que ninguém revisou,
porque isoladas as duas parecem certas. É a mesma razão de `summarizePortCounts`
ser uma função só.

O traço subiu de `2` para `2.4`: o contorno deixou de ser delimitação de desenho
e virou **informação**, e precisa sobreviver a vegetação, telhado e asfalto.

#### A inativa apaga a FIGURA, e nunca o selo

Por isso o desenho passou a viver num grupo próprio, `cto-box__figure`, com o
selo **fora** dele. Apagar o marcador inteiro levaria o selo junto — e uma caixa
desbotada **sem** selo esconde justamente o motivo de ela estar desbotada.

São quatro sinais, e nenhum deles é cor sozinha:

1. a figura dessatura (`grayscale`) e perde opacidade (`0.55`);
2. o contorno vira cinza e **tracejado** — sinal exclusivo dela;
3. o selo continua cheio, losango com `×`;
4. a plaqueta escreve **INATIVA**.

**O quarto existe porque o dono nomeou a ambiguidade:** *"apagado"* é vocabulário
de controle que a **interface** desabilitou, e aqui significa um fato da rede — a
caixa saiu de operação. Só o texto desfaz isso. E **só** a inativa o recebe:
escrever o estado em toda plaqueta transformaria o mapa numa lista de palavras,
já que nos outros três o contorno e o selo bastam.

O termo vem de `apresentacao.label`, a **mesma** tabela que nomeia o estado no
popup e na legenda, em versalete por `.toUpperCase()`. **O nome armazenado da CTO
não é tocado** — isto é apresentação derivada do status.

#### Seleção e estado são DUAS camadas

```text
halo externo ao ícone ....... seleção   (outline, cor de foco)
contorno do corpo ........... estado    (stroke, cor do estado)
```

Uma caixa danificada e selecionada mostra as duas ao mesmo tempo. Se a seleção
pintasse o corpo, **clicar apagaria a informação que fez alguém clicar**. O
`outline` vive no elemento SVG inteiro, fora do desenho, e por construção não tem
como colidir com o traço do corpo.

#### O que as sabotagens do delta mediram

| | mutação | quem caiu |
|---|---|---|
| `V1` | contorno volta ao traço neutro | `STATUSVIS-01/02/03` (estrutural **e** navegador) |
| `V2` | dois estados dividem a mesma cor | `STATUSVIS-01/02/03` |
| `V3` | traço afina para 1 | `STATUSVIS-01/02/03b` |
| `V4` | a inativa deixa de apagar | `STATUSVIS-04` (nos dois) |
| `V5` | o apagamento pega o marcador inteiro | `STATUSVIS-04` |
| `V6` | a plaqueta perde "INATIVA" | `STATUSVIS-05` |
| `V7` | a seleção pinta o corpo | `STATUSVIS-06` (nos dois) |
| `V8` | a figura deixa de ser grupo próprio | `STATUSVIS-04` |
| `V9` | a inativa perde o tracejado | `STATUSVIS-07` |
| `V10` | todas as plaquetas escrevem o estado | `STATUSVIS-05` (nos dois) |

**Dez de dez** — e a `V5` **passou no navegador** na primeira rodada, por um
motivo que vale mais que o placar: `opacity` **não é herdada, ela COMPÕE**. Lendo
`getComputedStyle(selo).opacity` o valor é `1` mesmo enquanto um ancestral apaga o
selo na tela, então a asserção afirmava algo que não tinha como enxergar. Ela
passou a **multiplicar a opacidade do selo até o `svg`**, que é a pergunta certa:
*quanto disto chega aos olhos?* O detector estrutural já pegava a `V5`, então nada
saiu descoberto — mas uma asserção de navegador que afirma o que não mede é pior
que a ausência dela, porque parece prova.

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

---

## 40. `CTO-3.2.1d` — o ADMIN corrige a posição da CTO pelo mapa

A validação em uso real da `CTO-3.2.1c` passou em tudo — bases, zoom, plaqueta,
marcador, contorno de estado, popup, navegação. E produziu uma necessidade nova:
**o dono viu uma coordenada errada e não tinha como corrigi-la de onde estava
olhando.**

Decisão de produto sincronizada antes de qualquer linha de produção — PRD §377,
`DECISION UPDATED`, registrada também na §390. **Zero migration, zero alteração
de schema, zero Dart, zero dependência.**

### 1. O achado que define a fase: a rota já existia

A regra do enunciado era não criar uma segunda implementação de escrita de
coordenada. Ao inventariar o caminho que a tela de detalhe usa, a conclusão foi
mais forte que "dá para reaproveitar":

```text
PATCH /api/ctos/[id]
  assertSameOrigin ................ CSRF
  requireCtoAccess ................ capability ANTES do perfil, e perfil = ADMIN
  zod .strict() ................... campo extra é 400
  updateCto
    findFirst({ id, companyId }) .. tenant na leitura
    assertCoordinates ............. finitude, faixa, par completo
    compara com o gravado ......... só o que mudou entra em `data`
    updateMany({ id, companyId }) . tenant na escrita
    logAuditWithin ................ CTO.UPDATED
```

**Mandar só `{ latitude, longitude }` JÁ É a operação estreita.** `updateCto`
monta `data` campo a campo a partir do que chegou, então nome, capacidade,
estado e observações não são sequer lidos — não existe como sobrescrevê-los por
acidente.

Uma rota `/location` própria teria criado uma segunda autoridade sobre a mesma
regra de coordenada. A `CTO-1.6` já pagou por isso: rota e domínio conheciam a
faixa `-90..90` ao mesmo tempo, e quem falava era a que tinha menos a dizer.

### 2. "Arrastou" e "salvou" são coisas diferentes

```text
visualização → Ajustar posição → modo de edição → arrastar → Salvar / Cancelar
```

Num mapa a mão está sempre arrastando alguma coisa. Se soltar o marcador
gravasse, uma coordenada certa viraria errada sem que ninguém tivesse pedido e
sem nada na tela para desfazer. Por isso **o marcador não é arrastável por
padrão** — só a caixa cuja edição foi declarada, e só enquanto durar.

**Cancelar é confiável depois de quantos arrastos forem**, e não por esforço: o
par gravado nunca é tocado. O rascunho simplesmente deixa de existir, e a posição
volta a ser lida da origem. Não há nada a desfazer.

### 3. Duas medições que mudaram a implementação

**O painel empurrava o mapa 206 pixels.** Renderizado no fluxo da página, acima
do mapa, entrar em modo de edição descia o mapa — ou seja, o mapa saltava
debaixo da mão exatamente no instante em que a pessoa vai arrastar com precisão.
Somado aos **138px** que o `autoPan` do popup já desloca ao abrir, a caixa que se
quer mover mudava de lugar duas vezes antes do primeiro arrasto. O painel passou
a ser ancorado **dentro** do mapa, e `MAPEDIT-04b` mede a moldura para que não
volte.

Os 138px do `autoPan` também corrigiram um teste meu: uma referência de posição
tirada antes do clique comparava dois enquadramentos diferentes, e o teste
acusava o Cancelar de não restaurar quando quem se movera fora o mapa.

### 4. `dragend`, e nunca `drag`

`drag` dispara por quadro. Como a posição do marcador é uma prop, atualizá-la a
cada quadro re-renderizaria todos os marcadores dezenas de vezes por segundo — e
é exatamente uma prop mudando durante interação com o mapa que fechou a
realimentação `popup → autoPan → moveend → render` na `CTO-3.2.1`, com o popup
parando de abrir.

**A plaqueta não precisa disso:** o Leaflet move o tooltip junto com o marcador
nativamente, então o nome acompanha em tempo real de graça. Quem espera o fim do
arrasto é o painel de coordenadas, que é lido justamente quando a mão para.

### 5. Três camadas visuais que não disputam nada

```text
contorno do corpo ..... ESTADO       verde · âmbar · vermelho · cinza
halo sólido ........... SELEÇÃO      cor de foco
halo tracejado ........ EDIÇÃO       cor primária + cursor grab
```

Modo de edição **não é estado da rede**: uma CTO disponível continua verde
enquanto está sendo movida. Reaproveitar as cores de estado para dizer "está
sendo arrastada" faria o operador ler mudança de operação onde houve um gesto de
interface.

### 6. Erro ao salvar: o modo de edição CONTINUA

Das duas condutas que o enunciado admitia, esta é a honesta. O marcador fica onde
a mão o deixou, mas o painel segue na tela dizendo "Ajustando posição" com o erro
ao lado — ninguém confunde isso com uma posição salva. Devolver o marcador ao
ponto antigo apagaria o trabalho de quem acabou de posicionar a caixa por causa
de uma falha que pode ser de rede.

E o sucesso não é afirmado por estado local: depois de salvar, a camada **relê o
recorte**. A posição que aparece é a que o servidor devolve.

### 7. Auditoria — a coordenada entra com o VALOR

A regra do módulo é registrar nomes de campo, nunca o conteúdo: uma observação
pode ter parágrafos, possivelmente com dado de cliente. **Ela continua valendo
para todo o resto.**

A coordenada é a exceção, por três razões: são dois números, então não há volume
a vazar; ela não é dado pessoal (é a coordenada da **caixa**, que fica no poste);
e agora que o ADMIN pode arrastá-la, *"as coordenadas mudaram"* não responde a
única pergunta que se faz depois de um arrasto errado, que é **de onde para
onde**. Sem o par anterior, desfazer vira arqueologia.

Nenhuma tabela nova, nenhuma migration: é o mesmo `logAuditWithin`, com o
`details` mais informativo.

### 8. Concorrência — `last-write-wins`, declarado

`updateCto` não tem `version` nem CAS, e esta fase **não introduziu nenhum**. Dois
ADMINs movendo a mesma caixa ao mesmo tempo: vence quem gravar por último, e o
outro não é avisado.

Isso é aceitável e está declarado. A operação é estreita — dois números — e o
efeito de perder a corrida é uma caixa no lugar que o outro escolheu, visível no
mapa e corrigível com outro arrasto. Introduzir CAS aqui criaria conflito onde
não há dano, e transformaria uma microfase num sistema de edição colaborativa.
A trilha de auditoria com o "de → para" é o que torna a sequência reconstruível.

### 9. O subfluxo que NÃO entrou, e por quê

**Definir a posição inicial de uma CTO sem coordenada** ficou como follow-up
pequeno, e o motivo é de contrato, não de esforço.

Uma caixa sem coordenada **não é marcador**: ela não aparece na leitura do
recorte. O único lugar onde ela existe na tela é a busca, cujo DTO tem **cinco
campos** por decisão da `CTO-3.2` — sem `status` e sem `summary`. Um marcador
sintético para ela teria de inventar os dois, ou buscar o detalhe por um caminho
novo, ou alargar o DTO da busca. As três opções são escopo real.

**O backend já está pronto:** `updateCto` aceita passar de `null` para um par, e
`POS` cobre isso. E o caminho existente não sumiu — a tela de detalhe continua
aceitando as coordenadas digitadas. O que falta é só a porta no mapa.

### O que as sabotagens mediram

| | mutação | quem caiu |
|---|---|---|
| `S1` | marcador sempre arrastável | `MAPEDIT-03/04` (estrutural **e** navegador) |
| `S2` | soltar o marcador grava | `MAPEDIT-05/06` |
| `S3` | Cancelar não descarta o rascunho | `MAPEDIT-07` |
| `S4` | perfil deixa de ser verificado | `POS-02`, `POS-03` |
| `S5` | `companyId` fora da escrita | **passou** — ver abaixo |
| `S5b` | `companyId` fora da leitura | **passou** — ver abaixo |
| `S5c` | os DOIS guardas de tenant juntos | `POS-04` |
| `S6` | faixa de latitude não verificada | `POS-05` |
| `S7` | o mapa manda o objeto inteiro | `MAPEDIT-08`, `POS-08b` |
| `S8` | Salvar só mexe na UI | `MAPEDIT-08/14` (navegador) |
| `S9` | a plaqueta some na edição | `MAPEDIT-09`, `ML-DENS-04` |
| `S10` | a edição repinta o corpo | `MAPEDIT-10` |
| `S11` | o painel volta a empurrar o mapa | `MAPEDIT-04b` |
| `S12` | a trilha perde o "de → para" | `POS-AUD-01` |

**`S5` e `S5b` passaram sozinhas, e isso é defesa em profundidade funcionando —
não um buraco.** `updateCto` tem dois guardas de tenant independentes: a leitura
inicial filtra por `companyId`, e a escrita filtra de novo no `updateMany`.
Removendo um, o outro fecha; removendo os **dois** (`S5c`), `POS-04` cai. Ou
seja: cada um é redundante isoladamente, e o par é a garantia. Fica medido em vez
de suposto.

**Duas sabotagens cobraram testes meus antes de caírem.** A `S10` sobrevivia
porque a asserção estrutural olhava só o bloco `.cto-box--editing { … }`, e o
ataque acrescenta um seletor descendente novo; e a asserção de navegador comparava
o contorno antes/depois do **arrasto**, quando os dois valores já vinham
sabotados — comparar dois erros dá igualdade. A referência passou a ser capturada
**antes de entrar em edição**, que é a pergunta certa.

### O que NÃO mudou

`bbox`, API de mapa, DTOs, política de zoom, altura, plaqueta, contorno de
estado, popup, navegação, persistência, permissões de leitura, domínio da CTO,
`CONNECT`/`MOVE`/`DISCONNECT`, schema, Prisma e Dart. Nenhuma camada de cliente,
OS aberta ou Online/Offline foi iniciada. Nenhum ERP é consultado para mover uma
caixa, e nenhuma sincronia com FiberMap foi criada.

### `OWNER VALIDATED / APPROVED`

O dono executou o roteiro na interface real e aprovou. Validado ao vivo:

```text
ADMIN entra em "Ajustar posição"          a CTO pode ser arrastada
Cancelar NÃO persiste                     Salvar persiste
reload mantém a posição nova              Satélite/Híbrido durante o ajuste
nome preservado                           contorno/status preservado
popup preservado                          zoom preservado
modo do mapa preservado
```

O par que mais importa nessa lista é **Cancelar não persiste / Salvar
persiste**: é a separação entre "arrastou" e "salvou" observada fora do teste,
que é onde ela precisava valer.

> **`CTO-3.2.1d` — `OWNER VALIDATED / APPROVED`.** `CTO-2` continua `DONE`,
> `CTO-3.1` `APPROVED`, o PRD V1 `FROZEN` com a §377 atualizada.

---

## 41. `CTO-3.2.2` — clientes ativos, conectividade e OS abertas

**Estado:** `READY FOR OWNER VALIDATION`. Commits locais, sem tag e sem push.
**Migration:** nenhuma. **Prisma:** nenhuma alteração de schema. **Dart:** zero.
**Dependência nova:** nenhuma.

As três camadas que faltavam entram sobre o **mesmo motor** da `CTO-3.2`: não
nasceu uma segunda tela, não nasceu um registro de camadas e não nasceu uma
interface `MapLayer`. O controle de camadas é um bloco de três caixas de
seleção, e cada camada tem a sua própria leitura, o seu próprio
`AbortController` e o seu próprio estado de erro.

### 41.1 Uma autoridade de Online/Offline, amplificada — nunca duplicada

O invariante da §370 do PRD continua sendo o mesmo de antes, e o mapa **lê**:
`CustomerDiagnosticSnapshot` é a fonte, e `getCustomerDiagnostic` continua
sendo a leitura individual. O que a fase acrescentou é
`getConnectivityForCustomers`, uma leitura em **lote** sobre a mesma tabela,
devolvendo o mesmo DTO.

O que tornou isso possível sem criar uma segunda semântica é um fato do código
que precisa ficar registrado: **`getCustomerDiagnostic` é leitura pura de
banco.** Ela não fala com provider nenhum. Se falasse, um lote seria um lote de
chamadas externas, e o teto de 10 por minuto de quem arrasta (por usuário,
dentro da empresa) iria embora no primeiro arrasto.

Três regras seguem valendo palavra por palavra, e cada uma tem detector:

* **ausência de snapshot é `UNKNOWN`, jamais `OFFLINE`** — falha de integração
  é afirmação sobre a integração, nunca sobre o cliente;
* **o mapa não dispara refresh** — abrir, arrastar ou dar zoom não fala com
  ERP nenhum;
* **a empresa que trocou de ERP tem duas linhas por cliente**
  (`@@unique([companyId, customerId, externalProvider])`), e as duas leituras
  — individual e em lote — resolvem por `observedAt desc`.

### 41.2 A OS ABERTA é derivada dos estados TERMINAIS

`OPEN_SERVICE_ORDER_STATUSES` não é uma lista de estados abertos: é a lista dos
**terminais** (`COMPLETED`, `CANCELLED`) subtraída do enum inteiro.

A diferença aparece no dia em que alguém acrescentar um estado à máquina. Com
uma lista de abertos, o estado novo nasceria **fechado** — invisível no mapa,
sem ninguém perceber. Derivando dos terminais, ele nasce **aberto**: aparece
demais, e aparecer demais é um defeito que alguém relata no mesmo dia.

### 41.3 `N+1` medido, não afirmado

O enunciado proibia `for customer: getConnectivity(customer.id)`. A proibição
tem teste que **conta consultas**, e não comentário:

* 40 clientes no recorte → **1** consulta de conectividade;
* 6 CTOs no recorte → **1** consulta de cada tipo;
* lista vazia → **zero** consulta.

O resumo operacional da CTO chegou a custar duas consultas de vínculo, porque
ocupação de porta e contagem por caixa foram escritas separadas. Foram unidas
numa só, devolvendo `{ summaries, occupiedPortIds }` — medido pelo mesmo teste
que reprovou a versão anterior.

### 41.4 O que o mapa NÃO carrega

O DTO do cliente é afirmado por **igualdade de chaves**, não por ausência de
alguns campos: `id`, `name`, `latitude`, `longitude`, `connectivityStatus`,
`connectivityObservedAt`, `openServiceOrderCount`, `cto`. Sem CPF, sem e-mail,
sem financeiro, sem payload de ERP, sem senha de Wi-Fi, sem nota interna, sem
MAC. Um teste que listasse proibidos só pegaria o que alguém já imaginou; a
igualdade pega o campo que ninguém previu.

### 41.5 O `DISPATCHER` não recebe a camada de clientes

Isso é decisão de produto, e ela foi **recusada em silêncio**: ampliar
localização de clientes ao despacho não estava no enunciado, e esconder o botão
não é segurança. A camada é de `ADMIN`, e a rota recusa no **servidor**.

A busca é o caso delicado, porque ela é compartilhada: o `DISPATCHER` busca
CTO e número de OS. Os resultados do tipo `CUSTOMER` são removidos **no
servidor**, antes de a resposta sair — não filtrados na tela.

### 41.6 Dois empates que o navegador decidia por sorteio

Os dois foram achados pela suíte, e nenhum dos dois aparecia como erro: a tela
abria, alguma coisa acontecia, e só quem procurava notava que nem sempre era a
mesma coisa.

**O marcador da OS nasce na coordenada do CLIENTE** — é a única que existe.
Então todo cliente com OS aberta tem o losango exatamente sobre o ponto: mesma
latitude, mesma longitude, mesmo pixel. O Leaflet deriva o `z-index` da
latitude, que ali é a mesma: **medido no navegador, `239` nos dois**. O
desempate caía para a ordem no DOM, que é a ordem em que as duas respostas HTTP
chegaram.

Um mapa em que o popup aberto depende de uma corrida de rede não é um mapa, é
um sorteio. A correção é uma linha — `zIndexOffset` na camada de OS — e a
decisão que ela grava é que **a OS vence o empate**: o popup dela já carrega
nome do cliente, conectividade com idade, CTO, porta e **Abrir cliente**,
enquanto o popup do cliente, no mesmo ponto, não teria como levar à OS. Para
ver o cliente sozinho, o operador desliga a camada de OS — e aí o ponto fica
clicável, com a contagem de OS abertas no popup.

A prova por reversão devolve o número exato do defeito:
`Expected: > 239 · Received: 239`.

**O segundo empate era do meu teste, não do produto.** Ele lia a vista de
referência **depois** de abrir o popup, capturando o empurrão do `autoPan` do
Leaflet — 0,0027°, uns 124px. O link de volta carrega, de propósito, a vista de
**antes** desse empurrão, porque o operador não arrastou nada: quem moveu o
mapa foi o popup. Lendo a referência antes do clique, a comparação passou de
`toBeCloseTo(…, 3)` — que tolera 55 metros de deriva — para **igualdade de
string**, nas duas pontas, porque as duas escrevem o mesmo `toFixed(6)`.

A mesma correção foi aplicada à volta pelo popup da OS, que afirmava **só o
zoom**: uma volta que devolvesse o zoom certo sobre outro bairro passava.

### 41.7 Um empate que NÃO foi decidido, e por quê

A CTO e um cliente **exatamente** na mesma coordenada empatam pela mesma razão,
e esse não foi resolvido. A diferença é que o par cliente↔OS é **estrutural** —
a OS herda a coordenada do cliente, então a colisão é garantida —, enquanto
CTO↔cliente exige igualdade exata de latitude e longitude, que é construção de
fixture e não condição de dado real.

Decidir qual dos dois vence é escolha de produto que o enunciado não fez, e
inventá-la aqui seria decidir por omissão. Fica registrado como pergunta ao
dono: **quando uma caixa e um cliente ocupam o mesmo ponto, qual popup abre?**

### 41.8 Estado das camadas na URL, e o padrão que é omitido

As camadas ligadas viajam como **lista** (`?layers=CTOS,ORDERS`), e o parser é
uma allowlist: valor inventado na URL não liga camada nenhuma. Ausência do
parâmetro significa **padrão**, e não "tudo desligado" — quem chega por um link
sem `layers` recebe o mapa como ele abre.

E o padrão **não é escrito**: a vista de quem não mexeu em nada não polui a
barra de endereço. Lista vazia, porém, **é** escrita, porque "desliguei tudo" é
uma escolha e precisa sobreviver à navegação.

O padrão em si tem teste próprio (`LAYERDEF-01/02`), e ele nasceu de uma
sabotagem que **passou**: trocar `CUSTOMERS: false` por `true` não derrubava
nada no Vitest, porque o padrão era afirmado só pelo navegador.

### 41.9 Duas fronteiras técnicas que o código impôs

**Leaflet continua entrando por uma porta só.** `OperationalMarkers` importado
estaticamente puxa `leaflet` para o render do servidor e derruba o build; ele
entra por `dynamic(..., { ssr: false })`, como o resto do mapa.

**A busca mora em módulo próprio.** `cto-map` já dependia de `operational-map`,
e uma busca que alcança os dois dentro de qualquer um deles fecharia um ciclo.
`map-search.ts` depende dos dois e ninguém depende dela.

### 41.10 O que NÃO foi criado

Nenhuma coluna de contagem (`cto.onlineCount`, `cto.offlineCount`,
`cto.openOsCount`): as contagens são derivadas a cada leitura. Nenhuma segunda
coordenada de cliente (`Customer.latitudeMap` e parentes): `CustomerLocation`
continua sendo a autoridade e `Customer.latitude/longitude` continua sendo a
projeção mantida que o schema declara. Nenhum índice novo, nenhuma migration,
nenhum clustering, nenhum plugin instalado por antecipação. E nenhum `0,0` como
fallback: cliente sem localização é **contado**, nunca posicionado.

### 41.11 Três testes meus que passavam sem provar nada

Os três foram descobertos porque uma sabotagem **sobreviveu** a eles, e os três
tinham a mesma causa: o gesto que deveria provocar o efeito não provocava nada.

**O arrasto caía fora do mapa.** `LAYER-01/02/03` afirmava que a camada
desligada não consulta, arrastando de `(400, 300)` a `(460, 340)`. Medido: o
contêiner do mapa começa em `y=343`, e o viewport do teste tem 720px de altura
contra 558px de mapa — ou seja, o ponto inicial estava **acima** do mapa e a
metade de baixo dele está fora do alcance do ponteiro. O arrasto não movia
nada: zero mudança de URL, zero requisições. A afirmação "não consultou"
passava porque **nada** havia acontecido.

A cura tem duas partes, e a segunda é a que importa: o arrasto passou a ser
calculado a partir da caixa medida do contêiner, e entrou um **controle
positivo** — o mesmo gesto tem de ter recarregado a camada LIGADA. Sem ele, a
próxima vez que o arrasto ficar inerte o teste volta a passar calado.

**`LAYER-19` observava uma requisição só.** Pelo mesmo arrasto morto, a segunda
leitura nunca era disparada — e sem segunda leitura não existe "resposta
velha". O teste da guarda de sequência nunca exercia a guarda. Junto, a
asserção era só negativa: `not.toContainText("999")` também passa quando o
elemento **não existe**, e contador ausente é indistinguível de contador certo
para essa asserção. Agora exige-se que ele esteja na tela antes de afirmar o
que ele não diz.

**`LAYER-08/09` dependia de um sorteio.** Ele clicava no ponto do cliente com a
camada de OS ligada — o ponto coberto pelo losango. Passava ou falhava conforme
a ordem de chegada das respostas. Era ele que vinha "detectando" `S11`, `S14` e
`S15`: uma detecção que não era mérito do teste, e que escondia que `S11` não
tinha detector nenhum.

### 41.12 A sabotagem que NÃO deveria ser detectada, e a medição que prova

`S14` remove a guarda de bilhete da camada de clientes, e **nenhum teste de
navegador a derruba** — nem depois de o arrasto ser consertado. Isso foi
medido, não deduzido: uma sonda temporária contou as avaliações da guarda no
cenário da `LAYER-19` e registrou **uma**, aceita. Zero rejeições.

A razão é que o `AbortController` fecha a janela primeiro: a leitura anterior é
abortada antes de `res.json()` resolver, então ela nunca chega à linha da
guarda. O bilhete ali é **defesa em profundidade atrás do aborto**, e não o
mecanismo principal — a mesma conclusão que a `CTO-3.2` registrou para a sua
`S2`, agora com número.

O contrato do `createLatestRequestGuard` continua tendo teste próprio em
`cto-map-ui.test.ts`. O que não tem detector é a remoção do **ponto de uso**, e
não tem porque, naquele ponto, ela não muda comportamento observável.

### 41.13 Sabotagens

Quinze mutações (`S1`–`S15`), aplicadas uma por vez e restauradas com conferência
de `git status` ao final de cada rodada. As de navegador rodaram com **`.next`
limpo entre cada mutação** — sem isso o servidor serve `chunk` velho e relata
aprovação falsa, que é a armadilha metodológica já documentada no projeto.

| # | O que a mutação faz | Detector |
|---|---|---|
| `S1` | o módulo do mapa alcança um provider concreto de ERP | `CONN-MAP-07` |
| `S2` | o lote vira leitura por cliente (`N+1`) | `CONN-MAP-09`, `CTOSUM-09` |
| `S3` | ausência de snapshot passa a significar `OFFLINE` | `CONN-MAP-06`, `CUSTMAP-09..12` |
| `S4` | a leitura de clientes perde o `companyId` | `CUSTMAP-04/05/08` |
| `S5` | a leitura de OS perde o `companyId` | `OSMAP-03` |
| `S6` | cliente inativo passa a aparecer | `CUSTMAP-01/02/03` |
| `S7` | o resumo conta vínculo histórico como atual | `CTOSUM-06/07/08` |
| `S8` | o selo de OS substitui o estado de conectividade | `LAYER-04/05/06/07` |
| `S9` | OS fechada volta a aparecer | `CUSTMAP-09b`, `MAPSEARCH-08/09` |
| `S10` | a camada de clientes nasce ligada | `LAYERDEF-01`, `LAYER-01/02/03` |
| `S11` | a camada consulta mesmo desligada | `LAYER-01/02/03` |
| `S12` | o DTO do cliente passa a carregar o documento | `CUSTMAP-08` |
| `S13` | a busca de clientes perde o tenant | `MAPSEARCH-04` |
| `S14` | sai a guarda de bilhete da camada de clientes | **nenhum — ver §41.12** |
| `S15` | o retorno deixa de reconhecer o mapa | `LAYER-10/11` |

Catorze detectadas; a décima quinta está explicada acima e medida. Depois do
conserto dos três testes fracos, **cada sabotagem de navegador derruba
exatamente o teste que existe para pegá-la** — antes, o placar era ruidoso
porque um teste instável falhava junto e mascarava a ausência de detector do
`S11`.

### 41.14 Quatro defeitos que SÓ a suíte inteira mostrou

Durante a fase inteira eu rodei a suíte **filtrada** — `-g "camadas de cliente e
OS"`, `-g "LAYER-..."` —, e ela ficou verde o tempo todo. A primeira execução
completa do Playwright derrubou **quatro** testes, nenhum deles da camada nova.
É a mesma armadilha que a `CTO-3.2.1d` já tinha documentado com nove testes, e
eu caí nela de novo: **filtro não é suíte.**

**O controle de camadas empurrou a legenda para fora da primeira dobra.** Medido
em 1440×900: o controle ocupava **82px** de altura de página, e a legenda ficava
com o topo em `y=982` — exatamente 82px abaixo dos 900 da janela. A `UXP-02`
existe desde a `CTO-3.2.1b` para afirmar que a legenda é visível sem rolar, e a
regra que ela protege é que **altura de mapa é faixa de leitura, nunca fração de
tela**. Eu acrescentei chrome a uma página que não tinha folga nenhuma.

A cura não foi encurtar o mapa — isso seria pagar a conta com a régua que a
`CTO-3.2.1b` fixou. O **controle foi para dentro do mapa**, no canto oposto ao
da base (`Mapa`/`Satélite`/`Híbrido` à direita, `Camadas` à esquerda), que é
onde controle de camada mora em qualquer mapa e onde este componente já
colocava o seletor de base. Cantos opostos preservam a distinção que a fase
exige: os dois controles não podem parecer alternativas entre si.

**Os AVISOS não foram junto**, e a razão é diferente da do controle: mensagem de
erro em cima do mapa tapa exatamente o que a pessoa está tentando ver. Erro de
camada e "carregando clientes" ficaram no fluxo, e agora só existem quando há o
que dizer, em vez de um cartão sempre presente.

**Um payload de teste ficou velho.** A `UI-MAP-06` monta a resposta de
`/api/ctos/map` à mão, e a fase acrescentou `operational` ao DTO. O marcador lê
`marker.operational.openServiceOrderCount` **sem guarda** — e está certo, porque
isso é contrato de servidor e não entrada de usuário —, então o payload
incompleto derrubava a camada inteira e nenhum marcador era desenhado. O teste
falhava com "nenhum `.leaflet-marker-icon`", que não parece um problema de
contrato.

**Um texto de tela mudou e o teste não soube.** A busca deixou de ser só de CTO,
e o vazio passou de *"Nenhuma CTO encontrada"* para *"Nada encontrado com esse
nome, código ou número de OS."*. A copy nova está certa; a `SEARCH-04` é que
ficou para trás.

### 41.15 Medir posição de marcador em pixels de tela estava errado

A `MAPEDIT-05/06/07` compara onde a caixa está antes e depois de Cancelar. Ela
media **pixels de viewport**, e três coisas diferentes quebraram essa conta:

* a página **rola** — 41px de diferença que eram rolagem, não movimento;
* o mapa **se desloca sozinho** no meio da sequência: uma sonda registrou a
  vista passando de `-20.397441` para `-20.397129` durante o terceiro arrasto, e
  mudando de novo depois do Cancelar;
* a leitura do centro vem da barra de endereço, que só é reescrita no
  `moveend` — medir no instante do clique compara um centro velho com um
  marcador já na posição nova: **25,9px de erro puro**.

A grandeza certa não é pixel de tela: é **o marcador estar sobre a coordenada
gravada**. O teste passou a projetar essa coordenada em Web Mercator — o mesmo
cálculo que o Leaflet faz — e a comparar o *desvio* entre onde o marcador está e
onde ela cai. O desvio é constante enquanto a caixa estiver no lugar certo,
porque ele é só o ancoramento do ícone, e **não importa onde o mapa esteja**.

E a `MAPEDIT-08/14` deixou de usar `reload()`: ele herda a vista da barra de
endereço, que depois do `autoPan` e do arrasto punha a caixa **na borda** do
recorte consultado — às vezes dentro, às vezes fora. Uma entrada nova, enquadrada
na coordenada original, prova a mesma coisa (o que aparece vem do servidor) sem
depender de qual lado da borda a caixa calhou de cair.

**Janela alta para os testes de arrasto.** O mapa termina abaixo da dobra num
viewport de 720px — consequência aceita da altura fixa —, e o `autoPan` do popup,
que a `CTO-3.2.2` tornou maior ao acrescentar as contagens operacionais ao popup
da caixa, levava o marcador para `y=761`, com `elementFromPoint` devolvendo
**NADA** ali. O ponteiro não alcança o que está fora do viewport, então o
arrasto não acontecia e o botão Salvar continuava — corretamente — desabilitado.

### 41.16 A legenda caía de novo quando as camadas eram LIGADAS

A correção do §41.14 devolveu a legenda à primeira dobra — no estado **padrão**.
Ligando a camada de clientes ela saía outra vez, e a `UXP-02` não via: ela
valida o mapa como ele abre, e a camada nasce desligada.

A causa era a mesma conta, em outro lugar: **cada camada trazia a sua própria
linha de contadores**, empilhadas. Medido em 1440×900 com as três ligadas, as
linhas ficavam em `y=820`, `852` e `884`, e a legenda em **`y=916`** — dezesseis
pixels abaixo da janela. Os contadores passaram a dividir **uma** linha que
quebra sozinha, e a legenda voltou para `y=852`.

A `LAYER-21` existe para a quarta camada não repetir a conta em silêncio. E ela
**nasceu fraca**: com `toBeInViewport()` ela sobreviveu à reversão que empilha
os contadores de novo, porque esse matcher aceita qualquer interseção — uma
legenda com 4 dos seus 20px visíveis ainda passa. Com a afirmação numérica —
`legenda.y + legenda.height <= 900` — a reversão devolve o número do defeito:
`Expected: <= 900 · Received: 912`.

### 41.17 Um arrasto que não pega o marcador não falha — ele não faz nada

Com `--repeat-each=4`, a `MAPEDIT-05/06/07` caía em **2 de 4** execuções. O
sintoma apontava para o lugar errado: a asserção que falhava era a da classe
`cto-box--editing` depois do Cancelar.

A causa é anterior. Arrastando em sequência, a caixa desce para fora da **área
visível** do mapa — o contêiner tem `overflow-hidden`, então ela continua tendo
posição de layout e deixa de estar sob o cursor. Medido: no segundo arrasto,
`elementFromPoint` no centro calculado do marcador devolvia
`DIV[space-y-4]`, que é o contêiner da **página**, abaixo do mapa. O arrasto
movia `0,0`.

E é isso que torna a falha traiçoeira: **um arrasto que erra o alvo não dá
erro**. Ele simplesmente não acontece, o teste segue adiante, e quem reclama é
alguma asserção lá na frente.

O helper passou a **conferir a pegada** antes de arrastar: se o ponteiro não cai
sobre o marcador, ele traz a caixa ao centro arrastando o **mapa** — nunca o
marcador, para não mexer no rascunho de posição — e tenta de novo. Se ainda
assim não alcançar, **interrompe com mensagem**, em vez de arrastar o vazio.

Com a conferência, `--repeat-each=3` sobre a `MAPEDIT` inteira dá **30/30**.

**Isto é PRÉ-EXISTENTE, e foi medido como tal:** a mesma intermitência
reproduz no estado commitado, sem nenhuma alteração desta fase — 2 de 4 também.
A `CTO-3.2.2` a tornou mais provável ao aumentar o popup da caixa com as
contagens operacionais, o que aumenta o empurrão do `autoPan` e faz a caixa
começar a sequência mais perto da borda de baixo.

---

## 42. `CTO-3.2.2b` — estabilização e polimento do Mapa Operacional

**Estado:** `READY FOR OWNER VALIDATION`. Commits locais, sem tag e sem push.
**Migration:** nenhuma. **Schema:** nenhum. **Dart:** zero. **Dependência:** nenhuma.
**PRD:** não tocado nesta rodada, por instrução.

A validação manual da `CTO-3.2.2` aprovou o que a fase entregou de função —
três bases, persistência de vista e camadas, popup, plaqueta, arrasto da CTO,
filtros — e reprovou a experiência: oito pontos, três deles de estabilidade.

### 42.1 Os três "bugs" eram UM, e a sonda mostrou qual

O dono relatou como coisas separadas: *a CTO abre e some*, *os pontos de
cliente somem no zoom*, *o mapa fica se mexendo sozinho*. A medição mostrou uma
cadeia só:

```text
t=0ms     clique na caixa  → popup abre
t≈250ms   autoPan empurra a vista 291px (o popup tem 520px num mapa de 558)
t≈600ms   o moveend do empurrão dispara a releitura, com o recorte NOVO
t=754ms   resposta chega — e a caixa clicada não está nela
t=750ms   marcador `ausente`, popup morre junto
```

O recorte pedido ao servidor era **exatamente** `map.getBounds()`. Com isso o
dado vira função do pixel: qualquer deslocamento tira do resultado o que o
operador está olhando. O `autoPan` era o deslocamento mais comum, e o mais
cruel, porque acontece **por causa do clique**.

**A cura de raiz é `MAP_VIEWPORT_PADDING_RATIO = 0.25`:** o cliente pede mais do
que mostra, então movimento pequeno não muda a resposta. Área consultada 2,25×,
não 4×.

**A segunda metade é o tamanho do popup.** 520px num mapa de 558 é 93% da
altura — qualquer clique forçava um empurrão enorme. Os onze números viraram
chips que quebram sozinhos, os dois botões secundários passaram a dividir uma
linha, e a frase que repetia o selo de status saiu: **520px → 321px**, e o
empurrão caiu para **111px**.

**Desligar o `autoPan` foi tentado e medido**, porque o enunciado pedia eliminar
o movimento: o mapa de fato para, e o popup passa a nascer **236px acima da
borda**, cortado. Um controle que esconde metade do próprio conteúdo é pior que
um deslocamento pequeno. Ele ficou ligado, com `autoPanPadding` de 24px.

### 42.2 A prova fraca que eu quase deixei passar

Zerar a folga do recorte **não derrubava** a `STAB-01`. A razão é boa e
perigosa: com o popup já encolhido, o empurrão de 111px não tira o marcador nem
de um recorte colado. A proteção continuava certa e tinha deixado de ser
testada.

Uma proteção que nenhum teste derruba é uma proteção que alguém apaga na
próxima limpeza. A `STAB-04` afirma o **contrato**, não o sintoma: o recorte
pedido tem de ser maior que o visível, comparado por Web Mercator contra o
centro e o zoom da URL. Com a folga em zero ela devolve `1.0000046`.

### 42.3 O controle de camadas saiu do canvas — e o orçamento vertical foi refeito

Ele esteve **dentro** do mapa por uma fase, e a razão registrada na §41.14 era
boa: fora, custava 82px e empurrava a legenda para baixo da dobra. A validação
manual mostrou o preço do outro lado — **ele cobria os botões `+`/`−` do
Leaflet**, que moram no canto superior esquerdo, exatamente onde o operador
clica para aproximar.

Um controle que tapa o controle do mapa é pior que um controle que ocupa
altura. Ele voltou ao fluxo, como cartão abaixo da busca, e a conta foi paga na
**altura do mapa**: a faixa passou de `380/440/500/560` para
`320/360/380/400`.

Medido em 1440×900 com as três camadas ligadas:

```text
cartão de camadas  y=276..325
botões + / −       y=352..416      ← sem interseção
mapa               y=342..740  (400px)
resumo             y=757..809
legenda            y=825..859
documento          900px exatos    ← nada rola
```

**A regra que NÃO mudou:** altura de mapa continua em **pixels**, nunca fração
de tela. Unidade de viewport traria de volta o mapa que cresce e empurra o resto
para fora — que é o defeito que a `CTO-3.2.1b` consertou.

### 42.4 Decisões visuais

**Cliente virou pontinho de 16px**, como o dono pediu — e a **forma** carrega o
estado junto da cor, porque cor sozinha não distingue para quem não a enxerga e
um glifo de 7px é ilegível nesse tamanho:

```text
ONLINE        disco cheio         OFFLINE  disco com furo
SEM LEITURA   contorno tracejado
```

O anel de OS continua **por fora** e nunca substitui o miolo — `OFFLINE` e `OS
aberta` precisam ser lidos ao mesmo tempo. Ele virou **contínuo**: tracejado num
anel de 16px vira serrilha e some.

**OS virou losango de 15px, laranja, sem a sigla dentro.** "OS" com 7px não se
lia em tamanho nenhum e obrigava o marcador a ser grande para caber. Três
formas, distinguíveis sem cor: círculo é cliente, caixa é CTO, losango é OS. E o
tamanho é hierarquia — a caixa (20×27) é a infraestrutura, a OS é o trabalho
aberto em cima dela.

**Legenda em três grupos** — Caixas, Clientes, OS —, e só dos que estão
desenhados: explicar símbolo fora da tela é ruído. Os símbolos são os **mesmos
SVGs** dos marcadores, não aproximações; um quadradinho "representando" o ponto
faria a legenda divergir do mapa na primeira mudança de forma.

**Resumo em chips com número grande.** Antes eram sentenças cinzas do mesmo peso
do resto da página, e o dono leu como texto perdido. As contagens de **sem
localização** têm tom próprio porque respondem outra pergunta: elas não mudam
quando o mapa se move.

**Popup do cliente:** `Cadastro: Ativo` virou selo (como texto solto do mesmo
tamanho, era indistinguível do resto), CTO e porta viraram um endereço só, e a
contagem de OS ganha tom de alerta quando há trabalho aberto.

### 42.5 O que a legenda quebrou nos testes, e por quê

Desenhar os mesmos SVGs teve um preço que só a suíte mostrou: **`svg.cto-dot`
deixou de significar "ponto no mapa"** e passou a casar também com os símbolos
da legenda — `toHaveCount(3)` recebeu **7**. Os seletores de marcador passaram a
ser do `.leaflet-marker-pane`, que é onde o Leaflet põe marcador e nada mais.

E a `STATUSVIS-06` passou a abrir em `z15`: com o mapa em 400px, a caixa ao
norte (a ±0,004°, uns 444m) cai a 15px do topo e a **plaqueta dela**, que fica
acima do marcador, sai pela borda. O Leaflet recorta, e o ponteiro nunca a
alcança. É a `ML-01/02` ao contrário — **o zoom do teste é função da altura do
mapa**, e mudou junto com ela.

---

## 43. `CTO-3.2.2c` — hierarquia visual, ativos responsivos ao zoom e zero layout shift

**Estado:** `READY FOR OWNER VALIDATION`. Commits locais, sem tag e sem push.
**Migration:** nenhuma. **Schema:** nenhum. **Dependência:** nenhuma. **Dart:** zero.

Microfase de refinamento sobre a `CTO-3.2.2b`, a partir da validação parcial do
dono: a base funcional foi aprovada, e sobraram proporções, identificação e um
defeito de layout.

### 43.1 Discovery de urgência — a autoridade EXISTE

Antes de pintar qualquer OS de vermelho, a pergunta foi respondida no código:

* `ServiceOrderPriority` — enum com `LOW · NORMAL · HIGH · URGENT`;
* `ServiceOrder.priority`, padrão `NORMAL`, com índice `(companyId, priority)`;
* `SERVICE_ORDER_PRIORITY_LABELS` em `service-order-labels.ts`, o mesmo helper
  que o despacho usa;
* rota própria de alteração — `POST /api/service-orders/[id]/priority` (`DQ-3`);
* testes existentes na trilha da fila.

**`URGENT` e somente `URGENT` é urgente.** `HIGH` é "Alta", que é outra coisa, e
tratá-la como urgência seria exatamente a inferência que o enunciado proíbe.
Nada no mapa deduz urgência de tipo, status, título ou tempo em aberto.

O que faltava era **transporte**: o DTO do mapa não carregava o campo.
`ServiceOrderMapMarker` ganhou `priority`, e o `select` da consulta ganhou a
coluna. Zero migration.

### 43.2 A arquitetura de três camadas por marcador

O enunciado avisou do risco, e ele é real: o Leaflet posiciona cada marcador
escrevendo `transform: translate3d(...)` no contêiner. Escalar **esse** elemento
substitui o posicionamento, e o marcador sai do lugar geográfico.

```text
.leaflet-marker-icon      ← o Leaflet manda: translate3d, âncora
  └── .cto-marker-hit     ← área de CLIQUE, não escalada
        └── .cto-marker-scale   ← transform: scale(var(--map-scale))
              └── svg           ← o desenho
```

**A camada do meio não é enfeite, e o alcance disso foi medido — depois de uma
leitura minha errada.** Pondo `pointer-events: none` na camada de clique, o
**ponto do cliente fica inclicável** e a `POP-03` cai; o **arrasto da CTO
continua funcionando**, e a `MAPEDIT` inteira passa. São dois comportamentos
diferentes.

Eu havia concluído antes que a ausência da camada quebrava o arrasto da caixa, a
partir de uma falha da `MAPEDIT-05/06/07` que tinha outra causa — o marcador
saía pela borda de baixo com o mapa em 400px. **A conclusão certa é a de cima**,
e a sabotagem `S13` tem como detector a `POP-03`, não a `MAPEDIT`.

Com a camada de hit de fora da transformação, o alvo fica com **30px em
qualquer zoom** — medido em z15, z17 e z18 — enquanto o desenho encolhe.

### 43.3 A escala é CSS, e não passa por React

Duas variáveis (`--map-scale`, `--map-scale-cto`) escritas no contêiner do mapa
a cada `zoomend`. **Nenhum marcador é re-renderizado.** Se a escala fosse prop,
cada degrau de zoom recriaria os ícones, e o popup aberto morreria junto — que é
o defeito que a `CTO-3.2.2b` acabou de consertar por outro caminho.

A caixa tem curva própria e reduz menos: de longe, cliente e OS podem virar
pontinhos discretos, mas o mapa continua precisando de referência de
infraestrutura.

### 43.4 Tamanhos, medidos

| | antes | agora (z17) | alvo do dono |
|---|---|---|---|
| CTO | 38px | **32px** | 30–34 |
| OS | 15px | **20px** | 18–20 |
| Cliente | 16px | **18px** | 16–18 |

Hierarquia preservada: `32 > 20 > 18`. A diferença encolheu, que era o pedido.

### 43.5 Identificação

**Cliente por INICIAIS**, e a garantia de saída do helper é o que as autoriza
num `divIcon`. `customerInitials` devolve `[A-Z]{0,2}` — nenhum caractere com
significado em HTML sobrevive à peneira final, e há teste com entrada hostil
(`<img src=x onerror=...>`, `</svg><script>`) provando isso. A regra do projeto
— nome digitado por gente não entra em `divIcon` — continua valendo; o que entra
é o resultado garantido de uma função pura.

**OS pelo NÚMERO do domínio**, em `Tooltip` (que o React escapa), nunca pelo id
de banco. A urgente ganha `!` antes: a cor não pode ser a única portadora do
sinal.

**Vermelho tem dois significados, e está tudo bem.** Na OS é urgência; no
cliente é `OFFLINE`. Formas diferentes, rótulos diferentes e dois grupos na
legenda separam a semântica — a cor sozinha nunca decide.

### 43.6 O layout shift do refresh

O indicador de carregamento vivia no fluxo, **acima** do mapa: aparecia,
empurrava a página para baixo, e sumia empurrando de volta. Era o que o dono
descreveu como "a página desce e depois volta" a cada zoom ou arrasto.

Agora é uma pílula em overlay **dentro** do mapa, com 160ms de atraso — e o
atraso é só da interface: o pedido sai na hora, quem espera é o aviso, para não
piscar em resposta instantânea.

A `LOADUX` mede topo e altura de mapa, controle, chips e legenda **durante** uma
leitura retardada de propósito, com tolerância de 1px. Medir só antes e depois
não veria nada — o defeito só existe enquanto a leitura está em voo.

### 43.7 Uma sabotagem que passou, e o teste que faltava

`S6` remove a lista de conectores das iniciais, e **nenhum teste caía**. A razão
é boa: em "João da Silva Neto" e "Ana de Souza" a partícula está no MEIO, e
"primeira e última palavra" já acerta sem filtrar nada.

A lista só decide quando o conector é a **ponta**: sem ela, "Ana de" vira `AD`.
Nasceu daí a `INIT-11`, e só então a sabotagem cai.

### 43.8 INFO — o empate CTO↔cliente ficou mais provável

A decisão sobre qual popup abre quando **caixa e cliente ocupam exatamente a
mesma coordenada** segue **em aberto** desde a `CTO-3.2.2`, e o enunciado desta
fase manda não resolvê-la em silêncio. Ela não foi resolvida.

Mas o custo prático dela **aumentou**: a área de clique do ponto de cliente
passou de 18px para 30px, então o ponto agora cobre o centro da caixa quando os
dois coincidem. Medido: na fixture, a caixa ficou inalcançável ao ponteiro com a
camada de clientes ligada.

Em dado real a coincidência exata é improvável — a coordenada da caixa e a do
cliente vêm de origens independentes. Mas a decisão continua pendente, e agora
com um raio maior.

### 43.9 INFO — não existe seleção de cliente nem de OS

A regra "o selecionado mostra o rótulo em qualquer zoom" vale para a **caixa**, e
ela já a tem desde a `CTO-3.2.1c`. O parâmetro `sel` da URL é de CTO: não há
caminho que selecione um ponto de cliente ou um losango de OS.

Uma regra de CSS chegou a ser escrita para isso e **foi removida** — classe que
ninguém aplica é CSS morto se passando por funcionalidade. Criar seleção para as
outras duas famílias é decisão de produto, não desta microfase.

### 43.10 Sabotagens

Catorze mutações. **Treze detectadas**, e as três que passaram na primeira
rodada renderam mais que o placar.

| # | O que a mutação faz | Detector |
|---|---|---|
| `S1` | escala aplicada no contêiner externo do Leaflet | `ZOOMVIS-08/09` |
| `S2` | cliente volta ao tamanho antigo (16px) | `ZOOMVIS-01` *(ver abaixo)* |
| `S3` | a caixa continua com 38px | `ZOOMVIS-01` |
| `S4` | a OS continua com 15px | `ZOOMVIS-01` |
| `S5` | iniciais usam primeiro + **segundo** nome | `INIT-01/02/05` |
| `S6` | conectores deixam de ser ignorados | `INIT-11` *(ver abaixo)* |
| `S7` | o indicador volta ao fluxo do documento | `LOADUX-01..06` |
| `S8` | a OS urgente perde o `!` | `OSURG-03` |
| `S9` | a OS normal fica vermelha | `OSURG-01/02` |
| `S10` | o rótulo da OS usa o id do banco | `OSURG-06` |
| `S11` | o nome completo vira rótulo permanente | `LABELZOOM-03` |
| `S12` | o zoom manda fechar o popup | **nenhum — ver abaixo** |
| `S13` | a camada de clique fica inerte | `POP-03` |
| `S14` | o rótulo duplicado "CTO CTO" volta | `POP-03` |

**`S2` passou, e a asserção era frouxa.** A faixa dizia `>= 16`, e 16 é
exatamente o tamanho antigo — a sabotagem que desfaz o aumento cabia dentro do
limite. Passou a ser `> 16`: o limite inferior tem de **excluir** o que se quer
tirar do caminho. Agora ela cai dizendo `cliente não cresceu: 16`.

**`S6` passou, e faltava um caso.** Em "João da Silva Neto" e "Ana de Souza" a
partícula está no MEIO, e "primeira e última palavra" acerta sem filtrar nada. A
lista de conectores só decide quando o conector é a **ponta** — sem ela, "Ana
de" vira `AD`. Nasceu a `INIT-11`.

**`S12` não é detectável, e não deveria ser.** Ela faz o `zoomend` chamar
`map.closePopup()`, e o popup **continua aberto**: o `<Popup>` do react-leaflet
é declarativo e o reabre. Mais fundo que isso: nesta arquitetura **o zoom não
toca React em lugar nenhum** — a escala é variável CSS, e nenhum marcador é
re-renderizado. Uma sabotagem que fizesse o zoom desmontar marcador teria de
reintroduzir o acoplamento zoom→render, que é uma reescrita e não uma troca de
sinal. A `ZOOMSEQ-01` continua valendo como guarda contra essa regressão futura.

## 44. `CTO-3.2.2d` — polimento final e usabilidade do popup da OS

**Estado:** `READY FOR OWNER VALIDATION`. Commits locais, sem tag e sem push.
**Migration:** nenhuma. **Schema:** nenhum. **Dependência:** nenhuma. **Dart:** zero.
**PRD:** não tocado, por instrução da fase — o dono quer validar o acabamento
antes de congelar decisão visual. Esta seção é nota técnica: registra o que foi
medido e por quê, não promove nada a regra de produto.

### 44.1 Cliente pelo PRIMEIRO NOME, e por `Tooltip`

`customerFirstName` (`src/lib/customer-presentation.ts`) devolve a primeira
palavra significativa em caixa de apresentação: `ROSELI JESUNO DE SOUZA
TEIXEIRA` → `Roseli`, `João da Silva Neto` → `João`, `   Ana    Maria   ` →
`Ana`. Conector na ponta é pulado (`de Souza` → `Souza`), nome com hífen é um
nome só (`ANA-CLARA` → `Ana-Clara`), e sem nome não há rótulo — nada é
fabricado.

**Ele não pode ir para o `divIcon`.** As iniciais da `CTO-3.2.2c` podiam, porque
`[A-Z]{0,2}` não tem caractere com significado em HTML e a garantia era do
helper. Um primeiro nome pode conter `<`, `&` ou aspas. Ele vai pelo `Tooltip`,
que o React escapa. `customer-initials.ts` foi removido — ficou sem consumidor.

O nome completo continua no popup, aberto por ação explícita; telefone,
documento e endereço não entram no mapa.

### 44.2 Cada família de rótulo tem uma DIREÇÃO

A OS usa a coordenada do cliente, e o número dela vai à direita do losango. Com
o nome do cliente também à direita, os dois nasciam **a um pixel um do outro** —
medido: `Camada` em (785, 418) e `OS-N°8800` em (786, 418).

```text
             [CAIXA]        ← plaqueta da caixa: ACIMA
  Maria  ●◆  OS-N°7         ← cliente à ESQUERDA, OS à DIREITA
```

**Abaixo do ponto foi considerado e descartado pela conta:** o nome desceria
38px, e a plaqueta da caixa sobe 59px acima dela — um cliente a 80m ao norte de
uma caixa cruzaria a plaqueta. À esquerda, no mesmo ponto, as três direções
não se cruzam. Colisão entre pontos DIFERENTES e próximos continua sendo
densidade: o limite que a `CTO-3.2.1c` declarou (o limiar de zoom evita a
parede, não toda sobreposição).

As caudas `::before` das direções `right` e `left` passaram a usar `--surface`.
A padrão do Leaflet é branca: no tema claro coincide com a plaqueta; no escuro
vira uma seta branca presa a uma plaqueta escura. A da OS estava assim desde a
`CTO-3.2.2c`.

### 44.3 Tamanhos — a hierarquia é de ÁREA desenhada

| | `CTO-3.2.2c` | agora (z17) | corpo pintado |
|---|---|---|---|
| Caixa | 32px | 32px | carcaça 14,5 × 19,6 |
| OS | 20px | **23px** | losango de diagonal 19,6 (≈ 191 px²) |
| Cliente | 18px | **21px** | disco de 14 (≈ 154 px²) |

O pedido foi só o cliente (≈ 20–22px), com o objetivo `CTO > OS > Cliente`. **A
OS subiu junto**, e o motivo é a conta que o lado do ícone esconde: o losango
ocupa metade do quadrado dele, o disco bem mais. Com a OS em 20 e o cliente em
21, o cliente pintaria 154 px² contra 144 da OS — hierarquia invertida com os
números em ordem certa. Os dois cresceram ~15%, e a razão de área OS/cliente
aprovada na fase anterior (1,28) ficou em 1,24.

O comentário escrito no código antes dessa medição afirmava o contrário ("21 de
círculo e 20 de losango deixam a OS com mais peso") e foi corrigido.

A área de clique continua 30px para os dois: o desenho cresceu, o alvo não.

### 44.4 O `!` mora só no símbolo

O rótulo da OS é `OS-N°<número>` para qualquer prioridade. A urgente continua
vermelha e com `!` **dentro do losango**; o texto não o repete. A pílula de
prioridade do popup também perdeu o `!` — ela diz "Urgente" por extenso.
Urgência continua sendo `priority === "URGENT"` e somente isso.

### 44.5 Legenda

`Online`/`Offline` viraram `Cliente online`/`Cliente offline`: a legenda tem um
grupo de OS com "Aberta" e "Urgente", e "Online" sozinho não dizia de quê.
`Sem leitura` e `Com OS aberta` ficaram. Os filtros da camada de clientes
continuam `Online`/`Offline` — ali o sujeito já é o controle "Clientes ativos".

### 44.6 O popup da OS — compacto, e fora dos controles do mapa

**O defeito relatado**, medido antes de tocar em código: o popup tinha
**222 × 473px** num mapa de 398. O `autoPan` mostrava o topo dele e empurrava o
marcador para fora da vista; a releitura vinha sem o marcador, ele era
desmontado e o conteúdo do popup sumia — sobrava a casca com o "×". É a cadeia
da `CTO-3.2.2b`, agora no popup da OS.

**A forma nova:** 300px de largura e **no máximo 240 de altura**, com cabeçalho
(número + prioridade) e ações **fora** da rolagem; só o miolo rola. Uma sonda
mediu 20 casos com ela — quatro janelas (1440×900, 1366×768, 1280×720,
1024×700) × centro e as quatro bordas —, e o popup ficou em **302 × 242** com o
"Abrir OS" dentro do mapa, dentro da janela e recebendo o clique em todos. Essa
sonda é anterior ao ajuste de respiro abaixo; depois dele, quem mede é a `OSPOP`
permanente, nas três janelas do enunciado.

**E o que a prova de borda achou depois:** perto da borda direita o seletor
Mapa/Satélite/Híbrido interceptava o clique no "×". Os controles ficam acima
dos painéis do Leaflet, e o popup — 242px num mapa de 398 — quase sempre
terminava com o topo a 24px da borda de cima, onde os dois cantos têm
controle. Medido em coordenadas do mapa: zoom em (10–44, 10–74), seletor em
(776–962, 12–42), atribuição em (625–974, 376–398).

A correção é `autoPanPaddingTopLeft = [52, 50]`: **cada respiro limpa um
controle**, e juntos limpam os dois em qualquer posição — topo ≥ 50 passa por
baixo do seletor, esquerda ≥ 52 passa ao lado do zoom. Um topo de 82 limparia
os dois sozinho e não caberia no mapa de 320px da tela estreita. Embaixo e à
direita ficam os 24px de antes, que já limpam a atribuição.

A `OSPOP` agora afirma, nas três janelas do enunciado e nas cinco posições: o
popup para de se mexer, fica inteiro dentro do mapa e fora de todo controle, o
"Abrir OS", o "Abrir cliente" e o "×" recebem o clique no centro deles, o
marcador sobrevive ao empurrão — e, na borda de cima, o clique no "Abrir OS"
navega de fato.

**O popup da CAIXA não foi mudado** — está fora do escopo e aprovado pelo dono —
e continua com 24px de respiro. Ver 44.9.

### 44.7 Ativos próximos — o critério de regressão do dono

O dono validou abrir caixa, cliente e OS individualmente com eles próximos.
Não havia teste de navegador para isso. A `PROX-01` monta um bairro próprio,
longe de todas as outras fixtures, com a caixa, um cliente a **36px** dela em
z17 (≈5px entre as áreas de clique) e duas OS em clientes vizinhos, e clica
cada um partindo do mesmo enquadramento. Um controle positivo afirma que eles
estão mesmo próximos — se a conta de graus os espalhasse, o teste provaria
cliques em alvos isolados.

**Mesma coordenada exata continua sendo a decisão aberta** e não é testada aí.
O aumento do cliente **não** a piorou: cresceu o desenho, que não recebe
ponteiro; a área de clique continua 30px.

### 44.8 Três armadilhas de medição, e duas asserções minhas que não mediam

**"Parou" pela URL não cobre animação.** A vista só é reescrita no `moveend`, no
FIM do empurrão; duas leituras iguais logo após o clique são duas leituras da
vista velha. Medido duas vezes: o popup ainda andou 9px depois do "estável", e
um Cancelar que estava certo foi acusado de errar 185px — o tamanho do
empurrão do popup da caixa. A espera passou a ser pelo **objeto**: três
leituras iguais do popup, ou do marcador junto com a URL.

**`getBoundingClientRect` de `<circle>` inclui o traço.** O disco de 14px mede
15,5. O limite inferior que escrevi primeiro (`> 12,5`) aceitava o tamanho
antigo, que pinta ~13,3 — a sabotagem que desfaz o aumento passaria por ele.

**Os rótulos moram no painel de TOOLTIPS**, não no de marcadores. A
`LABELZOOM-03` lia `.leaflet-marker-pane` para afirmar que o nome completo não
aparece — e nunca veria um nome vazado. E a asserção de "uma palavra só"
estava escrita `/s/`, a letra, porque a barra invertida se perdeu no script que
a gerou; passava porque "Camada" não tem "s". As duas foram corrigidas, e a
`FIRSTNAME-MAP` afirma a lista exata com nomes reais de várias palavras.

**O `Esc` do Leaflet não fecha popup depois de um clique em marcador.** O
handler de teclado só é ligado com o foco no contêiner, e o marcador
(`tabindex=0`) toma o foco. Os testes fecham pelo "×", como a pessoa fecha.

### 44.9 INFO

* **O popup da CAIXA pode pousar debaixo dos controles perto das bordas.** Mesma
  classe do defeito corrigido na OS; não foi tocado por estar fora do escopo e
  aprovado pelo dono. Medido: na borda direita o seletor Mapa/Satélite/Híbrido cobre o "×" do popup da caixa (`elementFromPoint` devolve o seletor), e na esquerda o zoom cobre o cabeçalho — em 1440×900 e em 1280×720. É anterior a esta fase (o popup de 321px com 24px de respiro vem da `CTO-3.2.2b`). O conserto da OS **não se transfere direto**: 321px de popup, mais 50 de respiro, mais os 32 do ícone passam dos 398 do mapa, e o `autoPan` voltaria a empurrar o marcador para fora. Pede decisão própria — encolher o popup da caixa ou outro arranjo dos controles.
* **Colisão de rótulos entre pontos diferentes e próximos** continua possível em
  z16–z17 com o nome do cliente ligado — é densidade, e o limiar de zoom é a
  regra que existe para ela. Pedir para esconder rótulo por sobreposição seria
  uma regra que o operador não consegue prever (decisão da `CTO-3.2.1c`).
* **O empate CTO↔cliente na mesma coordenada** segue em aberto, sem piora.
* **O `title` do marcador de cliente** carrega o nome completo, como antes: é o
  nome acessível e aparece só no hover do navegador, não é rótulo permanente.

### 44.10 Sabotagens

Dezoito mutações — as catorze do enunciado e mais quatro sobre o que esta fase
consertou —, cada uma sobre o estado commitado, com `.next` limpo, restaurada
por `git checkout` e conferida por `git status` vazio. **Dezoito detectadas.**

| # | O que a mutação faz | Detector | O que ele disse |
|---|---|---|---|
| `S1` | cliente volta a 18px | `ZOOMVIS-01`, `CUSTOMERVIS-01` | `cliente não cresceu: 18`; `disco de 13.25px` |
| `S2` | rótulo com o nome completo | `LABELZOOM-03`, `CUSTOMERVIS-07`, `FIRSTNAME-MAP` | `rótulo com mais de uma palavra: CAMADA CLIENTE OFFLINE` |
| `S3` | "Roseli Jesuno" (duas palavras) | 7 testes `FIRSTNAME` (Vitest), `FIRSTNAME-MAP` | lista de rótulos diferente da esperada |
| `S4` | urgente volta a `! OS-N°` | `OSURG/OSLABEL` | o rótulo `OS-N°8802` deixou de existir |
| `S5` | urgente perde o `!` do símbolo | `OSURG/OSLABEL` | contagem de `!` |
| `S6` | urgente perde o vermelho | `OSURG/OSLABEL` | `a urgente não se distingue da normal` |
| `S7` | normal vira vermelha | `OSURG/OSLABEL` | contagem de normais |
| `S8` | legenda volta a "Online" | `LEGEND-01..06`, `VIS-01` | lista exata da legenda |
| `S9` | popup da OS com 430px | `OSPOP` | `centro: o popup passou da borda do mapa` |
| `S10` | popup da OS sem `autoPan` | `OSPOP` | `centro: o popup passou da borda do mapa` |
| `S11` | contêiner do cliente zerado | `LAYER-08/09` | o clique no cliente esgota o tempo |
| `S12` | área de clique de 90px | `PROX-01` | `folga entre caixa e cliente: -25px` |
| `S13` | caixa não arrastável em edição | `MAPEDIT-05/06/07`, `MAPEDIT-08/14` | o arrasto move o mapa, não a caixa |
| `S14` | indicador de carregamento no fluxo | `LOADUX-01..06` | `mapa mudou de posição durante o refresh: 310 → 360` |
| `S15` | nome do cliente de volta à direita | `LABELCOL-01` | `nome × OS 8800` |
| `S16` | caudas com a cor padrão do Leaflet | `LABELCOL-02` | `a cauda da plaqueta ficou com a cor padrão` |
| `S17` | popup da OS com 24px de respiro | `OSPOP` | `esquerda: o popup ficou debaixo do zoom` |
| `S18` | OS de volta a 20px | `ZOOMVIS-01`, `CUSTOMERVIS-02` | `a OS ficou menor que o cliente: 171 contra 188 px²` |

**`S10` é a borda de CIMA, não a de baixo.** O enunciado descreve o caso como
"popup edge-bottom esconde botão". O Leaflet abre o popup **acima** do marcador,
então perto da borda de baixo o botão fica logo acima do ponto e não some por
construção — medido nas cinco posições. Sem `autoPan`, quem perde o botão é a
borda de cima e o próprio centro (popup de 242px sobre um marcador a 199px).

**`S12` cai na folga, antes do clique.** A `PROX-01` afirma a folga entre as
áreas de clique com dois limites: o de cima prova que os ativos estão mesmo
próximos; o de baixo é a propriedade — a área do cliente não alcança a da
caixa. Com 90px ela fica negativa e o teste para ali.

**`S18` mede a área PINTADA**, com o traço: 188 px² de disco contra 171 de
losango com a OS em 20. Com a OS em 23 o losango pinta ~226.

## 45. `CTO-3.2.2e` — estabilização final de UX do Mapa Operacional

**Estado:** `READY FOR OWNER VALIDATION`. Commits locais, sem tag e sem push.
**Migration:** nenhuma. **Schema:** nenhum. **Dependência:** nenhuma. **Dart:** zero.
**Rota nova:** nenhuma. **PRD:** não tocado, por instrução da fase — o dono
congela a documentação depois da validação final. Esta seção é nota técnica.

Sete pedidos do dono, e cinco deles tinham causa-raiz que a medição achou
antes de qualquer edição.

### 45.1 O flicker tinha DOIS indicadores, e o que piscava era o sem atraso

Sonda de 20 ms durante um arrasto com resposta normal:

```text
----------------------------L-L-L-L-------------------------------   L = "Carregando CTOs…"
                                                                    U = "Atualizando mapa…" (nunca)
```

`OperationalMap` desenhava **"Carregando CTOs…"** no instante em que a camada
de CTO começava a ler, e o apagava no instante da resposta — ~80 ms de vida.
Ao lado dele, a camada já tinha o aviso único "Atualizando mapa…", com 160 ms
de atraso, que numa resposta normal nunca chegava a aparecer. Eram dois
indicadores para a mesma coisa.

Ficou **um**, da camada, e a cadência virou função pura
(`src/lib/map-activity-indicator.ts`): **250 ms para aparecer** e **300 ms de
tempo mínimo na tela**. Leitura rápida nunca mostra nada; leitura lenta mostra
depois do atraso e não some no milissegundo seguinte; leitura emendada na
anterior não apaga e reacende. O pedido ao servidor sai na hora — só o aviso
espera. `OperationalMap` perdeu a prop `loading`, e um teste estrutural proíbe
o texto e o `data-testid` de voltarem.

A prova de navegador é **temporal**: um cronômetro no próprio navegador
registra quando a requisição da camada sai e quando o aviso aparece e some.
Com resposta de 120 ms, zero aparições; com 320 ms, uma aparição ≥ 200 ms
depois do pedido, visível por ≥ 250 ms.

### 45.2 O espaço vazio dos popups era o `p { margin: 1.3em }` do Leaflet

Medido no popup da CTO: nome a **31 px** do topo em vez de 13, status 34 px
abaixo dele, 321 px no total. No da OS: cabeçalho de **104 px** para uns 40 de
conteúdo — e a conectividade do cliente a **y=210 num miolo que terminava em
187**: fora da área rolável. Era isso que o dono via como "pouco evidente".

A causa é uma regra do `leaflet.css` — `.leaflet-popup-content p { margin:
1.3em 0 }` —, mais específica que o reset de `p` do Tailwind e que qualquer
utility `mt-*`. Todo parágrafo de popup nascia com ~18 px em cima e embaixo.

A correção é uma regra escopada (`.cto-map-popup--compacto p { margin: 0 }`)
mais a decisão de os dois popups compactos **não usarem `<p>` com margem** —
o espaçamento é de contêiner. Escopada porque o popup do **cliente** foi
aprovado pelo dono como está, com as margens do Leaflet; ele não muda nesta
fase.

| | antes | agora |
|---|---|---|
| CTO — invólucro | 321 px | **229 px** (−29 %) |
| CTO — nome a partir do topo | 31 px | 13 px |
| OS — cabeçalho | 104 px | **37 px** |
| OS — invólucro | 242 px | 248 px, **tudo visível sem rolar** |
| OS — conectividade | fora do miolo visível | dentro, com o sujeito escrito |

No popup da CTO o nome e o selo de estado passaram a dividir a primeira linha
(o `pr-5` mantém o nome fora do "×", que mora nos 24 px do canto). Nenhuma
informação saiu: capacidade, livres, ocupadas, reservadas, danificadas,
ativos, online, offline, sem leitura, OS abertas, e as três ações.

### 45.3 O popup da OS usa a largura

O nome do cliente vivia numa coluna à direita do rótulo e era truncado
("ROSELI JESUNO DE…"). Agora ocupa a largura inteira, em até duas linhas; a
conectividade vira selo com o **sujeito** — `customerLabel` na tabela de
`connectivity-presentation.ts`: "Cliente online", "Cliente offline", "Sem
leitura" — com a idade da leitura na mesma linha; "Aberta" e "Técnico"
dividem uma linha em duas colunas; a caixa, quando há, fecha o miolo.
Cabeçalho e ações continuam fixos, fora da rolagem; o teto subiu de 240 para
280 px, e o miolo cabe sem rolar (136 px de conteúdo em 136 de área).

### 45.4 O popup da CTO pousa fora dos controles

A `CTO-3.2.2d` deixou registrado que, perto da borda direita, o seletor de
base cobria o "×" deste popup, e perto da esquerda o zoom cobria o cabeçalho
— e não corrigiu porque com 321 px ele não cabia com 50 de respiro no menor
mapa. Compactado, cabe: os dois popups leem a **mesma** constante
(`popup-clearance.ts`, `[52, 50]` / `[24, 24]`), porque a geometria dos
controles é do mapa e não de uma camada. Medido nas três janelas, no centro e
nas quatro bordas: popup inteiro no mapa, fora do zoom, do seletor e da
atribuição, com "×", "Abrir CTO", "Ver clientes" e "Ajustar posição"
recebendo o clique no centro deles.

### 45.5 A altura do mapa tem um degrau por ALTURA de janela

O dono pediu mais área vertical, e "quanto" depende de quanto sobra abaixo do
mapa. O topo do mapa fica em 298 px de documento com as camadas padrão e em
309 com a camada de clientes ligada (o cartão de camadas ganha o filtro e
cresce 11 px). Medido com as três camadas ligadas, o pior caso:

| janela | antes | agora | mapa termina em | resumo | legenda |
|---|---|---|---|---|---|
| 1440×900 | 400 | **440** | 749 | inteiro (765–817) | **inteira** (833–895) |
| 1366×768 | 400 | **410** | 719 | começa em 735 | começa em 803 |
| 1280×720 | 400 | **410** | 719 | começa em 735 | começa em 803 |

Em 720 de altura, **410 é o teto**: o mapa termina a um pixel da dobra, e um
mapa cortado na dobra é pior que um mapa pequeno. Em 900 sobram 200, e **440
é o maior mapa que ainda deixa resumo e legenda inteiros na primeira dobra
com as três camadas ligadas** — a propriedade que a `CTO-3.2.2` corrigiu
(§41.14) e que a `LAYER-21` guarda desde então. 460 seria possível ao custo
de 15 px de legenda abaixo da dobra; **ficou como decisão do dono, não
tomada aqui**.

Por isso o último degrau é `[@media(min-width:1024px) and (min-height:860px)]`
— **um número de pixels**, discreto e previsível, e não um mapa que cresce com
a janela. A regra da `CTO-3.2.1b` não mudou: nenhuma unidade de viewport, em
degrau nenhum. Os degraus menores subiram 20 (340/380/400).

O preço, declarado: em 768 e 720 de altura, com a camada de clientes ligada, o
resumo começa 15 px abaixo da dobra (com as camadas padrão ele cabe em 768).
É a "rolagem pequena" que o dono aceitou em troca do mapa maior.

### 45.6 Ajustar posição traz a caixa para a área segura

O dono via a caixa "lá embaixo" ao entrar em edição. Medido: o `autoPan` do
popup empurra a vista para o popup caber **acima** do marcador, então o
marcador vai parar no rodapé (y=354 num mapa de 400); fechado o popup, ele
fica lá — e no canto esquerdo, debaixo do painel de edição (172–386, 316 px
de largura).

Ao entrar em edição a camada chama o **`panInside` do Leaflet** com respiros
medidos — topo 106 (o zoom termina em 74 e o ícone tem 32), esquerda 64,
direita 40, base 48 — e um retângulo a evitar no canto inferior esquerdo
(332 × 250, o painel com folga). O canvas escolhe entre subir e ir para a
direita pelo menor deslocamento. `panInside` move o mínimo que resolve e **só
se precisar**: caixa já na área segura não se move, e o teste prova as duas
coisas — no centro a vista de depois é a de antes; nas bordas ela muda. É
pan de **vista**: a coordenada gravada não muda, nada é escrito, e quem
escreve continua sendo o arrasto explícito do marcador.

### 45.7 "Sem leitura" ganhou corpo

Antes: contorno tracejado de 1,75 px, sem preenchimento. Sobre satélite e
híbrido, invisível. Agora são quatro sinais, e nenhum é cor sozinha: um
**halo** na cor da superfície por baixo (o recurso que já dá contraste ao
online e ao offline pelo traço deles), preenchimento neutro **claro** com
contorno tracejado **escuro** de 1,9 px, e um **centro**. O raio do halo (6,9)
dá ao ponto a mesma área aparente do disco cheio com o traço dele — a razão
medida é 1,04. Contraste contorno × preenchimento calculado do
`getComputedStyle` nos dois temas: ≥ 7:1. Continua neutro (canais a menos de
40 de distância) e continua tracejado; não vira vermelho nem verde.

### 45.8 Cliente com OS urgente: sinal ADICIONAL, com uma autoridade

`hasUrgentOpenServiceOrder` entrou no DTO — um booleano, e nada além: o
marcador precisa saber SE há urgência, não quais OS. Sai da **mesma**
consulta que conta as OS abertas: o `groupBy` passou a agrupar por cliente **e
prioridade**, e a urgência é o grupo `URGENT` entre os abertos. `HIGH` não
conta; urgente concluída ou cancelada não conta; nada é deduzido de tipo,
texto ou tempo. Zero consulta a mais — o teste conta: oito clientes, um
`groupBy`, zero `findMany`, zero `count`.

No desenho: **anel vermelho no lugar do âmbar** (nunca os dois) e um selo `!`
no canto, **fora** do disco — dentro ele disputaria com o furo do offline e o
centro do sem leitura. O miolo não muda: online continua verde, offline
continua vermelho (quem o distingue do offline comum é o anel a mais e o
selo, não um tom de vermelho), sem leitura continua tracejado. **Estático**:
nenhuma animação, medido por `animationName`. O rótulo acessível diz "com OS
urgente" por extenso. A legenda ganhou "Cliente com OS urgente" com o mesmo
símbolo, por último — ela não substitui nenhuma das quatro entradas. O popup
do cliente ganhou um chip "OS urgente" na linha que já existia, e só isso.

### 45.9 O que NÃO mudou

Popup do cliente (aprovado), chips de resumo, controle de camadas fora do
canvas, filtros, rótulos de cliente e de OS, tamanhos dos marcadores (CTO 32,
OS 23, cliente 21), a escala por zoom em CSS, o `translate3d` do Leaflet, e a
ordem OS acima de cliente. O empate CTO↔cliente na mesma coordenada
**continua em aberto**.

### 45.10 Fixtures e testes que mudaram de contrato, legitimamente

`VIS-03` afirmava `fill: none` no sem leitura — o contrato agora é "tem
preenchimento, e ele não é o de nenhum dos outros dois estados"; a prova de
contraste ficou na `UNKNOWNVIS`. `LEGEND-01..06` ganhou a quinta entrada.
`OSPOP` subiu o teto de 260 para 300 e ganhou as asserções `OSPOP2` sobre
cabeçalho, conectividade à vista e largura do nome. O bairro `PROX` ganhou
dois vizinhos — Carlos (online + urgente) e Pedro (offline com HIGH aberta e
urgente concluída) — e João passou a ter uma urgente além da normal; Roseli
fica sem OS de propósito, porque é o cliente que a `PROX-01` clica
diretamente.

### 45.11 INFO

* **O popup do cliente ainda carrega as margens de parágrafo do Leaflet**
  (~18 px entre blocos). Foi aprovado pelo dono como está e a fase mandou não
  redesenhar; se a consistência com os outros dois importar, a classe
  `cto-map-popup--compacto` já existe.
* **460 em 1440×900 é possível**, ao custo de a legenda terminar 15 px abaixo
  da dobra com as três camadas ligadas. Ficou em 440 para não desfazer a
  propriedade que a `CTO-3.2.2` corrigiu; é decisão do dono.
* **1280×720:** com clientes ligados os chips do resumo quebram em duas
  linhas (111 px) por LARGURA, e a legenda começa a ~83 px da dobra. Já era
  assim antes da fase (a diferença é os 10 px do mapa).
* **O empate CTO↔cliente na mesma coordenada** segue em aberto, sem piora.

### 45.12 Sabotagens

Dezenove mutações — as dezesseis do enunciado e mais três sobre o que esta
fase consertou —, cada uma sobre o estado commitado, com `.next` limpo,
restaurada por `git checkout` e conferida por `git status` vazio.
**Dezenove detectadas.**

| # | O que a mutação faz | Detector | O que ele disse |
|---|---|---|---|
| `S1` | atraso do indicador volta a zero | `LOADFLICKER-02/09` (Vitest), `LOADFLICKER-01` | `o indicador piscou numa leitura rápida` |
| `S2` | "Carregando CTOs…" reaparece, sem atraso | `LOADFLICKER-01/04`, `LOADFLICKER-02/05` | contagem de "Carregando CTOs" ≠ 0 |
| `S3` | indicador volta ao fluxo do documento | `LOADUX-01..06` | `mapa mudou de posição durante o refresh: 310 → 360` |
| `S4` | sem leitura volta a oco, sem halo | `VIS-03`, `UNKNOWNVIS-01..06` | `fill` voltou a `none` |
| `S5` | URGENT aberta não destaca | `URGCLIENT-01/03b/07` (Vitest), `URGCLIENT-04` | flag falsa no Carlos |
| `S6` | HIGH destaca como urgente | `URGCLIENT-03` (Vitest), `URGCLIENT-04` | Lucas com anel e selo |
| `S7` | urgente FECHADA destaca (predicado de aberta some) | `URGCLIENT-02`, `CUSTMAP-09b`, `CTOSUM-01..05` | contagens erradas |
| `S8` | urgência pinta o miolo de vermelho | `URGCLIENT-04` | `Carlos deveria continuar verde: rgb(185, 28, 28)` |
| `S9` | popup da OS volta a 430px | `OSPOP` | `centro: o popup passou da borda do mapa` |
| `S10` | conectividade some do popup da OS | `OSPOP2`, `LAYER-10/11` | `a conectividade não está à vista` |
| `S11` | popup da OS sem `autoPan` | `OSPOP` | `o popup passou da borda do mapa` |
| `S12` | popup da CTO volta ao espaço vazio | `CTOPOP-01` | `popup com 293px` |
| `S13` | popup da CTO com respiro esquerdo curto | `CTOPOP-08` | `esquerda: o popup ficou debaixo de o zoom` |
| `S14` | popup da CTO com respiro de topo curto | `CTOPOP-07/09` | `direita: o × está coberto` |
| `S15` | altura do mapa volta a 400 | `UXP-01/01b` (Vitest), `MAPHEIGHT-01` | `altura do mapa` |
| `S16` | painel de edição sai do mapa | `EDITUX-01` | `o painel escapou do mapa` |
| `S17` | entrar em edição não chama `panInside` | `EDITUX-03` | `fundo-esquerda: a caixa ficou debaixo do painel` |
| `S18` | o retângulo do painel deixa de ser evitado | `EDITUX-03` | `fundo-esquerda: a caixa ficou debaixo do painel` |
| `S19` | tempo mínimo visível volta a zero | `LOADFLICKER-05/09` (Vitest), `LOADFLICKER-02/05` | `sumiu cedo demais` |

**`S15` não aplicou na primeira volta**, e a culpa foi do script: a âncora
ainda tinha os `420/460` da primeira versão da altura, trocados por `410/440`
depois de escrevê-lo. Corrigida a âncora, caiu nos dois detectores.

**`S17` e `S18` caem no MESMO caso**, "fundo-esquerda", e é o esperado: sem
`panInside` a caixa fica onde o `autoPan` a deixou, e sem o retângulo do
painel o `panInside` a considera dentro dos respiros e não a tira de baixo
dele. O que os separa é o "direita" e o "fundo": com `S18` esses dois ainda
passam.

---

## 46. Fechamento — `CTO-3.2.2e` APPROVED · Mapa Operacional V1 FROZEN

> **2026-09-12. Documentação apenas** — zero código, zero teste, zero
> migration, zero schema, zero rota.

```text
CTO-3.2.2e                  APPROVED — validada pelo dono na interface real
Mapa Operacional V1         FROZEN
CTO-3.2.2f                  não existe
```

**O dono validou a `CTO-3.2.2e`** e, com ela, o mapa inteiro: as três bases,
zoom, pan e vista persistida; as três camadas e o filtro de clientes; os
marcadores de CTO e de OS, com a OS urgente; o cliente online, offline, sem
leitura, com OS aberta e com OS urgente; o primeiro nome no mapa e os rótulos
sumindo de longe; os três popups, inclusive perto das bordas; o clique
individual entre entidades próximas; o indicador de carregamento sem flicker
relevante; o ajuste de posição da CTO — entrar, cancelar, salvar e recarregar;
chips de resumo, legenda, hierarquia e resposta ao zoom. Segurança, tenancy e
permissões preservadas; conectividade e OS pelas autoridades que já existiam;
nenhuma regressão observada.

**A implementação do mapa web está congelada para a V1.** O contrato aprovado
foi sincronizado no PRD: §364–§379 descrevem o comportamento real, as decisões
que mudaram estão marcadas `DECISION UPDATED` e indexadas em §390, e o contrato
consolidado está em **PRD §392**. O critério contra o feature creep é a **PRD
§393**: ideia nova de mapa vai para o backlog; o código do mapa só reabre por
**correção crítica de defeito**.

**Esta nota técnica não foi reescrita.** As seções §34–§45 descrevem o estado no
momento de cada entrega e continuam sendo a casa das medições que o PRD, de
propósito, não carrega — tamanhos, alturas, tempos do indicador, respiros de
popup, tetos, empilhamento e as armadilhas de teste. Onde um número mudou numa
fase seguinte, **a seção mais recente vence** (a faixa de altura do mapa, por
exemplo, é a da §45, não a da §42).

Pendências que atravessam o freeze, **nenhuma bloqueante**:

```text
CTO ↔ cliente na mesma coordenada exata    decisão do dono, aberta (PRD §371)
degrau de altura maior em telas altas      avaliado; custaria parte da legenda
                                           abaixo da dobra — decisão do dono,
                                           não tomada (§45)
popup do cliente                           mantém o espaçamento padrão do
                                           Leaflet — aprovado como está (§45)
seleção de cliente e de OS                 não existe; a seleção do mapa é de
                                           caixa (§43)
CTO-3.3 · 3.4 · CTO-6 · CTO-7              fora do mapa web; seguem sob a §119
```

**Backlog registrado no mesmo fechamento, sem código:** a Central de Retenção e
Recuperação — inadimplência, patrimônio em risco, recolhimento, risco de churn,
cobrança e WhatsApp — é a **PRD Parte XVII (§394–§401)**. Ela não é fase desta
especificação, não tem versão atribuída, e **não** acrescenta camada ao mapa
congelado (PRD §401).

---

## 47. `RC-1D` — os clientes da caixa na tela da CTO (observabilidade, só leitura)

**Melhoria aprovada pelo dono na abertura da `RC-1D`.** A tela da CTO respondia
bem *"como estão as portas?"* e mal *"como estão os clientes desta caixa?"*.
Agora, ao abrir a caixa, o `ADMIN` vê o resumo de clientes — ativos, online,
offline, sem leitura e OS abertas — e, em cada porta ocupada, o cadastro ao lado
da conectividade, a idade da última leitura e quantas OS abertas o cliente tem.

**Isto NÃO é autoridade de rede nova.** Nada foi persistido, nada foi
recalculado e nenhuma decisão de conexão, ocupação, capacidade ou movimentação
mudou. A fase é de **apresentação**.

### 47.1. As autoridades reusadas — não copiadas

```text
resumo        getCtoOperationalSummaries   a MESMA função do popup da caixa
por porta     getCtoPortCustomers          a MESMA função de "Ver clientes"
conectividade CustomerDiagnosticSnapshot   pela leitura em LOTE (§370 da PRD)
OS aberta     OPEN_SERVICE_ORDER_STATUSES  o predicado derivado dos terminais
portas        summarizePortCounts          livre e ocupada, como a CTO-2.2 conta
```

`src/lib/cto-client-connectivity.ts` só compõe as duas leituras; a semântica é a
da **PRD §372**: "clientes ativos" são os de cadastro ativo com vínculo ativo na
caixa, e online, offline e sem leitura contam **esses**. Por isso o detalhe e o
popup não têm como divergir — um teste compara os dois número a número, e outro
compara as contagens dos filtros com as do resumo.

`UNKNOWN` é **"Sem leitura"**, nunca "Offline" e nunca "Desativado": ausência de
leitura não é estado do link, e estado do link não é situação cadastral. Não
existe `STALE`, e a idade sai de `observedAt` pelo formatador único
(`connectivityAge`).

### 47.2. O que a tela não faz

* **não chama provider**: abrir a caixa é leitura de banco. Um teste espia o
  `fetch` e outro lê o fonte — de `customer-diagnostics` só a leitura em lote é
  usada, e o grafo de import alcançar `src/integrations` é fato medido e
  declarado (a leitura e a atualização moram no mesmo módulo);
* **não escreve**: um retrato de snapshot, vínculo, porta, CTO, OS e auditoria é
  comparado depois de duas aberturas;
* **não consulta por cliente**: as consultas são constantes — duas portas ou
  seis custam as mesmas leituras;
* **não amplia acesso**: a tela continua `ADMIN` com a capability de rede, na
  ordem capability → perfil da `CTO-1`; o `DISPATCHER` segue sem ela.

### 47.3. Os filtros, em duas unidades

```text
PORTAS     Todas · Livres · Ocupadas            conta POSIÇÃO
CLIENTES   Online · Offline · Sem leitura ·     conta CLIENTE ATIVO
           Com OS aberta
```

Locais, sobre o que a página já trouxe — filtrar é apresentação, e o servidor já
decidiu o que aquela pessoa pode ver. As duas unidades nunca viram parcelas da
mesma soma (PRD §373), e cada contagem de filtro é igual à do resumo que ela
espelha. **Porta livre não tem conectividade** e nunca diz "Sem leitura".

### 47.4. Estado nunca é só cor

Cada selo tem glifo, rótulo em texto e tom — a mesma regra do marcador do mapa.
Os botões de filtro carregam `aria-pressed`, funcionam pelo teclado e mostram
foco; a lista anuncia "Mostrando N de M portas".

### 47.5. O mapa continua `FROZEN`

O popup aprovado **não foi redesenhado**. A única mudança no código do mapa na
`RC-1D` é a correção do `MAPEDIT` intermitente (§47.6), que é defeito provado.

### 47.6. `MAPEDIT` — a caixa que voltava sozinha

O E2E intermitente registrado em `docs/MASTER-PLAN.md` §12 tinha **uma** causa
para os dois sintomas (painel com par novo e marcador no ponto gravado; Salvar
gravando o ponto de antes do arrasto): o react-leaflet 4 reposiciona um marcador
quando a prop `position` muda de **referência**, e o array era recriado a cada
render. Toda releitura do recorte que chegasse entre o último movimento do mouse
e o soltar chamava `setLatLng(par gravado)` no marcador que estava na mão, e o
`dragend` lia o ponto antigo de volta.

Reproduzido sem sorte (`MAPEDIT-15`): a resposta de `/api/ctos/map` é segurada
pela rota e liberada com o botão ainda apertado — desvio 0 no código antigo.
A correção é `stablePosition`: o mesmo array enquanto o par não muda, então só
movimento real chega ao Leaflet. E, no sucesso do salvamento, a camada aplica o
par que o **servidor** devolveu antes de limpar o rascunho (`MAPEDIT-16`), em
vez de deixar a caixa voltar ao ponto antigo até a releitura chegar.

---

## 48. `RC-1D` — a tela enxuta da CTO, e o `DIAG-AUTO-1`

**Validação do dono sobre a §47:** o conceito de conectividade foi aprovado, a
organização visual foi reprovada — e junto veio uma lacuna operacional real,
que virou a fase `DIAG-AUTO-1`.

### 48.1. O que saiu da tela

O card **"Clientes"** foi removido inteiro. Ele repetia, num bloco grande no
topo, números que a lista de portas já carrega linha a linha, e no celular
empurrava as portas — a informação que a pessoa veio ver — para baixo da dobra.

O resumo rápido continua existindo onde ele é rápido: o **popup da caixa no
mapa**, que o dono aprovou e que não foi tocado (`FROZEN`).

Com o card fora, a leitura do resumo virou consulta morta e saiu junto:

```text
antes   6 consultas por abertura (resumo + lista)
depois  3 consultas — só a lista
```

A garantia de que detalhe e popup não divergem **não** saiu com ela: virou um
teste mais forte. Antes, os dois lados vinham da mesma chamada e concordar era
tautológico; agora `CTO-CONSIST-01` compara as contagens derivadas da lista com
as de `getCtoOperationalSummaries` — a autoridade do popup —, número a número.

### 48.2. A hierarquia da porta

```text
01  [Ocupada] [Online] [Cadastro inativo] [Leitura desatualizada]
    NOME DO CLIENTE
    Online há 9 d · Verificado há 2 min   [1 OS aberta]
    [ações]
```

Três decisões:

* **ocupação e conectividade na MESMA linha.** São lidas juntas; a
  conectividade estava três linhas abaixo, depois do nome. A prova é
  geométrica, não estrutural — `UX-02/03` compara o topo dos dois selos em
  1280 px e em 375 px, e pega quem os separe de novo mexendo só no CSS;
* **"Cadastro ativo" deixou de ser dito.** O normal não se anuncia; repetido em
  oito linhas, competia com o que muda. Só a exceção aparece, e ela é
  **"Cadastro inativo"** — o que o dado realmente diz. Não existe "cancelado"
  nem "suspenso" no modelo, e inventá-los a partir de um booleano seria afirmar
  um estado de contrato que ninguém gravou;
* **porta livre continua sem conectividade**, e nunca diz "Sem leitura".

Os filtros viraram **uma faixa** que quebra linha. As duas unidades continuam
separadas — porta conta posição, cliente conta cliente (PRD §373) —, agora por
um traço fino em vez de dois blocos titulados.

### 48.3. `DIAG-AUTO-1` — duração não é frescor

O dono viu *"Online · última leitura há 9 dias"* e apontou o que isso não
prova. A correção tem duas metades, e a segunda é a que sustenta a primeira.

**A metade visível:** a tela passou a dizer as duas coisas.

**A metade que a torna possível:** `observedAt` responde *"quando conferimos"* e
é reescrito a cada verificação bem-sucedida — inclusive quando nada mudou. Com
o ciclo automático rodando de cinco em cinco minutos, derivar duração dele faria
todo cliente parecer ter mudado de estado agora há pouco. Entrou `statusSince`,
que só anda quando `connectivityStatus` muda.

```text
observedAt   quando conferimos pela última vez
statusSince  desde quando o estado ATUAL começou
```

**Não é uma segunda autoridade de estado.** O estado continua sendo
`connectivityStatus`; a coluna só data a transição dele. A regra inteira mora
numa função pura e exportada (`resolveStatusSince`), que é o ponto exato onde um
descuido reiniciaria toda duração da tela — e é ela que os testes atacam
diretamente.

**Migration aditiva, backfill conservador:** linha legada nasceu com
`statusSince = observedAt`, porque é o único instante em que se SABE que o
estado já era aquele. O começo real pode ser anterior, ninguém o registrou, e
inventar uma data mais antiga seria afirmar uma duração que nunca foi medida.

### 48.4. O ciclo, e o que ele não é

**Não é um daemon, e não é um segundo worker.** O repositório inteiro não tem
agendador: o worker do outbox é um lote único chamado por cron do operador, e é
esse o padrão que `npm run diagnostics:refresh` segue — mesmo `tsconfig.worker.json`,
mesmo `logServerError`, mesma disciplina de log só com contagens.

**Consequência declarada:** a cadência de 5 minutos depende de alguém agendar o
comando. Sem isso nada se atualiza sozinho — e a tela **avisa**, porque a
verificação envelhece e o selo "Leitura desatualizada" aparece. O sistema
envelhece em público em vez de afirmar um estado que ninguém confirmou.

> **`DIAG-AUTO-1 code complete` · `production scheduler activation PENDING`.**
> Não existe agendador em lugar nenhum do repositório — nem Dockerfile, nem CI,
> nem Procfile, nem cron versionado —, e a infraestrutura de produção é decisão
> aberta do dono desde a `RC-1A`, ao lado do storage de produção. O contrato
> está escrito em `.env.example`; o caminho real do deploy só existe quando o
> ambiente existir. **Enquanto ninguém agendar, a produção não verifica nada
> automaticamente**, e afirmar o contrário seria descrever um sistema que não
> está no ar.

### 48.4.0. O que é configurável, e o que é decisão

**A política vive num módulo só** — `src/lib/connectivity-policy.ts` —, e são
DUAS grandezas distintas:

```text
DIAGNOSTICS_REFRESH_TARGET_MS   de quanto em quanto RECONFERIMOS   padrão  5 min
DIAGNOSTICS_STALE_AFTER_MS      quando a confirmação está VELHA    padrão 10 min
DIAGNOSTICS_REFRESH_BATCH_LIMIT teto por execução                  padrão 300
DIAGNOSTICS_REFRESH_CONCURRENCY chamadas simultâneas               padrão 6
constante   CONNECTIVITY_REFRESH_LEASE_MS   60 s
pré-existente DIAGNOSTIC_TIMEOUT_MS         8 s, por chamada
```

**O ciclo e a tela leem as DUAS primeiras do mesmo lugar**, e isso corrige uma
divergência real que a fase anterior tinha declarado como limitação: o worker
obedecia à variável de ambiente e a tela derivava o limiar de uma constante
compilada. Um operador que alongasse o alvo para 15 minutos veria a tela avisando
aos 10 — certa sobre o contrato e errada sobre aquele ambiente, sem nada no
código denunciando a divergência.

**A tela não decide nada.** O read model entrega `verificationIsStale` já
resolvido no DTO por porta; nenhum componente compara idade com limiar. Um teste
lê o fonte do módulo de apresentação e exige que ele não conheça limiar nenhum.

Valor inválido — não numérico, zero, negativo, fracionário ou absurdo (acima de
24 h) — **derruba a subida**, em vez de virar padrão silencioso. E o limiar do
aviso **não pode ser menor que o alvo**: se fosse, toda verificação nasceria
atrasada, o aviso perderia sentido e a operação aprenderia a ignorá-lo. É uma
relação entre as duas, então só pode ser conferida onde as duas existem juntas.

A reserva **não** é env: ela precisa ser maior que o deadline de uma chamada
(8 s) e muito menor que o alvo, e expor esse número convida um valor que quebra
os dois lados de uma vez. O deadline por chamada é pré-existente e compartilhado
com o refresh manual da OS — mexer nele mudaria comportamento já aprovado.

### 48.4.1. O que evita a rajada — e o que NÃO existe

O objetivo é não disparar 600 chamadas às 10:00:00. O que impede isso:

```text
teto por execução      no máximo 300 conexões por volta (configurável)
concorrência limitada  no máximo 6 chamadas ao provider ao mesmo tempo
fila compartilhada     N trabalhadores puxam do mesmo ponteiro até acabar
```

A chamada 601 nunca existe numa volta, e a sétima chamada simultânea nunca
existe: o ciclo é uma **janela deslizante de seis**, não um disparo em bloco.

**O que NÃO existe, e não deve ser descrito como se existisse:** não há
*jitter*, não há distribuição por *buckets* de hash, não há horário-alvo por
cliente. A distribuição é consequência da concorrência limitada, e só.

**Ciclo anterior ainda rodando:** o novo simplesmente encontra menos trabalho —
quem já foi verificado saiu da faixa de elegibilidade, e quem está reservado é
pulado (contado em `claimedByOther`, que é trabalho de outro ciclo, não trabalho
perdido).

**Elegibilidade é conexão física, não cadastro.** Quem entra tem
`CustomerNetworkConnection` ativa. `Customer.active` **não** filtra: um cliente
cadastralmente inativo que continua ligado é exatamente o caso que a operação
precisa enxergar, e ignorá-lo esconderia equipamento em campo.

**Nenhuma escrita própria.** O ciclo chama o MESMO `refreshCustomerDiagnostic`
do botão da OS, então falha de provider continua não escrevendo nada — nem
estado, nem `observedAt`. É por isso que a tela consegue dizer *"Online há 5
dias · Leitura desatualizada · verificado há 37 min"* em vez de inventar um
estado novo.

### 48.5. Duas coisas foram MEDIDAS antes de serem afirmadas

**Dois ciclos simultâneos duplicavam o trabalho inteiro.** Sem reserva, cada um
processou as seis conexões elegíveis — doze chamadas ao provider para seis
clientes. A elegibilidade sozinha não protege: os dois leem a lista antes de
qualquer escrita.

Entrou `claimCustomerForCheck`, um `updateMany` com o prazo no predicado — o
mesmo compare-and-set que o outbox usa para reivindicar evento, e não um
mecanismo novo. O prazo existe para que um processo morto devolva o cliente à
fila em vez de trancá-lo.

**A janela do PRIMEIRO diagnóstico foi fechada, e ela também foi medida.** Quem
nunca foi verificado não tem snapshot, logo não tinha onde ser reservado: dois
ciclos simultâneos chamavam o provider **duas vezes** para o mesmo cliente
(`processed=1` nos dois, duas chamadas, um snapshot). O banco ficava coerente — e
é por isso que nenhuma asserção sobre estado final via o defeito. O que o
denuncia é contar **chamadas ao provider**, que é a única grandeza perdida.

A arbitragem é um **advisory lock do Postgres** (`pg_try_advisory_xact_lock`), o
mesmo mecanismo que `lockStock` já usa neste repositório, e **nenhuma coluna
nova**:

* **fabricar um snapshot para ter onde travar foi recusado** — um registro com
  `UNKNOWN` criado só para isso afirmaria uma observação que não aconteceu, e
  `CustomerDiagnosticSnapshot` significa "isto foi observado";
* `IdempotencyRecord` foi avaliada e não serve: exige `userId` não-nulo (o ciclo
  não tem sessão) e memoriza o sucesso para replay — o oposto do que uma
  verificação periódica quer;
* a variante **`xact`** é deliberada: solta no commit e na queda da conexão, de
  modo que um ciclo que morra **não deixa ninguém trancado** — sem prazo, sem
  expiração, sem estado preso. É também a variante que sobrevive a pooler em
  modo transação.

**O preço, declarado:** a transação fica aberta durante a chamada ao provider, no
máximo o deadline dela (8 s). Vale só para a **primeira verificação de cada
cliente**, uma vez na vida dele; do segundo ciclo em diante existe snapshot e a
reserva por coluna assume, sem segurar transação nenhuma. `try` e não `lock`:
quem perde a disputa volta na hora, sem bloquear.

**Capacidade, com 600 conexões elegíveis:**

```text
seleção           85 ms · 2 consultas (nunca uma por cliente)
ciclo (conc. 6)   6,9 s para 600 · 5.252/min
ciclo (conc. 12)  5,1 s para 600 · 7.095/min
```

**Estas medições são SINTÉTICAS, e a distinção não é detalhe.** O provider foi o
`MockERPAdapter`, em processo, com 10 ms de latência simulada. Elas provam
**banco, seleção, reserva, concorrência e overhead de orquestração** — e **não**
provam 600 chamadas reais a um ERP em 6,9 s. Quem ler o número solto concluirá a
segunda coisa, que é falsa.

**A capacidade do provider real NÃO foi medida** (`PROVIDER CAPACITY — NOT YET
MEASURED`). O único provider configurado no ambiente é o **ReceitaNet de
produção de um provedor real**; não existe sandbox, e disparar carga contra ele é
decisão do dono, não iniciativa de implementação. Consequência: **concorrência 6
é configuração inicial conservadora, não capacidade comprovada**, e a calibração
fica para a `RC-1F`/piloto.

A conta que substitui o benchmark ausente é direta. Com concorrência `C` e
latência média `L` por chamada, um ciclo de `N` clientes leva ≈ `N × L / C`:

```text
600 clientes · concorrência 6 · janela de 300 s
latência média máxima para fechar o ciclo:  300 × 6 / 600 ≈ 3 s por chamada

L = 1 s   →  ~100 s      cabe
L = 2 s   →  ~200 s      cabe
L = 3 s   →  ~300 s      no limite
L = 5 s   →  ~500 s      NÃO cabe
L = 8 s   →  ~800 s      NÃO cabe (8 s é o deadline de cada chamada)
```

**Isto é estimativa, não benchmark.** Se a latência real ficar acima de ~3 s, as
saídas são de operação e estão previstas: subir a concorrência, encurtar o
intervalo do agendador, ou aceitar cadência maior que o alvo — e o comando já
avisa no log quando o teto foi atingido e sobrou trabalho.

### 48.6. A tela aberta acompanha o ciclo

`/ctos/[id]` relê a cada 45 s pelo MESMO `router.refresh()` de toda ação da
página: o server component roda de novo e as props chegam novas. Nenhum endpoint
novo, nenhum polling contra API própria e **nenhuma chamada a provider** — o
navegador continua lendo só o snapshot já gravado.

O mapa não precisou de nada: ele já relê o recorte a cada `moveend`/`zoomend`
com 350 ms de debounce, e o snapshot novo entra na leitura seguinte.

### 48.7. Validação do dono — os dois últimos ajustes

A validação manual deu `PASS` para a CTO no desktop, os filtros, a organização
das portas, o layout das portas no celular e o popup do mapa. Dois ajustes
foram aprovados, e os dois são de apresentação — nenhuma contagem, campo,
política ou migration mudou.

**A copy do aviso de frescor virou "Leitura desatualizada".** "Verificação
atrasada" soava como tarefa atrasada de alguém. O novo texto diz o que o aviso
é: o último estado conhecido existe e não foi confirmado recentemente — não é
offline, não é queda, não é falha confirmada. Internamente continua
`verificationIsStale`, decidido no servidor pela política de frescor.

**O card "Ocupação" ficou compacto só no celular.** Cinco blocos de duas linhas,
dois a dois, mais a frase sobre categorias que se sobrepõem, empurravam a lista
de portas para baixo. Agora a linha principal é capacidade · ocupadas · livres,
e reservadas · danificadas vão numa linha menor, com rótulo e número lado a
lado. Medido na caixa de 10 portas do E2E: o card foi de **306 px para 138 px**
em 375 e 390 px, e a primeira porta subiu de `y=731` para `y=563`. No desktop
nada mudou — **154 px** de card e a primeira porta em `y=455`, antes e depois —,
e `sm:order-*` preserva a ordem visual aprovada.

A frase sobre categorias sai da **tela** no celular e **não** do leitor de tela
(`sr-only`, nunca `hidden`): para quem ouve os números, é ela que explica uma
soma maior que a capacidade. A ordem do DOM é a do celular, que é também a de
leitura, e cada número continua num par `dt`/`dd`.

Testes: `STALE-COPY-01` (Vitest, varredura das telas; e E2E), `OCC-MOB-01/02/03`
em 375 e 390 px e `OCC-DESK-01` em 1280 px.

### 48.8. "Sem leitura" é só o texto

Nota do dono: o selo dizia **`? Sem leitura`**, e o `?` saiu. Online e Offline
precisam do glifo (`●`, `×`) porque duas palavras curtas em cores vizinhas se
confundem de relance; "Sem leitura" não tem par com que se confundir — o texto
já é o sinal, e o `?` só repetia a dúvida. Por isso ele virou **`null`**, e não
outro símbolo.

**A regra mora na tabela única** (`CONNECTIVITY_PRESENTATION.UNKNOWN.glyph =
null`, `src/lib/connectivity-presentation.ts`). O selo não é componente
compartilhado — cada tela monta o seu —, mas todos leem o glifo dali:

| Selo | Onde |
|---|---|
| detalhe da CTO, desktop e celular | `CtoDetailManager.tsx` |
| popup do cliente e popup da OS | `OperationalMarkers.tsx` |
| "Ver clientes" da caixa | `CtoMapLayer.tsx` |
| coluna de conectividade | `clientes/page.tsx` — só mostra o recorte OFFLINE, então nunca exibiu `UNKNOWN` |

**Os três do Mapa Operacional foram incluídos por decisão explícita do dono**,
com o mapa `FROZEN`: a mudança neles é só a guarda do glifo, e o "Ver clientes"
é a MESMA lista da tela da CTO (`getCtoPortCustomers`) — sem isso, os mesmos
clientes diriam "Sem leitura" numa tela e "? Sem leitura" na outra. **Não
mudou:** `UNKNOWN`, `connectivityStatus`, rótulos, filtros, contagens, tom
`neutral` e cores, autoridade do diagnóstico, e os marcadores do mapa — que
carregam `UNKNOWN` pela **forma** (tracejado), nunca por este glifo. Os glifos
da caixa (`+ 0 ! ×`, PRD §367) são outra tabela e não foram tocados.

**A armadilha: `null` desenhado compila.** `<span aria-hidden>{null}</span>`
some com o caractere e deixa o span vazio, e o `gap` do `inline-flex` continua
empurrando o texto — um espaço fantasma que nenhum tipo acusa, porque `null` é
`ReactNode` válido. Todo ponto guarda o glifo (`{glyph && (...)}`), e os testes
afirmam a **ausência do span**, não só a do caractere.

Testes: `NOGLYPH-DATA-01/02/03` (o dado; online e offline mantêm glifo e tom),
`NOGLYPH-STRUCT-01/02` (varredura: todo selo de conectividade guarda o glifo, e
a varredura prova que enxergou os selos), `UX-09` (tela da CTO em 1280 e 375 px)
e `NOGLYPH-01` (popups da OS e do cliente no mapa). Os dois E2E têm **controle
positivo** — o selo com leitura precisa continuar com o glifo, senão "zero spans"
passaria também com um seletor cego.

Nove sabotagens, nove detectadas, cada uma pelo teste que existe para ela:
devolver o `?` derruba o dado e os dois E2E (`Received: "?Sem leitura"` — o
defeito do dono, em número); tirar a guarda da CTO derruba a varredura e **só**
o `UX-09`; tirar a do popup, a varredura e **só** o `NOGLYPH-01`; tirar a do
"Ver clientes", **só a varredura** — limite declarado: a caixa da fixture do
mapa não tem cliente `UNKNOWN`, e pôr um mudaria as contagens congeladas da
`LAYER-13/14`; zerar o glifo do Online e mudar o tom do `UNKNOWN` derrubam o
dado.

**Um teste meu era instável, e a causa foi provada:** o controle do popup do
cliente clicava o cliente ONLINE, que na fixture está na **mesma coordenada da
"CAMADA CAIXA"** — 2 de 4 execuções morriam com `CAMADA CAIXA … intercepts
pointer events`. É o empate CTO↔cliente que segue aberto (PRD §371). O controle
passou a ser o cliente OFFLINE, afastado: 6 de 6. Antes da troca, essa
instabilidade chegou a parecer detecção numa sabotagem que não tocava o mapa.

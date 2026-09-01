# AlfaOS — CTOs e Rede de Distribuição: especificação técnica

Detalhamento da capability aprovada no PRD **Parte XIII (§333–§341)**.

Mora aqui, e não no PRD, pelo mesmo motivo que `DISPATCH-QUEUE.md` e
`FIELD-API.md` moram fora dele: o PRD é **visão de produto**, e modelo de
dados, concorrência de porta, matriz de teste e fases são engenharia.

> **Nada disto existe em código.** Nenhuma migration, nenhuma entidade, nenhuma
> rota, nenhuma tela. Este documento é o que uma futura fase de implementação
> executaria — e ela **não é a próxima**: a sequência `DQ` da fila operacional
> vem antes (PRD §341).

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

`NÃO criar migration.` Proposta para uma futura fase de planejamento.

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
  number               posição, 1..capacity
  state                LIVRE · OCUPADA · RESERVADA · DANIFICADA
  notes                opcional

CustomerNetworkConnection
  companyId
  customerId
  ctoPortId
  serviceOrderId       a OS que criou o vínculo, quando houve uma
  technicianId         quem instalou
  equipmentId          a ONT, quando houver vínculo autoritativo
  connectedAt
  disconnectedAt       NULO enquanto ativo
  source               FIELD · WEB · IMPORT
  reason               opcional, na desconexão
```

`companyId` repetido em toda linha segue a convenção do projeto
(`ServiceOrderExecution`, `TimeEntry`, `TechnicianDispatchQueueEntry`): permite
filtrar tenant **num predicado SQL** em vez de navegar a FK até a CTO.

---

## 4. A porta é o ponto de concorrência

Dois técnicos, dois celulares, a mesma `CTO A16 / porta 4`, no mesmo minuto. É
o caso realista, não o exótico: duas instalações no mesmo condomínio saem
juntas.

### O que garante a exclusividade

```text
unique parcial: (ctoPortId) WHERE disconnectedAt IS NULL
```

Uma porta com vínculo ativo não aceita um segundo. É o **banco** que arbitra —
não uma checagem de aplicação, que perde a corrida por construção.

> Postgres suporta unique parcial; o Prisma não a modela em `@@unique`. A
> implementação futura escreve o índice no SQL da migration, como o projeto já
> faz com o CHECK de identidade externa da OS
> (`service_orders_external_identity_check`).

**Alternativa se a unique parcial for descartada:** `CTOPort.state` com CAS. É
inferior — o estado da porta passa a ser um segundo lugar que precisa concordar
com a existência do vínculo, e os dois divergem no primeiro rollback parcial.

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

### Capacidade reduzida

Baixar uma CTO de 16 para 8 portas com vínculos ativos em 9–16 **desconectaria
oito clientes por um campo de formulário**.

> Invariante: reduzir capacidade abaixo da maior porta ocupada é **recusado**.
> Liberar aquelas portas é operação administrativa explícita, com auditoria
> própria.

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

## 15. Pendências para o planejamento de implementação

Nenhuma bloqueia a documentação; todas bloqueiam a primeira migration.

```text
C-01  unique parcial no SQL da migration, ou CAS em CTOPort.state?
      (recomendado: unique parcial — o banco arbitra)

C-02  como as capabilities por empresa são armazenadas? Não existe
      infraestrutura de feature flag por empresa no AlfaOS hoje

C-03  o teto de 10/min do diagnóstico serve à CTO, ou a capability
      precisa de limite próprio? Depende de CTO-5 e CTO-6

C-04  potência óptica entra em ServiceOrderCompletionPolicy ou em
      política própria da CTO?

C-05  a ONT vincula por ServiceOrderEquipment ou por entidade de
      inventário? Depende de a v0.10 ter identidade estável do equipamento

C-06  nome da CTO é único por empresa — e o que acontece ao renomear
      uma caixa que já tem histórico?
```

# Execução do Técnico — AlfaOS (v0.3-technician-execution)

Este documento descreve a execução de Ordens de Serviço em campo entregue no
checkpoint `v0.3-technician-execution`: o técnico **inicia** o atendimento e
registra **diagnóstico**, **serviço realizado** e **observações**.

O **fechamento** da OS (fotos, materiais, assinatura, PDF, `COMPLETED`) **não**
faz parte deste checkpoint — ver §9.

## 1. Fluxo

```text
ASSIGNED
 ↓  técnico abre "Minhas OS" → abre a OS
 ↓  INICIAR ATENDIMENTO   (POST /api/service-orders/[id]/start)
IN_PROGRESS               (startedAt gravado, ServiceOrderExecution criada)
 ↓  diagnóstico / serviço realizado / observações
 ↓  SALVAR EXECUÇÃO       (PATCH /api/service-orders/[id]/execution)
IN_PROGRESS               (a OS permanece em atendimento)
```

Salvar a execução **não** muda o status. A OS só sai de `IN_PROGRESS` no
fechamento (v0.4) ou no cancelamento.

## 2. Modelo `ServiceOrderExecution`

| Campo | Papel |
| --- | --- |
| `id` | PK (`cuid`). |
| `companyId` | Inquilino. **Desnormalizado de propósito** — ver §7. |
| `serviceOrderId` | FK para a OS, **`@unique`**: uma execução por OS, garantido pelo banco. |
| `diagnosis` | Texto livre, opcional (`@db.Text`). |
| `workPerformed` | Texto livre, opcional (`@db.Text`). |
| `notes` | Texto livre, opcional (`@db.Text`). |
| `version` | Token de lock otimista **próprio**, independente de `ServiceOrder.version` (§5). |
| `createdAt` / `updatedAt` | Timestamps. |

`onDelete: Cascade` a partir de `ServiceOrder` e de `Company`, consistente com
`ServiceOrderEvent`. Índice `@@index([companyId])`.

Migration aditiva `20260823013205_add_service_order_execution` — cria apenas a
tabela nova, não altera nenhuma tabela existente.

**Nenhum campo extra foi adicionado.** Em particular, o `started_by` citado no
PRD §29 **não** virou coluna: quem iniciou é gravado no evento `OS_STARTED`
(`ServiceOrderEvent.userId` + `metadata.technicianId`) e no `AuditLog`. Como
`IN_PROGRESS` só transiciona para `COMPLETED`/`CANCELLED`, o responsável não
pode mudar depois do início, então o dado derivado não tem como divergir — e
uma coluna a mais teria que ser mantida em sincronia sem nenhum consumidor que
a exigisse.

## 3. Iniciar atendimento (`startServiceOrder`)

Ação **explícita**, não um endpoint genérico de mudança de status. Um endpoint
genérico teria que confiar no estado-alvo enviado pelo cliente e carregar sua
própria matriz de quem-pode-definir-o-quê; iniciar uma OS é um único evento de
negócio, com um ator, um efeito colateral (`startedAt`), um artefato (a
execução) e uma entrada de timeline.

Tudo dentro de **uma transação**:

1. **Resolver o técnico pela sessão**: `session.user.id + companyId →
   Technician`. `technicianId` **nunca** é aceito do cliente como prova de
   ownership (§4).
2. **Elegibilidade** do técnico pela regra única de `src/lib/technicians.ts`
   (§6). Falha → `403` com mensagem acionável.
3. **Carregar a OS** por `id + companyId`. Não existe → `404`.
4. **Ownership**: `order.technicianId === technician.id`. Não é o dono → `404`
   (não `403` — §4).
5. **Transição**: `ALLOWED_STATUS_TRANSITIONS[os.status].includes("IN_PROGRESS")`.
   Falha → `409`.
6. **Compare-and-set**: `updateMany({ where: { id, version: expectedVersion },
   data: { status: "IN_PROGRESS", startedAt, version: { increment: 1 } } })`.
   `count !== 1` → `409`, sem sobrescrever nada.
7. **Criar** a `ServiceOrderExecution` (só o vencedor do compare-and-set chega
   aqui; a constraint `@unique` é o árbitro final).
8. **Criar** o `ServiceOrderEvent` `OS_STARTED`.
9. **Fora da transação**: `logAudit` com `SERVICE_ORDER.STARTED`.

### 3.1. `expectedVersion` é OBRIGATÓRIO

Diferente de `assignTechnician`, onde é opcional por retrocompatibilidade.
Este fluxo é novo — não há chamador legado a preservar — então o lock
fim-a-fim (o que o técnico VIU na tela vs. o que ele clicou) vale desde o
primeiro dia. Corpo sem `expectedVersion` → `400`.

### 3.2. Idempotência de double-click / retry

A escolha do produto é **erro previsível, nunca um segundo start silencioso**:

| Cenário | Resultado |
| --- | --- |
| Repetição **sequencial** (o primeiro clique já commitou) | `409` **"Esta OS já está em atendimento."** — a OS agora lê `IN_PROGRESS` e `ALLOWED_STATUS_TRANSITIONS.IN_PROGRESS` não contém `IN_PROGRESS`, então a guarda de transição recusa com mensagem específica. |
| Requisições **realmente simultâneas** (as duas leram `ASSIGNED`) | Ambas passam pela guarda; o compare-and-set arbitra. O Postgres serializa os dois `UPDATE` no row lock, exatamente uma casa `version: expectedVersion`, a perdedora casa zero linhas → `409` genérico ("modificada por outra requisição"). |

Nos dois casos o resultado observável é idêntico e seguro: **um** `startedAt`,
**uma** execução, **um** evento `OS_STARTED`. Coberto por teste nos dois
caminhos, incluindo a tentativa com versão já atualizada (também `409`).

Optou-se por `409` em vez de um `200` idempotente porque um `200` esconderia do
técnico a informação de que o estado mudou por baixo dele — e, no caso
simultâneo, seria impossível distinguir "minha requisição venceu" de "a do meu
colega venceu" sem inventar um campo de resultado que ninguém consome.

## 4. Ownership

- O técnico da sessão é resolvido **no servidor**: `session.user.id +
  companyId → Technician`. O cliente nunca envia `technicianId`; se enviar, o
  Zod `.strict()` **rejeita a requisição inteira** (`400`).
- Não-dono recebe **`404`, nunca `403`**. `403` confirmaria que a OS existe e
  pertence a um colega — exatamente o fato que um técnico varrendo ids não pode
  aprender. Mesma escolha já feita em `GET /api/service-orders/[id]`.
- Usuário `TECHNICIAN` **sem** registro `Technician` também recebe `404`: sem
  registro ele não pode ser dono de nada, e a resposta não sinaliza se a OS
  existe.
- `ADMIN`/`DISPATCHER` recebem `403` nas duas rotas de escrita: eles leem tudo,
  mas não iniciam nem editam a execução (§8).

## 5. Concorrência e versionamento

Dois locks otimistas **independentes**:

| Lock | Usado por | Motivo |
| --- | --- | --- |
| `ServiceOrder.version` | `start` (`expectedVersion` obrigatório) | Cobre a decisão de iniciar sobre uma leitura da OS. |
| `ServiceOrderExecution.version` | `execution` (`expectedVersion` obrigatório) | Cobre o texto que o técnico está editando. |

Separados de propósito: um despachante mexendo na OS não pode invalidar o
parágrafo que o técnico está digitando, e vice-versa.

O cenário do enunciado é coberto por teste:

> A abre a execução na versão 1, B abre a execução na versão 1, A salva →
> versão 2, B tenta salvar com versão 1 → **`409`**, e o texto de A permanece.

A verificação é em duas camadas: a versão lida na transação é comparada
explicitamente com `expectedVersion` (para que um save obsoleto seja recusado
mesmo quando o payload não mudaria nada), e o `updateMany({ where: { id,
version: expectedVersion } })` continua sendo o árbitro real entre escritores
concorrentes. `count !== 1` → `409`.

Assim como em `ServiceOrder.version`, o predicado **não** pode ser `updatedAt`:
`DateTime` do Prisma mapeia para `timestamp(3)`, então duas escritas no mesmo
milissegundo passariam ambas e uma se perderia em silêncio.

## 6. `Technician.active` — leitura vs. escrita

Se `Technician.active = false` mas o `User` continua autenticável
(`User.active = true`):

| Operação | Resultado |
| --- | --- |
| Abrir `/minhas-os` | **Permitido** (read-only), com aviso no topo. |
| Abrir `/ordens/[id]` da própria OS | **Permitido** (read-only), execução exibida sem formulário. |
| `POST .../start` | **Bloqueado** `403` — *"Seu perfil técnico está inativo. Entre em contato com o responsável."* |
| `PATCH .../execution` | **Bloqueado** `403` — mesma mensagem. |

Se `User.active = false`, a sessão deixa de ser válida e a requisição morre em
`401` antes de qualquer regra de domínio (kill switch existente, não alterado).

**Nada é destrutivo.** Desativar um técnico **não** reatribui, **não** cancela e
**não** apaga histórico: a OS já iniciada continua `IN_PROGRESS`, `startedAt`
permanece, a execução mantém o que já foi escrito e a timeline fica intacta. A
regra bloqueia **apenas escritas novas** — mesma postura já adotada para a
elegibilidade de atribuição.

### 6.1. Regra única, dois vocabulários

A regra de elegibilidade vive em **um só lugar**
(`technicianEligibilityReason`, em `src/lib/technicians.ts`) e devolve um
**código**, não uma frase. Duas tabelas de mensagens consomem esse código:

- `technicianAssignmentIssue` — terceira pessoa, para quem **atribui**
  (ADMIN/DISPATCHER): *"Somente técnicos ativos podem receber OS."*
- `technicianExecutionIssue` — segunda pessoa, para o **próprio técnico**:
  *"Seu perfil técnico está inativo…"*

Uma regra com dois vocabulários, em vez de duas regras que eventualmente
discordam. As telas usam `getTechnicianByUserId(...).executionIssue` — derivado
da mesma função — para trocar o botão pela explicação, de modo que a UI nunca
oferece uma ação que a API recusaria.

## 7. Multi-tenancy

`companyId` é **desnormalizado** em `ServiceOrderExecution` justamente para que
toda leitura e escrita filtre por inquilino **em SQL**, não por navegação de FK:

- Leitura: `getCompanyServiceOrderExecution` consulta
  `where: { serviceOrderId, companyId }`. É uma segunda query deliberada, e não
  um `include` no detalhe da OS — o Prisma não aceita `where` em `include` de
  relação to-one, então um `include` alcançaria a linha só pela FK e a checagem
  de `companyId` degradaria para um `if` na aplicação. Aqui a linha do inquilino
  errado **não é filtrada depois; ela nunca é lida**.
- Escrita: `updateServiceOrderExecution` busca a execução com o mesmo predicado
  duplo antes de qualquer alteração.

Custo: uma busca indexada por ponto numa tela de detalhe. **Não** introduz N+1 —
nenhuma listagem inclui a execução, e a paginação/filtros server-side de
`listCompanyServiceOrders` seguem intactos.

## 8. Timeline e auditoria

| Evento | Timeline (`ServiceOrderEvent`) | `AuditLog` |
| --- | --- | --- |
| Iniciar atendimento | `OS_STARTED` (com `technicianId`, `technicianName`, `startedAt`) | `SERVICE_ORDER.STARTED` |
| Salvar execução | **nenhum** | `SERVICE_ORDER.EXECUTION_UPDATED` |

**Salvar não gera evento de timeline** de propósito: a timeline registra
marcos (criada, atribuída, iniciada), e o técnico pode salvar os mesmos três
campos muitas vezes durante o atendimento — um evento por save afogaria os
marcos reais em ruído.

O `AuditLog` do save registra **apenas os nomes dos campos que mudaram de
valor** (ex.: `campos: diagnosis, notes`), com usuário e data. **O texto livre
nunca é copiado para o log**: a trilha administrativa é lida por pessoas que não
são o técnico, e ela precisa registrar *que* o diagnóstico mudou, não *o que o
diagnóstico diz*. Um save que não altera nenhum valor não gera entrada de
auditoria (evita ruído), embora ainda incremente a versão.

## 9. UI mobile-first

### `/minhas-os`

Ordem de prioridade visual: **"Em atendimento"** (`IN_PROGRESS`) → **"Hoje"**
(`ASSIGNED` agendada para o dia civil de hoje **da empresa** — `Company.timezone`,
nunca o fuso do servidor; `HOTFIX-FIELD-01`) → **"Próximas"**. A seção "Em atendimento" só
aparece quando há algo nela, e vem primeiro porque é a OS que o técnico está
fisicamente executando; todo o resto é planejamento.

Os cards mostram número, cliente, cidade/UF, tipo, horário, prioridade e status.

**Contrato de "Hoje" — definitivo (`HOTFIX-FIELD-01` `APPROVED`, 2026-09-13).**

```text
"Hoje"       o dia civil da EMPRESA
autoridade   Company.timezone → resolveTimezone → civilDayBoundsIn
             (companySliceClock lê o fuso — a mesma autoridade do cartão
             "OS de hoje" do painel, PRD §380)
intervalo    [início do dia, início do dia seguinte)
fuso ruim    ausente ou inválido → o contrato de resolveTimezone (DEFAULT_TIMEZONE)
nunca        fuso do servidor · do navegador · do celular ·
             new Date(ano, mês, dia) dependente do processo · janela fixa de 24 h
```

Implementação: `listServiceOrdersForTechnician` (`src/lib/service-orders.ts`);
prova: `src/tests/minhas-os-today.test.ts` (empresa em `Asia/Tokyo` contra o fuso
do processo, dias de 23 h e 25 h) e `e2e/minhas-os-today.spec.ts`.

**Débito registrado — a semântica de "Próximas". NÃO corrigido.** "Próximas" é,
na prática, *tudo o que está atribuído e não é "Em atendimento" nem "Hoje"*: OS
com agendamento futuro, OS sem agendamento e OS com agendamento **já vencido**.
Na validação do dono em 13/09/2026, a seção mostrou OS agendadas para
06/09/2026 — elas pertencem corretamente à fila, mas não são literalmente
"próximas". Caminhos futuros, **sem decisão**:

```text
A   renomear "Próximas" para "Aguardando atendimento"
B   separar em Atrasadas · Hoje · Próximas · Sem agendamento
C   outra estrutura, definida pela fase correta do fluxo do técnico
```

Referências já escritas, que não decidem nada: a PRD §171 (agenda do técnico no
Field) já separa "Atrasadas" de "Próximas"; e "OS atrasada" já tem definição do
dono na PRD §380 (agendada, vencida, não iniciada) — um recorte de atrasadas
aqui reutilizaria essa regra, nunca uma segunda. **Este débito não reabre o
`HOTFIX-FIELD-01`**, que tratou só o fuso de "Hoje": nome, agrupamento, query e
status de `/minhas-os` ficam como estão até a fase do fluxo do técnico.

### `/ordens/[id]`

- `ASSIGNED` + técnico dono → botão grande **INICIAR ATENDIMENTO** com
  `window.confirm("Deseja iniciar esta Ordem de Serviço?")`.
- `IN_PROGRESS` + técnico dono → **"Status: Em atendimento"**, **"Iniciado às
  HH:MM"** e o formulário (Diagnóstico, Serviço realizado, Observações +
  **SALVAR EXECUÇÃO**), com feedback **"Execução salva."**
- `ADMIN`/`DISPATCHER` → tudo **read-only**: técnico, `startedAt`, os três
  campos e a timeline, sem formulário editável e sem botão de iniciar.

A ação do técnico fica **acima** do grid, não na coluna lateral: no mobile o
grid empilha, e qualquer coisa na coluna da direita cairia depois de
Informações + Cliente + Timeline — a ação principal da tela seria a última
coisa da página.

Detalhes de robustez do formulário:

- O estado dos campos **nunca** é resetado — nem em erro, nem em sucesso. Um
  técnico no corredor do cliente, em rede ruim, não pode perder um parágrafo de
  diagnóstico porque a requisição deu timeout ou voltou `409`.
- Botão desabilitado durante a requisição (+ guarda `if (loading) return`),
  impedindo double-submit — mesmo padrão do `AssignTechnicianForm`.
- A versão usada no próximo save é `max(versão da prop, versão devolvida pelo
  último save bem-sucedido)`. Só a prop não bastaria: `router.refresh()` é
  assíncrono, então dois saves rápidos mandariam a versão pré-save no segundo e
  o técnico entraria em `409` contra si mesmo. Como a versão é monotônica,
  "a maior" é inequívoco e um valor genuinamente mais novo vindo do servidor
  continua vencendo.

## 10. Endpoints

| Método e rota | Perfil | Corpo (`.strict()`) | Descrição |
| --- | --- | --- | --- |
| `POST /api/service-orders/[id]/start` | TECHNICIAN (dono) | `{ expectedVersion }` | `ASSIGNED → IN_PROGRESS` |
| `PATCH /api/service-orders/[id]/execution` | TECHNICIAN (dono) | `{ expectedVersion, diagnosis?, workPerformed?, notes? }` | Salva a execução |

**Não existe endpoint genérico de mudança de status.**

Ambas as rotas aplicam `assertSameOrigin` (CSRF), autenticação, `assertProfile`
e Zod `.strict()`. O `.strict()` **rejeita** (não ignora) `companyId`,
`serviceOrderId`, `status`, `technicianId`, `version`, `createdAt`, `updatedAt`
e `id` — descartar em silêncio faria o chamador acreditar que mudou o próprio
inquilino ou o status e ainda receber `200`. Os textos são limitados a
`EXECUTION_TEXT_MAX_LENGTH` (10.000 caracteres) por campo.

`GET /api/service-orders/[id]` passa a incluir `execution` (ou `null`) e
`startedAt`, para o técnico dono (editar) e para ADMIN/DISPATCHER (ler).

## 11. Dashboard

O KPI **"Em Atendimento"** passou a contar `status = IN_PROGRESS` da empresa da
sessão. Antes contava `ASSIGNED` **e** `IN_PROGRESS`, o que misturava dois
estados operacionais distintos — trabalho apenas entregue a alguém vs. trabalho
sendo feito agora. Até a v0.3 nada alcançava `IN_PROGRESS`, então o número era
na prática "atribuídas" com o rótulo errado.

## 12. Continuação e fora do escopo

O fechamento (`IN_PROGRESS → COMPLETED`, com fotos, materiais e assinatura) foi
implementado na v0.4 — ver `docs/SERVICE-ORDER-CLOSING.md`. Consequência direta
para este documento: uma OS `COMPLETED` deixa de aceitar qualquer escrita do
técnico, inclusive a edição da execução descrita na §5.

Continuam fora do escopo: PDF/comprovante, reabertura/devolução, pausa/retomada,
GPS, estoque, ReceitaNet real, WhatsApp/notificações, OLT, IA e offline
avançado.

**Mapa de Campo do Técnico (`FIELD-MAP-1`)** — conceito aprovado pelo dono em
13/09/2026, `FUTURE` / pós-V1, **não implementado**: `docs/PRD.md` Parte XIX
(§415–§421). Nada muda em `/minhas-os` por causa dele.

## 13. Localização do cliente em campo — contrato da RC-1C

Decisão do dono (RC-1C, 14/09/2026), depois do caso que abriu a fase: um ponto
importado foi **confirmado** por um técnico a ~2,3 km dele e virou "verificado".
O mapa estava certo — ele lê a autoridade, e o ponto não tinha se movido —, mas a
confirmação marcava `verified` sem mostrar a distância, sem bloquear e até sem
GPS. Contrato: PRD §172 (`DECISION UPDATED`); segurança: `docs/SECURITY.md` §8.22.

`CustomerLocation` continua sendo a **autoridade** geográfica, e
`Customer.latitude`/`longitude` a projeção de leitura, sincronizada na mesma
transação de toda escrita. O Mapa Operacional e o cartão do ADMIN leem a
autoridade.

### 13.1. Confirmar (`POST /api/field/v1/service-orders/:id/location/confirm`)

| Regra | Onde |
| --- | --- |
| Exige a posição do aparelho; ausente, pela metade ou inválida → `400` | `requireObservedPosition` |
| Exige a **precisão**: até **50 m**, sobre o valor real (50,1 m não passa); ausente ou zero → `400` — antes da distância (RC-1C-HOTFIX) | `LOCATION_GPS_MAX_ACCURACY_M`, `isGpsAccuracyAllowed`, `requireGpsAccuracy` |
| Distância calculada **no servidor** (haversine, metro inteiro) | `distanceInMeters` (`src/lib/geo.ts`) |
| Limite **100 m, inclusivo**, comparado no metro arredondado que o técnico vê | `LOCATION_CONFIRM_MAX_DISTANCE_M`, `isConfirmDistanceAllowed` |
| Acima do limite → `400` "Você está a X do ponto cadastrado. Use Corrigir localização." — e **nada é gravado** | `confirmCustomerLocation` |
| Confirmar **não move** o ponto nem troca a origem; só `verified = true` | idem |
| Distância vinda do corpo é recusada (`.strict()`) e nunca usada | rota + domínio |

A ordem dentro da transação é a do contrato: técnico → OS dele → OS em
atendimento (`FOR SHARE`, RC-LOC-06) → ponto existe → versão → ainda não
verificado → GPS → **precisão** → distância → limite → escrita. Quem não pode
mexer na OS recebe o 404 genérico da OS antes de qualquer pergunta sobre GPS, e a
regra dos 100 m vem antes da escrita — não existe `verified` gravado para depois
ser desfeito.

**Precisão ≤ 50 m — RC-1C-HOTFIX (15/09/2026).** Até a hotfix a precisão era só
registrada e mostrada; a validação física provou o preço (§13.5), e o dono
aprovou o limite. São duas regras **independentes**: precisão ≤ 50 m **e**
distância ≤ 100 m. Com 220 m de precisão a distância nem é calculada; com 14 m e
1,2 km, a precisão passa e a recusa é a dos 100 m. O limite vigente fica no
`metadata` do evento (`gpsMaxAccuracyMeters`), ao lado do de distância.

**Onde a confirmação fica registrada — sem migration.** A linha de
`CustomerLocationHistory` mantém a assinatura de confirmação (mesmo ponto, de não
verificado para verificado) que a timeline e o pacote técnico reconhecem; os
**números** — distância, precisão, posição do aparelho e o limite vigente — ficam
no `metadata` do evento `LOCATION_CONFIRMED`, gravado na mesma transação. A
posição do aparelho fica no servidor: a leitura da OS
(`getCompanyServiceOrder`) a remove da saída, e as telas mostram a distância.

### 13.2. Corrigir (`.../location/correct`)

* **Com GPS:** o ponto muda — autoridade, trilha com o ponto anterior, técnico,
  OS, instante, precisão, origem `TECHNICIAN_GPS`, `verified = true`, projeção e
  mapa. Desde a RC-1C-HOTFIX, com a mesma exigência de **precisão ≤ 50 m**
  (ausente → `400`); fora dela, `400` e o **endereço do mesmo corpo também não é
  aplicado** — quem mandou coordenada escolheu mover o ponto.
* **Sem GPS:** só o endereço textual; coordenada e `verified` intactos (trilha
  `ADDRESS`, evento `ADDRESS_CORRECTED`).
* **Coordenada digitada (`source: MANUAL`) é recusada** (`400`): moveria o ponto
  e o marcaria verificado sem ninguém ter medido nada. O aplicativo nunca a
  envia.
* **Meia coordenada é recusada** (`400`), em vez de virar correção só de
  endereço com a posição descartada em silêncio.

### 13.3. No aplicativo

"Confirmar localização" primeiro **captura** uma posição dentro do contrato
(§13.5) — "Buscando uma localização precisa…", com a precisão atual e Cancelar —
e só então mostra "Distância da sua posição" e "Precisão do GPS" antes de
perguntar:

* dentro do limite que o **servidor mandou** no pacote
  (`location.confirmMaxDistanceMeters`): "Você está no endereço do cliente?", com
  Confirmar — e a confirmação envia exatamente a posição capturada e mostrada
  (precisão com o valor real) e a versão do ponto medido (se o ponto mudou nesse
  meio-tempo, o servidor responde conflito);
* acima dele: "Você está muito distante do ponto cadastrado. Use Corrigir
  localização.", sem Confirmar, com o botão que leva à correção;
* sem GPS ou com GPS impreciso: a captura diz o motivo e oferece "Tentar
  novamente", e nenhuma medida existe para confirmar.

"Corrigir", com "Usar minha localização atual" ligado, captura no **Salvar**, por
cima da folha: só uma posição dentro do contrato a fecha e vai ao servidor; falha
ou cancelamento deixam a folha aberta com o que foi digitado. O controlador
recusa correção por GPS sem posição válida em vez de transformá-la em correção
só de endereço. Com o interruptor desligado, só o endereço — sem GPS nenhum.
Depois de um comando aceito, o pacote é relido do servidor, e a seção mostra o
estado de lá.

A coordenada do cliente não aparece — só distância e precisão. A conta é a do
servidor, provada pelos mesmos vetores dos dois lados
(`apps/field/test/location_confirm_test.dart` ×
`src/tests/customer-location-confirm.test.ts`). Um servidor sem o campo do
limite deixa a regra inteira com ele: o aplicativo não bloqueia sozinho.

### 13.4. Na web

* **Timeline do cliente (RC-LOC-02):** "Confirmada a 32 m do ponto cadastrado." —
  nunca a coordenada. Confirmação antiga acima do limite de hoje: "…, acima do
  limite de 100 m."; sem GPS: "Confirmada sem a posição do aparelho." A timeline
  da OS (`/ordens/[id]`) continua com o código cru — débito da `RC-1D`.
* **Cartão "Localização do cliente" (RC-LOC-03):** `ADMIN`, somente leitura, lido
  da autoridade — coordenadas, precisão, origem, verificada, atualizada em (fuso
  da empresa), técnico e OS quando houver, e "Ver no mapa" quando a empresa tem o
  Mapa Operacional. Sem ponto: "Sem localização geográfica cadastrada". Projeção
  sem autoridade (legado, RC-LOC-04): a mesma frase, com uma nota, e sem a
  coordenada antiga. **Nenhum campo de latitude/longitude existe para editar.**

### 13.5. A captura de posição — RC-1C-HOTFIX (15/09/2026)

**O defeito da validação física.** No mesmo telefone, o Google Maps pôs o
aparelho no lugar certo e o AlfaOS gravou um ponto a mais de 1 km dali, por
"Corrigir localização" com "Usar minha localização atual". A causa, provada no
aparelho e no banco — não suposta:

1. o AlfaOS Field tinha só a permissão de localização **aproximada** (Android
   12+: `ACCESS_COARSE_LOCATION` concedida, `ACCESS_FINE_LOCATION` negada por
   escolha do usuário); o Google Maps tinha a precisa;
2. o Android entrega posição aproximada deslocada numa grade de ~2 km e com
   precisão de **2000 m** — exatamente o `accuracyMeters` gravado. Duas correções
   no mesmo lugar moveram o ponto 2004 m uma da outra;
3. `Geolocator.getCurrentPosition` (`geolocator` 13.0.4, `geolocator_android`
   4.6.2) responde com a **primeira** posição que o sistema entrega — o plugin
   cancela as atualizações no primeiro retorno —, e nem o aplicativo nem o
   servidor olhavam precisão ou idade.

Coordenada invertida ou alterada no caminho foi descartada pela medida: o ponto
gravado fica a ~1 km dos outros pontos da empresa, e a ~3.000 km se latitude e
longitude estivessem trocadas.

**O contrato da captura** (`apps/field/lib/core/location/operational_position.dart`),
uma só para Confirmar e Corrigir:

| Regra | Valor |
| --- | --- |
| Precisão, sobre o valor real | até **50 m** (o limite do pacote, `gpsMaxAccuracyMeters`; sem ele, 50) — o valor **medido** (`measuredAccuracyMeters`); a bandeira `hasAccuracy` do plugin não serve no Android (RC-1C-HOTFIX-3, §13.7) |
| Idade da leitura | até **10 s**, pelo instante da própria leitura — pode ter nascido antes de a captura abrir (RC-1C-HOTFIX-2, §13.6); no futuro, só até 2 s |
| Espera | ~**20 s**; várias leituras, e a **primeira aceitável** encerra |
| Sem leitura aceitável | falha — a melhor precisão vista vai na **mensagem**, nunca como posição |
| Coordenada | a mesma definição do servidor (`coordenadaValida`) |
| GPS depois da resposta | desligado (o fluxo é cancelado) — nada em segundo plano |
| Última posição conhecida | proibida em `lib/` inteiro (teste estrutural) |
| Log | motivo, idade, precisão e o que o plugin entregou (tipo, `hasAccuracy`, `accuracy` bruta); **nunca** coordenada (teste estrutural) |

**Precisa × aproximada.** Com só a aproximada concedida, a captura pede a
permissão de novo — é o que faz o Android 12+ oferecer "usar localização
precisa" — no momento do toque em Confirmar/Corrigir, nunca na abertura. Recusada,
falha com "Ative Localização precisa para usar esta função." Mesmo que o sistema
dissesse "precisa", a precisão de cada leitura continua sendo o que decide.

**A precisão pedida ao plugin.** `LocationAccuracy.best`, conferido na versão
instalada: no Android, `high`, `best` e `bestForNavigation` viram todos
`PRIORITY_HIGH_ACCURACY` no provedor fundido — trocar o enum não mudaria nada. O
que a hotfix muda é aceitar só a leitura que o contrato aceita. Intervalo de 1 s.

**O servidor não recebe o instante da leitura**, e a hotfix não o acrescentou à
API: a recência é garantida pela captura, e o servidor arbitra o que o corpo traz
— coordenada, precisão, distância, posse e tenant (`requireGpsAccuracy`). Um APK
anterior à hotfix, que ainda envia a posição aproximada, recebe `400` "Precisão
do GPS insuficiente: 2000 m. …".

**O check-in e o ponto não mudaram.** Continuam com `LocationService.current()`:
lá a coordenada informa e nunca bloqueia, e o contrato de precisão não os alcança.

**"Sem localização" depois de corrigir** — a outra pergunta da validação. O banco
mostra que as duas correções gravadas na validação (OS Nº 11) moveram o ponto, e
que a OS em atendimento cujo cliente seguia sem localização (Nº 5) não tem
correção nenhuma gravada: para aquele cliente a seção dizia a verdade. Por que a
tentativa não gravou não dá para provar — recusa do servidor não deixa rastro no
banco, e nem o log do servidor nem o do aparelho daquele momento estavam
disponíveis. O que o código mostra é o que a tela escondia: corrigir lia o GPS
por até 15 s **sem estado nenhum na tela**, e uma falha virava um aviso
passageiro — a seção continuava igual, sem dizer se algo estava acontecendo. A
hotfix dá à captura um estado visível, com cancelar e tentar de novo, e prova
por teste que, depois de uma correção aceita, o pacote é relido e a seção mostra
o que o servidor diz agora.

### 13.6. Frescor pela idade da leitura — RC-1C-HOTFIX-2 (15/09/2026)

**O defeito da segunda validação física.** Com `ACCESS_FINE_LOCATION`
concedida, a localização ligada e o aparelho tendo posições boas (fundida ~27 m,
rede ~16 m, GPS ~11 m), toda captura terminava em "Localização não obtida". O
que o aparelho registrou, lido no `dumpsys` sem nenhuma coordenada:

* o provedor fundido do Google recebeu cada captura como pedido
  `@1s HIGH_ACCURACY` e ligou o GPS em nome do AlfaOS; **cinco das seis
  capturas seguraram o GPS pelos 20 s inteiros** — o prazo — e a sexta foi
  cancelada aos 12 s;
* o provedor marcou o aparelho como **parado** (`device stationary`,
  `engine stationary throttled`) e entregou **13 localizações em todas as
  sessões do AlfaOS** somadas — não uma por segundo;
* a tela dizia "Localização não obtida", e não "Precisão do GPS insuficiente":
  nenhuma das 13 foi contada nem como imprecisa. Foram recusadas como **velhas**.

**A causa, no código.** A regra de frescor tinha duas condições: idade até 10 s
**e** ter nascido no máximo 2 s antes de a captura abrir. A segunda recusava a
posição que o provedor entrega com o aparelho parado — a que ele já tinha,
nascida segundos antes da assinatura —, e com o aparelho parado nenhuma outra
vinha. A matriz de teste reproduziu isso antes da correção: a leitura das
12:00:01 com 18 m, numa captura aberta às 12:00:05, era recusada.

**O contrato do dono.** A leitura serve se tem coordenada válida, precisão entre
0 e 50 m, e **idade até 10 s** — no futuro, até ~2 s. **Quando ela nasceu em
relação à abertura não importa.** Isso não reabre a última posição conhecida
(`getLastKnownPosition` continua proibida): a leitura vem do FLUXO aberto pela
captura, e é a idade dela que decide.

**O relógio do aparelho não era o problema.** Com hora automática, ele estava a
~0,3 s do UTC (medido contra NTP pelo computador), bem dentro da tolerância de 2
s.

**O que NÃO foi provado no aparelho, e como a próxima validação prova.** O
`dumpsys` não registra o instante de cada leitura entregue, então ele não
distingue "nascida mais de 2 s antes da abertura" (corrigido) de "mais de 10 s
de idade" (continua recusado, pelo contrato). A captura passou a registrar, num
build de depuração e **sem coordenada**, uma linha por leitura no `logcat`:

```text
alfaos.gps gps_reading n=1 verdict=accepted ageMs=4210 bornBeforeCaptureMs=3980 accuracyMeters=18.0
alfaos.gps gps_capture outcome=acquired readings=1 bestAccuracyMeters=18.0
```

Com o telefone ligado ao computador durante o teste físico, `adb logcat -s flutter`
mostra por que cada leitura foi aceita ou recusada. Em build de produção, nada
disso é escrito.

> **Corrigido pela RC-1C-HOTFIX-3 (§13.7).** "Foram recusadas como **velhas**"
> não estava provado: o título "Localização não obtida" sai igual para leitura
> velha e para leitura sem precisão. Com a regra de frescor antiga avaliada antes
> da precisão, as leituras nascidas antes da abertura caíam como velhas, e as
> demais como sem precisão. A correção desta seção era real — a matriz a provou —
> e havia uma segunda causa atrás dela, que foi o que este diagnóstico mostrou no
> teste seguinte.

### 13.7. A precisão que o plugin do Android esconde — RC-1C-HOTFIX-3 (15/09/2026)

**O defeito da terceira validação física.** Com o frescor corrigido, o `logcat`
do aparelho mostrou, na captura:

```text
alfaos.gps gps_reading n=1 verdict=noAccuracy ageMs=5059 … accuracyMeters=-
alfaos.gps gps_reading n=2 verdict=noAccuracy ageMs=5039 … accuracyMeters=-
alfaos.gps gps_capture outcome=timeout readings=2 bestAccuracyMeters=-
```

Leituras de ~5 s — dentro do frescor — recusadas só por não terem precisão, com
o sistema medindo de 7 a 27 m (`dumpsys location`, lido sem coordenada: fundida
6,9 m e GPS 16,2 m nesta sessão; fundida ~27 m, rede ~16 m e GPS ~11 m na
anterior).

**A causa, no plugin instalado — não no aparelho.** Lida no código das versões
do `pubspec.lock` (`geolocator` 13.0.4, `geolocator_android` 4.6.2,
`geolocator_platform_interface` 4.3.0):

1. o nativo (`LocationMapper.toHashMap`) só escreve `accuracy` no mapa quando
   `Location.hasAccuracy()` é verdadeiro, com o valor de `Location.getAccuracy()`;
2. a interface 4.3.0 criou `Position.hasAccuracy`, com padrão `false`, e o
   `Position.fromMap` o calcula certo, pela presença da chave;
3. o `geolocator_android` 4.6.2 chama `Position.fromMap` e **reconstrói** a
   leitura em `AndroidPosition.fromMap`, por um construtor que não conhece o
   campo — `hasAccuracy` volta ao padrão.

No Android, **toda** leitura chega com `hasAccuracy == false`, e com o número
medido intacto em `accuracy`. A captura da RC-1C-HOTFIX lia a precisão como
`hasAccuracy ? accuracy : null` e recusava 100% das leituras. É determinístico, e
não condição do aparelho: desde a RC-1C-HOTFIX, nenhuma captura de Confirmar ou
Corrigir podia passar no Android. A combinação de versões é a que as restrições
permitem (`geolocator_android` pede `geolocator_platform_interface: ^4.1.0`), e
nenhuma dependência mudou nesta hotfix. O check-in e o ponto não foram afetados:
`LocationService` lê `accuracy > 0`, e não a bandeira.

**Por que os testes não viram.** Todos os testes da captura entregavam leituras
abaixo da fronteira `PositionSource`, pulando a conversão do plugin — justamente
onde o defeito morava. Medido por sabotagem: a regra antiga, reintroduzida, passa
nos testes da captura que existiam antes e cai nos novos
(`apps/field/test/operational_position_platform_test.dart`), que rodam a
`GeolocatorPositionSource` real sobre a conversão do Android até o corpo das
requisições de Confirmar e Corrigir.

**A correção — sem fonte alternativa.** `measuredAccuracyMeters` decide pelo que
o plugin garante: se a plataforma afirma que mediu, vale o valor como veio (zero,
negativo ou infinito continuam recusados como precisão inválida); se não afirma,
só um número positivo e finito é medida. O `0.0` é a marca de "não mediu" e vira
"sem precisão" — nunca "zero metros de erro", nunca um valor presumido, nunca a
precisão pedida ao provedor. A posição original tinha a precisão; quem a perdia
era a leitura dela. Por isso **não entrou fallback** (`getCurrentPosition`,
`LocationManager`): não havia leitura sem precisão a compensar, e o provedor
fundido continua sendo a fonte. O contrato não mudou — ≤ 50 m, ≤ 10 s, ~20 s — e
o servidor também não.

**O que ainda precisa do aparelho.** Os fatos acima estão provados no código e
em teste que roda a conversão real do plugin. Que as leituras entregues ao
AlfaOS naquele aparelho tragam `accuracy` positivo ainda não está: o `logcat`
antigo já tinha girado. A captura passou a registrar, **antes do juízo**, só em
build de depuração e sem coordenada, o que a plataforma entregou:

```text
alfaos.gps raw_position n=1 sourceMode=primary type=AndroidPosition hasAccuracy=false rawAccuracy=18.0 rawFinite=true rawPositive=true ageMs=5000 timestampMs=…
alfaos.gps gps_reading n=1 verdict=accepted ageMs=5000 bornBeforeCaptureMs=5000 accuracyMeters=18.0
```

`hasAccuracy=false` com `rawAccuracy` positivo é o defeito do plugin, agora lido
certo. `rawAccuracy=0.0` seria uma leitura realmente sem medida: continua
recusada, e só aí a pergunta de uma fonte alternativa volta — com decisão do
dono. `sourceMode` é sempre `primary`, porque não existe outra fonte.

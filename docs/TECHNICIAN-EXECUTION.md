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
(`ASSIGNED` agendada para hoje) → **"Próximas"**. A seção "Em atendimento" só
aparece quando há algo nela, e vem primeiro porque é a OS que o técnico está
fisicamente executando; todo o resto é planejamento.

Os cards mostram número, cliente, cidade/UF, tipo, horário, prioridade e status.

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

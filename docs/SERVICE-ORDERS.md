# Ordens de Serviço — AlfaOS (v0.2-service-orders)

Este documento descreve o núcleo operacional de Ordens de Serviço (OS)
entregue no checkpoint `v0.2-service-orders`.

## 1. Modelo de dados

| Modelo | Papel |
| --- | --- |
| `Customer` | Cliente do provedor, sempre escopado por `companyId`. |
| `Technician` | Técnico vinculado a um `User` da mesma empresa. `userId` é único (um usuário só pode ser técnico uma vez) e `active` controla disponibilidade para atribuição. |
| `ServiceOrder` | OS com `number`, `customerId`, `type`, `description`, `priority`, `status`, origem opcional `externalProvider`/`externalId` (importação ERP). |
| `ServiceOrderEvent` | Timeline imutável da OS (`SERVICE_ORDER_IMPORTED`, `TECHNICIAN_ASSIGNED`, mudanças de status). Gravada na mesma transação das mutações. |

Campos de origem externa (`externalProvider`, `externalId`) não aparecem nos
shapes públicos da API (`toPublicServiceOrder`).

## 2. Máquina de estados

Centralizada em `ALLOWED_STATUS_TRANSITIONS` (`src/lib/service-orders.ts`):

| Estado atual | Estados permitidos |
| --- | --- |
| `PENDING` | `ASSIGNED`, `CANCELLED` |
| `ASSIGNED` | `ASSIGNED` (troca de técnico), `IN_PROGRESS`, `CANCELLED` |
| `IN_PROGRESS` | `COMPLETED`, `CANCELLED` |

Toda mudança passa por essa máquina; o único endpoint de transição
implementado neste checkpoint é a atribuição/troca
(`POST /api/service-orders/[id]/assign`).

## 3. Atribuição de técnico

- Regras: o técnico deve existir, estar **ativo** e pertencer à **mesma
  empresa** da OS. Violação de empresa → `404`; técnico inativo → `400`.
- **Otimistic locking**: a atualização usa
  `updateMany({ where: { id, updatedAt: os.updatedAt } })`. Se `count !== 1`,
  outra requisição modificou a OS → `409` "A OS foi modificada por outra
  requisição. Recarregue e tente novamente."
- A troca de técnico é permitida a partir de `ASSIGNED` e grava novo evento na
  timeline.
- OS + evento de atribuição são gravados na **mesma transação** Prisma.

## 4. Minhas OS (ownership do técnico)

- `GET /api/service-orders` com o perfil `TECHNICIAN` retorna apenas as OS
  atribuídas ao técnico da sessão.
- O `technician_id` é resolvido **no servidor**: `session.userId → user →
  technician`. O cliente nunca envia o vínculo.
- A página `/minhas-os` lista as OS de hoje e as próximas do técnico
  autenticado. Um técnico de outra empresa não enxerga OS locais.

## 5. Integração com Mock ERP

- `MockERPAdapter.listServiceOrders()` expõe três OS de exemplo (#10001 João da
  Silva — Manutenção/HIGH, #10002 Maria Oliveira — Instalação/NORMAL, #10003
  Carlos Souza — Suporte/NORMAL).
- `POST /api/integrations/sync` exige integração habilitada (senão `400`).
- **Idempotência**: a correspondência é feita por
  `companyId + externalProvider + externalId` (cliente via `upsert`; OS via
  `create` numa transação com fallback em `P2002`, para ficar atômica sob
  syncs concorrentes — ver [SECURITY.md §8](SECURITY.md)). Na primeira sync
  criam-se 3 OS; reimportações atualizam dados externos e reportam "0
  criadas, 3 atualizadas" — nunca duplicam, e **não** sobrescrevem
  `status`/`technicianId`/timeline locais, mesmo com duas sincronizações
  simultâneas da mesma OS.

## 6. Endpoints

| Método e rota | Perfil | Descrição |
| --- | --- | --- |
| `GET /api/customers` · `POST /api/customers` | ADMIN/DISPATCHER | Listar/criar clientes |
| `GET/PATCH/DELETE /api/customers/[id]` | ADMIN/DISPATCHER | Detalhe/edição/exclusão |
| `GET /api/technicians` · `POST /api/technicians` | ADMIN | Listar/vincular técnico |
| `PATCH/DELETE /api/technicians/[id]` | ADMIN | Ativar/desativar/excluir |
| `GET /api/service-orders` | ADMIN/DISPATCHER/TECHNICIAN | Listar (filtros por status/prioridade/técnico; técnico vê só as suas) |
| `POST /api/service-orders` | ADMIN/DISPATCHER | Criar OS manual |
| `GET /api/service-orders/[id]` | ADMIN/DISPATCHER/TECHNICIAN | Detalhe + timeline (ownership) |
| `POST /api/service-orders/[id]/assign` | ADMIN/DISPATCHER | Atribuir/trocar técnico |
| `POST /api/integrations/sync` | ADMIN | Importar OS do ERP (idempotente) |

Todas as rotas novas usam Zod `.strict()`, exigem sessão com perfil adequado
e são isoladas por `companyId`.

## 7. Fora do escopo deste checkpoint

Execução/fechamento de OS (diagnóstico, fotos, materiais, assinatura, PDF),
estoque, notificações/WhatsApp, GPS, OLT, IA, e a integração real com a
ReceitaNet (aguarda documentação oficial).

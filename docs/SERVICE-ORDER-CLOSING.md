# Fechamento da OS — AlfaOS (v0.4-service-order-closing)

Como uma OS em atendimento vira uma OS concluída, preservando evidências e
rastreabilidade. Complementa `docs/TECHNICIAN-EXECUTION.md` (que cobre
`ASSIGNED → IN_PROGRESS`).

## 1. Fluxo

```text
IN_PROGRESS
 ↓ execução preenchida (diagnóstico + serviço realizado)
 ↓ evidências (fotos)
 ↓ materiais utilizados
 ↓ assinatura do cliente
 ↓ revisão
 ↓ FINALIZAR ATENDIMENTO
COMPLETED
```

Ao concluir: `status = COMPLETED`, `completedAt` preenchido, evento
`OS_COMPLETED` na timeline, `SERVICE_ORDER.COMPLETED` no AuditLog, e os dados
tornam-se imutáveis para o técnico.

## 2. Modelos

| Modelo | Cardinalidade | Constraint no banco |
| --- | --- | --- |
| `ServiceOrderEvidence` | N por OS (máx. 10) | `storageKey @unique` |
| `ServiceOrderMaterialUsage` | N por OS | — |
| `ServiceOrderSignature` | **1 por OS** | `serviceOrderId @unique` |

Os três desnormalizam `companyId` — mesma razão da execução: toda leitura e
escrita filtra o tenant **em SQL**, não por navegação de FK.

`quantity` é `Decimal(10,3)`: "15,5 m de cabo drop" é entrada real de campo.
`MaterialUnit` é uma lista curta (`UNIT`, `METER`, `KILOGRAM`, `LITER`) — v0.4
registra material declarado, **não** faz controle de estoque.

Migration: `20260823051110_add_service_order_closing` (aditiva).

## 3. Storage

```text
domínio → FileStorageContract → LocalFileStorageAdapter
```

O domínio conhece apenas `storageKey`. Nenhum byte vai para o Postgres.

**A chave é gerada no servidor**: `<companyId>/<orderId>/<uuid>.<ext>`, com a
extensão derivada do **mime validado**, nunca do nome enviado. Um upload
chamado `../../../etc/passwd.png` não influencia onde o arquivo cai. O adapter
ainda valida a chave contra `STORAGE_KEY_PATTERN` e confirma que o caminho
resolvido continua dentro da raiz.

Trocar disco local por S3/R2/MinIO no futuro é escrever um adapter — sem tocar
schema nem regra de negócio.

## 4. Segurança dos uploads

- Aceitos: **JPEG, PNG, WebP**. SVG e HTML são recusados — ambos carregam
  script e executariam na origem da aplicação.
- O tipo real é decidido pelos **magic bytes**, e precisa coincidir com o tipo
  declarado. Só o header é falsificável; só o sniffing aceitaria um JPEG
  declarado como executável.
- Limites: **8 MB por imagem**, **10 imagens por OS** (pior caso 80 MB/OS),
  2 MB por assinatura.
- Leitura: **não existe URL pública**. Os bytes saem apenas por
  `GET .../evidence/:id/content` e `GET .../signature`, após sessão, tenant e —
  para técnico — ownership. As respostas usam `Content-Disposition: attachment`,
  `X-Content-Type-Options: nosniff` e `Cache-Control: private, no-store`.

## 5. Concorrência

### 5.1. O "claim" — como filho e fechamento se arbitram

Toda mutação de filho (evidência, material, assinatura) executa **primeiro**,
na mesma transação da escrita:

```sql
UPDATE service_orders
   SET version = version + 1
 WHERE id = $1 AND companyId = $2
   AND status = 'IN_PROGRESS' AND version = $expectedOrderVersion
```

Zero linhas → **409**. É isso que torna `child × complete` determinístico: os
dois disputam o mesmo row lock, quem commita primeiro move a versão, e o
perdedor não casa mais o predicado.

Verificar `status === 'IN_PROGRESS'` em código antes de inserir **não**
resolveria: entre a checagem e o insert a OS pode fechar.

### 5.2. O fechamento — dois compare-and-set

`completeServiceOrder` recebe `expectedOrderVersion` **e**
`expectedExecutionVersion`, ambos obrigatórios, e aplica nesta ordem, dentro de
uma transação:

1. **execução** em `expectedExecutionVersion` — impede fechar em cima de um
   texto que outra aba acabou de salvar;
2. **OS** em `expectedOrderVersion` **e** `status = IN_PROGRESS` — arbitra
   `complete × complete` e `complete × child`.

Qualquer um casando zero linhas aborta tudo com 409. Não há releitura de versão
disfarçada de validação.

### 5.3. Idempotência

`complete` repetido (sequencial ou `Promise.all`) resulta em: um `completedAt`,
um `OS_COMPLETED`, um incremento de versão, e **409 previsível** no segundo.

## 6. Campos obrigatórios

Para concluir, a execução precisa de `diagnosis` e `workPerformed` não vazios
após `trim`. `notes` é opcional.

**Foto, material e assinatura NÃO são obrigatórios nesta versão** — as três
funcionalidades existem, mas quais evidências uma OS exige é política de
checklist por tipo de OS, que ainda não existe. Fixar "sempre obrigatório"
agora bloquearia fechamentos legítimos.

## 7. Imutabilidade após COMPLETED

Depois de `COMPLETED`, o técnico não edita execução, não adiciona nem remove
evidência ou material, não altera assinatura, não reinicia e não reconclui —
todas as rotas recusam com 409, e a UI não renderiza nenhum controle de
escrita. O histórico permanece legível.

Correção posterior deverá passar por um fluxo de reabertura/devolução (futuro),
nunca por edição silenciosa de uma OS encerrada.

## 8. Autorização

Somente o **técnico proprietário** fecha e mutaciona filhos. Ownership vem de
`session.user → Technician → technician.id → ServiceOrder.technicianId`;
`technicianId` do cliente é rejeitado pelo `.strict()`, nunca confiado. Exige
também `User.active`, `User.profile = TECHNICIAN`, `Technician.active` e mesma
empresa.

ADMIN/DISPATCHER: **leitura completa, escrita nenhuma** (403 nas rotas de
escrita). Não-dono recebe **404**, nunca 403, para não confirmar existência.

## 9. Timeline e AuditLog

Timeline recebe **apenas** `OS_COMPLETED`, com metadata de contagens
(`evidenceCount`, `materialCount`, `hasSignature`) — nunca conteúdo. Foto,
material e save não geram evento: a timeline é história operacional de alto
nível.

AuditLog registra `SERVICE_ORDER.EVIDENCE_ADDED` / `EVIDENCE_REMOVED` /
`MATERIAL_ADDED` / `MATERIAL_UPDATED` / `MATERIAL_REMOVED` /
`SIGNATURE_CAPTURED` / `COMPLETED`, com IDs e metadata mínima — nunca bytes de
imagem, assinatura ou texto livre extenso.

## 10. Endpoints

```text
POST   /api/service-orders/:id/evidence                  (multipart)
DELETE /api/service-orders/:id/evidence/:evidenceId
GET    /api/service-orders/:id/evidence/:evidenceId/content
POST   /api/service-orders/:id/materials
PATCH  /api/service-orders/:id/materials/:materialId
DELETE /api/service-orders/:id/materials/:materialId
PUT    /api/service-orders/:id/signature                 (multipart)
GET    /api/service-orders/:id/signature
POST   /api/service-orders/:id/complete
```

Todas as mutantes: Same-Origin/CSRF, sessão, perfil TECHNICIAN, e
`expectedOrderVersion`. Não existe endpoint genérico de mudança de status.

## 11. Validação de versão

`expectedVersionSchema` (`src/lib/version.ts`) valida inteiro, `>= 0` e
`<= 2147483647`. Um valor acima do teto do `integer` do Postgres agora é **400**
na fronteira, não 500 vindo do driver.

## 12. UI mobile-first

Após iniciar, a tela do técnico ganha Execução → Evidências → Materiais →
Assinatura → Revisão → **FINALIZAR ATENDIMENTO** (confirmação explícita
avisando que o atendimento não poderá ser alterado).

Um único componente cliente possui a versão da OS: cada mutação de filho
incrementa `ServiceOrder.version`, então painéis com cópias separadas
conflitariam entre si.

Concluída, a tela mostra `startedAt`, `completedAt`, duração e todo o conteúdo
em modo leitura.

## 13. Fora do escopo deste checkpoint

PDF/comprovante, reabertura/devolução, avaliação do cliente, estoque e baixa
automática, ReceitaNet real, GPS/rota, Flutter, offline, notificações, OLT,
RADIUS, ACS, FiberMap e IA.

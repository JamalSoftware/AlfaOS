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
CTO-3.1    contrato de leitura geográfica          APPROVED
CTO-3.2    Mapa Operacional web — camada de CTO    READY FOR OWNER VALIDATION
CTO-3.2.1  bases, marcador de caixa, navegação     READY FOR OWNER VALIDATION
```

O escopo do primeiro lançamento está congelado em **PRD §362–§391**, e a lista
do que falta está em **§386**.

---

## 2. A sequência até o lançamento

```text
CTO-3.2.1
   ↓  validação do dono — bases, marcador de caixa, voltar ao mapa
PRD V1 Launch Scope Freeze                                    ← concluído
   ↓
CTO-3.2.1b · 3.2.1c   polimento de UX e o estado na silhueta   ← concluído
   ↓  validação do dono em uso real
CTO-3.2.1d   ADMIN corrige a posição da CTO no mapa            ← concluído
   ↓
CTO-3.2.2   camada de clientes + OS abertas + Online/Offline em lote
   ↓  validação do dono — Mapa Operacional V1 completo
DASH-1 · TL-1 · EV-1 · GS-1    (ordem entre si: decisão do dono)
   ↓
LANÇAMENTO V1
   ↓
V2 (PRD §388)  →  V3 (PRD §389)
```

**A ordem entre `DASH-1`, `TL-1`, `EV-1` e `GS-1` não está congelada.** Elas são
independentes entre si e todas dependem apenas do que já existe. Congelar a
ordem agora seria decidir por antecipação algo que o uso real vai informar
melhor.

---

## 2.1. `CTO-3.2.1d` — a posição da CTO, corrigida no mapa

Entrou na sequência depois da validação em uso real da `CTO-3.2.1c`: o dono viu
uma coordenada errada e não tinha como corrigi-la de onde estava olhando.

**Escopo, e ele é estreito de propósito:** o `ADMIN` seleciona a caixa, entra em
modo de edição explícito, arrasta, confere e salva — ou cancela. Enquanto não
houver `Salvar`, **o banco não muda**. A escrita reaproveita o caminho que a tela
de detalhe já usa (`PATCH /api/ctos/[id]` com payload só de coordenada), então
não existe segunda validação nem segundo serviço.

**PRD §377, `DECISION UPDATED`.** Confirmação em campo, GPS do Field,
`accuracyMeters`, `source`, `confirmedAt`/`confirmedBy` e o workflow de
verificação continuam **pós-V1**. Receber uma coordenada não é confirmá-la, e o
ADMIN corrigindo pelo mapa não esteve no poste.

Zero migration, zero Prisma, zero Dart, zero dependência.

---

## 3. `CTO-3.2.2` — Mapa Operacional V1: clientes e OS abertas

**Objetivo.** Ligar as duas camadas que faltam ao motor que já existe: clientes
ativos localizáveis e OS abertas, com conectividade vinda da autoridade que a
tela da OS já usa.

**Dependências.** `CTO-3.2.1` validada pelo dono. PRD §366–§374, §376–§379.

### O portão obrigatório: discovery do Online/Offline

Antes de escrever código, responder — com arquivo e linha, não de memória:

```text
1  de onde vem Online/Offline?
2  qual provider responde, e como ele é escolhido?
3  existe cache? de quê, por quanto tempo?
4  qual endpoint a tela da OS usa?
5  qual é o conceito de frescor?
6  qual é o fallback quando a fonte não responde?
7  como o erro é representado?
8  que testes já existem?
9  dá para reutilizar diretamente, ou é preciso extrair um read model comum?
```

**O levantamento já feito no congelamento do PRD respondeu a maior parte, e a
resposta está em §370.** Ele fica aqui como portão porque a implementação
precisa **confirmar** contra o código no momento em que for escrever, e não
confiar nesta anotação.

> O que o levantamento já mediu, e que a implementação precisa respeitar:
> a leitura de hoje é **de um cliente por chamada** (`getCustomerDiagnostic` →
> `findFirst`). Uma camada de mapa faria `N+1`. **A extração autorizada é uma
> leitura em lote sobre a mesma tabela e o mesmo DTO** — ampliar a autoridade,
> nunca criar uma segunda.
>
> E o mapa **lê**; ele não dispara refresh. O refresh tem teto de 10 chamadas
> por minuto por empresa (PRD §337), e um mapa que atualizasse por marcador
> queimaria a cota da OS num arrasto.

### Entregas

```text
backend   leitura em lote de conectividade (extração de customer-diagnostics)
          leitura de clientes por recorte — bbox + teto + tenant em SQL
          leitura de OS abertas por recorte
          resumo de conectividade e contagem de OS por CTO — derivados
web       camada de clientes (OFF por padrão) e de OS abertas (ON)
          popups de cliente e de OS
          filtros simples de cliente
          busca ampliada: cliente, endereço, número de OS
          selo numérico de OS no marcador da CTO
          clientes ativos vinculados no popup da CTO
Field     nenhuma alteração
migration nenhuma esperada
```

**Testes.** Tenancy com controle positivo em cada leitura nova; teto e recorte
afirmados **sobre a consulta**, não só sobre o resultado; `N+1` provado ausente
por contagem de consultas; falha de integração **não** vira `OFFLINE`;
cliente sem coordenada não vira marcador e alimenta o contador; DTO mínimo
afirmado por igualdade de chaves.

**Segurança.** PRD §376 e §379. Coordenada de outro tenant é vazamento mesmo
isolada. Nenhuma ampliação de perfil sem levantamento de capabilities.

**Validação do dono.** Mapa Operacional V1 completo, na interface real.

**Risco.** *Médio-alto* — é a primeira superfície que mostra muitos clientes de
uma vez, e o volume de assinantes é a ordem de grandeza que o mapa de CTO não
tinha. Os dois pontos de atenção são desempenho da leitura em lote e a
disciplina de não deixar nenhuma pergunta de conectividade escapar da autoridade
única.

---

## 4. `DASH-1` — Dashboard operacional acionável

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
(`/api/integrations/customers/search`) e a busca do mapa (`CTO-3.2`), ambas com
escopo próprio.

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

Git                             sem push e sem tag sem autorização explícita
```

---

## 9. O que este plano NÃO cobre

V2 e V3 (PRD §388, §389): falha coletiva, central de incidentes, modo NOC,
manutenção preventiva, camada de técnico ao vivo, métricas de técnico, FiberMap
e rede física.

Trilhas documentadas e não promovidas: **Escala de Trabalho** (PRD §288–§307),
**Colaboração entre Técnicos** (§342–§351), **custódia de patrimônio**
(§210–§223), **contratos e assinatura eletrônica** (Parte X) e as **capabilities
de negócio do SGP**.

Elas continuam sob a §119: estar no PRD não é autorização para implementar.

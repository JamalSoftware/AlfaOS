# AlfaOS — Colaboração entre Técnicos: especificação

Especificação da capability descrita no PRD **Parte XIV (§342–§351)**.

Mora aqui, e não no PRD, pelo mesmo motivo que `DISPATCH-QUEUE.md` e
`CTO-NETWORK-DISTRIBUTION.md`: o PRD é **visão de produto**, e matriz de
permissão, ciclo de convite, política de concorrência e opção de modelagem são
engenharia.

> **Estado: `DOCUMENTAÇÃO`. Nada desta especificação existe em código.**
>
> Nenhum schema, nenhuma migration, nenhuma rota, nenhuma tela, nenhum teste.
> A §119 do PRD vale aqui como em toda parte: estar escrito não autoriza
> implementar.

---

## 1. O problema, e o caso real que o levantou

O técnico A terminou a carga dele mais cedo. O técnico B ainda tem cinco OS.
Hoje o AlfaOS só tem uma resposta: **reatribuir** uma OS de B para A — o que
troca o responsável, mexe na fila de despacho de dois técnicos e some com a OS
da lista de B.

Só que muitas vezes a operação não quer transferir. Quer que A **ajude** B numa
OS específica: subir no poste junto, puxar cabo, segurar a escada, medir. A OS
continua sendo de B, e B continua respondendo por ela.

Falta ao AlfaOS a segunda resposta.

## 2. O que é, em uma frase

> Uma OS tem **um** técnico responsável e **zero ou mais** colaboradores.
> Colaborar acrescenta participantes; **não** troca o responsável.

```text
ServiceOrder
├── Responsável        1     quem responde pela OS
└── Colaboradores      0..N  quem ajuda a executá-la
```

## 3. A regra de ouro

```text
COLABORAÇÃO      acrescenta participante        NÃO altera o responsável
                                                NÃO altera a fila de despacho

TRANSFERÊNCIA    altera o responsável           PODE alterar a fila de despacho
                                                é auditada como reatribuição
```

**Os dois nunca são sinônimos**, e a especificação inteira depende disso. Um
produto que chame as duas coisas de "repasse" perde a distinção no primeiro
diálogo de UI, e depois não consegue responder "de quem é esta OS?".

### Exemplo

```text
OS #523
Responsável   Técnico B
Colaborador   Técnico A

A está ajudando B. A OS é de B.
```

---

## 4. O que o código de hoje já sustenta, e o que não

Esta seção existe para a fase de planejamento não descobrir tarde. Foi
levantada lendo o código, não presumida.

### Não existe nada de colaboração hoje

Busca global por `collaborat`, `participant`, `helper`, `crew`, `assistant` em
`src/`, `apps/field/lib/`, `prisma/` e `scripts/`: **zero** ocorrência
relacionada ao conceito. Os poucos `helper` encontrados são utilitários de
formatação e fixtures de teste. Não há conceito a reaproveitar nem a duplicar.

### A posse tem UM portão, e isso é sorte

Toda escrita que pendura algo numa OS — evidência, material, equipamento,
assinatura, resposta de checklist, impedimento — passa por
`loadInProgressOwnedOrder` (`src/lib/service-order-child-mutation.ts`), que
chama `loadOwnedServiceOrder` e recusa quando
`order.technicianId !== technician.id`.

```text
resolveActingTechnician   quem está agindo, PELA SESSÃO
loadOwnedServiceOrder     ele é o responsável desta OS?
status === IN_PROGRESS    a OS está em andamento?
```

Isso é excelente e é perigoso pelo mesmo motivo: **a permissão do colaborador
se resolve estendendo um predicado, e não espalhando verificações por sete
comandos em quatro arquivos**. Em compensação, errar essa única função erra
todas as mutações de uma vez. É a superfície mais crítica desta capability.

### A autoria já existe em cinco lugares, e falta em dois

| Superfície | Autor hoje |
|---|---|
| `ServiceOrderEvent` (timeline) | `userId` ✅ |
| `ServiceOrderEvidence` | `uploadedByUserId` ✅ |
| `ServiceOrderMaterialUsage` | `createdByUserId` ✅ |
| `ServiceOrderSignature` | `capturedByUserId` ✅ |
| `AuditLog` | `userId` ✅ |
| `ServiceOrderExecution` | **nenhum** ❌ |
| `ServiceOrderEquipment` | **nenhum** ❌ |

`ServiceOrderExecution` é **um registro único por OS** (`serviceOrderId
@unique`): diagnóstico, trabalho realizado, notas e checklist moram nele, e
ninguém precisou registrar autoria porque só existia um técnico possível.
`ServiceOrderEquipment` idem.

Consequência para o planejamento: **`COL-6` não é uniforme.** Cinco superfícies
ganham atribuição de autoria de graça; duas exigem decisão de schema. E a de
`ServiceOrderExecution` é a mais delicada, porque o registro é único e
compartilhado — dois técnicos escrevendo o mesmo diagnóstico não são duas
linhas, são uma linha com duas mãos.

### A fila de despacho já PROÍBE a OS em duas filas

`TechnicianDispatchQueueEntry.serviceOrderId` é `@unique` **global**. Uma
segunda entrada para a mesma OS, na fila de outro técnico, viola a constraint
antes de qualquer regra de aplicação.

Isso é uma boa notícia: o invariante "colaborador não entra na fila
autoritativa" (`COL-AC03`) já é **estrutural**, e não depende de alguém lembrar
dele. A colaboração não pode criar entrada de fila nem por engano.

### O CAS de versão vai deixar de ser raro

`claimOrderForChildMutation` faz compare-and-set em
`status = IN_PROGRESS AND version = expectedOrderVersion`. Hoje um `409` de
versão é **raro**: só um técnico escreve numa OS.

Com dois técnicos escrevendo ao mesmo tempo, o `409` passa a ser **rotina** —
não é defeito, é o mecanismo funcionando. O Field precisa tratá-lo como
recarregar-e-tentar, e não como erro vermelho. É a consequência de UX mais
concreta desta capability, e ela aparece na primeira colaboração real.

### Não existe tabela genérica de capability

`Company` tem colunas de política — `pppoePasswordPolicy`, `timezone` — e é o
precedente do projeto para configuração por empresa. Não há tabela genérica de
feature flag. O Field recebe `capabilities` no `GET /me`, **derivadas** e
declaradamente não-autoritativas ("UI não é controle de segurança, e cada rota
reconfere").

Onde a capability de colaboração vai morar é decisão da fase de planejamento;
o que já está decidido é que ela é **por empresa** e que a rota reconfere.

---

## 5. Ciclo de vida do colaborador

Ciclo **conceitual**. Nenhum enum físico está fechado.

```text
INVITED  ──aceita──►  ACCEPTED  ──removido──►  REMOVED
   │
   └────recusa────►  DECLINED
```

* **Antes do aceite, o convidado não é colaborador ativo.** Ele não escreve
  nada na OS, não aparece como participante e não recebe acesso.
* `DECLINED` e `REMOVED` são **terminais** e ficam no histórico. Convidar de
  novo cria um registro novo, nunca ressuscita o antigo.
* Uma empresa pode configurar `Exigir aceite = OFF`; nesse caso a colaboração
  nasce ativa, conforme a política de quem pode convidar.

### O histórico não é opcional

Nunca substituir uma lista atual sem histórico. É preciso responder:

```text
quem participou   ·   quando entrou   ·   quando saiu
quem convidou     ·   quem aceitou
```

Mesmo raciocínio do vínculo de CTO (`CTO-NETWORK-DISTRIBUTION.md`): fechar o
registro antigo e abrir o novo, nunca `UPDATE` destrutivo sobre uma lista.

---

## 6. Quem pode o quê

### Convidar

Políticas previstas, por empresa: `ADMIN`, `DISPATCHER`, e o **próprio
responsável** pela OS. A empresa pode restringir o técnico de campo — há
operação que quer o convite passando pelo despacho.

Nenhum papel novo é criado. Não existe "Gestor" nesta especificação.

### Remover

`ADMIN`, `DISPATCHER`, o responsável, e o **próprio colaborador** (sair da
colaboração). A política final é da fase de planejamento.

### Ser convidado

Somente técnico **elegível da mesma empresa**. Nunca:

```text
técnico de outra empresa
usuário sem registro Technician
Technician inativo
o próprio responsável pela OS
```

A elegibilidade reusa a regra que já existe (`technicianExecutionIssue`), não
uma cópia — a mesma decisão que o `GET /me` do Field já tomou.

---

## 7. Permissões do colaborador

**Não presumir que o colaborador tem todas as permissões do responsável.** A
política é por empresa; a lista de ações previstas:

```text
visualizar a OS
registrar diagnóstico
responder checklist
adicionar fotos e evidências
registrar materiais
registrar equipamento instalado
registrar medição óptica
coletar assinatura
concluir a OS
```

### Recomendação para a V1

Recomendação, **não** contrato fechado:

| Ação | Colaborador na V1 |
|---|---|
| Visualizar a OS | ✅ |
| Diagnóstico | ✅ |
| Checklist permitido | ✅ |
| Fotos e evidências | ✅ |
| Materiais | ✅ |
| Equipamento instalado | ✅ quando autorizado |
| Medição | ✅ |
| **Concluir a OS** | ❌ **só o responsável** |

Conclusão é a ação que fecha a responsabilidade. Deixá-la com o responsável na
V1 evita ter de arbitrar, já na primeira versão, duas pessoas concluindo a
mesma OS de dois celulares.

### O colaborador não "inicia" a OS

O colaborador **não** executa `startServiceOrder`: a OS já está `IN_PROGRESS`,
iniciada pelo responsável. Isso tem uma consequência derivada do código atual —
`loadInProgressOwnedOrder` exige `IN_PROGRESS`, então **o colaborador só
contribui depois de o responsável ter iniciado**. Se a operação quiser
colaboração antes do início, isso é decisão nova, não detalhe de implementação.

Entrar na colaboração é um conceito **separado** de iniciar a OS, e os dois não
podem colapsar.

### Check-in, Jornada e Colaboração são três coisas

```text
Check-in da OS   o técnico chegou no cliente
Jornada          o técnico está trabalhando hoje
Colaboração      o técnico participa desta OS
```

Misturar os três é o erro fácil. Uma pessoa pode estar em jornada sem
colaborar, colaborar sem ter feito check-in, e ter feito check-in numa OS que
não é a que ela colabora.

---

## 8. A fila de despacho não é tocada

**Invariante crítico.** Acrescentar colaborador **não** cria entrada na fila
autoritativa do colaborador. A fila continua sendo do responsável.

Como registrado na §4, isso é **estrutural**: `serviceOrderId` é `@unique`
entre entradas, e a mesma OS não cabe em duas filas.

No Field, a colaboração aparece numa **seção própria**, nunca com `1ª/2ª/3ª`:

```text
EM ATENDIMENTO
  OS #480   ...

PRÓXIMAS NA FILA
  1ª  OS #512
  2ª  OS #517

COLABORANDO
  OS #523   Responsável: Técnico B
```

Numerar a colaboração junto com a fila misturaria **responsabilidade
operacional** com **auxílio**, e o técnico deixaria de saber qual é a próxima
OS dele.

### Prioridade continua sendo da OS

`priority` é propriedade da OS, e não do participante. O colaborador não ganha
uma prioridade própria, e a colaboração não altera a prioridade de nada
(`COL-AC10`).

---

## 9. Transferência de responsabilidade

Ação **separada**, que já tem domínio no AlfaOS: é a reatribuição
(`assignTechnician`, `placeAssignedOrder`, a fila de despacho). A fase de
planejamento deve **reusar** esse domínio, não escrever um segundo.

```text
B → A     responsável muda
          fila de despacho muda
          auditoria registra a reatribuição
```

Isto **não** é colaboração.

### Da colaboração para a transferência

Fluxo previsto: A está colaborando com B, e depois o administrador transfere a
responsabilidade para A. O resultado precisa ser tratado **explicitamente** —
A não pode ficar como responsável **e** colaborador ativo da mesma OS ao mesmo
tempo (`COL-AC06`, §52 do briefing).

O que acontece com B nesse momento é **decisão aberta `COL-02`**.

---

## 10. Interação com a Jornada

A Jornada dá contexto ao seletor de colaborador:

```text
Técnico A   🟢 em jornada    1 OS pendente
Técnico C   ⚪ jornada encerrada
```

**Recomendação:** no primeiro MVP, a Jornada **informa**, não bloqueia. Uma
empresa pode querer que bloqueie; isso vira política. É a decisão aberta
`COL-07`.

A carga de trabalho (quantas OS pendentes) é informação **auxiliar**. Nenhuma
otimização automática.

### Nunca colaborar sozinho

Com o Mapa Operacional (Parte III) e localização, o seletor poderá um dia
mostrar distância e sugerir um colaborador próximo. **Sugerir, nunca aplicar.**
Nenhuma transferência e nenhuma colaboração acontecem automaticamente por
distância ou carga. Humano confirma, sempre.

---

## 11. Materiais, equipamentos, evidências e assinatura

### Autoria

Toda contribuição preserva **quem fez**. Não atribuir tudo ao responsável. Como
a §4 mostra, cinco superfícies já carregam autor; `ServiceOrderExecution` e
`ServiceOrderEquipment` não carregam.

### Sessão de cada um

Cada técnico age **com a própria sessão**. Nenhum compartilhamento de token, de
credencial ou de autorização de upload entre técnicos. O colaborador não usa a
sessão do responsável para nada.

### Materiais

Se o colaborador registra consumo, o sistema sabe quem registrou. De **qual
estoque** o material sai — do responsável, do colaborador, ou de um estoque
compartilhado — é a decisão aberta `COL-01`, e ela não pode ser tomada em
silêncio: o inventário é um ledger (PRD §211, §215) e a resposta muda o saldo
de alguém.

### Equipamentos

Mesmo princípio. O colaborador pode registrar se a política permitir, e a
posse/estoque precisa continuar coerente. Registrar autoria em
`ServiceOrderEquipment` é parte da decisão.

### Assinatura

A assinatura pertence à **OS**, não a um técnico. `ServiceOrderSignature` já
registra `capturedByUserId`, então "quem conduziu a coleta" já é respondível
sem mudança de arquitetura.

---

## 12. Conclusão da OS

V1: **somente o responsável conclui.**

Futuro: a empresa pode habilitar "responsável **ou** colaborador conclui". Se
isso for habilitado, o backend precisa arbitrar concorrência e máquina de
estados — dois participantes concluindo do celular ao mesmo tempo. O mecanismo
já existe (`claimOrderForChildMutation` e o CAS de `version`), mas a política e
a mensagem de conflito não.

Decisão aberta `COL-05`.

### Depois de `COMPLETED`

Não se acrescenta colaborador a uma OS concluída como operação normal. O
histórico de quem participou **permanece** (`COL-AC12`).

### `CANCELLED`

`CANCELLED` é hoje estado **declarado e inalcançável** — nunca escrito em
produção. Se um dia se tornar alcançável, as colaborações ativas precisam ser
encerradas coerentemente. Não é escopo desta especificação.

### Colaborador inativado

Um `Technician` inativado **não executa novas ações**. O histórico do que ele
já fez permanece intacto — a mesma regra que a desativação de técnico já segue
hoje ("desativação não apaga histórico").

### Responsável inativado durante uma OS aberta

Isso pertence ao fluxo de **transferência/reatribuição**, não ao de
colaboração. A colaboração não resolve ausência de responsável.

---

## 13. Auditoria e timeline

A timeline operacional (`ServiceOrderEvent`, que já tem `userId`) representa o
que aconteceu na OS. O `AuditLog` continua separado, para auditoria
administrativa.

```text
14:20   Técnico B iniciou a OS.
14:43   Técnico B convidou Técnico A.
14:44   Técnico A aceitou a colaboração.
14:51   Técnico A adicionou diagnóstico.
15:02   Técnico A registrou material.
15:18   Técnico B concluiu a OS.
```

**Sem ruído.** Um evento por fato relevante. Convite, aceite, recusa, remoção e
transferência são fatos; salvar rascunho não é.

---

## 14. Offline

O Field pode **mostrar** a colaboração já conhecida quando estiver offline.

Mas **aceitar convite**, **remover colaborador** e **mudar responsabilidade**
exigem reconciliação autoritativa. Nenhuma autoridade offline: o aplicativo não
decide quem colabora, do mesmo jeito que não decide a ordem da fila (DQ-6).

---

## 15. Notificações

A colaboração é a melhor consumidora da futura `FIELD NOTIFICATION FOUNDATION`
(PRD §153). Eventos previstos:

```text
COLLABORATION_INVITED
COLLABORATION_ACCEPTED
COLLABORATION_DECLINED
COLLABORATION_REMOVED
```

Exemplo de push futuro: *"Técnico B convidou você para colaborar na OS #523."*

**Nada de FCM existe hoje**, e esta especificação não o antecipa. Sem
notificação, o convite continua funcionando — o colaborador o vê ao abrir o
aplicativo.

---

## 16. Segurança

### Tenancy

Toda colaboração é **company-scoped**. Responsável, colaborador e OS pertencem
à mesma empresa, verificado em SQL, com o `companyId` vindo **da sessão**.
Nunca do Flutter, nunca do body, nunca da query (`COL-AC15`).

### IDOR

As futuras rotas precisam impedir:

```text
técnico A adicionar técnico da empresa B
alguém aceitar convite que não é dele
alterar colaboração de OS que não pode acessar
enumerar OS por resposta 403 × 404
```

Vale a convenção existente: **404 em vez de 403** quando 403 confirmaria
existência, e o corpo da resposta não vaza conteúdo.

### Privacidade

O colaborador acessa **o necessário da OS em que participa**, e nada além.
Colaborar numa OS não abre a carteira do outro técnico, não lista as outras OS
dele e não expõe a fila dele.

### PII

Reusar os DTOs mínimos do Field, já aprovados. **Nenhum campo de PII entra no
contrato só por causa da colaboração.** A ausência de dado é uma decisão de
segurança tomada na v0.9 e mantida na DQ-5.

### Concorrência

Cenários a planejar, todos com o backend como autoridade:

```text
dois convites iguais ao mesmo técnico
aceite e remoção simultâneos
transferência de responsabilidade enquanto um convite está pendente
conclusão da OS enquanto um colaborador entra
dois participantes concluindo, se a empresa habilitar isso um dia
```

### Idempotência

`invite`, `accept`, `decline` e `remove` são mutações de rede móvel e precisam
nascer idempotentes, na infraestrutura de `Idempotency-Key` que o Field já tem
(`docs/FIELD-API.md`). Escopo por `(empresa, usuário, operação, chave)`, e só o
sucesso é memorizado.

### Unicidade

O mesmo técnico não pode ser colaborador **ativo** duas vezes na mesma OS. A
constraint física é decisão da fase de planejamento — o histórico precisa
aceitar o mesmo técnico várias vezes ao longo do tempo, então uma unique
ingênua sobre `(serviceOrderId, technicianId)` **não serve**.

---

## 17. Relatórios

Futuro. Medidas possíveis:

```text
OS como responsável        ·  OS como colaborador
convites aceitos           ·  apoios prestados
tempo de colaboração       ·  ações por participante
```

**Não atribuir 100% da OS a todos os participantes.** O relatório precisa
distinguir três coisas diferentes:

```text
responsabilidade   quem responde pela OS
participação       quem esteve nela
ações executadas   o que cada um fez
```

E nada disso vira folha de pagamento automaticamente. O AlfaOS documenta sem
julgar nem descontar — a mesma regra da custódia de patrimônio (PRD §219).

Como medir "tempo de colaboração" é a decisão aberta `COL-06`.

---

## 18. Origem e ReceitaNet

Acrescentar colaborador **não** altera `origin`, `externalProvider` nem
`externalId` da OS.

Uma OS importada do ReceitaNet recebe colaboração como qualquer outra OS
operacional, se a política da empresa permitir. **O ERP não controla
colaboradores**, e nenhum endpoint novo do ReceitaNet é inventado para isso —
vale a §141 do PRD.

---

## 19. Modelagem — as duas opções

`NÃO criar migration.` Comparação para a futura fase de planejamento.

### Opção A — relação própria de colaboração

```text
ServiceOrder.technicianId          continua sendo o RESPONSÁVEL
ServiceOrderCollaborator          a relação nova, com estado e histórico
```

* Não toca em nada do que já existe.
* A fila de despacho, `loadOwnedServiceOrder`, `assignTechnician`, o backfill,
  os DTOs do Field e os 137 testes da trilha da fila continuam válidos.
* O custo: "participante" fica representado de duas formas diferentes — uma
  coluna para o responsável, uma tabela para os colaboradores.

### Opção B — participantes uniformes

```text
ServiceOrderParticipant  com role  RESPONSIBLE | COLLABORATOR
```

* Conceitualmente mais limpo: um só lugar responde "quem participa".
* O custo é grande e concreto: `ServiceOrder.technicianId` é a chave de que
  dependem a fila de despacho inteira (`TechnicianDispatchQueue`,
  `placeAssignedOrder`, `removeOrderFromQueue`, o backfill), o predicado de
  posse de **todas** as mutações-filhas, a atribuição, a listagem do Field e a
  reatribuição. Migrar isso é reescrever a capability que acabou de ser
  auditada e liberada.

### Recomendação

**Opção A.** Verificada contra o código, não escolhida por gosto: a Opção B
exigiria refatorar a superfície mais testada e mais recentemente auditada do
projeto para ganhar uniformidade conceitual, sem nenhum ganho operacional para
o técnico em campo.

A não-uniformidade é um custo **declarado**, não um descuido: o responsável é
uma coluna porque ele é **um**, e a unicidade dele é o que a fila de despacho,
o SLA, o fechamento e a auditoria usam.

---

## 20. Fases

Nenhuma autorizada. Nenhuma iniciada.

| Fase | Escopo |
|---|---|
| **COL-1** | Modelagem, capability por empresa, invariantes em código |
| **COL-2** | Admin/Web gerencia colaboradores de uma OS |
| **COL-3** | Field convida colaborador |
| **COL-4** | Aceite e recusa |
| **COL-5** | Permissões do colaborador, por empresa |
| **COL-6** | Auditoria, timeline e atribuição de autoria |
| **COL-7** | Notificações push |
| **COL-8** | Relatórios de colaboração |
| **COL-9** | `FUTURO` — sugestão por carga e localização |

`COL-6` tem custo desigual e a §4 explica por quê: cinco superfícies já
carregam autor, duas não.

---

## 21. Critérios de aceite

| # | Critério |
|---|---|
| **COL-AC01** | Empresa com a capability desativada não expõe colaboração em lugar nenhum |
| **COL-AC02** | Acrescentar colaborador **não** altera o técnico responsável |
| **COL-AC03** | Colaborador **não** entra na fila de despacho autoritativa |
| **COL-AC04** | Técnico da empresa B não colabora em OS da empresa A |
| **COL-AC05** | O mesmo técnico não aparece duas vezes como colaborador ativo na mesma OS |
| **COL-AC06** | O responsável não pode ser colaborador de si mesmo |
| **COL-AC07** | O convite pode ser aceito ou recusado |
| **COL-AC08** | O histórico preserva convite, aceite, recusa e remoção |
| **COL-AC09** | Cada ação preserva o autor real, e não o responsável por padrão |
| **COL-AC10** | Colaboração não altera a prioridade da OS |
| **COL-AC11** | Transferência de responsabilidade continua sendo conceito separado |
| **COL-AC12** | OS `COMPLETED` não aceita nova colaboração como operação normal |
| **COL-AC13** | Colaborador inativado não executa novas ações; o histórico permanece |
| **COL-AC14** | Sem a capability, o Field não mostra o botão |
| **COL-AC15** | Nenhum `companyId` vindo do cliente vira autoridade |

---

## 22. Decisões abertas

Registradas, **não** resolvidas. Resolver sem necessidade seria decidir no
escuro.

| # | Pergunta |
|---|---|
| **COL-01** | De qual estoque sai o material quando o colaborador registra consumo? |
| **COL-02** | Depois da transferência `B → A`, o antigo responsável sai ou vira colaborador? |
| **COL-03** | Qual o máximo padrão de colaboradores por OS? |
| **COL-04** | Quais ações exatas o colaborador executa na V1? |
| **COL-05** | A empresa pode permitir que o colaborador conclua a OS? |
| **COL-06** | Como se mede "tempo de colaboração"? |
| **COL-07** | A Jornada é apenas aviso, ou regra de elegibilidade? |

---

## 23. O que esta especificação deliberadamente não faz

```text
não reabre a Fila Operacional          DQ-1 a DQ-7.2, pronta para release
não altera o aggregate da fila         só a transferência interage com ela
não cria role nova                     ADMIN, DISPATCHER, TECHNICIAN bastam
não implementa FCM                     PRD §153
não implementa CTO                     Parte XIII
não autoriza redesign do Field         FIELD DESIGN FREEZE segue ACTIVE
não cria endpoint de ERP               PRD §141
não decide schema físico               Opção A é recomendação, não migration
```

---

## 24. Vocabulário de produto

PT-BR, e o mesmo em toda superfície:

```text
Colaborar
Adicionar colaborador
Colaboradores
Responsável
Transferir responsabilidade
```

**Não** chamar colaboração de "repasse": repasse sugere que a OS mudou de dono,
que é exatamente o que a colaboração não faz.

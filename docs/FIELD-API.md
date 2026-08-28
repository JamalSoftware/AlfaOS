# AlfaOS Field API — contrato do backend

Fundação de backend do aplicativo do técnico (PRD Parte V). **Não há Flutter
neste repositório**: esta é a superfície HTTP que o aplicativo vai consumir.

> **Princípio que domina o resto.** O Field é **outro cliente do mesmo AlfaOS**,
> não um sistema paralelo. Máquina de estados, posse, tenancy, elegibilidade,
> compare-and-set, timeline e auditoria são os MESMOS serviços que a web usa.
> Nenhuma regra de negócio vive na camada Field.

```text
Flutter  →  AlfaOS Field API  →  Services/Application  →  Domain  →  PostgreSQL
```

Nunca `Flutter → ReceitaNet`. Nunca `Flutter → OLT`. Nunca `Flutter → banco`.

---

## 1. Namespace e versão

```text
/api/field/v1/...
```

A versão está no caminho, e não num cabeçalho, porque o consumidor é um **APK
instalado**: aparelhos com versões diferentes convivem em campo por meses, e
não há como forçar atualização. `v2` nasce ao lado de `v1`, sem quebrar quem
não atualizou.

As rotas administrativas (`/api/service-orders`, `/api/customers`, …) continuam
onde estão e **não** ganham comportamento móvel.

---

## 2. Autenticação — token opaco preso a um dispositivo

### O que é

```text
POST /api/field/v1/auth/login   →  token opaco (32 bytes aleatórios)
Authorization: Bearer <token>   →  em toda requisição seguinte
```

O token é guardado como **SHA-256**; o texto claro existe uma única vez, na
resposta do login. Um dump do banco não devolve acesso a ninguém.

### Por que não é o cookie da web

O AlfaOS já autentica com JWT em cookie `HttpOnly`. Reusá-lo aqui estaria errado
por duas razões independentes:

1. **Aquele token não é revogável.** É sem estado: quem o tem, entra, até
   expirar. O cenário que justifica esta camada é **celular perdido** — um
   aparelho que não coopera. Sem revogação server-side, cortar o acesso exigiria
   trocar a senha do usuário, o que derruba os outros aparelhos dele **e** não
   impede que o push continue entregando OS ao aparelho perdido.
2. **Cookie em cliente nativo é acidente esperando acontecer.** O navegador
   manda cookie sozinho — é daí que vem CSRF. Um aplicativo nativo não tem
   origem, então `assertSameOrigin` não teria como funcionar.

### Por que não é um JWT novo

Um segundo JWT com `deviceId` na claim não resolveria a revogação: continuaria
sendo necessário consultar o banco a cada requisição para saber se o aparelho
ainda vale. Aí o JWT não paga por si mesmo — ele existe para evitar a consulta,
e a consulta acontece de qualquer jeito. Sobra só superfície extra (chave,
algoritmo, `alg: none`, expiração que não é revogação).

**SHA-256 puro e não bcrypt**: o valor já tem 256 bits de `randomBytes`, então
não há o que adivinhar por força bruta. Bcrypt existe para senha de gente, que é
fraca; token sorteado não é.

### A cadeia, re-derivada a cada requisição

```text
Bearer  →  MobileDevice (ACTIVE, não revogado, não expirado)
        →  User (ativo, perfil TECHNICIAN, mesma empresa)
        →  Technician (mesma empresa)
```

Nada disso vem do que o aplicativo enviou. `companyId` sai do usuário e
`technicianId` sai do vínculo — mesmo que o app os mande, são ignorados.

O `technicianId` gravado em `MobileDevice` **não autoriza nada**: é registro
histórico de quem registrou o aparelho.

### Recusas

Toda recusa de autenticação é o mesmo `UNAUTHENTICATED`. Distinguir "token
inválido" de "aparelho revogado" de "usuário desativado" contaria a quem roubou
o aparelho em que pé está a conta.

O login recusa com a **mesma frase** para: e-mail inexistente, senha errada,
usuário inativo, perfil não-TECHNICIAN, sem cadastro de técnico, técnico
inativo. Qualquer diferença permitiria descobrir quem trabalha na empresa a
partir de um app que qualquer pessoa baixa.

Força bruta usa a máquina **da web**, sem segunda implementação:
`isLoginBlocked`, `recordLoginAttempt`, custo constante de bcrypt e
`DUMMY_PASSWORD_HASH`.

### Validade e revogação

| | |
|---|---|
| validade do token | 36 h (`FIELD_TOKEN_MAX_AGE_SECONDS`) |
| revogação | `revokedAt` — efeito na **próxima requisição** |
| logout | zera o token, **preserva** a linha do dispositivo |
| relogin mesma instalação | reaproveita a linha e **rotaciona** o token |
| relogin de instalação **revogada** | recusado com `DEVICE_REVOKED` |

A expiração não substitui a revogação: ela é a rede embaixo dela, para o
aparelho que sumiu sem ninguém perceber.

### Revogado não volta por login

Um aparelho revogado **não é reativado** por entrar de novo. A implementação
inicial reativava, como "caminho de recuperação", e isso esvaziava a revogação:
quem estivesse com o celular perdido **e** a senha — o caso de um aparelho
desbloqueado ou de credencial anotada — voltava a ter acesso sozinho, sem o
administrador saber.

A contrapartida que torna a política viável: revogar um aparelho **não bloqueia
a pessoa**. Quem perdeu o celular recebe outro, o aplicativo gera um
`installationId` novo, e o técnico volta a trabalhar sem depender de um
administrador disponível.

### Quem revoga

```text
GET  /api/mobile-devices              lista os aparelhos da empresa
POST /api/mobile-devices/:id/revoke   corta o acesso
```

Superfície **administrativa da web** (cookie + Same-Origin), não da Field API.
Apenas `ADMIN`: revogar aparelho é administração de acesso, que no AlfaOS já é
do ADMIN — como usuários e credenciais de ERP. Tela em `/dispositivos`.

A listagem **não** devolve `tokenHash`, `pushToken` nem `installationId`:
nenhum deles ajuda a decidir se um aparelho deve ser revogado, e os três são
exatamente o que não deve passar por navegador, log de proxy e captura de tela
de suporte.

---

## 3. Endpoints

| Método | Caminho | O que faz |
|---|---|---|
| POST | `/auth/login` | credencial + instalação → token |
| POST | `/auth/logout` | invalida o token deste aparelho |
| GET | `/me` | contexto do técnico e capabilities |
| POST | `/devices/register` | metadados e rotação do push token |
| GET | `/service-orders` | fila do técnico (`scope=active\|completed`) |
| GET | `/service-orders/:id` | detalhe operacional |
| POST | `/service-orders/:id/start` | ASSIGNED → IN_PROGRESS |
| POST | `/service-orders/:id/pppoe/reveal` | senha em claro, sob demanda |
| POST | `/service-orders/:id/diagnostic` | releitura de conectividade |
| GET | `/notifications` | central do técnico |
| POST | `/notifications` | marcar como lida |

**Execução e fechamento em campo (v0.10):**

| Método | Caminho | O que faz |
|---|---|---|
| GET | `/service-orders/:id/execution` | pacote da tela de execução, numa leitura |
| POST | `/service-orders/:id/check-in` | chegada ao local |
| POST | `/service-orders/:id/location/confirm` | confirma o ponto cadastrado |
| POST | `/service-orders/:id/location/correct` | corrige endereço e/ou coordenada |
| POST | `/service-orders/:id/checklist/:itemId` | responde um item do checklist |
| POST | `/service-orders/:id/evidence` | anexa foto categorizada (multipart) |
| POST | `/service-orders/:id/evidence/:evidenceId` | remove foto antes de concluir |
| POST | `/service-orders/:id/materials` | baixa material do estoque do técnico |
| POST | `/service-orders/:id/equipment` | registra equipamento instalado |
| POST | `/service-orders/:id/equipment/:equipmentId` | remove equipamento |
| POST | `/service-orders/:id/contact-attempts` | tentativa de contato |
| POST | `/service-orders/:id/impediments` | "não consegui executar" |
| PUT | `/service-orders/:id/signature` | assinatura do cliente (multipart) |
| POST | `/service-orders/:id/complete` | IN_PROGRESS → COMPLETED |
| GET | `/inventory` | estoque do próprio técnico |

Todo comando mutante exige `Idempotency-Key` e `expectedVersion`, e executa a
mesma sequência — autenticar → elegibilidade → chave → corpo → dedup → domínio.
A ordem é propriedade de segurança: elegibilidade antes da desduplicação impede
que um técnico inelegível reserve uma chave que depois bloquearia a legítima.

Duas remoções usam `POST` e não `DELETE`: o comando precisa de `expectedVersion`
no corpo, e corpo em `DELETE` é mal suportado por proxies.

**Não existe rota de ENTRADA de estoque no Field.** Se existisse, o técnico
criaria o próprio saldo antes de baixá-lo, e a validação de saldo não valeria
nada. Entrada é ato de quem entrega, e vive na API administrativa.

`expectedVersion` de `location/confirm` e `location/correct` é o da
**localização**, não o da OS: são objetos diferentes com locks próprios, e um
despachante mexendo na OS não pode invalidar a confirmação que o técnico está
enviando. Em `correct` ele aceita `null`, que significa "eu vi que este cliente
não tem localização" — o compare-and-set da criação.

### A resposta de um comando vem da mutação

`start` devolve o **resultado da própria operação** — `id`, `number`, `status`,
`priority`, `startedAt`, `updatedAt`, `version` — e não uma releitura da OS.

A releitura filtrava por posse, e isso abria uma janela real: a transação
commitava, o despachante reatribuía a OS, e a releitura devolvia **404** para
uma operação que **tinha acontecido**. A fila local do aplicativo marcaria como
falha algo que deu certo, e reenviaria.

O erro conceitual por trás disso é reabrir a autorização depois do commit: quem
já foi autorizado a executar não precisa ser autorizado de novo para saber o que
executou. Negar a LEITURA de quem não é mais dono continua certo — negar o
RELATO da escrita dele, não.

O corpo é mínimo de propósito: o aplicativo já tem o detalhe, e projetar o
`PublicServiceOrder` inteiro traria `customer.document` — o CPF — de volta ao
cache do aparelho.

---

## 4. Contrato de erro

```json
{
  "ok": false,
  "error": {
    "code": "CONFLICT",
    "message": "A OS foi modificada por outra requisição.",
    "retryable": false,
    "conflict": true
  }
}
```

O Flutter **nunca** interpreta a mensagem humana para descobrir o tipo de erro:
ela muda quando alguém corrige uma vírgula, e quebraria num APK que já está em
campo. O desfecho vem em `code`.

| `code` | HTTP | `retryable` | `conflict` |
|---|---|---|---|
| `UNAUTHENTICATED` | 401 | não | não |
| `FORBIDDEN` | 403 | não | não |
| `DEVICE_REVOKED` | 403 | não | não |
| `NOT_FOUND` | 404 | não | não |
| `VALIDATION_ERROR` | 400 | não | não |
| `CONFLICT` | 409 | não | **sim** |
| `IDEMPOTENCY_CONFLICT` | 409 | não | **sim** |
| `RATE_LIMITED` | 429 | **sim** | não |
| `UPSTREAM_UNAVAILABLE` | 503 | **sim** | não |
| `INTERNAL` | 500 | **sim** | não |

`retryable` e `conflict` são **derivados do código**, nunca escritos à mão na
rota — são as duas decisões que o app toma, e deixá-las por endpoint garantiria
que um dia divergissem.

`DEVICE_REVOKED` tem código próprio, e não `UNAUTHENTICATED`, porque é a única
recusa cuja saída **não** é "faça login de novo": repetir com aquela instalação
nunca vai funcionar, e o aplicativo precisa mandar a pessoa falar com a empresa
em vez de deixá-la digitando a senha. Só chega a quem já provou a credencial
correta, então não conta nada a um desconhecido — quem erra a senha continua
recebendo o `UNAUTHENTICATED` uniforme.

---

## 5. Idempotência

Todo comando mutante exige:

```text
Idempotency-Key: <8..200 chars, [A-Za-z0-9._:-]>
```

Escopo único: **`(empresa, usuário, operação, chave)`**.

- **empresa e usuário** para que reapresentar a chave de outra pessoa não
  devolva o resultado dela — isso seria um oráculo sobre operação alheia.
- **operação** para que a mesma chave em dois comandos não colida.

A chave é gerada **no dispositivo, no momento da ação** — não no envio. Gerada
no envio, cada retentativa produz chave nova e a proteção não existe.

**Ela evita duplicação; ela não prova autorização.** Posse e tenancy são
verificadas *antes* da desduplicação, nunca no lugar dela.

### Só o sucesso é memorizado

Falha não fica guardada. Um 409 de hoje não pode virar 409 permanente amanhã,
quando a causa já passou — o técnico ficaria com uma operação impossível de
reenviar e nenhuma forma de destravá-la senão reinstalar o app.

### Corrida

A reserva é gravada **antes** de executar, e o banco arbitra pela unique.
Verificar-e-depois-inserir deixaria duas requisições simultâneas passarem pela
verificação e executarem as duas.

### Reserva abandonada

Gravar a reserva antes de executar tem um preço: um processo que morre no meio
deixa a linha `IN_FLIGHT`. Sem prazo, toda retentativa daquela chave recebia
`CONFLICT` até a expiração de 24 h — uma queda de processo travava a operação
do técnico por um dia.

A reserva tem **lease de 2 minutos**. Vencido, outra requisição pode assumi-la —
e a tomada é arbitrada pelo banco, então duas que enxerguem o mesmo lease
vencido não assumem as duas.

A tomada **re-executa o handler**, não finge sucesso. A operação pode ter
commitado antes de o processo morrer, e quem garante que ela não aconteça duas
vezes **não é esta camada**: é o domínio. A máquina de estados recusa
`ASSIGNED → IN_PROGRESS` numa OS já em atendimento, e o compare-and-set recusa
uma versão que já andou. O desfecho de uma tomada depois de um commit é um 409
honesto — nunca uma segunda execução.

A impressão digital é conferida **antes** do lease: chave reaproveitada para
outro conteúdo continua sendo `IDEMPOTENCY_CONFLICT`, nunca uma tomada
silenciosa.

---

## 6. Conflito e offline

`Idempotency-Key` e `expectedVersion` respondem perguntas **diferentes**:

| | pergunta | quando falha |
|---|---|---|
| `Idempotency-Key` | "isto já aconteceu?" | app reenviou a fila local |
| `expectedVersion` | "o mundo ainda é o que eu vi?" | alguém mexeu enquanto ele estava offline |

Uma não substitui a outra.

O `version` da OS viaja em toda listagem e detalhe; o comando o devolve como
`expectedVersion`. Versão velha → **409 com `conflict: true`**, que manda o app
recarregar em vez de reenviar.

> **Nunca "last write wins" silencioso para decisão operacional.** O cenário: o
> técnico fica sem rede, o despachante cancela a OS, o técnico executa e
> sincroniza. Sobrescrever apagaria uma decisão da operação; descartar apagaria
> duas horas de campo. As duas são inaceitáveis — por isso o desfecho é
> conflito explícito, para gente resolver.

`clientMutationId` é opcional e **não tem efeito no servidor**: volta na
resposta para o app casar o desfecho com a operação da própria fila
(`localOperationId`), mesmo quando a resposta chega numa execução seguinte.

O offline de verdade é do cliente Flutter. O backend fornece o que ele precisa —
idempotência, `version`, timestamps, respostas determinísticas e semântica de
conflito — e nada além disso: mecanismo sem consumidor é código morto.

---

## 7. Minimização de dado

Os DTOs do Field são **projeções próprias** (`src/lib/field/dto.ts`), não o
`PublicServiceOrder` da web. Reaproveitar seria a escolha curta e errada:
`PublicServiceOrder` carrega `customer.document` — o CPF — para uma tela
administrativa que precisa dele, e devolvê-lo ao aplicativo colocaria CPF no
cache de dezenas de aparelhos que andam pela rua.

**Nunca no payload do Field:**

```text
CPF · senha PPPoE · token · ciphertext de credencial
payload cru de provider · dado financeiro
dados de outros técnicos · internals de auditoria
```

### A lista traz menos que o detalhe

A lista devolve nome do cliente, bairro e cidade, e um booleano `hasLocation` —
**não** a coordenada. Mandar latitude e longitude da carteira inteira do dia
seria distribuir o endereço de cada cliente para um cache que não tem uso para
eles. A coordenada só aparece no detalhe, onde vira destino de navegação.

### Provider não aparece

`origin`, `externalProvider`, `externalId` e `externalNumber` ficam **fora**.
Uma OS importada do ReceitaNet funciona no Field exatamente como uma interna
depois de atribuída — e como o dado não desce, não existe `if (RECEITANET)`
possível do lado do aplicativo. A ausência é a garantia.

---

## 8. PPPoE

O detalhe devolve apenas `passwordConfigured`. O texto claro sai **só** por
`POST /service-orders/:id/pppoe/reveal`, com `no-store`, teto de frequência e
auditoria obrigatória — o mesmo serviço de domínio que a web usa.

> **Por padrão, senha PPPoE em texto claro NÃO é persistida offline**
> (`docs/SECURITY.md` §8.9). Cache offline é armazenamento durável num aparelho
> que é roubado. Isso é contrato do cliente Flutter; o que o servidor garante é
> `no-store`, cota e registro.

---

## 9. Notificação, outbox e push

```text
TRANSAÇÃO
 ├── ServiceOrder (atribuição, CAS)
 ├── ServiceOrderEvent
 ├── Notification
 └── OutboxEvent
COMMIT
          depois, fora da transação
worker → lê o outbox → provider de push
```

**A central é o registro; o push é apenas o aviso.** A `Notification` é gravada
mesmo quando o push falha — e ele falha: token expirado, aparelho desligado,
permissão negada, provider que descarta sem avisar.

**Sem segredo no payload do outbox.** A tabela sobrevive à transação, é lida por
worker e aparece em dump e em backup. Ela carrega **referência**; o worker relê
o que precisa na hora de processar.

O texto da notificação cabe na tela bloqueada: número operacional e tipo. Nome
do cliente, endereço, telefone e diagnóstico ficam de fora por construção.

### Worker

Comando, não daemon:

```bash
npm run outbox:work
```

Chamável por cron. Duas execuções sobrepostas são seguras — a reivindicação é um
`updateMany` cujo predicado é o mesmo da busca, então o banco arbitra e o
perdedor não pega nada. Não exige Redis, supervisor nem orquestrador.

**Roda com `node` puro.** O script é compilado por `npm run build` (junto do
`next build`, via `tsconfig.worker.json`) e o comando executa
`dist/scripts/outbox-worker.js`. Antes ele rodava com `tsx`, que é
devDependency: depois de `npm prune --omit=dev` — passo normal de deploy — o
cron simplesmente não iniciava, e a fila parava em silêncio. O único `require`
externo do artefato compilado é `@prisma/client`, que é dependency.

```bash
# cron de produção, depois de npm run build
* * * * * cd /app && npm run outbox:work
```

### Lease e recuperação

A reivindicação tem **prazo de 5 minutos**. Um worker que morre entre
reivindicar e concluir deixaria o evento em `PROCESSING` para sempre — nada mais
procurava por esse estado, e `requeueFailedOutboxEvent` só aceita `FAILED`. Com
o lease, prazo vencido volta a ser elegível.

O teto de tentativas vale **também no reclaim**: um evento que derruba o
processo nunca chega ao tratamento de erro, então sem essa guarda seria
reivindicado para sempre. Ao estourar, vira `FAILED` sem sequer tentar entregar.

Retry com backoff exponencial (30 s → 1 h), teto de 6 tentativas, depois
`FAILED` **visível**, com motivo sanitizado e reprocessável. Job que esgotou as
tentativas e sumiu em silêncio é pior que job que nunca rodou.

```text
GET  /api/outbox-events              eventos FAILED da empresa
POST /api/outbox-events/:id/requeue  devolve um deles à fila
```

Apenas `ADMIN`. O requeue **não aceita corpo**: nada do evento é editável, senão
seria um endpoint de injeção de evento com outro nome. Só sai de `FAILED` —
`PENDING` já está na fila e `PROCESSING` pertence a um worker (ou ao lease que
vai expirar).

### Entrega: at-least-once

Um worker pode morrer **depois** de o provider aceitar a mensagem e **antes** de
marcar `PROCESSED`. Quando o lease vencer, o evento é reivindicado de novo e a
notificação sai outra vez.

É deliberado e não tem conserto barato: exactly-once exigiria transação
distribuída com um provider de push que não a oferece. A escolha real é entre
entregar duas vezes e **perder** — e perder um aviso de atribuição é pior. O
aplicativo precisa tolerar duplicata, o que é natural para push.

### Push

`PushNotificationProvider` é abstração; a implementação atual é inerte
(`NoopPushProvider`) e reporta `delivered: 0` **honestamente** — um stub que
fingisse entrega esconderia, no dia da integração real, se o push parou de
funcionar. FCM entra junto do Flutter.

Token de push nunca vai para log. Token recusado em definitivo é limpo do
aparelho — limpar o `pushToken` **não** revoga o acesso: é fato sobre a
permissão de notificação, não sobre o direito de entrar.

---

## 10. Rate limit

Reusa `capability-rate-limit`. **Sempre depois da autorização** — consumido
antes, uma sondagem anônima ou de outra empresa gastaria a cota de quem tem
direito a ela.

| capability | teto/min |
|---|---|
| `field-pppoe-reveal` | 5 |
| `customer-diagnostic` | 10 |

Limitação conhecida, herdada: o estado é **em memória do processo**
(`docs/SECURITY.md` §8.7).

---

## 11. O que esta fundação NÃO faz

> **Revisado na v0.10.** Cinco itens desta lista deixaram de valer — conclusão,
> upload de evidência, assinatura, material e checklist pelo Field foram
> implementados, e o inventário ganhou o ledger mínimo. O que segue é o que
> continua fora.

- Nenhuma linha de Flutter, nenhum APK. **A trilha Flutter da v0.10 é a Etapa B
  e não faz parte deste backend.**
- Nenhuma integração FCM real; push continua abstração inerte.
- Nenhum motor offline no cliente. O contrato é compatível com a fila local da
  v0.11 (`Idempotency-Key` + `clientMutationId` + `expectedVersion`), mas o
  aplicativo ainda não a tem.
- Nenhum toolkit: Wi-Fi analyzer, speed test, OLT, ONU, RADIUS, ACS, TR-069.
- Nenhum `ToolExecution`.
- Nenhuma custódia de patrimônio: transferência técnico→técnico, conferência
  periódica, extravio, descarte e manutenção (PRD §210–§223) ficam fora, e
  entrarão como valores NOVOS do mesmo `InventoryMovementType` — nunca como um
  segundo motor (§181, §215).
- Nenhum PDF de fechamento. A conclusão grava um `ServiceOrderCompletion`
  estruturado; o PDF, quando existir, será uma renderização dele, e a conclusão
  nunca fica bloqueada esperando pipeline de documento.
- Nenhuma reabertura de OS concluída (§170).
- Nenhuma política de geofence bloqueante: a distância do check-in é registrada
  como informação, nunca como impedimento (§167).

Estar no PRD não autoriza implementar (§119).

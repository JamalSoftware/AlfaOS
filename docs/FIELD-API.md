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

A expiração não substitui a revogação: ela é a rede embaixo dela, para o
aparelho que sumiu sem ninguém perceber.

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
`updateMany` com predicado de status, então o banco arbitra e o perdedor não
pega nada. Não exige Redis, supervisor nem orquestrador.

Retry com backoff exponencial (30 s → 1 h), teto de 6 tentativas, depois
`FAILED` **visível**, com motivo sanitizado e reprocessável. Job que esgotou as
tentativas e sumiu em silêncio é pior que job que nunca rodou.

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

- Nenhuma linha de Flutter, nenhum APK.
- Nenhuma integração FCM real.
- Nenhum endpoint de conclusão de OS pelo Field — a validação de fechamento
  continua sendo do Core (`docs/SERVICE-ORDER-CLOSING.md`), e o endpoint entra
  usando **aquele** serviço, não um novo.
- Nenhum upload de evidência pelo Field. As categorias estruturadas do PRD §162
  seguem especificação; `EvidenceKind` continua com um único valor.
- Nenhuma assinatura, material ou checklist pelo Field.
- Nenhum toolkit: Wi-Fi analyzer, speed test, OLT, ONU, RADIUS, ACS, TR-069.
- Nenhum `ToolExecution`, nenhum inventário como ledger.

Estar no PRD não autoriza implementar (§119).

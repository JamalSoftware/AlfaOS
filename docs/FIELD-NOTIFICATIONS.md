# AlfaOS — Field Notification Foundation: plano de implementação

Plano da fase descrita no PRD **§153–§157**. Mora aqui, e não no PRD, pelo
mesmo motivo que `DISPATCH-QUEUE.md`: o PRD é visão de produto, e provider,
ciclo do token, política de retry e contrato de payload são engenharia.

> **Estado: `NF-1` e `NF-2` ENTREGUES. `NF-3` em diante continuam `PLANNED`.**
>
> O provider real do FCM existe, a seleção por configuração existe, e o defeito
> de logout que a §2 registrou foi corrigido (§24). O Flutter inicializa o
> Firebase, pede a permissão com contexto e obtém o token (§25).
>
> **Nenhuma migration, nenhum projeto Firebase criado e nenhum segredo
> versionado.** O aplicativo compila e roda **sem** o `google-services.json`;
> enquanto ele não existir, o push fica `unavailable`. **Nenhum push chega a um
> aparelho ainda** — o token não é enviado ao AlfaOS, e isso é `NF-3`.

---

## 1. O que JÁ existe — levantado no código, não presumido

O briefing que abriu esta fase supunha que a fundação estava por fazer. **Ela
está quase toda pronta.** O que segue foi verificado arquivo por arquivo.

### Schema

| Modelo | Estado |
|---|---|
| `Notification` | ✅ `companyId`, `userId`, `technicianId?`, `type`, `title`, `body`, `resourceType`, `resourceId`, `readAt`. Índices por `(companyId, userId, createdAt)` e `(…, readAt)` |
| `OutboxEvent` | ✅ `status`, `attempts`, **`leaseExpiresAt`**, **`availableAt`** (backoff), `lastError`, `processedAt`. Índices `(status, availableAt)` e `(companyId, createdAt)` |
| `MobileDevice` | ✅ **`pushToken String?` já existe**, mais `status`, `revokedAt`, `installationId`, unique `(companyId, userId, installationId)`, índices por `(companyId, userId, status)` e `(companyId, technicianId, status)` |

O comentário do schema já fixa a política: *"Push não é fonte de verdade — a
`Notification` é o REGISTRO; o push é só o aviso"*, e `title`/`body` são
**redigidos para a tela bloqueada**, sem CPF, senha, endereço, telefone ou
diagnóstico.

### Backend

```text
src/lib/notifications.ts     createNotification, listNotifications, markNotificationsRead
src/lib/outbox.ts            enqueueOutboxEvent, claim com lease, backoff, OUTBOX_EVENTS
src/lib/outbox-handlers.ts   handleServiceOrderAssigned — o slice inteiro
src/lib/push/provider.ts     PushNotificationProvider, PushMessage, PushDeliveryResult,
                             NoopPushProvider, setPushProvider/resetPushProvider
scripts/outbox-worker.ts     o worker, compilado por build:worker, rodado por node
```

**A abstração de provider já existe** — `PushMessage { tokens[], title, body,
data? }` e `PushDeliveryResult { delivered, invalidTokens }` —, com um
`NoopPushProvider` que **não finge sucesso**: devolve `delivered: 0`, que é o
número verdadeiro.

### O vertical slice `SERVICE_ORDER_ASSIGNED` está COMPLETO no backend

`assignTechnician` grava, **na mesma transação** da atribuição:

```text
ServiceOrder atualizada  +  Notification  +  OutboxEvent
```

O handler então: relê a `Notification` **filtrando por `companyId`**; busca os
`MobileDevice` com `status: ACTIVE`, `revokedAt: null` e `pushToken != null`;
chama `getPushProvider().send(...)` com `data` contendo apenas `type`,
`resourceType` e `resourceId`; e, para cada token recusado em definitivo,
**limpa só o `pushToken`** — sem revogar o aparelho, porque token morto é fato
sobre a permissão de notificação, não sobre o direito de acesso.

### Registro de token

`POST /api/field/v1/devices/register` e `POST /api/field/v1/auth/login`
**já aceitam `pushToken`** (`z.string().max(512).nullish()`). O `companyId`
vem sempre da sessão. `revokeDevice` limpa `pushToken` junto.

### Central de notificações

`GET /api/field/v1/notifications` existe e é real. No Flutter, o sino
(`notifications_bell.dart`) consome `notificationsControllerProvider` e navega
para `/notifications` — **não é placeholder**, e o contador vem do mesmo estado
que a tela carrega. Nada no aplicativo afirma que push funciona.

### Flutter

Existe `PushRegistrationService` com `NoopPushRegistrationService`, e
`pushRegistrationProvider` em `providers.dart`. O redator de log
(`core/logging/log.dart`) já censura `pushtoken`, `token`, `installationid`,
`phone`, `address` e `document` em qualquer profundidade.

### Testes

`field-notifications-outbox.test.ts`, `field-outbox-lease.test.ts`,
`field-outbox-atomicity.test.ts`, `field-device-admin.test.ts` — com
`FakePush` e `ContadorPush` implementando `PushNotificationProvider`. **Nenhum
teste toca Firebase**, e a costura de injeção já é a usada por eles.

---

## 2. O que realmente FALTA

A lista é curta, e é por isso que o roadmap abaixo não se parece com o do
briefing.

```text
1. provider FCM real           RESOLVIDO em NF-1
2. seleção do provider         RESOLVIDO em NF-1
3. configuração e credencial   RESOLVIDO em NF-1
4. Flutter: firebase_messaging RESOLVIDO em NF-2
5. Flutter: obter o token      RESOLVIDO em NF-2 (ENVIAR continua sendo NF-3)
6. rotação de token            RESOLVIDO em NF-2 (exposta; registrar é NF-3)
7. deep link do toque          o router não trata rota inicial vinda de push
8. logout não limpa pushToken  RESOLVIDO em NF-1 (era o defeito latente)
9. observabilidade de entrega  nada é persistido por dispositivo
```

### O defeito latente que o levantamento encontrou

`logoutField` (`src/lib/field/devices.ts`) zera `tokenHash`, `tokenIssuedAt` e
`tokenExpiresAt`, **preserva a linha** — e **não limpa `pushToken`**, deixando
`status: ACTIVE` e `revokedAt: null`.

O predicado do handler é exatamente `status: ACTIVE, revokedAt: null,
pushToken != null`. Logo, **um aparelho de onde o técnico saiu continua sendo
alvo de push do usuário anterior**. E o token de push é da *instalação*, não da
pessoa: se outro técnico entrar no mesmo aparelho, a notificação do primeiro
chega na tela do segundo.

Hoje isso é **inócuo**, porque o `NoopPushProvider` não entrega nada. Vira
defeito de privacidade **no dia em que o FCM for ligado**. Por isso a limpeza
do `pushToken` no logout é pré-requisito de `NF-1`, e não um polimento
posterior.

---

## 3. Arquitetura alvo

```text
assignTechnician (transação)
   ├── ServiceOrder
   ├── Notification          o REGISTRO
   └── OutboxEvent           a intenção de avisar
                ↓
        outbox-worker         claim com lease + backoff
                ↓
        handleOutboxEvent     relê o estado atual, filtra por tenant
                ↓
        PushNotificationProvider
                ↓
        FcmPushProvider       NF-1
                ↓
              FCM
                ↓
            Android
                ↓
        Field router          deep link, atrás do guard de sessão
```

O backend continua sendo autoridade. **O Flutter nunca conhece credencial
server-side do Firebase** — ele recebe apenas a configuração de cliente, que é
pública por definição.

---

## 4. Escolha do SDK — `firebase-admin`, e por quê

Duas opções reais: **Firebase Admin SDK (Node)** ou **FCM HTTP v1 cru** com
`google-auth-library` para trocar a chave de serviço por um access token.

**Recomendação: `firebase-admin`, e somente no worker.**

O fato que decide, e ele foi verificado: **`outbox-handlers.ts` é importado por
exatamente dois lugares — `scripts/outbox-worker.ts` e os testes.** Nenhuma
rota do Next o alcança. Consequência prática:

* a dependência **não entra no bundle do Next**;
* a credencial de serviço **não existe no runtime web**, só no processo do
  worker;
* `tsconfig.worker.json` tem um `include` explícito e mínimo — acrescentar o
  provider é **uma linha**.

Contra o HTTP v1 cru: seria preciso implementar mint de OAuth, cache do access
token, e classificar erro por token na mão. O SDK entrega
`messaging/registration-token-not-registered` e `…/invalid-argument` como
códigos estáveis, que mapeiam direto em `PushDeliveryResult.invalidTokens` — a
única informação que a interface já existente pede do provider. Reimplementar
isso é escrever, sem teste de contrato, a parte que decide quando um aparelho
para de receber notificação para sempre.

> **A escolha vale enquanto `outbox-handlers.ts` não for importado por uma
> rota.** Se um dia for, a credencial passa a viver no processo web e a decisão
> precisa ser reavaliada — não silenciosamente.

## 5. Configuração e credenciais

Somente no servidor/worker. **Nunca** no Flutter, no cliente web, no Git ou
com valor real em `.env.example`.

Variáveis conceituais, seguindo o padrão de `src/lib/env.ts` (validação
explícita, ausência tratada, sem valor real versionado):

```text
FIREBASE_PROJECT_ID
FIREBASE_CLIENT_EMAIL
FIREBASE_PRIVATE_KEY        multilinha; escapar \n como o ambiente exigir
```

Os nomes finais fecham em `NF-1`, junto da implementação.

### Fail-safe, não fail-closed

**Ausência de configuração não pode derrubar nada.** A regra:

```text
config ausente   → o provider continua sendo o Noop
                   web sobe, npm test roda, npm run build passa
                   o worker registra "provider indisponível" uma vez, e segue
config presente  → FcmPushProvider é instalado na inicialização do worker
```

O desenvolvimento local **não** precisa de Firebase. É o que hoje já acontece,
e é o comportamento a preservar: `delivered: 0` é honesto, e uma exceção na
subida seria pior que não entregar.

---

## 6. Ciclo de vida do token no aparelho

**`installationId` e push token são coisas diferentes**, e confundi-las é o
erro clássico:

```text
installationId   gerado pelo app, correlaciona reinstalação com a mesma linha
                 não é segredo, não autentica nada
push token       emitido pelo FCM, endereça UMA instalação
                 rotaciona sozinho, e some quando o app é desinstalado
```

| Momento | Comportamento planejado |
|---|---|
| Primeira obtenção | Depois da permissão concedida, `register()` devolve o token → `POST /devices/register` |
| Refresh do FCM | Listener de rotação → mesmo endpoint. Não presumir token permanente |
| Login | Envia o token no corpo do login, que já o aceita |
| Reinstalação | `installationId` novo ou reaproveitado; token novo pelo mesmo endpoint |
| **Logout** | **Limpar `pushToken` no servidor** (ver §2) |
| Revogação | `revokeDevice` já limpa `pushToken` e marca `REVOKED` |
| Token recusado pelo FCM | Handler já limpa **só** o `pushToken`, sem revogar a conta |

### Multi-dispositivo

`MobileDevice` é por `(companyId, userId, installationId)`, e o handler já faz
`findMany` — **N aparelhos por usuário funcionam hoje**. Nada de modelar um
token único por usuário.

### Aparelho revogado

A regra já está no lugar certo: **no predicado da consulta do handler**, e não
numa verificação de aplicação depois. Revogar tem efeito imediato porque o
próximo `findMany` simplesmente não retorna a linha.

---

## 7. Entrega, retry e idempotência

### Entrega ≠ sucesso de domínio

Falha do FCM **não** desfaz a atribuição da OS. O domínio grava OS +
`Notification` + `OutboxEvent` numa transação; a entrega acontece depois, fora
dela. É o que o outbox transacional já garante hoje.

### Retry

Já implementado: `attempts`, `availableAt` (backoff), `leaseExpiresAt` (lease
de 5 min, reivindicação vencida volta à fila), teto de tentativas, `lastError`
sanitizado. **Não reimplementar.** O que `NF-1` acrescenta é a classificação:

```text
transitório (rede, 5xx, quota)   deixa falhar → backoff → nova tentativa
permanente (token inválido)      NÃO é falha do evento: limpa o token e segue
```

Confundir os dois é o que faz um aparelho desinstalado consumir tentativas para
sempre — e o handler atual já trata isso corretamente.

### Idempotência

A identidade da entrega é o `OutboxEvent`. O worker é **at-least-once**, e isso
está declarado desde a v0.9: um lease vencido pode reprocessar um evento já
enviado, e o FCM pode receber a mesma mensagem duas vezes.

O que **não** pode acontecer é a `Notification` ser duplicada — e não é, porque
ela é criada na transação do domínio, não no worker. O reprocessamento relê a
mesma linha.

> Push duplicado é incômodo; `Notification` duplicada é registro errado. A
> arquitetura atual já escolhe o incômodo.

---

## 8. Payload e PII

O `data` do push carrega **somente identificadores**:

```json
{ "type": "SERVICE_ORDER_ASSIGNED", "resourceType": "ServiceOrder", "resourceId": "..." }
```

**Nunca**: CPF, telefone, endereço, senha PPPoE, senha de Wi-Fi, diagnóstico,
token, credencial, nome do cliente.

O `title`/`body` vêm da `Notification`, já redigidos:

```text
"Nova OS atribuída"
"OS Nº 512 · Instalação"
```

O número operacional identifica sem revelar. **Nome do cliente fica de fora**:
a prévia aparece sobre a tela bloqueada, sem autenticação, e fica dias na
central do sistema operacional.

Reaproveitar `title`/`body` da `Notification` — em vez de redigir de novo no
worker — é deliberado: uma segunda redação deixaria escapar o que a primeira
teve o cuidado de omitir.

---

## 9. Deep link, sessão e posse

```text
push tocado
   └── extrai type + resourceId
        └── router aplica o guard de sessão que JÁ existe
             ├── unauthenticated → /login, e o destino fica pendente
             ├── revoked         → /revoked
             └── authenticated   → /orders/:id
```

O `redirect` do `GoRouter` é hoje o **único** lugar que decide entrada. O deep
link precisa passar por ele, e não contorná-lo. **Nenhum bypass do guard**:
sessão expirada não abre tela protegida, e o destino é retomado depois do
login.

### O push não é autorização

Cenário obrigatório: o push da OS #123 chega; antes de o técnico tocar, a OS é
reatribuída. Ao abrir, o backend confere a posse **atual** — `/orders/:id` já
devolve 404 para OS que não é do portador do token. O push antigo não vale como
prova de nada, e é o servidor que decide.

Um `resourceId` de outra empresa recebe a mesma resposta pelo mesmo caminho.

### Primeiro plano

Três opções: notificação local, banner interno, ou apenas atualizar o estado.

**Recomendação para a primeira fase: apenas atualizar o estado** — o contador
do sino e a lista. O técnico já está olhando o aplicativo; empilhar uma
notificação do sistema sobre a tela que ele está usando é ruído, e o
`FIELD DESIGN FREEZE` está `ACTIVE`, então banner novo é decisão visual que não
cabe aqui.

### Permissão do Android 13+

`POST_NOTIFICATIONS` é permissão de runtime. **Não pedir na primeira tela sem
contexto** — negação é lembrada e cara de reverter.

Momento recomendado: **logo após o primeiro login bem-sucedido**, com uma frase
que diga para que serve ("para avisar quando uma OS for atribuída a você"). Se
negada, o aplicativo continua inteiro: a `Notification` interna existe, e o
sino mostra o mesmo número. Nada de tela de bloqueio, nada de insistência.

---

## 10. Escala, tempestade e eventos futuros

Um worker **multiempresa**, com isolamento no predicado — não um por empresa.
É o que já existe.

O risco de tempestade **hoje é zero**: só `SERVICE_ORDER_ASSIGNED` existe, e a
reordenação da fila **não emite evento nenhum**. Isso precisa continuar assim.

Quando eventos novos entrarem:

```text
SERVICE_ORDER_ASSIGNED        existe
SERVICE_ORDER_BECAME_FIRST    só a transição REAL para a 1ª posição, e só
                              quando o ocupante mudou de fato (D-10)
SERVICE_ORDER_URGENT          só a promoção, nunca a renumeração colateral
COLLABORATION_*               quando a Parte XIV sair do papel
```

> **Renumeração colateral não gera push.** Mover uma OS da 5ª para a 1ª desloca
> quatro entradas; se cada deslocamento avisasse, um clique do despachante
> viraria cinco notificações. A `D-10` já decidiu isso para a fila, e a
> fundação de notificação não pode reabrir a decisão pelo outro lado.

---

## 11. Observabilidade de entrega

Hoje nada é persistido por dispositivo: `PushDeliveryResult` devolve uma
contagem e os tokens inválidos, e o worker registra apenas no `OutboxEvent`.

Com N aparelhos, uma `Notification` pode ter `A = entregue` e `B = falhou`, e o
modelo atual não expressa isso.

**Recomendação: não resolver em `NF-1`.** Uma tabela de entrega por dispositivo
é a única parte deste plano que exigiria migration, e ela só se paga quando
houver alguém para ler o dado. Fica como `NF-6`, opcional, com a pergunta
aberta `NP-03`.

O que `NF-1` deve fazer é **logar o suficiente para diagnosticar**: id do
evento, id da notificação, nome do provider, contagem entregue, contagem
inválida, número da tentativa. **Nunca** o token completo — se for preciso
correlacionar, um hash truncado. O redator do Flutter já faz a sua parte.

---

## 12. Fases

Ajustadas ao código real. As duas primeiras fases do briefing original
(abstração de provider e registro de push token) **já estão feitas** e não
aparecem aqui.

| Fase | Escopo | Migration | Dependência |
|---|---|---|---|
| **NF-1** ✅ | `FcmPushProvider`, seleção por configuração, fail-safe, **limpeza do `pushToken` no logout**, logging | ❌ | `firebase-admin` (só worker) — **ENTREGUE, ver §24** |
| **NF-2** ✅ | Flutter: `firebase_messaging`, config nativa Android, permissão com contexto | ❌ | `firebase_core`, `firebase_messaging` — **ENTREGUE, ver §25** |
| **NF-3** | Flutter: obter token, enviar no login e no `devices/register`, listener de rotação | ❌ | — |
| **NF-4** | Deep link do toque, nos três estados, atrás do guard de sessão | ❌ | — |
| **NF-5** | Piloto em aparelho físico e endurecimento | ❌ | — |
| **NF-6** | `FUTURO` — entrega por dispositivo, se houver quem leia | ✅ provável | — |
| **NF-7** | `FUTURO` — eventos novos, com controle de tempestade | ❌ | — |

**`NF-1` a `NF-5` não exigem migration nenhuma.** `MobileDevice.pushToken`,
`OutboxEvent` e `Notification` já comportam o fluxo inteiro.

### O primeiro vertical slice

**`SERVICE_ORDER_ASSIGNED`**, e não por preferência: é o único evento que
existe, o backend inteiro dele já está escrito e testado, o destinatário é
inequívoco (`Notification.userId`), e o deep link natural é `/orders/:id`, rota
que já existe. Ligar o FCM fecha o circuito sem escrever um único caso de uso
novo.

---

## 13. Plano de testes

Nenhum teste toca o Firebase. A costura já existe (`setPushProvider`) e já é
usada.

```text
provider fake, sucesso                  entrega contada, nada mais escrito
falha transitória                       evento volta para a fila com backoff
token permanentemente inválido          pushToken limpo, aparelho NÃO revogado
retry                                   tentativa contada, teto respeitado
evento processado duas vezes            uma Notification, nunca duas
tenant cruzado                          evento da empresa A não alcança device de B
aparelho revogado                       fora do predicado, não recebe
logout                                  pushToken limpo, deixa de ser alvo
multi-dispositivo                       N tokens num send, um por aparelho
payload                                 whitelist: só type/resourceType/resourceId
sem PII                                 title/body sem nome, telefone ou endereço
deep link sem sessão                    vai para /login, nunca à tela protegida
posse obsoleta                          OS reatribuída → 404 na abertura
config ausente                          web sobe, testes passam, Noop ativo
```

Flutter: permissão negada não quebra o aplicativo; rotação de token chama o
endpoint; toque com aplicativo terminado, em segundo plano e em primeiro plano.

## 14. Plano adversarial

Provas a escrever quando a fase for implementada, com reversão:

```text
A  evento da empresa A mirando aparelho da B
B  aparelho revogado recebendo push
C  o mesmo OutboxEvent processado duas vezes
D  timeout do FCM depois de a mensagem já ter sido aceita
E  token rotacionado enquanto o evento está pendente
F  OS reatribuída antes de o push ser aberto
G  deep link apontando para OS de outra empresa
H  payload contendo PII do cliente
I  logout e, em seguida, push do usuário anterior no mesmo aparelho
```

`I` é a prova do defeito que a §2 registrou — hoje ela **falharia**.

---

## 15. O que o operador precisa fazer fora do código

Sem segredo no chat e sem segredo no Git:

```text
1. criar ou reusar um projeto no Firebase
2. registrar o aplicativo Android (o applicationId do Field)
3. baixar o google-services.json e colocá-lo em apps/field/android/app/
   — ele NÃO vai para o Git
4. gerar uma chave de conta de serviço com permissão de envio pelo FCM
5. guardar project id, client email e private key no ambiente do WORKER
   — nunca no ambiente web, nunca em .env.example com valor real
```

O `google-services.json` é configuração de cliente e não é segredo de servidor,
mas continua fora do Git: ele identifica o projeto e não tem por que estar num
repositório.

---

## 16. Decisões abertas

| # | Pergunta |
|---|---|
| **NP-01** | Nomes finais das variáveis de ambiente do FCM |
| **NP-02** | O aplicativo pede a permissão no primeiro login ou na primeira OS atribuída? |
| **NP-03** | Vale registrar entrega por dispositivo, e quem leria esse dado? |
| **NP-04** | Em primeiro plano, fica em "só atualizar estado" ou ganha banner numa rodada de design? |
| **NP-05** | Quando `SERVICE_ORDER_BECAME_FIRST` entra, e com qual janela de debounce? |

---

## 17. O que este plano deliberadamente não faz

```text
não integra iOS/APNs        Field é Android-first; a abstração não impede
não faz push web            notificação do admin web é outro assunto
não implementa Collaboration a fundação só precisa não impedir
não implementa CTO          sem relação
não reabre a Fila           D-10 continua valendo pelo outro lado
não autoriza redesign       FIELD DESIGN FREEZE segue ACTIVE
não cria migration          NF-1 a NF-5 não precisam de nenhuma
```

---

## 24. `NF-1` — o que foi entregue

Escopo: **backend e worker apenas**. Zero Dart, zero código nativo Android,
zero migration, zero schema.

### Arquivos

```text
src/lib/push/fcm.ts         FcmPushProvider, mapper de erro, chave, credencial
src/lib/push/bootstrap.ts   a escolha do provider, uma vez por processo
src/lib/push/provider.ts    PushDeliveryResult ganhou retryableFailures
src/lib/outbox-handlers.ts  ordem do sucesso parcial e deduplicação de token
src/lib/field/devices.ts    logoutField limpa o pushToken
scripts/outbox-worker.ts    chama o bootstrap na subida
tsconfig.worker.json        as duas fontes novas entram na compilação do worker
.env.example                as três variáveis, comentadas e sem valor
```

Uma dependência nova: **`firebase-admin`**, e nenhuma outra.

### A extensão mínima do contrato

`PushDeliveryResult` ganhou **`retryableFailures: number`**, obrigatório. O
contrato anterior sabia dizer "entreguei" e "este token morreu", e não sabia
dizer "tente de novo" — um provider que falhasse de forma transitória faria o
handler concluir o evento, e o aviso sumiria em silêncio.

Obrigatório, e não opcional, porque campo opcional convida exatamente esse
esquecimento no próximo provider que alguém escrever. O compilador cobrou os
dois fakes de teste na hora.

### A ordem no sucesso parcial

É a regra desta fase, e não um detalhe:

```text
1. envia
2. limpa os tokens PERMANENTEMENTE inválidos
3. só então lança, se houve falha transitória
```

Três aparelhos — um entregou, um morreu, um tropeçou — precisam dos três
desfechos ao mesmo tempo. Se a exceção viesse antes da limpeza, o token morto
sobreviveria a cada tentativa e o evento gastaria as seis contra um aparelho
desinstalado. Limpando antes, **cada retentativa tem estritamente menos
destinos condenados que a anterior**: a fila avança mesmo quando falha.

Lançar é como o handler diz "de novo" ao outbox — `processOutboxBatch` devolve
o evento a `PENDING` com backoff. O preço é declarado: quem já recebeu vai
receber de novo. A entrega é **at-least-once**, e sempre foi; push repetido é
incômodo, `Notification` duplicada seria registro errado, e ela não se duplica
porque nasce na transação do domínio.

### A classificação de erro, e a assimetria que a decide

Um mapper só, em `fcm.ts`. Permanente condena o token: `not-registered`,
`invalid-registration-token`, `invalid-argument`, `invalid-recipient`,
`mismatched-credential`. **Todo o resto é transitório, inclusive o código
desconhecido.**

A assimetria é a razão: chamar transitório de permanente **apaga o token** e
cala aquele aparelho para sempre, sem ninguém perceber; chamar permanente de
transitório gasta seis tentativas e aparece como `FAILED`, com motivo, na fila.
O primeiro erro é silencioso e definitivo; o segundo é barulhento e reversível.

### Fail-safe, provado no build

```text
credencial completa    → FcmPushProvider
credencial ausente     → Noop, e o worker diz por quê
credencial incompleta  → Noop, e o worker diz QUAL variável falta
credencial recusada    → Noop, e o worker não morre
```

`npm run build`, `npm test` e `npx playwright test` rodaram **sem nenhuma
variável do Firebase** definida.

### O isolamento do bundle, verificado e não afirmado

```text
grep -rl firebase .next/server .next/static   →  zero arquivos
grep -l  firebase-admin dist/src/lib/push/*.js →  fcm.js
```

A dependência está no worker compilado e em lugar nenhum do bundle da web. A
credencial de serviço não existe no runtime que atende requisição de usuário.

### O provider não decide tenant

`grep -c companyId` no módulo de push inteiro devolve **zero**. Ele recebe uma
lista de tokens já filtrada; quem escolhe destinos é o handler, com o
`companyId` do evento no predicado da consulta.

### O defeito de logout — corrigido

`logoutField` passou a limpar o `pushToken`. **Não revoga**: `status` continua
`ACTIVE`, a linha continua reaproveitável, e o próximo login registra um token
novo pelo caminho que já existe (`loginField` só sobrescreve `pushToken`
quando o aplicativo manda um).

### Testes — 34 novos

```text
FCM-01  config completa → provider real
FCM-02  sem config → Noop, sem derrubar nada
FCM-03  config parcial → Noop, nomeando a variável que falta
        (mais: em branco conta como ausente; chave recusada cai no Noop)
FCM-04  chave privada: `\n` escapado, aspas do shell, chave já correta
FCM-05  instalar duas vezes no mesmo processo não lança
FCM-06  entrega bem-sucedida não mexe no token
FCM-07  token inválido sai, e o aparelho NÃO é revogado
FCM-08  falha transitória pede retry e preserva o token
FCM-09  sucesso parcial: limpa o morto, mantém o vivo, ainda pede retry
FCM-10  nenhum aparelho elegível conclui sem retry infinito
FCM-11  aparelho revogado não recebe
FCM-13  multi-dispositivo, e o mesmo token em duas linhas envia uma vez
FCM-14  evento da empresa A não alcança aparelho da B
        classificação de erro: permanente, transitório e desconhecido
        payload: só type/resourceType/resourceId, e texto sem PII

LOGOUT-PUSH-01  logout limpa o token, mantém ACTIVE, e o aparelho sai da mira
                (inclui o técnico SEGUINTE no mesmo aparelho)
LOGOUT-PUSH-02  o outro aparelho do mesmo usuário continua recebendo
LOGOUT-PUSH-03  revogar continua sendo mais forte que sair
```

A chave RSA usada no teste é **gerada em processo** e descartada: `cert()` do
SDK valida o PEM, e uma chave de mentira faria o teste do caminho feliz medir
o fail-safe em vez do caminho feliz.

### Provas de reversão

```text
A  logout mantém o pushToken            4 dos 5 testes de logout falham
B  handler envia para revogado          FCM-11 falha
C  handler sem companyId no predicado   FCM-14 falha
D  token inválido revoga o aparelho     FCM-07 falha
E  tudo classificado como permanente    2 testes de classificação falham
G  config ausente derruba o processo    FCM-02 e o de credencial em branco falham
H  falha parcial concluída em silêncio  4 testes de entrega falham
F  token inteiro em log                 verificada por inspeção: nenhum
                                        `console.*` imprime token ou chave
```

### Risco de dependência, medido

`npm audit` reporta 14 vulnerabilidades. **Oito `high` são pré-existentes** —
cadeias de Next, Prisma e ESLint. As **seis `moderate` chegaram com o
`firebase-admin`**, todas na cadeia `@google-cloud/storage` →
`retry-request` → `teeny-request` → `uuid`.

Medido, e não presumido: importar `firebase-admin/app` e
`firebase-admin/messaging` carrega **98 módulos, e nenhum deles** é
`@google-cloud/storage`, `retry-request` ou `teeny-request`. O código
vulnerável está instalado e não é alcançado pelo caminho que o AlfaOS usa.

Nenhum upgrade foi feito: `npm audit fix --force` é proibido pelo `CLAUDE.md`,
e um upgrade amplo fora de escopo trocaria um risco medido por um não medido.

### O que continua faltando para o push chegar ao técnico

`NF-1` liga o lado do servidor. **Nenhuma notificação chega a um aparelho
ainda**, porque o Flutter não obtém token: `PushRegistrationService` continua
sendo o `Noop`, não há `firebase_messaging`, não há permissão de Android e não
há deep link. Isso é `NF-2` a `NF-5`.

---

## 25. `NF-2` — o que foi entregue

Escopo: **Flutter e Android apenas**. Zero TypeScript, zero Prisma, zero
migration, zero alteração de backend.

```text
apps/field/lib/core/push/field_push_service.dart    a costura e a implementação Firebase
apps/field/lib/core/push/push_coordinator.dart      quando perguntar, e a garantia de não insistir
apps/field/lib/core/push/push_prompt_memory.dart    a marca de "já perguntamos"
apps/field/lib/core/push/push_permission_sheet.dart a explicação antes do diálogo do sistema
apps/field/lib/app/providers.dart                   a costura nova substitui a inerte
apps/field/lib/features/auth/ui/login_screen.dart   a oferta, depois do login
apps/field/android/app/src/main/AndroidManifest.xml POST_NOTIFICATIONS
apps/field/android/app/build.gradle.kts             google-services CONDICIONAL
apps/field/android/settings.gradle.kts              versão do plugin, sem aplicar
apps/field/.gitignore                               google-services.json fora do Git
```

Duas dependências diretas — `firebase_core` e `firebase_messaging` — e mais
cinco transitivas da mesma família. **Nenhum pacote não relacionado mudou de
versão**, e `flutter_local_notifications` **não** entrou: banner em primeiro
plano é fase futura, e trazê-lo agora seria complexidade sem consumidor.

### O aplicativo compila SEM o Firebase, e isso foi verificado

A descoberta que decidiu a estratégia de Gradle: o plugin
`com.google.gms.google-services` **falha o build quando o
`google-services.json` falta**. Aplicado sem condição, ninguém compilaria o
Field sem antes ter acesso ao projeto Firebase da plataforma — nem para rodar
em emulador, nem para abrir um APK de depuração.

Por isso ele é aplicado **condicionalmente**:

```text
sem o arquivo   o APK compila, o app roda, o push fica indisponível
com o arquivo   o plugin entra e o push funciona
```

Verificado, e não afirmado: `flutter build apk --debug` conclui, e
`android/app/build/generated/res/google-services/` **não existe** — o plugin
foi de fato pulado.

### A costura, e por que a antiga saiu

`FieldPushService` expõe `initialize`, `permissionStatus`,
`requestPermission`, `token` e `tokenRefresh`. Nenhuma tela, controller ou
repositório chama `FirebaseMessaging` diretamente — é essa fronteira que faz
os 339 testes rodarem sem Firebase.

O `PushRegistrationService` inerte foi **removido**, e não mantido ao lado.
Ele nunca teve consumidor, e deixar duas costuras para a mesma coisa faria a
fase seguinte ter de escolher entre elas.

### Três identificadores que não se misturam

```text
installationId   correlaciona reinstalação com a mesma linha de MobileDevice
token de sessão  o Bearer opaco do Field, revogável
pushToken (FCM)  endereça UMA instalação, e rotaciona sozinho
```

`FieldPushService` **não expõe** os dois primeiros, e `PushPreparation`
carrega apenas o terceiro. A confusão entre eles é o erro clássico da
integração de push, e aqui ela é impedida pelo tipo.

### Quando o aplicativo pergunta

**Depois do primeiro login bem-sucedido, com contexto** — a regra decidida no
`NF-0`, agora em código.

```text
authorized     nada a perguntar; busca o token
notDetermined  e nunca perguntamos  → oferece a explicação
notDetermined  e já perguntamos     → não oferece
denied         → NUNCA volta a perguntar sozinho
unavailable    → não oferece, e não diz que a pessoa recusou
```

Pedido sem contexto é recusado, e no Android a recusa é lembrada: a partir da
segunda negativa o sistema nem exibe o diálogo. Perguntar cedo demais não
adianta a permissão — **gasta a única boa chance de obtê-la**.

A marca de "já perguntamos" é **um booleano** em `SharedPreferences`. Não é
segredo, então não vai para o armazenamento seguro; e nada além dele é
gravado — nem token, nem e-mail, nem data.

### `unavailable` não é `denied`

Um é ausência de infraestrutura, o outro é decisão da pessoa. Colapsá-los
faria a tela dizer "você recusou" para quem nunca foi perguntado — e é
exatamente o estado do AlfaOS enquanto o projeto oficial do Firebase não
existir. São dois valores distintos do enum, com teste próprio.

`deniedPermanently`, que o plugin expõe, **é** colapsado em `denied`: a conduta
é a mesma, e estado a mais no domínio só se justifica quando muda o que o
aplicativo faz.

### Nada disso derruba o aplicativo

Toda chamada ao Firebase é protegida, e a oferta de permissão roda **fora** do
`try` do login: o técnico entrou, e se o Firebase não existe, se a permissão é
recusada ou se o provedor cai, ele continua com OS, Jornada e execução. Push é
capability, não requisito — e a `Notification` interna existe de qualquer
jeito, no sino.

A inicialização também **não bloqueia a subida**: ela acontece depois do
login, e não no `main()`.

### O token não é persistido, e não é impresso

O SDK do Firebase é a autoridade sobre o token; guardá-lo em disco criaria uma
segunda cópia que envelhece. E nenhum `print`, `debugPrint` ou `log` do
aplicativo recebe token — verificado por inspeção e pela prova de reversão
`A`. O redator de log já censurava `pushtoken`; agora não há o que censurar.

### A fronteira com o `NF-3`

`NF-2` **expõe** o token e a rotação. **Não registra nada no backend** — não
chama `/devices/register`, não toca no login do servidor. Antecipar isso faria
o registro nascer sem os testes de idempotência que a fase seguinte prevê, e a
fronteira está exatamente em `PushCoordinator.tokenRefresh`.

### Testes — 23 novos

```text
NF2-01  inicializa uma vez; a segunda chamada não tenta de novo
NF2-02  já autorizado: não pergunta, e busca o token
NF2-03  negado: não quebra, e não volta a perguntar sozinho
NF2-04  o token vem depois de a permissão ser concedida
NF2-05  permissão concedida sem token não quebra
NF2-06  rotação emite o token novo para quem for registrá-lo
NF2-07  provedor indisponível não impede nada; unavailable ≠ denied;
        a stream de rotação é vazia sem Firebase
NF2-08  o token viaja no RESULTADO, não em log
NF2-09  construir o coordenador não inicializa, não consulta e não pergunta
NF2-10  depois do login, a oferta existe — oferecer não é perguntar
NF2-11  "agora não" mantém o app e não repete a pergunta
NF2-12  três logins depois de uma recusa: nenhuma pergunta nova
NF2-13  o manifesto declara POST_NOTIFICATIONS e nada além do necessário
NF2-14  o plugin do Gradle é condicional, e a versão é declarada sem aplicar
NF2-15  nenhum google-services.json versionado, nenhuma chave no Android
        e os três identificadores não se misturam
```

### Provas de reversão

```text
A  imprimir o token                      inspeção: nenhum print/log no módulo
B  pedir permissão no construtor         7 testes falham
C  negação lança e bloqueia              NF2-03, NF2-07 e NF2-12 falham
D  não escutar a rotação                 NF2-06 falha
E  falha do Firebase sobe como exceção   NF2-01 falha
F  devolver installationId como token    NF2-04, NF2-05 e NF2-08 falham
G  perguntar sempre, mesmo negado        NF2-03, NF2-11 e NF2-12 falham
```

### O que o operador ainda precisa fazer

```text
1. criar ou reusar o projeto Firebase da plataforma
2. registrar o app Android com o applicationId com.jamalsoftware.alfaos.field
3. baixar o google-services.json e colocá-lo em apps/field/android/app/
   — ele NAO vai para o Git, e o .gitignore já o cobre
4. a credencial de servidor do NF-1 continua sendo outra coisa, e mora
   somente no ambiente do worker
```

Enquanto isso não acontecer, o aplicativo compila, roda e trabalha — e o push
fica `unavailable`, dito com essa palavra e não como recusa da pessoa.

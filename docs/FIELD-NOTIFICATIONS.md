# AlfaOS — Field Notification Foundation: plano de implementação

Plano da fase descrita no PRD **§153–§157**. Mora aqui, e não no PRD, pelo
mesmo motivo que `DISPATCH-QUEUE.md`: o PRD é visão de produto, e provider,
ciclo do token, política de retry e contrato de payload são engenharia.

> **Estado: `NF-1` a `NF-4` ENTREGUES. `NF-5` — piloto em aparelho físico — em
> curso: dois defeitos reais encontrados e corrigidos (permissão do Android e
> sino no cold start, §28), com o piloto completo ainda dependendo da conta de
> serviço do Firebase no worker.**
>
> O provider real do FCM existe, a seleção por configuração existe, e o defeito
> de logout que a §2 registrou foi corrigido (§24). O Flutter inicializa o
> Firebase, pede a permissão com contexto e obtém o token (§25). O token chega
> ao `MobileDevice.pushToken` e acompanha a rotação (§26). E o toque numa
> notificação leva à OS, atrás do guarda de sessão (§27).
>
> **Nenhuma migration, nenhum projeto Firebase criado e nenhum segredo
> versionado.** O aplicativo compila e roda **sem** o `google-services.json`;
> enquanto ele não existir, o push fica `unavailable`. **Nenhum push chega a um
> aparelho ainda** — não por falta de encanamento, que a `NF-3` e a `NF-4`
> fecharam, mas porque sem o `google-services.json` o provedor não emite token
> nenhum. O que falta é o §15 e o piloto físico (`NF-5`).

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
| **NF-3** ✅ | Flutter: enviar o token no `devices/register`, listener de rotação, ciclo de sessão | ❌ | — **ENTREGUE, ver §26** |
| **NF-4** ✅ | Deep link do toque, nos três estados, atrás do guard de sessão | ❌ | — **ENTREGUE, ver §27** |
| **NF-5** `PLANNED` | Piloto em aparelho físico e endurecimento | ❌ | depende do `google-services.json` (§15) |
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

---

## 26. `NF-3` — o que foi entregue

O token do FCM chega ao `MobileDevice.pushToken` e continua chegando quando o
Firebase o rotaciona. **Nenhuma migration, nenhuma dependência nova, nenhum
endpoint novo** — a rota `POST /api/field/v1/devices/register` já aceitava
`pushToken` desde o `NF-0`, e o que faltava era o aplicativo mandá-lo.

**Ainda assim, nenhum push chega a um aparelho**, e a razão não mudou: sem o
`google-services.json` da plataforma, o provedor responde `unavailable` e o
token nem existe. O que a `NF-3` fecha é o encanamento; a água depende do §15.

### 26.1 Nenhuma segunda abstração

O `PushCoordinator` do `NF-2` ganhou a responsabilidade, em vez de nascer uma
classe nova ao lado dele. Ele já era o dono do ciclo de vida do push; uma
`PushTokenManager` teria de reimplementar o mesmo controle de sessão, e as duas
divergiriam no primeiro logout.

O destino é uma **função** — `PushTokenSink` —, não o repositório de
autenticação. O coordenador mora em `core/` e não pode enxergar `features/`,
mas a razão maior é de responsabilidade: quem está ali decide **quando** há um
token para registrar, e nada mais. Empresa, usuário e dono do aparelho são
derivados da autenticação no servidor.

> **Correção de registro:** o `NF-3` foi escrito supondo um
> `PushRegistrationService` existente. Ele **não existe** — o `NF-2` o removeu
> de propósito (§25), por ser costura inerte sem consumidor. A instrução de
> reutilizar valeu, e o alvo foi o `PushCoordinator`.

### 26.2 A sessão é o portão, e a assimetria é deliberada

`startSession()` e `stopSession()` são chamados por **um** ponto do
`SessionController` — um `_apply` que troca a fase e acerta o push junto.
Espalhar as duas chamadas pelos seis lugares que mudam a fase funcionaria hoje
e falharia no dia do sétimo, com um sintoma que nenhuma tela mostra.

**Ligar não é esperado. Desligar é.**

```text
authenticated   → unawaited(startSession())   a entrada não espera o push
qualquer outra  → await   stopSession()       é isto que fecha a corrida do §17
```

A primeira metade não é preferência: com `await`, o `login()` **nunca
retornava** em ambiente sem Firebase, e a tela ficava com o indicador girando.
`Firebase.initializeApp()` não completa num teste de widget, e nada garante que
complete num aparelho sem Google Play. Push é capability; a sessão não espera
por capability. Dois testes de widget que já existiam foram os que apontaram
isso — o valor de rodar a suíte inteira, e não só a da fase.

Pela mesma razão, **o cancelamento da assinatura não é esperado**: a rotação
real é servida por um canal de plataforma cujo `cancel()` pode não responder, e
esperar por ele pendurava o `logout()` para sempre. Quem garante que nada mais
é enviado é a marca de sessão ativa, não o cancelamento — que é higiene.

### 26.3 Os quatro desfechos do token

```text
token disponível + permissão concedida   registra
token null                               NÃO envia `pushToken: null`
permissão negada                         não registra
rotação sem sessão                       nenhuma requisição
```

`null` **não é revogação** (§11 do enunciado). O contrato do servidor lê
`pushToken: null` como "apague", e o provedor devolve `null` por motivo banal —
ainda não terminou de emitir. Mandar `null` aí apagaria um token que
funcionava. A chave simplesmente não vai no corpo.

**Permissão negada não registra**, e isso é uma decisão. No Android o
`getToken()` responde mesmo sem permissão de notificação: o token existe, e é a
ENTREGA que o sistema descarta. Registrar assim faria `pushToken != null`
significar "existe um endereço" em vez de "dá para avisar esta pessoa" — e a
segunda é a pergunta que o worker faz.

### 26.4 A corrida entre logout e rotação

O cenário do §17: a rotação chega, o logout começa, o servidor limpa o
`pushToken`, e o callback antigo o grava de volta. Um aparelho de onde o
técnico acabou de sair volta a ser destino de notificação, sem nada na tela
mostrando isso.

A ordem que fecha:

```text
1. a sessão cai       (nenhum envio NOVO começa)
2. espera-se o que JÁ está em voo, sob a credencial ainda válida
3. só então o logout limpa o servidor
```

Os envios em voo são guardados num **mapa por token**, não numa future só. Dois
envios podem se sobrepor no caminho normal do primeiro login — `requestNow()`
entrega o token recém-concedido e o provedor emite a rotação com esse mesmo
token quase no mesmo instante —, e uma future só faria a segunda sobrescrever a
primeira, deixando a primeira órfã: ninguém a esperaria, e a resposta atrasada
regravaria o token depois da limpeza. Com a chave sendo o token, o envio
repetido do mesmo valor nem começa: ele adere ao que já está a caminho.

### 26.5 Técnico A sai, técnico B entra

O token é da **instalação**, não da pessoa: ele não muda quando o técnico troca.
A memória de "já registrei este token" é zerada no fim da sessão — se
sobrevivesse, B nunca registraria, e o aparelho ficaria mudo para ele sem
nenhum sinal.

Do lado do servidor, `(companyId, userId, installationId)` dá a B uma linha
própria. E o registro agora **solta o token da linha antiga da mesma empresa**:
o caso real é o par que divide o aparelho da empresa quando o `logout` de A não
alcançou o servidor — o aplicativo limpa a sessão local de qualquer jeito,
porque sair precisa funcionar offline —, e sem essa limpeza uma notificação
endereçada a A chegaria no aparelho que B está segurando, com número de OS e
nome de cliente na tela de bloqueio.

**A limpeza é escopada por `companyId`**, como toda escrita do projeto. Um
aparelho compartilhado entre empresas DIFERENTES fica fora do alcance dela, e
isso é risco conhecido e aceito: fechá-lo exigiria escrever na linha de outro
tenant. Registrado em `SECURITY.md` §8.13.

### 26.6 Idempotência: o servidor deixou de auditar o que não mudou

`registerDevice` contava "veio no corpo" como alteração. O aplicativo reenvia o
mesmo token a cada abertura — comportamento correto dele, já que o provedor é a
autoridade sobre o valor —, então cada abertura gravava uma linha de auditoria
idêntica, e a trilha do aparelho crescia no ritmo exato em que deixaria de ser
lida. Agora o `changed` compara com o estado atual: cinco registros iguais, uma
linha de auditoria.

`lastSeenAt` continua avançando sempre. Ele é batimento, não mudança.

O aplicativo também não repete: um token já confirmado não vira requisição.
São duas defesas para coisas diferentes — a do cliente evita a viagem, a do
servidor evita o ruído de qualquer cliente.

### 26.7 O que a auditoria independente mudou

Auditoria adversarial em sessão separada, sobre o diff: **`APPROVED WITH
RISKS`**, 0 CRITICAL, 0 HIGH, 0 MEDIUM, 3 LOW e 5 INFO. Os três LOW foram
corrigidos, não só registrados.

**O mais importante era um teste meu que não provava o que dizia.** O `NF3-10`
comparava índices na lista de requisições do transporte falso — que é
preenchida no **despacho**, antes do atraso. Como o teste despachava a rotação
antes de chamar o logout, o índice já estava cravado: **a asserção passava com
a ordem do `logout()` invertida.** Verificado invertendo de fato: 19 de 19
verdes com o código quebrado. O transporte falso ganhou uma linha do tempo com
despacho E conclusão, e a asserção passou a ser sobre conclusão.

Os outros dois: o mapa de envios em voo da §26.4 nasceu de um `LOW` sobre a
future única; e o teste cross-tenant ganhou controle positivo, porque sem ele
uma requisição que falhasse por qualquer motivo deixaria a asserção verde
provando nada.

Dois `INFO` viraram código por serem baratos: o predicado de escrita passou a
exigir aparelho ativo e não revogado — uma revogação que commite entre a
autenticação e a escrita deixaria um token gravado em linha `REVOKED` —, e o
`tokenRefresh` público do coordenador virou `@visibleForTesting`, porque
assinar por ali receberia a rotação sem passar pelo portão de sessão.

### 26.8 Provas de reversão

Oito sabotagens do enunciado, mais quatro reversões próprias.

```text
A  registrar sem sessão ativa            NF3-06 e NF3-12 falham
B  segundo login não cancela a anterior  NF3-12 falha
C  stopSession não desliga nada          NF3-09, NF3-10 e NF3-11 falham
D  memória de registro sobrevive ao sair NF3-11 falha
E  token gravado em SharedPreferences    NF3-15 falha (dois testes)
F  token impresso em log                 NF3-13 falha
G  aparelho revogado reativado           ver abaixo
H  cada rotação cria outro MobileDevice  9 testes falham, entre eles B02 e B03

1  ordem do logout invertida             NF3-10 falha (dois testes)
2  esperar só o último envio             NF3-10 falha
3  sem guarda de token já em voo         NF3-10 falha
4  escrita sem predicado de estado       NF3-B06 falha
```

**A sabotagem `G` passou na primeira tentativa, e o defeito era do teste.**
`revokeDevice` apaga o `tokenHash` junto, então o token da sessão deixa de
resolver por conta própria: o `NF3-B06` recebia o 401 por outra porta e
passaria mesmo sem o guarda de `status` na autenticação. Nasceram daí dois
testes — um sobre o login, que é o único caminho capaz de devolver credencial
válida a uma linha revogada, e outro que monta à mão o estado `REVOKED` com
`tokenHash` vivo, o único jeito de exercer a segunda tranca isoladamente. Com
eles, cada metade de `G` derruba o seu.

**As reversões 1 e 3 também passaram antes de os testes serem corrigidos.** A 1
está descrita na §26.7. A 3 falhava porque a rotação era emitida antes de a
assinatura existir, e um `Stream.broadcast` descarta evento sem ouvinte: a
sobreposição que o teste queria provar nunca acontecia.

### 26.9 Gates

```text
1689 Vitest        (era 1670)
 116 Playwright    inalterado
 360 Flutter       (era 339)
lint, tsc, build, build:worker, dart format, flutter analyze
prisma validate, 24 migrations — NENHUMA nova
APK debug construído, sem google-services.json
```

Uma falha de suíte apareceu e **não era da fase**: `time-clock-effective` usa
`Date.now() - 60_000` como horário de correção, que no primeiro minuto depois
da meia-noite cai no dia civil anterior. A execução começou 23:56 e atravessou
a virada. É a mesma bomba-relógio que a `DQ-4` desarmou em
`time-clock-routes.test.ts` com `- 30min`; as três ocorrências restantes foram
travadas no início do dia civil da empresa.

### 26.10 O que o `NF-3` deliberadamente NÃO faz

```text
deep link do toque          NF-4
onMessageOpenedApp          NF-4
getInitialMessage           NF-4
banner em primeiro plano    NF-4
notificação local           NF-4
piloto em aparelho físico   NF-5
fila offline de registro    não previsto — a próxima sessão tenta de novo
enviar `pushToken: null`    nunca; quem limpa é o logout, no servidor
```

O registro **não tem retentativa própria**. Falha de rede, `401` e `403` são
engolidos, não marcam o token como registrado, e a próxima oportunidade
autenticada tenta de novo. Sem laço, sem fila, sem backoff — a próxima
oportunidade chega sozinha, na abertura seguinte ou na rotação seguinte.

---

## 27. `NF-4` — o que foi entregue

O toque numa notificação leva à OS. **Zero migration, zero dependência, zero
endpoint novo, zero mudança de backend** — o `git diff` do servidor tem apenas
testes.

Nenhuma notificação local foi criada, e nenhuma tela foi redesenhada: o
`FIELD DESIGN FREEZE` continua valendo, e esta fase é comportamento.

### 27.1 Um parser, e ele é uma allowlist

`PushDestination.fromData` é o **único** lugar que interpreta payload. Três
listeners com três interpretações divergiriam no dia do primeiro evento novo, e
o que divergiria em silêncio é para onde o técnico é levado.

Ele exige `type == SERVICE_ORDER_ASSIGNED`, `resourceType == ServiceOrder` e um
`resourceId` que case `^[A-Za-z0-9_-]{1,64}$`. Qualquer outra coisa devolve
`null`, e **nada lança**: o payload vem da rede e de uma camada nativa, e o
parser roda na ABERTURA do aplicativo, ao consultar o toque que o abriu. Um
parser que estoura ali não deixa o aplicativo subir.

**A validação do identificador é segurança, não capricho.** Ele preenche UM
segmento de `/orders/:id`; sem a regra, `resourceId = "abc/execucao"` montaria
`/orders/abc/execucao` e o payload passaria a **escolher a tela**. Barra, ponto,
interrogação, porcentagem, espaço e unicode ficam de fora.

### 27.2 Push indica destino; ele não autoriza nada

O único dado do payload que sobrevive é o identificador dentro da rota. A tela
de detalhe busca a OS pelo caminho autenticado de sempre, e `getFieldServiceOrder`
continua filtrando por `companyId` **e** `technicianId` em SQL — sem saber que a
navegação veio de um push.

Os dois desfechos que isso garante estão provados contra Postgres real:

```text
OS reatribuída entre o envio e o toque   404, com controle positivo
OS de outra empresa                      404, com controle positivo
```

O `404` é escolha, não acaso: `403` confirmaria que aquele id existe, que é
exatamente o fato que um técnico sondando ids não pode aprender.

### 27.3 Os três estados, e a distinção que os separa

```text
app FECHADO      getInitialMessage()      toque → navega
app em SEGUNDO   onMessageOpenedApp       toque → navega
app ABERTO       onMessage                NINGUÉM tocou → só atualiza estado
```

O erro clássico da integração de push é tratar "chegou mensagem" e "a pessoa
tocou na mensagem" como o mesmo evento. Eles são opostos em intenção. Trocar a
tela debaixo da mão de um técnico que está no meio de uma execução é a pior
coisa que um aplicativo de campo pode fazer — e ele nem pediu.

Em primeiro plano o aplicativo recarrega **três** coisas: fila do despacho,
lista de OS e contagem do sino. Recarregar tudo puxaria jornada, estoque e
sessão junto, em cima de alguém que muitas vezes está em borda de sinal.

### 27.4 O guarda é o do roteador, e não há segunda porta

Sem sessão, o destino **espera**. Empurrar a rota funcionaria — o `redirect` do
`GoRouter` mandaria para o login de qualquer jeito —, mas funcionaria por
acidente, e o destino se perderia no caminho.

O pendente é memória, nunca disco: um ponteiro para recurso de uma empresa não
sobrevive ao logout. E ele é **descartado** quando a fase vira `unauthenticated`
ou `revoked`, porque um destino guardado durante o técnico A não pode abrir na
sessão do técnico B, que entrou no mesmo aparelho em seguida.

Um teste estrutural proíbe `Navigator.`, `GoRouter` e `go_router` dentro do
`PushNavigator`, com os comentários removidos antes da asserção.

### 27.5 O defeito que a auditoria encontrou, e que nenhum teste de unidade veria

**O caminho real de produção estava quebrado, e falhava em silêncio.**

O destino pendente é consumido quando a fase da sessão muda — exatamente o
instante em que o `routerProvider` é invalidado, porque ele observa essa fase.
O `push` acertava um `GoRouter` recém-criado cujo delegate ainda não fora
anexado à árvore, e a resolução da rota inicial que vinha em seguida
**descartava** o empilhamento.

O sintoma: o técnico tocava o aviso, entrava, e caía no Início. Sem erro, sem
log, sem nada que explicasse por que a notificação não levou a lugar nenhum.

Todos os testes de unidade da fase passavam, porque todos injetam um roteador
falso — eles provam a DECISÃO, não a expressão que roda em produção. A auditoria
independente apontou a lacuna como `LOW`; ao escrever o teste que a fecha
(`test/widget/push_deeplink_route_test.dart`, com o `GoRouter` de verdade), a
lacuna virou defeito reproduzido.

A correção é empilhar **depois do quadro**, com `ensureVisualUpdate` para
garantir que exista um quadro pelo qual esperar — um toque com o aplicativo já
aberto não muda estado nenhum por conta própria. Provado nos dois sentidos.

### 27.6 A central de notificações usa o mesmo parser

Ela já navegava, com um predicado próprio: `resourceType == 'ServiceOrder'` e
`resourceId` não vazio. Agora passa por `PushDestination`, porque a pergunta é
idêntica — "para onde este aviso leva?" — e duas respostas divergiriam.

**Registro honesto do ganho:** isto é endurecimento em profundidade, e **não** o
fechamento de um vetor explorável. Existe uma única escrita de
`Notification.resourceId` em produção, e ela grava o `id` da OS. O buraco existia
no código e não tinha fonte que o alcançasse. O valor está em não depender de a
única fonte continuar sendo a única.

Preço declarado: um `type` futuro apontando para OS — a mensagem "a OS saiu de
você", por exemplo — deixará de navegar **em silêncio** até alguém estender o
parser. É o custo da allowlist, e é preferível ao contrário.

### 27.7 Repetição, e a tela onde a pessoa já está

Duas defesas independentes, para coisas diferentes:

* **`messageId` já tratado** — janela de 32 ids em memória. Cobre o mesmo toque
  entregue duas vezes pela plataforma.
* **"já estou lá"** — `startsWith`, e não igualdade: quem está em
  `/orders/x/execucao` está DENTRO daquela OS, e tirá-lo da execução para
  mostrar o detalhe dela seria perder trabalho em andamento por causa de um
  aviso sobre o que ele já está fazendo.

A primeira só ficou provada depois da auditoria: o teste original repetia a
mensagem com o técnico já na OS, e a segunda defesa o descartaria sozinha — a
asserção passava com a deduplicação removida.

### 27.8 Provas de reversão

Oito sabotagens do enunciado, mais três reversões próprias.

```text
A  navegar sem sessão                     NF4-07, 08, 09, 11 e 18 falham
B  primeiro plano navega sozinho          NF4-13 e NF4-14 falham
C  qualquer `type` vira OS                NF4-02 e NF4-15 falham
D  posse fora do predicado da consulta    NF4-17 falha
E  a mesma, no eixo temporal              NF4-16 falha
F  repetição empilha                      NF4-12 (2) e NF4-19 (2) falham
G  ouvinte duplicado                      ver abaixo
H  deep link quebra o Voltar              NF4-21 falha

1  `push` sem esperar o quadro            teste do roteador real falha
2  deduplicação removida                  NF4-12 falha
3  grep de fonte sem tirar comentários     — corrigido antes de ser explorado
```

**A sabotagem `G` passou na primeira rodada, e o defeito era do teste.** A
deduplicação do coordenador e a guarda de "já estou lá" **mascaram** ouvintes
duplicados: o segundo evento é descartado, a contagem de navegações continua
certa, e o vazamento segue vivo — acumulando uma assinatura por reinício. A
correção foi contar assinaturas VIVAS no duplo, e não navegações. Com isso, `G`
cai.

### 27.9 Gates

```text
1694 Vitest        (era 1689)
 116 Playwright    inalterado
 399 Flutter       (era 360)
lint, tsc, build, build:worker, dart format, flutter analyze
prisma validate, 24 migrations — NENHUMA nova
APK debug construído, sem google-services.json
```

Auditoria independente: **`APPROVED WITH RISKS`** — 0 CRITICAL, 0 HIGH, 0
MEDIUM, 3 LOW, 7 INFO. Os três `LOW` foram corrigidos, e um deles era o defeito
da §27.5. Dois `INFO` viraram código: a atualização de primeiro plano passou a
consultar a sessão, e a afirmação sobre a injeção na central foi corrigida para
o que ela de fato é.

### 27.10 O que a `NF-4` deliberadamente NÃO faz

```text
flutter_local_notifications   fora de escopo, e não instalado
banner em primeiro plano      NF-0 decidiu que não; continua não
navegar em primeiro plano     nunca — ninguém tocou em nada
marcar lida ao tocar o push   a central tem regra própria, preservada
eventos de push novos         o parser é allowlist; um evento novo é trabalho
rastreio de entrega           NF-6, e só se houver quem leia
iOS                           fora
```

**Falta o piloto físico (`NF-5`).** Gesto de sistema, toque em notificação real
e ordem de subida não se aprovam por teste de widget — e a §27.5 é a prova
disso: o caminho de produção estava quebrado com 34 testes verdes.

---

## 28. `NF-5` — o sino no cold start

O piloto físico entregou o cenário completo e ele falhou num ponto só:
aplicativo **encerrado**, OS atribuída, worker `provider=fcm reivindicados=1
processados=1`, notificação nativa entregue, aplicativo aberto, **OS presente**
— e o contador do sino no número antigo.

### 28.1 A causa

O contador só era lido em dois lugares, e nenhum deles é a subida:

```text
providers.dart  onForeground    push chegando com o app ABERTO
notifications_screen.dart       ao visitar a própria tela de notificações
```

Não havia caminho de leitura em `bootstrap`, em `authenticated`, nem no
tratamento do toque. **Um aplicativo aberto do zero mostrava zero, sempre.** Não
por decisão de exibir zero: por nunca ter perguntado.

E a regra estava documentada como intencional no `notifications_bell.dart`, que
dizia ser honesto ficar em zero até a tela ser visitada, porque buscar em
segundo plano gastaria bateria "antes de o push real existir (§153)". O push
real passou a existir na `NF-1`–`NF-4`. A mesma regra deixou de ser honestidade
e virou o defeito: o aviso chegava ao aparelho e a tela dizia, com número, que
não havia nada. O comentário foi **revisto, não apagado**.

### 28.2 Dois gatilhos, e a distinção é o ponto

| Gatilho | Onde | Cobre |
|---|---|---|
| Sessão vira `authenticated` | `app.dart` | cold start com toque, cold start sem toque, login comum |
| Toque tratado com sessão viva | `push_navigator.dart` | abertura em segundo plano |

O primeiro **não é sobre push**: a pergunta que ele responde é "existe alguém
autenticado aqui?". Pendurá-lo num callback do Firebase faria o sino depender de
um provedor que, num aparelho sem Google Play, nunca fala. Ele acontece depois
do `/me`, então o token já está no cofre.

O segundo existe porque a abertura em segundo plano **não muda fase nenhuma** —
a sessão já estava autenticada. Sem ele, o toque levava à OS com todo o resto
velho.

O toque relê o **mesmo** que a chegada em primeiro plano relê. A diferença entre
"chegou com o app aberto" e "chegou com o app fechado" é só se havia alguém
olhando; fazer os dados dependerem disso seria arbitrário.

### 28.3 O backend continua sendo a autoridade

Nada soma. `load()` **substitui** o estado pela resposta, e é por isso que o
sino desce quando alguém lê os avisos noutro aparelho — coisa que um `count++`
jamais faria. Repetir a leitura não duplica: os três controladores recusam uma
segunda carga enquanto a primeira está em voo.

Medido, não presumido: na subida por toque a leitura é **uma**.
`getInitialMessage()` resolve por microtask enquanto o `/me` espera a rede, de
modo que o toque sempre encontra a sessão em `bootstrapping`, o destino fica
pendente e quem relê é o gatilho de fase, sozinho.

### 28.4 Achado próprio: a contagem sobrevivia ao logout

Não estava no enunciado. **Nada invalidava o estado de notificações quando a
sessão terminava**: o técnico seguinte no mesmo aparelho entrava e o sino trazia
o número do anterior até a releitura responder — e um toque nesse intervalo
abriria a **lista** do anterior, com número de OS e nome de cliente na tela.
`clear()` na saída, coberto por `NF5-BELL-09`.

### 28.5 A prova física

Mesmo aparelho, mesma sessão, mesmo servidor, cold start sem push nenhum:

```text
banco          Tecnico Alfa, 6 notificações não lidas
ANTES (build sem a correção)   sino SEM badge
DEPOIS (build com a correção)  sino com badge 6
```

O resto da tela ficou idêntico — mesmas OS, mesma ordem, mesmo layout. Só o sino
mudou, que é o controle do experimento.

**Os dois caminhos de callback não foram validados fisicamente**
(`NF5-BELL-02` terminado-com-toque e `NF5-BELL-03` segundo-plano-com-toque):
eles exigem o worker com a conta de serviço do Firebase, que não está no
`.env` do repositório. Ambos têm regressão, e a reversão prova cada um
separadamente.

### 28.6 Provas de reversão e sabotagens

```text
R1  gatilho de sessão removido       9 testes falham, todos com Actual: <0>
R2  releitura no toque removida      NF5-BELL-03 falha, Actual: <0>
S-A load soma em vez de substituir   NF5-BELL-06 (2) e NF5-BELL-07 caem
S-B1 allowlist aceita qualquer type          NF5-BELL-08 cai
S-B2 allowlist aceita qualquer resourceType  NF5-BELL-08 cai
S-B3 allowlist aceita qualquer resourceId    NF5-BELL-08 cai
S-C logout não limpa                 NF5-BELL-09 cai
S-D lê em toda fase                  NF5-BELL-09 cai
```

Duas correções que as próprias provas impuseram. A `NF5-BELL-08` original
mandava payloads errados em **três** campos ao mesmo tempo, e teria passado com
a allowlist relaxada em dois deles — agora cada payload erra em um campo só. E
a `NF5-BELL-07` afirmava `lessThanOrEqualTo(2)`, que **tolerava** a segunda
requisição; o número foi medido e a afirmação virou exata.

A `S-D` não foi pega pela contagem de requisições da `NF5-BELL-04`, e a razão é
o Riverpod: `ref.listen` só dispara em **mudança**, e o estado inicial já é
`bootstrapping` — ler em toda fase é indistinguível na subida. Quem a pega é o
logout.

### 28.7 Copy

`"Nova OS atribuída"` → `"Nova OS"` (`src/lib/service-orders.ts`). Uma linha de
produção e quatro asserções de teste; nenhuma superfície web renderiza
`Notification`, que é dado exclusivo do Field.

### 28.8 Pendência NÃO corrigida: token só após reiniciar

O piloto observou que, depois de conceder `POST_NOTIFICATIONS`, o token do FCM
só apareceu no backend na reabertura do aplicativo.

Leitura do código: `requestNow()` faz a sequência certa — pede a permissão,
obtém o token e entrega. A hipótese é que `getToken()` responda `null` logo após
a concessão, com o registro no FCM ainda em voo; `_entregar(null)` corretamente
não envia nada, **e nada retenta**. Na reabertura, `startSession()` pergunta de
novo e o token existe.

**É hipótese, não diagnóstico provado** — confirmá-la exige o aparelho com o
Firebase configurado, e corrigir às cegas violaria a regra de não adivinhar. A
correção seria uma política de retentativa nova, com testes próprios, e não
pertence a esta alteração.

### 28.9 Gates

```text
1694 Vitest        inalterado
 116 Playwright    inalterado
 423 Flutter       era 411
lint, tsc, build, build:worker, dart format, flutter analyze
prisma validate, 24 migrations — NENHUMA nova
APK debug construído e instalado em aparelho físico
```

Nenhuma migration, nenhuma dependência, nenhum endpoint novo. O diff de servidor
é uma string e quatro asserções.

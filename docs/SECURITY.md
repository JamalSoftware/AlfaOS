# Segurança — AlfaOS (v0.3-technician-execution)

Este documento descreve as medidas de segurança implementadas nos checkpoints
de hardening (`v0.1.1-hardening`) e do núcleo operacional de Ordens de Serviço
(`v0.2-service-orders`) sobre a fundação `v0.1-foundation`.

## 1. Autenticação e sessão

- **JWT assinado com `jose`** (`HS256`): o payload contém apenas `userId`,
  `iat` e `exp`. Nenhum dado sensível é embutido no token.
- **Sessão revalidada a cada request**: `getSessionUser` busca o usuário no
  banco a cada acesso. Alterações de perfil, desativação ou remoção de conta
  têm efeito imediato — o token em si não carrega privilégios.
- **Cookie de sessão**: `HttpOnly`, `Secure` (produção), `SameSite=Lax`,
  `Path=/`, `Max-Age=12h`. Inacessível via JavaScript.
- **Validação de ambiente**: `validateEnv` falha cedo (fail-fast) se
  `DATABASE_URL`/`AUTH_SECRET` estiverem ausentes, se `AUTH_SECRET` tiver
  menos de 32 caracteres, ou se for o valor padrão em produção. Nunca expõe o
  valor dos secrets nas mensagens de erro.

## 2. Rate limit de login (anti brute-force)

- Persistente em PostgreSQL (tabela `LoginAttempt`), funciona em
  multi-instância (sem estado em memória).
- **Por e-mail**: `LOGIN_MAX_FAILED_ATTEMPTS` (padrão 5) falhas em uma janela
  deslizante de `LOGIN_WINDOW_SECONDS` (padrão 900s) → `429`.
- **Por IP**: `LOGIN_MAX_FAILED_ATTEMPTS_BY_IP` (padrão 20) falhas → `429`.
  Só se aplica quando um IP confiável pôde ser estabelecido (ver 2.1).
- **Não existe teto global.** Todo contador aqui é **atribuível**: só bloqueia o
  identificador que efetivamente produziu as falhas. O antigo
  `LOGIN_MAX_FAILED_ATTEMPTS_GLOBAL` foi **removido** em
  `v0.2.2-pre-v03-hardening` — era acionável por qualquer anônimo e derrubava o
  login de todos os tenants (ver 2.2).
- O custo de CPU do bcrypt, que era a justificativa do teto global, é contido na
  origem por um **portão de admissão** em `src/lib/password.ts` (ver 2.2).
- Nenhum bloqueio é permanente; a janela expira sozinha.
- Os dois tetos são avaliados em `isLoginBlocked`, chamado **antes** do
  `prisma.user.findUnique` e **antes** do `verifyPassword` — rejeitar depois do
  bcrypt não protegeria nada (o custo já teria sido pago).
- Tentativas bloqueadas geram auditoria `AUTH.RATE_LIMITED` **uma vez por
  usuário por janela** (só na transição para bloqueado). Gravar uma linha por
  requisição rejeitada permitiria a um flood anônimo inflar `audit_logs` e
  empurrar qualquer evento real de segurança para fora do painel "Atividade
  recente" do dashboard, que lê apenas as 10 últimas linhas.
- A resposta de login rejeitado é sempre a mesma (`401 "Credenciais inválidas."`)
  para usuário inexistente, inativo ou senha errada, e um `bcrypt.compare`
  contra um hash dummy é executado quando a conta não existe, para nivelar o
  tempo de resposta. Assim não há **enumeração de contas** por mensagem nem por
  timing. O motivo real continua registrado internamente
  (`AUTH.LOGIN_BLOCKED` para inativo, `AUTH.LOGIN_FAILED` para senha errada).

### 2.1. Trusted Proxy / Rate limiting por IP

`X-Forwarded-For` é um header **controlado pelo cliente**. Confiar nele sem
validação permite dois ataques não autenticados: bloquear o login de um IP de
terceiros (basta forjar o IP da vítima em ~20 tentativas falhas) e evadir o
limite por IP (basta randomizar o header a cada tentativa). Por isso o header
só é lido quando existe proxy reverso declaradamente confiável.

**Variável de ambiente: `TRUSTED_PROXY_HOPS`** (inteiro, padrão `0`) — número
de proxies reversos confiáveis à frente da aplicação.

| Valor | Comportamento |
| --- | --- |
| `0` (padrão) | `X-Forwarded-For` é **ignorado por completo**. Usa-se apenas o IP da conexão fornecido pelo runtime, quando existir. |
| `N >= 1` | Usa-se o endereço escrito pelo proxy confiável mais externo: `chain[chain.length - N]` no `X-Forwarded-For` (mesma semântica de `trust proxy = N` do Express). Tudo à esquerda desse índice é entrada enviada pelo cliente e **nunca** é selecionado. |

Por que `chain.length - N` e não "pular N a partir da direita": cada proxy
confiável acrescenta o endereço do peer de quem recebeu a requisição. Com um
único proxy (`N=1`), o endereço real do cliente é justamente o **último**
elemento da lista; com dois (`N=2`), o penúltimo; e assim por diante.

O valor extraído é validado como IPv4/IPv6 (aceitando as formas `v4:porta` e
`[v6]:porta`) antes de ser usado. Valor ausente ou inválido não vira exceção —
cai no fallback descrito abaixo.

**Limitação conhecida do runtime**: o App Router do Next.js 14 não expõe o
socket TCP aos route handlers. `NextRequest.ip` só é preenchido quando o
adaptador de hospedagem o injeta (ex.: Vercel) — e nesse caso não é
manipulável pelo cliente. Em `next start` self-hosted sem proxy configurado
não existe IP de conexão confiável.

**Fallback seguro (proteção contra DoS global)**: quando nenhum IP pode ser
estabelecido, `getClientIp` devolve o sentinela `unknown` com
`trusted: false`. Nesse caso o limite **por IP é simplesmente não aplicado** e
o registro em `LoginAttempt.ip` é gravado como `NULL`. A decisão é deliberada:
se todos os clientes caíssem no mesmo balde de fallback, o limite por IP
viraria um interruptor global — 20 falhas de qualquer usuário derrubariam o
login de toda a base. A proteção anti brute-force nesse cenário continua
existindo pelo limite **por e-mail** (5 falhas), que é por natureza
diferenciado por alvo.

**Riscos de configurar errado**:

- `TRUSTED_PROXY_HOPS` **maior** que o número real de proxies → passa-se a
  confiar em entradas enviadas pelo cliente: volta o spoofing de IP e a evasão
  do limite.
- `TRUSTED_PROXY_HOPS` **menor** que o número real (ex.: `0` atrás de um CDN) →
  todos os usuários compartilham o endereço do proxy; o código evita o
  bloqueio global só no caso do sentinela, então aqui o efeito é um limite por
  IP efetivamente compartilhado. Configure o número correto.
- Regra prática: só aumente o valor depois que a topologia estiver fechada e
  o proxy mais externo estiver comprovadamente sobrescrevendo (não apenas
  acrescentando) o header vindo do cliente.

### 2.2. DoS anônimo por bcrypt — portão de admissão (substitui o teto global)

> **Mudança em `v0.2.2-pre-v03-hardening`.** Esta seção descrevia um teto global
> (`LOGIN_MAX_FAILED_ATTEMPTS_GLOBAL`, padrão 200). Esse teto **foi removido**.
> O texto abaixo descreve por que ele era pior que o problema que resolvia e o
> que ficou no lugar.

**O ataque.** Para não vazar a existência de contas por timing, o login roda
`bcrypt.compare` **sempre**, inclusive contra o hash dummy quando o e-mail não
existe (ver seção 2). Cada tentativa custa ~350ms de CPU (custo 12, `bcryptjs`,
JS puro) na única thread que atende todos os tenants. Um atacante anônimo que
mande `POST /api/auth/login` em loop **com um e-mail aleatório novo a cada
requisição** escapa dos dois limites atribuíveis:

- o contador **por e-mail** fica sempre em 0 (e-mail inédito a cada tentativa);
- o contador **por IP** não é aplicado quando `getClientIp` devolve
  `trusted: false` — o caso **padrão** em `next start` self-hosted sem
  `TRUSTED_PROXY_HOPS`, já que o App Router do Next.js 14 não expõe o IP da
  conexão (`NextRequest.ip` fica `undefined`).

**Por que o teto global foi removido.** Ele era acionável por qualquer um, sem
credencial nenhuma: ~200 requisições com e-mails aleatórios (nenhuma conta
precisa existir) e **todo login do deployment passava a receber `429`** —
inclusive usuários legítimos com senha correta — por uma janela inteira de 15
minutos. Pior: a requisição bloqueada retornava `429` **antes** de
`recordLoginAttempt`, então sustentar o bloqueio custava ao atacante quase nada,
enquanto o `429` vs `401` ainda servia de oráculo para saber se o bloqueio
seguia de pé. Isso é um **interruptor de autenticação**, não um rate limit: a
defesa contra a negação de serviço *era* a negação de serviço.

**O que ficou no lugar: portão de admissão do bcrypt** (`src/lib/password.ts`).
O problema é consumo de CPU, então o limite passou a ser sobre a CPU, não sobre
um contador histórico de falhas:

| Variável | Padrão | Papel |
| --- | --- | --- |
| `BCRYPT_MAX_CONCURRENCY` | `2` | Hashes/comparações simultâneos. |
| `BCRYPT_MAX_QUEUE` | `32` | Chamadores em fila FIFO. Acima disso → `503` imediato, sem gastar CPU. |

Como funciona:

1. Até `BCRYPT_MAX_CONCURRENCY` operações rodam ao mesmo tempo. O event loop
   sempre sobra para o resto da aplicação.
2. O excedente espera em **FIFO**, então um login legítimo no meio de um flood é
   **atendido** (mais devagar), não negado.
3. Passando da fila, a requisição é recusada na hora com `503` e **zero CPU**.

Números medidos na suíte (`src/tests/login-flood.test.ts`): com 20 logins
simultâneos, o pico de bcrypt concorrente é **2** com o portão e **20** sem ele.
Vinte comparações em voo dividem a mesma CPU e multiplicam por 20 a latência de
qualquer login honesto — é esse colapso que o portão evita.

**A diferença essencial.** A contrapressão é **instantânea e reversível**: não
existe janela, não existe estado que o atacante consiga deixar para trás. Assim
que o flood para, o portão está vazio e o próximo login passa no mesmo
milissegundo. O teto global, ao contrário, mantinha todo mundo fora por 15
minutos depois do último pacote do atacante.

**Trade-off que permanece.** Sob saturação real e sustentada, parte das
requisições recebe `503` — inclusive, eventualmente, de usuários legítimos. Isso
é inerente a um endpoint CPU-bound e **não é evitável** por configuração; o que
mudou é que (a) a degradação é proporcional e temporária em vez de um bloqueio
de janela inteira, (b) o resto da aplicação continua respondendo, e (c) nada do
que um anônimo faz deixa estado que exclua terceiros depois. O `503` também não
distingue conta existente de inexistente, então não reabre enumeração.

**Dimensionar a fila.** A espera de pior caso é aproximadamente
`(BCRYPT_MAX_QUEUE / BCRYPT_MAX_CONCURRENCY) * 350ms` — com os padrões, ~5,6s.
Mantenha abaixo do timeout HTTP do cliente. Aumentar `BCRYPT_MAX_CONCURRENCY`
**não** aumenta a vazão (a CPU é a mesma): só espalha o mesmo trabalho por mais
requisições e piora a latência de todas.

**Sem serviço externo.** O portão é em processo (a aplicação é single-instance
por design). Nada de Redis. Em um futuro multi-instância, cada processo tem seu
próprio portão — o que continua correto, já que o recurso protegido (a CPU
daquele processo) também é por processo.

**Não foi trocada a biblioteca de hash.** Migrar `bcryptjs` para o binding
nativo (que usa a threadpool do libuv) ou para argon2 invalidaria os hashes já
gravados e continua fora de escopo. Registrado na seção 10. Correção pontual ao
texto anterior desta seção: o `bcryptjs` **assíncrono** não bloqueia o loop de
ponta a ponta — ele fatia o trabalho em blocos de ~100ms e cede com
`setImmediate` entre eles. O custo de CPU é real do mesmo jeito; o que muda é
que o dano do flood aparece como colapso de latência agregada, não como um
congelamento único.

## 3. Proteção CSRF

- `assertSameOrigin` é aplicado em **todas** as rotas de mudança de estado
  (`POST/PUT/PATCH/DELETE`), incluindo `POST /api/auth/logout` (logout forçado
  cross-site é negação de serviço, ainda que de baixo impacto). Quando o header
  `Origin` está presente, ele deve corresponder ao host da requisição; caso
  contrário → `403`.
- Camada secundária: cookie `SameSite=Lax` bloqueia envio em POST cross-site.
- Requests sem `Origin` (navegação síncrona, curl, servidor-a-servidor) são
  aceitos, contando com SameSite + cookie de sessão.

## 4. Headers de segurança (todas as rotas)

| Header | Valor |
| --- | --- |
| `Content-Security-Policy` | `default-src 'self'; script-src 'self' 'unsafe-inline' [unsafe-eval apenas em dev]; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` (produção) |

**Notas sobre o CSP**:

- `'unsafe-inline'` em `script-src` é exigido pelo Next.js 14 App Router
  (scripts de bootstrap inline). Caminho de evolução recomendado: CSP com
  nonce. Rastreado como melhoria futura.
- `'unsafe-eval'` é adicionado **somente em desenvolvimento** (`next dev`),
  onde o Next.js usa `eval` para fast refresh/source maps. Produção permanece
  sem `unsafe-eval`.
- `frame-ancestors 'none'` + `X-Frame-Options: DENY` bloqueiam clickjacking.

## 5. Auditoria

- Todos os eventos relevantes (login, logout, criação/edição/desativação de
  usuário, testes e habilitação de integração, bloqueios) são registrados em
  `AuditLog` com `companyId` para isolamento multi-empresa.
- **Sanitização central**: `sanitizeAuditDetails` remove de qualquer detalhe
  gravado valores de senha, hash, tokens, secrets, API keys, `Authorization`
  e cookies. Prefere sobre-redação a vazamento.

## 6. Tratamento de erros

- `runApi` centraliza o tratamento: erros internos são logados no servidor
  (mensagem apenas, sem stack/SQL/Prisma) e o cliente recebe `500` genérico.
- `DomainError` (`notFound`/`badRequest`/`conflict`/`forbidden`) permite que o
  domínio sinalize erros de negócio que são traduzidos em status HTTP corretos
  (`404/400/409/403`) sem vazar detalhes internos.
- Mensagens de erro de negócio não revelam a existência de recursos de outras
  empresas (multi-tenancy usa `404` em vez de `403/404` informativo quando o
  recurso pertence a outra empresa).

## 7. Multi-tenancy

- Todos os acessos a dados de empresa passam por `session.companyId`.
- Usuários de empresas diferentes são inalcançáveis (scope com `404`).
- Clientes, técnicos e OS são sempre consultados com escopo `companyId`.
- Auditoria e rate limit também são isolados por empresa/sessão.

## 8. Proteção de Ordens de Serviço (v0.2-service-orders)

- **Mass assignment bloqueado**: toda rota nova usa **Zod `.strict()`** —
  campos desconhecidos no corpo são rejeitados (`400`). O frontend nunca envia
  `companyId`, `status`, timestamps nem `externalProvider`; esses valores são
  resolvidos no servidor.
- **Ownership**: a OS detalhada, a atribuição e "Minhas OS" validam que
  recurso e ator pertencem à **mesma empresa**. OS/técnico de outra empresa →
  `404`.
- **"Minhas OS" resolve o técnico no servidor**: `technician_id` é derivado da
  sessão (`session → user → technician`); o cliente nunca informa o vínculo.
  Um técnico de outra empresa não acessa OS locais.
- **Elegibilidade do técnico para NOVA atribuição** (endurecido em
  `v0.2.2-pre-v03-hardening`): checar `Technician.active` não bastava. O `User`
  vinculado é quem representa a pessoa, e ele pode ser desativado ou trocar de
  perfil sem que a linha do técnico mude — então uma **conta revogada continuava
  recebendo trabalho**. Agora exige-se, em conjunto: `Technician.active`, o
  `User` existir, `User.active`, `User.profile = TECHNICIAN`, e técnico **e**
  usuário pertencerem à empresa da OS. Inelegível → `400` com motivo explícito;
  técnico de outra empresa → `404` (não confirma existência).
  A mesma regra alimenta o dropdown (`listActiveTechnicianOptions`), então a UI
  nunca oferece opção que a API recusaria.
  A regra é **derivada na leitura**, não sincronizada: desativar um usuário não
  reescreve `Technician` nem toca em OS já atribuídas — o histórico e a timeline
  permanecem intactos e o técnico continua aparecendo nas OS antigas. Só novas
  atribuições são bloqueadas.
- **Optimistic locking por versão explícita** (corrigido em
  `v0.2.2-pre-v03-hardening`): a atribuição usava
  `updateMany({ id, updatedAt })`. `DateTime` do Prisma vira `timestamp(3)` no
  Postgres (resolução de 1ms), então duas escritas no mesmo milissegundo
  satisfaziam ambas o predicado e uma era **perdida em silêncio**. O token agora
  é `ServiceOrder.version` (inteiro, `@default(0)`), incrementado a cada escrita
  e usado como compare-and-set: `where: { id, version }` +
  `data: { version: { increment: 1 } }`. O perdedor recebe `409` determinístico,
  decidido por identidade e não por relógio.
- **Lock otimista fim-a-fim** (corrigido em `v0.2.3-pre-v03-hardening`):
  `version` não era exposto na API nem aceito de volta, então o predicado só
  cobria requisições concorrentes — nunca a janela entre o que o operador leu na
  tela e o que clicou. `version` agora sai em `PublicServiceOrder` e
  `POST /api/service-orders/[id]/assign` aceita `expectedVersion` **opcional**;
  quando enviada, é ela o compare-and-set, e uma reatribuição feita sobre uma
  leitura obsoleta recebe `409` em vez de sobrescrever a decisão anterior.
  Omitir o campo mantém o comportamento antigo (retrocompatível).
- **Timeline imutável**: status e atribuição só mudam pela máquina de estados
  central (`ALLOWED_STATUS_TRANSITIONS`); cada mutação grava um
  `ServiceOrderEvent` na mesma transação — nunca status sem rastro.
- **Idempotência do sync**: reimportar o ERP usa `externalId` e apenas
  atualiza dados externos; **nunca** sobrescreve `status`, `technicianId` nem
  timeline locais.
- **Guard de página alinhado com a API**: `/tecnicos/novo` exige `ADMIN` no
  servidor (`requirePageProfile`), igual à API `POST /api/technicians`; o link
  "Novo técnico" só aparece para `ADMIN`. Antes a página aceitava também
  `DISPATCHER`, que via o formulário e sempre recebia `403` da API.
- **Importação atômica**: a criação da OS importada e o evento
  `SERVICE_ORDER_IMPORTED` ocorrem na mesma transação, e o índice único
  `(companyId, externalProvider, externalId)` arbitra syncs concorrentes — o
  perdedor faz rollback completo (sem evento órfão) e é reprocessado como
  update. Duas sincronizações simultâneas do mesmo `externalId` não geram
  duplicata de OS, nem evento de criação duplicado, nem `500`.

## 8.1. Proteção da execução do técnico (v0.3-technician-execution)

Detalhes completos em [TECHNICIAN-EXECUTION.md](TECHNICIAN-EXECUTION.md).

- **Ownership derivado da sessão**: `startServiceOrder` e
  `updateServiceOrderExecution` resolvem o técnico por
  `session.user.id + companyId → Technician`. `technicianId` **nunca** é aceito
  do cliente como prova de autorização — e, por `.strict()`, mandá-lo no corpo
  **rejeita a requisição** (`400`) em vez de ser ignorado.
- **Não-dono recebe `404`, nunca `403`**. `403` confirmaria que a OS existe e
  pertence a um colega — o fato que um técnico varrendo ids não pode aprender.
  Um usuário `TECHNICIAN` sem registro `Technician` também recebe `404`.
- **`ADMIN`/`DISPATCHER` não escrevem execução** (`403` em ambas as rotas).
  `startedAt` é a base de toda a história de SLA: se o escritório pudesse
  carimbá-lo, o campo passaria a significar "alguém disse que o técnico chegou"
  em vez de "o técnico chegou", sem como distinguir depois. Staff mantém leitura
  integral.
- **Mass assignment**: Zod `.strict()` nas duas rotas **rejeita** (não descarta
  em silêncio) `companyId`, `serviceOrderId`, `status`, `technicianId`,
  `version`, `createdAt`, `updatedAt` e `id`. Descarte silencioso faria o
  chamador crer que mudou o próprio inquilino ou o status e ainda receber `200`.
  Textos limitados a 10.000 caracteres por campo.
- **`expectedVersion` obrigatório** nas duas rotas (diferente de `assign`, onde
  é opcional por retrocompatibilidade): fluxo novo, sem chamador legado, então o
  lock fim-a-fim vale desde o primeiro dia.
- **Locks otimistas separados**: `start` faz compare-and-set em
  `ServiceOrder.version`; `execution`, em `ServiceOrderExecution.version`. Um
  despachante mexendo na OS não invalida o texto que o técnico está digitando, e
  vice-versa. `count !== 1` → `409`, sem sobrescrever.
- **Idempotência de double-click/retry**: erro previsível, nunca um segundo
  start silencioso. Repetição sequencial → `409` "já está em atendimento" (a
  máquina de estados recusa `IN_PROGRESS → IN_PROGRESS`); requisições
  simultâneas → o compare-and-set arbitra e a perdedora recebe `409`. Em ambos
  os casos: um `startedAt`, uma execução, um evento `OS_STARTED`. A constraint
  `serviceOrderId @unique` é o árbitro final no banco.
- **Isolamento multi-tenant em SQL nas duas pontas**: `companyId` é
  desnormalizado em `ServiceOrderExecution` e toda leitura/escrita filtra por
  `{ serviceOrderId, companyId }`. Deliberadamente **não** é um `include` na
  query da OS — o Prisma não aceita `where` em `include` to-one, o que
  degradaria a checagem de inquilino para um `if` na aplicação. A linha do
  inquilino errado não é filtrada depois: ela nunca é lida.
- **Técnico desativado — leitura permitida, escrita bloqueada**: com
  `Technician.active = false` (e `User.active = true`), `/minhas-os` e o detalhe
  da OS seguem legíveis, mas `start` e `execution` retornam `403` com *"Seu
  perfil técnico está inativo. Entre em contato com o responsável."*. Com
  `User.active = false`, o kill switch de sessão já derruba em `401`.
  **Nada é destrutivo**: não reatribui, não cancela, não apaga histórico — OS
  iniciada, `startedAt`, execução e timeline permanecem intactos.
- **Regra de elegibilidade única**: `technicianEligibilityReason` devolve um
  código; `technicianAssignmentIssue` e `technicianExecutionIssue` só traduzem
  para o público certo. Uma regra com dois vocabulários, em vez de duas regras
  que divergem com o tempo.
- **Auditoria sem vazar conteúdo**: `SERVICE_ORDER.EXECUTION_UPDATED` registra
  **apenas os nomes dos campos alterados**, usuário e data — o texto livre do
  diagnóstico/serviço/observações **não** é copiado para a trilha
  administrativa, que é lida por quem não é o técnico. Saves **não** geram
  evento de timeline (só `OS_STARTED` gera), para não afogar os marcos reais em
  ruído de autosave.

## 8.2. Proteção do fechamento e dos uploads (v0.4-service-order-closing)

Detalhe completo em [SERVICE-ORDER-CLOSING.md](SERVICE-ORDER-CLOSING.md); o que
importa para segurança:

- **Uploads não confiam no cliente.** O tipo real vem dos *magic bytes* e
  precisa coincidir com o tipo declarado; só o header é falsificável, e só o
  sniffing aceitaria um JPEG declarado como executável. SVG e HTML são
  recusados — ambos executam script na origem da aplicação.
- **A storage key é gerada no servidor** (`<companyId>/<orderId>/<uuid>.<ext>`),
  com extensão derivada do mime validado. O nome enviado nunca toca o caminho,
  então `../../../etc/passwd.png` não escapa. O adapter revalida a chave contra
  um padrão restrito e confirma que o caminho resolvido continua sob a raiz.
- **Nenhuma URL pública para arquivo privado.** Os bytes só saem por rota
  autorizada, após sessão + tenant + ownership, com
  `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` e
  `Cache-Control: private, no-store`. Conhecer `storageKey` ou id não basta.
- **Limites**: 8 MB por imagem, 10 imagens por OS, 2 MB por assinatura.
- **Concorrência**: toda mutação de filho faz compare-and-set na `ServiceOrder`
  antes de escrever, e o fechamento faz dois (execução e OS). Verificar status
  em código antes de inserir não bastaria — entre a checagem e o insert a OS
  pode fechar.
- **Imutabilidade**: depois de `COMPLETED`, toda escrita do técnico é recusada
  com 409 e a UI não renderiza controle de escrita algum.
- **Auditoria sem vazar conteúdo**: os eventos de evidência/material/assinatura
  registram IDs e metadata mínima — nunca bytes de imagem, assinatura ou texto
  livre. Só `OS_COMPLETED` entra na timeline.
- **Validação de versão centralizada**: `expectedVersionSchema` rejeita valores
  acima do teto do `integer` do Postgres na fronteira (400), fechando o LOW em
  que um valor fora da faixa virava 500 vindo do driver. Aplicado também
  retroativamente em `/start`, `/execution` e `/assign`.

## 8.3. Diagnóstico do cliente e integrações ERP (v0.5)

Detalhe completo em [ERP-INTEGRATIONS.md](ERP-INTEGRATIONS.md); o que importa
para segurança:

- **Escopo por OS, não por cliente.** `GET|POST
  /api/service-orders/:id/diagnostic` usa a OS como superfície de autorização.
  Uma rota `/customers/:id/diagnostic` daria a qualquer técnico autenticado um
  oráculo de enumeração sobre toda a base de clientes da empresa. O
  `customerId` vem da OS, server-side, nunca do request.
- **Anti-enumeração preservada**: não-dono e cross-tenant recebem `404`, e o
  corpo não vaza status nem provider.
- **Falha de integração nunca vira estado do cliente.** `OFFLINE` só é
  persistido quando um provider positivamente o reporta. Timeout, 401, 429,
  5xx, payload inválido e provider sem capability retornam `ok: false` com o
  snapshot anterior **intacto**.
- **Erros não vazam internals**: `IntegrationError.userMessage` é a única
  string renderizável; URL, header, token e stack ficam no log do servidor.
  Teste de regressão verifica ausência de `http(s)://`, `token`, `Bearer` e
  frames de stack na resposta.
- **Timeout obrigatório** (8s) aplicado no call site, cobrindo qualquer adapter
  presente ou futuro. Sem retry automático.
- **Mass assignment**: o corpo do refresh é `z.object({}).strict()` — enviar
  `customerId`, `companyId`, `externalProvider`, `connectivityStatus` ou
  `observedAt` resulta em 400, não em um 200 que ignorou o campo.
- **Auditoria de alto valor apenas**: só refresh manual bem-sucedido gera
  `CUSTOMER_DIAGNOSTIC.REFRESHED`, sem documento, telefone ou payload.
- **Sem fallback silencioso**: empresa sem integração habilitada recebe
  `NOT_SUPPORTED`; dado de mock nunca é rotulado como ReceitaNet.
- **Credenciais**: resolvido — ver §8.4.

## 8.4. Armazenamento de credenciais de ERP

- **AES-256-GCM** (`node:crypto`, sem dependência nova). GCM autentica: um
  ciphertext adulterado falha no decrypt em vez de produzir um token errado que
  seria enviado ao provedor.
- **IV aleatório de 12 bytes por credencial**, nunca derivado de `companyId`
  nem de contador. É isso que faz o mesmo token cifrado duas vezes gerar
  ciphertexts diferentes — sem isso, quem lesse o banco saberia que duas
  empresas configuraram a mesma credencial.
- **Binding criptográfico (AAD) a `companyId` + `provider`.** O AAD tem o
  formato versionado e com prefixo de comprimento
  `alfaos:erp-credential:v1:<len>:<companyId>:<len>:<provider>` — os prefixos
  impedem que dois pares distintos colidam no mesmo AAD, mesmo que algum campo
  venha a conter o delimitador. Ele **não é armazenado**: é reconstruído no
  decrypt a partir da identidade real da linha, e é exatamente isso que faz um
  ciphertext transplantado falhar. A auditoria da v0.5 provou que, sem AAD,
  copiar `ciphertext`+`iv`+`authTag` da Empresa A para a linha da B permitia B
  ler o token de A; com o binding, o mesmo ataque é rejeitado. O contexto é
  **obrigatório na assinatura** de `encryptCredential`/`decryptCredential`, de
  modo que esquecer o binding é erro de compilação, não descuido silencioso.
  `companyId` vem sempre da sessão e `provider` da própria linha — nunca do
  cliente.
- **Sem fallback para ciphertext sem AAD.** Credenciais gravadas antes do
  binding falham no decrypt de propósito: aceitá-las manteria o vetor de
  transplante vivo. Elas precisam ser **reconfiguradas** pelo ADMIN. Como a
  v0.5 não foi publicada, isso afeta no máximo credenciais criadas em
  desenvolvimento.
- **Chave mestra em `ERP_CREDENTIAL_ENCRYPTION_KEY`**, apenas em variável de
  ambiente. Nunca no banco, nunca no Git, nunca em log ou mensagem de erro.
  Deve decodificar (base64) para exatamente 32 bytes; se estiver presente e
  malformada, `validateEnv()` falha no boot. Ausente é permitido — a aplicação
  roda normalmente, mas operações de credencial falham **fechadas** (503).
- **Nunca há fallback para plaintext.** A cifragem acontece antes da escrita:
  chave ausente aborta com nada persistido. Teste de regressão confirma que o
  banco não contém o token nem na coluna legacy.
- **`apiKey` é legacy/deprecated**: nenhum fluxo escreve nela, conteúdo
  preexistente **não** é migrado automaticamente (proveniência desconhecida), e
  ela é limpa sempre que uma credencial nova é salva.
- **Nenhum endpoint devolve o token**, para nenhum perfil. A leitura expõe
  apenas `provider`, `configured`, `last4` e `updatedAt`. O token não entra em
  props de Server Component nem no HTML da página — verificado por E2E que
  inspeciona `page.content()` após salvar e após reload.
- **Somente ADMIN** salva/substitui/remove; DISPATCHER e TECHNICIAN recebem
  403, não autenticado recebe 401, e `companyId` vem sempre da sessão.
- **AuditLog** registra `ERP_CREDENTIAL_SAVED` / `_REPLACED` / `_REMOVED` com
  provider e ator — nunca token, ciphertext, IV, tag ou o `last4`.
- **Remoção não depende da chave**: apagar um segredo não pode exigir
  conseguir lê-lo.
- **Credencial configurada ≠ conexão validada.** Sem documentação oficial não
  há endpoint contra o qual validar, e a UI declara essa distinção
  explicitamente em vez de sugerir que a integração funciona.
- **Rotação da chave mestra invalida todas as credenciais cifradas** — elas
  precisam ser reconfiguradas. Registrado no `.env.example`.
- **Trocar o provider apaga a credencial (v0.5.1).** O AAD vincula o ciphertext
  a `(companyId, provider)`, então após a troca ele deixa de decriptar. Até a
  v0.5 os campos permaneciam gravados e `getCredentialStatus` — que só verifica
  se o ciphertext existe — seguia reportando "configurada" com o mesmo
  `last4`: o operador via uma credencial aparentemente válida que nenhum
  adapter conseguiria usar. Agora `POST /api/integrations/test-connection`
  limpa o conjunto completo (`CLEARED_CREDENTIAL_FIELDS`, o mesmo usado por
  `removeCredential`, para que nenhum campo sobreviva por duplicação de
  lista), devolve `invalidatedCredential: true` e a UI pede reconfiguração.
  `AuditLog` registra `ERP_CREDENTIAL_INVALIDATED` com provider antigo e novo —
  nunca token, ciphertext, IV, tag, `last4` ou chave.
- **A credencial só é entregue ao provider para o qual foi gravada (v0.6.2).**
  `getCredential(companyId, provider)` compara o `provider` pedido com o da
  linha antes de decriptar; divergência devolve `null`, e o chamador falha
  fechado por "credencial não configurada". O AAD protege contra **transplante
  de ciphertext entre linhas**; ele não responde "este segredo foi gravado para
  o provedor que estou chamando agora?" — a linha continua sendo a mesma e o
  decrypt passa. Sem essa comparação, um token gravado enquanto a integração
  ainda era `MOCK` era entregue ao adapter do ReceitaNet e enviado no header
  `token` para `api.receitanet.net`: **segredo de um provedor viajando para
  outro**. O parâmetro é obrigatório de propósito, para que omiti-lo seja erro
  de compilação. Regressão em `src/tests/receitanet-callcenter.test.ts`.

## 8.5. Credenciais de acesso do cliente (PPPoE) — v0.5.1

- **Nunca em texto puro.** AES-256-GCM, IV novo de 12 bytes por gravação, e
  as três colunas (`ciphertext`, `iv`, `authTag`) formam um valor só —
  garantido por CHECK no banco, para que uma falha no meio de um update não
  deixe uma linha meio-gravada.
- **AAD obrigatório**, ligando cada senha a
  `(companyId, customerId, connectionId, type)` com serialização versionada e
  prefixada por comprimento. O AAD **não é armazenado**: é reconstruído da
  identidade real da linha, e é isso que faz um ciphertext transplantado
  entre clientes, entre conexões ou entre empresas falhar em vez de decriptar.
  O namespace `alfaos:customer-connection-credential:` é disjunto do de ERP.
- **Chave própria**, `CUSTOMER_CREDENTIAL_ENCRYPTION_KEY`, separada da
  `ERP_CREDENTIAL_ENCRYPTION_KEY`. Reutilizar a chave do ERP com AAD distinto
  seria criptograficamente suficiente contra transplante, mas o nome passaria
  a mentir: rotacionar algo chamado "ERP" destruiria silenciosamente a senha
  de acesso de todos os clientes. Chaves separadas fazem o alcance da rotação
  corresponder ao nome. Também foi considerada uma subchave HKDF derivada da
  chave de ERP — descartada pelo mesmo motivo: mantém o risco de rotação.
- **Fail-closed.** Sem a chave, gravar ou revelar falha; em nenhuma hipótese
  uma senha é gravada em claro como alternativa.
- **A senha nunca é reexibida.** Não existe rota de leitura: o shape público
  da conexão tem `username` e um booleano `passwordConfigured`. Nem um
  `last4` — num token de API ele identifica qual credencial está configurada;
  numa senha ele só vaza um quarto dela.
- **Revelação escopada por OS.** `POST /api/service-orders/:id/connection-password`.
  POST e não GET: um GET colocaria o pedido na URL (log, histórico, Referer),
  seria cacheável e não passaria pela proteção Same-Origin. Resposta
  `no-store` com **apenas** a senha no corpo.
- **Autorização** — sessão válida; `companyId` da sessão; TECHNICIAN precisa
  ser o técnico da OS, estar **operacionalmente elegível** e a OS estar em
  `ASSIGNED`/`IN_PROGRESS`; a conexão precisa pertencer ao cliente daquela
  OS. Outro técnico, outro tenant, outro cliente e conexão inativa recebem
  **404**, nunca 403 — 403 confirmaria a existência. Status inadequado e
  técnico inelegível devolvem 403, porque aí a OS já é visível ao técnico e
  escondê-la seria mentir sobre um recurso que ele acessa. DISPATCHER nunca
  recebe plaintext.
- **Elegibilidade é a MESMA regra da escrita de execução**
  (`technicianExecutionIssue`), reutilizada e não copiada: `Technician.active`
  + `User` existente, ativo e com perfil TECHNICIAN + mesma empresa. Até a
  auditoria final da `v0.5.1` o reveal checava apenas a posse, e um técnico
  desativado seguia extraindo a senha das OS ainda atribuídas a ele enquanto
  a escrita já lhe era negada — o bloqueio parcial fazia o ADMIN concluir que
  o acesso tinha sido revogado. Ler uma senha não é da mesma classe que ler
  um registro: produz uma capacidade que sobrevive à revogação.
- **A posse é verificada ANTES da elegibilidade.** Invertida, a ordem viraria
  oráculo: um técnico inelegível receberia 403 em toda OS existente da
  empresa e 404 nas inexistentes.
- **Nada do cliente HTTP decide dono.** O schema é strict e tem um campo só
  (`connectionId`); `companyId`, `customerId` e `technicianId` no corpo
  resultam em 400.
- **AuditLog OBRIGATÓRIO e fail-closed.** Grava `PPPOE_CREDENTIAL_VIEWED`
  com ator, empresa, cliente, conexão e OS. Nunca senha, ciphertext, IV,
  tag, chave — nem o `username`, que não é necessário para investigar (o id
  da conexão identifica) e é dado de acesso do cliente. Revelação negada
  **não** gera o evento.

  Este caminho usa `logAuditRequired`, não `logAudit`: se a escrita falhar, a
  exceção propaga e a senha **não é devolvida** (503). `logAudit` engole a
  falha de propósito e continua fazendo isso em todo o resto do sistema — lá
  a linha de auditoria é suplementar, porque a mudança de estado também fica
  gravada na entidade. Aqui ela é a **única** evidência de que o segredo saiu
  do servidor, e perdê-la é perder o fato inteiro. O decrypt pode ocorrer
  antes; o que não pode é o texto claro chegar ao cliente sem registro.
- **Plaintext fora da resposta inicial.** A senha nunca entra em props de
  Server Component nem no HTML servido — verificado por E2E que inspeciona
  `page.content()` na OS e na tela administrativa, inclusive após reload.
- **A máscara tem comprimento FIXO, nunca derivado do valor real.** O
  componente recebe `passwordConfigured`, um booleano, e desenha um número
  constante de caracteres. Uma máscara com um símbolo por caractere da senha
  vazaria o comprimento a quem olhasse a tela — informação que estreita força
  bruta sem que ninguém revele nada, e que sobrevive a foto de tela e a
  ombro alheio. Há regressão E2E comparando o tamanho da máscara com o da
  senha da fixture e exigindo que sejam diferentes.
- **Senha ausente não é mascarada.** Conexão com `username` e sem credencial
  declara a ausência. Mascarar afirmaria que existe um valor a revelar, e o
  técnico descobriria o contrário na porta do cliente.
- **Cópia não repete o segredo em rótulo nem em toast.** A confirmação diz
  que a senha foi copiada, nunca qual é: uma notificação fica visível na tela
  depois que o usuário já desviou o olhar.

## 8.5.1. Número operacional da OS

O número **não é segredo** — ele existe justamente para ser dito ao telefone.
O que ele exige é integridade, e as garantias estão em
[SERVICE-ORDERS.md §1.3](SERVICE-ORDERS.md). Em resumo, do ponto de vista de
segurança:

- **Gerado no servidor, nunca aceito do cliente.** Os schemas Zod de criação
  são `.strict()` e não declaram `number`; enviá-lo é 400, como qualquer
  outro campo desconhecido. A empresa vem sempre da sessão.
- **Imutável no banco**, por trigger `BEFORE UPDATE` — não apenas por
  disciplina da aplicação. Renumerar uma OS não deixa rastro na timeline, ao
  contrário de uma mudança de status, então o banco é o único lugar onde
  nenhum caminho de escrita futuro consegue esquecer a regra.
- **Sequência isolada por empresa.** A unique é `(companyId, number)`, nunca
  `number` sozinho: cada empresa tem a sua OS Nº 1. Nenhuma leitura, busca ou
  listagem por número escapa do filtro de `companyId` em SQL, então o número
  não vira oráculo sobre o volume de OS de outro tenant.
- **Concorrência resolvida por lock de linha do contador**, não por
  `MAX(number) + 1` — ver a justificativa em SERVICE-ORDERS.md §1.3.

## 8.6. Integração ReceitaNet CallCenter (read-only) — v0.6

- **Token só em header.** `ReceitanetCallCenterClient` envia a credencial no
  header HTTP `token`, nunca em query string. Uma URL entra em log de
  servidor, proxy, histórico do navegador e cabeçalho `Referer`; um header
  não. Verificado por teste que inspeciona a URL e o corpo enviados.
- **Token nunca sai do servidor.** Obtido apenas por `ERPCredentialService`
  através de `resolveCompanyAdapter`, existe em memória e nada mais: não é
  logado, não entra em `AuditLog`, não aparece em mensagem de erro e nunca
  volta ao frontend. `IntegrationError.userMessage` é a única string
  renderizável e não contém token, URL, header nem stack.
- **Somente leitura.** Nenhuma operação mutante da API foi implementada —
  reiniciar, liberar em confiança, boleto, abrir/fechar chamado e gravação
  estão no contrato e ficaram de fora deliberadamente.
- **Busca de cliente é administrativa.** `POST /api/integrations/customers/search`
  e `/import` aceitam apenas ADMIN e DISPATCHER. **TECHNICIAN não recebe**:
  ele tem acesso ao cliente da OS dele, não à base da empresa — dar-lhe busca
  global recriaria exatamente o oráculo que a rota de diagnóstico evita.
- **POST e não GET nas duas rotas.** Os filtros são dado pessoal (nome,
  CPF/CNPJ, telefone) e não podem trafegar em URL. Same-Origin e schema
  strict em ambas; `companyId` vem sempre da sessão.
- **A importação relê do ERP.** O corpo de `/import` aceita SOMENTE
  `externalId`; nome, documento e endereço são buscados no servidor. Aceitar
  esses campos do cliente HTTP deixaria o formulário escrever no cadastro sob
  aparência de importação.
- **Sem duplicata silenciosa.** A importação casa primeiro pela identidade
  externa, depois pelo documento quando o cliente local ainda não tem
  vínculo. Documento já ligado a OUTRA identidade externa é **conflito**, não
  palpite: adivinhar ali vincularia o atendimento à pessoa errada.
- **Dado local não é apagado** por campo ausente na resposta do ERP. Nulo
  significa "o ERP não informou", não "o ERP informou vazio".
- **`/ping` não valida credencial** — ver `docs/ERP-INTEGRATIONS.md` §1.

## 8.7. Credenciais por API do provider — v0.7.1

### O store operacional

`ERPCredential` é a **única fonte operacional** de credenciais de ERP. Uma
linha por `(companyId, provider, kind)`, com `kind` ∈ `CALLCENTER` |
`CHATBOT`.

As colunas `credential*` de `ERPIntegration` continuam **fisicamente** no
banco — removê-las é migration destrutiva — mas estão **inertes**: nenhum
caminho de produção as lê ou escreve. Há regressão que prova as duas coisas:
gravar não as toca, e uma credencial existente apenas nelas NÃO é aceita
pelo adapter.

### Por que uma linha por credencial

O isolamento é **estrutural**, não uma regra a lembrar. Gravar a credencial
do Chatbot é um `upsert` numa linha; removê-la é um `delete` numa linha. Não
existe escrita capaz de alcançar as duas.

Foi o acoplamento oposto — credencial como colunas de uma linha
compartilhada — que produziu a perda de token numa troca de provider
(§8.4). Com linhas separadas, aquele modo de falha deixa de existir por
construção.

### Sem fallback entre APIs

O token do CallCenter **não** abre o Chatbot, e vice-versa. Falta de
credencial é indisponibilidade daquela capability, nunca motivo para tentar
a outra chave: cair para o outro token concederia a uma API um acesso que a
empresa nunca configurou.

Chatbot ausente devolve `null` — estado legítimo — e o CallCenter continua
funcionando ao lado. Isolamento de falha em ambas as direções.

### AAD versionado por linha

| Versão | Vínculo | Quando |
|---|---|---|
| `v1` | empresa + provider | Credenciais **migradas** de `ERPIntegration` |
| `v2` | empresa + provider + **kind** | Toda gravação nova |

`v1` existe por uma razão só: os ciphertexts migrados foram cifrados quando
havia uma credencial por empresa. Recomputar o AAD como `v2` mudaria os
bytes, a verificação GCM rejeitaria, e a empresa perderia um token que
estava funcionando. Regravar aquele token promove a linha para `v2`.

`v2` fecha o transplante entre APIs: sem o `kind` no AAD, as duas
credenciais da mesma empresa teriam vínculo idêntico e seriam
intercambiáveis — inaceitável entre tokens com privilégios diferentes, já
que o do Chatbot devolve senha de cliente.

A versão **sai da linha**, nunca do request. Regressões cobrem: downgrade
`v2`→`v1` não decripta; ciphertext do CallCenter na linha do Chatbot não
decripta; ciphertext da empresa A na empresa B não decripta.

### Token do Chatbot na query string

O contrato do Chatbot aceita `token` e `app` **apenas** como parâmetros de
query. É pior que o header do CallCenter — URL entra em log de servidor,
proxy, histórico e `Referer` — e é limitação do provider, não escolha nossa.

Mitigações adotadas:

- a chamada é **exclusivamente server-side**; o token nunca chega ao browser;
- `redirect: "error"` (abaixo), sem o qual um 30x levaria a URL inteira —
  token incluso — ao host do `Location`;
- mensagens de erro **nunca** ecoam a URL nem o erro original do transporte,
  porque ambos a carregam.

### Redirect e Content-Type

Os dois clientes usam `redirect: "error"`. A allowlist de base URL valida a
URL que **nós** montamos, não o destino de um redirect — seguir um 30x
sairia do host allowlisted carregando credencial. `error` e não `manual`:
não existe decisão a tomar, sair do host é sempre errado.

O `Content-Type` é validado antes do parse. Um 200 com `text/html` é portal
cativo ou página de erro de proxy, não resposta da API. Ausência do cabeçalho
é tolerada (API terse existe); presença com tipo errado é `INVALID_RESPONSE`.
O tipo recebido e o corpo **não** entram na mensagem de erro.

### Normalização do token

Num ponto só (`normalizeCredentialToken`). Apara espaço nas pontas —
incluindo a quebra de linha do "colei com newline" — e **recusa caractere
de controle no meio**. Um CRLF interno num valor que vira header HTTP é
injeção de cabeçalho, e o token do CallCenter vai exatamente num header.

Caractere válido interno nunca é alterado: normalizar demais gravaria uma
credencial diferente da que o provedor emitiu.

### Fronteira do plaintext PPPoE

A resposta do Chatbot contém **senha de cliente em texto puro**. Regras:

- o corpo bruto **nunca** é logado, persistido ou devolvido a um chamador;
- existe **uma** fronteira de normalização, e depois dela o objeto é
  descartado;
- a senha segue direto para a cifra da `CustomerConnection` (§8.5);
- nenhum `console.log`, logger, `AuditLog`, timeline, cache, snapshot ou
  `error.message` recebe senha;
- só o endpoint explícito e auditado de reveal devolve plaintext, depois que
  a senha já está cifrada.

A auditoria da troca de procedência registra `MANUAL`/`AUTO_DOCUMENT_LAST4`/
`RECEITANET_CHATBOT` e o id da conexão — **nunca** o valor antigo ou novo.

### Rate limit de capability

Endpoints que disparam chamada ao provider têm teto por
`(empresa, usuário, capability)`. Um clique nosso vira uma requisição lá, e
sem teto uma tela em loop gasta a cota da EMPRESA — a punição do provider
recairia sobre todos os operadores dela.

**Cobertura, endpoint por endpoint.** Até a v0.7.5 esta seção afirmava
cobertura geral enquanto o teto existia em UMA rota — a auditoria da v0.7.x
mediu e registrou (RATE-01). A lista abaixo é a cobertura real, e existe
justamente para que a afirmação volte a ser verificável:

| Rota | Capability | Teto/min |
|---|---|---|
| `POST /api/integrations/customers/search` | `erp-customer-search` | 20 |
| `POST /api/integrations/customers/import` | `erp-customer-import` | 30 |
| `POST /api/integrations/test-connection` | `erp-test-connection` | 10 |
| `POST /api/service-orders/:id/diagnostic` | `customer-diagnostic` | 10 |
| `POST /api/integrations/sync` | `erp-order-sync` | 5 |
| `GET /api/service-orders/:id/receitanet-context` | `receitanet-context` | 10 |

Cada capability tem balde próprio: esgotar a busca não impede importar. Os
tetos diferem porque o uso real difere — busca é dirigida por digitação,
importação é um clique por linha de uma lista, sincronização é operação em
lote. Um teto que barra trabalho normal não protege cota nenhuma; só ensina
a equipe a trabalhar contra a ferramenta.

O `GET` do diagnóstico **não** consome cota: ele lê o snapshot local e não
fala com ninguém. Só o `POST`, que é a releitura, amplifica.

`POST /api/service-orders/:id/diagnostic` é o único que o TECHNICIAN alcança,
e é o mais fácil de repetir — "Atualizar diagnóstico" é um botão que se aperta
de novo quando o cliente ainda está offline. Recusa devolve **429** com
`Muitas solicitações. Tente novamente em instantes.` e apenas
`retryAfterSeconds` no corpo: nunca token, URL, código do provider ou o nome
interno da capability.

O teto é consumido **depois** da autorização, para que sondagem anônima ou
cross-tenant não consuma cota de ninguém. Há regressão cobrindo as três
formas: sem sessão, com perfil sem permissão, e técnico sondando OS de outro
técnico — nenhuma delas gasta a cota de quem tem direito a ela.

**Limitação conhecida:** o estado é em memória do processo. Com mais de uma
instância, o teto efetivo é multiplicado. Aceitável hoje porque o alvo é
acidente (loop de UI, clique repetido) e o AlfaOS roda em instância única;
se a implantação virar multi-instância, o limite precisa migrar para
armazenamento compartilhado antes de ser tratado como controle.

**Sem teto agregado por empresa (INFO).** Como o balde é por usuário, a empresa
não tem um teto único no AlfaOS: cinco usuários ativos podem, somados, pedir até
5 × 10 atualizações de diagnóstico por minuto ao provider. É a contrapartida
deliberada de um operador em loop não bloquear os colegas — decisão do dono em
`DIAG-RATE-01` (PRD §370). Rever antes de qualquer atualização automática ou de
escala multi-instância; nenhum segundo limite existe hoje.

### Risco residual aceito

**Tamanho de resposta não é limitado.** `res.text()` lê o corpo inteiro. Um
provider comprometido ou um proxy hostil poderia devolver payload muito
grande e pressionar a memória do processo. Não implementado nesta release
porque exigiria trocar o transporte por leitura em streaming nos dois
clientes, e o vetor depende de o host allowlisted já estar comprometido —
cenário em que há problemas maiores. Registrado para revisão futura.

---

## 8.8. Enriquecimento de cliente via Chatbot — v0.7.2

### Fronteira do dado pessoal

A resposta do Chatbot carrega, de uma vez: senha PPPoE em texto puro,
login, telefones, e-mail, CPF/CNPJ, endereço completo e coordenadas. É o
payload mais sensível que o AlfaOS lê de qualquer provedor.

Regras em vigor:

- o corpo bruto **nunca** é logado, persistido, cacheado ou devolvido;
- existe **uma** fronteira de normalização, e depois dela o objeto é
  descartado;
- a senha segue direto para a cifra da `CustomerConnection` (§8.5);
- o `AuditLog` do enriquecimento registra os **nomes** dos campos
  alterados, nunca os valores — a lista carrega telefone, e-mail e endereço
  de uma pessoa;
- o resultado devolvido ao chamador contém desfecho, código do catálogo e
  contagens. Nenhum valor pessoal.

### Ambiguidade não grava

Múltiplos contratos sem desempate inequívoco produzem `AMBIGUOUS` e
**escrita nenhuma** — nem os campos que “provavelmente” seriam iguais entre
contratos, porque decidir quais seriam é a mesma adivinhação por outro nome.

O desempate usa `Customer.externalContractId`, lido do **próprio** cliente
sob escopo de empresa. Nunca de uma varredura global: um `idContrato` de
outra empresa não desempata nada, e há regressão provando isso.

`idCliente` **não** desempata contratos — é compartilhado entre os contratos
do mesmo cliente.

### Contato digitado por gente

Telefone e e-mail só são gravados quando o campo local está **vazio**.

São exatamente os campos que o despachante corrige à mão depois de falar com
o cliente. Deixar a releitura do ERP sobrescrever apagaria a informação mais
atual da empresa em favor da mais velha. Endereço e nome seguem a política
oposta (provedor é fonte), como já era antes.

### Telefone: dois slots, N valores

O cadastro tem `phone` e `secondaryPhone`; o provedor pode devolver mais. O
preenchimento olha quais slots estão **livres** e conta o que não coube em
`phonesDiscarded`.

A contagem existe para que a perda seja visível. Uma divisão cega da lista
em dois gravaria o segundo telefone quando o primeiro slot estivesse ocupado
por um valor manual — perdendo o primeiro **sem contá-lo**.

### Coordenadas

`x` é latitude, `y` é longitude (homologado geograficamente). Validadas por
faixa antes de gravar, e `(0, 0)` é **recusado**: é o Golfo da Guiné, e na
prática o sentinela de “não preenchido” de um cadastro.

Coordenada importada entra com `locationSource = IMPORTED` e
`locationVerified = false`, **sempre**. Marcar verificado por ter vindo de um
cadastro afirmaria uma checagem que ninguém fez — e é essa afirmação que
faria um técnico confiar num ponto errado em vez de procurar o endereço.

**Dívida registrada:** o PRD §133–§139 descreve uma entidade
`CustomerLocation` própria, com histórico e verificação por GPS. Os dois
campos em `Customer` são a menor mudança segura desta etapa, não o desenho
final.

### Isolamento de falha

Chatbot ausente, indisponível ou sem documento do cliente devolve
`UNAVAILABLE` com código do catálogo — a importação pelo CallCenter já
aconteceu e não é desfeita. O provisionamento PPPoE cai para o `login` do
CallCenter e a política da empresa.

Não há fallback de credencial: o enriquecimento usa exclusivamente a
credencial `CHATBOT` (§8.7).

---

## 8.9. AlfaOS Field — superfície móvel (contrato)

> **Parcialmente implementado desde a v0.9.** Esta seção continua sendo o
> CONTRATO — PRD Parte V, §150–§195. O que a fundação de backend já cumpre está
> na **§8.13**, com a evidência; o que segue sem código está marcado abaixo.
>
> Ainda **especificação, sem código**: cache offline do aplicativo, conclusão de
> OS pelo Field, evidências estruturadas, assinatura, materiais, checklist,
> resultado de ferramenta, coordenada enviada pelo aparelho e integração real de
> push. Cada item abaixo é uma decisão que fica cara de reverter depois que o
> aplicativo estiver em campo.

### O Field nunca fala com o ERP

```text
Field  →  AlfaOS API  →  ReceitaNet
```

Um token de ERP no aplicativo estaria em centenas de aparelhos fora do controle
da empresa, e vale para a **base inteira de clientes** — não só para a OS aberta.
A credencial não sai do servidor (§8.7), e a autorização por OS que já existe
para diagnóstico e para PPPoE (§8.5) continua sendo a fronteira.

### Token e sessão no dispositivo

- Token no **armazenamento seguro da plataforma** (Keystore/Keychain), nunca em
  arquivo de preferências nem em banco local em claro.
- **Access token curto, refresh controlado, revogação do lado do servidor.**
  Token longo transforma um aparelho roubado em acesso válido por semanas.
- A revogação precisa ser **server-side e imediata**, sem depender de o aparelho
  estar ligado ou conectado — um dispositivo perdido não coopera.

### Registro de dispositivo

`MobileDevice` (§155) existe por causa de um cenário específico: **celular
perdido**. Sem ele, cortar o acesso exige trocar a senha do usuário, o que
derruba os outros aparelhos dele **e** não impede que o token de push continue
entregando ordens de serviço ao aparelho perdido.

- O ADMIN revoga **sessão e dispositivo**, não só a senha.
- `deviceMetadata` guarda o **mínimo** para suporte. Inventário de aparelho é
  vigilância acidental.
- **Não usar número de telefone como identidade de dispositivo.** Número é
  reciclado pela operadora e pertence à pessoa; quem receber o número depois
  passaria a receber notificação operacional da empresa.

### Privacidade da notificação

A prévia do push é **a superfície menos controlada do produto**: aparece sobre a
tela bloqueada, não passa por autenticação, não expira, e pode ficar na central
do sistema operacional por dias — num aparelho apoiado no painel do carro.

**Nunca em push:**

```text
CPF · senha PPPoE · login sensível desnecessário
endereço completo · telefone · diagnóstico detalhado
```

O número operacional da OS (§8.5.1) identifica sem revelar. O detalhe fica atrás
do toque, e a autorização é verificada **na abertura** — deep link não é prova
de acesso. Notificação para OS já reatribuída leva a uma negação limpa.

### Segredo em cache offline

> **Por padrão, senha PPPoE em texto claro NÃO é persistida offline.**

Cache offline é armazenamento durável num aparelho que anda pela rua. Toda a
arquitetura da §8.5 existe para que o texto claro só saia do servidor sob pedido
explícito, `no-store` e com auditoria obrigatória — gravá-lo no disco do celular
anula os três em silêncio, e a revelação deixa de ter registro porque deixa de
acontecer.

Exceção exige política explícita da empresa, prazo de validade e registro. Nunca
é o comportamento padrão.

**Token de ERP não vai para o Field em nenhuma hipótese** — nem em cache, nem em
memória, nem "temporariamente".

### Idempotência como entrada não confiável

A `idempotencyKey`/`localOperationId` (§160) vem **do cliente**. Ela evita
duplicação; ela **não** prova autorização.

- Escopada por empresa e por técnico. Uma chave de outro tenant não pode
  alcançar nem colidir com a linha de ninguém.
- Reapresentar a chave de outra pessoa não pode devolver o resultado dela — isso
  seria um oráculo sobre operações alheias.
- Continua valendo tudo da §8 desta página e da §44 do PRD: ownership e tenancy
  são verificados **antes** da desduplicação, nunca no lugar dela.

### Validação de conclusão é do servidor

O checklist e as obrigatoriedades do tipo de OS (§164–§166) são avaliados no
**backend**. A validação no app é conveniência: um app modificado, uma versão
antiga ainda em campo ou uma requisição montada à mão passam por cima dela.

Vale a regra permanente do projeto: **UI não é controle de segurança.**

### Outbox e workers

- **Sem segredos no payload do outbox** (§156). A tabela sobrevive à transação,
  é lida por workers e aparece em dump e em backup. Ela carrega **referência** ao
  agregado; o worker relê o que precisa na hora de processar.
- `companyId` viaja no evento para que o worker respeite o isolamento de tenant
  sem reconsultar o agregado.
- Observabilidade (§190) correlaciona por identificador — `correlationId`,
  `eventId`, `notificationId`, `deviceId`, `jobId`. **Sem PII e sem segredos**,
  como já exige a §63 do PRD.

### Coordenada enviada pelo aparelho

**O app coleta, o Core decide.** Nenhuma checagem de acesso passa a depender de
onde o técnico diz estar (PRD §130). Check-in com GPS (§167) é registro
operacional, não autorização — e no primeiro MVP não bloqueia por geofence,
porque GPS urbano erra dezenas de metros e falha dentro de prédio, exatamente
onde o atendimento acontece.

Confirmação de localização do cliente **nunca** marca `verified = true` só por
receber a posição do telefone (§172).

### Resultado de ferramenta

`ToolExecution.resultSanitized` (§176) **nunca** guarda senha PPPoE, token,
segredo de roteador ou credencial em claro. O aviso existe porque uma execução
de `ROUTER_CONFIGURATION` naturalmente teria a senha do Wi-Fi e a credencial
PPPoE no meio do resultado: guarda-se **o que foi configurado**, nunca **com
qual segredo**.

Credencial de OLT não chega ao Flutter (§182) — ela dá acesso administrativo a
todos os assinantes daquele equipamento, não só ao cliente da OS.

### Evidência é imutável depois de COMPLETED

O técnico não apaga evidência histórica (§162). Correção posterior existe, é
auditada e preserva o registro anterior — mesma regra do fechamento (§8.2) e da
reabertura (PRD §170).

Localização de foto não é exposta sem necessidade: a coordenada de uma foto é a
casa de um cliente.

---
## 8.10. Preferência de tema — v0.7.3

Superfície pequena, mas com uma característica que merece regra: um valor
controlado pelo cliente que termina como atributo do `<html>`.

### Allowlist fechada

A preferência vem do `localStorage`, que é gravável por qualquer script na
origem e editável à mão pelo usuário. Ela é validada contra exatamente
`light` | `dark` | `system` — nos três pontos que a leem: o script inline do
`<head>`, o provider e o próprio `onChange` do seletor. Qualquer outra coisa
vira o padrão, em silêncio.

Sem isso, uma string arbitrária entraria no DOM. Não é execução de script —
`setAttribute` não avalia nada —, mas é valor arbitrário num atributo que o
CSS usa como seletor, e a fronteira certa é rejeitar na entrada.

**Nunca aceitar classe ou CSS vindo do usuário.** O que o produto aceita é a
escolha entre três temas conhecidos, não uma folha de estilo.

### `dangerouslySetInnerHTML` no script do tema

O script inline do `<head>` é injetado assim porque é o único caminho para
script inline em React. É seguro **por construção, não por sorte**:
`THEME_SCRIPT` é uma constante estática de `@/lib/theme`, sem nenhuma
interpolação de dado de requisição, sessão ou banco.

Há regressão travando as duas propriedades: a string não contém `</script`
nem `<!--`, e o valor lido do storage passa pela allowlist antes de chegar ao
`setAttribute`. No instante em que alguém interpolar dado ali, vira XSS.

### O tema não toca nada de domínio

Não existe rota, nem coluna, nem sessão envolvida: a preferência é do
navegador. Autenticação, perfil, tenant, revelação de senha PPPoE e
credencial de ERP seguem exatamente como antes — o tema é apresentação, e não
tem acesso a nenhum deles.

A senha PPPoE continua mascarada por `passwordConfigured` (§8.5): a máscara
não depende de tema, e trocar de tema não revela nada.

---

## 8.11. Navegação contextual e redirect aberto — v0.7.4

A tela de edição de cliente é alcançada por dois caminhos, e o botão de
voltar precisa saber por qual. O destino viaja na query string, o que faz
dele **entrada do usuário**: qualquer link montado por terceiro chega ali.

### Allowlist, não denylist

Só passam duas rotas, casadas por inteiro com `^...$`:

```text
/clientes
/ordens/<id no formato interno>
```

Filtrar `javascript:` e `//` seria uma corrida perdida — `\/\/`, `%2f%2f`,
`/\`, tab no meio do esquema e dezenas de outras formas contornam listas de
proibição. Ancorando o formato inteiro, toda essa criatividade de
codificação fica irrelevante: a string simplesmente não casa.

Sem isso é redirect aberto: o operador **autenticado** clica em "voltar" e
cai numa tela fora do AlfaOS que imita a de origem e pede a senha de novo.

### Formato não é autorização

O formato do id é a primeira peneira, e só. A OS ainda é resolvida **sob a
empresa da sessão**: um id bem formado de outro tenant passa pela allowlist
e morre nessa checagem. Se morresse só depois, o botão viraria um oráculo —
"esta OS existe naquela empresa" — pela simples presença do link.

Falhar aqui nunca é erro de tela: um destino ruim vira "voltar para
clientes", que sempre funciona.

### Links externos de navegação

Google Maps e Waze recebem endereço e coordenada por `encodeURIComponent`.
O endereço é texto digitado por gente: um `&` num complemento
acrescentaria um parâmetro à URL, e um `#` cortaria o resto fora.

Os dois links levam `rel="noreferrer noopener"` — sem isso a URL da OS, que
carrega o id interno, viajaria no `Referer` até o Google e o Waze.

**A coordenada nunca é exibida como texto**, só dentro do `href`.

### Menos dado no celular

O técnico deixou de receber, no payload da OS: id interno, origem, número
no ERP e o documento do cliente. Não é controle de acesso — é redução de
superfície: dado que não é necessário para executar o atendimento não
precisa viajar para um aparelho que anda pela rua.

O que JÁ era controle continua igual e não foi tocado: `ReceitanetContextPanel`
recusa TECHNICIAN na rota (§8.7), a revelação de senha PPPoE mantém posse,
elegibilidade, Same-Origin, `no-store` e auditoria obrigatória (§8.5), e as
rotas de conexão continuam exigindo ADMIN.

---

## 8.12. Same-Origin sob host real, e o logout — v0.7.5

### O defeito

`assertSameOrigin` comparava o `Origin` com `new URL(request.url).host`. No
Next 14 essa URL carrega o host que o servidor resolveu **ao subir** —
`localhost` — e não o host que o navegador endereçou. Medido no servidor de
desenvolvimento: com `Host: 192.168.1.50:3210` na requisição, `request.url`
continuava sendo `http://localhost:3210/...`.

Consequência: abrir o AlfaOS por IP de rede local, por nome de máquina ou
até por `127.0.0.1` fazia **toda rota mutante** — as 30 que usam o helper —
recusar com `Origem não permitida`, mesmo com `Origin` idêntico ao `Host`.
O sintoma visível era o logout, porque é a única ação que navega para a API
e mostra o corpo da resposta na tela.

### A comparação agora

Origem efetiva, da mais confiável para a menos:

1. **`APP_ORIGINS`** — allowlist explícita. Configurada, a origem precisa
   estar na lista e **nenhum cabeçalho da requisição participa da decisão**.
   É a política estrita, recomendada em produção, e nela o esquema também
   conta (`http` não entra numa lista `https`).
2. **`X-Forwarded-Host`**, apenas com `TRUST_PROXY_HEADERS=true`.
3. **`Host`** — que o navegador preenche a partir da URL que ele precisou
   resolver para chegar até nós, e que o conteúdo de outra página não
   consegue mudar.
4. o host de `request.url`, como último recurso.

**`X-Forwarded-Host` é ignorado por padrão.** Ele é escrito por qualquer
cliente; confiar nele sem proxy que o sobrescreva seria Host Header
Injection pela porta da frente.

**O host resolvido serve SÓ para comparar.** Ele nunca monta URL de
redirect, link ou e-mail — é o que separa esta comparação de uma injeção de
host de verdade.

### Redirect relativo

O logout respondia `307` com `Location` absoluto derivado de `request.url`.
Dois defeitos num só: o `307` preserva o método e o navegador refazia POST
em `/login`, e o destino absoluto mandava quem abriu pelo IP da rede para o
`localhost` do **próprio aparelho**.

Agora é `303 See Other` com `Location: /login` — relativo. O navegador
resolve contra a URL que ele mesmo pediu, e nenhum cabeçalho participa: não
há superfície de open redirect.

### Sessão

A sessão é um **token assinado, sem estado no servidor**: não existe
registro a invalidar, e remover o cookie É a invalidação. Por isso a rota
limpa mesmo sem sessão válida na entrada — exigir sessão daria tela de erro
a quem clicou em "Sair" com o token já expirado.

O cookie sai com `Max-Age=0`, `Expires` no passado, `HttpOnly`, `Path=/`,
`SameSite=Lax` e `Secure` em produção. **Origem recusada não limpa cookie**
— um site de terceiro não derruba a sessão de quem foi atacado.

### Risco residual documentado

Sem `APP_ORIGINS`, quem fala **direto** com o servidor pode enviar `Host` e
`Origin` casados e passar pela checagem. Isso não é capacidade nova: quem
controla os próprios cabeçalhos já podia omitir o `Origin` e cair na
política de ausência (abaixo). CSRF só existe quando um NAVEGADOR é o
veículo, e ali o `Host` é do navegador.

**Configurar `APP_ORIGINS` em produção fecha isso**, porque tira os
cabeçalhos da decisão.

### Ausência de `Origin` — política herdada, mantida

Requisição sem `Origin` passa, apoiada em `SameSite=Lax` mais o cookie.
Cabeçalho presente porém **vazio** conta como ausente, e agora isso é
explícito no código em vez de depender de a string vazia ser *falsy*.

Não foi apertada aqui: seria mudança de comportamento das 30 rotas, com
risco próprio, e não é o defeito relatado. Fica registrada como candidata.

### Verificação

15 ataques executados contra o servidor de desenvolvimento real — origem de
terceiro, sufixo e prefixo enganosos, porta diferente, `userinfo`,
protocol-relative, `Origin: null`, CRLF, `X-Forwarded-Host` e `Forwarded`
sem confiança. Nenhum passou.

Ponto final no host, IP decimal e IP hexadecimal **passam, e é correto**:
`192.168.1.50.`, `3232235826` e `0xC0A80132` canonicalizam para o mesmo
IPv4, e o navegador aplica a mesma canonicalização ao decidir mesma origem.

---

## 9. Configuração de produção

1. Gere um `AUTH_SECRET` forte: `openssl rand -base64 48`.
2. Use PostgreSQL gerenciado com TLS e credenciais fortes.
3. Sirva por HTTPS (HSTS é emitido em produção).
4. Aplique as migrations: `npx prisma migrate deploy`.

### 9.1 O que a fundação de notificações exige fora do Git

Acrescentado na revisão de checkpoint, porque a lista acima estava completa para
a v0.12 e deixou de estar: quem seguisse só os quatro passos entregaria um
sistema em que **o push nunca chega, em silêncio**. Nenhuma OS fica errada — a
`Notification` existe e o técnico a vê ao abrir o aplicativo —, e é justamente
por isso que a falha não aparece: nada alerta.

**Credencial do servidor (worker).** Três variáveis de ambiente, **nunca no
repositório**: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` e
`FIREBASE_PRIVATE_KEY`. Sem as três, o worker sobe com o provedor inerte e diz
por quê — configuração pela metade é tratada como erro de operação, não como
ausência de intenção. A conta de serviço é credencial privilegiada e **não** vai
para dentro do aplicativo.

**Configuração do aplicativo.** `apps/field/android/app/google-services.json`,
obtido do projeto Firebase da plataforma, com o `applicationId`
`com.jamalsoftware.alfaos.field`. Fora do Git, coberto pelo `.gitignore`, e
injetado no momento do build. O Gradle o aplica **condicionalmente**: sem o
arquivo o APK compila e o push fica `unavailable`, em vez de o build quebrar.

**A ativação do SGP fica travada até a homologação.** `SGP_ACTIVATION_ENABLED`
é o padrão de produção em `false` — ausente também é `false`, e a comparação é
exata com `"true"` (mesma convenção de `TRUST_PROXY_HEADERS`), de modo que
`"1"`, `"yes"` e `"TRUE"` **não** liberam nada. Testar a conexão continua
disponível: é diagnóstico e é o que a homologação precisa fazer. Ligar para
`true` é decisão deliberada, depois de o SGP ser exercitado contra uma
instalação real — ver §8.18.

**O worker precisa ser chamado.** Ele processa um lote e termina — é comando,
não daemon, e a decisão está justificada em `scripts/outbox-worker.ts`. Execuções
sobrepostas são seguras porque a reivindicação é um `updateMany` com predicado de
status, e o banco arbitra. Agende:

```text
* * * * * cd /app && npm run outbox:work
```

`npm run build` compila o worker junto (`build:worker`), então `dist/` já existe
depois do build de produção — o worker **não** depende de `devDependencies`.

## 10. Melhorias futuras rastreadas

Dívida registrada na auditoria final da `v0.5.1`, deliberadamente NÃO
corrigida naquele ciclo (só H-1 e M-1 entraram):

- **Unicidade case-insensitive de `ServiceOrderType`** (L-1). A checagem
  case-insensitive é de aplicação e não é atômica; a unique
  `(companyId, name)` do Postgres é case-sensitive e não arbitra a corrida.
  Uma corrida real criou quatro variantes de caixa do mesmo nome. É
  qualidade de dado, não segurança: mesma empresa, só ADMIN, e tipos são
  rótulos. Correção: índice único funcional em `(companyId, lower(name))`.
- **Sem throttle na revelação de credencial** (I-1). Um técnico autorizado
  pode automatizar a extração das senhas das OS atribuídas a ele. Limitado
  ao próprio escopo e integralmente auditado — cada revelação gera um
  `PPPOE_CREDENTIAL_VIEWED`.
- **OS INTERNAL com identidade externa fica sujeita a sobrescrita por
  import** (I-2). A origem corretamente não é reescrita, mas os campos
  externos são. Inalcançável pela aplicação: nenhuma rota grava
  `externalProvider`/`externalId` numa OS e os schemas são strict.
- **Painel de conexões mostra apenas a primeira ativa.** A escolha é
  determinística e o reveal exige `connectionId` explícito e validado, então
  não há risco de revelar a credencial errada — mas um cliente com duas
  conexões tem a segunda invisível na OS.
- **Área de transferência.** A senha copiada pelo técnico permanece no
  clipboard do aparelho sem expiração; fora do alcance do servidor.

- CSP com nonce (remover `'unsafe-inline'` de `script-src`).
- 2FA / TOTP para contas administrativas.
- Registro de expiração e rotação de sessão em nível de servidor.
- Rate limit por conta em rotas de escrita.
- Tirar o bcrypt do event loop (binding nativo com threadpool, worker thread ou
  fila) — hoje o custo é apenas **limitado** pelo portão de admissão da seção
  2.2, não removido da thread principal. Exige rehash progressivo dos hashes
  existentes.
- ~~Expor `ServiceOrder.version` na API para que o cliente envie a versão que
  leu (lock otimista fim-a-fim).~~ **Feito em `v0.2.3-pre-v03-hardening`** — ver
  seção 8 e [SERVICE-ORDERS.md §3.2](SERVICE-ORDERS.md). Resta apenas estender
  `expectedVersion` às demais mutações de OS quando elas existirem (start/finish
  chegam na v0.3).
- Fluxo de recuperação de administrador (CLI/console de suporte). Hoje o
  travamento é apenas **prevenido** (seção 12); não existe caminho de
  recuperação se uma empresa ficar sem ADMIN ativo por outro meio.
- ~~Armazenamento seguro de credenciais de ERP por empresa.~~ **Feito** — ver
  §8.4 (AES-256-GCM, chave mestra em ambiente, falha fechada). Resta como
  evolução: rotação de chave sem reconfiguração manual (envelope encryption com
  DEK por credencial, ou KMS/secret manager externo), e remoção definitiva da
  coluna legacy `apiKey` numa migration destrutiva futura.

## 11. Vulnerabilidades de dependências (risco aceito/adiado)

`npm audit` (ver `docs/V0.2-AUDIT.md` para o detalhamento completo):

- `prisma`/`@prisma/config` → `deepmerge-ts` (GHSA-ggr8-5vv4-36mx, stack
  exhaustion/DoS ao mesclar grafos de objeto recursivos): **sem correção
  disponível para frente** na linha atual do Prisma — o `npm audit` só sugere
  downgrade para `6.12.0`, o que reintroduziria outros bugs corrigidos desde
  então. Não foi feito downgrade. Risco considerado baixo (exige um objeto
  recursivo malicioso chegando ao `deepmerge-ts` interno do Prisma; não é um
  caminho óbvio de input do usuário no AlfaOS). Acompanhar releases futuras do
  Prisma para uma correção forward.
- `next`/`postcss`/`eslint-config-next` e transitivos: reduzidos de 1 crítico
  + 7 high para 0 crítico + 8 high ao atualizar para `next@14.2.35`/
  `eslint-config-next@14.2.35` (último patch da linha 14.x). O restante exige
  migração para `next@15`/`16` (major, precisa React 19 — fora do escopo desta
  rodada).

## 12. Travamento administrativo (auto-lockout de ADMIN)

Sessão é revalidada no banco a cada request (seção 1): um ADMIN que se
desativa perde o acesso **na requisição seguinte**, e se ele era o único ADMIN
ativo da empresa ninguém mais consegue gerenciar usuários — não existe caminho
de recuperação dentro do produto. Com a mensagem única de credenciais (seção
2), a vítima nem sequer vê "usuário inativo" para entender o que aconteceu.
Duas camadas independentes impedem isso:

1. **Auto-modificação de privilégio** (`PATCH /api/users/[id]`): quando o alvo
   é a própria sessão, `active: false` ou uma troca de `profile` são recusados
   com `403` ("Você não pode desativar ou alterar o próprio perfil de
   acesso."). Nome, e-mail e senha próprios continuam editáveis, e reenviar o
   `profile`/`active` **inalterados** (o formulário de edição sempre manda os
   dois) é no-op e passa. Defesa principal: não depende de contar
   administradores.
2. **Último ADMIN ativo** (`updateCompanyUser`): dentro da mesma transação do
   update, se a alteração deixaria a empresa com **zero** usuários `ADMIN` com
   `active: true`, a transação faz rollback e a resposta é `409` ("Não é
   possível remover o último administrador ativo da empresa."). O `COUNT` roda
   **depois** do `UPDATE`, dentro da transação, para enxergar a própria escrita.
   Cobre o caso de um ADMIN desativar/rebaixar **outro** que seja o último, e
   protege qualquer chamador da função (scripts, seeds), não só a rota HTTP.
   A guarda só é avaliada quando a escrita de fato remove um ADMIN ativo —
   editar um técnico nunca é recusado por causa dela.

Limitação conhecida: com duas transações **simultâneas** rebaixando
administradores diferentes, o isolamento padrão (read committed) pode deixar
ambas passarem. A janela é estreita (o `COUNT` já enxerga o próprio `UPDATE`) e
a camada 1 cobre o caminho realista de auto-travamento. Fechar isso por
completo exigiria `Serializable` ou um lock explícito na empresa.

Na interface, as mesmas regras aparecem antes do erro: o botão
"Desativar" da própria linha vem desabilitado com o motivo no `title`, o
formulário de edição bloqueia perfil/status na própria conta, e recusas da API
(como a do último administrador) passaram a ser exibidas — antes o clique
falhava em silêncio.

---

## 8.13. Field API — fundação de backend (v0.9)

O que a §8.9 exigia e esta versão entregou. Contrato completo da superfície em
`docs/FIELD-API.md`.

### Token opaco, revogável, preso a um dispositivo

O cookie da web é um JWT **sem estado** e por isso irrevogável até expirar. A
§8.9 exige revogação *server-side e imediata*, porque o cenário que justifica a
camada é celular perdido — um aparelho que não coopera.

```text
Bearer  →  MobileDevice (ACTIVE, não revogado, não expirado)
        →  User (ativo, TECHNICIAN, mesma empresa)
        →  Technician (mesma empresa)
```

- 32 bytes de `randomBytes`, guardados como **SHA-256 em hex**. O texto claro
  existe uma única vez, na resposta do login; um dump do banco não devolve
  acesso a ninguém.
- SHA-256 puro e não bcrypt: o valor já tem 256 bits de entropia, então não há o
  que adivinhar por força bruta. Hash lento por requisição autenticada seria
  custo sem defesa.
- Validade de 36 h. A expiração **não substitui** a revogação — é a rede embaixo
  dela, para o aparelho que sumiu sem ninguém perceber.
- `revokedAt` tem efeito na requisição seguinte, e apaga junto o `pushToken`:
  senão o celular perdido continuaria recebendo prévia de OS na tela bloqueada.

### Revogar precisa ser alcançável, e precisa significar alguma coisa

Duas correções pós-auditoria, e as duas são sobre a mesma capacidade:

**Superfície operacional.** `revokeDevice` existia e nenhuma rota a chamava. Na
prática, o ADMIN de uma empresa cujo técnico perdeu o celular só conseguia
cortar o acesso abrindo o banco — e a alternativa realista era trocar a senha do
usuário, que derruba os outros aparelhos dele **e** deixa o push entregando OS
ao aparelho perdido. Capacidade de segurança que só existe em função exportada é
capacidade que a operação não tem. Agora existe `/dispositivos` e
`POST /api/mobile-devices/:id/revoke`, apenas para `ADMIN`, filtrados por
`companyId` da sessão, com auditoria e Same-Origin.

**Revogado não volta por login.** O `upsert` do login reativava a linha
(`status: ACTIVE`, `revokedAt: null`). A intenção era recuperação; o efeito era
esvaziar a revogação — quem estivesse com o aparelho perdido e a senha voltava a
ter acesso sozinho, sem o administrador saber. Agora o login recusa com
`DEVICE_REVOKED` e não toca em `status` nem `revokedAt`.

A contrapartida que torna isso operacionalmente aceitável: revogar um aparelho
**não bloqueia a pessoa**. Uma instalação nova registra normalmente, e o técnico
volta a trabalhar sem depender de um administrador disponível.

A listagem administrativa **não** devolve `tokenHash`, `pushToken` nem
`installationId`. Nenhum ajuda a decidir uma revogação, e os três são o que não
deve passar por navegador, log de proxy e captura de tela de suporte.

#### O token de push endereça UM aparelho — e a limpeza para no tenant

Um token do provedor identifica uma **instalação**, não uma pessoa. Quando dois
técnicos dividem o mesmo aparelho, os dois têm linhas próprias de
`MobileDevice` — a unique é `(companyId, userId, installationId)` — mas o token
é o mesmo valor para ambos.

O caso que isso cria é real e não hipotético: sair do aplicativo limpa a sessão
local **mesmo quando o `logout` não alcança o servidor**, porque sair precisa
funcionar offline. A linha do primeiro técnico fica `ACTIVE` com o token ainda
gravado, e uma notificação endereçada a ele chega no aparelho que o segundo
está segurando — com número de OS e nome de cliente na tela de bloqueio.

Por isso o registro de push **solta o token de qualquer outra linha da mesma
empresa** antes de gravá-lo na linha do chamador, na mesma transação.

**Janela conhecida e aceita:** essa limpeza é escopada por `companyId`, como
toda escrita do projeto. Um aparelho compartilhado entre técnicos de empresas
**diferentes** fica fora do alcance dela. Fechá-la exigiria uma rota da empresa
A escrever na linha da empresa B, que é o que a regra de multi-tenancy proíbe —
e o pré-requisito do vazamento é estreito: mesmo aparelho físico, mesma
instalação, dois tenants, e um logout que não chegou ao servidor. A situação
se cura sozinha no primeiro registro seguinte dentro daquele tenant.

O valor bruto do `pushToken` **nunca sai do servidor**: a listagem
administrativa o converte em booleano, nenhuma rota o devolve, e a auditoria de
registro grava o **nome** do campo alterado, nunca o conteúdo.

#### O toque numa notificação indica destino — nunca autoriza

O payload de push chega pela rede e um aparelho comprometido pode forjá-lo.
Nada nele concede acesso: ele produz **uma rota**, e a tela consulta o servidor
pelo caminho autenticado de sempre. `getFieldServiceOrder` continua filtrando
por `companyId` **e** `technicianId` em SQL, sem saber que a navegação veio de
um aviso — uma OS reatribuída entre o envio e o toque responde `404`, e uma OS
de outra empresa também.

`404` e não `403`, pela mesma razão do resto da superfície: confirmar que aquele
identificador existe é justamente o fato que um técnico sondando ids não pode
aprender.

**Injeção de rota fechada na origem.** O identificador preenche UM segmento de
`/orders/:id`, então ele é validado contra `^[A-Za-z0-9_-]{1,64}$` antes de a
rota ser montada. Sem isso, `resourceId = "abc/execucao"` produziria
`/orders/abc/execucao`: o payload deixaria de indicar um recurso e passaria a
**escolher a tela**. A mesma validação passou a valer para a central de
notificações — ali é defesa em profundidade, já que a única escrita de
`Notification.resourceId` em produção grava o `id` da OS.

**O guarda de sessão é o do roteador, e não há segunda porta.** Sem sessão
autenticada o destino fica em memória e espera o login; ele é descartado quando
a fase vira `unauthenticated` ou `revoked`, porque um destino guardado durante a
sessão de um técnico não pode abrir na sessão do próximo no mesmo aparelho.
Nada é gravado em disco: um ponteiro para recurso de uma empresa não sobrevive
ao logout.

**Mensagem recebida com o aplicativo aberto não navega.** Ninguém tocou em
nada — ela atualiza estado, e apenas quando há sessão. Navegar ali tiraria o
técnico do meio de um atendimento sem que ele tivesse pedido.

### O cookie da web não abre o Field, e vice-versa

O token é lido **exclusivamente** de `Authorization: Bearer`. Nunca de cookie,
nunca de query string, nunca do corpo.

- **Cookie** está fora porque é o que o navegador envia sozinho — aceitá-lo
  reabriria CSRF numa superfície que hoje não tem essa classe de problema. É por
  isso que a Field API **não** usa `assertSameOrigin`: não existe CSRF contra
  uma API que só lê `Authorization`, e um cliente nativo não tem origem para
  apresentar.
- **Query string** está fora porque a URL entra em log de servidor, em histórico
  e no `Referer`.
- O login **não** emite `Set-Cookie`. O token viaja no corpo, uma vez, para que
  o aplicativo o guarde no cofre da plataforma (Keystore/Keychain).

### Recusa uniforme

Toda falha de autenticação é o mesmo `UNAUTHENTICATED`. Distinguir "token
inválido" de "aparelho revogado" de "usuário desativado" contaria a quem roubou
o aparelho em que pé está a conta.

O login recusa com a **mesma frase** para e-mail inexistente, senha errada,
usuário inativo, perfil não-TECHNICIAN, ausência de cadastro de técnico e
técnico inativo — qualquer diferença permitiria descobrir quem trabalha na
empresa a partir de um app que qualquer pessoa baixa. ADMIN e DISPATCHER não
entram no Field: dar-lhes token de aplicativo ampliaria o alcance de um aparelho
roubado para muito além de uma carteira de OS.

Força bruta reusa a máquina da web (`isLoginBlocked`, `recordLoginAttempt`,
custo constante de bcrypt, `DUMMY_PASSWORD_HASH`) — uma segunda implementação
seria uma segunda superfície de enumeração, e a que ninguém lembraria de
endurecer junto.

### Identidade de dispositivo

`installationId` é gerado pelo próprio aplicativo. Deliberadamente **não** é
IMEI, **não** é Android ID e **não** é número de telefone: número é reciclado
pela operadora e pertence à pessoa, então quem o receber depois passaria a
receber notificação operacional da empresa. Ele não é segredo e não autentica
nada — só correlaciona reinstalação com a mesma linha, dentro de um usuário que
já provou quem é.

`MobileDevice.technicianId` **não autoriza**: é registro histórico de quem
registrou o aparelho. A autorização é sempre re-derivada de `userId → Technician`.

### Idempotência como entrada não confiável

Escopo único `(companyId, userId, operation, key)`.

- **empresa e usuário** na chave para que reapresentar a chave de outra pessoa
  não devolva o resultado dela — seria um oráculo sobre operação alheia.
- **operação** para que a mesma chave em dois comandos não colida.
- Posse e tenancy são verificadas **antes** da desduplicação, nunca no lugar
  dela.
- **Só o sucesso é memorizado.** Guardar a falha transformaria uma recusa
  temporária em recusa permanente para aquela chave, e o aparelho ficaria com
  uma operação na fila local impossível de completar.
- A reserva é gravada antes de executar e a corrida é arbitrada pela unique do
  banco — verificar-e-depois-inserir deixaria duas requisições simultâneas
  executarem as duas.
- **Reserva abandonada tem prazo.** Gravar antes de executar deixa a linha
  `IN_FLIGHT` quando o processo morre no meio; sem prazo, a chave respondia
  `CONFLICT` por 24 h. O lease é de 2 minutos, e a tomada é arbitrada pelo banco.
  A tomada **re-executa** o handler em vez de fingir sucesso: quem garante que a
  mutação não aconteça duas vezes é o DOMÍNIO — máquina de estados e
  compare-and-set —, não esta camada. A impressão digital é conferida antes do
  lease, então chave reaproveitada para outro conteúdo continua sendo conflito.

### Minimização

Os DTOs do Field são projeções próprias, não o `PublicServiceOrder` da web —
que carrega `document` (CPF) para uma tela administrativa. Nunca no payload:
CPF, senha PPPoE, token, ciphertext de credencial, payload cru de provider,
dado financeiro, dados de outros técnicos.

A **lista** devolve `hasLocation` booleano, não a coordenada: mandar latitude e
longitude da carteira do dia distribuiria o endereço de cada cliente para um
cache que não tem uso para eles. A coordenada só aparece no detalhe.

`origin`, `externalProvider`, `externalId` e `externalNumber` ficam fora — e
isso é duplamente deliberado: como o dado não desce, não existe `if (RECEITANET)`
possível no aplicativo, e uma OS importada se comporta como qualquer outra.

### Privacidade da notificação

Título e corpo são redigidos para a tela bloqueada: número operacional e tipo.
Nome do cliente, endereço, telefone, CPF e diagnóstico ficam de fora **por
construção**, e há regressão que falha se algum deles aparecer.

`resourceId` é ponteiro, não permissão: a autorização é verificada na abertura,
e uma OS já reatribuída leva a uma negação limpa.

### Outbox

`Notification` e `OutboxEvent` são gravados na **mesma transação** da
atribuição. Chamar o provider de push lá dentro produziria transação aberta
esperando rede de terceiro, ou push entregue de uma atribuição que sofreu
rollback.

O payload carrega só identificadores. A tabela sobrevive à transação, é lida por
worker e aparece em dump e em backup; o worker relê o conteúdo na hora de
processar. `companyId` viaja no evento para que o worker respeite o isolamento
de tenant sem reconsultar o agregado.

`lastError` é sanitizado e truncado. Token de push nunca vai para log.

**Reivindicação tem lease de 5 minutos.** Sem ele, um worker morto entre
reivindicar e concluir deixava o evento em `PROCESSING` para sempre: nada mais
procurava por esse estado, e o requeue só aceita `FAILED`. O aviso sumia em
silêncio — o desfecho que a fila existe para evitar. O teto de tentativas vale
também no reclaim, senão um evento que derruba o processo seria reivindicado
indefinidamente.

A entrega é **at-least-once**, e isso é explícito: um worker pode morrer depois
de o provider aceitar e antes de marcar `PROCESSED`, e o evento sai de novo.
Exactly-once exigiria transação distribuída com um provider que não a oferece; a
escolha real é entre duplicar e perder, e perder um aviso de atribuição é pior.

Requeue de `FAILED` é `ADMIN`, filtrado por empresa, **sem corpo** — um endpoint
de requeue que aceitasse payload seria injeção de evento com outro nome.

### Rate limit

Sempre **depois** da autorização. Consumido antes, uma sondagem anônima ou de
outra empresa gastaria a cota de quem tem direito a ela — e a sondagem viraria
negação de serviço contra o técnico legítimo. Há regressão que prova isso: 20
chamadas sem token e 10 contra OS alheia não fazem a primeira chamada legítima
virar 429.

Vale a limitação herdada da §8.7: o estado é em memória do processo.

### Risco residual aceito

**Cursor hostil.** A paginação por cursor aceita qualquer id bem formado. O
filtro de posse e tenancy continua no `where` em SQL, então um cursor alheio
**não** traz linha de outro técnico nem de outra empresa — verificado por
ataque. O que ele pode fazer é deslocar a janela da própria lista de quem
chamou, ou seja, o técnico veria menos OS suas. É defeito de apresentação
autoinfligido, não travessia de autorização, e não justifica manter uma tabela
de cursores assinados.


---

## 8.14. Execução e fechamento em campo (v0.10)

A v0.10 acrescenta onze comandos mutantes e três leituras ao `/api/field/v1`, e
uma superfície administrativa para configurar checklist, política de conclusão e
catálogo de estoque. Nenhuma regra de negócio nova vive nas rotas: elas
autenticam, desduplicam e chamam os MESMOS serviços que a web chama.

### A sequência de todo comando, e por que a ordem é segurança

```text
autenticar → elegibilidade → Idempotency-Key → corpo → dedup → domínio
```

- **Elegibilidade antes da desduplicação.** Invertido, um técnico inelegível
  gravaria uma reserva `IN_FLIGHT` que depois bloquearia a chave legítima do
  próprio aparelho por até dois minutos.
- **Chave antes do corpo**, para recusar sem trabalho.
- **Domínio por último**, e é ele quem valida posse, estado e compare-and-set.

A sequência mora em `fieldOrderCommand` (`src/lib/field/command.ts`), uma vez.
A v0.9 a escrevia à mão em quatro rotas, o que estava certo com quatro; são
dezesseis agora, e a décima sexta é a que erraria a ordem.

### Posse é derivada da OS, nunca do corpo

`customerId`, `technicianId` e `companyId` **nunca** são lidos do corpo. O
cliente é alcançado através de uma OS que o técnico possui — é o que impede o
ataque de usar uma OS própria para corrigir o cadastro do cliente de outra.
Todo schema é `.strict()`: campo desconhecido é **recusado**, não descartado em
silêncio, porque um aplicativo que envia `companyId` precisa ouvir um "não" em
vez de achar que funcionou.

Recurso de OS alheia responde **404**, nunca 403 — 403 confirmaria que o id
existe, que é o fato que um técnico sondando ids não pode aprender.

### Check-in NÃO confirma localização

A fronteira mais fácil de apagar sem perceber. O check-in diz onde o APARELHO
estava quando o técnico declarou que chegou; `CustomerLocation.verified` diz que
uma pessoa conferiu que aquele é o ponto de instalação. Derivar o segundo do
primeiro produziria uma base inteira de coordenadas "verificadas" que ninguém
verificou — e faria isso em silêncio, em toda OS (PRD §172).

`verified` só é escrito por confirmação ou correção explícita, os dois caminhos
com ação humana deliberada. Há regressão que prova que um check-in com GPS
**não** marca a localização como verificada.

A distância até o cliente é calculada **no servidor** e registrada como
informação. Não bloqueia: GPS de celular erra dezenas de metros em área urbana
densa e falha dentro de prédio — exatamente onde o atendimento acontece.

### Precedência de localização — e o defeito que a auditoria encontrou

> Dado de menor confiança NÃO sobrescreve silenciosamente dado já confirmado
> (PRD §197).

`verified` domina o eixo `source`, com um degrau inteiro (+100) acima de
qualquer origem. Escrita automática — importação, geocodificação — passa
obrigatoriamente por `applyImportedCustomerLocation`, que não rebaixa
`verified`, não substitui ponto verificado e registra a divergência em vez de
escolher em silêncio.

**A auditoria da v0.10 encontrou essa regra implementada e sem chamador de
produção.** O caminho real (`enrichCustomerFromChatbot`) gravava coordenada e
`locationVerified: false` direto no `Customer`, então qualquer enriquecimento
rebaixava a confirmação de campo. Corrigido: a escrita passa pelo único caminho
automático, dentro da mesma transação do resto do cadastro. A regressão que o
prova entra pelo caminho REAL, não pelo helper — era exatamente essa a diferença
entre um teste que pega e um que não pega.

### Upload

Tipo real decidido pelo **número mágico dos bytes**, nunca pela extensão nem
pelo `Content-Type` — ambos escolhidos pelo cliente. SVG não é aceito em formato
nenhum: carrega script e rodaria na origem da aplicação. A chave de storage é
gerada no servidor a partir de ids que controlamos, então o nome enviado nunca
alcança o caminho — `../../../etc/passwd.png` vira nome de exibição e nada mais.
Só `file`, `expectedOrderVersion`, `category`, `caption` e `capturedAt` são
LIDOS do formulário; partes extras são ignoradas, que é a mesma garantia do
`.strict()` obtida por não ler.

`capturedAt` é informativo. O relógio do celular é ajustável pelo próprio
usuário e o EXIF é editável: o fato que vale para integridade é `createdAt`,
gravado pelo servidor quando o arquivo chegou (PRD §162).

`contentHash` é gravado como metadado e **não é único**. Transformá-lo em unique
criaria um caminho de sucesso-sem-escrita que enfraqueceria a garantia de
corrida do teto de evidências — cujo teste prova que de N envios concorrentes
exatamente um vence. A retentativa do Field já é coberta pela `Idempotency-Key`.

### Inventário — saldo é do técnico, e a corrida é real

O saldo é SOMA sobre movimentos imutáveis, nunca uma coluna. Isso cria um
problema que `SUM` sozinho não resolve: sob READ COMMITTED, duas baixas
simultâneas do último metro de cabo leem o mesmo total, as duas se acham
autorizadas e as duas gravam — e nenhuma transação fez nada errado isoladamente.
Não há linha de saldo a travar, porque o saldo é derivado.

A serialização é um **lock consultivo de transação** por `(empresa, item,
técnico)`, adquirido sempre DEPOIS do compare-and-set da OS. Como todo consumo
passa por `consumeInventoryForOrder`, a ordem é a mesma em todos os caminhos e
não há ciclo de espera. Colisão de `hashtext` custa paralelismo, nunca correção.

Quantidade é sempre positiva e o sinal vem do tipo: aceitar `-5` seria aceitar
uma ENTRADA disfarçada de baixa, que é como se cria saldo do nada num ledger que
confia no sinal do cliente. **O Field só emite `TECHNICIAN_TO_CUSTOMER`** — se
pudesse emitir entrada, o técnico criaria o próprio saldo antes de baixá-lo.

### Assinatura vinculada ao conteúdo

`signedContentHash` é o resumo determinístico do fechamento no instante da
assinatura. Sem ele a assinatura prova que alguém desenhou num vidro, não o que
a pessoa aceitou: o técnico colheria a assinatura e só depois acrescentaria
material ou trocaria o serviço realizado.

A verificação de obsolescência vale **mesmo sem política de conclusão**: se
existe assinatura, ela tem de corresponder ao que está sendo fechado. Assinatura
da v0.4 tem hash nulo e é ignorada — exigir recoleta retroativa impediria fechar
OS legítimas por uma regra que não existia quando foram assinadas.

### Conclusão

Duas verificações otimistas, e são mesmo duas: a da OS arbitra
`concluir × concluir` e `concluir × mutação-filha`; a da EXECUÇÃO impede que um
técnico numa segunda tela salve texto novo um milissegundo antes do fechamento e
a OS seja selada em torno de conteúdo que o autor do fechamento nunca revisou.

A validação roda DENTRO da transação, sobre os mesmos dados que serão selados, e
devolve a lista COMPLETA de pendências com códigos estáveis — um técnico que
descobre o que falta uma por uma faz uma ida ao servidor por item e, em rede de
borda, desiste no meio (PRD §166). A ausência de `ServiceOrderCompletionPolicy`
significa "sem exigência extra", e é o que mantém toda OS anterior à v0.10
concluindo exatamente como antes.

**Impedimento não muda status.** A OS continua `IN_PROGRESS`; fechá-la seria a
conclusão falsa que o impedimento existe para tornar desnecessária (§169).

### Minimização

O pacote de execução não carrega CPF, `externalProvider`, `externalId` nem
interno de auditoria — verificado por ataque, com controle positivo provando que
o cliente da fixture TEM documento gravado. A ausência do dado de provider é o
que impede um `if (RECEITANET)` no aplicativo.

Tentativa de contato registra **que** houve uma ligação, nunca o que foi dito:
conteúdo de conversa é outra categoria de dado, com outras obrigações de LGPD
(PRD §113).

### Riscos residuais aceitos

- **Correção de localização não incrementa `ServiceOrder.version`.** A
  localização é do CLIENTE e tem lock próprio; usar o da OS produziria conflitos
  espúrios entre um despachante e o técnico. Existe uma janela em que a OS fecha
  entre a leitura e a escrita da localização, e ela é benigna: a localização não
  entra no `closingContentHash` nem no snapshot de fechamento, então nada selado
  é alterado.
- **`storage.put` roda dentro da transação** (herdado da v0.4): o lock de linha
  da OS é mantido durante uma escrita de disco. Irrelevante para o adaptador
  local; é custo real a reconsiderar quando existir adaptador de rede (S3/R2).
- **Sem expurgo** de `CustomerLocationHistory`. A trilha é imutável e cresce; a
  deduplicação de divergência impede o crescimento por sincronização repetida,
  mas não há política de retenção.

---

## 8.15. Jornada / Ponto — Fase 1

A jornada acrescenta duas superfícies: `/api/field/v1/time-clock/*`, que segue
integralmente o modelo da **§8.13** (token opaco de `MobileDevice`, só
`Authorization: Bearer`, `Idempotency-Key` obrigatória, sem cookie e portanto
sem CSRF), e `/api/time-clock/*`, administrativa, que segue o modelo da web —
sessão em cookie, `assertSameOrigin` e papel conferido na rota.

Três garantias transversais valem em ambas, e nenhuma delas depende do cliente:

- **`companyId` sai da sessão ou do token**, nunca do corpo nem da rota;
- **`userId` da jornada é conferido no domínio**, e um id de outra empresa
  devolve **404** — não 403, para que um id sondado não aprenda que existe;
- **`TimeEntry` não tem caminho de `UPDATE`** em lugar nenhum do projeto.
  Correção cria linha nova, e a antiga permanece superada e visível (PRD §229).

### Separação de função na própria jornada

> Quem **abriu** a correção não **decide** essa correção quando a jornada é a
> própria.

A regra é a **conjunção** de `requestedById == decisor` **e** `userId ==
decisor`, e vive em `decideTimeAdjustment` (`src/lib/time-clock.ts`). Cada
metade sozinha estaria errada: a primeira proibiria o gestor de aprovar o que
abriu **para um funcionário** (§231, sem conflito de interesse); a segunda
proibiria o `ADMIN` de decidir o que um **colega** abriu sobre o dia dele (onde
o contraditório já existe).

**Abrir para si mesmo continua permitido.** Proibir a abertura empurraria o
`ADMIN` de volta para o `UPDATE` na marcação — o que o módulo existe para
impedir.

Três propriedades da recusa importam para auditoria:

1. é **403** com mensagem administrativa: o pedido existe, é da empresa, e quem
   pediu tem direito de vê-lo na fila;
2. acontece **depois do lock do dia e da releitura**, e **antes de qualquer
   escrita** — nenhuma `TimeEntry` derivada, nenhum `updateMany` no pedido e
   **nenhum `AuditLog`**. Um rastro de aprovação sem aprovação mente para quem
   audita depois;
3. o pedido permanece **`PENDING`**: recusar a decisão não pode consumir o
   pedido, ou a pessoa perderia a correção legítima ao tentar decidi-la por
   engano.

A fila do painel deixa de oferecer os botões e escreve `Requer outro
aprovador`. **Isso é UX.** A autoridade é o domínio — um `POST` montado à mão,
com sessão válida de `ADMIN`, recebe a mesma recusa (`time-clock-security.test.ts`).

### Idempotência da criação administrativa

`POST /api/time-clock/members/:userId/adjustments` **exige** `Idempotency-Key`.
Obrigatória, e não opcional: uma chave que o cliente pode omitir é uma proteção
que não vale nas requisições que mais precisam dela.

É a **mesma** infraestrutura da §8.13 — mesma tabela, mesmo lease de dois
minutos, mesma arbitragem pela unique `(companyId, userId, operation, key)`. Um
segundo sistema de idempotência para a web teria regras próprias de expiração e
tomada, e seria o que divergisse primeiro.

Duas escolhas de escopo são de segurança, não de estilo:

- **operação com nome próprio** (`time-clock.admin-adjustment`). Compartilhar o
  nome com o comando do Field faria uma chave repetida entre os dois devolver o
  desfecho guardado do outro;
- **o usuário do escopo é quem assina** — o gestor —, não o funcionário da
  jornada. Sem o usuário no escopo, a tabela viraria oráculo: apresentar a chave
  de um colega e ler a resposta guardada para ele.

### O fuso é da empresa, não do aparelho

`WorkdayView` carrega **`utcOffset`** (`-03:00`), calculado no servidor para
aquele dia por `utcOffsetIn`. O aplicativo monta o horário solicitado com esse
deslocamento.

Não é confidencialidade — é **integridade do registro de jornada**. Um celular
em fuso divergente fazia o técnico escolher `08:30` e o servidor gravar outro
instante, sem nada na tela denunciar. O deslocamento vem do servidor porque
resolver um nome IANA exige a base de fusos, e uma tabela embutida no APK
envelhece na primeira mudança de lei.

**O cliente nunca envia fuso.** Um `timezone` no corpo seria entrada não
confiável decidindo a que dia civil pertence uma batida; os schemas são
`.strict()` e recusam o campo. O servidor lê `Company.timezone`, e
`resolveTimezone` cai em `America/Sao_Paulo` diante de valor inválido gravado.

**As DUAS respostas que produzem um `Workday` carregam o deslocamento** —
`GET /today` e `POST /entries`. A revisão do endurecimento encontrou a segunda
sem ele: o aplicativo grava o dia que volta da batida e só depois relê `today`,
e quando essa releitura falha — rede caindo logo após bater — o estado **fica**
com o que veio da batida, até a próxima leitura que der certo. A janela não é
de um quadro, e dentro dela o Field voltava ao relógio do aparelho para exibir
e para montar correção. Corrigido, com regressão nas duas pontas
(`time-clock-hardening.test.ts` e `apps/field/test/widget/time_clock_test.dart`).

### Riscos residuais aceitos

- **`Company.timezone` não tem superfície administrativa** (JOR-05, PRD §253).
  O padrão atende o piloto; a leitura já é defensiva. Não é risco de
  autorização.
- **A lista de correções do Field exibe horários de outros dias com o
  deslocamento de hoje.** Só exibição, com a data ao lado, e só divergiria num
  fuso com horário de verão. O instante gravado é sempre o montado com o
  deslocamento do dia correto.
- **Segregação de função não é configurável por empresa.** A regra é fixa na
  Fase 1. Política por empresa — exigir dois aprovadores sempre, ou liberar
  autoaprovação em empresa de uma pessoa só — fica para a fase de configuração.

---

## 8.16. Permissões do Android — auditoria de pré-release

Auditoria completa das permissões do AlfaOS Field, feita depois de `NF-1`…`NF-5`
e antes do checkpoint da fundação de notificações. O que segue é o resultado,
não a intenção: cada linha foi conferida no manifesto **fundido** e no APK.

### 8.16.1 O que a auditoria descobriu

**O manifesto de fonte não é o que vai no aparelho.** O Gradle funde o nosso com
o de cada plugin e o de cada AAR. O AlfaOS declara **cinco** permissões; o APK
tem **nove**. As quatro extras entraram com o `firebase_messaging` na `NF-2` e
nunca foram registradas em lugar nenhum.

Pior: um teste afirmava que o aplicativo **não** usava `WAKE_LOCK`. A afirmação
era verdadeira sobre o arquivo que ele lia e falsa sobre o artefato. Um teste
que documenta uma crença errada é pior que a ausência do teste, porque encerra a
discussão. Corrigido, com a verdade sobre o artefato movida para um teste que lê
o manifesto fundido.

### 8.16.2 Matriz definitiva

| PERMISSION | WHY | WHEN REQUESTED | RUNTIME | STATUS |
|---|---|---|---|---|
| `INTERNET` | falar com a API do AlfaOS | instalação | não | **KEEP** |
| `CAMERA` | evidência fotográfica do atendimento (PRD §162) | ao acionar a foto, pelo `image_picker` | sim | **KEEP** |
| `POST_NOTIFICATIONS` | avisar OS atribuída (`NF-2`…`NF-5`) | depois do primeiro login, com contexto | sim | **KEEP** |
| `ACCESS_FINE_LOCATION` | ponto e check-in, enquanto em uso | ao bater ponto / fazer check-in | sim | **KEEP** |
| `ACCESS_COARSE_LOCATION` | idem, e sustenta a escolha "Aproximada" | no mesmo pedido | sim | **KEEP** |
| `WAKE_LOCK` | `firebase_messaging` acorda o aparelho para entregar | — | não | **KEEP (plugin)** |
| `ACCESS_NETWORK_STATE` | `firebase_messaging` decide quando repetir | — | não | **KEEP (plugin)** |
| `com.google.android.c2dm.permission.RECEIVE` | receber do Google Play Services | — | não | **KEEP (plugin)** |
| `…field.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` | `androidx.core`, nível `signature`, escopada ao pacote | — | não | **KEEP (plugin)** |

**Nenhuma permissão foi removida** — nenhuma sobrava. E nenhuma foi acrescentada.

Ausentes e que continuam ausentes, por decisão: `ACCESS_BACKGROUND_LOCATION`,
`FOREGROUND_SERVICE*`, `RECORD_AUDIO`, `BLUETOOTH_*`, `READ_MEDIA_IMAGES`,
`READ/WRITE_EXTERNAL_STORAGE`, `MANAGE_EXTERNAL_STORAGE`, `SYSTEM_ALERT_WINDOW`,
`REQUEST_INSTALL_PACKAGES`, `PACKAGE_USAGE_STATS`, `SCHEDULE_EXACT_ALARM`,
`RECEIVE_BOOT_COMPLETED`, e todas as de telefonia, SMS e contatos.

### 8.16.3 A política de pedido

**Nada é pedido na subida.** Não existe `requestAllPermissionsOnStartup()`, e a
sua ausência é testada: a subida (`lib/app/app.dart`) não pode nem mencionar
sensor ou pedido de permissão.

Três pontos pedem, e cada um dentro da própria funcionalidade:

- **localização** — em `GeolocatorLocationService.current()`, chamado pelo ponto
  e pelo check-in;
- **notificação** — no `PushCoordinator`, depois do primeiro login, com a folha
  de contexto;
- **câmera** — pelo próprio `image_picker`, no instante em que a foto é
  acionada. A declaração de `CAMERA` no manifesto é o que faz o plugin pedir:
  `ImagePickerUtils.needRequestCameraPermission()` é literalmente "a permissão
  está no manifesto?". Sem a declaração ele dispensaria o pedido; com ela, pede
  no lugar certo.

**Negar não bloqueia nada**, e isto foi provado em aparelho, não afirmado.

### 8.16.4 Fronteira testada — `android_permissions_test.dart`

Quatro grupos, e a forma importa:

- **PERM-01** — o conjunto da fonte é comparado por **igualdade**, não por
  ausência. Uma lista de proibidas só pega o que alguém já imaginou; a igualdade
  obriga quem acrescentar qualquer permissão a escrever aqui por que ela existe.
- **PERM-02** — nenhuma proibida, na fonte **e** no fundido.
- **PERM-03** — o fundido é exatamente a fonte mais as injeções declaradas, nos
  **dois** sentidos: sobrando significa plugin novo não registrado; faltando
  significa que a lista está descrevendo um mundo que não existe mais.
- **PERM-04** — só três arquivos podem conter `requestPermission()`, e a subida
  não menciona sensor.

Limite declarado: `flutter clean` apaga o manifesto fundido, e sem ele PERM-02
(fundido) e PERM-03 **pulam** em vez de falhar. Elas são gate de build, não de
teste isolado — a ordem correta é `flutter build apk` antes de `flutter test`.

### 8.16.5 Provas físicas

Aparelho real, permissões partindo de `granted=false`.

**Localização** — o prompt nativo apareceu ao bater ponto, **não na subida**, com
as opções `Exata`/`Aproximada` e `Durante o uso do app`; **não** havia opção "o
tempo todo", que é a confirmação visível de que `ACCESS_BACKGROUND_LOCATION` não
está declarada. Resultado no banco, do prompt até a linha gravada:

| Batida | Permissão | Coordenada | Precisão |
|---|---|---|---|
| `CLOCK_IN` | negada | não | — |
| `BREAK_START` | aproximada | sim | 2000 m |
| `BREAK_END` | aproximada | sim | 2000 m |
| `CLOCK_OUT` | aproximada | sim | 2000 m |

A primeira linha é a prova de que **negar não bloqueia**: o ponto foi registrado
sem coordenada. As demais provam por que as duas permissões de localização são
declaradas juntas — com só `FINE`, escolher "Aproximada" negaria tudo. Os 2000 m
são a assinatura da localização aproximada do Android.

`POST_NOTIFICATIONS` estava `granted=true`, confirmando o piloto da `NF-5`.

**Câmera — EXECUTADO depois, e PASSOU (§8.16.11).** Na auditoria de permissões
ficou NÃO EXECUTADO porque a tela de Execução não carregava. O bloqueio era
transitório, do servidor de desenvolvimento, e não defeito de rota — §8.16.11
mostra por quê. Nenhum `pm grant` foi usado em teste nenhum.

### 8.16.6 Achado fora do escopo, não corrigido

A tela de **Execução** não carrega contra o servidor de desenvolvimento. O
domínio está sadio — `getFieldExecutionBundle` devolve o pacote completo quando
chamado direto, com os identificadores reais. A falha está acima dele, e um
sintoma adjacente foi observado: sem token, `/api/field/v1/notifications`
responde `401` com o envelope JSON correto, enquanto as duas rotas sob
`service-orders/[id]` respondem **500 com HTML**. Merece investigação própria;
não é regressão desta auditoria e não toca permissão.

### 8.16.7 `PHOTO-PICKER-01` — pendência de produto: o seletor de fotos

`image_picker` expõe `useAndroidPhotoPicker`, e o padrão do plugin é `false` — o
AlfaOS nunca o liga. A galeria abre por `ACTION_GET_CONTENT`, não pelo seletor
moderno do Android.

**Isto não é questão de permissão.** Nenhum dos dois caminhos exige permissão de
armazenamento: ambos são Intent para um app do sistema, e a URI devolvida vem
com acesso por item. Nada foi declarado nem é necessário — `READ_MEDIA_IMAGES` e
`READ/WRITE_EXTERNAL_STORAGE` estão ausentes e continuam proibidos pelo teste.

É preferência de produto, e fica registrada em vez de aplicada: ligar o seletor
moderno muda o comportamento da tela de foto, que é exatamente o caminho que
esta auditoria **não conseguiu exercitar em aparelho** (§8.16.5). Mudança de UX
não verificável não entra numa auditoria.

### 8.16.8 `EXIF-01` — coordenada GPS viaja na foto de evidência · **CLOSED**

> **Estado: `CLOSED`.** Corrigido no servidor, com prova de reprodução antes e
> teste físico depois. O registro do achado fica abaixo; a correção está em
> §8.16.10.

**Achado da auditoria independente. Pré-existente desde a v0.10.**

Toda foto de evidência sobe com o bloco GPS do EXIF intacto. A cadeia foi
verificada no fonte resolvido deste projeto, não presumida:

- `ExifDataCopier` do `image_picker_android 0.8.13+21` tem **32** referências a
  `TAG_GPS_*` e as copia para o arquivo redimensionado;
- o ramo que **não** redimensiona (`ImageResizer.shouldScale == false`) devolve
  o arquivo original, com o EXIF completo — os dois caminhos preservam GPS;
- o servidor grava o buffer verbatim (`src/lib/storage/local.ts`), e o
  `package.json` **não tem** nenhuma biblioteca de imagem. Nada remove o EXIF em
  ponto nenhum da cadeia.

**Por que isto importa mais que uma permissão a mais.** O GPS do EXIF é escrito
pelo aplicativo de câmera, sob a permissão **dele**. O técnico que **negou**
localização ao AlfaOS continua enviando coordenada em cada foto — a recusa dele
não tem efeito nenhum sobre esta coleta, que é a definição de consentimento
contornado. E `pickFromGallery()` é pior: sobe coordenada de outro tempo e outro
lugar, como a casa do técnico numa foto tirada no fim de semana. Colide com a
§138 do PRD, que trata localização de pessoa como dado sensível.

Não é vazamento entre empresas nem falha de autorização — o dado fica dentro do
tenant. É coleta e retenção de dado pessoal fora da política que o próprio
projeto escreveu.

**Por que não foi corrigido na auditoria de permissões.** O mandato daquela
tarefa proibia dependência nova, e a saída parecia exigir uma — o caminho do
aparelho está fechado (`requestFullMetadata` **não tem implementação Java** no
plugin, e remover `maxWidth`/`imageQuality` não ajuda porque o ramo sem
redimensionamento preserva o EXIF igual). A reavaliação mostrou que a correção
no servidor **não** precisa de dependência: ver §8.16.10.

`ACCESS_MEDIA_LOCATION` — a permissão que destravaria o GPS de EXIF em foto de
galeria no Android 10+ — entrou na lista de proibidas do teste de fronteira,
para que a superfície não cresça enquanto a coleta não for cortada.

### 8.16.9 O que a auditoria independente corrigiu no próprio teste de fronteira

A revisão independente devolveu `APPROVED WITH RISKS` — 0 CRITICAL, 0 HIGH, 2
MEDIUM — e **o segundo MEDIUM era sobre o teste escrito nesta mesma tarefa**.

As duas asserções que leem o manifesto fundido — as únicas do repositório
capazes de ver injeção por plugin — chamavam `markTestSkipped` quando o artefato
faltava. `build/` é ignorado pelo Git, então em clone novo, em CI ou depois de
`flutter clean` elas **não rodavam**, e o resumo dizia `~2`, que ninguém lê como
"a asserção de segurança não aconteceu". Pior: o `README` do próprio app mandava
rodar `flutter test` **antes** de `flutter build apk` — exatamente a ordem em que
a proteção não existia.

É o mesmo erro que esta auditoria corrigiu no `NF2-13`, com outra roupa:
concluir sobre o artefato a partir de algo que não é o artefato. Pular em
silêncio é a forma mais educada de fazer isso.

Corrigido em três frentes: a ausência do artefato agora **falha**, com mensagem
dizendo o que rodar; o `README` inverteu a ordem, com o motivo escrito; e entrou
uma conferência de **frescor**, porque manifesto obsoleto é pior que ausente —
ele passa, comparando com o mundo de ontem.

**A primeira versão do frescor estava errada, e o gate a derrubou.** Ela
comparava com o `pubspec.lock`, que qualquer `flutter pub get` reescreve mesmo
sem mudança — enquanto o Gradle **não** reescreve o manifesto quando considera a
tarefa atualizada. O resultado era vermelho depois de um `pub get` inocente, e
gate que grita à toa é gate que as pessoas aprendem a ignorar. O sinal passou a
ser o `pubspec.yaml`, que é o arquivo que uma **pessoa** edita para acrescentar
plugin e que nenhuma ferramenta reescreve sozinha.

Também da auditoria: a asserção dizia "o manifesto fundido, que é o que vai no
aparelho" e lia o de **debug** — o que vai para a loja é o de release. O texto
foi corrigido e o de release passou a ser conferido quando existe (este
repositório não produz APK assinado, então ele costuma não existir, e o pulo
aparece no resumo). E `ACCESS_MEDIA_LOCATION` e `QUERY_ALL_PACKAGES` entraram na
lista de proibidas.

**Ressalva que fica de pé:** os testes passarem não prova que o APK de *release*
está limpo. Eles rodam contra o fundido de **debug**, e o de release nunca foi
gerado neste repositório.

### 8.16.10 A correção do `EXIF-01` — limpeza de metadado no servidor

#### A fronteira, e por que ela é o servidor

`src/lib/media/image-metadata.ts`, chamado por `addEvidence` e `putSignature`
(`src/lib/service-order-closing.ts`) — os **dois** pontos que persistem imagem.

Qualquer cliente pode enviar imagem: o aplicativo, um script, uma integração
futura, alguém com o token. Uma limpeza feita só no aparelho protegeria
exatamente quem já se comporta bem. E a posição dentro da função importa: a
sanitização acontece **antes do hash e do tamanho**, de modo que `contentHash` e
`sizeBytes` descrevem o ARQUIVO GRAVADO. Sanitizar depois do hash faria o campo
que existe para provar "o arquivo não mudou" acusar corrupção em toda foto.

#### Dependência: nenhuma

Metadado vive em **segmentos de contêiner**, ao lado dos dados comprimidos — não
dentro deles. Removê-lo é percorrer a estrutura e não copiar certos pedaços:
nenhum pixel é decodificado, nada é recomprimido, nenhuma qualidade se perde.
`sharp` faria o oposto — decodificar e reencodar tudo para jogar fora um punhado
de bytes —, cobrando binário nativo no deploy e degradando a evidência a cada
upload. O inventário confirmou que o projeto **não tem** nenhuma biblioteca de
imagem, e continua sem ter.

#### Política de metadado

| Segmento | Destino | Por quê |
|---|---|---|
| `APP0` com prefixo `JFIF\0` | fica | estrutural; não fala da pessoa |
| `APP2` com prefixo `ICC_PROFILE\0` | fica | perfil de cor; tirá-lo muda como a foto APARECE |
| `APP1` Exif | sai, **menos `Orientation`** | é onde mora a IFD de GPS |
| `APP1` XMP | sai | `exif:GPSLatitude` em texto |
| `APP13` IPTC, demais `APPn`, `COM` | sai | sem valor operacional |
| bytes depois do `EOI` | sai | trailer de Motion Photo |
| PNG `eXIf`/`tEXt`/`iTXt`/`zTXt` | sai | `eXIf` carrega GPS igual ao do JPEG |
| WebP `EXIF`/`XMP `, com os bits do `VP8X` zerados | sai | senão o arquivo se descreve errado |

**Minimização com uma exceção declarada.** `Orientation` é reinjetada num EXIF
mínimo de 34 bytes porque o AlfaOS **não decodifica** a imagem: os pixels chegam
como a câmera os gravou e é a tag que os endireita. Apagá-la faria toda foto de
retrato aparecer deitada, e o técnico levaria a culpa por "tirar a foto errada".
Imagem sem orientação declarada **não ganha uma inventada**.

**O que isto NÃO faz:** não é defesa contra esteganografia. Dado escondido nos
pixels sobrevive, e sobreviveria a um reencode também.

#### O que a auditoria independente encontrou na primeira versão

Veredito `APPROVED WITH RISKS` — 0 CRITICAL, 0 HIGH, **2 MEDIUM**, e os dois
eram reais. Ambos corrigidos, com regressão própria e prova de reversão:

* **`EXIFA-01` — arma de CPU.** O percurso trabalha sobre bytes escolhidos por
  quem envia, e marcadores isolados ocupam **dois bytes**: 8 MB deles produziam
  **1452 ms de event loop bloqueado**, contra 2 ms de um JPEG normal — 726
  vezes. Em Node isso não é uma requisição lenta, é a aplicação inteira parada,
  para todos os tenants, porque a thread é uma só. Fechado com teto de 1024
  segmentos, que nenhum JPEG real alcança.
* **`EXIFA-02` — o arquivo não termina na imagem.** A limpeza copiava tudo a
  partir do `SOS`, o que está certo para os dados comprimidos e errado para o
  que vem depois do `EOI`. Samsung e Google anexam ali o MP4 da Motion Photo,
  cujo `moov/udta/©xyz` guarda coordenada — e ele atravessava intacto o mesmo
  arquivo em que GPS, thumbnail e IPTC eram removidos. Alcançável pela **web**,
  onde o `<input type="file">` envia o arquivo cru. Fechado cortando no `EOI`.

Mais dois `LOW`: `APP0` e `APP2` eram preservados pelo **número** do marcador,
o que deixava passar `JFXX` (que carrega thumbnail) e qualquer carga com prefixo
parecido com `ICC_PROFILE`. Agora são reconhecidos pelo conteúdo.

#### Efeito colateral declarado: a validação apertou

De "tem os bytes mágicos certos" para "é um contêiner que fecha". Arquivo
truncado ou malformado passa a receber **400** em vez de ser gravado corrompido
— falha fechada, e estritamente melhor. O preço apareceu de imediato: os
fixtures de imagem de **sete** arquivos de teste eram assinatura mais enchimento
e nunca foram imagem nenhuma. Viraram contêineres mínimos válidos.

#### Provas

Reprodução antes da correção: **8 testes falhando**, com GPS sobrevivendo à
persistência. Depois: **16 testes** (`EXIF-01`…`EXIF-10`), e seis provas de
reversão — persistir o original, preservar GPS, apagar sem tratar orientação,
copiar até o fim do buffer, remover o teto de segmentos, e preservar `APPn` pelo
número.

**Prova física**, aparelho real, foto real capturada pela tela que o técnico usa:

```text
original enviado pelo aparelho   EXIF_PRESENT=true   26406 bytes, com marca/modelo/MakerNote
arquivo gravado                  EXIF_PRESENT=false  25267 bytes
                                 GPS_METADATA_PRESENT=false
                                 XMP_PRESENT=false
segmentos preservados            0xE0 (JFIF), 0xE2 (ICC) — exatamente a política
```

**Limite honesto:** aquele exemplar **não tinha GPS** — a câmera do aparelho não
anexou coordenada —, então o teste físico prova que EXIF real de câmera é
removido, e o GPS especificamente é provado pelo teste com fixture controlado. A
IFD de GPS mora **dentro** do bloco EXIF que foi demonstravelmente removido por
inteiro, o que liga as duas provas.

### 8.16.11 Teste físico da câmera — `PASS`

Executado pela mesma tela que o técnico usa em produção; nenhuma rota
temporária, nenhuma tela de depuração, nenhum `pm grant`.

```text
estado inicial          CAMERA granted=false
OS -> Execução -> Adicionar foto -> categoria
  prompt NATIVO do Android aparece EXATAMENTE aqui, não no login nem na subida
NÃO PERMITIR            app não quebra; câmera não abre; fotos, OS e sessão
                        intactas; granted=false com USER_SET
segunda tentativa       o prompt reaparece — negar uma vez não é permanente
DURANTE O USO DO APP    granted=true; a câmera do sistema abre
captura + envio         evidência gravada, e sem metadado (§8.16.10)
```

**O bloqueio anterior era do servidor de desenvolvimento, não da rota.** A
`getFieldExecutionBundle` já respondia corretamente quando chamada direto com os
identificadores reais, a rota tem cobertura de teste que passa, e numa instância
limpa as três rotas devolvem `401` JSON para requisição sem token — inclusive as
duas sob `service-orders/[id]`, que antes tinham devolvido `500` HTML. Nenhuma
linha de rota, autorização, tenancy, posse, máquina de estados ou CAS foi
alterada para fazer a tela carregar.

---

## 8.17. `SSRF-01` — IPv4 embutido em literal IPv6 escapava do filtro

Achado da **auditoria independente de release**, com exploração demonstrada.
Corrigido antes da decisão de publicação.

### O defeito

`assertSafeOutboundUrl` recusa endereço interno, e a verificação tinha a
ramificação certa para IPv4 embutido em IPv6 — que **nunca disparava**. O parser
WHATWG de `URL` normaliza `[::ffff:127.0.0.1]` para o hostname
`[::ffff:7f00:1]`: hexadecimal, sem ponto nenhum. A regex procurava a forma
pontuada, não casava, e a função devolvia `false`.

Reproduzido de forma independente, com controle positivo:

```text
recusado    https://127.0.0.1
recusado    https://[::1]
ACEITO      https://[::ffff:127.0.0.1]          loopback
ACEITO      https://[::ffff:169.254.169.254]    metadados de nuvem
ACEITO      https://[::ffff:10.0.0.5]           RFC1918
ACEITO      https://[64:ff9b::127.0.0.1]        NAT64
```

O host é literal, então `isIP` é verdadeiro e **o DNS nem é consultado** — não
dependia de resolvedor hostil nem de rebinding. Um ADMIN fazia o servidor do
AlfaOS emitir `POST` para endereço interno arbitrário pela tela do SGP, e a
ativação **persistia** esse endereço em `ERPIntegration.baseUrl`.

SSRF **cega** — o corpo do provider nunca é ecoado —, mas `reachable`,
`latencyMs` e a classe da mensagem formam um oráculo de vivacidade suficiente
para mapear serviço interno.

### A correção

A forma hexadecimal passou a ser reconhecida: `::ffff:`, `::` e `64:ff9b::`
seguidos de dois grupos hexadecimais viram o IPv4 correspondente, e a decisão
volta para a mesma tabela que governa o resto. Nove formas privadas recusadas,
e **endereço público em literal IPv6 continua aceito** — sem isso, a correção
passaria também se alguém barrasse todo IPv6, e um SGP hospedado em IPv6
pararia de funcionar sem explicação.

### A lição, que vale além deste achado

**O teste existia e estava no nível errado.** A suíte de SSRF cobria
`https://[::1]` e `https://[fe80::1]` — os dois únicos literais IPv6 que
atravessam a normalização **inalterados**. O caso que o comentário do código
nomeava não era exercitado em nível nenhum: teria passado em `isPrivateAddress`
e falhado em `assertSafeOutboundUrl`.

A regressão (`SGP1-11b`) vive **no nível do guarda**, não da função auxiliar,
porque é ali que a normalização da URL já aconteceu. Ao revisar teste novo, a
pergunta é *"o defeito conseguiria aparecer nesta asserção?"* antes de *"a
asserção está correta?"*.

---

## 8.18. `RC-1` — a ativação do SGP é travada até a homologação real

Fecha o único MEDIUM aberto da revisão final de checkpoint.

### O que a revisão mediu

O SGP autentica e é ativável desde a `SGP-1`, e **nunca foi exercitado contra
uma instalação real**. A consequência de ativá-lo hoje não é hipotética: o
`SgpAdapter` não declara capability de negócio nenhuma, então toda a superfície
ERP da empresa passa a responder `NOT_SUPPORTED` — busca de cliente,
diagnóstico, chamados. Reversível, porque a credencial do provider anterior é
preservada; e **ninguém era avisado**.

### A trava

`SGP_ACTIVATION_ENABLED`, padrão `false`, comparação **exata** com `"true"`.
Ausente é `false`; ilegível é `false`. `"1"`, `"yes"` e `"TRUE"` não liberam —
um parser permissivo transforma erro de digitação em liberação silenciosa, e o
padrão de uma trava de release tem de ser fechado.

**Ela vive no domínio, não na rota**, e a diferença é o que a torna uma regra em
vez de uma porta: um caller futuro — script, job, outra rota — herda a trava sem
precisar lembrar dela.

E vive nas **duas** funções que escrevem `ERPIntegration.provider`, que são as
únicas do repositório: `activateErpProviderWithConfiguration` e
`switchActiveErpProvider`. A segunda já recusava o SGP, mas por
`requiresCandidateConfiguration` — um predicado que existe por outra razão. Duas
proteções que só coincidiam por acidente: um provider futuro que precise de
trava e não de configuração candidata passaria direto, e ninguém saberia que
aquele `if` virara controle de release. Apontado pela auditoria independente.

**E é defesa em profundidade, declarada como tal.** Remover o guarda dessa
segunda função **não derruba nenhum teste** — foi verificado por sabotagem —,
porque o predicado vizinho continua recusando o SGP antes dele. O valor dele é
futuro, para o provider que ainda não existe; hoje ele não é o controle que
carrega o peso, e afirmar o contrário seria vender proteção que não está sendo
exercida.

O guarda roda **antes de tudo**: antes da validação do candidato
(que resolve DNS), antes do reteste (que emite requisição), antes da cifragem e
da transação. Uma recusa não toca a rede e não deixa rastro — nem
`ERPIntegration`, nem `ERPCredential`, nem `AuditLog`.

Resposta: **409**, e a mensagem **não nomeia a variável de ambiente**. Quem
opera precisa saber que a ativação não está liberada e o que fazer; quem sonda
não precisa saber como ela é ligada.

### O que a trava NÃO faz

**Não bloqueia testar.** É diagnóstico, não persiste nada, não altera o ERP
ativo — e é exatamente o que a homologação precisa. **Não é global.** O
ReceitaNet, o rollback e a troca entre providers liberados seguem intactos: um
guarda global pareceria mais seguro e quebraria a operação de quem já usa ERP,
inclusive o caminho de volta.

**E não prende ninguém dentro do SGP.** A trava é de ativação, não de uso:
fechá-la depois de uma empresa já estar no SGP não impede a volta. Provado por
`RC1-14`, e não afirmado — o contrário transformaria uma proteção de release
numa armadilha, justamente para quem ativou antes dela existir.

> **Correção de uma afirmação que estava aqui.** Esta seção dizia que "a
> sabotagem que aplica a trava a todos os providers derruba apenas `RC1-08`".
> **Era falsa**, e a auditoria independente mostrou por quê: aquela sabotagem
> também punha o guarda em `switchActiveErpProvider`, e foi essa metade que
> derrubou o teste. Tirar `provider === "SGP"` do predicado teria sido
> **invisível para a suíte inteira** — nenhum teste chamava a ativação com outro
> provider. A especificidade agora é afirmada no próprio predicado (`RC1-13`).

### A tela

`EM VALIDAÇÃO` no lugar de `DISPONÍVEL`, com o aviso **antes** do formulário e
não depois do erro: sem isso a pessoa preenche Base URL, App e Token, testa com
sucesso e só então descobre que ativar não é possível. O botão de ativar não é
renderizado.

**A tela é consequência da regra, nunca a regra.** Esconder botão não é
controle: `RC1-11` chama a rota direto, sem tela nenhuma, e recebe 409 sem
nenhuma mutação.

### Quando liberar

Depois de o SGP ser exercitado contra uma instalação real — inclusive o detalhe
de transporte ainda aberto (`urlencoded` × `multipart/form-data`,
`docs/ERP-SGP.md` §10). Aí `SGP_ACTIVATION_ENABLED=true`, deliberadamente.

O estado documentado do SGP passa a ser: **`CODE COMPLETE`,
`REAL TENANT VALIDATION REQUIRED`, `PRODUCTION ACTIVATION GUARDED`.**

---

## 8.19. `CTO-1` — capability, isolamento e a fronteira única de imagem

Fase de cadastro de CTOs e portas. Três decisões de segurança e uma correção de
concorrência achada durante a implementação.

### A capability é a primeira verificação, e responde 404

`Company.ctoNetworkEnabled`, padrão `false`, e nenhuma empresa é habilitada pela
migration. `requireCtoAccess` (`src/lib/cto-access.ts`) é o único portão, e a
ordem é fixa:

```text
1. sessão ausente          401
2. capability desligada    404
3. perfil não autorizado   403
4. recurso de outra empresa 404   (no domínio, por predicado SQL)
```

**A capability é verificada ANTES do perfil, e inverter a ordem vaza
informação.** Com o perfil primeiro, um `DISPATCHER` de empresa que não
contratou o módulo receberia 403 — que significa *"isto existe, você é que não
pode"* — e a empresa descobriria pela resposta de erro que há um módulo CTO.
Com a capability primeiro, quem não a tem vê o mesmo que veria se a rota não
existisse.

Um par de testes fixa isso: o **mesmo** perfil recebe 404 com a capability
desligada e 403 com ela ligada. Sem o segundo, o primeiro passaria mesmo que o
404 viesse do lugar errado.

**Capability não é permissão**, e o inverso também vale: perfil correto numa
empresa sem a capability continua sendo 404. A verificação existe na API **e**
na página; esconder o item do menu é conveniência, nunca controle, e há teste
de acesso direto à URL provando isso.

A leitura é do **banco** a cada requisição, nunca da sessão: o token é emitido
no login e carregaria o valor de então, de modo que desligar o módulo só teria
efeito quando cada pessoa reautenticasse.

### Isolamento de tenant

`companyId` sempre da sessão. Nenhum schema de entrada tem o campo, e todos são
`.strict()` — um `companyId` enviado assim mesmo é **rejeitado** com 400, não
descartado em silêncio. Descartar deixaria quem tentou achando que funcionou, e
apagaria o sinal de que alguém está tentando.

O filtro vai no **predicado SQL**, nunca por navegação de FK: o módulo não tem
um `findUnique({ id })` sequer. Recurso de outra empresa é **404** em leitura,
edição, capacidade, inativação, estado de porta e foto — cada um com controle
positivo provando que o caminho autorizado devolve o dado.

Uma verificação a mais que não é sobre tenant: o `ctoId` do caminho participa do
predicado do estado da porta. Sem ele, o id de uma porta de **outra caixa da
mesma empresa** seria aceito — não é cross-tenant, mas é escrever num recurso
diferente do que a URL nomeia.

### A foto da CTO não é evidência de OS

Ela não passa por `loadInProgressOwnedOrder`, não tem `serviceOrderId` e não
conta em política de conclusão nenhuma. A caixa é infraestrutura do provedor: a
autorização é a da infraestrutura — ADMIN da empresa dona —, e criar uma OS só
para permitir a foto inventaria um vínculo que não existe.

**A fronteira de upload foi extraída ANTES deste terceiro consumidor**
(`src/lib/media/image-upload.ts`). Até aqui a política vivia duplicada em
`addEvidence` e `putSignature`; acrescentar a CTO como terceira cópia é
exatamente a forma como o `EXIF-01` aconteceu — um ponto de upload nascendo
fora da política, sem ninguém notar porque não havia política, havia repetição.

A fronteira decide, nesta ordem: vazio, teto, sniff do tipo **real**, allowlist
do declarado, concordância entre os dois, e a sanitização de metadado
(EXIF/GPS, XMP/IPTC, comentários, trailer depois do `EOI`, teto de segmentos).
O teto vem antes do sniff porque as duas etapas seguintes percorrem o arquivo;
a sanitização vem por último porque é a única que **produz** bytes, e é sobre
eles que hash e tamanho são calculados.

> **Prova de que a fronteira é uma só:** devolver os bytes originais em
> `processImageUpload` derruba **12 testes** de uma vez — evidência, assinatura
> e foto de CTO. Nenhum consumidor ficou fora.

A chave do storage é construída no servidor (`buildStorageKey`), e **nunca sai
na resposta**: o DTO expõe `hasPhoto`, não o caminho. Servir os bytes exige
sessão, capability e tenant; saber o id da CTO não basta para ler a foto de
outra empresa. `Content-Disposition: attachment` e `X-Content-Type-Options:
nosniff` fecham a segunda metade da defesa que começa recusando SVG no upload.

> **`CTO-1.8` — `attachment` foi MEDIDO, não presumido.** A `CTO-1.7` justificou
> o preview por precedente (a evidência de OS já usava `<img src="/api/...">`
> com o mesmo cabeçalho). A `CTO-1.8` fechou a lacuna com prova própria: com uma
> imagem decodificável de dimensões conhecidas, o navegador reporta
> `naturalWidth`/`naturalHeight` corretos na primeira foto, na substituição e
> depois do F5 — navegadores aplicam `Content-Disposition` a navegação de topo,
> não a subrecurso. **A troca para `inline` foi avaliada e recusada**: não
> corrige nada e enfraquece a defesa. Trocar cabeçalho de segurança para
> resolver um sintoma que ele não causa é como uma proteção some sem que
> ninguém decida removê-la.
>
> Os cabeçalhos passaram a ser afirmados por teste, junto com a ausência da
> chave e do `companyId` neles (`BYTES-09`). O corpo servido é byte a byte o do
> storage (`BYTES-03`), e o `Content-Type` acompanha o formato real — não é
> `image/jpeg` fixo (`BYTES-02`).

### `CTO-1.9` — a faixa é verificada com a capacidade que o lock travou

Porta acima da capacidade é histórica e **read-only** (decisão de produto, §23 da
especificação). A verificação vive no domínio, dentro da transação, e compara com
a `capacity` que `lockCto` devolveu — não com uma lida antes.

A janela que isso fecha: reduzir 16 → 8 e reservar a porta 12 ao mesmo tempo, as
duas operações lendo 16 e concluindo que 12 está dentro. O teste de corrida
**proíbe** o desfecho híbrido, e a sabotagem que move a leitura para fora da
transação o reproduz.

A ordem continua sendo tenant → CTO → porta → faixa: outro tenant e porta de
outra CTO respondem **404**, nunca o 409 de faixa — que nomeia a posição e a
capacidade, e confirmaria a existência dos recursos.

### `CTO-CONC-01` — a corrida entre estado de porta e redução de capacidade

Encontrada durante a implementação, não relatada depois.

Mudar o estado de uma porta parece isolado — um campo, numa linha — e disputa
com a redução de capacidade, que decide se pode reduzir olhando o estado de
**todas** as portas acima do novo limite:

```text
redução      lê a porta 12 como AVAILABLE
estado       grava RESERVED na porta 12
redução      commita capacity = 8
             → porta reservada ACIMA da capacidade
```

Cada operação respondeu por metade da pergunta e nenhuma respondeu pela caixa —
o mesmo formato do problema que a fila operacional resolveu com `version`
própria mais `FOR UPDATE` (PRD §318).

**Correção:** as duas travam a **CTO** com `FOR UPDATE`, e a leitura da porta
acontece **depois** do lock. O estado lido antes de travar é uma fotografia que
já envelheceu quando se age sobre ela — e é dela que sai o "de → para" da
auditoria, que passaria a mentir.

Depois da redução, marcar como reservada uma posição já fora da capacidade
continua permitido: é linha real, e registrar que ela está danificada é
legítimo. O que não pode é a redução acontecer *apesar* da reserva.

### O teto de capacidade é controle de recurso

O banco garante `capacity > 0`, e sozinho isso aceita `capacity = 1_000_000`:
a criação abre uma transação que insere um milhão de linhas e segura o lock
enquanto isso, no mesmo processo Node que atende todos os tenants. Não é
hipótese exótica — é um campo numérico num formulário, e um zero a mais o
produz sem má intenção. `CTO_MAX_CAPACITY = 256`, validado no zod e no domínio.

### O que NÃO é apagado

Não existe `DELETE` de CTO em rota nenhuma, e `CTO → CTOPort` é `Restrict` no
schema: mesmo um `delete` escrito por engano num caminho futuro esbarra no
banco. Reduzir capacidade **não** apaga porta — as posições acima viram
histórico e apenas saem da faixa ofertável.

**A faixa `1..capacity` é regra de aplicação, e isso é uma consequência
declarada, não uma omissão.** Um CHECK entre `cto_ports.number` e
`ctos.capacity` seria cross-table (exigiria trigger) e contradiria a própria
política, que exige que linhas com `number > capacity` sobrevivam. Por isso
`isPortOfferable` é função exportada e testada diretamente: quando a `CTO-2`
receber um `ctoPortId` num payload, ela precisa decidir na **transação que
escreve**, e não confiar na lista que a tela mostrou.

O blob da foto anterior também não é apagado numa substituição — comportamento
conservador declarado, sem política de remoção. Órfão custa disco; apagar por
suposição custa dado.

### `CTO-1.1` — o teto no banco e a coordenada não-finita

Duas ambiguidades da `CTO-1` fechadas. O registro completo, com a decisão de
migration e o comportamento documentado, está em
`docs/CTO-NETWORK-DISTRIBUTION.md` §20. Aqui fica o que é de segurança.

**O teto de capacidade passou a existir no banco.** Ele vivia só no `zod` e em
`assertCapacity` — duas camadas de aplicação. `ctos_capacity_max_check` é a que
sobrevive a um caminho de escrita novo que esqueça as duas, e a que torna
`CTO_CAPACITY_MAX` um fato da tabela: mudá-lo passa a exigir migration. O
controle é de **recurso**: sem ele, `capacity = 1_000_000` abre uma transação
que insere um milhão de linhas segurando o lock da CTO, no mesmo processo que
atende todos os tenants.

A recusa acontece **antes** de qualquer trabalho proporcional à entrada —
antes da transação e antes do `Array.from({ length: capacity })`. Testado pelas
duas pontas: zero linhas criadas e recusa imediata.

**A validação de coordenada tinha uma lacuna que um teste de faixa não pega.**
Comparação com `NaN` é sempre falsa: `NaN < -90` e `NaN > 90` são os dois
`false`, então verificar `-90..90` **sozinho deixa `NaN` passar**. A checagem
parecia total e não cobria o único valor que não se compara.
`assertCoordinates` passou a exigir finitude **antes** da faixa; o `zod` já
recusava, e esta guarda cobre a chamada direta ao serviço, que é superfície
pública do módulo.

**E há um caso que o servidor não consegue defender**, o que vale registrar
como fronteira e não como defeito:

```text
JSON.stringify(NaN)      → null
JSON.stringify(Infinity) → null
null nos dois campos     → "remova a coordenada", que é legítimo
```

O servidor recebe entrada malformada e remoção deliberada como a **mesma**
mensagem. A defesa é do cliente, antes de o JSON ser montado, e o predicado é
`Number.isFinite` — o único que corresponde ao que `JSON.stringify` descarta.
A primeira versão usava `Number.isNaN`, que fecha `"abc"` e deixa `"Infinity"`
passar; provado por reversão, com o E2E sendo o único teste capaz de alcançar
essa camada.

Nenhum valor inválido vira `null`, e nenhuma coordenada gravada é apagada por
entrada malformada.

## 8.20. `CTO-2.4` — a rede de distribuição pela API do Field

A `CTO-1` fixou que a capability vem antes do perfil; a `CTO-2.2` e a `CTO-2.3`
fixaram que `companyId` sai da sessão e que a obsolescência é obrigatória. Esta
seção registra o que muda quando quem opera não é o ADMIN pela web, e sim o
técnico pelo aparelho.

### O modelo de autorização

`docs/FIELD-API.md` e a **§8.13** continuam valendo inteiros: token opaco preso
ao `MobileDevice`, só `Authorization: Bearer`, nunca cookie e nunca query
string. **Sem `assertSameOrigin`** — Same-Origin defende cookie, e não há
cookie nesta superfície; acrescentar a verificação aqui seria proteção fictícia
para um cliente que não é browser.

Sobre isso, a fase acrescenta quatro condições, e todas são do servidor:

1. a empresa tem `ctoNetworkEnabled` — senão a superfície inteira é `404`;
2. o perfil é `TECHNICIAN` e existe `Technician` — os dois já são condição de
   `authenticateField`;
3. a OS do caminho é da empresa da sessão, está `IN_PROGRESS` e pertence àquele
   técnico;
4. **o cliente do vínculo é o cliente daquela OS.**

A quarta não é uma comparação que alguém precisa lembrar de escrever: não existe
campo `customerId` nos schemas. O cliente é derivado da OS, e o vetor mais barato
— OS legítima do próprio técnico usada para mexer em outro cliente — deixa de ter
onde ser expresso.

### Capability antes de tudo, inclusive da idempotência

Com `ctoNetworkEnabled` desligada a resposta é `NOT_FOUND`, nunca `FORBIDDEN`:
`403` diria *isto existe, você é que não pode*, e a empresa descobriria pela
mensagem de erro que há um módulo que não contratou. A verificação roda antes da
elegibilidade e **antes da reserva de idempotência** — sem isso, uma empresa sem
o módulo gravaria linha em `IdempotencyRecord`, e há teste que afirma zero.

### Posse e estado — quantos portões, e onde

Medido por reversão, não afirmado:

| caminho | posse | `IN_PROGRESS` |
|---|---|---|
| escrita | 2 (`resolveOwnedOrderCustomer`, `loadOwnedServiceOrder` na transação) | 3 (mais o predicado do `claim`) |
| leitura | 1 (`resolveOwnedOrderCustomer`) | 1 |

Removendo a posse só do primeiro portão, a **escrita continuou recusando** e a
leitura caiu. O caminho de leitura é o de gate único, e é ele que `F-A1` e
`FIELD-R13` guardam de forma permanente.

### A autorização vive DENTRO da transação

`ConnectionContext.authorizeWithin` roda como primeira instrução da transação do
domínio, antes de qualquer lock. Fora dela, a OS poderia ser concluída entre a
conferência e a escrita, e o `ServiceOrderEvent` nasceria depois do fechamento —
evento numa OS que o snapshot de conclusão já declarou encerrada.

Ordem de lock resultante: **`ServiceOrder → Customer → CTO`**. Não há ciclo,
porque nada que trave `Customer` pede `ServiceOrder` exclusivo depois: a origem
`WEB` não toca OS.

`ServiceOrder.version` protege a **sessão operacional da visita**; a ocupação da
porta continua protegida pelo lock da CTO e pelas duas uniques parciais. As duas
respondem perguntas diferentes e não se substituem.

### Superfície de dados

O DTO do Field omite, deliberadamente:

* o **ocupante** de qualquer porta que não seja a do cliente da OS — `occupied:
  true` responde a pergunta operacional sem entregar cliente de outro
  atendimento;
* `companyId`, coordenadas da CTO, foto, observações administrativas;
* tudo de PPPoE. A senha tem porta própria, explícita e auditada (§8.9);
* `effectiveState`, que colapsa em `OCCUPIED` e apagaria `DAMAGED` de uma porta
  com cliente dentro.

Recurso de outra empresa responde `404` com **corpo idêntico** ao de um id
inexistente — há teste que compara os dois corpos byte a byte, porque distinguir
"não é seu" de "não existe" é o oráculo de enumeração que o módulo evita.

### Idempotência, e o escopo que inclui a OS

`(empresa, usuário, operação, chave)`, e a impressão digital carrega o
`orderId`. A mesma chave usada em duas OS diferentes é `IDEMPOTENCY_CONFLICT`
(409), não replay — provado por reversão, retirando o `orderId` da impressão
digital.

### Um achado desta revisão, corrigido

Uma string com byte `NUL` atravessava `z.string().min(1)`, chegava ao Postgres e
voltava `22021`; a fronteira do Field traduzia em `INTERNAL`, que é
**retentável** — o aplicativo reenviaria em laço uma requisição impossível.
`fieldResourceId` recusa antes, com `VALIDATION_ERROR`, usando a mesma classe de
caracteres que `clientMutationId` e `installationId` já usam.

**A classe é pré-existente e maior que esta fase**, e isso foi medido:
`serviceOrderEvidence` e `timeEntry` se comportam igual. Fica registrado como
risco `INFO` do codebase — qualquer rota que leve string do cliente para um
`where` do Prisma tem o mesmo desfecho —, e não como regressão da `CTO-2.4`.

### Online-only

`CONNECT`, `DISCONNECT` e `MOVE` não têm fila offline. Nenhum DTO de
sincronização, nenhum job, nenhuma reserva local: duas pessoas reservariam a
mesma porta sem rede, e a reconciliação escolheria um perdedor depois de os dois
terem subido no poste.

---

## 8.21. `RC-1B` — endurecimento de segurança e configuração do Release Candidate

> **Estado: `APPROVED` / `CLOSED` (14/09/2026).** O dono validou em uso real o
> que era visível — upload de foto pelo Field, upload pela web e troca da foto da
> CTO: `PASS`. Publicada no GitHub no mesmo dia, sem tag. Os IDs são os da
> auditoria `RC-1A`. Nenhuma migration, nenhuma dependência, nenhuma
> funcionalidade nova, e o contrato de "Confirmar localização" (`RC-LOC-01`)
> **não foi tocado** aqui — ele é da `RC-1C` (§8.22).

### `RC-STO-01` — o corpo multipart tem teto ANTES de existir na memória

As cinco rotas de upload (evidência web e Field, assinatura web e Field, foto de
CTO) chamavam `request.formData()` e só depois conferiam `file.size`. Àquela
altura o corpo inteiro já estava na memória do processo — um processo só, para
todas as empresas —, e um usuário autenticado derrubava a aplicação com um POST
de alguns gigabytes. Os comentários das rotas diziam o contrário.

`readMultipartWithinLimit` (`src/lib/multipart-limit.ts`) é a porta única agora:

- `Content-Length` com formato inválido é recusado, e o declarado acima do teto
  é recusado **sem ler um byte** do corpo;
- durante a leitura, os bytes são contados e o fluxo é **cancelado** ao passar
  do teto — o que cobre o cabeçalho ausente (transferência em pedaços) e o que
  mente;
- só então o formulário é interpretado, pelo próprio `Response.formData()` do
  runtime. Nenhuma dependência de parser em fluxo.

Isso só é proteção de verdade porque o Next 14 entrega ao route handler o corpo
EM FLUXO: sem middleware, nada o lê antes (`body-streams.js` só bufferiza para
clonar o corpo para um middleware, e o projeto não tem nenhum). O teto do corpo
é o do arquivo mais 64 KiB de moldura do formulário; os tetos de arquivo (8 MB,
2 MB, 8 MB), os códigos (400 / `VALIDATION_ERROR`) e as mensagens continuam os
mesmos, e a autenticação continua vindo antes.

**Requisito de produção, não opcional:** o teto daqui protege a memória do
processo Node; a conexão e os bytes que o cliente continua mandando são do
servidor web à frente. **O proxy reverso precisa de limite de corpo**
(`client_max_body_size` no nginx, ou equivalente) no valor do maior teto ou
abaixo — e é ele que cobre as rotas JSON, que continuam lendo o corpo inteiro
com `request.json()`.

### `RC-LOG-01` — log de erro não carrega dado

`runApi`, `runFieldApi`, `logAudit` (que imprimia o objeto de erro inteiro), a
falha de auditoria da revelação de PPPoE, a atualização de `lastSeenAt` do Field
e os três scripts de worker imprimiam `error.message`. A mensagem do Prisma
repete os argumentos da consulta (nome, documento, o `details` de auditoria), o
Postgres põe o VALOR que recusou e o filesystem põe o caminho absoluto com a
chave de storage.

`logServerError` (`src/lib/safe-log.ts`) imprime uma linha: o tipo do erro, um
código de formato conhecido (Prisma `P####`, errno `E*`) e o contexto que o
chamador escolheu — cujos valores precisam ter cara de id ou código; texto livre
vira `?`. Em desenvolvimento entram os frames da pilha, sem a linha da mensagem.
O log `error` do **próprio Prisma** ficou só em desenvolvimento: todo erro do
motor é lançado ao chamador e registrado ali, com o código. Provado com um
`PrismaClientValidationError` real carregando CPF, um `ENOENT` real com caminho
de storage e uma consulta cujo erro do Postgres contém o valor.

### `RC-SEC-01` — configuração inválida do login derruba a subida

`LOGIN_*` eram lidos com `Number()`: `"abc"` virava `NaN`, e `tentativas >= NaN`
é sempre falso — o limitador de força bruta sumia sem aviso. Agora são lidos em
`validateEnv`: **ausente** usa o padrão (5 · 900 s · 20); **presente e
inválido** (`NaN`, `Infinity`, `"10abc"`, `"1.5"`, `"1e3"`, vazio, zero,
negativo, fora da faixa) lança na subida, nomeando a variável. Faixas:
tentativas por e-mail 1..1000, janela 60..604800 s, tentativas por IP
1..100000. A política do limitador não mudou.

### `RC-OPS-03` — o Mock ERP não existe em produção

`isMockErpEnabled()` (`src/integrations/mock-availability.ts`, `NODE_ENV !==
"production"`, sem variável para religar) é consultado pela **fábrica de
adapters** — em produção `MOCK` não produz adapter (`NOT_SUPPORTED`), então
nenhum dado inventado sai por sincronização, busca de cliente, diagnóstico,
teste de conexão ou troca de ERP ativo —, pelo domínio da sincronização (com
mensagem própria) e pelas telas: o botão e as instruções somem de `/ordens` e
`/clientes`, e `/integracoes` tira o Mock das duas listas e mostra a linha
`MOCK` como "Nenhum ERP configurado". **A linha `MOCK` continua existindo**: é o
único caminho pelo qual uma empresa nova ganha uma integração antes de escolher
o ERP de verdade, e trocar isso seria fluxo novo.

### `RC-OPS-04` — o seed recusa em produção

`prisma/seed.ts` cria — e reativa — usuários ADMIN com senha de demonstração no
código-fonte. `assertSeedAllowed` recusa com `NODE_ENV=production`, antes de
qualquer consulta, sem modo de forçar; a senha não é mais impressa. **Limite
declarado:** depende de `NODE_ENV=production` estar no ambiente do comando —
uma trava por nome de banco quebraria o `.env.example`, que chama o banco de
desenvolvimento de `alfaos`. O runbook de produção precisa proibir `db seed` e
`migrate reset` contra a base real.

### `RC-DB-02` — os índices únicos parciais têm guarda

Três invariantes vivem só no SQL das migrations, porque o DSL do Prisma não
expressa `WHERE`: um template de checklist padrão por empresa, um cliente ativo
por porta e uma porta ativa por cliente. `schema-partial-indexes.test.ts`
confere no banco migrado que cada índice existe, é `UNIQUE`, cobre a coluna
certa e mantém o predicado, e que nenhuma migration posterior o derruba — e
prova que falha quando o índice some, vira índice total ou muda de coluna.

### `RC-TEN-01` / `RC-DB-01` — o vetor da FK simples

`assignTechnician` lia o técnico ANTERIOR por id só, para o evento
`TECHNICIAN_CHANGED`: uma OS da A apontando para um técnico da B — o schema
permite — copiaria nome e id dele para a timeline da A. Reproduzido com linha
corrompida; nenhum escritor da API a produz, então é defesa em profundidade. O
filtro agora leva `companyId`. Testes adversariais novos, com controle
positivo: OS na A com cliente da B, template da A com tipo da B, e confirmação
de localização por técnico da mesma empresa que não é o dono e por técnico da B
com o id da OS da A. **Continua fora (P3):** os `include` de relação por FK no
detalhe da OS e na visão da fila leem o registro relacionado sem conferir o
tenant dele — só expõem dado com linha corrompida, que nenhum caminho da API
produz.

### `RC-LOC-06` — localização × conclusão

Os comandos de localização conferiam `IN_PROGRESS` com leitura simples; entre
ela e o commit, a OS podia ser concluída, e ponto, histórico e evento eram
gravados mesmo assim. Reproduzido sem `sleep`
(`location-completion-race.test.ts`). O status agora é relido com `FOR SHARE`
na mesma transação: a conclusão espera o commit, ou o comando espera a
conclusão e recebe o mesmo 409 de antes. Sem CAS na `version` da OS — a
localização continua com a própria —, e a ordem de trava (OS antes de cliente)
é a das mutações-filhas.

### `RC-STO-02` / `RC-TEST-01` — infraestrutura de teste

Vitest e E2E não escrevem mais no `.storage` do projeto: cada arquivo de teste
tem um `STORAGE_ROOT` temporário próprio (`setup.ts`), e o Playwright usa um
diretório temporário fixo, recriado no `globalSetup` e apagado no
`globalTeardown`, que recusa qualquer raiz dentro do `.storage`. O resíduo
antigo **não foi apagado**: o dry-run contou 1.886 diretórios, dos quais 1.884
são de empresas que não existem no banco de desenvolvimento (2.032 arquivos,
1,5 MB). As páginas administrativas ganharam teste de redirecionamento do
`TECHNICIAN`, e o download de assinatura, teste de negação entre empresas e
entre técnicos.

## 8.22. `RC-1C` — o contrato de localização do cliente

> **Estado: `APPROVED` / `CLOSED` (15/09/2026).** Validação física final do dono
> `PASS` (`docs/TECHNICIAN-EXECUTION.md` §13.8, onde o contrato final do GPS está
> congelado). Sem tag; publicação em `origin/main` autorizada pelo dono no
> fechamento, só fast-forward. Contrato aprovado pelo dono (PRD §172,
> `DECISION UPDATED`); o técnico em `docs/TECHNICIAN-EXECUTION.md` §13. Nenhuma
> migration, nenhuma dependência.

### `RC-LOC-01` — confirmar exige GPS e distância, e quem decide é o servidor

"Confirmar localização" gravava `verified = true` sem condição: um técnico a
~2,3 km — ou com o GPS negado — transformava um ponto importado em verificado,
e o mapa e a operação passavam a confiar nele. Agora a posição do aparelho é
obrigatória, a distância é calculada **no servidor** e o limite é 100 m,
inclusivo, comparado no metro inteiro que o técnico vê. Acima dele, `400` e nada
é gravado — nem `verified`, nem trilha, nem evento, nem auditoria.

- **A distância nunca vem do cliente.** `distanceMeters` no corpo é recusado pelo
  `.strict()`, e o domínio só lê a posição.
- **A regra vem antes da escrita**, dentro da mesma transação: não existe um
  `verified` gravado para depois ser desfeito.
- **A porta da OS vem antes do GPS.** Técnico de outra empresa — inclusive pelo
  vetor da DQ-7.1, OS da A apontando técnico da B — e técnico da mesma empresa
  que não é o dono recebem o `404` genérico da OS; o corpo não conta que existe
  cliente ou ponto do outro lado.
- **A posição do aparelho fica no servidor.** Ela é gravada no `metadata` do
  evento `LOCATION_CONFIRMED`, e a leitura da OS (`getCompanyServiceOrder`, que
  serve `GET /api/service-orders/:id` e a resposta da conclusão a ADMIN,
  DISPATCHER e ao técnico dono) a remove da saída. Achado na revisão da própria
  fase, antes dos gates: sem a poda, a posição do técnico naquele instante
  viajaria em toda leitura da OS. É o desenho do check-in, que guarda a
  coordenada na linha própria e deixa no evento só distância e precisão.

### Correção: coordenada só pelo GPS do aparelho

Uma coordenada DIGITADA (`source: MANUAL`) movia o ponto e o marcava verificado
sem ninguém ter medido nada — o mesmo defeito, por outra porta. Recusada (`400`).
Meia coordenada também: antes ela era descartada em silêncio e o endereço da
mesma requisição era aplicado. O aplicativo nunca enviou nenhuma das duas.

### Quem escreve localização de cliente

Só o técnico dono da OS em atendimento, pelas duas rotas do Field. `DISPATCHER` e
`ADMIN` não têm porta de escrita — nem pelo Field (o token é de `TECHNICIAN`),
nem pela web; um teste estrutural exige que só essas duas rotas chamem os
escritores. O cartão "Localização do cliente" (`RC-LOC-03`) é **somente
leitura**, só para o `ADMIN` — a mesma fronteira da camada de clientes do mapa
(PRD §376) —, lê a autoridade e confere o tenant de novo nas relações de
verificador e de OS, que são FK simples.

### O que ficou declarado, não fechado

- ~~**Precisão não bloqueia:** não há limite de precisão aprovado.~~ **Fechado
  pela RC-1C-HOTFIX** (§8.22.1): precisão ≤ 50 m, exigida no servidor.
- **A regra é sobre a posição que o aparelho declara.** Um aparelho hostil pode
  mentir a coordenada, e o servidor não tem como provar onde o técnico está. O
  que o contrato garante é que a confirmação passou pela regra, que a distância
  declarada fica registrada e que burlá-la exige mandar uma posição falsa de
  propósito — não basta negar o GPS.

### 8.22.1. `RC-1C-HOTFIX` — precisão do GPS ≤ 50 m, no aplicativo e no servidor

> **Estado: `APPROVED` / `CLOSED`** (15/09/2026), com as correções
> `RC-1C-HOTFIX-2` (frescor) e `RC-1C-HOTFIX-3` (precisão lida no Android)
> descritas abaixo. Decisão do dono; causa raiz e contrato da captura em
> `docs/TECHNICIAN-EXECUTION.md` §13.5 a §13.8. Nenhuma migration, nenhuma
> dependência, nenhuma permissão nova.

A validação física gravou um ponto a mais de 1 km do lugar: o aplicativo só
tinha a permissão de localização aproximada, o Android entregou uma posição com
2000 m de precisão, e nada a recusava — o servidor aceitava qualquer precisão
até o teto de sanidade de 100 km.

- **O servidor recusa por conta própria.** Confirmar e corrigir **com**
  coordenada exigem `observedAccuracyMeters`/`accuracyMeters` presente, finita,
  maior que zero e ≤ `LOCATION_GPS_MAX_ACCURACY_M` (50), sobre o valor bruto
  (`requireGpsAccuracy`). Um APK anterior à hotfix — ou um cliente sabotado com
  coordenada perfeita e precisão 1500 m — recebe `400 VALIDATION_ERROR`, e nada
  é gravado. Provado pela rota e pelo servidor real (E2E).
- **Zero é recusa**: é o valor que o plugin devolve quando a plataforma não
  mediu nada.
- **A ordem de confirmar não mudou**: a porta da OS continua antes de qualquer
  pergunta de GPS — a precisão não vira oráculo de existência para quem não é o
  dono. Na correção, a validação da precisão fica ao lado da validação da
  coordenada, antes da transação, como já era a da coordenada: depende só do
  corpo e não revela nada sobre a OS.
- **Correção com GPS ruim não vira correção de endereço**: o corpo inteiro é
  recusado. Correção só de endereço (sem coordenada) não exige precisão.
- **Recência não é arbitrada pelo servidor**: a API não recebe o instante da
  leitura, e a hotfix não o acrescentou. A leitura de até 10 s é garantida pela
  captura do aplicativo; o servidor arbitra coordenada, precisão, distância, posse
  e tenant.
- **Privacidade**: nenhum log do aplicativo leva coordenada (teste estrutural);
  a captura registra só o motivo e a melhor precisão. O GPS é desligado ao fim de
  cada captura; nada mede em segundo plano, e `ACCESS_BACKGROUND_LOCATION`
  continua fora do manifesto.
- **RC-1C-HOTFIX-2 — o frescor é a idade da leitura** (≤ 10 s; no futuro, até
  ~2 s), não "ter nascido depois de a captura abrir" — `docs/TECHNICIAN-EXECUTION.md`
  §13.6. `getLastKnownPosition` continua proibida em `lib/` inteiro. O gancho de
  diagnóstico escreve no `logcat` **só em build de depuração** (`kDebugMode`,
  e `Log` já é `assert`-only), uma linha por leitura com veredito, idade, instante
  relativo à abertura e precisão — **nunca coordenada**, e um teste estrutural
  varre `Log`, `debugPrint` e `print` dos arquivos de localização, e exige que o
  tipo do diagnóstico não tenha campo de coordenada.
- **RC-1C-HOTFIX-3 — a precisão é a MEDIDA, não a bandeira** —
  `docs/TECHNICIAN-EXECUTION.md` §13.7. Com `geolocator_android` 4.6.2,
  `Position.hasAccuracy` chega `false` em toda leitura do Android (o plugin não
  repassa o campo que a interface 4.3.0 criou), e a captura recusava todas. Ela
  lê agora `measuredAccuracyMeters`: o valor que a plataforma afirma ter medido,
  ou, sem a afirmação, só um número positivo e finito — o `0.0` de "não mediu"
  continua sendo "sem precisão". Nada é presumido e nenhuma fonte alternativa
  entrou; o servidor continua exigindo precisão presente, positiva e ≤ 50 m. A
  linha crua `raw_position` (tipo, `hasAccuracy`, `accuracy` bruta, idade) segue
  as mesmas regras do gancho acima: só em build de depuração, nunca coordenada,
  e o teste estrutural cobre também as classes que a montam.

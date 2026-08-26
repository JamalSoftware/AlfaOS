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

O teto é consumido **depois** da autorização, para que sondagem anônima ou
cross-tenant não consuma cota de ninguém.

**Limitação conhecida:** o estado é em memória do processo. Com mais de uma
instância, o teto efetivo é multiplicado. Aceitável hoje porque o alvo é
acidente (loop de UI, clique repetido) e o AlfaOS roda em instância única;
se a implantação virar multi-instância, o limite precisa migrar para
armazenamento compartilhado antes de ser tratado como controle.

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

## 8.9. AlfaOS Field — superfície móvel (ESPECIFICAÇÃO, não implementado)

> **Nada desta seção existe em código.** É o contrato de segurança que a trilha
> Field precisa cumprir quando for autorizada — PRD Parte V, §150–§195. Está
> aqui, e não só no PRD, porque cada item abaixo é uma decisão que fica cara de
> reverter depois que o aplicativo estiver em campo.

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

## 9. Configuração de produção

1. Gere um `AUTH_SECRET` forte: `openssl rand -base64 48`.
2. Use PostgreSQL gerenciado com TLS e credenciais fortes.
3. Sirva por HTTPS (HSTS é emitido em produção).
4. Aplique as migrations: `npx prisma migrate deploy`.

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

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

## 9. Configuração de produção

1. Gere um `AUTH_SECRET` forte: `openssl rand -base64 48`.
2. Use PostgreSQL gerenciado com TLS e credenciais fortes.
3. Sirva por HTTPS (HSTS é emitido em produção).
4. Aplique as migrations: `npx prisma migrate deploy`.

## 10. Melhorias futuras rastreadas

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

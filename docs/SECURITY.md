# Segurança — AlfaOS (v0.2-service-orders)

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
- **Global**: `LOGIN_MAX_FAILED_ATTEMPTS_GLOBAL` (padrão 200) falhas na mesma
  janela, somando todos os e-mails e todos os IPs → `429` (ver 2.2).
- Nenhum bloqueio é permanente; a janela expira sozinha.
- Os três tetos são avaliados em `isLoginBlocked`, chamado **antes** do
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

### 2.2. Teto global de falhas (DoS anônimo por bcrypt)

**Variável de ambiente: `LOGIN_MAX_FAILED_ATTEMPTS_GLOBAL`** (inteiro, padrão
`200`) — total de falhas de login recentes, **somando todos os e-mails e todos
os IPs**, dentro de `LOGIN_WINDOW_SECONDS`.

**O ataque que ele fecha.** Para não vazar a existência de contas por timing, o
login roda `bcrypt.compare` **sempre**, inclusive contra o hash dummy quando o
e-mail não existe (ver seção 2). A biblioteca usada é `bcryptjs` — JS puro, que
**bloqueia o event loop** (usa `setImmediate`, não a threadpool do libuv);
custo 12 gasta ~350ms de CPU síncrona por comparação. Um atacante anônimo que
mande `POST /api/auth/login` em loop **com um e-mail aleatório novo a cada
requisição** escapa dos dois limites anteriores:

- o contador **por e-mail** fica sempre em 0 (e-mail inédito a cada tentativa);
- o contador **por IP** não é aplicado quando `getClientIp` devolve
  `trusted: false` — o que é o caso **por padrão** em `next start`
  self-hosted sem `TRUSTED_PROXY_HOPS`, já que o App Router do Next.js 14 não
  expõe o IP da conexão (`NextRequest.ip` fica `undefined`).

Com ~3 req/s isso satura o event loop do processo inteiro e derruba a resposta
de **todos os tenants**, não só do alvo. O teto global é o único contador que
esse flood não consegue driblar: ele não depende de conhecer e-mails válidos
nem de haver um IP confiável.

**Por que 200.** Uma ordem de grandeza acima do limite por IP (20) e duas acima
do limite por e-mail (5). Em números: 200 falhas em 900s é ~0,22 falha/s
sustentada; como cada e-mail só contribui com 5 falhas antes de ser bloqueado
por conta própria, chegar a 200 exige ao menos 40 e-mails distintos falhando na
mesma janela de 15 minutos — muito acima do que um deployment multi-tenant
normal produz, e bem abaixo da taxa que satura uma CPU. Um flood a 3 req/s
atinge o teto em ~67s e é cortado a partir daí.

**Trade-off assumido (importante).** Diferente dos outros dois, este teto é
deliberadamente um **interruptor global**: enquanto está estourado, todo login
recebe `429`, inclusive o de usuários legítimos com senha correta. A seção 2.1
evita exatamente esse efeito para o balde de IP não diferenciado; aqui ele é
aceito porque (a) o valor é alto o bastante para que atingi-lo signifique
ataque em curso, não uso normal; (b) a alternativa é o event loop saturado, em
que *nenhum* request (login ou não) é atendido — degradação pior; (c) o
bloqueio é temporário e se dissolve sozinho quando a janela desliza; (d) nenhum
conta é travada nem exige intervenção manual. Operadores de deployments muito
grandes devem elevar o valor via env var.

**Custo do contador.** É um `COUNT` sem filtro de e-mail/ip sobre
`login_attempts`. A tabela não cresce sob flood: requisições bloqueadas
retornam `429` **sem** gravar `LoginAttempt`, então o número de linhas na
janela fica limitado ao próprio teto (~200), além da limpeza oportunista que
apaga tudo com mais de duas janelas. Por isso não foi criado índice novo.

**Não foi trocada a biblioteca de hash.** Migrar `bcryptjs` para o binding
nativo (que usa threadpool) ou para argon2 invalidaria os hashes já gravados no
banco e está fora do escopo desta correção — o freio aqui é sobre **taxa de
requisição**, não sobre o custo do hash. Fica registrado na seção 10.

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
- **Atribuição restrita**: só aceita técnico **ativo** da mesma empresa
  (inativo → `400`; outra empresa → `404`). Vincular usuário que já é técnico
  → `409`.
- **Otimistic locking**: atribuição usa `updateMany({ id, updatedAt })`; se
  outro request alterou a OS primeiro → `409` "modificada por outra
  requisição". Evita sobrescrita silenciosa em escritas concorrentes.
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
  fila) — hoje o custo síncrono é contido apenas pelo teto global da seção 2.2.
  Exige rehash progressivo dos hashes existentes.
- Fluxo de recuperação de administrador (CLI/console de suporte). Hoje o
  travamento é apenas **prevenido** (seção 12); não existe caminho de
  recuperação se uma empresa ficar sem ADMIN ativo por outro meio.

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

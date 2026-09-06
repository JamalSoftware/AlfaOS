# Integrações ERP e Diagnóstico do Cliente — AlfaOS

Como o AlfaOS fala com sistemas externos e como o diagnóstico de conectividade
do cliente chega até a tela. Complementa `docs/ARCHITECTURE.md` (camadas) e
`docs/SERVICE-ORDERS.md` (sync de OS).

**Quatro partes, com estados diferentes.** As seções **1 a 12** descrevem a
integração ReceitaNet, em código desde a v0.7.2. As **13 a 27** são o plano da
plataforma de ERPs plugáveis (`ERP-0R`). A **§28** registra o que a **`ERP-1`
entregou** — troca explícita do ERP ativo e preservação da credencial anterior.
A **§29** registra a **`SGP-1`**: o provider SGP autentica, tem sonda de conexão
e é ativável.

O que continua sendo só plano são as **capabilities de negócio do SGP** — busca
de cliente, contratos, financeiro e OS. O `SgpAdapter` implementa **apenas**
`testConnection`. Inventário do provider em `docs/ERP-SGP.md`.

## 1. Estado da integração ReceitaNet

Três estados diferentes, deliberadamente separados. Confundi-los foi o erro que
esta seção já cometeu uma vez.

### CALLCENTER READ-ONLY — IMPLEMENTADO (v0.6)

Contra o OpenAPI oficial da CallCenter (3.0.3, `info.version` 1.0.3,
https://www.receitanet.net/api/callcenter/):

| Capacidade | Endpoint | Situação |
| --- | --- | --- |
| Disponibilidade da API | `GET /ping` | IMPLEMENTADO |
| Validação da credencial | `POST /v1/clientes` (leitura de sonda) | IMPLEMENTADO |
| Busca por nome | `POST /v1/clientes` | IMPLEMENTADO |
| Busca por CPF/CNPJ | `POST /v1/clientes` | IMPLEMENTADO |
| Busca por telefone | `POST /v1/clientes` | IMPLEMENTADO |
| Detalhe do cliente | `POST /v1/cliente` | IMPLEMENTADO |
| Endereço, bairro, cidade, UF, CEP | `POST /v1/cliente` | IMPLEMENTADO |
| Plano | `POST /v1/cliente` | IMPLEMENTADO |
| Tecnologia (código cru) | `POST /v1/cliente` | IMPLEMENTADO |
| Situação do contrato | `POST /v1/cliente` | IMPLEMENTADO |
| Servidor em manutenção | `POST /v1/cliente` | IMPLEMENTADO |
| Conectividade ONLINE/OFFLINE | `POST /v1/cliente/verificar-acesso` | IMPLEMENTADO |

**Tudo read-only.** Nenhuma operação mutante foi implementada, e isso é
escolha, não pendência — ver a lista de recusados abaixo.

**Transporte.** `ReceitanetCallCenterClient`
(`src/integrations/receitanet/CallCenterClient.ts`) concentra base URL, token,
encoding, timeout, request, parse e normalização de erro. Nenhum `fetch` fora
dele.

- Corpo: `application/x-www-form-urlencoded`. O contrato aceita apenas isso e
  `multipart/form-data` — **JSON não está no contrato** e não é usado.
- Token: header HTTP `token`. **Nunca em query string** — uma URL entra em log
  de servidor, proxy, histórico e `Referer`. O contrato menciona um campo
  `token` no corpo como compatibilidade legada; não é usado.
- `fetch` é injetável, e é o que permite exercitar 401, 404, 500, timeout, JSON
  inválido e payload incompleto sem tocar a rede.

### Identidade: um único identificador

O CallCenter expõe **apenas** `idCliente`, que o próprio OpenAPI descreve como
*"ID do cliente/contrato no ReceitaNet"*. O schema **não possui `contratoId`**.

É esse valor, e somente ele, que vai para `Customer.externalId` sob
`externalProvider = RECEITANET`.

> **Atenção para quando a URA entrar.** Lá o schema `Cliente` devolve
> `idCliente` **e** `contratoId` como campos distintos. Antes de misturar as
> duas APIs é obrigatório confirmar com o suporte se são o mesmo número —
> assumir que sim vincularia atendimentos ao cliente errado.

### DOCUMENTADO, NÃO IMPLEMENTADO

Existe no contrato e foi deliberadamente deixado de fora desta etapa:

| Capacidade | API | Por quê |
| --- | --- | --- |
| Reiniciar/ressincronizar acesso | CallCenter | operação mutante |
| Liberação em confiança | CallCenter, URA, Chatbot, Central | operação mutante e financeira |
| Envio de boleto | CallCenter, URA, Chatbot | operação mutante |
| Abrir chamado | CallCenter, URA, Chatbot, Central | operação mutante |
| Gravação / finalizar chamado | CallCenter, URA | operação mutante; exige `urlgravacao` |
| Listar chamados do cliente | CallCenter, URA, Chatbot, Central | sem uso no fluxo atual |
| Faturas / débitos | CallCenter, URA, Chatbot, Central | fora do escopo |
| URA · Central do Assinante | — | nenhuma linha de código |

### CHATBOT — IMPLEMENTADO (v0.7.2)

Capability independente da CallCenter, com credencial própria por empresa.
Homologada contra a API real, em cliente real — ver
`docs/RECEITANET-HOMOLOGATION.md`.

| Capacidade | Situação |
| --- | --- |
| Validação da credencial (`/empresa`) | IMPLEMENTADO |
| Enriquecimento cadastral do cliente | IMPLEMENTADO |
| Telefones, e-mail | IMPLEMENTADO |
| Endereço com número e referência | IMPLEMENTADO |
| Coordenadas | IMPLEMENTADO |
| PPPoE usuário e senha real | IMPLEMENTADO |
| `idContrato` → `Customer.externalContractId` | IMPLEMENTADO |
| Planos, servidor, contexto de conexão | Leitura ao vivo, **não persistido** |

**Read-only.** Nenhuma operação mutante do Chatbot foi implementada.

**Sem fallback entre capabilities.** CHATBOT não cai para CALLCENTER e o
contrário também não: hosts, autenticação e schemas são diferentes, e um
fallback silencioso apresentaria dado de uma API como se fosse da outra.

### NÃO EXISTE EM NENHUMA API

> **Corrigido em 2026-08-25.** Este bloco afirmava que nenhuma API expunha
> número do endereço, telefone, coordenadas ou PPPoE. Isso valia para as quatro
> APIs **lidas em spec**; contra a API real, a **Chatbot entrega os quatro**. A
> lacuna era de leitura, não do provider.

Continua sem existir **em nenhuma API do ReceitaNet**: **ONU**, potência óptica,
MAC de equipamento de rede, OLT, **listagem de OS por empresa** (confirmado pelo
suporte — `docs/PRD.md` §141), delta sync e webhook.

> **Qualificado em 2026-09-03.** Este parágrafo dizia "em nenhuma API", sem
> nomear provider, e virou afirmação sobre o mundo quando era afirmação sobre um
> fornecedor. O levantamento do SGP (`docs/ERP-SGP.md` §5) encontrou endpoints
> documentados de ONU, OLT, PON, CPE e **listagem global de OS**. A limitação é
> do ReceitaNet, não uma propriedade dos ERPs.

Consequência prática: o AlfaOS **não preenche** esses campos a partir do ERP e
não os inventa.

### Lacuna conhecida do CallCenter

A URA documenta responder *"offline com success false e HTTP 200"* quando ela
própria não consegue falar com o servidor de acesso. **O CallCenter não tem
esse campo** e não sinaliza esse caso: uma falha interna dele entre a API e o
servidor de acesso chegaria aqui indistinguível de um OFFLINE legítimo.

Não há como resolver isso do nosso lado sem inventar sinal. Está na lista de
perguntas ao suporte, junto com a tabela de valores de `tecnologia` — que o
contrato declara como inteiro sem documentar o significado, motivo pelo qual o
AlfaOS grava e exibe o **código cru** em vez de traduzir.

### Credenciais

`ERPCredentialService` (`src/lib/erp-credentials.ts`) é o único caminho de
escrita e leitura. `resolveCompanyAdapter` (`src/lib/erp-adapter.ts`) é o único
lugar que obtém o token e o entrega pronto ao adapter — nenhum adapter lê
ciphertext, toca o Prisma ou sabe como o segredo é armazenado.

O token existe apenas em memória do servidor. Nunca é logado, nunca entra em
`AuditLog`, nunca aparece em mensagem de erro, nunca vai para a URL e nunca
volta ao frontend.

Cada credencial é **vinculada criptograficamente** a `(companyId, provider)`
via AAD do AES-GCM. Detalhe em `docs/SECURITY.md` §8.4.

> **Corrigido na `ERP-1`.** Este parágrafo afirmava que trocar o provider
> **apagava** a credencial, "explicitamente na troca". Era verdade, e era o
> defeito: o segredo do provider anterior era destruído sem ação explícita, o
> que eliminava o rollback operacional. Hoje a credencial **permanece**, cifrada
> e ociosa — o AAD já a mantém isolada, e ela simplesmente não é consultada
> enquanto aquele provider não for o ativo. Ver §18 e §28.4.

**Credenciais por API — IMPLEMENTADO na v0.7.1.** A resolução é
`(companyId, provider, credentialKind)`, com `credentialKind ∈ {CALLCENTER,
CHATBOT}`. Configurar, trocar ou remover uma **não** remove, sobrescreve nem
invalida a outra.

O AAD é **versionado por linha**: `v1` = `(companyId, provider)` para as linhas
migradas, `v2` = `(companyId, provider, kind)` para as novas. A versão vem
sempre da própria linha — nunca de request, query ou browser. Detalhe em
`docs/SECURITY.md` §8.7.

### Alcançável ≠ credencial validada

`/ping` tem `security: []` no contrato: **ele não autentica**. Um ping
bem-sucedido prova que o serviço está de pé e nada sobre o token da empresa.

Por isso `testConnection()` responde às duas perguntas separadamente, e
`ERPConnectionResult` carrega `reachable` e `credentialValidated` como campos
distintos. Quando a API responde, o adapter faz **uma** leitura autenticada,
documentada e read-only (`POST /v1/clientes` com um filtro de CPF que não casa)
só para ver se o token é aceito; o conteúdo da resposta é descartado.

A tela nunca diz "ReceitaNet conectado" porque o ping passou.

## 2. Arquitetura

```text
Customer / ServiceOrder
        ↓
ERPIntegrationContract  (identidade, testConnection, listServiceOrders)
        +
ERPDiagnosticsCapability  (fetchCustomerConnectivity)
        ↓
MockERPAdapter | ReceitanetAdapter
        ↓
resultado normalizado
        ↓
CustomerDiagnosticSnapshot
        ↓
UI
```

Diagnóstico ficou **fora** do `ERPIntegrationContract` de propósito. O contrato
base é o que todo adapter precisa ter; diagnóstico é algo que um provider pode
ou não oferecer. Fundir os dois obrigaria todo adapter a stubar o método, ou
transformaria a interface base num balaio de métodos opcionais não
relacionados. Separado, `supportsDiagnostics()` responde honestamente.

## 3. Modelo normalizado

```text
ConnectivityStatus: ONLINE | OFFLINE | UNKNOWN
```

`UNKNOWN` é resposta de primeira classe, não código de falha.

**Regra crítica: erro ≠ OFFLINE.** Timeout, 401, 403, 404, 429, 500, payload
inválido, provider sem capability, integração desabilitada — nada disso vira
`OFFLINE`. Todos são falhas *da integração*, não afirmações sobre o cliente.
Colapsar isso mandaria um técnico a campo por causa de um token expirado.

Sem evidência positiva para classificar → `UNKNOWN`.

## 4. Snapshot

`CustomerDiagnosticSnapshot`, chaveado por
`(companyId, customerId, externalProvider)`. Guarda **apenas campos
normalizados** — nunca o payload bruto do provider.

- `observedAt`: quando **nós** observamos.
- `sourceUpdatedAt`: quando o **provider** diz que o estado mudou, quando ele
  informa. São separados porque só o segundo permite ordenar duas respostas
  concorrentes, e nem todo provider fornece.

**Uma falha nunca sobrescreve um snapshot válido.** Um refresh que falha
devolve `ok: false` com o snapshot anterior intacto — é isso que permite à tela
dizer "não foi possível atualizar; último estado conhecido: Online às 08:42".

**Proteção contra escrita obsoleta:** se ambos os `sourceUpdatedAt` existirem e
o novo for mais antigo que o gravado, a escrita é descartada. Quando o provider
não fornece o campo, não há por onde ordenar e last-write-wins é honesto —
inventar ordenação a partir do nosso tempo de recebimento seria fabricar
precisão que o provider não deu.

## 5. Modelo de erros

`IntegrationError` com código fechado: `AUTHENTICATION_FAILED`,
`UPSTREAM_UNAVAILABLE`, `RATE_LIMITED`, `NOT_SUPPORTED`, `INVALID_RESPONSE`,
`CUSTOMER_NOT_FOUND`, `TIMEOUT`.

Status HTTP do provider **não** circula pelo domínio — cada adapter traduz na
própria fronteira. `userMessage` é a única string renderizável e nunca contém
URL, header, token ou stack.

A rota de refresh responde **200 mesmo quando o provider falha**: a requisição
ao AlfaOS teve sucesso, e o corpo carrega o motivo e o snapshot preservado. Um
5xx faria o AlfaOS reportar falha própria pela indisponibilidade alheia.

## 6. Timeout

`DIAGNOSTIC_TIMEOUT_MS = 8000`, aplicado no **call site**
(`withIntegrationTimeout`), não dentro de cada adapter — assim a garantia é
estrutural e um adapter futuro não consegue esquecer. Também pega adapter que
trava sem tocar a rede.

Não há SLA ReceitaNet documentado do qual derivar o número; 8s é folgado para
um round trip saudável e curto o bastante para não segurar um handler. **Sem
retry automático** nesta versão.

## 7. Autorização

Diagnóstico é escopado por **Ordem de Serviço**, não por id de cliente.

`GET|POST /api/service-orders/:id/diagnostic`

A OS é a superfície de autorização que o AlfaOS já prova: staff da empresa lê,
e técnico lê só a própria. Uma rota `/customers/:id/diagnostic` daria a
qualquer técnico autenticado um oráculo sobre toda a base de clientes da
empresa — sondar ids, comparar 200 e 404, enumerar. O `customerId` vem da OS,
server-side, nunca do request.

Não-dono e cross-tenant recebem **404**, nunca 403, mantendo a convenção
anti-enumeração do resto do sistema.

## 8. Provider identity

Preservada a regra existente: `id interno + companyId + externalProvider +
externalId`. O mesmo `externalId` em empresas diferentes são entidades
distintas, e o snapshot de uma não é alcançável pela outra.

O provider vem da integração da própria empresa (`ERPIntegration.provider`,
apenas se `enabled`), nunca do request. Empresa sem integração habilitada
recebe `NOT_SUPPORTED` — **não** há fallback silencioso para o mock, porque
rotular dado de mock como se fosse de ERP real é exatamente a confusão a
evitar.

## 9. MockERP

Cenários determinísticos por convenção de sufixo no `externalId`, para que
testes criem quantos clientes distintos precisarem sem colidir na unique
constraint:

| Sufixo / id | Comportamento |
| --- | --- |
| `-ONLINE`, `MOCK-CUST-1` | `ONLINE` com `sourceUpdatedAt` |
| `-OFFLINE`, `MOCK-CUST-2` | `OFFLINE` com `sourceUpdatedAt` |
| `MOCK-CUST-3` | `UNKNOWN` |
| `-FAIL` | lança `UPSTREAM_UNAVAILABLE` |
| `-INVALID` | lança `INVALID_RESPONSE` |
| `-TIMEOUT` | nunca resolve (exercita o deadline) |
| qualquer outro | `UNKNOWN` |

## 10. Invariante operacional

**Falha de ERP não pode derrubar a operação.** Abrir OS, iniciar atendimento,
salvar execução, anexar evidência e finalizar continuam funcionando com o
provider indisponível. A leitura do diagnóstico na página é local (só lê
snapshot) e nunca faz chamada externa no caminho de renderização.

## 11. Auditoria e observabilidade

`CUSTOMER_DIAGNOSTIC.REFRESHED` é registrado apenas quando um refresh manual
produz observação nova. Leituras que só renderizam snapshot existente **não**
são auditadas — auditar cada visualização enterraria os eventos que importam.

O log carrega provider, empresa, cliente e resultado. Nunca documento,
telefone, payload, token ou header.

## 12. Fora do escopo desta versão

Chamadas reais ReceitaNet, busca administrativa de cliente por
nome/CPF/telefone contra o ERP, dados de PPPoE/ONU/óptico, cache, circuit
breaker, retry, rate limit do provider, e qualquer escrita no sistema externo.
v0.5 é read-only.

---

# PLATAFORMA DE ERPs PLUGÁVEIS — PLANEJAMENTO `ERP-0R`

Tudo daqui para baixo é **plano**. Nenhuma linha existe em código: não há
`ERPProvider.SGP`, não há `SgpAdapter`, não há migration. O inventário do
provider está em `docs/ERP-SGP.md`.

Motivação: a Alfa Telecom está migrando do ReceitaNet para o **SGP**. Atender só
a esse caso seria trocar um acoplamento por outro — o objetivo é a **camada**,
com o SGP como o primeiro provider a exercitá-la de verdade.

> **Correção de rota registrada.** Uma versão anterior deste plano (`ERP-0`) e a
> implementação que a seguiu (`ERP-1`) partiam de **múltiplos ERPs ativos
> simultaneamente por empresa**, com autoridade por capability e provider
> principal. Essa premissa foi **descartada como decisão de produto**, e os
> commits correspondentes saíram da `main` (ficaram na branch local
> `backup/erp-multiprovider-discarded`). O que segue substitui aquele plano.

## 13. A regra

```text
Company
   └── ERPIntegration 0..1
          └── provider   (RECEITANET | SGP | futuros)
```

**Cada empresa tem ZERO OU UM ERP ativo.** O AlfaOS suporta vários *tipos* de
ERP globalmente; cada empresa escolhe **um** e usa aquele.

Não existe provider por capability. Não existe dual-provider operacional. Não
existe principal + secundário.

A terminologia acompanha: **plataforma de ERPs plugáveis**, não
"multi-provider por empresa". A primeira descreve o produto; a segunda descrevia
uma arquitetura que foi recusada.

### Por que a regra simples é a certa

O ganho que o modelo descartado prometia era migração gradual por capability.
O preço era alto e agora está medido, porque chegou a existir em código:

* **duas autoridades passam a ser possíveis**, e impedi-las exige uma unique
  nova, uma tabela nova e uma camada de resolução nova;
* toda pergunta ao ERP deixa de ser *"qual o ERP da empresa?"* e vira *"quem
  responde por esta capability?"* — em cada call site;
* a tela deixa de mostrar um estado e passa a mostrar uma matriz;
* e a operação ganha um modo de falha novo: **acreditar que está no provedor A
  enquanto uma capability ainda responde pelo B**.

Nada disso paga por si para o caso real, que é *trocar de ERP uma vez*. Um corte
com preparação e confirmação explícita (§19) resolve a migração sem nenhum
desses custos.

## 14. `ERPIntegration.companyId @unique` — PRESERVAR

A relação existente está **correta** e não muda. É ela que torna a regra da §13
invariante de banco em vez de convenção.

**Não** criar `@@unique([companyId, provider])` como substituto: aquilo é
exatamente a mudança que permitiria dois ERPs ativos.

**Não** criar `Company.primaryErpProvider`: com uma integração só, o provider
dela **é** o provider ativo. Um campo separado seria uma segunda memória do
mesmo fato, e as duas divergem no dia em que alguém escrever numa e esquecer da
outra.

**Não** criar `ERPCapabilityBinding` nem `company + capability → provider`.

## 15. Resolução — a que já existe basta

```text
Company → ERPIntegration → provider → adapter
```

`resolveCompanyAdapter(companyId, provider)` (`src/lib/erp-adapter.ts`) continua
sendo o **único** ponto que decifra uma credencial e a entrega pronta. Nenhum
adapter toca Prisma ou ciphertext.

**Não criar uma segunda camada de resolução.** Não existe
`resolveProviderFor(company, capability)`, porque não há o que resolver: só há
um provider ativo.

## 16. Capability continua sendo pergunta ao ADAPTER

Capability descreve **o que um adapter sabe fazer** — não quem responde por ela.
O mecanismo já existe e não muda: interfaces fora do contrato base, detectadas
por type guard.

```text
adapter = resolveCompanyAdapter(company, provider)

supportsCustomerLookup(adapter) ?  executar
                                :  NOT_SUPPORTED
```

`supportsDiagnostics`, `supportsCustomerLookup` e `supportsServiceTickets` já
respondem isso hoje. Um `SgpAdapter` futuro declara as suas, e o núcleo do
AlfaOS continua sem saber com qual ERP está falando.

Empresa sem integração habilitada, ou provider que não implementa a capability
pedida, recebe `NOT_SUPPORTED` — **nunca** fallback silencioso para o MockERP.
Rotular dado de mock como se viesse de ERP real é a confusão que a §8 já proíbe.

## 17. Troca de ERP ativo

Trocar o ERP da empresa é **uma ação explícita e confirmada**, não efeito
colateral de outra.

**Estado atual, e é o defeito a corrigir:** hoje a troca acontece dentro de
`POST /api/integrations/test-connection`. Clicar em "testar conexão" com um
provider diferente do gravado **troca o provider da empresa** e, além disso,
**apaga as credenciais do anterior**. Testar deixou de ser uma consulta.

O desenho correto separa as duas coisas:

```text
TESTAR CONEXÃO     consulta. Não altera o ERP ativo. Não apaga nada.
ALTERAR ERP ATIVO  ação própria, com confirmação explícita e AuditLog.
```

## 18. Trocar de provider NÃO apaga credencial

Este é o achado da implementação descartada que **continua valendo**, e é o
único que sobrevive dela.

Hoje a troca executa `deleteMany` sobre as `ERPCredential` do provider anterior.
Isso destrói segredo sem ação explícita e **elimina o rollback operacional**: se
o ERP novo se comportar mal na segunda-feira de manhã, voltar exige reconfigurar
credencial sob pressão.

A regra passa a ser: **credencial armazenada não significa ERP ativo.** As
credenciais do provider anterior permanecem, cifradas e ociosas, até que alguém
as remova explicitamente. O vínculo AAD `(companyId, provider, kind)` já as
mantém isoladas — elas simplesmente não são consultadas enquanto aquele provider
não for o ativo.

Remover credencial continua existindo como **ação própria** do ADMIN.

## 19. Migração ReceitaNet → SGP

```text
A   ReceitaNet ativo.
B   Admin configura as credenciais do SGP.
C   TESTAR CONEXÃO no SGP passa.
D   Admin confirma: "ALTERAR ERP ATIVO PARA SGP".
E   ERPIntegration.provider = SGP.
F   As operações passam a usar o SGP. As credenciais do ReceitaNet FICAM.
```

O ponto de corte é `D`, e é deliberadamente um só: a operação sabe exatamente
quando mudou de ERP, e o `AuditLog` sabe quem e quando.

### `B` e `C` sem dois ERPs ativos — a decisão em aberto

Para testar o SGP antes do corte é preciso ter a credencial dele em algum lugar.
Duas saídas, e a escolha fica para a `SGP-1`:

**(i) Credencial candidata, não persistida.** O ADMIN preenche Base URL, App e
Token, e a rota de teste usa esses valores **em memória**, sem gravar. Só depois
da confirmação em `D` o segredo é cifrado e gravado. Nada muda no schema, e não
existe estado intermediário para alguém confundir com "ERP ativo".

**(ii) Credencial gravada para provider não ativo.** `ERPCredential` já é
`(companyId, provider, kind)` — o schema **já permite** guardar a credencial do
SGP enquanto o ReceitaNet é o ativo. É o mesmo estado que a §18 cria depois da
troca, só que antes.

A (ii) é a que o schema já suporta e a que sobrevive naturalmente ao rollback;
a (i) evita que um token trafegue e seja gravado antes de alguém decidir usá-lo.
**Recomendada: (ii)**, porque não inventa um caminho de token não persistido e
porque a §18 já exige que credencial ociosa seja um estado normal. A `SGP-1`
confirma ao escrever a tela.

## 20. Identidade externa — histórico, não seleção

`(companyId, externalProvider, externalId)` em `Customer` e `ServiceOrder`
**permanece exatamente como está**. Ela registra **de onde o dado veio**, não
qual ERP está ativo agora.

```text
OS importada antes da troca   externalProvider = RECEITANET
OS importada depois           externalProvider = SGP
```

As duas coexistem, e isso é correto. **Nenhum registro antigo é convertido para
SGP.** Reescrever o histórico apagaria a informação de qual sistema originou
cada atendimento — e é justamente ela que permite conferir uma OS antiga com o
provedor certo.

`ServiceOrderOrigin` também não muda: OS importada nasce `EXTERNAL`, e a partir
daí **execução, fila de despacho, timeline e fechamento são do AlfaOS** (§17 da
Parte XV do PRD).

## 21. Arquitetura de adapters — preservada

`ERPIntegrationContract`, `ReceitanetAdapter`, `MockERPAdapter`, o modelo de
erros `IntegrationError`, o timeout no call site e as capabilities por type
guard **não mudam**. Um `SgpAdapter` entra ao lado; `IxcAdapter`,
`MkSolutionsAdapter` e `HubsoftAdapter` entrariam da mesma forma.

O núcleo do AlfaOS não sabe qual ERP está usando, e é isso que a plataforma
significa.

## 22. Configuração na Web

Caminho existente, preservado: **`/integracoes`**, já no menu, restrito a
`ADMIN`. A tela mostra **um** ERP ativo:

```text
INTEGRAÇÃO ERP

ERP utilizado pela empresa   [ ReceitaNet ▼ ]
Status                       Conectado · testado há 4 min

<configuração específica do provider selecionado>

[ TESTAR CONEXÃO ]   [ SALVAR ]   [ ALTERAR ERP ATIVO ]
```

**Nunca** apresentar dois ERPs como ativos ao mesmo tempo.

O seletor pode listar o **catálogo** de fornecedores que o AlfaOS suporta — SGP,
ReceitaNet, e futuros marcados como `EM BREVE`, sem opção de seleção enquanto
não houver adapter. *"Disponível no AlfaOS"* não é *"ativo nesta empresa"*, e a
tela não pode deixar a diferença ambígua.

Campos por provider: o ReceitaNet mantém os atuais; o SGP acrescenta **Base
URL**, **App** e **Token**, com o token pelo `ERPCredentialService`.

`ERPIntegration` já tem `baseUrl` e um `config Json?` **sem nenhum consumidor**
hoje — ou seja, o `app` do SGP tem onde morar sem coluna nova, se a `SGP-1`
preferir. Coluna dedicada continua sendo opção; a decisão é da fase que
implementa.

## 23. Segredo e auditoria

Sem novidade estrutural — o que existe basta:

* token cifrado por `ERPCredentialService`, AAD `(companyId, provider, kind)`;
* **não existe caminho de leitura do token**: só `SUBSTITUIR`, nunca `REVELAR`;
* apenas os últimos 4 caracteres aparecem;
* log permitido: empresa, provider, capability, operação, status, duração.
  **Proibido:** token, `app` junto do token, CPF completo, telefone, nome,
  endereço, senha PPPoE, corpo da resposta.

`AuditLog` registra: integração criada, habilitada, desabilitada, `baseUrl`
alterada, `app` alterado, token substituído, token removido, teste executado e
— o que mais importa — **troca do ERP ativo**, com origem e destino. Nenhum
evento carrega valor de token.

## 24. Credencial do SGP e privilégio mínimo

A API do SGP expõe liquidar, estornar e cancelar título. Enquanto não houver
capability de escrita, o token gerado para o AlfaOS **não deve** ter essas
permissões — um token que não pode chamá-las transforma *"não chamamos"* em
*"não conseguimos"*.

Se o SGP permitir restringir host e associar usuário ao token — o que a
documentação pública **não** descreve (`ERP-SGP.md` §10) —, a recomendação é
restringir e usar um usuário identificável como integração, nunca conta pessoal.
Confirmar com o fornecedor antes de prometer.

## 25. O que o schema realmente precisa

Resposta direta: **quase nada**, e é essa a diferença em relação ao plano
descartado.

| Necessidade | Situação |
| --- | --- |
| uma integração por empresa | **já existe** — `companyId @unique` |
| provider ativo | **já existe** — `ERPIntegration.provider` |
| `baseUrl` por empresa | **já existe** |
| lugar para o `app` do SGP | **já existe** — `config Json?`, hoje sem consumidor (ou coluna nova, se a fase preferir) |
| credencial cifrada por provider e API | **já existe** — `ERPCredential(companyId, provider, kind)` |
| identidade externa por provider | **já existe** |
| `ERPProvider.SGP` | **falta** — `ALTER TYPE ... ADD VALUE`, aditivo |
| valor de `ERPCredentialKind` para o SGP | **falta** — o SGP tem UMA API, e `CALLCENTER`/`CHATBOT` são nomes do ReceitaNet |

Sobre o `kind`: **não reutilizar `CALLCENTER` para o SGP** só para evitar um
valor novo — a linha passaria a mentir sobre qual API a credencial abre. E **não
renomear** os existentes: eles estão gravados em linhas reais e participam do
AAD `v2`, e renomear valor de enum invalidaria credencial em produção.

Os dois valores que faltam cabem numa migration **aditiva de duas linhas**, e
ela pertence à `SGP-1` — é lá que passam a ser usados.

## 26. Plano de testes

| # | Cenário |
| --- | --- |
| `ERP-01` | empresa A escolhe SGP |
| `ERP-02` | empresa B escolhe ReceitaNet, sem interferência |
| `ERP-03` | empresa sem ERP é estado legítimo |
| `ERP-04` | **o banco recusa** duas `ERPIntegration` para a mesma empresa |
| `ERP-05` | troca ReceitaNet → SGP muda o ERP ativo |
| `ERP-06` | a troca **não** apaga a credencial anterior |
| `ERP-07` | o adapter resolvido é o do provider ativo |
| `ERP-08` | capability não suportada devolve `NOT_SUPPORTED`, nunca Mock |
| `ERP-09` | empresa A não lê nem altera a integração de B |
| `ERP-10` | segredo mascarado: só `last4`, nunca o token |
| `ERP-11` | substituição de token troca o valor e audita sem vazar |
| `ERP-12` | a troca do ERP ativo é auditada com origem e destino |
| `ERP-13` | `externalProvider` histórico preservado após a troca |
| `ERP-14` | OS antiga do ReceitaNet **continua** ReceitaNet |
| `ERP-15` | OS nova nasce SGP |

`ERP-04` é o teste que substitui toda a maquinaria descartada: com
`companyId @unique`, ele é uma linha e o banco responde.

## 27. Roadmap revisado

| Fase | Escopo | Migration |
| --- | --- | --- |
| `ERP-1` | troca de ERP explícita + parar de apagar credencial na troca + auditoria | **não** — **ENTREGUE**, ver §28 |
| `SGP-1` | `ERPProvider.SGP` + `kind` do SGP + `SgpClient`/`SgpAdapter` com `testConnection` + configuração na tela | **sim**, aditiva de 2 valores — **ENTREGUE**, ver §29 |
| `SGP-2` | `CUSTOMER_LOOKUP` read-only | não |
| `SGP-3` | contratos, financeiro e demais capabilities conforme a API real | a definir |
| `SGP-4` | descoberta e importação de OS sobre o motor da v0.8 | provável, pequena |
| `SGP-5` | write-back controlado, capability explícita e desligada por padrão | a definir |

### Quanto a `ERP-1` precisa mesmo existir

**Pouco, e nada disso é fundação.** A §25 mostra que o schema já sustenta a
regra: `companyId @unique` **já é** a invariante principal, e não há camada de
resolução a construir.

O que sobra são **dois defeitos de comportamento**, ambos independentes do SGP e
ambos benéficos para o ReceitaNet hoje:

1. a troca de ERP acontece como efeito colateral de "testar conexão" (§17);
2. a troca apaga credencial sem ação explícita (§18).

Consertar os dois é uma fase pequena, sem migration. **Se a prioridade for
chegar ao SGP, é legítimo dobrar `ERP-1` dentro de `SGP-1`** — a tela de
configuração do SGP é justamente onde a troca explícita precisa aparecer.

A recomendação é mantê-las separadas por um motivo prático: `ERP-1` pode ser
verificada contra o ReceitaNet, que já funciona e já tem regressão. Misturada
com o transporte novo do SGP, um defeito na troca ficaria indistinguível de um
defeito no adapter.

---

# 28. `ERP-1` — ENTREGUE

Os dois defeitos da §17 e da §18 estão corrigidos. **Nenhuma migration, nenhuma
alteração de schema, nenhuma dependência nova, zero Dart.** O SGP continua sem
existir: sem `ERPProvider.SGP`, sem `SgpAdapter`, sem transporte.

## 28.1 O que entrou

| Peça | Onde |
| --- | --- |
| `switchActiveErpProvider`, `getActiveIntegration` | `src/lib/erp-integration.ts` |
| `POST /api/integrations/active-provider` | `src/app/api/integrations/active-provider/route.ts` |
| `logAuditWithin` (auditoria dentro de transação) | `src/lib/audit.ts` |
| Teste de conexão sem efeito colateral | `src/app/api/integrations/test-connection/route.ts` |
| Controle de troca com confirmação | `src/app/(app)/integracoes/ActiveProviderSwitch.tsx` |

## 28.2 As três ações, agora separadas

```text
SALVAR CREDENCIAL   grava segredo. Não ativa provider.
TESTAR CONEXÃO      consulta. Não altera o ERP ativo. Não apaga nada. Não cria nada.
ALTERAR ERP ATIVO   POST /api/integrations/active-provider. A ÚNICA que escreve `provider`.
```

### O que o teste de conexão fazia, e não faz mais

Três escritas saíram da rota:

* o `upsert` que gravava `provider` — testar um candidato **ativava** aquele ERP
  na empresa, e toda a operação passava a falar com outro sistema por causa de
  um clique de diagnóstico;
* o `deleteMany` sobre as `ERPCredential` do provider anterior — segredo
  destruído em silêncio, rollback eliminado;
* o `CLEARED_CREDENTIAL_FIELDS` sobre as colunas legadas.

Junto com elas saiu a **criação** da integração. O `upsert` fazia de "testar" um
caminho de configuração: uma empresa sem ERP que clicasse em testar acabava
configurada em MOCK. Criar é `PATCH /api/integrations`; testar é consulta.

### O que ainda é gravado

`lastTestedAt`/`lastTestStatus` descrevem a saúde da integração **ativa**, e por
isso só são gravados quando o provider testado **é** o ativo. Testar um
candidato não persiste nada: escrever o resultado dele na linha da empresa faria
a tela anunciar a saúde de um ERP que não atende ninguém.

Não existe coluna para saúde de candidato, e **nenhuma foi inventada** — exigir
"último teste bem-sucedido" antes da troca fica para a `SGP-1`, quando houver
uma segunda implementação real para exercitá-la.

A resposta ganhou `testedActiveProvider` e `activeProvider`, e perdeu
`invalidatedCredential` — o campo sinalizava uma destruição que deixou de
existir.

## 28.3 A troca explícita

`switchActiveErpProvider` é a única operação que escreve `ERPIntegration.provider`.

**Precondições, e nenhuma é codificada por provider.** A exigência de credencial
é *"o provider de destino resolve para um adapter utilizável?"*, e quem responde
é `resolveCompanyAdapter`, que já falha com `AUTHENTICATION_FAILED` quando falta
o segredo. O MockERP passa porque não precisa de token; o ReceitaNet só passa com
credencial gravada; um provider futuro herda a regra sem que ninguém volte lá.

**Trocar para o provider já ativo é recusado**, e não tratado como no-op
silencioso: um 200 gravaria `ERP.ACTIVE_PROVIDER_CHANGED` para uma troca que não
aconteceu, e a auditoria passaria a conter eventos que a operação nunca viveu.

**Concorrência sem coluna nova.** O `updateMany` é compare-and-set sobre o
provider **lido**: `where: { companyId, provider: current.provider }`. Duas
trocas simultâneas a partir do mesmo estado não deixam estado híbrido — quem
chega em segundo encontra `count === 0` e recebe 409, sem gravar auditoria de
uma troca que não fez. Nenhuma `version` foi acrescentada ao schema: o próprio
provider é o token de comparação, e ele já estava lá.

**Atomicidade.** A escrita e o `AuditLog` estão na mesma transação, via
`logAuditWithin`. Um registro sem a troca inventaria um evento; uma troca sem
registro apagaria quem a fez. `logAuditWithin` propaga a exceção, ao contrário de
`logAudit` — engoli-la derrotaria o propósito de estar na transação — e reusa
`auditRow`, para a sanitização continuar num lugar só.

## 28.4 Credencial armazenada não é ERP ativo

A troca **não apaga** a credencial do provider anterior. As linhas ficam
cifradas e ociosas, isoladas pelo AAD `(companyId, provider, kind)`, e
simplesmente não são consultadas enquanto aquele provider não for o ativo.

É isso que preserva o rollback: `RECEITANET → MOCK → RECEITANET` não exige
recadastrar token em nenhum dos passos.

**E credencial ociosa não cria provider secundário.** Se o ERP ativo não oferece
uma capability, a resposta é `NOT_SUPPORTED` — e não "usar o outro provider, que
tem credencial e sabe fazer". Não existe fallback.

## 28.5 Histórico

A troca não toca `Customer.externalProvider` nem
`ServiceOrder.externalProvider`. Isso é estrutural, não disciplina: o serviço
escreve em **duas** tabelas apenas, `erp_integrations` e `audit_logs`.

## 28.6 O que o teste de conexão perdeu, e por que os testes antigos mudaram

Três testes afirmavam o comportamento antigo — que a credencial era apagada e
que o provider mudava. Estavam descrevendo o defeito, não a regra. Foram
reescritos para o invariante novo e ganharam as asserções que antes eram
impossíveis: o ERP ativo não muda, a credencial do ativo sobrevive, e o
resultado do candidato **não** é gravado na linha da empresa.

Um deles montava uma empresa **sem** integração e dependia do `upsert` para
existir. Virou dois testes: um com a integração criada antes, e outro — novo —
provando que testar **não cria** integração para quem não tem ERP.

## 28.7 Um teste que passava pelo motivo errado

A sabotagem `F` (obedecer ao `companyId` do corpo) **passou** na primeira
tentativa. O `ERP1-13` mandava o `companyId` da empresa B, mas B não tinha
credencial do provider de destino: a troca falhava por precondição, e o 400
aparecia mesmo com o ataque bem-sucedido.

O teste passou a preparar a empresa B **inteira** — integração e credencial de
destino no lugar —, de modo que obedecer ao corpo *funcionaria*. Só então a
asserção "B continua em MOCK" tem o que proibir.

## 28.8 Roadmap

`ERP-1` sai da §27 como **ENTREGUE**. A próxima é `SGP-1`, que carrega a
migration aditiva de dois valores de enum (`ERPProvider.SGP` e o `kind` da API
única do SGP) e o `SgpAdapter`.

---

# 29. `SGP-1` — ENTREGUE

O provider SGP existe no domínio, autentica e é ativável. **Somente
`testConnection`** — nenhuma capability de negócio.

Uma migration **aditiva de duas linhas**, exatamente como a §25 previu. Zero
coluna, zero tabela, zero unique alterada, zero dependência, zero Dart.

## 29.1 O que entrou

| Peça | Onde |
| --- | --- |
| `ERPProvider.SGP`, `ERPCredentialKind.PUBLIC_API` | migration `20260903120000` |
| `SgpClient` — transporte Token/App | `src/integrations/sgp/SgpClient.ts` |
| `SgpAdapter` — só `testConnection` | `src/integrations/SgpAdapter.ts` |
| Validação de URL de saída (SSRF) | `src/lib/safe-outbound-url.ts` |
| Candidato e ativação atômica | `src/lib/erp-provisioning.ts` |
| `assertProviderUsableAfterSwitch` | `src/lib/erp-adapter.ts` |
| `POST /api/integrations/candidate` | rota de teste e ativação |
| Card do SGP | `src/app/(app)/integracoes/SgpProviderCard.tsx` |

## 29.2 A superfície escolhida, e a que ficou de fora

**Adotada:** `/api/ura/`, `/api/os/`, `/api/fttx/`, `/api/estoque/` — Token e App
no **corpo**, `application/x-www-form-urlencoded`.

**`NOT ADOPTED / NEED VALIDATION`:** a superfície `/api/v1/` com `Authorization`,
vista no site do fabricante e ausente das 275 requisições catalogadas. **Não se
assume que o token de uma vale na outra.** Confirmar antes de considerar migrar
o transporte.

## 29.3 A sonda mudou de endpoint, e a reconfirmação é o motivo

A `ERP-0R` sugeriu `consultaplano`. A revalidação da coleção oficial mostrou que
ele é **`GET` com corpo `form-data`** — e um `GET` com corpo é descartado por
proxies e por vários clientes HTTP. A única alternativa seria `token`/`app` na
query string, que é o que não se faz com um segredo.

**Sonda adotada: `POST /api/ura/planoscontas/`.** É `POST`, recebe exatamente
`token` e `app`, e devolve `[{ id, codigo, descricao }]` — plano de contas, sem
cliente, sem valor, sem PII. Autenticado, somente leitura, e nenhum parâmetro
capaz de disparar efeito.

Descartados com motivo: `fatura2via` tem `nao_gerar_os` e pode **abrir OS**;
`cpemanager/.../command/ping/` executa comando em equipamento; e
`consultacliente` exigiria enviar o documento de uma pessoa real só para saber se
o token vale.

**O SGP não tem `/ping` anônimo.** Não existe chamada que prove "o serviço está
de pé" sem credencial, então `reachable` e `credentialValidated` são derivados
assim: sucesso → os dois; `401`/`403` → alcançável com credencial recusada
(um 401 **é** resposta); timeout ou 5xx → não alcançável, e nada se sabe sobre a
credencial.

## 29.4 Candidato: nada é persistido

Testar uma configuração que a empresa ainda não usa era o problema central. Dois
caminhos foram recusados por escrito antes de o código existir:

* gravar `baseUrl`/`config` do SGP na integração ativa só para testar —
  **corromperia a configuração do ERP que está atendendo**;
* criar uma segunda `ERPIntegration` — quebraria a regra de um ERP ativo.

A saída: `testCandidateConnection` recebe a configuração pelo corpo, monta o
adapter **em memória**, testa e devolve. Nada é gravado — nem integração, nem
credencial, nem `lastTestedAt`. O token existe só naquela requisição.

**Nem no navegador.** O formulário guarda os três valores em estado de
componente; `localStorage`, `sessionStorage` e cookie estão fora. Se o ADMIN sair
antes de ativar, preenche de novo — simplicidade escolhida sobre segredo
persistido fora do cofre.

## 29.5 Ativação: reteste no servidor, e atomicidade real

O resultado que o browser viu **não é aceito como prova**. Entre o clique em
"testar" e o em "confirmar" o token pode ter sido revogado — e o corpo da
confirmação é reenviável, então sem reteste um `POST` forjado ativaria o SGP com
credencial que nunca funcionou. A ativação testa de novo, no servidor, com a
configuração que vai de fato ser gravada. Falhou → **nada é trocado**.

A atomicidade é real e não aparente: `encryptCredential` é **pura** e roda FORA
da transação, falhando por chave ausente antes de qualquer escrita. Só as
escritas entram — integração, credencial e `AuditLog` —, então não existe estado
em que `provider = SGP` conviva com credencial ausente.

Concorrência: o mesmo compare-and-set da `ERP-1`, sobre o provider lido. Duas
ativações simultâneas deixam uma vencer; a outra recebe 409 sem gravar auditoria
de uma troca que não fez.

## 29.6 SSRF

A `baseUrl` vem do ADMIN, então o servidor do AlfaOS passaria a bater onde
mandassem. `safe-outbound-url.ts` recusa: esquema fora de `https` (com `http`
liberado só fora de produção, porque o token viaja no corpo), credencial
embutida na URL, fragmento, IP literal privado, e **nome que resolve** para
loopback, link-local (inclusive `169.254.169.254`), RFC1918, CGNAT ou multicast.

**Regex não bastaria, e é por isso que há DNS.** `http://127.0.0.1` é fácil de
barrar por texto; `https://host.exemplo` apontando para `127.0.0.1` não é. E
**todos** os endereços resolvidos são verificados, não só o primeiro — um nome
com um registro público e um interno passaria se a checagem parasse no primeiro.

Redirecionamento não é seguido (`redirect: "manual"`): um `302` para host interno
driblaria a validação, que só examinou a URL que nós montamos.

**O que NÃO está fechado, declarado:** DNS rebinding. Entre a resolução e a
conexão existe uma janela; fechá-la exige fixar o IP validado na própria conexão
(dispatcher com `lookup` próprio), o que atravessa a camada de transporte e não é
escopo desta fase. O que está garantido é que um endereço **estaticamente**
interno — direto ou por resolução — nunca é aceito.

## 29.7 Duas correções que o código impôs ao plano

### A precondição da troca avaliava o estado ERRADO

`switchActiveErpProvider` usava `resolveCompanyAdapter` como precondição, e ela
lê as sobreposições **gravadas**. Depois de ativar o SGP, voltar para o
ReceitaNet **falhava**: a linha ainda tinha o host do SGP, o
`ReceitanetCallCenterClient` tem allowlist **exata** de host e recusava — e o
operador recebia *"não foi possível autenticar"*, como se o token estivesse
errado.

Corrigido com `assertProviderUsableAfterSwitch`, que constrói o adapter **sem**
as sobreposições — o estado que a troca vai produzir, já que ela limpa
`baseUrl`/`config`.

**E a limpeza não é proteção contra vazamento de token:** a allowlist do
ReceitaNet já impedia isso, antes de qualquer requisição. O defeito era de
operabilidade — rollback bloqueado com mensagem enganosa —, e é assim que está
registrado.

### O SGP não entra pela rota genérica de troca

`POST /api/integrations/active-provider` troca entre providers cuja credencial já
está gravada. O SGP precisa de `baseUrl`, `app` e token, então ele é recusado ali
com mensagem que aponta o caminho certo — e, no seletor da tela, nem é oferecido.
Deixá-lo passar acabaria ativando o SGP com a `baseUrl` de outro provider.

## 29.8 Nenhuma capability de negócio

A API do SGP documenta cliente, contratos, financeiro, OS, ONU e CPE. **A
existência do endpoint não é a capability.** O adapter não declara nenhuma
interface e não tem os métodos, então `supportsCustomerLookup`,
`supportsDiagnostics` e `supportsServiceTickets` respondem `false`
estruturalmente — sem ninguém manter uma lista.

Dois testes guardam isso: um estrutural, pelos type guards, e um sobre o
**fonte** — que proíbe até a declaração das interfaces, porque um método vazio
adicionado às pressas compilaria.

## 29.9 Recomendação ao operador

O token do SGP para o AlfaOS deve ser **somente leitura** nesta fase:

```text
Permite Baixar Título      OFF
Permite Cancelar Título    OFF
```

A API expõe esses caminhos; o AlfaOS não os chama, e um token que não pode
chamá-los transforma *"não chamamos"* em *"não conseguimos"*.

Restrição de host/rota e usuário associado ao token **não aparecem na
documentação pública** (§10). Se existirem no produto, restringir; e usar um
usuário identificável como integração, nunca conta pessoal — recomendação que
vale desde já e vira requisito quando houver write-back.

## 29.10 O que depende do sandbox

Um detalhe de transporte, e só ele: a coleção oficial cataloga
`multipart/form-data`, e a documentação de autenticação registra que *"o uso de
form-data é opcional"*. A implementação usa `application/x-www-form-urlencoded`,
que é o mesmo transporte do cliente do ReceitaNet e não exige gerar boundary. Se
o SGP recusar, muda o `Content-Type` e a serialização — e nada mais.

Nenhum teste automático chama o SGP real. Sem credencial de sandbox disponível,
o estado é **`SGP SANDBOX VALIDATION REQUIRED`** e, desde a `RC-1`, também
**`PRODUCTION ACTIVATION GUARDED`**: a ativação em produção depende de
`SGP_ACTIVATION_ENABLED=true`, que é decisão deliberada tomada depois da
homologação com uma instalação real. Testar a conexão continua liberado. Ver
`docs/SECURITY.md` §8.18.

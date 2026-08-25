# Integrações ERP e Diagnóstico do Cliente — AlfaOS (v0.7.2)

Como o AlfaOS fala com sistemas externos e como o diagnóstico de conectividade
do cliente chega até a tela. Complementa `docs/ARCHITECTURE.md` (camadas) e
`docs/SERVICE-ORDERS.md` (sync de OS).

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

Continua sem existir em nenhuma API: **ONU**, potência óptica, MAC de
equipamento de rede, OLT, **listagem de OS por empresa** (confirmado pelo
suporte — `docs/PRD.md` §141), delta sync e webhook.

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
via AAD do AES-GCM. Consequência operacional: **trocar o `provider` de uma
integração invalida a credencial**, que é apagada explicitamente na troca.
Detalhe em `docs/SECURITY.md` §8.4.

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

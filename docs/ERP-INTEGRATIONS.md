# Integrações ERP e Diagnóstico do Cliente — AlfaOS (v0.5)

Como o AlfaOS fala com sistemas externos e como o diagnóstico de conectividade
do cliente chega até a tela. Complementa `docs/ARCHITECTURE.md` (camadas) e
`docs/SERVICE-ORDERS.md` (sync de OS).

## 1. Estado da integração ReceitaNet

### CONFIRMED

**Nenhuma capacidade.** Zero operações ReceitaNet estão implementadas nesta
versão.

### NOT CONFIRMED

Uma varredura completa do repositório em v0.5 não encontrou **nenhuma**
documentação da API ReceitaNet: sem OpenAPI/Swagger, sem coleção Postman, sem
PDF, sem exemplo de payload, sem descrição de autenticação, sem base URL.

Portanto, todas as capacidades abaixo estão **NOT CONFIRMED**:

| Capacidade | Situação |
| --- | --- |
| Autenticação | NOT CONFIRMED |
| Busca de cliente (nome) | NOT CONFIRMED |
| Busca por CPF/CNPJ | NOT CONFIRMED |
| Busca por telefone | NOT CONFIRMED |
| Contratos | NOT CONFIRMED |
| Chamado / OS | NOT CONFIRMED |
| Status de conectividade | NOT CONFIRMED |
| Teste de conectividade | NOT CONFIRMED |
| Dados PPPoE | NOT CONFIRMED |
| ONU / CPE | NOT CONFIRMED |
| Financeiro | NOT CONFIRMED |

**Sobre o PRD §27.** Ele registra que APIs oficiais foram *identificadas como
existentes* para clientes, chamados, contratos, dados da empresa, central do
assinante e informações financeiras. Identificar que uma API existe não é ter o
contrato dela: não dá endpoint, método, esquema de autenticação nem formato de
resposta. O §64 fecha a questão — integração só se implementa com documentação
oficial, Swagger/OpenAPI, Postman, informação oficial do suporte ou testes
autorizados.

### NOT IMPLEMENTED

`ReceitanetAdapter` declara as capabilities e **recusa todas** com
`NOT_SUPPORTED`. Ele nunca devolve dado fabricado e nunca devolve `OFFLINE` —
o AlfaOS não ter integração não diz nada sobre o link do cliente.

Declarar-e-recusar é deliberado: omitir o método faria `supportsDiagnostics()`
responder `false`, e a UI esconderia o painel como se diagnóstico fosse
irrelevante para esse provider. Recusar explicitamente mostra o estado real.

### Bloqueio adicional: credenciais

Mesmo com documentação, autenticação real não subiria hoje.
`ERPIntegration.apiKey` é uma coluna **plaintext**, hoje sem uso em nenhum
caminho de código, sem cifragem em repouso, sem rotação e sem gestão de chave
por tenant. Guardar credencial real de provider ali seria exatamente o "token
plaintext no banco sem arquitetura deliberada" que `docs/SECURITY.md` proíbe.

**Status: LIVE RECEITANET AUTH BLOCKED BY CREDENTIAL STORAGE DESIGN.**

### O que fazer quando a documentação chegar

Implementar uma capability por vez e registrar aqui, para cada uma: fonte da
confirmação, endpoint, método, autenticação, campos consumidos e mapping para
o modelo AlfaOS. Rotear HTTP por um cliente dedicado (auth, timeout e
normalização de erro num lugar só), conforme `docs/PRD.md` §28.
`withIntegrationTimeout` já está no call site, então um adapter novo herda o
limite de tempo automaticamente.

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

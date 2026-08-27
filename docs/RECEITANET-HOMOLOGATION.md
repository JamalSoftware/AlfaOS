# ReceitaNet — Homologação AlfaOS

Investigação read-only das APIs oficiais do ReceitaNet, com o objetivo específico
de determinar se existe alguma forma autorizada de **descobrir ordens de serviço
sem conhecer previamente o `idCliente`**.

> **A pergunta central foi RESPONDIDA em 2026-08-25.** O suporte do ReceitaNet
> confirmou que **não existe hoje API pública para listar globalmente todas as
> OS da empresa**. A investigação está **encerrada** — ver "Descoberta global
> de OS" abaixo. O restante do documento continua sendo a referência de
> contrato, armadilhas e homologação das rotas que existem.

Nenhum endpoint mutante foi chamado durante esta investigação. Nenhum dado
pessoal, token ou segredo aparece neste documento.

**Data da coleta:** 2026-08-24
**Fonte:** OpenAPI oficiais publicados em `www.receitanet.net/api/<api>/openapi.yaml`
e documentação pública em `blog.receitanet.net`.

---

## APIs conhecidas

Quatro APIs oficiais, cada uma com OpenAPI próprio e **contrato independente**.
Não são versões da mesma API: divergem em autenticação, transporte, nomes de
campo e semântica. Misturar contratos entre elas é erro.

| API | OpenAPI | Autenticação | Transporte | Escopo do consumidor |
|---|---|---|---|---|
| CallCenter | `/api/callcenter/openapi.yaml` | header `token` | form-urlencoded / multipart | Operador da empresa |
| URA | `/api/ura/openapi.yaml` | `app` + `token` em **query** | JSON | Sistema de telefonia |
| Chatbot | `/api/chatbot/openapi.yaml` | `app` + `token` em **query** | query params | Bot de atendimento |
| Central do Assinante | `/api/centralassinante/openapi.yaml` | Bearer via `POST /token` | JSON | **O próprio assinante** |

O ReceitaNet mantém um registro interno de integrações: o campo `app` é descrito
como *"Tipo da integração cadastrado em `sistema_integracoes`"*, e o CallCenter
exige *"uma integração ativa do tipo `callcenter`"*. Os valores válidos desse
registro **não são publicados**.

### CallCenter

A única com token em header (as demais expõem o token na URL, que entra em log
de servidor, proxy, histórico e `Referer`). É a superfície correta para o AlfaOS
e continua sendo a única implementada.

### URA

Mesmo domínio funcional, contrato diferente. Tem valor **documental**: descreve
campos que o CallCenter expõe sem explicar (ver *Chamados / OS*).

### Chatbot

Único com endpoints de escopo de empresa (`/empresa`, `/planos-cobrancas`,
`/debitos`). O OpenAPI marca **todos** os parâmetros como `required: false`,
inclusive `token` — o que não pode ser verdade num endpoint autenticado. Trate
a obrigatoriedade declarada neste spec como não confiável.

### Central do Assinante

Autenticação é login do **assinante** (`/token`, por login/senha ou CPF/CNPJ).
Tudo que ela devolve é do escopo daquele assinante. Usá-la a partir do AlfaOS
exigiria credencial do cliente final — fora de questão.

### OSNET / App Técnico

Produto separado (`sistema.osnet.app.br`), ativado em
`ReceitaNet → Menu → Integrações → OSNET`. **Não possui OpenAPI publicado e não
tem subcategoria própria** no índice de APIs do blog (que lista apenas
`api-callcenter`, `api-ura`, `api-central-assinante`, `api-chatbot`).

Afirmações da documentação pública oficial:

- *"No RECEITANET, a ordem automaticamente é registrada no OSNET. Bem como as
  suas movimentações feitas pelo técnico irão automaticamente para o seu
  RECEITANET."* — sincronização bidirecional automática.
- *"O estoque técnico/ReceitaNet atualiza no OSNET? SIM, a API atualiza
  gradualmente."* — existe API; "gradualmente" não distingue push de polling.
- *"As ordens de serviço do tipo financeiro **não** são encaminhadas para o
  OSNET."* — há filtro por tipo na fronteira ReceitaNet→OSNET.
- Três tipos são encaminhados: **Manutenção, Instalação, Retirada de
  Equipamentos**.
- Existe um **"Botão ressincronizar OS"** na interface do OSNET.

---

## Matriz de endpoints

`R` = read-only · `M` = mutante · `?` = incerto

### CallCenter — `https://api.receitanet.net/callcenter`

| Rota | Método | R/M | Parâmetros | Retorno | Teste real | Homologação |
|---|---|---|---|---|---|---|
| `/ping` | GET | R | nenhum (`security: []`) | disponibilidade | ✅ | Implementado |
| `/v1/clientes` | POST | R | `nome` \| `phone` \| `cpfcnpj` (anyOf) | `ClienteResumo[]` \| erro | ✅ | Implementado |
| `/v1/cliente` | POST | R | `idCliente` | `ClienteDetalhado` | ✅ | Implementado |
| `/v1/cliente/verificar-acesso` | POST | R | `idCliente` | `status` 1/2 | ✅ | Implementado |
| `/v1/chamados` | POST | R | **`idCliente` (obrigatório)** | `Chamado[]` \| erro | ✅ | **Implementado (v0.7)** |
| `/v1/chamado` | POST | **M** | abertura de chamado | protocolo gerado | ❌ proibido | Fora de escopo |
| `/v1/chamado/gravacao` | POST | **M** | `idSuporte`, `urlgravacao` | `success` | ❌ proibido | Fora de escopo |
| `/v1/cobranca/enviar` | POST | **M** | envio de cobrança | — | ❌ proibido | Fora de escopo |
| `/v1/cliente/notificacao-pagamento` | POST | **M** | notificação | — | ❌ proibido | Fora de escopo |
| `/v1/cliente/reiniciar` | POST | **M** | reexecução de rotina no servidor | — | ❌ proibido | Fora de escopo |

`/v1/chamado/gravacao` *"pode finalizar o chamado"* — é mutante apesar do nome
sugerir gravação de mídia.

### URA

| Rota | Método | R/M | Parâmetros | Observação |
|---|---|---|---|---|
| `/clientes` | POST | R | busca de cliente | devolve `idCliente` **e** `contratoId` separados |
| `/chamados` | POST | R | **`idCliente`** | inclui `existeChamadoPendenteIntegracao` |
| `/verificar-acesso` | POST | R | `idCliente` | — |
| `/boletos` | POST | R | `idCliente` | — |
| `/abertura-chamado` | POST | **M** | — | proibido |
| `/notificacao-pagamento` | POST | **M** | — | proibido |
| `/chamado-gravacao` | POST | **M** | `idSuporte` | proibido |

### Chatbot

| Rota | Método | R/M | Parâmetros | Escopo |
|---|---|---|---|---|
| `/empresa` | POST | R | `token`, `app` | **Empresa** — dados cadastrais |
| `/planos-cobrancas` | POST | R | `token`, `app` | **Empresa** — catálogo de planos |
| `/debitos` | POST | R | `page`, `status`, `cpfcnpj`, `data_inicio`, `data_fim` | **Empresa?** — ver hipótese |
| `/clientes` | POST | R | `cpfcnpj`, `phone` | Cliente |
| `/chamados` | POST | R | **`idCliente`** | Cliente |
| `/verificar-acesso` | POST | R | `idCliente` | Cliente |
| `/boletos` | POST | R | `idCliente` | Cliente |
| `/abertura-chamado` | POST | **M** | — | proibido |
| `/notificacao-pagamento` | POST | **M** | — | proibido |
| `/chamado-gravacao` | POST | **M** | `idSuporte` | proibido |

### Central do Assinante

| Rota | Método | R/M | Escopo | Observação |
|---|---|---|---|---|
| `/token` | POST | R | — | login do assinante |
| `/chamados` | GET | R | Assinante | **últimos 3**, abertos **e finalizados** |
| `/chamados/respostas/{chamado}` | GET | R | Assinante | thread de mensagens |
| `/chamados` | POST | **M** | Assinante | proibido |
| `/chamados/respostas/{chamado}` | POST | **M** | Assinante | proibido |
| `/empresa`, `/cliente/*`, `/financeiros/faturas` | GET | R | Assinante | — |

---

## Chamados / OS

### Contrato exato de `POST /v1/chamados` (CallCenter)

```
summary:     Consultar chamados abertos
description: Retorna até 10 chamados abertos do cliente,
             em ordem decrescente de previsão.
requestBody: required: true
             schema: IdClienteRequest
               required: [idCliente]   # integer
               + LegacyFields (token, app — legado)
responses:   200 → oneOf [ Chamado[], ErrorMessage ]
             401 → NotAuthenticated
```

Não existe: parâmetro de query, header além do `token`, paginação, filtro de
data, filtro de status, nem qualquer campo além de `idCliente`.

Schema `Chamado` — 6 campos, todos obrigatórios:
`idSuporte` · `numero` · `protocolo` · `descricao` · `tipo` · `data_previsao`.

**Não há campo de status.** O endpoint devolve apenas abertos, por definição.

### Duas armadilhas documentadas

**1. Teto de 10 registros.** *"Retorna até 10 chamados abertos"*. Um cliente com
11 chamados abertos perde um, silenciosamente, sem paginação para recuperá-lo.

**2. `success:false` aqui significa ZERO, não erro.** O exemplo `nenhum` do
próprio spec:

```json
{ "success": false, "message": "Nenhum chamado localizado." }
```

Em `/v1/clientes` a AlfaOS trata `success:false` como `INVALID_RESPONSE`
(v0.6.1). Em `/v1/chamados` a **mesma forma** significa "nenhum resultado".
Reaproveitar o tratamento de um no outro produziria erro onde há resposta
legítima. Registrado aqui porque a semelhança é enganosa.

### Decodificador de campos — só a URA documenta

O spec da URA explica o que o CallCenter expõe sem explicar:

> *"O campo `numero` é o **SUP_NUMERO**, ou seja, o **número visível da O.S.**;
> `idSuporte` é o **SUP_CODIGO** usado por `chamado-gravacao`."*

Logo: `numero` = número operacional que o cliente e o técnico enxergam;
`idSuporte` = chave primária interna. Para a AlfaOS, `idSuporte` é o candidato a
`externalId` e `numero` é dado de exibição.

### Campo exclusivo da URA — `existeChamadoPendenteIntegracao`

> *"1 quando este chamado aberto foi **criado por integração/API**; 0 quando veio
> de outro fluxo."*

É um discriminador de **procedência**. Distingue chamado nascido via API de
chamado nascido na interface do ReceitaNet. O CallCenter **não** expõe esse
campo. Relevante para a AlfaOS não reprocessar o que ela mesma criou — e é
indício direto de que o ReceitaNet mantém estado de integração por chamado.

### Experimentos já comprovados (fornecidos pelo operador)

| Experimento | Resultado |
|---|---|
| `/v1/chamados` com `idCliente` válido | array de chamados abertos |
| 1 chamado tipo 1 aberto | `/v1/chamados` = 1 registro; `isChamados[1]=1` |
| 2 chamados tipo 1 abertos | `/v1/chamados` = 2 registros; `isChamados[1]` **continuou 1** |
| Chamado de segunda categoria criado | apareceu como `tipo=2`; `isChamados[2]` foi a 1 |
| Único `tipo=2` finalizado | sumiu de `/v1/chamados`; flags de tipo 2 voltaram a 0 |
| `/v1/chamados` com corpo vazio | `success:false` — *"Cliente não localizado."* |

**Conclusões dos experimentos:**

- `isChamados` e `isSuportesAberto` são **flags de existência por tipo**, não
  contadores. As chaves 1/2/4/5 correspondem a valores de `tipo`.
- `/v1/chamados` reflete apenas chamados abertos — finalizar remove da lista.
- Sem `idCliente` não há listagem. **Este formato não é enumeração global.**

### Correlação com o OSNET

A documentação do OSNET diz que três tipos são encaminhados (Manutenção,
Instalação, Retirada de Equipamentos) e que o tipo **financeiro não é**. Os
experimentos observaram as chaves 1/2/4/5. A correspondência exata entre número
e rótulo **não está documentada em lugar nenhum** — é pergunta para o suporte,
não dedução.

---

## Descoberta global de OS

### RESPOSTA OFICIAL DO PROVIDER — 2026-08-25

> **Não existe atualmente API pública disponível para listar globalmente todas
> as OS da empresa.** A API atual permite consultar chamados/OS **por cliente
> conhecido**.

Isto encerra a investigação. A diferença em relação ao que já estava
documentado abaixo não é cosmética: "nenhuma das quatro APIs documenta isso"
deixava em aberto a possibilidade de um endpoint não publicado; a resposta do
suporte fecha essa porta.

**Consequências, todas obrigatórias:**

- **Não continuar procurando nem fuzzando endpoint global.** A pergunta foi
  respondida. Varredura de rota não documentada viola a §64 do PRD e, contra a
  API de um provider real, é tráfego que ninguém autorizou.
- **Isto é limitação conhecida do provider, não dívida do AlfaOS.** Não entra
  em backlog nem em lista de correção — não há o que corrigir do lado do
  AlfaOS.
- **As hipóteses abaixo ficam encerradas**, incluindo `Chatbot /debitos` como
  enumerador de clientes. Mesmo se funcionasse, varredura cliente a cliente não
  é descoberta: é N requisições por ciclo contra API de terceiro.
- **Quando o ReceitaNet liberar API ou feed global**, o AlfaOS **adiciona uma
  estratégia nova de descoberta** — sem substituir o motor de importação. As
  duas camadas respondem perguntas diferentes: descoberta diz *quais OS
  existem*, importação diz *como uma OS vira ServiceOrder*. Ver PRD §141.

O material abaixo permanece como registro de como se chegou a essa conclusão.

### COMPROVADO

- **Nenhuma das quatro APIs oferece listagem de chamados por empresa.** Todos os
  quatro endpoints de chamados (`CallCenter /v1/chamados`, `URA /chamados`,
  `Chatbot /chamados`, `Central /chamados`) exigem escopo de um único cliente ou
  assinante.
- **Nenhum endpoint read-only aceita `protocolo`, `numero` ou `idSuporte` como
  chave de consulta.** `idSuporte` aparece como parâmetro **apenas** em
  `chamado-gravacao`, que é mutante.
- **Não existe paginação nem filtro de data/status em nenhum endpoint de
  chamados.** Os parâmetros `page`, `status`, `data_inicio` e `data_fim` existem
  no Chatbot, mas pertencem a **`/debitos`** — financeiro, não OS.
- `/v1/chamados` tem teto documentado de **10 registros**.
- Nenhum spec menciona webhook, callback, fila ou push.

### DESCARTADO

- **Polling global via CallCenter.** Não há superfície para isso.
- **Consulta por protocolo/número da OS.** Não existe em nenhuma API.
- **`isChamados` / `isSuportesAberto` como contadores.** Refutado por
  experimento: dois chamados do mesmo tipo mantiveram a flag em 1.
- **Chatbot `/chamados` como alternativa.** Aceita exatamente `token`, `app` e
  `idCliente` — mesma limitação, com o agravante do token em query string.
- **Central do Assinante como fonte operacional.** Escopo do assinante, teto de
  3 registros, exige credencial do cliente final.

### HIPÓTESE

- **`Chatbot /debitos` como enumerador de clientes.** `cpfcnpj` está declarado
  `required: false`, e há `page` + `data_inicio`/`data_fim`. O schema `Debito`
  devolve `id`, `nome`, `login`. Se `cpfcnpj` for realmente opcional, isso
  permite enumerar a base de clientes paginada — e daí varrer `/v1/chamados`
  por cliente. **Não confirmado:** o spec do Chatbot marca até `token` como
  opcional, então a declaração não é confiável, e o teste exige token do tipo
  `chatbot`, que não temos.
  *Custo desta rota, se confirmada: N requisições por ciclo, N = número de
  clientes. Para 3.000 clientes isso é inviável como polling contínuo.*
- **`existeChamadoPendenteIntegracao` indica fila de integração interna.** O
  campo prova que o ReceitaNet marca chamados por procedência de API. Sugere
  estado de sincronização mantido do lado dele.

### AGUARDANDO RECEITANET

> **A pergunta 1 ("existe listagem global?") foi respondida: NÃO.** As
> perguntas abaixo continuam abertas, mas nenhuma delas bloqueia a v0.8 — a
> importação por cliente conhecido não depende de nenhuma.

- Existe integração OSNET documentada para terceiros, ou é partner-to-partner
  fechada?
- O registro `sistema_integracoes` aceita um tipo que dê escopo de empresa em
  chamados?
- O mecanismo ReceitaNet→OSNET é push, polling ou fila?

### Mecanismo OSNET — **DESCONHECIDO**

A documentação pública afirma sincronização automática bidirecional e existência
de API, mas **não descreve o mecanismo**. Não há menção pública a webhook,
callback, fila ou intervalo de polling.

Duas evidências circunstanciais, ambas insuficientes para concluir:

- O **"Botão ressincronizar OS"** implica que a sincronização pode falhar e
  precisa de reparo manual — mais compatível com push-com-retry do que com
  polling contínuo, que se autocorrigiria no ciclo seguinte.
- *"A API atualiza gradualmente"* sugere sincronização incremental, mas a frase
  é sobre **estoque**, não sobre OS.

Classificação honesta: **DESCONHECIDO**. Não há base pública para afirmar o
mecanismo.

---

## Questões para o suporte

Perguntas fechadas, cada uma derivada de uma lacuna concreta acima.

**Descoberta de OS**

1. ~~Existe algum endpoint, em qualquer das quatro APIs, que liste chamados de
   **toda a empresa** sem `idCliente`?~~ **RESPONDIDA em 2026-08-25: não
   existe.** A parte "está no roadmap?" segue sem resposta.
2. Existe consulta read-only por **protocolo** ou por **`idSuporte`**? Hoje
   `idSuporte` só aparece em `chamado-gravacao`, que é mutante.
3. `POST /v1/chamados` documenta *"até 10 chamados"*. O que acontece com o 11º?
   Há alguma forma de paginar ou de saber que houve truncamento?

**Semântica de campos**

4. Qual o significado de cada valor de `tipo` em `Chamado`? Os experimentos
   observaram 1, 2, 4 e 5. Qual corresponde a Manutenção, Instalação, Retirada
   de Equipamentos e Financeiro?
5. `isChamados` e `isSuportesAberto` (retornados em `/v1/cliente`): a leitura de
   que são flags de existência indexadas por `tipo`, e não contadores, está
   correta?
6. `existeChamadoPendenteIntegracao` existe na URA mas não no CallCenter. Pode
   ser exposto também no CallCenter? A semântica é a mesma?
7. Em `/v1/chamados`, `{"success": false, "message": "Nenhum chamado
   localizado."}` significa **zero chamados** ou alguma condição de erro?

**OSNET**

8. A integração ReceitaNet↔OSNET tem API documentada disponível para
   **terceiros**, ou é exclusiva entre ReceitaNet e OSNET?
9. O envio de OS ReceitaNet→OSNET é push (webhook/callback), polling do lado do
   OSNET, ou fila interna? Qual o intervalo, se houver?
10. O que exatamente o "Botão ressincronizar OS" dispara? Reenvia OS que
    falharam, ou é uma varredura completa?
11. O `sistema_integracoes` admite cadastrar um tipo de integração que receba OS
    da mesma forma que o OSNET recebe? Que requisitos isso teria?

**Chatbot**

12. Em `POST /debitos`, `cpfcnpj` é realmente opcional? Omitindo-o, a resposta
    traz débitos de **todos** os clientes da empresa, paginado?
13. O campo `id` em `Debito` é o mesmo `idCliente` usado nas demais rotas?

---

## Segurança

Regras observadas nesta investigação e obrigatórias em qualquer continuação:

- Nenhum endpoint mutante foi chamado. `abertura-chamado`, `chamado/gravacao`,
  `cobranca/enviar`, `notificacao-pagamento` e `cliente/reiniciar` permanecem
  intocados.
- Nenhum fuzzing de rota. Os valores válidos de `sistema_integracoes` não são
  públicos e **não devem ser adivinhados** — é pergunta para o suporte.
- Nenhum token, CPF/CNPJ, nome, endereço ou descrição de OS neste documento.
- O token público que aparece nos exemplos dos OpenAPI é material de
  documentação e **não** é credencial de nenhuma empresa.
- URA e Chatbot transportam o token em **query string**. Se algum dia forem
  usadas, isso é um risco a tratar explicitamente: URL entra em log de servidor,
  proxy, histórico e cabeçalho `Referer`.
- Central do Assinante exigiria credencial do cliente final. Fora de questão.

---

## `/v1/clientes.login` — usuário PPPoE

**Classificação: VALIDADO OPERACIONALMENTE. Confirmação do provider pendente.**

O campo `login`, devolvido por `/v1/clientes` e `/v1/cliente`, foi comparado
manualmente com o usuário PPPoE real de **3 clientes distintos**. Bateu nos
3/3.

O OpenAPI **não** declara essa semântica: descreve `login` apenas como o
login do cliente no provider. A igualdade é evidência de campo, não de
contrato — por isso está registrada como validada operacionalmente, e a
pergunta ao suporte continua aberta (§ *Questões para o suporte*).

A v0.7 usa esse campo como usuário da conexão PPPoE. Se o suporte
desmentir a equivalência, o impacto é conhecido e limitado: as conexões de
origem `RECEITANET` teriam o usuário errado, e as de origem `MANUAL`
estariam intactas por construção.

Nenhum outro campo foi promovido a credencial. Em particular, **não existe
senha PPPoE em nenhuma das quatro APIs** — a senha é derivada localmente
pela política da empresa ou digitada.

## Senha PPPoE — regra da Alfa Telecom

Política operacional declarada: **os 4 últimos dígitos do CPF**.

Implementada como `Company.pppoePasswordPolicy`, por empresa, com dois
valores: `MANUAL_ONLY` (default) e `DOCUMENT_LAST4`. O default não deriva
nada — uma empresa que nunca declarou política não passa a gerar senha por
omissão.

`DOCUMENT_LAST4` exige **exatamente 11 dígitos**. CNPJ tem 14 e não recebe
regra por analogia: a política declarada fala de CPF, e estendê-la
inventaria uma credencial que ninguém definiu. Documento ausente, curto ou
não numérico deixa a senha não configurada — estado legítimo.

**`MANUAL` nunca é sobrescrito.** É a regra que protege o caso real: a
maioria dos clientes segue a política, e uma minoria tem senha própria. Uma
sincronização ingênua apagaria justamente essas, sem deixar rastro.
`usernameSource` e `passwordSource` são independentes porque o caso comum é
misto — login do ERP, senha trocada à mão.

**A proteção exige senha GRAVADA.** `passwordSource` é uma coluna `NOT NULL`
com default `MANUAL`, então uma conexão criada pela automação sem senha
derivável — CNPJ, ou empresa em `MANUAL_ONLY` — nascia rotulada como manual
sem que ninguém tivesse digitado nada. A auditoria da v0.7.x encontrou o
efeito (PPPOE-01): quando o Chatbot trazia a credencial real, ela era
recusada, e o operador lia "definida à mão" sobre uma senha que não existia —
o técnico chegava ao cliente sem senha nenhuma.

Quem responde "existe segredo aqui?" é `credentialCiphertext`, que o schema
já define como nulo enquanto a senha não foi configurada. A procedência só é
lida quando há ciphertext. A regra não foi enfraquecida: sem senha gravada
não há trabalho humano a preservar, e a credencial real preenche o vazio.

Nada disso é enviado ao ReceitaNet, ao RADIUS ou ao roteador. É a
credencial **local** que o técnico usa.

## Telefone — o que existe e o que não existe

**Não há campo de telefone estruturado confiável** em nenhum schema
homologado do CallCenter. Nem `/v1/clientes`, nem `/v1/cliente`.

O que existe é uma **convenção de texto** dentro da `descricao` de
`/v1/chamados`, do tipo `Contato: <telefone>`, visível no próprio exemplo
do OpenAPI.

Consequências adotadas na v0.7:

- esse valor é o **contato daquele chamado**, não o telefone mestre do
  cadastro, e **nunca** é promovido a `Customer.phone`;
- é exibido em separado, rotulado como contato do chamado;
- o parser é deliberadamente estreito: exige o rótulo `Contato:`, aceita só
  10 ou 11 dígitos, e devolve nulo em qualquer dúvida. Falhar em extrair
  custa pouco — a tela mostra o cadastro. Extrair errado manda o técnico
  ligar para um estranho.

Na OS, a ordem é: `Customer.phone`, depois `Customer.secondaryPhone`, e
"Não informado" quando não há nenhum — nunca um travessão solto, que não
distingue campo vazio de tela quebrada.

## Chamados abertos — o que a v0.7 usa

`POST /v1/chamados` está implementado como **leitura**, exposto a
ADMIN/DISPATCHER e escopado por Ordem de Serviço (nunca por id de cliente,
que daria um oráculo de enumeração da carteira).

Duas armadilhas do contrato, ambas tratadas:

1. **Teto de 10, sem paginação.** A tela avisa quando a lista atinge o teto,
   em vez de apresentá-la como completa.
2. **`success:false` aqui significa ZERO, não erro.** É a mesma forma que em
   `/v1/clientes` é `INVALID_RESPONSE` desde a v0.6.1. Tratá-las igual
   transformaria “este cliente não tem chamado aberto”, que é o caso comum,
   num erro na tela. Coberto por regressão.

`idSuporte` (SUP_CODIGO) é a identidade; `numero` (SUP_NUMERO) é o número
visível da OS **no ReceitaNet**. Nenhum dos dois substitui
`ServiceOrder.number`, que é o número local do AlfaOS — são dois sistemas
numerando as próprias ordens.

`tipo` continua **sem rótulo**. O contrato declara um inteiro e não publica
o significado dos valores; a tela mostra o código. A correlação com os três
tipos que o OSNET recebe (Manutenção, Instalação, Retirada) permanece
hipótese, não mapeamento.

## O que a v0.7 deliberadamente NÃO fez

- Nenhuma sincronização global de OS. `/v1/chamados` é contexto de leitura;
  não cria, altera nem fecha Ordem de Serviço do AlfaOS.
- Nenhum endpoint mutante. `abertura-chamado`, `chamado/gravacao`,
  `cobranca/enviar`, `notificacao-pagamento` e `cliente/reiniciar` seguem
  intocados.
- Nenhuma linha de URA, Chatbot ou Central do Assinante.

---

## ReceitaNet Chatbot — homologação real

**Data:** 2026-08-25. Homologado contra a API real, em cliente real.

Esta seção separa três coisas que não podem ser confundidas:

| Rótulo | Significa |
|---|---|
| **COMPROVADO EMPIRICAMENTE** | Observado na API real e conferido contra a realidade do cliente. Não está no contrato publicado. |
| **DOCUMENTADO OFICIALMENTE** | Está no OpenAPI publicado. |
| **AINDA NÃO HOMOLOGADO** | Aparece na resposta, mas ninguém verificou o significado. |

### Forma da resposta — DOCUMENTADO OFICIALMENTE

`POST /clientes` devolve `success`, `msg` e `contratos`. Dentro de
`contratos`: `idCliente`, `idContrato`, `razaoSocial`, `login`, `senha`,
`coordenadas`, `telefones[]`, `endereco`, `servidor`, `contratoStatusDisplay`,
`isPromessaPagamento`, `contratoValorAberto`, `faturasEmAberto[]`, `email`,
`cpfCnpj`, `contratoStatus`, `existeChamado`, `isChamados`,
`clienteLiberadoConfianca`, `usouLiberacaoConfianca`, `logins[]`, `planos[]`,
`tecnologia`.

### Credencial PPPoE — COMPROVADO EMPIRICAMENTE

`contratos.logins[]` traz `login`, `senha` e `isPrincipal`.

Observado: `logins[0]` coincidiu com o par solto `contratos.login`/`senha`, e
`isPrincipal` era `true`.

**O achado que muda a arquitetura:** `contratos.senha` foi comparada com a
senha PPPoE real do cliente e conferiu — **num cliente cuja senha NÃO era os
4 últimos dígitos do CPF**. Ou seja, a API entregou corretamente justamente a
exceção à política padrão, que é o caso em que a derivação erraria e ninguém
perceberia até o técnico não conseguir conectar.

Consequência: `DOCUMENT_LAST4` deixou de ser fonte principal e virou
**fallback**. A ordem de confiança passou a ser:

1. `RECEITANET_CHATBOT` — credencial real do provedor;
2. `MANUAL` — o que uma pessoa digitou, nunca sobrescrito em silêncio,
   **nem pela credencial real**;
3. `AUTO_DOCUMENT_LAST4` — palpite derivado do CPF.

A seleção da conexão principal usa o campo `isPrincipal`, **nunca o índice**:
uma amostra em que o principal estava na posição 0 não é ordenação garantida,
e assumir a ordem entregaria a credencial errada no primeiro cliente fora do
padrão.

### Telefones — COMPROVADO EMPIRICAMENTE

`contratos.telefones[]` foi comparado com o telefone cadastral real e
conferiu. É fonte de telefone **mestre**, e tem precedência sobre a extração
do rótulo `Contato:` na descrição de chamado — que continua sendo contato
**daquela OS**, não do cadastro.

O código não assume quantidade: uma, várias ou nenhuma.

### Coordenadas — COMPROVADO EMPIRICAMENTE

`contratos.coordenadas` traz `x` e `y`. Verificação geográfica real:
**`x` é latitude, `y` é longitude** — os pontos caíram junto ao endereço do
cliente.

O mapeamento está fixado e testado porque a nomenclatura `x`/`y` torna a
inversão fácil de cometer, e invertida põe o cliente do outro lado do mundo.

Coordenada importada **não** é localização confirmada: confirmação por
técnico/GPS continua sendo processo separado.

### Endereço — DOCUMENTADO, com ressalvas de campo

`numero` pode vir nulo. Nunca é inventado e nunca vira a string `"null"` na
tela. `referencia` é preservada — é o que faz o técnico achar a casa quando
não há número.

### Servidor — PARCIALMENTE HOMOLOGADO

Em cliente OFFLINE testado: `servidor`, `profile`, `tipo` e `interface`
vieram preenchidos e conferidos manualmente. `ip` veio nulo; `mac`,
`idSerial` e `elementoRede` vieram vazios.

Todos são tratados como **nullable**. `tipo` **não** ganhou enum: o provider
não publica os significados.

### Planos — DOCUMENTADO, com armadilha de tipo

`planos[].valor` chega como **String** nesta API. `Number()` ingênuo aceitaria
`""` como `0` — e zero parece um plano gratuito. A normalização trata formato
brasileiro e devolve `null` para o que não for numérico.

### Segurança — o que esta API obriga

**A resposta contém senha de cliente em texto puro.** Regras adotadas:

- o corpo bruto nunca é logado, persistido ou devolvido a um chamador;
- existe UMA fronteira de normalização, e depois dela o objeto é descartado;
- a senha segue direto para a cifra da `CustomerConnection`;
- erros carregam código, nunca trecho do corpo — uma mensagem que ecoasse o
  payload vazaria a credencial num log;
- toda chamada é server-side.

**O token do Chatbot vai na QUERY STRING**, porque o contrato só aceita
assim. É pior que o header do CallCenter — URL entra em log de servidor,
proxy e histórico — e é limitação do provider, não escolha nossa. A mitigação
possível é a chamada nunca sair do servidor, que é o caso.

### Duas credenciais, dois ciclos de vida

O token do CallCenter não abre o Chatbot. O AlfaOS guarda as duas
separadamente, resolvidas por `(companyId, provider, kind)`.

O isolamento é **estrutural**: cada credencial é uma LINHA. Remover a do
Chatbot apaga uma linha e não tem como tocar a do CallCenter, porque não
existe escrita que alcance as duas. Foi o acoplamento oposto — credencial
como colunas de uma linha compartilhada — que já causou perda de token numa
troca de provider.

O AAD é versionado por linha. `v1` (empresa + provider) é o formato das
credenciais migradas, e mantê-lo é o que preserva o token que a empresa já
tinha configurado. `v2` inclui o `kind`: sem ele, as duas credenciais da
mesma empresa teriam AAD idêntico e seriam intercambiáveis — inaceitável
entre tokens com privilégios diferentes, já que o do Chatbot devolve senha de
cliente. Toda gravação nova é `v2`.

### Ainda pendente de confirmação do provider

Nada nesta seção está no OpenAPI como semântica declarada. Continuam
pendentes ao suporte:

- `logins[].senha` é sempre a senha PPPoE vigente, ou pode estar defasada?
- `isPrincipal` é garantidamente único por contrato?
- `coordenadas.x`/`y` são sempre latitude/longitude, nessa ordem?
- `servidor.tipo` — qual o conjunto de valores e o significado de cada um?
- `planos[].valor` — qual o formato numérico garantido?

---

## Estado da integração — v0.7.2

| Capability | API | Credencial | Situação |
|---|---|---|---|
| Busca de cliente | CallCenter | `CALLCENTER` | Implementado |
| Detalhe do cliente | CallCenter | `CALLCENTER` | Implementado |
| Verificar acesso (ONLINE/OFFLINE) | CallCenter | `CALLCENTER` | Implementado |
| Chamados abertos | CallCenter | `CALLCENTER` | Implementado (leitura) |
| Enriquecimento do cadastro | Chatbot | `CHATBOT` | **Implementado (v0.7.2)** |
| Credencial PPPoE real | Chatbot | `CHATBOT` | **Implementado (v0.7.2)** |
| Sincronização de OS por cliente | CallCenter | `CALLCENTER` | **Implementado (v0.8)** |
| Descoberta global de OS | — | — | **NÃO EXISTE** — limitação do provider (§141) |

Campos que o enriquecimento aplica: nome, endereço completo (com
referência), telefones, e-mail, coordenadas, `idContrato` e a credencial
PPPoE.

Campos que o Chatbot devolve e o AlfaOS **não persiste**: plano, servidor,
profile, interface, IP, MAC, tecnologia. São dados voláteis — persistir
produziria cadastro velho apresentado como atual. Ficam disponíveis por
leitura ao vivo no bloco operacional da OS.

Nenhuma operação mutante do ReceitaNet foi implementada em nenhuma das duas
APIs.

---

## Sincronização de OS — v0.8, IMPLEMENTADA

Escopo do PRD §142. Esta seção é o recorte de provider.

**Por cliente conhecido, e só.** A limitação continua exatamente onde
estava: não existe API pública para listar as OS da empresa, o suporte
confirmou, e a v0.8 **não** a contorna. Nada de varrer ids, chamar
`/v1/chamados` sem `idCliente` ou explorar rota não homologada.

**Direção única.** Leitura para dentro do AlfaOS. Nenhuma rota mutante do
ReceitaNet é chamada — `abertura-chamado`, `chamado/gravacao`,
`cliente/reiniciar`, `cobranca/enviar` e `notificacao-pagamento` seguem
intocados. Devolver a execução ao provedor depende de homologação que
ainda não existe.

**Depois de importada, a execução é do AlfaOS.** O provedor é a origem do
chamado, não a autoridade sobre o atendimento: uma nova sincronização
atualiza apenas campos do provedor e nunca toca técnico, status,
execução, evidências, materiais, assinatura ou timeline.

**Ausência não é fechamento.** Um chamado que some da resposta seguinte
não é cancelado, concluído nem apagado — `/v1/chamados` só devolve
abertos, tem teto de 10 e pode omitir.

```text
cliente conhecido  →  CallCenter POST /v1/chamados  →  ServiceOrder EXTERNAL
```

### Mapeamento de identidade

| Campo AlfaOS | Campo ReceitaNet |
|---|---|
| `externalProvider` | `RECEITANET` |
| `externalId` | `idSuporte` |
| `externalNumber` | `numero` |
| `externalProtocol` | `protocolo` |

**`ServiceOrder.number` continua sendo o número local do AlfaOS.** O `numero`
do ReceitaNet **nunca** vira chave primária nem número local — vai para
`externalNumber` como dado do provider. Número de terceiro usado como
identidade local é impossível de garantir único e colide no dia em que um
segundo provedor for integrado.

**`idSuporte` é obrigatório, e um lote sem ele é recusado inteiro.** O schema
`Chamado` o declara como inteiro, e o AlfaOS aceita exatamente isso: inteiro
positivo. String numérica, `null`, vazio, objeto, booleano, zero, negativo e
fracionário são recusados — não há normalização nem fallback, e nem `numero`,
nem `protocolo`, nem a posição no array substituem a identidade.

Uma linha inválida invalida a **resposta inteira**: `INVALID_RESPONSE`, zero
OS criadas, zero atualizadas, zero eventos. Não existe importação parcial.
Aproveitar as linhas boas deixaria o operador com uma sincronização
“bem-sucedida” cujo conteúdo ninguém consegue descrever.

O motivo é concreto, e a auditoria da v0.8 o reproduziu (SYNC-01). Antes da
guarda, `String(row.idSuporte)` transformava `undefined` na string
`"undefined"`. Como `customerId` **não** faz parte da unique, dois chamados de
**clientes diferentes** da mesma empresa colidiam nessa chave: o segundo
atualizava a OS do primeiro, e a tela mostrava o cliente A com o problema de
B. Um técnico sairia para o endereço errado.

*Risco assumido:* se o provider passar a enviar `idSuporte` como string, a
sincronização falha inteira em vez de degradar. É deliberado — falha barulhenta
e de conserto trivial vale mais que identidade adivinhada.

### Idempotência

```text
companyId + externalProvider + externalId
```

### Armadilhas que já valem para esta rota

As duas já documentadas acima passam a ser requisito de implementação, não
curiosidade:

- **`success: false` em `/v1/chamados` significa ZERO RESULTADOS**, não erro.
  Tratá-lo como falha faria toda importação de cliente sem chamado aberto
  parecer indisponibilidade do provider.
- **Teto de 10 registros, sem paginação e sem sinal de truncamento.** Um
  cliente com mais de 10 chamados abertos importa incompleto **em silêncio**.
  A pergunta 3 ao suporte segue aberta; até lá, o comportamento precisa ser
  tratado como limite conhecido e visível ao operador.

### Campos recebidos e NÃO usados

Dois campos do chamado chegam e são deliberadamente descartados. O
normalizador os expõe (`typeCode`, `forecast`) e a v0.8 não os lê:

| Campo | Por que não é usado | Onde fica |
|---|---|---|
| `tipo` | Inteiro sem tabela de significado publicada. Traduzir para “Instalação” inventaria semântica. A OS recebe o rótulo fixo `Chamado ReceitaNet` e `typeId` nulo. | **Em lugar nenhum** |
| `data_previsao` | Previsão do provider não é compromisso combinado com o cliente. Virar `scheduledAt` faria a agenda exibir horários que ninguém marcou. `scheduledAt` fica nulo. | **Em lugar nenhum** |

**Nenhum dos dois é persistido** — nem em coluna, nem no metadata do evento de
importação. Comentários anteriores no código afirmavam que ficavam no metadata;
não ficavam, e a auditoria da v0.8 registrou a divergência (SYNC-02). Guardá-los
exigiria estrutura nova para valores sem semântica homologada, e dado que
ninguém sabe ler não fica melhor por estar salvo.

Se o ReceitaNet publicar a tabela de `tipo`, isto vira decisão nova — não
dívida escondida.

### Re-sincronização: no-op não escreve

Uma releitura que traz exatamente os mesmos campos do provider **não gera
`UPDATE`**. `version` e `updatedAt` ficam onde estavam, e o desfecho é
`unchanged`, distinto de `updated`.

Não é economia de escrita: `version` é o token do compare-and-set. Movê-lo sem
mudança real fazia a atribuição de um despachante — que leu a tela antes da
sincronização — falhar com **409** por uma sincronização que não mudou nada
(SYNC-03).

Mudança real do provider continua incrementando `version`. É exatamente aí que
o CAS precisa invalidar as leituras anteriores, e essa proteção não foi
enfraquecida.

### O que a v0.8 NÃO faz

- Descoberta global de OS. Não existe (§141 do PRD).
- Nenhuma operação mutante. `abertura-chamado` e `chamado/gravacao` continuam
  intocados.

---

## Capabilities — estado consolidado

```text
empresa
 ├── credencial CALLCENTER   →  busca · detalhe · diagnóstico · chamados do cliente
 └── credencial CHATBOT      →  enriquecimento · PPPoE · contexto operacional
```

As duas credenciais são **independentes por empresa**: configurar, trocar ou
remover uma não afeta a outra. **Não existe fallback entre elas** — hosts,
autenticação e schemas são diferentes, e um fallback silencioso apresentaria
dado de uma API como se fosse da outra.

Uma empresa operando com só uma das duas é estado normal, não erro.

Detalhe de armazenamento, AAD e fronteira do plaintext: `docs/SECURITY.md` §8.7.

# SGP (TSMX) — inventário da API oficial

Levantamento do provider **SGP**, feito para o planejamento `ERP-0R`.

> **Estado desde a `SGP-1`.** `ERPProvider.SGP` existe, o `SgpClient` e o
> `SgpAdapter` existem, e o AlfaOS **fala com o SGP** — mas somente para
> `testConnection`, pela sonda da §8. Nenhuma capability de negócio foi
> implementada: busca de cliente, contratos, financeiro, OS, FTTH e CPE seguem
> apenas documentados aqui. Registro da entrega em
> `docs/ERP-INTEGRATIONS.md` §29.

**Regra desta página:** só entra o que a documentação oficial sustenta. Onde a
fonte oficial não cobre, está escrito `NÃO DOCUMENTADO` — e isso vale como
resultado, não como convite a supor. Endpoint não é adivinhado a partir de
padrão de nomenclatura.

## 1. Fontes consultadas

Consultadas em 2026-09-02 e **revalidadas ao vivo em 2026-09-03**.

| Fonte | O que é | Papel |
| --- | --- | --- |
| `bookstack.sgp.net.br/books/api/page/autenticacoes-via-api` | BookStack do fabricante | **oficial** — métodos de autenticação |
| `bookstack.sgp.net.br/books/api/page/integracao-gateway-generica` | BookStack do fabricante | **oficial** — webhook de gateway |
| `www.tsmx.net.br/developers` | site do fabricante (TSMX) | **oficial** — sandbox e recursos em destaque |
| `documenter.getpostman.com/view/6682240/2sB34hHg2V` | coleção Postman **linkada pelo site oficial** | **oficial** — 275 requisições catalogadas |

A coleção do Postman foi lida programaticamente pelo JSON, não por leitura de
tela: **275 requisições em 14 pastas raiz** — URA (70), Central Assinante (34),
Central Assinante NOVA (34), Estoque (33), FTTH (29), Ordem de Serviço (26),
CRM (13), Gerenciador CPE (12), Suporte (9), Pré-Cadastro (5), RADIUS (5),
Remessa (2), Termo de Aceite (2), Outros (1).

Fontes de terceiros (blogs, documentação de integradores) foram encontradas e
**não** são citadas como autoridade.

## 2. Autenticação

Três métodos documentados:

| # | Método | Onde trafega | Uso |
| --- | --- | --- | --- |
| 01 | **Basic** (usuário/senha do SGP) | header `Authorization`, base64 | usuário real do SGP, sujeito às permissões dele |
| 02 | **Token + App** | **corpo** da requisição | *"o método mais seguro e recomendado para a API"* |
| 03 | **CPF/CNPJ + senha da Central** | corpo da requisição | credencial do **cliente final** |

**O AlfaOS usa o método 02.** O 01 amarra a integração a um usuário humano com
senha rotacionável e permissões amplas; o 03 é credencial do assinante e não tem
lugar numa integração servidor-a-servidor.

### O token vai no CORPO, não no header

Diferença estrutural em relação ao ReceitaNet, que usa o header `token`. No SGP,
`token` e `app` são **parâmetros da requisição**, e a tabela oficial marca os
dois como **obrigatórios**:

```text
app     string   Nome da Aplicação no SGP   (obrigatório)
token   string   Token da Aplicação no SGP  (obrigatório)
```

Consequência para o cliente HTTP: **nunca montar esses campos em query string**.
Uma URL entra em log de servidor, proxy, histórico e `Referer`, e o token do SGP
é credencial de escrita.

### Contradição entre duas fontes oficiais — não resolvida

| Fonte | Caminho para gerar o token |
| --- | --- |
| BookStack | `Administração -> Integrações -> Tokens` |
| descrição da coleção Postman | `Sistema -> Ferramentas -> Painel Admin -> Tokens` |

Ambos reconfirmados ao vivo. Provavelmente é diferença de versão do SGP. **Não
escolhemos uma**: quem configurar procura nos dois lugares. É informação de
operador, não de código.

### `App` não é segredo — mas o par é

O `App` é o **nome da aplicação** cadastrada no SGP; a documentação o trata como
identificador (*"você pode ter vários tokens com um mesmo App"*). O segredo é o
**Token**. Ainda assim o AlfaOS nunca devolve o token ao navegador (§7).

### Uma segunda superfície, `/api/v1/` — QUESTÃO ABERTA

O site oficial da TSMX mostra um exemplo que **não** corresponde à coleção:

```bash
curl -X GET "https://sandbox.sgp.net.br/api/v1/assinantes" -H "Authorization: ..."
```

Namespace `/api/v1/` com credencial em **header**, e o recurso `assinantes` — que
não aparece em nenhuma das 275 requisições catalogadas (lá o cliente é
`/api/ura/clientes/`). Reconfirmado ao vivo.

**Hipótese, não conclusão:** há uma API nova convivendo com a legada. Não
alcancei documentação pública dela.

**Decisão da `SGP-1`, tomada e registrada:** a superfície **ADOTADA** é a
documentada e catalogada — `/api/ura/`, `/api/os/`, `/api/fttx/`,
`/api/estoque/`, com Token e App no corpo. É a única com 275 requisições
descritas, exemplos de resposta e tabela de parâmetros.

A `/api/v1/` fica **`NOT ADOPTED / NEED VALIDATION`**. Em particular, **não se
assume que o token de uma vale na outra**: são esquemas de autenticação
diferentes (corpo × header), e tratá-los como equivalentes é justamente o tipo de
suposição que esta página existe para não fazer. Segue como pergunta ao
fornecedor (§11).

## 3. Base URL — por tenant, obrigatoriamente

Cada provedor tem sua própria instalação do SGP, em domínio próprio. A `baseUrl`
**não** pode ser constante do código, ao contrário do ReceitaNet, cujo host é o
mesmo para todos.

`ERPIntegration.baseUrl` já existe e já é usada como sobreposição opcional. Para
o SGP ela deixa de ser opcional: **sem `baseUrl` e sem `app` não há adapter SGP
utilizável**, e a recusa acontece na construção — como `getERPAdapter` já faz
com o token do ReceitaNet, *"onde a causa ainda é óbvia"*.

## 4. Inventário de endpoints

Extraído da coleção oficial.

### 4.1 Cliente

| Capability | Método | Path | Parâmetros relevantes | Paginação |
| --- | --- | --- | --- | --- |
| busca/listagem | `POST` | `/api/ura/clientes/` | `cliente_id`, `cpfcnpj`, `cliente_nome`, `plano`, `login`, `contrato`, `status`, `telefone`, `pop`, `contrato_status`, `cto`, `cto_porta`, `exibir_conexao`, `omitir_contratos`, `omitir_titulos`, janelas de data | `offset` / `limit` |
| consulta pontual | `POST` | `/api/ura/consultacliente/` | `cpfcnpj`, `contrato`, `nome`, `login`, `email`, `telefone`, `mac_controle`, `mac_dhcp`, `servico_serial`, `onu_serial` | não catalogada |
| listagem resumida | `POST` | `/api/ura/listacliente/` | `pop`, `status`, janela de data, `tipo` | não catalogada |

**Dois endpoints de cliente, e a diferença importa.** `consultacliente` é a
consulta dirigida; `clientes` é a listagem com filtro e paginação, e é a única
com `offset`/`limit`. A busca do operador mapeia em `consultacliente`; sync em
lote futuro usa `clientes`.

### 4.2 Contrato

| Método | Path | Observação |
| --- | --- | --- |
| `POST` | `/api/ura/listacontrato/` | filtros `contrato`, `plano`, `tipo`, `status`, `exibir_endereco` |
| `GET` | `/api/contratos/print/{tipo_contrato}` | impressão |
| `GET` | `/api/ura/consultaplano/` | catálogo de planos (`token`, `app`) |

### 4.3 Financeiro

| Método | Path | Natureza |
| --- | --- | --- |
| `POST` | `/api/ura/titulos/` | **leitura** — lista faturas, com `offset`/`limit` |
| `POST` | `/api/ura/fatura2via/` | **efeito colateral** — tem `nao_gerar_os` |
| `POST` | `/api/ura/pagamento/pix/{fatura}` | mutante |
| `POST` | `/api/ura/enviafatura/` | mutante — envia ao cliente |
| `POST` | `/api/banco/titulo/{id}/baixar/` · `/estornar/` · `/cancelar/` | **mutantes financeiros destrutivos** |
| `POST` | `/api/ura/acordopagamento` | mutante financeiro |

**`fatura2via` não é leitura.** O nome sugere consulta; o parâmetro
`nao_gerar_os` denuncia que ela pode **abrir OS** no SGP. Nunca usá-la como
sonda de conexão.

### 4.4 Ordem de serviço

| Método | Path | Natureza |
| --- | --- | --- |
| `POST` | `/api/os/list/` | **leitura — listagem global**: `filtro_data`, `agendamento_inicial`/`final`, `pop_id`, `contrato_id`, `cliente_id`, `status_encerrada`, `orderby` |
| `POST` | `/api/os/list/total/` · `/api/os/list/id/{os_id}` | leitura |
| `GET` | `/api/os/{os_id}/checklist/list/` · `/api/os/imagem/id/{os_id}/list/` | leitura |
| `GET` | `/api/os/ocorrencia/{motivo,metodo,tipo,setor}/list/` | leitura — tabelas de domínio |
| `POST` | `/api/os/update/id/{os_id}/` | **mutante** — `os_status`, `checkin_*`, `assinatura_*` |
| `POST` | `/api/os/acaminho/id/{os_id}/` | mutante |
| `PUT` | `/api/os/imagem/id/{os_id}/add/` | mutante |

### 4.5 Rede e diagnóstico

| Método | Path | Natureza |
| --- | --- | --- |
| `GET` | `/api/cpemanager/servico/{id}/infodetail` · `/wifi/list/` | leitura |
| `POST` | `/api/cpemanager/servico/{id}/command/ping/` | **executa comando** no equipamento |
| `GET` | `/api/fttx/onu/{id_onu}/info/` · `/api/fttx/onu/{id_onu}/` · `/api/fttx/onu/list/` | leitura — ONU |
| `GET` | `/api/fttx/olt/list/` · `/api/fttx/olt/{id}/pon/list/` | leitura — OLT e PON |
| `GET` | `/api/fttx/splitter/all/` · `/api/fttx/splitter/{id}/` · `/api/fttx/splitter/{cto_id}/onu/all/` | leitura — **CTO** |
| `GET` | `/api/fttx/onu/{id}/reset/` · `/deauth/` | **mutante**, apesar de `GET` |

**Atenção ao verbo.** `GET /api/fttx/onu/{id}/reset/` e `.../deauth/` **derrubam
ou removem uma ONU**. Método HTTP não é garantia de segurança nesta API, e
nenhuma regra do tipo *"só `GET` é seguro"* pode ser escrita no adapter.

### 4.6 Estoque e equipamento

Vinte e um `GET` de leitura, entre eles `/api/estoque/comodato/list/`,
`/api/estoque/comodatoitens/list/`, `/api/estoque/produto/list/` e
`/api/estoque/estoque_agregado_referencias/list/`.

## 5. O que o SGP tem e o ReceitaNet não

Três diferenças com efeito em seções já escritas. **Nenhuma promove nada.**

**Descoberta global de OS.** `POST /api/os/list/` lista OS da empresa por
período, sem exigir cliente conhecido. A **§141 do PRD** continua correta — o
ReceitaNet **não** oferece isso, por resposta oficial do suporte. E a §141 já
previu o caso: *"o AlfaOS adiciona uma estratégia nova de descoberta — sem
substituir o motor de importação já existente"*. O SGP encaixa exatamente aí; o
motor idempotente da v0.8 não é refeito.

**CTO.** `/api/fttx/splitter/all/` e os filtros `cto`/`cto_porta`. A **Parte XIII
do PRD** partiu da premissa de que **não havia fonte** de topologia, porque o
FiberMap é `FUTURO` sem código. Para uma empresa em SGP essa premissa não vale.
**Isto não altera a Parte XIII**: a §334 já definiu que a fronteira é
**precedência**, não proibição. Registrado para que a decisão seja tomada com o
fato à vista.

**ONU, OLT, PON e CPE** existem como endpoints documentados no SGP. A afirmação
de `docs/ERP-INTEGRATIONS.md` §1 sobre esses dados é sobre o **ReceitaNet**.

## 6. Mapeamento SGP → AlfaOS (proposto, não implementado)

Campo a campo só é possível contra resposta real. O que segue é a identidade:

```text
cliente SGP            → Customer
  id do cliente        → Customer.externalId          (externalProvider = SGP)
  contrato             → Customer.externalContractId
  cpfcnpj              → Customer.document
  login                → dado de conexão, NUNCA credencial de acesso ao AlfaOS

OS do SGP              → ServiceOrder
  os_id                → ServiceOrder.externalId      (externalProvider = SGP)
  número visível       → ServiceOrder.externalNumber
  ServiceOrder.number  → SEMPRE local, gerado pelo AlfaOS
  origin               → EXTERNAL
```

**`Customer.externalId` recebe o identificador do CLIENTE, não o do contrato** —
mesma regra do ReceitaNet (`idCliente`). Um cliente do SGP com vários contratos
continua sendo **um** `Customer`.

O `status` do SGP **não** é traduzido por semelhança de nome. Ou existe tabela de
domínio documentada, ou a tradução é explícita e conservadora — a mesma
disciplina que fez o AlfaOS gravar o código cru de `tecnologia` do ReceitaNet.

## 7. Segredo

| Dado | Classificação | Onde vive |
| --- | --- | --- |
| `token` | **SEGREDO** | `ERPCredential`, AES-256-GCM, AAD por tenant |
| `app` | configuração | claro, mas nunca exibido junto do token |
| `baseUrl` | configuração por tenant | claro |

O token **nunca**: volta ao navegador, vai para o Flutter, entra em `AuditLog`,
aparece em log, em mensagem de erro ou em URL. Só os **últimos 4 caracteres** são
exibidos, pelo mecanismo que já existe.

## 8. Teste de conexão — endpoint candidato

Precisa ser **autenticado e sem efeito colateral**. Descartados: `fatura2via`
(pode gerar OS), `/api/os/list/` (cara do outro lado), qualquer
`/api/banco/titulo/...` (financeiro) e `cpemanager/.../command/ping/` (o nome
engana: executa comando em equipamento).

**ADOTADA na `SGP-1`: `POST /api/ura/planoscontas/`.**

A recomendação anterior era `GET /api/ura/consultaplano/`. A reconfirmação na
coleção oficial mostrou que ele é **`GET` com corpo `form-data`** — e um `GET`
com corpo é descartado por proxies e por vários clientes HTTP. A única
alternativa seria `token`/`app` na query string, que é o que não se faz com um
segredo.

`planoscontas` é **`POST`**, recebe exatamente `token` e `app`, e devolve
`[{ id, codigo, descricao }]` — plano de contas, sem cliente, sem valor e sem
PII. Autenticado, somente leitura, e sem parâmetro capaz de disparar efeito.

Descartados, com motivo: `fatura2via` tem `nao_gerar_os` e pode **abrir OS**;
`cpemanager/.../command/ping/` executa comando em equipamento; e
`consultacliente` exigiria enviar o documento de uma pessoa real só para saber
se o token vale.

## 9. Fora de escopo — mutantes

Nenhum destes entra sem fase própria: liquidar, estornar e cancelar título ·
gerar PIX · enviar fatura · acordo de pagamento · liberação por confiança ·
alterar contrato · alterar status de contrato · alterar senha de serviço · criar
chamado · alterar OS · "a caminho" · anexar imagem em OS · resetar ou remover
ONU · configurar WAN/WiFi do CPE · qualquer escrita de estoque.

## 10. Limites e lacunas

| Assunto | Situação |
| --- | --- |
| **Rate limit** | `NÃO DOCUMENTADO`. Nenhuma fonte oficial publica teto, janela ou header de quota. |
| **Restrição de host/rota do token** | `NÃO DOCUMENTADO` no texto. As telas aparecem como imagem, e imagem não é fonte legível. `NEED SGP ACCESS`. |
| **Usuário associado ao token** | `NÃO DOCUMENTADO` no texto. Mesma ressalva. |
| **Permissões granulares do token** | `NÃO DOCUMENTADO`. A página descreve permissões do método **Basic**, não do Token/App. |
| **Paginação** | `offset`/`limit` em `/api/ura/clientes/` e `/api/ura/titulos/`. Sem cursor. |
| **Delta / `updatedAt`** | `/api/ura/clientes/` tem `data_alteracao_inicio`/`fim`. É o mais próximo de sync incremental que a documentação oferece. |
| **Webhook geral** | **Não existe.** Ver §12. |
| **Formato de erro** | não catalogado de forma sistemática. |
| **`GET` com corpo** | várias requisições catalogadas enviam `token`/`app` no **corpo de um `GET`**. Proxies e clientes HTTP descartam corpo em `GET`. Risco real de transporte — confirmar se aceitam query ou se são de fato `POST`. |

## 11. Perguntas ao fornecedor

1. `/api/v1/` do sandbox convive com `/api/ura/`, substitui, ou é outro produto?
2. Existe teto de requisições? Qual, e ele responde `429`?
3. Token/App aceita restrição de host/rota e associação a usuário? Onde?
4. Os `GET` que a coleção mostra com corpo aceitam `token`/`app` em query?
5. `GET /api/ura/consultaplano/` é aceitável como sonda periódica de conexão?
6. Existe tabela de domínio publicada para `os_status` e `contrato_status`?
7. Existe webhook para cliente, contrato ou OS — fora da gateway genérica?

## 12. Webhooks — a Gateway Genérica NÃO é webhook de ERP

A documentação descreve a **Integração Gateway Genérica**: o SGP dispara `POST`
para uma URL configurada, com as ações `cadastrar`, `atualizar`, `alterar_plano`
e `alterar_status`.

Parece um barramento de eventos de cliente. **Não é.** Configura-se em
`Sistema → Gateways → Gateway Outros`, e só dispara para **contratos do tipo
Serviço com aquela gateway vinculada**, carregando `Gateway ID` e
`Gateway Extra`. Quem recebe deve responder 200/201/204 e pode devolver
`gateway_id`/`gateway_params_extra`, que o SGP grava de volta no contrato. É
protocolo de **provisionamento de serviço**, com o receptor no papel de gateway.

Tratá-la como "webhook de mudança de cliente" seria exigir do provedor uma
configuração de faturamento que ele não fez para isso, receber eventos só de um
subconjunto de contratos, e o AlfaOS assumir um papel de provisionamento que não
desempenha.

**Não há webhook geral.** Sincronização, quando existir, é **polling** com
`data_alteracao_*` e `offset`/`limit` — e isso é fase posterior.

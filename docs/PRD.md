# AlfaOS — Product Requirements Document

**Produto:** AlfaOS  
**Documento:** PRD Mestre 2.0  
**Objetivo:** Fonte principal de contexto funcional e técnico para desenvolvimento assistido por IA  
**Status atual:** Baseline `v0.5-receitanet-diagnostics` (commit `e4fc701`), auditada e endurecida. Core operacional fechado ponta a ponta: criação, atribuição, execução, fechamento com evidências e diagnóstico de conectividade.  
**Arquitetura:** SaaS multiempresa preparado para múltiplos ERPs  
**Primeiro cliente:** Alfa Telecom  
**Premissa central:** o AlfaOS é o sistema de execução e gestão operacional das Ordens de Serviço. ERPs são origem, fonte de dados do cliente ou destino de sincronização — nunca o motor operacional. Ver Parte III (seções 121+).  
**Produto futuro:** SaaS comercial para provedores de internet e empresas com equipes técnicas — plataforma operacional completa (Core + Field App + Technician Toolkit + Network Intelligence), não apenas um sistema de abertura/fechamento de OS.

> Este documento representa a **visão do produto**. Ele não autoriza implementação automática de nenhuma funcionalidade — ver seção 119 "Princípio de Escopo". A Parte II (seções 72–120) registra a visão de longo prazo com classificação explícita de prioridade; a Parte I (seções 1–71) permanece a base funcional/técnica do Core já em desenvolvimento; a Parte III (seções 121+) fixa a propriedade da Ordem de Serviço, a posição dos ERPs e a arquitetura de geolocalização e mapa operacional.

---

# 1. VISÃO DO PRODUTO

O AlfaOS é uma plataforma de gestão e execução de **Ordens de Serviço** destinada inicialmente a provedores de internet.

O AlfaOS **não será inicialmente um ERP completo**.

Seu propósito principal é ser a camada operacional entre:

- ERP;
- equipe administrativa;
- despachantes;
- técnicos de campo;
- clientes.

O ERP continuará responsável por cadastro principal, financeiro e demais funções administrativas.

O AlfaOS será responsável pela execução operacional das Ordens de Serviço.

Fluxo principal:

```text
ERP
 ↓
AlfaOS
 ↓
Despachante
 ↓
Técnico
 ↓
Execução
 ↓
Fechamento
 ↓
ERP
```

O primeiro ERP integrado será o **ReceitaNet**.

Entretanto, o AlfaOS deve permanecer independente de qualquer ERP específico.

---

# 2. PROBLEMA QUE O ALFAOS RESOLVE

Provedores de internet normalmente possuem ERPs muito completos, porém a experiência operacional do técnico frequentemente é limitada.

O AlfaOS deverá oferecer uma experiência moderna para:

- receber OS;
- organizar OS;
- distribuir técnicos;
- executar serviços;
- registrar evidências;
- controlar materiais;
- acompanhar produtividade;
- coletar assinatura;
- fechar atendimento;
- sincronizar o resultado com o ERP.

O objetivo é reduzir:

- papel;
- WhatsApp para organização de OS;
- informações perdidas;
- fechamento incorreto;
- falta de evidência;
- deslocamentos desnecessários;
- falta de controle dos técnicos;
- trabalho duplicado entre sistemas.

---

# 3. VISÃO DE LONGO PRAZO

> O técnico deve conseguir realizar praticamente todo o atendimento sem sair do AlfaOS.

O AlfaOS não deve ser apenas um sistema para abrir e fechar Ordem de Serviço. Ele deve evoluir para uma **plataforma operacional completa** para equipes técnicas de provedores de internet — ver Parte II (seção 72 em diante) para o detalhamento completo dessa visão, incluindo Field App Flutter, Technician Toolkit e Network Intelligence.

O AlfaOS deverá evoluir de um aplicativo simples de OS para uma plataforma operacional completa.

Futuramente poderá conter:

- Ordens de Serviço;
- técnicos;
- clientes;
- GPS;
- roteirização;
- estoque por técnico;
- almoxarifado;
- medição óptica;
- testes de velocidade;
- fotos;
- assinatura digital;
- checklists;
- SLA;
- relatórios;
- produtividade;
- comunicação entre técnicos;
- notificações;
- IA;
- integrações com OLT;
- integrações com diversos ERPs.

Porém essas funcionalidades deverão ser adicionadas progressivamente.

Nunca transformar o projeto em um monólito de funcionalidades sem controle.

---

# 4. PRINCÍPIO DO MVP

O AlfaOS 1.0 deverá fazer uma coisa extremamente bem:

> Receber uma Ordem de Serviço, entregar ao técnico, permitir sua execução e devolver um fechamento confiável ao ERP.

Qualquer funcionalidade que não contribua diretamente para esse fluxo deverá ser avaliada para versões posteriores.

---

# 5. USUÁRIOS E PERFIS

Perfis iniciais:

```text
ADMIN
DISPATCHER
TECHNICIAN
```

## ADMIN

Responsável pela administração da empresa.

Pode:

- acessar dashboard;
- gerenciar usuários;
- gerenciar técnicos;
- visualizar clientes;
- visualizar todas as OS;
- atribuir OS;
- visualizar integrações;
- configurar integrações;
- consultar auditoria;
- acessar configurações.

---

## DISPATCHER

Responsável pela operação e despacho das OS.

Pode:

- acessar dashboard operacional;
- consultar clientes;
- visualizar técnicos;
- visualizar todas as OS;
- criar OS manual;
- atribuir técnico;
- trocar técnico;
- acompanhar andamento.

Não deve possuir acesso a configurações críticas.

---

## TECHNICIAN

Responsável pela execução da OS em campo.

Pode:

- acessar Minhas OS;
- visualizar somente OS atribuídas a ele;
- visualizar dados necessários do cliente;
- iniciar atendimento;
- registrar diagnóstico;
- registrar serviço executado;
- adicionar materiais;
- adicionar fotos;
- coletar assinatura;
- finalizar OS.

Não pode administrar outros usuários ou técnicos.

---

# 6. MULTIEMPRESA

O AlfaOS deverá nascer como uma aplicação **multi-tenant**.

Cada empresa possui seus próprios:

- usuários;
- técnicos;
- clientes;
- OS;
- integrações;
- anexos;
- materiais;
- eventos;
- auditoria.

Entidades operacionais deverão utilizar:

```text
company_id
```

## REGRA ABSOLUTA

Empresa A jamais poderá:

- listar;
- consultar;
- alterar;
- excluir;
- vincular;
- inferir;

dados da Empresa B.

O isolamento deve existir no **servidor e banco**, nunca apenas no frontend.

---

# 7. COMPANY_ID

Nunca confiar em:

```text
company_id
```

enviado pelo navegador.

A empresa deve ser derivada da sessão autenticada.

Exemplo conceitual:

```text
session
 ↓
user
 ↓
companyId
```

Esse valor será utilizado para todas as queries.

---

# 8. STACK PRINCIPAL

Stack aprovada:

## Aplicação

```text
Next.js
TypeScript
Tailwind CSS
```

## Banco

```text
PostgreSQL
```

## ORM

```text
Prisma
```

## Testes

```text
Vitest
Playwright
```

## Versionamento

```text
Git
GitHub privado
```

---

# 9. ARQUITETURA

O sistema deve manter separação clara entre:

```text
UI
 ↓
API / Server
 ↓
Services / Application
 ↓
Domain Rules
 ↓
Data Access
 ↓
PostgreSQL
```

Componentes React não devem concentrar regras críticas de negócio.

---

# 10. ESTRUTURA MODULAR

Estrutura conceitual:

```text
src/
 ├ app/
 ├ components/
 ├ lib/
 ├ integrations/
 ├ tests/
 └ types/

prisma/

docs/
```

A estrutura real atual deve ser preservada caso já esteja organizada.

Não reorganizar o projeto inteiro apenas por preferência estética.

---

# 11. ESTADO ATUAL DO PROJETO

Checkpoints existentes:

```text
v0.1-foundation
v0.1.1-hardening
v0.2-service-orders
v0.2.1-audit-fixes
v0.2.2-pre-v03-hardening
v0.2.3-pre-v03-hardening
v0.3-technician-execution
v0.4-service-order-closing
v0.5-receitanet-diagnostics
```

## v0.1-foundation

Implementou:

- autenticação;
- empresas;
- usuários;
- perfis;
- multi-tenancy;
- dashboard;
- arquitetura ERP;
- MockERP;
- auditoria inicial.

---

## v0.1.1-hardening

Adicionou principalmente:

- segurança de sessão;
- revalidação do usuário;
- rate limiting;
- CSRF;
- security headers;
- sanitização de audit logs;
- validação de environment;
- melhorias E2E;
- hardening multiempresa.

---

## v0.2-service-orders

Implementou:

- Customer;
- Technician;
- ServiceOrder;
- ServiceOrderEvent;
- MockERP;
- importação de OS;
- idempotência;
- atribuição de técnico;
- timeline;
- Minhas OS;
- ownership por técnico;
- paginação;
- filtros;
- criação manual de OS.

Fluxo validado:

```text
MockERP
 ↓
OS #10001
 ↓
PENDING
 ↓
atribuição de técnico
 ↓
ASSIGNED
 ↓
timeline
 ↓
Minhas OS
```

---

# 12. AUDITORIA ATUAL DA V0.2

Antes de iniciar a próxima fase, existe uma rodada de correções de auditoria.

Foram identificados problemas que deverão ser corrigidos antes da v0.3.

Principais pontos:

## HIGH

### Rate limiting

A implementação original confiava excessivamente em:

```text
X-Forwarded-For
```

A estratégia de identificação de IP deverá ser segura e compatível com proxies confiáveis.

### Testes Vitest

Arquivos compartilhavam o mesmo banco de testes e podiam executar resets concorrentes.

A suíte deverá executar deterministicamente.

---

## MEDIUM

- autorização visual da criação de Technician inconsistente com API;
- importação ERP sujeita a condição de corrida concorrente;
- teste E2E podia produzir falso positivo na validação do status.

---

## LOW

- Same-Origin no logout;
- enumeração de usuário inativo;
- inconsistência de regra/mensagem de unicidade de email;
- audit log de atribuição registrando ID incorreto.

---

# 13. DEPENDÊNCIAS E SEGURANÇA

A versão inicial utilizou:

```text
Next.js 14.2.15
```

Foi identificada vulnerabilidade de segurança relevante.

Antes de avançar para produção, atualizar para uma versão corrigida e compatível dentro da linha Next 14, sempre que possível.

Nunca utilizar:

```text
npm audit fix --force
```

automaticamente.

Mudanças de major version deverão ser avaliadas separadamente.

---

# 14. CUSTOMER

Customer representa o cliente operacional utilizado na OS.

Campos conceituais:

```text
id
company_id

external_provider
external_id

name
document

phone
secondary_phone
email

address
number
complement
district
city
state
zip_code

latitude
longitude

active

created_at
updated_at
```

---

# 15. IDENTIDADE EXTERNA

Dados vindos de ERP devem possuir identidade externa.

Nunca utilizar o ID do ERP como PK principal do AlfaOS.

Estratégia:

```text
AlfaOS ID
+
company_id
+
external_provider
+
external_id
```

Exemplo:

```text
company_id = empresa Alfa
external_provider = RECEITANET
external_id = 57321
```

---

# 16. TECHNICIAN

Technician é diferente de User.

## User

Representa:

- autenticação;
- sessão;
- role;
- permissões.

## Technician

Representa:

- profissional de campo;
- vínculo com OS;
- futuras informações operacionais.

Relacionamento:

```text
Technician
 ↓
user_id
 ↓
User
```

Um Technician deverá possuir User com role:

```text
TECHNICIAN
```

e ambos devem pertencer à mesma empresa.

---

# 17. SERVICE ORDER

ServiceOrder representa uma Ordem de Serviço.

## Duas identidades

> **`id` é a identidade TÉCNICA da OS.**
> **`number` é a identidade OPERACIONAL HUMANA da OS.**

`id` é o cuid: chave primária, chave estrangeira e valor na URL. Ele nunca
muda e nunca é substituído.

`number` é um inteiro positivo **sequencial por empresa**, gerado no servidor,
único em `(company_id, number)` e **imutável**. É o que a operação usa: "OS
Nº 12". Alfa Telecom tem a sua OS Nº 1; outra empresa tem a dela.

As duas coexistem porque resolvem problemas diferentes. Um cuid é estável e
opaco — perfeito como chave, impossível de ditar ao telefone ou anotar numa
ficha de campo. Um sequencial é legível, mas seria uma chave primária ruim:
depende de coordenação entre tenants e vaza volume de negócio.

`number` **não é** `external_number`. Aquele é o número da OS no ERP de
origem, pertence a outro sistema e é nulo em OS interna. OS INTERNAL e
EXTERNAL compartilham a mesma sequência de `number` — para a operação existe
uma fila de OS, não duas.

Detalhamento técnico (alocação, concorrência, backfill e invariantes de banco)
em `docs/SERVICE-ORDERS.md` §1.3.

Campos conceituais:

```text
id
number
company_id

external_provider
external_id
external_number

customer_id
technician_id

type
subtype
description

priority
status

scheduled_at
assigned_at
started_at
completed_at
cancelled_at

created_at
updated_at
```

---

# 18. PRIORIDADE

Valores:

```text
LOW
NORMAL
HIGH
URGENT
```

Interface:

```text
Baixa
Normal
Alta
Urgente
```

---

# 19. ESTADOS DA OS

Estados:

```text
PENDING
ASSIGNED
IN_PROGRESS
COMPLETED
CANCELLED
```

Interface:

```text
PENDING → Pendente
ASSIGNED → Atribuída
IN_PROGRESS → Em atendimento
COMPLETED → Concluída
CANCELLED → Cancelada
```

---

# 20. MÁQUINA DE ESTADOS

Status nunca poderá ser alterado livremente.

Não permitir uma API genérica que aceite:

```json
{
  "status": "COMPLETED"
}
```

Mudanças de estado devem passar pela camada de negócio.

Exemplos:

```text
assignTechnician()
startServiceOrder()
cancelServiceOrder()
completeServiceOrder()
```

Fluxo principal:

```text
PENDING
 ↓
ASSIGNED
 ↓
IN_PROGRESS
 ↓
COMPLETED
```

---

# 21. TIMELINE

Toda ação operacional importante gera evento.

Entidade:

```text
ServiceOrderEvent
```

Eventos previstos:

```text
OS_CREATED
OS_IMPORTED
TECHNICIAN_ASSIGNED
TECHNICIAN_CHANGED
OS_STARTED
OS_PAUSED
OS_RESUMED
OS_CANCELLED
OS_COMPLETED
PHOTO_ADDED
MATERIAL_ADDED
SIGNATURE_ADDED
ERP_SYNC_STARTED
ERP_SYNC_COMPLETED
ERP_SYNC_FAILED
```

Eventos deverão ser imutáveis através da interface comum.

---

# 22. TRANSAÇÕES

Operações críticas devem utilizar transação.

Exemplo:

```text
atribuir técnico
 ↓
atualizar OS
+
criar evento
+
auditoria
```

Ou tudo é persistido,

ou nada é persistido.

Nunca deixar OS parcialmente atualizada.

---

# 23. CONCORRÊNCIA

Operações críticas devem considerar concorrência.

Exemplo:

Dois despachantes tentando atribuir técnicos diferentes simultaneamente.

Utilizar estratégia apropriada como:

- optimistic locking;
- updated_at;
- version;
- transação;
- constraint.

Não aceitar lost update silencioso.

---

# 24. IDEMPOTÊNCIA

Integrações externas deverão ser idempotentes.

Exemplo:

Sincronizar duas vezes:

```text
ERP OS 10001
```

não pode resultar em:

```text
OS 10001
OS 10001
```

Utilizar constraint no banco sempre que possível.

---

# 25. ERP INTEGRATION

O AlfaOS deverá permanecer desacoplado de ERP.

Arquitetura:

```text
AlfaOS
 ↓
ERPIntegrationContract
 ↓
Adapter
```

Adapters futuros:

```text
MockERPAdapter
ReceitanetAdapter
SGPAdapter
IXCAdapter
HubSoftAdapter
```

---

# 26. MOCK ERP

MockERP existe para permitir desenvolvimento sem depender da API real.

Ele poderá simular:

```text
listar OS
buscar OS
buscar cliente
sincronizar dados
```

Nunca afirmar que endpoints do MockERP são endpoints do ReceitaNet.

---

# 27. RECEITANET

> **Superada quanto ao estado factual pela seção 129.** Esta seção descreve o que se sabia antes de os OpenAPI oficiais serem localizados. Mantida por rastreabilidade histórica; para o estado atual das APIs (URA, Chatbot, CallCenter, Central do Assinante) leia a seção 129. A seção 64 continua valendo integralmente.

ReceitaNet será o primeiro ERP real integrado.

Já foram identificadas APIs oficiais para funcionalidades relacionadas a:

- clientes;
- chamados;
- contratos;
- dados da empresa;
- central do assinante;
- informações financeiras.

Porém o fluxo completo de:

- listar OS operacionais;
- iniciar execução;
- alterar estado;
- anexar evidências;
- finalizar OS;

ainda depende da documentação específica da API de Ordens de Serviço.

Não inventar endpoints.

---

# 28. ARQUITETURA RECEITANET

Evitar criar um arquivo gigante.

Estrutura futura preferida:

```text
ReceitanetClient
       │
       ├── Customer
       ├── ServiceOrder
       ├── Tickets
       └── Billing
```

Ou adapters especializados equivalentes.

A camada HTTP/autenticação deverá ser reutilizável.

---

# 29. VERSÃO 0.3 — EXECUÇÃO DO TÉCNICO

Após aprovação/correção da v0.2, desenvolver:

```text
v0.3-technician-execution
```

Objetivo:

Técnico realmente executar atendimento.

Fluxo:

```text
ASSIGNED
 ↓
INICIAR ATENDIMENTO
 ↓
IN_PROGRESS
 ↓
diagnóstico
 ↓
serviço realizado
 ↓
observações
```

Implementar:

- botão Iniciar Atendimento;
- started_at;
- started_by;
- diagnóstico;
- serviço realizado;
- observações;
- timeline.

Avaliar pausa/retomada separadamente antes de implementar.

---

# 30. VERSÃO 0.4 — FECHAMENTO

Implementar:

- fotos;
- anexos;
- materiais utilizados;
- assinatura do cliente;
- validações;
- fechamento;
- completed_at;
- PDF/comprovante.

Fluxo:

```text
IN_PROGRESS
 ↓
evidências
 ↓
assinatura
 ↓
conclusão
 ↓
COMPLETED
```

---

# 31. FOTOS

Permitir:

- câmera;
- galeria;
- múltiplas imagens.

Registrar:

```text
company_id
service_order_id
uploaded_by
file_path
mime_type
size
created_at
```

Aplicar:

- limite de tamanho;
- MIME validation;
- nomes seguros;
- autorização.

---

# 32. MATERIAIS

MVP inicialmente registra materiais utilizados sem módulo completo de estoque.

Exemplo:

```text
Conector SC/APC   2 un
Cabo drop         30 m
ONU               1 un
```

Estoque completo será versão futura.

---

# 33. ASSINATURA

Coletar:

- nome do responsável;
- documento opcional;
- assinatura;
- data/hora.

Relacionar exclusivamente à OS da empresa correta.

---

# 34. PDF

Após conclusão permitir gerar comprovante contendo:

- empresa;
- número da OS;
- cliente;
- endereço;
- técnico;
- problema;
- serviço realizado;
- materiais;
- horários;
- fotos selecionadas;
- assinatura.

---

# 35. VERSÃO 0.5 — RECEITANET

**Status: entregue como `v0.5-receitanet-diagnostics`, com escopo menor do que o planejado nesta seção.**

O que a v0.5 entregou:

- fundação de integração (contrato, capabilities, normalização de erro, timeout);
- diagnóstico de conectividade do cliente com snapshot preservado;
- credenciais de ERP cifradas em AES-256-GCM, vinculadas a `(companyId, provider)`;
- MockERP como provider funcional.

O que **não** foi entregue, e por quê:

- importação, atualização e fechamento contra o ReceitaNet real. Na época não havia documentação oficial; hoje há quatro OpenAPI (seção 129), mas nenhum deles oferece listagem de OS por empresa, delta sync ou webhook — ou seja, o mecanismo de descoberta de OS externa continua inexistente.
- retries automáticos, deliberadamente adiados.

A continuação está no roadmap revisado da seção 131.

---

# 36. STATUS DA SINCRONIZAÇÃO

Status da OS e da integração devem ser independentes.

Exemplo:

```text
OS status:
COMPLETED

ERP sync:
FAILED
```

Estados de integração:

```text
NOT_REQUIRED
PENDING
SYNCING
SYNCED
FAILED
```

Uma falha no ERP nunca pode apagar o fechamento local.

---

# 37. RETRY

Falhas de integração devem poder ser reprocessadas.

Registrar:

- provider;
- action;
- endpoint ou referência;
- HTTP status;
- tentativa;
- erro;
- timestamp.

Segredos nunca devem aparecer nos logs.

---

# 38. ALFAOS 1.0

O AlfaOS 1.0 deverá possuir:

### Administração

- empresas;
- usuários;
- permissões;
- técnicos;
- clientes;
- dashboard.

### OS

- importação;
- criação manual;
- atribuição;
- execução;
- timeline;
- fechamento.

### Campo

- Minhas OS;
- interface mobile;
- início;
- diagnóstico;
- serviço realizado;
- fotos;
- materiais;
- assinatura.

### Integração

- ReceitaNet;
- logs;
- retry;
- idempotência.

### Saída

- comprovante/PDF.

---

# 39. FORA DO 1.0

Não é obrigatório para o AlfaOS 1.0:

- GPS contínuo;
- rastreamento em tempo real;
- roteirização;
- estoque completo;
- almoxarifado;
- integração OLT;
- medição óptica automática;
- teste automático de velocidade;
- rádio;
- chat;
- IA;
- BI avançado;
- financeiro;
- cobrança.

---

# 40. ALFAOS 1.2

> **Reorganizado em 2026-08-25.** Vários itens desta lista deixaram de ser
> "possíveis recursos de uma versão futura" e viraram escopo classificado da
> trilha Field: notificações, checklist dinâmico, modo offline, estoque,
> medição óptica, teste de velocidade e localização de técnicos estão em §194,
> cada um com prioridade própria. Esta seção fica como registro da intenção
> original.

Possíveis recursos:

- GPS;
- mapa;
- localização de técnicos;
- estoque individual;
- transferências de materiais;
- checklist dinâmico;
- SLA;
- notificações;
- WhatsApp;
- medição óptica;
- teste de velocidade;
- dashboards avançados;
- produtividade;
- modo offline.

---

# 41. ALFAOS FUTURO

Possibilidades posteriores:

- inteligência artificial;
- sugestão de diagnóstico;
- resumo automático da OS;
- análise de histórico;
- previsão de recorrência;
- roteirização inteligente;
- detecção de reincidência;
- análise de produtividade;
- comunicação por voz entre técnicos;
- integração com OLT;
- integração com equipamentos de campo.

---

# 42. SEGURANÇA

Requisitos permanentes:

- autenticação server-side;
- password hashing;
- cookies seguros;
- sessão revalidada;
- CSRF;
- SameSite;
- Secure em produção;
- rate limiting;
- RBAC;
- multi-tenancy;
- proteção IDOR;
- validação server-side;
- mass assignment protection;
- environment validation;
- headers de segurança;
- sanitização de logs;
- secrets nunca expostos;
- tratamento seguro de erros.

---

# 43. PROTEÇÃO IDOR

Qualquer endpoint baseado em ID deve considerar:

```text
resource.id
+
company_id
+
authorization
```

Nunca fazer:

```text
findUnique({ id })
```

e retornar diretamente sem confirmar ownership.

---

# 44. OWNERSHIP DO TÉCNICO

Mesmo dentro da mesma empresa:

Técnico A nunca poderá acessar OS do Técnico B.

A proteção deve usar:

```text
session.user
 ↓
Technician
 ↓
technician.id
 ↓
ServiceOrder.technician_id
```

Nunca aceitar ID do técnico vindo do frontend para determinar acesso.

---

# 45. MASS ASSIGNMENT

É proibido usar body diretamente:

```text
prisma.model.create({
  data: body
})
```

Campos permitidos devem ser explicitamente selecionados e validados.

---

# 46. AUDITORIA

Existe diferença entre:

## AuditLog

Auditoria administrativa e técnica.

Exemplo:

```text
USER_UPDATED
TECHNICIAN_CREATED
SERVICE_ORDER_IMPORTED
```

## ServiceOrderEvent

Histórico operacional da OS.

Exemplo:

```text
OS_STARTED
TECHNICIAN_ASSIGNED
OS_COMPLETED
```

Não confundir os dois conceitos.

---

# 47. TESTES

Todo módulo novo deverá possuir:

- unit tests;
- integration tests;
- testes multiempresa;
- testes de autorização;
- testes adversariais relevantes.

Fluxos críticos deverão possuir Playwright E2E.

---

# 48. TESTES MULTIEMPRESA

Para cada nova entidade testar:

Empresa A não consegue:

```text
listar B
consultar B
editar B
excluir B
vincular B
```

Esses testes são obrigatórios.

---

# 49. TESTES DE OWNERSHIP

Para recursos individuais de técnico:

```text
Técnico A
```

não acessa:

```text
Técnico B
```

mesmo pertencendo à mesma empresa.

---

# 50. QUALIDADE

Antes de concluir qualquer versão executar:

```text
npm run lint
npx tsc --noEmit
npm test
Playwright
npm run build
```

Tudo deve passar.

Não remover teste para conseguir resultado verde.

Não aumentar timeout indiscriminadamente para mascarar flakiness.

---

# 51. GIT

Git é a fonte oficial do histórico.

Repositório oficial:

```text
JamalSoftware/AlfaOS
```

Branch principal:

```text
main
```

Checkpoints existentes nunca devem ser alterados.

Tags são imutáveis.

---

# 52. PADRÃO DE VERSÕES

Exemplo:

```text
v0.1-foundation
v0.1.1-hardening

v0.2-service-orders
v0.2.1-audit-fixes

v0.3-technician-execution
v0.3.1-audit-fixes

v0.4-closing
v0.4.1-audit-fixes

v0.5-receitanet

v1.0-rc1
v1.0
```

---

# 53. PROCESSO DE DESENVOLVIMENTO COM CLAUDE CODE

Existirão dois papéis distintos.

## CLAUDE DEV

Responsável por implementar.

Deve:

1. ler PRD;
2. ler arquitetura;
3. verificar Git;
4. analisar código existente;
5. apresentar plano;
6. implementar apenas escopo autorizado;
7. criar testes;
8. executar quality gates;
9. documentar;
10. criar commit/tag quando autorizado.

---

## CLAUDE AUDITOR

Preferencialmente sessão separada.

Deve assumir:

> O desenvolvedor pode ter errado.

Sua função é tentar quebrar:

- multi-tenancy;
- autorização;
- ownership;
- idempotência;
- concorrência;
- transações;
- validações;
- estado;
- segurança.

Inicialmente não deve alterar código.

Primeiro produz relatório.

---

# 54. REGRA PARA NOVAS SESSÕES CLAUDE

Ao iniciar uma nova sessão:

Primeiro ler:

```text
docs/PRD.md
docs/ARCHITECTURE.md
docs/SECURITY.md
```

Se estiver trabalhando com OS também ler:

```text
docs/SERVICE-ORDERS.md
```

Se houver auditoria recente:

```text
docs/V0.2-AUDIT.md
```

ou documento equivalente da versão.

Depois executar:

```text
git status
git branch --show-current
git log --oneline --decorate -10
git tag
```

Somente depois propor alterações.

---

# 55. NÃO CONFIAR APENAS EM CONTEXTO DA CONVERSA

Claude deve considerar os documentos do repositório como fonte primária.

Não depender de memória da conversa anterior.

Caso exista conflito:

1. parar;
2. identificar o conflito;
3. consultar código/documentos;
4. pedir decisão antes de alterar arquitetura importante.

---

# 56. NÃO RECONSTRUIR

Nunca:

- recomeçar projeto do zero;
- substituir stack sem autorização;
- apagar migrations;
- reescrever módulo inteiro apenas por preferência;
- remover segurança;
- apagar testes;
- mover tags antigas;
- alterar histórico Git.

---

# 57. MIGRATIONS

Nunca editar migrations históricas já aplicadas.

Toda mudança de banco deve gerar nova migration.

Deve ser possível:

```text
banco vazio
 ↓
migrate deploy
 ↓
estado atual
```

---

# 58. DEPENDÊNCIAS

Antes de adicionar nova biblioteca:

avaliar:

- necessidade;
- manutenção;
- vulnerabilidades;
- tamanho;
- compatibilidade;
- licença.

Evitar dependências para problemas simples.

---

# 59. ERROS

Usuário final nunca deverá visualizar:

- stack trace;
- query SQL;
- Prisma internals;
- path do servidor;
- secrets;
- token;
- configuração interna.

O servidor poderá registrar detalhes apropriados de maneira segura.

---

# 60. MOBILE

Área do técnico é:

```text
mobile-first
```

Priorizar:

- botões grandes;
- poucos cliques;
- leitura rápida;
- formulários simples;
- boa experiência com uma mão;
- compatibilidade Android.

Administração continuará responsiva para:

- desktop;
- tablet;
- celular.

---

# 61. PWA E FIELD APP NATIVO

**Atualização (PRD 2.0):** esta seção foi revisada. A versão anterior deste documento recomendava não introduzir Flutter/React Native "antes de existir necessidade comprovada". Essa recomendação foi **substituída por uma decisão de produto explícita**: o AlfaOS terá um Field App nativo em **Flutter** — ver seção 75. A necessidade foi considerada comprovada pelo escopo de Technician Toolkit (GPS, Wi-Fi Analyzer, câmera/QR, offline, biometria), que depende de APIs de plataforma não disponíveis de forma confiável em PWA.

**Leia com atenção — esta decisão tem alcance limitado, deliberadamente:**

- Flutter **é** a decisão oficial para o futuro AlfaOS Field App.
- Android **é** a primeira prioridade móvel.
- Essa decisão **substitui** a recomendação antiga de evitar Flutter indefinidamente.
- Porém Flutter **NÃO faz parte do escopo imediato de nenhuma versão até que a trilha Field seja formalmente autorizada** — nenhuma linha de Flutter deve ser escrita antes disso. (O texto original desta linha citava `v0.3` e `v0.4`, que já passaram; a ressalva nunca foi sobre aquelas duas versões em particular, e sim sobre a ausência de autorização — ver §194 e §195.)
- O web/PWA existente (Next.js) **continua sendo a interface atual** do Core, inclusive para o técnico — `/minhas-os` e `/ordens/[id]` permanecem válidos e não são substituídos por esta decisão.
- O Field App Flutter **começa somente quando a trilha correspondente for formalmente autorizada** (ver seção 118, trilha "Field App") — não quando o Core chegar numa versão específica, e não automaticamente.
- **Estar planejado neste PRD não autoriza implementação antecipada.** "Flutter foi aprovado como decisão de produto" não significa "comece a migrar o AlfaOS para Flutter agora" — são duas afirmações diferentes, e só a primeira está registrada aqui. Ver seção 119 (Princípio de Escopo), que se aplica a esta decisão como a qualquer outra da Parte II.

---

# 62. PERFORMANCE

Evitar:

- carregar todas as OS;
- carregar todos os clientes;
- queries globais;
- N+1;
- filtros apenas no frontend.

Utilizar paginação e filtros server-side.

---

# 63. LOGS

Nunca registrar:

- password;
- password hash;
- Authorization;
- JWT;
- cookie;
- API key;
- AUTH_SECRET.

Sanitização deve ser centralizada.

---

# 64. RECEITANET — REGRA CRÍTICA

Não implementar endpoint, payload ou comportamento baseado em suposição.

Somente implementar integração real quando houver:

- documentação oficial;
- Swagger/OpenAPI;
- Postman;
- informação oficial do suporte;
- testes autorizados.

MockERP continuará disponível para desenvolvimento independente.

---

# 65. DEFINITION OF DONE

Uma tarefa só está concluída quando:

1. escopo foi implementado;
2. regras de negócio foram respeitadas;
3. multi-tenancy foi testado;
4. autorização foi testada;
5. testes passam;
6. typecheck passa;
7. lint passa;
8. build passa;
9. documentação atualizada;
10. riscos conhecidos documentados;
11. Git está consistente.

---

# 66. NÃO ESCONDER PROBLEMAS

Claude deve relatar:

- falhas;
- limitações;
- dívida técnica;
- testes instáveis;
- vulnerabilidades;
- decisões provisórias.

Nunca marcar como concluído algo que não foi realmente validado.

---

# 67. PRIORIDADES DE ENGENHARIA

Sempre seguir:

```text
Integridade > velocidade

Segurança > conveniência

Regras de negócio > CRUD genérico

Banco consistente > atalhos

Testes confiáveis > quantidade de testes

Manutenibilidade > código descartável
```

---

# 68. PRIORIDADE ATUAL DO PROJETO

**Atualizado.** A baseline vigente é `v0.5-receitanet-diagnostics` (commit `e4fc701`), auditada e endurecida. As versões v0.3, v0.4 e v0.5 foram concluídas e auditadas de forma independente.

A regra permanente do processo continua valendo: quem implementa não se autoavalia como aprovado em segurança (ver seção 53, `CLAUDE AUDITOR`).

**Próxima etapa: `v0.5.1` — Pilot Readiness e fundação para OS próprias. Ver seção 131.**

---

# 69. ROADMAP IMEDIATO

> **Substituída pela seção 131 daqui para frente.** O histórico abaixo permanece por rastreabilidade; a ordem vigente é a da seção 131.

Histórico concluído:

```text
v0.2.1 → v0.2.3
Correções da auditoria + endurecimento pré-v0.3     [CONCLUÍDO]
        ↓
v0.3
Execução do técnico                                  [CONCLUÍDO — auditado]
        ↓
v0.4
Fotos + materiais + assinatura + fechamento          [CONCLUÍDO — auditado]
        ↓
v0.5
Fundação de ERP + diagnóstico de conectividade       [CONCLUÍDO — auditado]
```

Continuação: **seção 131**. Ver também seção 118 (Roadmap Atualizado — Trilhas de Longo Prazo) para a visão que inclui Field App, Technician Toolkit e Network Intelligence além do Core.

---

# 70. PILOTO

Antes de considerar AlfaOS 1.0 produção geral:

Utilizar inicialmente poucos técnicos.

Observar:

- velocidade;
- usabilidade;
- falhas de conexão;
- fluxo de OS;
- erros de campo;
- dificuldade para preencher;
- uploads;
- assinatura;
- sincronização ERP.

Corrigir problemas encontrados antes da expansão.

---

# 71. PRINCÍPIO FINAL

O AlfaOS não deve tentar possuir todas as funcionalidades possíveis.

Sua qualidade será determinada por:

- confiabilidade;
- velocidade;
- simplicidade;
- segurança;
- experiência do técnico;
- integração correta com ERP.

O objetivo é construir um produto que uma equipe técnica realmente queira utilizar todos os dias.

---

# PARTE II — VISÃO EXPANDIDA DO PRODUTO

Esta parte registra a visão de **longo prazo** do AlfaOS, além do Core hoje em desenvolvimento (Parte I). Nada aqui está automaticamente aprovado para implementação — ver seção 119.

Cada seção de funcionalidade traz uma tag de prioridade: **[MVP]**, **[IMPORTANTE]**, **[DIFERENCIAL]** ou **[FUTURO]** (definições na seção 117).

---

# 72. VISÃO OFICIAL EXPANDIDA

> O técnico deve conseguir realizar praticamente todo o atendimento sem sair do AlfaOS.

Fluxo de longo prazo (não é o fluxo do MVP — ver seção 76 para a distinção):

```text
receber a OS
 ↓
localizar o cliente
 ↓
iniciar rota
 ↓
chegar ao local
 ↓
diagnosticar
 ↓
consultar a rede
 ↓
configurar equipamentos
 ↓
testar
 ↓
utilizar materiais
 ↓
registrar evidências
 ↓
pedir ajuda
 ↓
obter assinatura
 ↓
finalizar o atendimento
```

Tudo dentro do mesmo ecossistema AlfaOS. Esse fluxo será construído progressivamente — cada etapa é uma funcionalidade própria, classificada individualmente nas seções seguintes.

---

# 73. GRANDES BLOCOS DO PRODUTO **[visão estrutural]**

## AlfaOS Core **[MVP]**

Empresas, usuários, técnicos, clientes, ordens de serviço, máquina de estados, execução, timeline, AuditLog, SLA, agendamento, permissões, multi-tenancy, relatórios, integrações, qualidade operacional. É o que está em desenvolvimento hoje (Parte I).

## AlfaOS Field App **[DIFERENCIAL]**

Aplicativo móvel para os técnicos. Tecnologia planejada: **Flutter** (ver seção 75). Prioridade inicial Android, por causa do uso em campo e das integrações de hardware/rede necessárias (Wi-Fi scanner, câmera/QR, GPS).

## AlfaOS Technician Toolkit **[DIFERENCIAL]**

Conjunto de ferramentas técnicas de diagnóstico e instalação (Wi-Fi Analyzer, speed test, medições antes/depois, assistente de configuração de roteador) — ver seção 82.

## AlfaOS Network Intelligence **[FUTURO]**

Camada de inteligência operacional baseada em ERP, RADIUS, OLT, ONU, ACS/CPE, FiberMap, topologia, incidentes, correlação de falhas, motor de regras e IA — ver seções 102–108.

## AlfaOS SaaS **[FUTURO]**

Camada comercial multiempresa para venda do produto a outros provedores — ver seção 114.

---

# 74. IDENTIDADE INDIVIDUAL DO TÉCNICO **[MVP — já implementado no Core]**

> 1 técnico = 1 usuário individual.

Não usar contas compartilhadas. Arquitetura já implementada (ver seção 16):

```text
User
 ↕
Technician
```

Cada técnico possui usuário próprio, autenticação individual, empresa, perfil, status ativo/inativo, histórico próprio, ações auditáveis. Toda ação operacional deve poder identificar quem a realizou.

Quando um técnico é desativado: não pode realizar novas operações; histórico anterior permanece; OS antigas não são apagadas; auditoria permanece intacta. Essa regra já está implementada no Core (`Technician.active`, validado em conjunto com `User.active` e `User.profile` — ver `docs/TECHNICIAN-EXECUTION.md`).

No futuro Field App Flutter, prever adicionalmente **[DIFERENCIAL]**: sessão individual no app, PIN ou biometria local, conceito de dispositivo autorizado, revogação remota, logout remoto — ver seção 99.

---

# 75. FIELD APP FLUTTER **[DIFERENCIAL]**

Haverá um aplicativo móvel Flutter para técnicos. Princípio arquitetural inegociável:

> Flutter não será uma segunda implementação das regras de negócio.

```text
Flutter Field App
        ↓
AlfaOS API
        ↓
Application / Domain Services
        ↓
PostgreSQL
        ↓
Integrações externas
```

Regras críticas (autorização, multi-tenancy, máquina de estados, concorrência) continuam exclusivamente no backend, exatamente como já são no Core hoje. O app móvel é **cliente da API**, nunca dono de regra de negócio.

Prioridade inicial: **Android**. iOS poderá ser suportado posteriormente conforme necessidade — não é um compromisso desta fase.

> **Fora de escopo agora.** Esta é uma decisão de arquitetura para quando a trilha "Field App" for formalmente autorizada (seção 118) — não um sinal para começar a implementar. Ver seção 61 para o texto completo desta ressalva e seção 119 para o princípio geral de escopo.

**A especificação completa do Field está na Parte V (§150–§195):** experiência,
notificações, registro de dispositivo, offline, evidências, checklist,
ferramentas técnicas e as fundações de backend que precisam existir antes. Esta
seção continua sendo a decisão de plataforma; a Parte V é o produto.

---

# 76. FLUXO DE CAMPO COMPLETO **[FUTURO — implementação progressiva]**

```text
Minhas OS
 ↓
Abrir atendimento
 ↓
Iniciar rota
 ↓
Navegação
 ↓
Cheguei ao local
 ↓
Iniciar atendimento
 ↓
Diagnóstico
 ↓
Ferramentas técnicas
 ↓
Serviço realizado
 ↓
Testes finais
 ↓
Materiais
 ↓
Fotos/evidências
 ↓
Assinatura
 ↓
Finalização
 ↓
Próxima OS
```

Esse é o fluxo de **longo prazo**. O fluxo atualmente implementado (v0.3) cobre apenas `ASSIGNED → IN_PROGRESS → diagnóstico/serviço/observações`, sem rota, navegação, ferramentas técnicas, materiais, fotos ou assinatura — ver `docs/TECHNICIAN-EXECUTION.md` para o que já existe de fato.

---

# 77. GPS E LOCALIZAÇÃO DO CLIENTE **[DIFERENCIAL]**

O técnico poderá futuramente: visualizar cliente no mapa; atualizar a localização real pelo GPS; corrigir coordenada incorreta; registrar precisão do GPS; adicionar referência de acesso; registrar foto da fachada quando apropriado; iniciar navegação (Google Maps/Waze); registrar chegada ao local.

Conceito de qualidade/origem da coordenada:

```text
IMPORTADA_DO_ERP
NÃO_CONFIRMADA
CONFIRMADA_PELO_TÉCNICO
```

> **Revisado pela seção 134.** Esta lista mistura dois eixos independentes —
> de onde a coordenada veio e se alguém a confirmou em campo. O modelo
> vigente os separa em `source` e `verified`, o que permite representar uma
> coordenada geocodificada **e** confirmada, combinação que a lista acima não
> consegue expressar. O restante desta seção continua válido.

Histórico de alteração de localização, quando aplicável, deve registrar: usuário, técnico, data/hora, coordenada anterior, coordenada nova, precisão (quando disponível). Mesmo padrão de rastreabilidade já usado em `ServiceOrderEvent`/`AuditLog` no Core.

---

# 78. ROTA E DESLOCAMENTO **[DIFERENCIAL]**

Conceito de `INICIAR ROTA`: o técnico poderá iniciar rota para o cliente diretamente pela OS.

Eventos operacionais futuros possíveis: `ROUTE_STARTED`, `ARRIVED_ON_SITE`. Não é obrigatório transformar todos em status principal da OS — preferência arquitetural:

```text
status principal simples
+
eventos operacionais (ServiceOrderEvent)
```

Timestamps possíveis: `route_started_at`, `arrived_at`, `started_at` (já existe), `completed_at` (já existe). Isso permitirá calcular tempo de deslocamento, tempo de atendimento e tempo total da OS — insumo futuro para SLA (seção 112). Roteirização de múltiplas OS e despacho assistido estão na seção 137.

---

# 79. MAPA DOS ATENDIMENTOS **[DIFERENCIAL]**

Field App poderá oferecer: OS do dia no mapa, localização dos clientes, distância, ETA, prioridade, próxima OS. Otimização automática da sequência de visitas é **[FUTURO]**, não parte desta fase.

> **Não confundir com o Mapa Operacional (seção 136).** Esta seção descreve o
> mapa do *dia do técnico*, dentro do Field App. O da seção 136 é o mapa da
> *operação inteira*, no painel Web, para quem despacha — outro público,
> outro escopo, outras permissões.

---

# 80. DIAGNÓSTICO RÁPIDO DO CLIENTE **[DIFERENCIAL]**

Módulo "Diagnóstico Rápido": permitir ao técnico consultar o estado do cliente sem entrar diretamente no ERP ou em ferramentas externas dispersas.

Pesquisa desejada: nome, CPF/CNPJ, telefone. **Regra:** pesquisa por nome pode usar a base local do AlfaOS — não assumir que um ERP externo aceita busca por nome se a API oficial não documentar isso (consistente com a seção 27/64, "não inventar endpoints").

Informações desejadas quando tecnicamente disponíveis, após localizar o cliente: online/offline, login PPPoE, IP, sessão, tempo conectado, última conexão, última atualização, plano, status cadastral operacional, ONU, OLT, PON, potência óptica, equipamento, chamados, incidentes.

**Regra crítica:** nunca tratar falha de API como OFFLINE. `ERRO DE CONSULTA != CLIENTE OFFLINE`. Uma falha de integração deve ser reportada como falha de consulta, nunca inferida como estado do cliente.

---

# 81. RECEITANET E OUTROS ERPS — REFORÇO ARQUITETURAL

Não acoplar nenhuma funcionalidade nova diretamente ao ReceitaNet. A arquitetura por contrato/adapter já descrita nas seções 25–28 e 64 continua sendo a regra para toda extensão futura:

```text
AlfaOS
 ↓
Integration Contract
 ↓
ReceitaNet Adapter (ou SGP / IXC / HubSoft / outro)
```

Nenhuma funcionalidade da Parte II (Diagnóstico Rápido, OLT, RADIUS, ACS, FiberMap) deve assumir um único ERP como dependência obrigatória de arquitetura.

---

# 82. ALFAOS TECHNICIAN TOOLKIT — VISÃO GERAL **[DIFERENCIAL]**

Ferramentas planejadas: Wi-Fi Analyzer, recomendação de canal, análise 2.4/5 GHz, RSSI, largura de canal, congestionamento, gateway, ping, jitter, packet loss, DNS, IPv4/IPv6, traceroute, speed test, consulta de conectividade, diagnóstico automático.

Classificação detalhada por ferramenta nas seções 83–88 e na tabela da seção 117 — nem toda ferramenta do toolkit tem a mesma prioridade.

---

# 83. WI-FI ANALYZER **[DIFERENCIAL — P0 na trilha Field, §174]**

> **Reclassificado em 2026-08-25.** Continua sendo DIFERENCIAL para o produto
> (§117), e passou a ser **P0 do Field MVP**: é a ferramenta que atende a
> reclamação mais comum do assinante e que hoje o técnico substitui por
> aplicativo de terceiro no celular pessoal. Especificação em §174.

Funcionalidade do Flutter/Android. Mostrar: SSID, banda, canal, RSSI, largura, redes próximas, ocupação, interferência.

```text
Canal atual: 6
Redes próximas: 8
Congestionamento: alto

Recomendação AlfaOS: Canal 1, 20 MHz
```

Não prometer capacidades que Android/iOS não permitam — o acesso real ao scanner Wi-Fi depende das APIs e permissões da plataforma. Android é prioridade justamente por isso (ver seção 75).

---

# 84. RECOMENDADOR DE CONFIGURAÇÃO WI-FI **[DIFERENCIAL — P0 na trilha Field, §174]**

Com base nas medições (seção 83), o AlfaOS poderá recomendar canal, largura, banda, posicionamento, necessidade de segundo AP ou de Mesh.

A recomendação deve ser baseada primeiro em **regras técnicas determinísticas**. IA (seção 108) poderá ser adicionada posteriormente, nunca como primeira implementação.

---

# 85. TESTE DE COBERTURA POR CÔMODOS **[FUTURO]**

Funcionalidade "Mapear cobertura Wi-Fi": o técnico registra medições por ambiente.

```text
Sala        -43 dBm   BOM
Cozinha     -55 dBm   BOM
Quarto 1    -64 dBm   ATENÇÃO
Quarto 2    -77 dBm   RUIM
```

O sistema poderá gerar relatório de cobertura a partir dessas medições.

---

# 86. MEDIÇÃO ANTES x DEPOIS **[DIFERENCIAL]**

"Medição Antes x Depois": antes da intervenção, registrar RSSI, ping, jitter, perda, download, upload, canal, potência óptica quando aplicável. Repetir após a intervenção. O AlfaOS calcula a diferença.

```text
ANTES                          DEPOIS
RSSI      -74 dBm              RSSI      -51 dBm
Download  112 Mbps             Download  487 Mbps
Jitter    17 ms                Jitter    2 ms
```

Pode virar evidência anexada à OS (ver seção 92 e, para o modelo estruturado que a substitui no Field, §162 e §176). Especificação da comparação antes/depois em §175.

---

# 87. SPEED TEST **[DIFERENCIAL — P0 na trilha Field, §179]**

> **Reclassificado em 2026-08-25:** P0 do Field MVP. Servidor de teste próprio
> ou regional continua FUTURO.

Ferramenta para registrar: download, upload, ping, jitter, perda de pacotes (quando disponível), tipo de conexão do teste (Wi-Fi/cabo, quando conhecido), data/hora. Servidor de teste próprio/regional é **[FUTURO]**, não parte desta fase.

---

# 88. ASSISTENTE DE CONFIGURAÇÃO DE ROTEADORES **[revisado — ver §178]**

> **Reclassificado em 2026-08-25.** Esta seção tratava o assunto inteiro como
> FUTURO. A §178 separa duas coisas que não são a mesma: a versão **assistida**
> — o app mostra os valores certos e o técnico digita — é **P0 do Field MVP** e
> não depende de integrar nenhum fabricante. A versão **automatizada**, com
> `RouterAdapter` por modelo, é **P1** e continua exigindo ACS/TR-069/API
> oficial em vez de scraping de HTML.

Cadastro de equipamentos homologados por fabricante/modelo (TP-Link, ZTE, Tenda, outros), cada um podendo conter guia, configuração WAN/PPPoE/VLAN/Wi-Fi/segurança, firmware homologado, problemas conhecidos, procedimentos.

Estudar futuramente ACS, TR-069, TR-369, APIs oficiais de fabricantes (ver seção 106). **Nunca armazenar credenciais sensíveis desnecessariamente.**

---

# 89. QR CODE / BARCODE **[DIFERENCIAL — leitura básica P0 na trilha Field, §180]**

> **Reclassificado em 2026-08-25:** a **leitura** é P0 do Field MVP; o vínculo e
> a baixa completos dependem do ledger de inventário (§181), que é P1.

Field App usará a câmera para escanear ONU, ONT, roteador, TV Box e outros equipamentos, lendo serial, MAC, QR ou barcode. Após a leitura: identificar equipamento, consultar cliente, consultar estoque, vincular ativo à OS, realizar baixa, consultar histórico.

Depende do módulo de Estoque por Técnico (seção 90) para as funções de vínculo/baixa.

---

# 90. ESTOQUE POR TÉCNICO **[FUTURO — P1 na trilha Field, §181]**

> **Decisão de modelagem acrescentada em 2026-08-25 (§181):** o estoque é um
> **ledger de movimentos com histórico imutável**, não um contador. Saldo é
> derivado. Um contador perde a história e, quando diverge da prateleira, não
> há como descobrir onde.

Cada técnico poderá possuir estoque individual:

```text
Almoxarifado
 ↓
Transferência para técnico
 ↓
Estoque do técnico
 ↓
Uso em OS
 ↓
Baixa
```

Suportar futuramente: entrada, transferência, consumo, devolução, equipamento defeituoso, RMA, serial, MAC, rastreabilidade. O registro simples de materiais utilizados (sem controle de estoque) já está previsto como parte do fechamento **[MVP]** — ver seção 32; estoque completo com rastreabilidade é módulo separado e posterior.

---

# 91. CHECKLISTS INTELIGENTES **[DIFERENCIAL — P0 na trilha Field, §165]**

> **Reclassificado em 2026-08-25:** P0 do Field MVP. A §165 especifica o
> checklist configurável por `companyId` + `ServiceOrderType`, e a §166 fixa que
> **quem valida a conclusão é o backend**, nunca o aplicativo.

O checklist deve variar por tipo de OS:

```text
INSTALAÇÃO         SEM CONEXÃO        WI-FI RUIM
potência óptica     diagnóstico        RSSI
ONU                 ONU                canal
roteador            autenticação       congestionamento
Wi-Fi               potência           speed test
speed test          causa              antes/depois
GPS                 teste final
fotos
assinatura
```

Objetivo: o técnico não precisa memorizar todo o protocolo — o sistema orienta a execução.

---

# 92. FOTOS E EVIDÊNCIAS — REFORÇO **[MVP — parte do fechamento v0.4]**

Complementa a seção 31. Além dos campos já definidos (`company_id`, `service_order_id`, `uploaded_by`, `file_path`, `mime_type`, `size`, `created_at`), considerar: compressão, upload em background, fila offline (depende da seção 98), timestamp, metadata mínima necessária, retenção, segurança.

Não depender exclusivamente de metadata do aparelho como prova absoluta — a integridade da evidência deve vir do registro server-side (quem, quando, para qual OS), não de EXIF não verificável.

> **Estendido em 2026-08-25 (§162).** Esta seção tratava foto como arquivo com
> metadados. No Field ela passa a ser **evidência categorizada**: `category`
> obrigatória, categorias exigíveis por `ServiceOrderType`, `hash` para
> deduplicação e imutabilidade após `COMPLETED`. Um álbum de doze fotos sem
> rótulo não prova nada seis meses depois — ninguém sabe qual é a CTO e qual é
> o acabamento.

---

# 93. ASSINATURA DO CLIENTE — REFORÇO **[MVP — parte do fechamento v0.4]**

Complementa a seção 33. Guardar assinatura, data/hora, OS, técnico, empresa. Considerar futuramente confirmação explícita de aceite dos serviços realizados (texto de aceite junto à assinatura) — **[IMPORTANTE]**, não obrigatório na primeira versão do fechamento.

---

# 94. CLIENTE AUSENTE / IMPOSSIBILIDADE DE ATENDIMENTO **[IMPORTANTE]**

Fluxo operacional para: cliente ausente, endereço não localizado, acesso bloqueado, cliente recusou atendimento, problema externo impeditivo, reagendamento (seção 95). Registrar: motivo, data/hora, tentativa de contato, observação, evidência quando apropriada. Deve gerar timeline (`ServiceOrderEvent`), não apenas texto livre perdido em um campo de observação.

---

# 95. REAGENDAMENTO **[IMPORTANTE]**

Dentro das permissões adequadas, técnico ou despachante poderá solicitar/realizar reagendamento. A regra final (quem pode, sob quais condições) dependerá da política configurada pela empresa — não assumir uma regra única e rígida para todos os tenants.

---

# 96. COMUNICAÇÃO **[DIFERENCIAL]**

Field App poderá oferecer: ligar para cliente, abrir WhatsApp, contato com central, chat interno, pedir ajuda, compartilhar contexto da OS. Push-to-talk é **[FUTURO]**.

Comunicação interna não deve se misturar com `AuditLog` — são conceitos diferentes (ver seção 46).

---

# 97. BASE DE CONHECIMENTO **[FUTURO]**

Central técnica futura contendo equipamentos, configurações, problemas recorrentes, LEDs, erros, procedimentos, padrões da empresa. Também poderá servir de contexto para o futuro assistente de IA (seção 108).

---

# 98. MODO OFFLINE **[revisado — fundação é P0 do Field MVP, §158]**

> **Reclassificado em 2026-08-25.** Esta seção marcava modo offline como FUTURO.
> A **fundação offline é P0 do Field MVP** (§158–§161): um aplicativo de campo
> que exige rede não é um aplicativo de campo, e retrofit de offline depois é
> reescrita — cada tela escrita assumindo resposta imediata do servidor precisa
> ser refeita.
> 
> Continua FUTURO a **maturidade completa** de sincronização: merge assistido,
> pré-sincronização preditiva e cache seletivo de base de conhecimento.
> 
> O parágrafo abaixo sobre `version`/`expectedVersion` estava certo e virou
> decisão fixada na §161.

Requisito arquitetural do Field App, não trivial. O técnico deve poder trabalhar em áreas sem conectividade.

Dados possivelmente pré-sincronizados: minhas OS, dados essenciais do cliente, checklist, informações necessárias ao atendimento.

Ações offline: preenchimento, fotos, materiais, assinatura, execução, observações.

```text
Offline Action Queue
 ↓
Conexão retorna
 ↓
Validação
 ↓
Conflict Resolution
 ↓
Sincronização
```

**Não** tratar sincronização como "enviar tudo quando a internet voltar". Conflitos devem ser detectáveis — exemplo: técnico fica offline enquanto despachante cancela ou reatribui a OS. O mecanismo de `version`/`expectedVersion` já implementado no Core (ver `docs/SERVICE-ORDERS.md`, `docs/TECHNICIAN-EXECUTION.md`) é o candidato natural para resolver esse conflito quando o offline for implementado — não inventar um segundo mecanismo de concorrência.

---

# 99. SEGURANÇA DO DISPOSITIVO **[revisado — parte é P0, ver §191]**

> **Reclassificado em 2026-08-25.** Esta seção tratava o bloco inteiro como
> DIFERENCIAL. Três itens são **P0 do Field MVP**, porque sem eles o primeiro
> aparelho em campo já nasce com um problema sem solução: **armazenamento
> seguro do token**, **registro de dispositivo** (`MobileDevice`, §155) e
> **revogação server-side de sessão e dispositivo**. Celular perdido é o
> cenário que os justifica — sem eles, cortar o acesso exige trocar a senha do
> usuário, o que derruba os outros aparelhos dele e ainda deixa o push
> entregando OS ao aparelho perdido.
> 
> Continuam DIFERENCIAL: PIN/biometria, lista de sessões na interface, versão
> mínima do app e bloqueio de versões inseguras.
> 
> Contrato de segurança em `docs/SECURITY.md` §8.9.

Para o Field App, prever: armazenamento seguro de token, criptografia/proteção de dados locais apropriada, PIN/biometria, dispositivos autorizados, lista de sessões, revogação, logout remoto, tratamento de celular perdido, versão mínima do app, possibilidade de bloquear versões inseguras.

---

# 100. HISTÓRICO TÉCNICO DO CLIENTE **[IMPORTANTE]**

Técnico poderá consultar, respeitando permissão: últimas OS, problemas recorrentes, equipamentos anteriores, alterações importantes, medições, reincidência (seção 101). Evitar exposição financeira ou pessoal desnecessária — ver LGPD, seção 113.

---

# 101. REINCIDÊNCIA **[IMPORTANTE]**

Análise futura do tipo "Cliente possui 4 chamados de Wi-Fi nos últimos 60 dias" — pode ajudar diagnóstico e gestão. Depende de histórico consolidado (seção 100).

---

# 102. PRÉ-DIAGNÓSTICO REMOTO **[FUTURO]**

Antes do deslocamento, o AlfaOS poderá verificar automaticamente dados disponíveis:

```text
Cliente → ERP → RADIUS → OLT → ONU → PON → incidentes → resultado
```

Conclusões possíveis: visita provavelmente necessária; possível problema Wi-Fi; possível problema de autenticação; possível problema óptico; possível incidente coletivo. **Nunca apresentar conclusão probabilística como certeza absoluta.**

---

# 103. CORRELAÇÃO DE INCIDENTES **[FUTURO]**

"Incident Correlation Engine":

```text
Cliente A offline
Cliente B offline
Cliente C offline
Cliente D offline
 ↓
mesma PON / CTO / região
 ↓
possível falha coletiva
```

O sistema poderá identificar padrão, alertar central, agrupar chamados, evitar deslocamentos duplicados, abrir incidente de rede.

---

# 104. INTEGRAÇÃO COM OLT **[FUTURO]**

Consulta futura de: ONU online/offline, potência RX/TX (quando disponível), distância, PON, serial, estado, eventos relevantes. Implementações devem respeitar o suporte oficial de cada equipamento/fabricante.

---

# 105. RADIUS / PPPoE **[FUTURO]**

Consulta futura de: sessão PPPoE, online/offline, IP, tempo de sessão, últimas informações disponíveis. **Não expor credenciais PPPoE sem necessidade operacional e autorização explícita.**

---

# 106. ACS / CPE MANAGEMENT **[FUTURO]**

Integração futura com ACS para equipamentos compatíveis: diagnóstico, configuração, Wi-Fi, firmware, reinício, provisionamento. Estudar TR-069, TR-369, APIs específicas. Não criar dependência obrigatória de um único fabricante.

---

# 107. FIBERMAP **[FUTURO]**

Integração futura com o ecossistema FiberMap. Técnico poderá visualizar, no contexto da OS:

```text
Cliente → CTO → Porta → Splitter → Cabo → Poste → PON → OLT
```

Permitirá diagnóstico topológico e análise de impacto.

---

# 108. ASSISTENTE INTELIGENTE (IA) **[FUTURO]**

Estratégia oficial: primeiro **motor de regras determinístico**, depois IA quando houver benefício comprovado.

```text
ONU ONLINE · Potência boa · PPPoE ONLINE
Teste cabeado 620 Mbps · Wi-Fi 65 Mbps · RSSI -76 dBm
 ↓
Motor de regras: "Provável problema de cobertura Wi-Fi."
```

Depois, IA poderá: explicar, ordenar hipóteses, sugerir testes, buscar na base de conhecimento (seção 97), auxiliar o técnico. **IA nunca deve substituir controles determinísticos de segurança/autorização** — essa regra é absoluta e se aplica a todo o produto, não só a este módulo.

---

# 109. CONTROLE DE QUALIDADE **[IMPORTANTE]**

Conceito de protocolos mínimos de fechamento, variável por empresa e tipo de OS. Exemplo: instalação pode exigir potência + speed test + GPS + foto + assinatura; Wi-Fi ruim pode exigir RSSI + análise + antes/depois. Essas regras devem ser configuráveis, não hardcoded para um único tipo de operação.

---

# 110. REABERTURA / DEVOLUÇÃO DE OS **[FUTURO]**

Fluxo para supervisor/gestão poder devolver OS, solicitar correção, ou reabrir atendimento quando aplicável. Tudo deve gerar timeline/auditoria. **Não sobrescrever histórico de execução anterior** — mesmo princípio já aplicado em `ServiceOrderExecution` (histórico preservado mesmo quando o técnico é desativado, ver `docs/TECHNICIAN-EXECUTION.md`).

---

# 111. AVALIAÇÃO DO ATENDIMENTO **[DIFERENCIAL]**

Cliente poderá avaliar o atendimento (nota, satisfação, comentário). **Não usar avaliação isolada como medida automática de desempenho disciplinar** — é um sinal entre vários, não um veredito.

---

# 112. SLA — APROFUNDAMENTO **[IMPORTANTE]**

Aprofundar o conceito já citado na Parte I: prazo, prioridade, janela, atendimento agendado, atraso, tempo até atribuição, tempo de deslocamento (seção 78), tempo de atendimento, tempo até conclusão. O dashboard poderá usar esses dados futuramente para métricas operacionais.

---

# 113. LGPD / PRIVACIDADE

Esta seção separa dois níveis de exigência distintos — não tratar privacidade como um bloco único de prioridade.

## Obrigatório para MVP / produção **[MVP — requisito transversal, não opcional]**

Privacidade e proteção básica de dados pessoais são requisito transversal obrigatório para o AlfaOS entrar em produção, no mesmo nível que segurança e multi-tenancy (seções 42–46). Inclui:

- minimização de dados;
- autorização por função (RBAC já implementado no Core);
- mascaramento de CPF quando apropriado — CPF não deve ser exibido integralmente sem necessidade;
- proteção de GPS — finalidade operacional definida, nunca coleta genérica "para ter caso precise". Requisitos específicos de rastreamento do técnico e retenção de histórico estão na seção 138;
- proteção de fotos;
- proteção de assinatura;
- AuditLog (já implementado no Core);
- segurança de sessão (já implementada no Core);
- isolamento multi-tenant (já implementado no Core — seção 6);
- não exposição de informações financeiras/desnecessárias ao técnico;
- tratamento seguro de dados pessoais em qualquer módulo novo.

Isto **não** pode ser interpretado como algo opcional ou puramente futuro — é obrigatório desde o Core atual e continua obrigatório em cada módulo novo da Parte II (GPS, fotos, offline, histórico do cliente) desde o momento em que esse módulo for implementado, não depois.

## IMPORTANTE / evolução **[IMPORTANTE]**

Podem ficar como evolução posterior, sem bloquear a operação inicial:

- políticas avançadas de retenção configurável;
- ferramentas administrativas avançadas de governança;
- workflows específicos de privacidade (ex.: atendimento formal a solicitações de titular);
- automações de ciclo de vida de dados;
- recursos adicionais de compliance que não sejam necessários para a operação segura inicial.

---

# 114. SAAS MULTIEMPRESA — APROFUNDAMENTO **[FUTURO]**

O AlfaOS será, no médio/longo prazo, um produto comercial multiempresa. Planejar (sem implementar agora): onboarding, empresas, usuários, técnicos, limites, planos, feature flags, integrações por empresa, personalização, cobrança, métricas, suporte. **Não implementar billing agora** — a arquitetura multi-tenant do Core (seção 6) já é o alicerce necessário; o que falta é a camada comercial, que é FUTURO.

---

# 115. ECONOMIA DE TOKENS / PROCESSO DE DESENVOLVIMENTO

O processo de desenvolvimento usa documentação modular e economia de contexto conforme `CLAUDE.md` e `docs/CONTEXT-MAP.md` — não duplicado aqui. Consulte esses arquivos para as regras de leitura seletiva, uso de Sonnet/Opus, estratégia de testes e uso de subagentes.

---

# 116. SKILLS FUTURAS

Estratégia interna de desenvolvimento, não funcionalidade do produto — detalhada em `CLAUDE.md`. Candidatas (não criar agora, só quando houver repetição real): `alfaos-security-review`, `alfaos-service-orders`, `alfaos-testing`, `alfaos-flutter`, `alfaos-integrations`, `alfaos-release`.

---

# 117. PRIORIZAÇÃO — CLASSIFICAÇÃO MVP / IMPORTANTE / DIFERENCIAL / FUTURO

**MVP** — necessário para o AlfaOS cumprir sua função principal (seção 4).
**IMPORTANTE** — grande valor operacional, mas pode entrar após o núcleo estar estável.
**DIFERENCIAL** — funcionalidade que diferencia o AlfaOS de sistemas tradicionais.
**FUTURO** — estratégia de longo prazo ou integração avançada.

Não classificar tudo como MVP. Classificação por módulo/bloco:

> **Duas escalas, dois eixos — desde 2026-08-25.** Esta tabela classifica o
> **produto inteiro**. A Parte V (§194) classifica a **trilha Field** em
> P0/P1/P2. As duas convivem: uma capability pode ser DIFERENCIAL para o
> produto e P0 para o Field — é o caso do Wi-Fi Analyzer, que diferencia o
> AlfaOS de sistemas tradicionais **e** é indispensável no primeiro aplicativo
> que o técnico vai usar. Quando as duas colunas divergirem, **a §194 é a
> autoridade sobre o que entra no Field**, e esta tabela sobre o que o produto
> considera essencial.

| Módulo / Funcionalidade | Classificação |
| --- | --- |
| AlfaOS Core (empresas, usuários, técnicos, clientes, OS, máquina de estados) | MVP |
| Execução do técnico (diagnóstico/serviço/observações — v0.3) | MVP |
| Fechamento (fotos, materiais simples, assinatura, PDF — v0.4) | MVP |
| OS própria do AlfaOS — origem INTERNAL (seções 122, 124) | MVP |
| Importação de OS externa — origem EXTERNAL com idempotência (seções 122, 123) | IMPORTANTE |
| Tipos de OS configuráveis por empresa — `ServiceOrderType` básico (seção 125) | IMPORTANTE |
| Localização/enriquecimento de Customer via ERP (seção 128) | IMPORTANTE |
| Recolhimento de equipamentos — fluxo completo (seção 126) | FUTURO |
| Entrega de carnê — workflow com desfechos próprios (seção 127) | FUTURO |
| Motor de regras por tipo de OS (checklist, obrigatoriedades dinâmicas) | FUTURO — **P0 na trilha Field** (§164, §165, §166) |
| Identidade individual do técnico / desativação sem perda de histórico | MVP |
| Integração ReceitaNet real | IMPORTANTE |
| Cliente ausente / reagendamento | IMPORTANTE |
| Histórico técnico do cliente / reincidência | IMPORTANTE |
| Controle de qualidade (protocolos mínimos por tipo de OS) | IMPORTANTE |
| SLA (aprofundamento operacional) | IMPORTANTE |
| Privacidade básica de dados pessoais (minimização, mascaramento de CPF, proteção de GPS/fotos/assinatura, AuditLog, sessão, isolamento multi-tenant) | MVP — requisito transversal obrigatório |
| Governança avançada de privacidade (retenção configurável, workflows de titular, automação de ciclo de vida) | IMPORTANTE |
| Field App Flutter (app nativo) — especificação completa na Parte V | DIFERENCIAL |
| GPS, rota, mapa dos atendimentos | DIFERENCIAL |
| Localização do cliente confirmada em campo (`CustomerLocation`, seção 134) | IMPORTANTE |
| Compartilhamento de localização do técnico (`TechnicianLocation`, seção 135) | DIFERENCIAL |
| Mapa operacional no painel Web (`OperationalMap`, seção 136) | DIFERENCIAL |
| Navegação abrindo app externo (Google Maps/Waze) | DIFERENCIAL |
| Técnicos próximos ao abrir a OS | DIFERENCIAL |
| Despacho assistido — sistema sugere, pessoa decide (seção 137) | FUTURO |
| Roteirização de múltiplas OS (Route Optimization Engine) | FUTURO |
| Diagnóstico Rápido do cliente | DIFERENCIAL |
| Technician Toolkit (Wi-Fi Analyzer, speed test, antes/depois, recomendador Wi-Fi, teste por cômodos) | DIFERENCIAL — **Wi-Fi Analyzer, recomendador, speed test, gateway discovery e quick diagnostics são P0 na trilha Field** (§174–§179); teste por cômodos continua FUTURO |
| Assistente de configuração de roteadores | **assistida: P0 na trilha Field** (§178) · **automatizada por adapter: P1** · acesso remoto: FUTURO |
| QR Code / Barcode de equipamentos | DIFERENCIAL — **leitura básica é P0 na trilha Field** (§180); vínculo e baixa dependem do ledger (P1) |
| Checklists inteligentes dinâmicos | DIFERENCIAL — **P0 na trilha Field** (§165) |
| Comunicação integrada (ligação/WhatsApp/chat) | DIFERENCIAL |
| Segurança avançada de dispositivo (biometria, revogação remota) | DIFERENCIAL |
| Avaliação do atendimento pelo cliente | DIFERENCIAL |
| Estoque por técnico (completo, com RMA/rastreabilidade) — modelado como **ledger de movimentos**, não contador (§181) | FUTURO — **P1 na trilha Field** |
| Modo offline — **fundação** (outbox local, idempotência, política de conflito) | **P0 na trilha Field** (§158–§161) |
| Modo offline — **maturidade completa** (merge assistido, pré-sync preditiva, cache seletivo) | FUTURO |
| Base de conhecimento | FUTURO — **P1 na trilha Field** (§183) |
| Notificações push + central de notificações | **P0 na trilha Field** (§153, §154) |
| Registro de dispositivo móvel (`MobileDevice`, revogação remota) | **P0 na trilha Field** (§155) |
| Transactional Outbox + fila de jobs com retry | **P0 na trilha Field** (§156, §157) |
| Evidências fotográficas estruturadas por categoria | MVP (evolução da §31/§92) — **P0 na trilha Field** (§162) |
| Registro de execução de ferramentas (`ToolExecution`) | **P0 na trilha Field** (§176) |
| Field API — versionamento, idempotência, contratos de sync | **P0 na trilha Field** (§192, §195) |
| Formulários dinâmicos configuráveis por empresa | FUTURO — **P2 na trilha Field** (§192) |
| Skills do técnico, disponibilidade e turnos | IMPORTANTE — **P1 na trilha Field** (§185) |
| Pré-diagnóstico remoto | FUTURO |
| Correlação de incidentes | FUTURO |
| Integração OLT / RADIUS / ACS / FiberMap | FUTURO |
| Assistente inteligente (IA) | FUTURO |
| Reabertura/devolução formal de OS | FUTURO |
| SaaS multiempresa comercial (billing, planos) | FUTURO |

Uma funcionalidade classificada como DIFERENCIAL ou FUTURO **não** entra automaticamente na próxima versão — precisa de escopo aprovado explicitamente (seção 119).

---

# 118. ROADMAP ATUALIZADO — TRILHAS DE LONGO PRAZO

O roadmap imediato do Core está na seção 131 (a seção 69 guarda o histórico). Esta seção mostra as quatro trilhas de longo prazo, que **não avançam em paralelo automaticamente** — cada uma só começa quando fizer sentido de produto e tiver escopo aprovado.

## Core 1.0

```text
v0.3 Technician Execution                    [concluído]
 ↓
v0.4 Fechamento e evidências                 [concluído]
 ↓
v0.5 Fundação de ERP + diagnóstico           [concluído]
 ↓
v0.5.1 Pilot Readiness + OS próprias
 ↓
v0.6 ReceitaNet Foundation (CallCenter read-only)
 ↓
Pilot
 ↓
Release AlfaOS 1.0
```

Detalhamento na seção 131.

## Field App

> **Ordem revisada em 2026-08-25. A §194 é a autoridade.** A sequência
> original colocava **Offline depois de GPS/Rotas**. Isso se inverteu: a
> fundação offline é **P0** (§158) e o tracking é **P1** (§186). Offline não é
> uma camada que se acrescenta sobre um app pronto — ele determina a forma de
> toda tela e de toda rota mutante, e adicioná-lo depois é reescrever as duas.

```text
P0   base do app + offline foundation + notificações
      + evidências estruturadas + toolkit essencial
 ↓
P1   GPS / rotas / mapa · inventário como ledger
      OLT/ONU · SLA · base de conhecimento
 ↓
P2   comunicação · IA · despacho inteligente · formulários dinâmicos
```

Detalhamento item a item na §194; fundações de backend na §195.

## Technician Toolkit

> **Ordem revisada em 2026-08-25 (§194).** Wi-Fi Analyzer, recomendação de
> canal, gateway discovery, quick diagnostics e speed test entram **juntos no
> P0** — são o conjunto mínimo que substitui os aplicativos de terceiro que o
> técnico usa hoje no celular pessoal. Teste por cômodos continua FUTURO.

```text
P0   Wi-Fi Analyzer · recomendação de canal · gateway discovery
      quick diagnostics · speed test · configuração assistida de roteador
 ↓
P1   antes/depois · óptica/OLT · automação de roteador por adapter
 ↓
FUTURO   teste de cobertura por cômodos · servidor de teste próprio
```

## Network Intelligence

```text
OLT
 ↓
RADIUS
 ↓
ACS
 ↓
FiberMap
 ↓
Incident Correlation
 ↓
IA
```

Não fixar versões numeradas artificiais para as trilhas de Field App, Toolkit e Network Intelligence agora — elas serão versionadas quando o escopo de cada fase for aprovado.

---

# 119. PRINCÍPIO DE ESCOPO

O PRD representa a **visão** do produto. Ele **não autoriza automaticamente implementação**.

Cada versão deve possuir seu próprio escopo aprovado explicitamente antes de virar código. Nenhum agente (humano ou IA) deve implementar uma funcionalidade classificada como DIFERENCIAL ou FUTURO apenas porque ela está registrada neste documento. "Estar no PRD" e "dever ser implementado agora" são coisas diferentes — este documento existe para que essa distinção nunca fique implícita.

---

# 120. DEFINIÇÃO DA VISÃO FINAL

> O objetivo do AlfaOS é ser o ambiente operacional central do técnico de telecom.

O técnico deverá conseguir receber o atendimento, chegar ao cliente, diagnosticar rede e Wi-Fi, consultar infraestrutura, configurar equipamentos, executar o serviço, utilizar materiais, registrar evidências, pedir suporte e finalizar a Ordem de Serviço dentro de um único ecossistema.

A plataforma deverá, ao mesmo tempo, fornecer à empresa rastreabilidade, segurança, produtividade, padronização e inteligência operacional.

Esta visão final complementa — e não substitui — o "Princípio Final" da seção 71: qualidade continua sendo definida por confiabilidade, velocidade, simplicidade, segurança, experiência do técnico e integração correta com o ERP, não pela quantidade de funcionalidades implementadas.

---

# PARTE III — ARQUITETURA DE ORDEM DE SERVIÇO PRÓPRIA

Registrada após a análise dos OpenAPI oficiais do ReceitaNet (URA, Chatbot, CallCenter e Central do Assinante). A Parte I (seções 1–71) permanece a base funcional/técnica do Core; a Parte II (72–120) registra a visão de longo prazo. A Parte III fixa uma decisão que as duas anteriores deixavam implícita: **de quem é a Ordem de Serviço**, e onde os ERPs se encaixam nisso.

Nada da Parte II é removido ou rebaixado aqui. GPS e rotas (77–79), mapa dos atendimentos (79), diagnóstico rápido (80), Technician Toolkit e Wi-Fi Analyzer (82–88), QR/Barcode (89), estoque por técnico (90), modo offline (98), OLT/RADIUS/ACS (104–106), FiberMap (107), IA (108) e SaaS multiempresa (114) permanecem válidos com as mesmas classificações. A Parte III apenas define **onde** eles se encaixam: todos são capacidades do Core ou do Field App, consumidas através da API/Core (seção 130), nunca acopladas a um ERP específico (seção 81).

---

# 121. PREMISSA CENTRAL — PROPRIEDADE DA ORDEM DE SERVIÇO

> **O AlfaOS é o sistema de execução e gestão operacional das Ordens de Serviço.**

ERPs — ReceitaNet, SGP, IXC, HubSoft e outros — podem exercer um ou mais destes papéis:

- origem de uma OS;
- fonte de dados do cliente;
- destino de sincronização;
- qualquer combinação dos três.

Nenhum deles é o motor operacional.

**Regras de produto (normativas):**

> **A origem da OS pode mudar; o motor de execução não.**

> **O ERP pode ser origem ou destino da OS, mas não controla o motor operacional do AlfaOS.**

Uma vez criada ou importada, a OS pertence ao domínio operacional do AlfaOS. Atribuição, máquina de estados, execução, evidências, concorrência e auditoria são decididas pelo Core — nunca pelo sistema externo.

Consequência prática e verificável: a indisponibilidade de um ERP nunca pode impedir um técnico de iniciar, executar ou concluir um atendimento. Essa invariante já vale para diagnóstico (`docs/ERP-INTEGRATIONS.md` §10) e passa aqui a valer para toda a superfície de OS.

---

# 122. ORIGENS DA OS — INTERNAL E EXTERNAL

Duas origens oficiais:

```text
INTERNAL   OS criada diretamente no AlfaOS
EXTERNAL   OS importada/recebida de ERP ou outro sistema
```

Ambas usam o **mesmo** fluxo de execução:

```text
PENDING → ASSIGNED → IN_PROGRESS → COMPLETED
```

(`CANCELLED` conforme seções 19–20.)

**Não criar máquina de estados por ERP.** Um fluxo por integração multiplicaria as transições a auditar, e cada integração nova viraria superfície de segurança nova em vez de um adapter. A origem é um **atributo** da OS, não um regime de execução.

A origem é um **campo gravado** (`ServiceOrder.origin`), definido no ponto de criação e nunca derivado dos campos externos.

> **Correção (v0.5.1).** Uma versão anterior desta seção dizia que a origem era observável pela presença de `external_provider`/`external_id`. Isso está errado e contradizia a própria regra seguinte: uma OS INTERNAL **pode ganhar vínculo com ERP depois e continua INTERNAL**. Derivar a origem dos campos externos faria exatamente esse caso mentir sobre a procedência.

A implicação vale só no outro sentido: **EXTERNAL exige** `external_provider` e `external_id` — garantido por CHECK no banco. INTERNAL pode ter os dois campos preenchidos, vazios, ou vir a preenchê-los.

A origem pode restringir **o que a empresa edita** numa OS importada. Nunca restringe **como o técnico executa**.

---

# 123. IDENTIDADE EXTERNA E IDEMPOTÊNCIA

Reforço da seção 15, agora com a consequência explícita para importação.

Toda OS EXTERNAL preserva:

```text
AlfaOS internal ID   ← identidade primária, sempre
company_id
external_provider
external_id
```

**`external_id` nunca vira primary key.** Ele não é único globalmente: o mesmo número em empresas diferentes são OS diferentes, e dois ERPs podem emitir o mesmo identificador.

A tripla `(company_id, external_provider, external_id)` é o que garante **idempotência de importação** — reimportar não duplica, apenas atualiza os dados externos. Essa garantia é de banco (constraint de unicidade), não de código de aplicação; ver seção 24.

---

# 124. OS PRÓPRIA DO ALFAOS

O AlfaOS cria OS independentemente de qualquer ERP. Isso não é plano B para quando a integração falha — é capacidade de produto de primeira classe, e hoje é a origem majoritária na prática (ver seção 129).

Casos de uso iniciais — **exemplos, não enumeração fechada**:

Instalação · Manutenção · Recolhimento de equipamentos · Entrega de carnê · Troca de equipamento · Troca de ONU · Troca de roteador · Mudança de endereço · Visita técnica · Vistoria · Visita preventiva · Retirada de cabo · Outros

**Estes exemplos não devem virar enum rígido no schema.** Cada provedor tem seu vocabulário operacional, e um enum obrigaria uma migration a cada empresa nova — exatamente o acoplamento que a arquitetura multiempresa existe para evitar. O campo `type` da OS permanece texto (seção 17), evoluindo para referência a `ServiceOrderType` (seção 125).

---

# 125. SERVICEORDERTYPE — TIPOS CONFIGURÁVEIS POR EMPRESA **[IMPORTANTE]**

Conceito: cada empresa define seu próprio catálogo de tipos de OS.

```text
ServiceOrderType
 ├── company_id        (isolamento obrigatório)
 ├── nome
 ├── descrição
 ├── ativo / inativo
 └── ordem de exibição
```

**MVP do conceito: apenas o acima.** Nome, descrição, ativo, ordem. Nada mais.

Campos previstos para evolução, **deliberadamente não projetados agora**:

checklist · fotos obrigatórias · assinatura obrigatória · materiais esperados · equipamentos esperados · campos específicos · regras de conclusão

Esses ficam registrados como **direção, não como especificação**. Cada um deles é uma regra que muda como a OS conclui — ou seja, mexe na máquina de estados e no fechamento, que são superfície crítica. Especificar tudo agora produziria um Dynamic Forms Engine antes de existir um único cliente usando tipos configuráveis, e o motor errado é mais caro de remover do que de não escrever.

Desativar um tipo **não apaga histórico**: OS já criadas com ele permanecem íntegras, seguindo a mesma regra da desativação de técnico (seção 74).

---

# 126. RECOLHIMENTO DE EQUIPAMENTOS **[IMPORTANTE — fluxo FUTURO]**

Caso de uso oficial.

Fluxo futuro:

```text
OS
 → equipamentos esperados
 → técnico recolhe
 → serial / QR
 → estado do equipamento
 → fotos
 → assinatura
 → estoque do técnico
 → devolução ao estoque da empresa
```

Depende de Estoque por Técnico (seção 90, FUTURO) e de QR/Barcode (seção 89). **Nada de estoque é implementado por esta seção.** Ela existe para que o desenho de `ServiceOrderType` e o de materiais não inviabilizem o caso de uso por acidente.

Atenção arquitetural desde já: recolhimento move **posse física** de um ativo entre três lugares — cliente → técnico → empresa. Isso é integridade de dados sob concorrência, não um formulário a mais.

---

# 127. ENTREGA DE CARNÊ **[IMPORTANTE — fluxo FUTURO]**

Caso de uso oficial. É uma OS **sem serviço técnico**: o resultado é a entrega em si.

Resultados possíveis:

```text
entregue
cliente ausente
endereço não localizado
recusado
```

Pode exigir nome de quem recebeu, assinatura e evidência fotográfica.

Esta seção registra uma lacuna real do modelo atual: hoje uma OS só conclui como `COMPLETED`. "Cliente ausente" e "endereço não localizado" são **desfechos legítimos e não são falha do técnico** — conectam-se com a seção 94 (cliente ausente) e a seção 95 (reagendamento). O desenho desses desfechos altera a máquina de estados e **não é decidido aqui**.

---

# 128. CLIENTE E ERP — LOCALIZAÇÃO E ENRIQUECIMENTO

O `Customer` do AlfaOS (seção 14) **continua sendo entidade própria**. O ERP é fonte de dados, não dono do cadastro.

Modelo:

```text
buscar no ERP       → nome | CPF/CNPJ | telefone
importar/atualizar  → id externo, nome, endereço, plano,
                      tecnologia, status do contrato, conectividade
complementar        → o que o ERP não tem, o AlfaOS preenche
```

Dois pontos decorrem diretamente da análise das APIs (seção 129) e devem orientar o desenho:

**Nenhum ERP entrega o cadastro completo.** O enriquecimento é **parcial por natureza** — o AlfaOS não pode tratar "sincronizado" como sinônimo de "cadastro completo", e o que falta continua sendo preenchido no AlfaOS.

> **Corrigido pela homologação de 2026-08-25 (§140).** A afirmação original desta seção — de que telefone, número do endereço e coordenadas não apareciam em nenhuma API ReceitaNet — valia para as quatro APIs **lidas em spec**. Contra a API real, a **Chatbot** devolve telefones, e-mail, endereço com número e referência, e coordenadas. A lacuna era de leitura, não do provider. O princípio acima sobrevive: o Chatbot também não entrega tudo, e nenhum ERP entrega.

**Campo preenchido no AlfaOS não pode ser silenciosamente sobrescrito por sync.** Se um despachante corrigiu o número da casa que o ERP não tem, uma sincronização posterior não pode apagar a correção.

A regra de precedência campo a campo **deixou de ser decisão pendente** e está fixada na §143: contato preenche apenas o que está vazio, credencial obedece a uma hierarquia de procedência, e localização importada nunca nasce verificada.

---

# 129. ESTADO REAL DAS APIS RECEITANET

**Esta seção substitui a seção 27 quanto ao estado factual.** A seção 64 (regra crítica) permanece integralmente válida.

> **Atualizada em 2026-08-25 pela §140.** O quadro abaixo descreve as APIs **como lidas em spec**, em 2026-08-24, antes de qualquer chamada real. Duas conclusões desta seção foram superadas por homologação contra a API real e não devem mais ser citadas como estado atual:
>
> - *"CallCenter é hoje a melhor candidata"* — continua verdadeiro **para busca, detalhe e diagnóstico**, e deixou de ser a resposta única: o enriquecimento cadastral e a credencial PPPoE vêm da **Chatbot**. As duas são capabilities independentes (§140).
> - *"nenhuma API devolve telefone, número do endereço ou coordenada"* — falso desde a homologação da Chatbot. Ver §140 e `docs/RECEITANET-HOMOLOGATION.md`.
>
> O que **não** mudou, e agora tem confirmação do próprio provider: não existe listagem global de OS da empresa (§141).

Foram localizados e lidos **quatro OpenAPI oficiais**:

| API | OpenAPI | Autenticação |
| --- | --- | --- |
| URA | 3.0.3 | `app` + `token` no corpo JSON |
| Chatbot | 3.0.3 | `token` + `app` em query string |
| CallCenter | 3.0.3 | `token` em header HTTP |
| Central do Assinante | 3.1.0 | Bearer JWT, escopado por cliente |

**CallCenter é hoje a melhor candidata** para dados operacionais de cliente e diagnóstico: é a única com busca por nome, a única que devolve endereço junto da busca, a única com health check e a única com autenticação em header.

**O que nenhuma das APIs públicas confirmou:**

- listagem global de OS/chamados da empresa;
- delta sync (filtro por data de criação ou alteração);
- webhook;
- callback de novas OS.

**Consequência de produto — e ela é estrutural:**

O AlfaOS **deve estar preparado para receber OS externa**; o modelo EXTERNAL (seção 122) existe exatamente para isso. Mas **não se deve afirmar que o ReceitaNet consegue hoje enviar todas as OS da empresa**, porque nenhuma API documentada oferece esse mecanismo.

**Não inventar mecanismo.** Não tratar varredura cliente a cliente como equivalente a sincronização, não presumir webhook não documentado, não presumir endpoint privado. Enquanto o mecanismo de descoberta não existir e não estiver documentado, a origem prática de OS no AlfaOS é **INTERNAL**, e o EXTERNAL fica pronto e aguardando.

Isso **reforça**, em vez de enfraquecer, a premissa da seção 121: o motor precisa ser do AlfaOS justamente porque não se pode depender do ERP nem para saber que uma OS existe.

---

# 130. ARQUITETURA OFICIAL — WEB, FIELD E CORE

```text
AlfaOS Web
        │
        ├──── AlfaOS API/Core ─── PostgreSQL
        │              │
AlfaOS Field           ├─ ReceitaNet
                       ├─ SGP
                       ├─ IXC
                       └─ outros
```

## AlfaOS Web — centro de comando administrativo

Perfis principais: **ADMIN**, **DISPATCHER** e **Gestor**, quando implementado.

Responsabilidades: clientes · tipos de OS · criação de OS · importação de OS · atribuição · agenda · acompanhamento · **mapa operacional (seção 136)** · evidências · relatórios · usuários e técnicos · integrações.

## AlfaOS Field — aplicativo dedicado do técnico

Tecnologia planejada: **Flutter**, **Android primeiro**, iOS posteriormente. Decisão registrada na seção 75; o alcance limitado descrito na seção 61 continua valendo integralmente — estar planejado aqui não autoriza implementação.

Jornada:

```text
login → minhas OS → detalhe → navegação → iniciar
      → diagnóstico → execução → fotos
      → materiais/equipamentos → assinatura → concluir
```

Responsabilidades futuras: GPS · localização em background · navegação por app externo · confirmação da localização do cliente · execução das OS · fotos · materiais · assinatura · acesso PPPoE · QR/barcode · offline mais adiante.

O Field App **consome a mesma API/Core do painel Web**. **Não duplicar regra de negócio no aplicativo.** Regra duplicada é regra que diverge: a cópia do app fica para trás e a diferença aparece como falha de autorização em campo, não como erro de compilação.

Vale integralmente para geolocalização: **o app coleta, o Core decide.** Uma coordenada enviada pelo aparelho é dado de entrada, nunca prova de autorização — nenhuma checagem de acesso passa a depender de onde o técnico diz estar.

Offline é evolução posterior (seção 98).

## O Core é a autoridade

O Core — e somente ele — é autoridade sobre:

```text
tenancy
ownership
ServiceOrder state machine
execução
evidências
auditoria
concorrência
idempotência
```

Web e Field são **clientes** dessa autoridade. Nenhum dos dois reimplementa qualquer item da lista. Nenhum ERP participa de qualquer item da lista.

---

# 131. ROADMAP REVISADO — INDICATIVO

Substitui a ordem da seção 69 daqui para frente. **Indicativo, não promessa contratual** — a seção 119 se aplica a cada etapa.

```text
v0.5-receitanet-diagnostics                     [CONCLUÍDO — tagueado]
        ↓
v0.5.1-pilot-readiness                          [CONCLUÍDO — tagueado]
        ↓
v0.6 · v0.6.1 · v0.6.2                          [CONCLUÍDO — tagueado]
ReceitaNet Foundation — CallCenter read-only
        ↓
v0.7 · v0.7.1 · v0.7.2                          [CONCLUÍDO — sem tag]
Chatbot: enriquecimento cadastral + credencial PPPoE real
credenciais independentes por capability
        ↓
v0.7.x                                          [PRÓXIMA ETAPA]
UX do técnico (§145–§148) + tema claro/escuro (§149)
        ↓
v0.8
/v1/chamados → ServiceOrder EXTERNAL por cliente (§142)
        ↓
Piloto
1 técnico + OS reais
        ↓
Estabilização da API
        ↓
AlfaOS Field (Flutter)
```

Depois disso, sem ordem fixada: descoberta global de OS **quando e se** o
ReceitaNet liberar API (§141) · Field App em Flutter · GPS ·
`CustomerLocation` · mapa operacional · roteirização · modo offline ·
ferramentas técnicas.

**A trilha Field tem roadmap próprio, em P0/P1/P2, na §194**, e as fundações
de backend que ela exige estão na §195. Ela não avança em paralelo
automaticamente: começa quando for formalmente autorizada, como qualquer
outra (§119).

Cada etapa exige escopo aprovado antes de virar código, e auditoria independente quando tocar superfície crítica.

**Geolocalização e mapa operacional (seções 133–139) são capability oficial do
Field/Dispatch, e não alteram a próxima etapa.** `CustomerLocation` pode entrar
antes do Field App, porque é cadastro e vive no Core; o rastreamento do técnico
depende do app existir. **Nada disso é antecipado para a v0.7.x nem para a
v0.8** — a §119 se aplica: estar no PRD não autoriza implementar.

---

# 132. CONEXÃO DO CLIENTE E CREDENCIAL DE ACESSO

```text
Customer
 └── CustomerConnection   (PPPOE hoje; coleção desde o início)
      └── credencial      (AES-256-GCM, AAD, nunca em claro)
```

**A credencial pertence à CONEXÃO DO CLIENTE, não à Ordem de Serviço.** A
mesma senha serve todas as OS daquele cliente; guardá-la na OS a duplicaria a
cada atendimento, e as cópias divergiriam no instante em que a senha mudasse.

MVP: `companyId`, `customerId`, `type`, `username`, credencial cifrada,
`active`, timestamps. **Não** é um engine de rede — IPoE, DHCP, CGNAT, IP
estático, VLAN, ONU, OLT e RADIUS continuam fora de escopo (Parte II).

## Regra de produto

> **O Field App pode revelar uma credencial de acesso somente quando
> autorizado por uma OS ativa atribuída ao técnico.**

A OS é a superfície de autorização, como já é para diagnóstico. Uma rota por
id de cliente daria a qualquer técnico autenticado um oráculo sobre a base
inteira de clientes da empresa.

Depois de `COMPLETED` o técnico continua vendo a OS, mas **não revela a senha
de novo**: senão uma OS antiga viraria chave permanente para a conexão daquele
cliente. ADMIN mantém a capacidade administrativa.

O texto claro nunca entra na resposta inicial da OS — só numa requisição
separada, explícita e auditada. Detalhe em `docs/SECURITY.md` §8.5.

## Origem da credencial

> **Superado na v0.7.** O texto original desta subseção dizia que nenhum
> OpenAPI ReceitaNet documentava usuário ou senha PPPoE e que o cadastro era
> necessariamente manual. A **Chatbot** entrega os dois em `logins[]`, com a
> senha em texto claro — comprovado contra a API real, não em spec.

O cadastro manual continua existindo e continua sendo o padrão quando não há
capability configurada. A procedência de cada metade — usuário e senha — é
gravada e governa quem pode sobrescrever o quê: a regra oficial está na §144.

RADIUS segue fora de escopo. A §64 continua valendo integralmente: nenhuma
chamada além do que o contrato do provider descreve.

---

# 133. GEOLOCALIZAÇÃO — REGRA ARQUITETURAL

Três conceitos, com responsabilidades separadas:

> **`CustomerLocation` descreve onde o atendimento acontece.**
> **`TechnicianLocation` descreve onde a equipe está.**
> **`OperationalMap` conecta essas informações para operação e despacho.**

Separá-los não é organização estética. São dados com donos, ciclos de vida e
riscos de privacidade completamente diferentes: a localização do cliente é
cadastral e muda raramente; a do técnico é telemetria de alta frequência sobre
uma pessoa; e o mapa não é dado nenhum — é uma leitura que combina os dois.
Fundi-los produziria uma tabela que ninguém consegue reter, expirar nem
autorizar corretamente.

Esta seção **complementa** as seções 77, 78 e 79, que descrevem a experiência
do técnico em campo. As seções 133–138 descrevem o **modelo e as invariantes**
por trás dela.

**Modelo conceitual, não especificação de banco.** Nada aqui autoriza migration
(seção 119). Os nomes de campo e de enum são indicativos e serão fixados quando
cada fatia for aprovada.

E a regra que já governa a OS continua valendo sem exceção:

> **A origem da OS pode mudar; o motor de execução não.**

Geolocalização é insumo do motor, nunca substituto dele. Nenhuma decisão de
autorização, estado ou integridade passa a depender de uma coordenada.

---

# 134. CUSTOMERLOCATION **[IMPORTANTE]**

A localização pertence ao **Customer**, não à ServiceOrder.

O motivo é o mesmo de `CustomerConnection` (seção 132): o ponto físico é o
mesmo em todos os atendimentos daquele cliente. Guardá-lo na OS o duplicaria a
cada visita, e as cópias divergiriam no instante em que alguém corrigisse uma
delas. A localização **existe independentemente de qualquer OS** — um cliente
recém-cadastrado já pode ter coordenada.

Modelo conceitual:

```text
CustomerLocation
 ├── latitude / longitude
 ├── accuracy          (metros; qualidade da captura)
 ├── source            (de onde veio a coordenada)
 ├── verified          (alguém confirmou em campo?)
 ├── verifiedAt / verifiedBy
 ├── referência        (ponto de acesso, observação de chegada)
 └── updatedAt
```

Origens possíveis, **indicativas**:

```text
MANUAL           digitada por um operador
GEOCODED         derivada do endereço
IMPORTED         veio de sistema externo
TECHNICIAN_GPS   capturada pelo GPS do técnico no local
```

**`source` e `verified` são eixos distintos, e essa é a decisão central desta
seção.** `source` diz de onde o número veio; `verified` diz se alguém esteve
lá. Uma coordenada `GEOCODED` pode ser confirmada por um técnico que chegou ao
local certo — permanece `GEOCODED` de origem e passa a ser `verified`. Colapsar
os dois num único enum perderia justamente essa combinação.

> **Reconciliação com a seção 77.** Aquela seção propôs uma lista única
> (`IMPORTADA_DO_ERP`, `NÃO_CONFIRMADA`, `CONFIRMADA_PELO_TÉCNICO`) que mistura
> os dois eixos. O modelo desta seção a substitui: `IMPORTADA_DO_ERP` vira
> `source: IMPORTED`, `NÃO_CONFIRMADA` vira `verified: false`, e
> `CONFIRMADA_PELO_TÉCNICO` vira `verified: true` — com `source` preservando
> separadamente a procedência. O restante da seção 77 continua válido.

**Uma localização confirmada em campo precisa ser distinguível de uma
geocodificada por endereço.** Não é detalhe de UI: são níveis de confiança
diferentes, e a operação decide coisas diferentes com cada um. Um ponto
geocodificado a partir de "Estrada Municipal, s/n, Zona Rural" pode estar
quilômetros longe da porta do cliente, e o técnico que confia nele se perde.

Estado atual: `Customer` já carrega `latitude`/`longitude` opcionais (seção 14).
Se o modelo acima vira colunas adicionais em `Customer` ou entidade própria é
decisão de implementação **deliberadamente adiada** — depende de haver ou não
mais de um ponto por cliente, o que hoje não é requisito.

## Confirmação em campo

No AlfaOS Field o técnico poderá:

- ver o ponto cadastrado no mapa;
- ver a distância entre onde ele está e o ponto;
- **confirmar** que a localização está correta;
- **corrigir** usando a posição GPS atual;
- registrar a precisão da captura.

```text
Você está a 18 metros do ponto cadastrado.

[Confirmar localização]   [Corrigir localização]
```

Especialmente relevante em **clientes rurais**, onde o endereço textual
frequentemente não geocodifica para lugar nenhum útil.

Toda alteração é rastreável — ator, momento, coordenada anterior, coordenada
nova e precisão — no mesmo padrão de `AuditLog`/`ServiceOrderEvent` já usado
pelo Core (seção 77).

---

# 135. TECHNICIANLOCATION **[DIFERENCIAL]**

O AlfaOS Field poderá compartilhar a posição do técnico durante a operação.

Modelo conceitual:

```text
TechnicianLocation
 ├── technicianId / companyId
 ├── serviceOrderId    (opcional — nem toda posição pertence a um atendimento)
 ├── latitude / longitude
 ├── accuracy
 ├── speed / heading   (opcionais)
 └── recordedAt
```

`serviceOrderId` é **opcional** de propósito: o técnico se desloca entre
atendimentos, e forçar um vínculo obrigaria a inventar uma OS para o intervalo.

## Última posição × histórico

Duas leituras com exigências opostas, e por isso **conceitualmente separadas**:

```text
Current/Last Technician Location   uma linha por técnico, sobrescrita
Location History                   série temporal, append-only
```

**O mapa ao vivo nunca pode varrer o histórico.** Com um punhado de técnicos
emitindo posição a cada 10–15 segundos, o histórico chega a milhões de linhas
em meses; um mapa que faz `ORDER BY recordedAt DESC LIMIT 1` por técnico sobre
essa tabela degrada exatamente quando a operação cresce. A leitura "onde estão
todos agora" precisa custar uma linha por técnico, não uma varredura.

Se isso vira duas tabelas, uma tabela com índice adequado ou um cache é decisão
de implementação. A **invariante** é que a leitura ao vivo não dependa do
volume acumulado.

## Frequência de envio

Números **indicativos**, ajustáveis depois de medir bateria e dados reais em
campo:

| Situação | Intervalo aproximado |
| --- | --- |
| Em deslocamento | 10–15 s, ou após deslocamento significativo |
| Parado / em atendimento | 30–60 s |
| Background | conforme o que o Android permitir |
| Fora da jornada | desligado, conforme política da empresa |

Enviar posição a cada segundo é o erro óbvio a evitar: consome bateria do
aparelho de trabalho do técnico, gasta o dado móvel dele e produz um histórico
que ninguém consegue reter. A regra prática é emitir por **movimento
significativo**, não por relógio.

## Atualização em tempo quase real

Para o primeiro piloto, **polling curto no painel é suficiente e honesto** —
poucos técnicos, poucas telas abertas. SSE/WebSocket/realtime são evolução
quando o custo do polling passar a incomodar.

**Nenhuma infraestrutura é escolhida nesta tarefa.**

---

# 136. OPERATIONAL MAP **[DIFERENCIAL]**

O **Mapa Operacional** pertence ao **AlfaOS Web / Dispatch**.

O Field App **fornece** localização e **consome** o que precisa para o próprio
atendimento; ele não é o mapa de comando.

> **Não confundir com a seção 79.** Aquela descreve o mapa do *dia do técnico*
> dentro do Field App — as OS dele, na ordem dele. Este é o mapa da *operação
> inteira*, para quem despacha. São públicos, escopos e permissões diferentes.

Deve futuramente exibir:

- técnicos;
- clientes;
- OS pendentes;
- OS agendadas;
- OS em andamento.

Filtros possíveis: técnicos · clientes · OS de hoje · pendentes · em
atendimento · concluídas · por tipo de OS · por técnico · por região.

## Estados visuais do técnico

```text
DISPONÍVEL
EM DESLOCAMENTO
EM ATENDIMENTO
OFFLINE
```

**Estes são estados de APRESENTAÇÃO, derivados — não uma máquina de estados
nova.** Saem da combinação de presença (há posição recente?), atividade
(está se movendo?) e OS (tem alguma `IN_PROGRESS`?). Persisti-los criaria um
segundo motor de estado ao lado do da OS, com as duas fontes divergindo na
primeira falha de rede. A OS continua sendo a única máquina de estados do
sistema (seções 19–20 e 122).

## Técnicos próximos

Ao abrir uma OS, o Dispatcher poderá ver quem está por perto:

```text
Carlos — 1,2 km
João   — 3,8 km
Pedro  — 7,4 km
```

**Distância não pode ser o único critério.** O técnico mais próximo pode estar
no meio de outro atendimento, sem a habilidade necessária ou com a agenda
cheia. Também devem pesar: disponibilidade, agenda, tipo da OS, habilidades,
carga de trabalho, SLA e região.

---

# 137. DESPACHO ASSISTIDO E ROTEIRIZAÇÃO **[FUTURO]**

## Despacho assistido

```text
OS nova
 → localização do cliente
 → localização e agenda dos técnicos
 → regras operacionais
 → SUGESTÃO de melhor técnico
```

**O sistema sugere; a pessoa decide.** Automação completa de despacho fica para
fase posterior, e essa ordem é deliberada: uma sugestão errada custa um clique,
uma atribuição automática errada custa uma viagem.

## Roteirização de múltiplas OS

Útil sobretudo para trabalho em lote: entrega de carnê (seção 127),
recolhimento de equipamentos (seção 126), visitas preventivas.

```text
Entrega de carnês — Rota Centro
  1. Cliente A
  2. Cliente B
  3. Cliente C
  4. Cliente D
```

Um algoritmo futuro poderá otimizar a ordem por distância, janela de horário,
prioridade e SLA. **Route Optimization Engine não é escopo agora.**

## Conexão com os fluxos já aprovados

Recolhimento de equipamentos (seção 126):

```text
lista de recolhimentos → agrupamento geográfico → rota → chegada
 → equipamento/serial/QR → evidência → assinatura → conclusão
```

Entrega de carnê (seção 127): a localização **confirmada** é o que torna esse
fluxo viável. É justamente nesse tipo de visita que "endereço não localizado"
aparece, e cada confirmação em campo corrige o cadastro para a próxima vez.

## Relação com a ServiceOrder

**Coordenadas não entram na OS.** A OS referencia o cliente; o cliente tem a
localização. O que a OS pode ganhar são **marcos de tempo**, não geometria:

```text
atribuição → saída/deslocamento → chegada → início → conclusão
```

Isso permite medir tempo de deslocamento e tempo de atendimento (insumo de SLA,
seção 112) sem duplicar dado geográfico. A preferência arquitetural da seção 78
continua valendo: status principal simples, mais eventos operacionais em
`ServiceOrderEvent`. **Nenhum desses marcos é implementado agora.**

## Navegação

No Field App:

```text
[Navegar até o cliente]
```

O MVP futuro **abre um aplicativo externo** — Google Maps, Waze ou o que
estiver instalado. Navegação turn-by-turn própria **não é requisito**, hoje nem
no horizonte próximo: é um produto inteiro, e existem bons gratuitos.

---

# 138. PRIVACIDADE DA LOCALIZAÇÃO

Complementa a seção 113, que continua valendo integralmente. Requisitos **de
produto** — política jurídica definitiva exige revisão legal e não é decidida
aqui.

- **O técnico precisa saber quando está sendo localizado.** Indicação visível e
  inequívoca no app.
- **Nada de rastreamento oculto.** Em nenhuma hipótese, por nenhuma
  configuração.
- **Início e fim definidos.** Quando o rastreamento começa e quando para
  precisa ser explícito, não implícito no app estar aberto. Fora da jornada,
  desligado.
- **Acesso ao mapa restrito a perfis autorizados**, com isolamento por
  `companyId` como em todo o resto do sistema.
- **Retenção com finalidade e prazo.** Histórico de localização não pode ser
  guardado indefinidamente "para o caso de precisar" — a seção 113 já proíbe
  coleta genérica de GPS, e retenção sem prazo é a mesma coisa deslocada no
  tempo. Política configurável é evolução; ter *alguma* política é requisito.
- **Auditoria** para acesso e alteração relevantes, quando aplicável — em
  especial a correção de `CustomerLocation`, que muda dado cadastral.

A assimetria é intencional: a localização do **cliente** é dado cadastral
operacional; a do **técnico** é dado pessoal de uma pessoa sob relação de
trabalho, e merece o tratamento mais restritivo dos dois.

---

# 139. RECEITANET E GEOLOCALIZAÇÃO

**Geolocalização é domínio do AlfaOS.**

O ReceitaNet pode fornecer dados cadastrais e endereço, **quando documentado**.

> **Corrigido em 2026-08-25 (§140).** Esta seção afirmava que nenhuma API
> ReceitaNet devolvia número do endereço nem coordenada. A **Chatbot devolve os
> dois** — comprovado contra a API real. A afirmação valia para as quatro APIs
> lidas em spec.

Isso **não** transfere geolocalização para o ERP. Coordenada de provider é
aproximação, entra como `IMPORTED` e nunca nasce verificada (§143); a
confirmação em campo (§134) continua sendo o que torna um ponto confiável.

Pertencem ao AlfaOS, sem depender de ERP nenhum:

```text
coordenadas · confirmação em campo · mapa · rastreamento
rotas · histórico · despacho assistido
```

Isso não é preferência arquitetural. A justificativa original — *nenhum OpenAPI
expõe coordenada* — caiu com a homologação da Chatbot, e a conclusão sobrevive
por um motivo mais forte, que não depende de qual API entrega o quê:

**um AlfaOS que dependesse do ERP para geolocalização teria a geolocalização
que aquele ERP quisesse dar.** Coordenada aproximada, sem confirmação em campo,
sem histórico, sem rastreamento e sem rota — e nenhuma delas no dia em que a
empresa trocar de provedor. Vale a mesma regra da seção 81: nenhuma
funcionalidade nova pode assumir um único ERP como dependência de arquitetura.


---

# PARTE IV — RECEITANET OPERACIONAL, EXPERIÊNCIA DO TÉCNICO E DESIGN SYSTEM

Registrada em 2026-08-25, depois da homologação das APIs ReceitaNet contra a
API real e da resposta oficial do suporte do provider sobre descoberta de OS.

As Partes I, II e III permanecem válidas. A Parte IV fixa o que passou a ser
**fato verificado** em vez de hipótese, corrige duas afirmações que a Parte III
fazia a partir de leitura de spec (§128, §129, §132) e registra três decisões
de produto que ainda não estavam escritas em lugar nenhum: a prioridade de
informação na tela do técnico, a separação de administração por papel e o
sistema de temas.

**A §119 se aplica a tudo aqui.** Estar registrado não autoriza implementar.

---

# 140. RECEITANET — DUAS CAPABILITIES INDEPENDENTES

O ReceitaNet deixou de ser "uma integração" no AlfaOS. São **duas capabilities**,
com credenciais próprias, ciclos de vida próprios e nenhuma dependência entre si:

```text
empresa
 ├── credencial CALLCENTER   →  busca · detalhe · diagnóstico · chamados do cliente
 └── credencial CHATBOT      →  enriquecimento cadastral · PPPoE · contexto operacional
```

| Capability | O que entrega |
|---|---|
| **CALLCENTER** | busca de clientes · detalhe do cliente · diagnóstico de conectividade (ONLINE/OFFLINE) · chamados abertos por cliente |
| **CHATBOT** | enriquecimento cadastral · PPPoE login · PPPoE senha real · telefones · e-mail · endereço · coordenadas · planos · contexto de servidor/conexão |

**As credenciais são independentes por empresa.** Configurar, trocar ou remover
uma **não pode** remover, sobrescrever nem invalidar a outra. Uma empresa pode
operar com só uma das duas, e a ausência de uma capability é um estado normal —
não um erro.

**Não existe fallback entre elas.** CHATBOT não cai para CALLCENTER, e o
contrário também não. As duas falam com hosts diferentes, autenticam de formas
diferentes e respondem em schemas diferentes; um fallback silencioso produziria
dado de uma API apresentado como se fosse da outra.

Detalhe de transporte, autenticação e armazenamento de credencial:
`docs/RECEITANET-HOMOLOGATION.md` e `docs/SECURITY.md` §8.7.

---

# 141. DESCOBERTA GLOBAL DE OS — LIMITAÇÃO DO PROVIDER

> **O suporte do ReceitaNet confirmou que não existe hoje API pública para
> listar globalmente todas as OS da empresa.**

Isto encerra a investigação registrada em `docs/RECEITANET-HOMOLOGATION.md`.
O que era "nenhuma das quatro APIs documenta isso" passou a ser **resposta
oficial do provider**, e a diferença importa: a primeira formulação deixava em
aberto a possibilidade de um endpoint não publicado.

**Estado atual:**

```text
cliente conhecido  →  /v1/chamados  →  OS abertas daquele cliente
```

**Estado futuro:** quando o ReceitaNet disponibilizar API ou feed global, o
AlfaOS **adiciona uma estratégia nova de descoberta** — sem substituir o motor
de importação já existente. Descoberta e importação são camadas separadas de
propósito: a primeira responde *quais OS existem*, a segunda *como uma OS vira
ServiceOrder*. Trocar a segunda porque a primeira mudou seria refazer trabalho
auditado por um motivo que não é dele.

**Consequências operacionais, todas obrigatórias:**

- **Não continuar procurando nem fuzzando endpoint global.** A pergunta foi
  respondida. Varredura de endpoint não documentado viola a §64 e, contra a API
  de um provider real, é tráfego que ninguém autorizou.
- **Registrar como limitação conhecida do provider, não como dívida do AlfaOS.**
  Não é backlog, não é pendência técnica e não entra em nenhuma lista de
  correção. O AlfaOS não tem o que consertar aqui.
- A hipótese `Chatbot /debitos` como enumerador de clientes fica **encerrada**.
  Mesmo se funcionasse, varredura cliente a cliente não é descoberta — é N
  requisições por ciclo contra a API de terceiro, e a §129 já recusava tratar
  isso como equivalente a sincronização.

Isto **reforça** a §121: o motor de OS precisa ser do AlfaOS justamente porque
não se pode depender do ERP nem para saber que uma OS existe.

---

# 142. SINCRONIZAÇÃO DE OS — ESCOPO DA v0.8

**Não implementado.** Esta seção define o escopo; a §119 se aplica.

```text
cliente conhecido  →  CallCenter /v1/chamados  →  ServiceOrder EXTERNAL
```

## Identidade conceitual

| Campo AlfaOS | Origem ReceitaNet |
|---|---|
| `externalProvider` | `RECEITANET` |
| `externalId` | `idSuporte` |
| `externalNumber` | `numero` |
| `externalProtocol` | `protocolo` |

**`ServiceOrder.number` continua sendo o número local do AlfaOS.** O número do
ReceitaNet **nunca** é chave primária nem número local — é dado do provider,
guardado como tal. Um número de terceiro usado como identidade local se torna
impossível de garantir único, impossível de alocar para OS própria (§124) e
colide no dia em que dois provedores diferentes forem integrados.

A separação `id` técnico / `number` operacional (§123 e `docs/SERVICE-ORDERS.md`
§1.3) continua valendo sem alteração.

## Idempotência

```text
companyId + externalProvider + externalId
```

É a mesma chave da §123. Importar duas vezes o mesmo chamado atualiza; não
duplica.

## O que fica fora

Descoberta global (§141). A v0.8 importa **por cliente conhecido** — é o que a
API permite, e a limitação é do provider.

---

# 143. ENRIQUECIMENTO DE CLIENTE — IMPLEMENTADO E VALIDADO

Implementado na v0.7.2 e validado contra cliente real. Fonte: capability
**CHATBOT** (§140).

Campos aplicados ao `Customer`:

```text
telefone principal · telefone alternativo · e-mail
endereço · complemento/referência · coordenadas
externalContractId
PPPoE username · PPPoE senha real · fonte da credencial
```

## Precedência campo a campo

Isto resolve a decisão que a §128 deixou pendente.

- **Contato (telefone, e-mail): preenche apenas o que está vazio.** Um número
  digitado por gente vale mais que um número importado — quem digitou tinha o
  cliente na linha. Importação não corrige cadastro conferido; ela completa
  cadastro incompleto.
- **Credencial: hierarquia de procedência**, na §144.
- **Localização: sempre `IMPORTED`, sempre `verified = false`.** Coordenada de
  ERP é aproximação — frequentemente o centro do CEP. Nascer verificada faria o
  técnico confiar num ponto que ninguém conferiu, e a confirmação em campo
  (§134) perderia o sentido.

## Enriquecimento parcial é resultado normal

Múltiplos contratos, provider indisponível, cliente não localizado e mais
telefones do que o cadastro comporta são desfechos **previstos**, não falhas.
Cada um precisa chegar ao operador: quem não é avisado descobre o cadastro
incompleto com o técnico já na porta do cliente.

Uma falha de enriquecimento **nunca** derruba a importação do cliente nem apaga
dado local existente.

Regra de dado pessoal, ambiguidade e isolamento de falha: `docs/SECURITY.md` §8.8.

---

# 144. PPPoE — PROCEDÊNCIA E PAPÉIS

## Hierarquia de procedência da senha

| Fonte | Regra |
|---|---|
| `RECEITANET_CHATBOT` | fonte real do provider |
| `MANUAL` | **nunca sobrescrita automaticamente** |
| `AUTO_DOCUMENT_LAST4` | fallback |

`MANUAL` é o valor que alguém decidiu. Uma importação que o sobrescreve
silenciosamente destrói uma decisão humana e só se descobre quando o acesso
falha em campo.

## O que o técnico faz

```text
ver o usuário  ·  copiar o usuário
ver a senha mascarada  ·  mostrar a senha  ·  copiar a senha
```

**A máscara tem comprimento fixo.** Não é derivada do valor real: um asterisco
por caractere entregaria o tamanho da senha a quem olhar a tela — informação
que estreita força bruta sem que ninguém revele nada.

**Máscara é apresentação, não conteúdo.** O texto claro não chega no render
inicial; só numa requisição separada, explícita e auditada (§132 e
`docs/SECURITY.md` §8.5).

**Senha ausente não vira máscara.** Conexão com usuário e sem senha é estado
legítimo do cadastro, e a tela declara isso. Mascarar mandaria o técnico tentar
revelar algo que não existe.

## O que o técnico NÃO faz

> **O técnico não administra a conexão do cliente.**

Ver a §147.

---

# 145. UX DO TÉCNICO — PRIORIDADE DE INFORMAÇÃO

> **Mobile-first. Máximo valor operacional com o mínimo de ruído.**

A tela do técnico é lida em pé, na calçada, no sol, com uma mão. Cada bloco que
não serve ao atendimento empurra para baixo um que serve.

Ordem de prioridade:

```text
1. OS
2. cliente
3. telefones
4. endereço / navegação
5. PPPoE
6. diagnóstico
7. plano
8. descrição / execução
9. ações
```

**Informação de implementação sai da tela principal do técnico.** Nome do
provider, código de capability, origem do dado e rótulo de integração descrevem
*como o AlfaOS obteve* a informação — não ajudam a atender o cliente.

**O provider ReceitaNet não ocupa card próprio na experiência normal do
técnico.** O dado que ele fornece aparece onde é útil (diagnóstico, PPPoE,
plano); a origem não vira seção.

Isto não retira nada do ADMIN e do DISPATCHER, que continuam vendo o contexto
de integração nas telas administrativas.

---

# 146. DIAGNÓSTICO NA TELA DO TÉCNICO

Na tela normal do técnico:

```text
ONLINE / OFFLINE / UNKNOWN     ← bem destacado
plano
última atualização
```

**Detalhe adicional só aparece quando há exceção.** Exemplo: servidor em
manutenção vira alerta visível, porque muda o que o técnico vai fazer.

**Não mostrar permanentemente:**

- código de tecnologia;
- fonte do dado;
- "sem manutenção informada".

A ausência de exceção não é informação: ocupar espaço para dizer que nada está
errado treina o olho a ignorar a região — inclusive no dia em que algo estiver.

`UNKNOWN` continua sendo estado próprio. **Erro não é OFFLINE** — a regra
central da §64 e de `docs/ERP-INTEGRATIONS.md` §10 vale integralmente na
apresentação: uma falha de integração apresentada como OFFLINE manda o técnico
investigar um problema de rede que não existe.

---

# 147. ADMINISTRAÇÃO DE CONEXÃO — SEPARAÇÃO POR PAPEL

Some da experiência do **TECHNICIAN**:

```text
Gerenciar acesso · Trocar senha · Restaurar padrão
Desativar · Nova conexão PPPoE
```

**Essas capabilities não são removidas do backend.** A regra é de
apresentação e de autorização por papel, não de amputação de funcionalidade.
Remover o código eliminaria o caminho de recuperação que o ADMIN usa quando o
provider está indisponível ou o dado veio errado.

O **ADMIN** continua com todas elas, preferencialmente reunidas numa área
**"Ações avançadas"** — presentes, e não no caminho de quem não vai usá-las.

A autorização no servidor é a autoridade. Esconder um botão é UX; a rota
continua verificando papel, tenant e ownership como sempre — **UI não é
controle de segurança**.

---

# 148. NAVEGAÇÃO CONTEXTUAL

A tela de edição de cliente é alcançada por dois caminhos, e o botão de voltar
precisa saber por qual:

```text
aberta a partir de uma OS   →  ← Voltar para OS Nº X
aberta pelo menu Clientes   →  ← Voltar para clientes
```

Um técnico que abriu o cadastro para conferir um telefone no meio de um
atendimento precisa voltar **para aquele atendimento**, não para uma listagem.

> **Qualquer `returnTo` deve ser interno e validado no servidor.**

Destino vindo da URL é entrada do usuário. Sem validação, vira redirect aberto:
um link montado por terceiro leva o operador autenticado para fora do AlfaOS,
numa tela que imita a de origem. Aceitar apenas caminho relativo conhecido —
nunca URL absoluta, nunca host externo, nunca `//`.

O número exibido é o **número operacional** da OS (§123), nunca o `id`.

---

# 149. THEME SYSTEM — CLARO, ESCURO E SISTEMA

**Requisito oficial de design.** O AlfaOS suporta:

```text
Light  ·  Dark  ·  System
```

**Tema escuro é capability oficial do produto**, não preferência estética. O
técnico trabalha de madrugada, em rua sem iluminação e dentro de caixa de
emenda; uma tela branca a 100% de brilho arruína a visão adaptada ao escuro e
denuncia a posição de quem está segurando o aparelho.

## Semantic tokens

O design system usa **tokens semânticos**, não cor hard-coded por componente:

```text
background · surface · surfaceElevated · border
textPrimary · textSecondary · muted
primary · success · warning · danger
```

Cor escrita direto no componente é cor que não tem contraparte no outro tema:
o componente fica legível num e ilegível no outro, e a divergência só aparece
quando alguém troca de tema.

**Todo componente funciona nos dois temas.** Não há componente "só claro".

## Estados operacionais

Precisam manter contraste adequado nos dois temas:

```text
ONLINE · OFFLINE · PENDING · ASSIGNED
IN_PROGRESS · COMPLETED · WARNING · ERROR
```

> **Não usar apenas cor para transmitir estado.**

Cor sozinha exclui quem tem daltonismo, some sob luz solar direta e desaparece
em captura de tela em escala de cinza — que é como um chamado costuma ser
encaminhado. Cada estado precisa de rótulo, ícone ou forma além da cor.

## Preferência do usuário

Persistir quando for tecnicamente adequado. `System` é o padrão: respeita o que
o aparelho já decidiu, inclusive o agendamento automático de noite.

---

# PARTE V — ALFAOS FIELD: ARQUITETURA, TOOLKIT E FUNDAÇÕES DE BACKEND

Registrada em 2026-08-25. Define o **AlfaOS Field** por inteiro — o aplicativo
do técnico, as ferramentas técnicas que ele carrega e os serviços de backend
que precisam existir para sustentá-lo.

As Partes I a IV permanecem válidas. A Parte V faz três coisas:

1. **especifica** o que a Parte II descrevia como intenção (§75, §82–§91, §98);
2. **reclassifica** o que a Parte II marcou como DIFERENCIAL ou FUTURO e passou
   a ser P0 do Field — cada reclassificação está marcada na seção de origem e
   consolidada na §191;
3. **acrescenta** o que não existia em nenhuma parte: notificações, registro de
   dispositivo, outbox transacional, fila de jobs, sincronização offline e o
   modelo de execução de ferramentas.

> **A §119 se aplica a toda a Parte V.** Nada aqui está implementado. Estar
> especificado não autoriza escrever código, criar migration nem iniciar
> Flutter. A trilha Field começa quando for formalmente autorizada.

**P0 · P1 · P2 classificam a trilha Field**, não o produto inteiro. A
classificação MVP/IMPORTANTE/DIFERENCIAL/FUTURO da §117 continua descrevendo o
AlfaOS como um todo. As duas convivem: uma capability pode ser DIFERENCIAL para
o produto e P0 para o Field — é exatamente o caso do Wi-Fi Analyzer, que
diferencia o AlfaOS de sistemas tradicionais **e** é indispensável no primeiro
aplicativo que o técnico vai usar.

---

# 150. ALFAOS FIELD — VISÃO OFICIAL

> **O AlfaOS Field é a aplicação operacional móvel de execução de serviços em
> campo. Ele não é um painel Web reduzido.**

Plataforma: **Flutter**, **Android primeiro**, iOS posteriormente — decisão já
registrada em §61 e §75, sem alteração.

## Desenhado para a rua

Um painel administrativo é lido sentado, com as duas mãos, numa tela grande,
com internet. Nada disso é verdade em campo. O Field é desenhado para:

```text
trabalho em rua          conectividade instável
uso com uma mão          atendimento rápido
sol forte e noite        baixa distração
ações grandes e claras   operação offline
ferramentas técnicas
```

Encolher o painel Web para caber num celular produz um aplicativo que funciona
na demonstração e falha na calçada: alvos de toque pequenos demais para luva,
texto ilegível sob sol, e a suposição de rede que a rua não cumpre.

## O backend continua sendo a autoridade

**O Flutter não duplica regra crítica.** Tenancy, ownership, máquina de estados,
concorrência, idempotência, validação de conclusão e auditoria vivem no Core e
só nele (§130).

Regra duplicada é regra que diverge: a cópia do app fica para trás a cada
release e a diferença aparece como falha de autorização em campo, não como erro
de compilação. O app **coleta e apresenta**; o Core **decide**.

---

# 151. PRIORIDADE DA TELA DA OS NO FIELD

Estende a §145 — mesmo princípio, aplicado à tela completa de execução:

```text
 1. identificação da OS        9. plano
 2. cliente                   10. descrição do serviço
 3. telefone principal        11. checklist
 4. telefone alternativo      12. evidências / fotos
 5. endereço                  13. materiais / equipamentos
 6. navegação                 14. assinatura
 7. PPPoE                     15. conclusão
 8. diagnóstico
```

A ordem não é estética: é a sequência real de um atendimento. Quem chega
precisa **identificar, ligar e chegar** antes de qualquer outra coisa; quem já
está dentro da casa precisa **executar e registrar**.

**Ruído de implementação sai da tela.** Nome do provider, código de capability,
origem do dado e rótulo de integração descrevem *como o AlfaOS obteve* a
informação — não ajudam a atender.

**ReceitaNet não ocupa card permanente** na experiência normal do técnico
(§145). O dado aparece onde é útil; a origem não vira seção.

---

# 152. TEMA NO FIELD

O sistema de temas da §149 vale integralmente no Field: **Light · Dark ·
System**, com **System como padrão**, sobre tokens semânticos, e estado
operacional nunca transmitido só por cor.

O Field acrescenta uma exigência que o painel Web não tem: legibilidade em
**dia · noite · baixa iluminação · dentro de veículo · plantão**.

Tema escuro aqui é **capability operacional**, não preferência estética. Uma
tela branca a brilho máximo às três da manhã arruína a visão adaptada ao escuro
por minutos — o técnico fica sem enxergar a caixa de emenda que veio consertar.

---

# 153. NOTIFICAÇÕES PUSH — P0

**Obrigatórias no MVP do Field.** Um aplicativo de campo sem push obriga o
técnico a abrir o app periodicamente para descobrir se algo mudou — o que
significa que ele não descobre.

## Eventos iniciais

```text
SERVICE_ORDER_ASSIGNED
SERVICE_ORDER_REASSIGNED_TO_TECHNICIAN
SERVICE_ORDER_REMOVED_FROM_TECHNICIAN
SERVICE_ORDER_SCHEDULE_CHANGED
SERVICE_ORDER_PRIORITY_CHANGED
SERVICE_ORDER_REOPENED
SERVICE_ORDER_CANCELLED
```

Futuro: `SLA_NEAR_DUE` · `ROUTE_CHANGED` · `IMPORTANT_MESSAGE` ·
`ASSISTANCE_REQUEST`.

## O que a notificação carrega

```text
Nova ordem de serviço
OS Nº 184 foi atribuída a você.
```

O número operacional (§123) identifica sem revelar nada. **Push NUNCA contém:**

```text
CPF · senha PPPoE · login sensível desnecessário
endereço completo · telefone · diagnóstico detalhado
```

**A tela bloqueada revela o mínimo.** Uma notificação aparece sobre a tela
travada, num aparelho apoiado no painel do carro, visível para qualquer um que
passe. É a superfície menos controlada do produto inteiro: o conteúdo não passa
por autenticação, não expira e pode ficar na central de notificações do sistema
operacional por dias.

Detalhe fica atrás do toque, não na prévia.

## Deep link

Tocar na notificação abre **a OS correspondente**. O destino é resolvido pelo
identificador da OS, e a autorização é verificada na abertura — um deep link
não é prova de acesso. Notificação para OS que já foi reatribuída leva a uma
negação limpa, nunca ao conteúdo.

---

# 154. CENTRAL DE NOTIFICAÇÕES

O Field tem central própria, dentro do aplicativo:

```text
lida / não lida · contador · data e hora · tipo
referência à OS · deep link
marcar uma como lida · marcar todas como lidas
```

> **Push não é fonte de verdade.**

A `Notification` interna é registrada **mesmo quando o push externo falha**.
Push depende de token válido, de aparelho ligado, de rede e de um provider de
terceiro que pode descartar a mensagem sem avisar. Um sistema que trata a
entrega do push como o fato perde a atribuição inteira quando o Google decide
que aquele token expirou.

A central é o registro; o push é apenas o aviso.

---

# 155. MOBILEDEVICE — REGISTRO DE DISPOSITIVO

O backend precisa do conceito de **instalação**, não de aparelho genérico.

```text
MobileDevice
  id · companyId · userId · installationId
  platform · registro de push protegido
  registeredAt · lastSeenAt · lastPushAt
  active · appVersion · deviceMetadata mínimo
```

Um usuário pode ter **mais de um dispositivo**, quando a política da empresa
permitir.

## Operações

```text
registrar · renovar token · desativar · logout
revogar celular perdido · substituir aparelho
```

**Revogar precisa ser imediato e do lado do servidor.** Celular perdido é o
cenário que justifica esta entidade existir: sem ela, a única forma de cortar o
acesso é trocar a senha do usuário, o que derruba os outros aparelhos dele e
não impede que o token de push continue entregando OS para o aparelho perdido.

## Não atrelar ao número de telefone

Número de telefone muda, é reciclado pela operadora e pertence à pessoa, não à
empresa. Usá-lo como identidade de dispositivo entrega notificações operacionais
a quem receber o número depois.

`deviceMetadata` guarda o **mínimo necessário** para suporte — modelo e versão
de sistema bastam. Inventário de aparelho é vigilância acidental.

---

# 156. TRANSACTIONAL OUTBOX — P0

> **Evento importante não pode depender de chamada externa dentro da transação
> principal.**

```text
TRANSACTION
 ├── alterar ServiceOrder
 ├── criar ServiceOrderEvent
 └── criar OutboxEvent
COMMIT

        depois, fora da transação

Worker → processa Outbox → Notification → provider de push
```

Chamar o FCM de dentro da transação cria dois desfechos igualmente ruins: a
transação fica aberta esperando rede de terceiro, ou o push é enviado e a
transação sofre rollback — e o técnico recebe notificação de uma atribuição que
não existe.

**Com outbox: se o provider estiver fora, a OS continua correta e o evento não
se perde.** Ele fica na fila até ser entregue.

```text
OutboxEvent
  eventId · companyId · eventType
  aggregateType · aggregateId
  createdAt · availableAt · processedAt
  attemptCount · status
```

**Sem segredos no payload.** O outbox é uma tabela que sobrevive à transação,
é lida por workers, aparece em dump de banco e em backup. Ele carrega
**referência** ao agregado, não o conteúdo sensível dele — o worker relê o que
precisa no momento de processar.

`companyId` no evento não é redundância: o worker precisa dele para respeitar
isolamento de tenant sem reconsultar o agregado.

---

# 157. JOB QUEUE E RETRY

Fila prevista para: **push · fotos · PDFs · integrações ERP · notificações ·
tarefas de sincronização** e, no futuro, **OLT/RADIUS/ACS**.

```text
PENDING → PROCESSING → COMPLETED
                    ↘ FAILED
```

Retry com **backoff exponencial** ou política equivalente. Retry imediato em
laço contra um provider já sobrecarregado é uma negação de serviço que o AlfaOS
aplica contra si mesmo.

> **Falha definitiva precisa ser observável e recuperável.**

Um job que esgotou as tentativas e desapareceu em silêncio é pior do que um
job que nunca rodou: ninguém sabe que faltou. `FAILED` fica visível, com motivo
e contagem de tentativas, e pode ser reprocessado.

---

# 158. OFFLINE-FIRST — P0

> **O Field nasce preparado para operar offline. Offline não é melhoria futura
> de UI.**

**Esta decisão substitui a classificação da §98**, que tratava modo offline como
FUTURO. A razão da mudança: um aplicativo de campo que exige rede não é um
aplicativo de campo. O técnico entra em prédio com laje de concreto, em área
rural e em caixa subterrânea — e é exatamente ali que ele precisa registrar o
que fez.

Retrofit de offline depois é reescrita: cada tela escrita assumindo resposta
imediata do servidor precisa ser refeita.

## O que o técnico faz sem rede

Conforme cache e permissões:

```text
abrir OS já sincronizadas · consultar dados necessários
iniciar atendimento · preencher checklist
registrar fotos · materiais · equipamentos
assinatura · observações
tentativas de contato · impedimentos
finalizar localmente como PENDENTE DE SYNC
```

**"Finalizado localmente" nunca é apresentado como concluído.** A conclusão é
decidida pelo servidor (§166). O app mostra o estado real: registrado aqui,
aguardando sincronização.

## Segredo offline tem política própria

> **Por padrão, senha PPPoE em texto claro NÃO é persistida offline.**

Cache offline é armazenamento durável num aparelho que anda pela rua e é
roubado. Toda a arquitetura da §132 e de `docs/SECURITY.md` §8.5 existe para
que o texto claro só saia do servidor sob pedido explícito e auditado; gravá-lo
no disco do celular anularia isso em silêncio.

Qualquer exceção a essa regra exige política explícita da empresa, prazo de
validade e registro — nunca é o comportamento padrão.

---

# 159. FIELD LOCAL OUTBOX

Ação feita offline vira **operação local pendente**, não estado alterado.

```text
START_ORDER · CHECKLIST_ITEM · ADD_PHOTO
USE_MATERIAL · SCAN_EQUIPMENT · ADD_NOTE
SIGNATURE · COMPLETE_ORDER
```

```text
operação local
  localOperationId · serviceOrderId · type
  createdAt · payload seguro
  syncStatus · retryCount

PENDING → SYNCING → SYNCED
                 ↘ CONFLICT
                 ↘ FAILED
```

## O técnico enxerga o status

```text
Sincronização
  ✓ início
  ✓ checklist
  ↻ 3 fotos
  ! 1 material
  ↻ assinatura
```

Sincronização silenciosa é sincronização que o técnico descobre que falhou
quando o despachante liga cobrando. O estado por item — e não uma barra global —
é o que permite agir sobre o item que travou.

`payload seguro` é literal: a operação local guarda o que o técnico registrou,
nunca credencial nem token.

---

# 160. IDEMPOTÊNCIA MOBILE

> **Toda operação mutante vinda do Field carrega `idempotencyKey` /
> `localOperationId`.**

O caso concreto: o celular envia `COMPLETE_ORDER` três vezes quando a internet
volta, porque o app não sabe se as duas primeiras chegaram. **O resultado é UMA
conclusão.**

Não pode existir:

```text
material duplicado · foto duplicada · assinatura duplicada
conclusão duplicada · timeline duplicada
```

A chave é gerada **no dispositivo, no momento da ação** — não no envio. Gerada
no envio, cada retentativa produz uma chave nova e a proteção não existe.

Isto estende a §24, que já é regra do Core; a novidade é que a chave passa a vir
do cliente e precisa ser tratada como entrada não confiável: escopada por
empresa e por técnico, nunca aceita como prova de autorização.

---

# 161. CONFLITOS OFFLINE

Usa o `version`/CAS que já existe no Core (§23) — **não inventar um segundo
mecanismo de concorrência**.

| Situação | Política |
|---|---|
| Evento imutável (foto, assinatura, evento de timeline) | **não sobrescrever** |
| Mudança incompatível (a OS foi cancelada ou reatribuída enquanto o técnico estava offline) | **CONFLICT** explícito |
| Dado não crítico | merge explícito **quando seguro** |

> **Nunca "last write wins" silencioso para decisão operacional crítica.**

O cenário que a política precisa sobreviver: o técnico fica sem rede, o
despachante cancela a OS, o técnico executa e sincroniza. Sobrescrever o
cancelamento apagaria uma decisão da operação; descartar o trabalho apagaria
duas horas de campo. As duas são inaceitáveis — por isso o desfecho é
`CONFLICT`, visível para gente resolver.

---

# 162. EVIDÊNCIAS ESTRUTURADAS — P0

> **Fotos não são anexos genéricos. São evidências categorizadas.**

**Isto especifica e estende a §31 e a §92.** Um álbum de doze fotos sem rótulo
não prova nada seis meses depois, quando o cliente contesta a instalação:
ninguém sabe qual delas é a CTO e qual é o acabamento.

## Categorias

```text
BEFORE_SERVICE · INSTALLATION_LOCATION · CABLE_ROUTE
CTO · ONU_ONT · ROUTER · EQUIPMENT
OPTICAL_READING · WIFI_TEST · SPEED_TEST
AFTER_SERVICE · CUSTOM · OTHER
```

**`ServiceOrderType` define quais categorias são obrigatórias** (§164 e §165).

Exemplo — INSTALAÇÃO:

```text
antes      local
durante    CTO · passagem · ONU · roteador · acabamento
testes     potência · Wi-Fi · velocidade
final      instalação concluída
```

## Metadados

```text
companyId · serviceOrderId · technicianId
category · capturedAt · uploadedAt · caption
file metadata · location (opcional)
syncStatus · hash para deduplicação
estado imutável / auditoria
```

**Não confiar somente no EXIF.** Metadado de aparelho é editável e o relógio do
celular é ajustável pelo próprio usuário. A integridade vem do registro
server-side — quem enviou, quando chegou, para qual OS — como a §92 já
estabelecia.

**Não expor localização sem necessidade.** A coordenada de uma foto é a casa de
um cliente. Ela entra quando serve a um propósito operacional declarado, com o
mesmo tratamento da §138.

## Depois de COMPLETED

O técnico **não apaga evidência histórica**. Correção posterior existe, é
**auditada**, e preserva o registro anterior — mesma regra de imutabilidade do
fechamento (`docs/SERVICE-ORDER-CLOSING.md`) e da reabertura (§168).

---

# 163. UPLOAD RESILIENTE

```text
compressão controlada · tamanho máximo · retry · fila
progresso · retomada quando possível · deduplicação
thumbnail · upload em background quando permitido
```

> **Nunca exigir upload completo das fotos antes de o técnico continuar
> preenchendo a OS offline.**

Bloquear o formulário até o upload terminar transforma uma tarefa de trinta
segundos numa espera indefinida em rede de borda — e o técnico contorna
deixando de fotografar. A regra que atrapalha o registro produz menos evidência,
não mais.

Foto entra na fila local (§159); o preenchimento continua.

---

# 164. SERVICEORDERTYPE COMO MOTOR DE EXECUÇÃO

**Estende a §125.** O tipo de OS deixa de ser rótulo e passa a **orientar a
execução**. Cada tipo pode definir:

```text
checklist · campos obrigatórios · fotos obrigatórias
testes obrigatórios · assinatura · materiais
equipamentos · permissões de conclusão
```

Exemplos de tipo:

```text
INSTALAÇÃO INTERNET · MANUTENÇÃO INTERNET
RETIRADA EQUIPAMENTO · INSTALAÇÃO CÂMERA
MANUTENÇÃO CÂMERA · ENTREGA DE CARNÊ
```

> **O produto não faz hard-code de workflow de ISP.**

O AlfaOS é multiempresa (§6). Uma empresa que instala câmeras e outra que
entrega carnê usam o mesmo motor; o que muda é a configuração do tipo, não o
código. Workflow em `if` por tipo vira um arquivo que ninguém consegue alterar
sem release — e a próxima empresa precisa de um tipo que não está lá.

---

# 165. CHECKLIST DINÂMICO — P0

Configurável por `companyId` + `ServiceOrderType`. **Substitui a classificação
DIFERENCIAL da §91 no escopo do Field: é P0.**

Tipos de item:

```text
boolean · texto · número · seleção
foto · medição · equipamento · assinatura · confirmação
```

Modificadores: `required` · `optional` · `conditional`.

Exemplo de condicional:

```text
"Potência acima do limite?"  →  exige justificativa e foto
```

> **A conclusão é validada pelo backend** (§166). O checklist no app orienta; ele
> não autoriza.

---

# 166. VALIDATION ENGINE DE CONCLUSÃO

> **O Flutter não decide sozinho se a OS pode ser concluída.**

O backend verifica:

```text
estado · ownership · version
checklist obrigatório · fotos obrigatórias
materiais · equipamentos · assinatura
medições · impedimentos · regras do tipo
```

A validação no cliente é conveniência — ela evita uma ida ao servidor para dizer
o óbvio. Ela não é controle: um app modificado, uma versão antiga em campo ou
uma requisição montada à mão passam por cima dela.

## A resposta é estruturada, não uma frase

```text
Não é possível concluir:
  · foto da ONU
  · teste de velocidade
  · assinatura
```

Uma lista de códigos permite que o app leve o técnico direto ao item que falta.
Uma mensagem de texto obriga ele a procurar.

---

# 167. WORK EVENTS E TEMPO OPERACIONAL

> **A máquina de estados oficial não muda.**

```text
PENDING → ASSIGNED → IN_PROGRESS → COMPLETED
```

**Não criar dezenas de estados principais.** Cada estado novo multiplica as
transições que precisam ser validadas, testadas e auditadas — e a §20 fica
impossível de manter correta.

O que o campo precisa registrar são **eventos auxiliares**, que não alteram o
estado da OS:

```text
TRAVEL_STARTED · ARRIVED · CHECKED_IN
PAUSED · RESUMED · CONTACT_ATTEMPT
BLOCKED · WORK_RESUMED
```

Deles derivam: **tempo de deslocamento · tempo no local · tempo ativo · tempo
parado · tempo total**.

## Check-in / chegada

```text
timestamp · GPS quando autorizado e disponível · accuracy
```

**No primeiro MVP, não bloquear por geofence.** GPS de celular erra dezenas de
metros em área urbana densa e falha dentro de prédio — exatamente onde o
atendimento acontece. Bloquear o início do trabalho por uma coordenada
imprecisa impede atendimento real para prevenir uma fraude hipotética.

Futuro: **sugerir** ou validar chegada por proximidade — sugerir, não impedir.

Vale a regra da §130: **o app coleta, o Core decide.** Coordenada enviada pelo
aparelho é dado de entrada, nunca prova de autorização.

---

# 168. TENTATIVAS DE CONTATO

**Não depender de observação em texto livre.** "Liguei e não atendeu" escrito
numa caixa de observação não é consultável, não vira métrica e não sustenta uma
cobrança contestada.

```text
ação        PHONE_CALL · WHATSAPP · SMS · OTHER
resultado   ANSWERED · NO_ANSWER · BUSY
            INVALID_NUMBER · CUSTOMER_REQUESTED_LATER
timestamp   obrigatório
```

> **Não capturar conteúdo de conversa por padrão.**

Registrar que houve uma ligação é dado operacional. Registrar o que foi dito é
outra categoria de coisa, com outras obrigações de LGPD (§113) — e o AlfaOS não
precisa dela para operar.

---

# 169. IMPEDIMENTOS

Ação no Field: **"Não consegui executar"**.

```text
CUSTOMER_ABSENT · CUSTOMER_NOT_ANSWERING · NO_ACCESS
MISSING_MATERIAL · EXTERNAL_NETWORK_ISSUE · WEATHER
NEED_SECOND_TECHNICIAN · NEED_SPECIAL_EQUIPMENT
SAFETY_RISK · OTHER
```

Motivos **configuráveis por empresa**. O tipo de impedimento pode exigir
comentário, foto ou nova previsão.

> **Impedimento não é conclusão falsa.**

Sem esta ação, o técnico que não conseguiu entrar tem duas saídas: concluir uma
OS que não executou, ou deixá-la aberta sem explicação. A primeira corrompe o
histórico e o indicador de qualidade; a segunda deixa o despachante sem
informação. O impedimento é a terceira saída, e é a correta.

Complementa a §94 (cliente ausente) e a §95 (reagendamento).

---

# 170. REABERTURA

> **`COMPLETED` nunca volta atrás sem histórico.**

```text
reabertura
  motivo · responsável · timestamp · evento imutável
```

Alterar o estado sem registro apagaria a evidência de que o serviço foi dado
por concluído uma vez — que é justamente o fato relevante numa reincidência
(§101) e numa contestação.

Estende a §110.

---

# 171. AGENDA DO TÉCNICO

```text
Hoje · Próximas · Atrasadas · Urgentes · Concluídas recentemente
```

Ordenação por **prioridade · agendamento · SLA · rota futura**.

"Atrasadas" e "Urgentes" existem como recortes próprios porque são as duas
listas em que estar no fim da rolagem equivale a não existir.

---

# 172. NAVEGAÇÃO E CONFIRMAÇÃO DE LOCALIZAÇÃO

## Navegação

O cliente tem coordenadas do ReceitaNet quando o enriquecimento as trouxe
(§143). O Field abre **Google Maps** ou **Waze**:

```text
coordenada válida  →  navegação por coordenada
sem coordenada     →  fallback para endereço textual
```

Coordenada importada permanece **`verified = false`** até confirmação em campo
(§134, §143).

## Confirmação de localização — Field v1

```text
técnico no local  →  [Confirmar localização]
                  →  GPS atual · comparação · confirmação explícita
```

> **Não marcar `verified = true` só por receber a localização do telefone.**

O aparelho reporta onde ele está, não que o técnico conferiu que aquele é o
ponto de instalação. Confirmação automática produziria uma base inteira de
coordenadas "verificadas" com a precisão do GPS do momento — e a §134 existe
exatamente para distinguir uma coisa da outra.

---

# 173. TOOLBOX — ORGANIZAÇÃO

Área central no Field: **FERRAMENTAS**, organizada por domínio.

```text
Wi-Fi · Rede · Roteador · Fibra · Equipamentos
```

> **Não virar lista desorganizada de atalhos.**

Uma gaveta com quinze ferramentas sem agrupamento custa mais tempo para
encontrar a certa do que executá-la. O agrupamento por domínio corresponde ao
modo como o problema chega: *o Wi-Fi está ruim*, *a fibra caiu*.

**Estende a §82.** As ferramentas das §83–§88 passam a ter classificação de
trilha Field na §191.

---

# 174. WI-FI ANALYZER — P0

Android prioritário. **Reclassificado: a §83 marcava DIFERENCIAL; no escopo do
Field é P0.** É a ferramenta que resolve a reclamação mais comum do assinante e
que hoje o técnico substitui por aplicativo de terceiro no celular pessoal.

Exibir, **quando a plataforma permitir**:

```text
SSID · BSSID quando permitido · RSSI
banda · canal · largura · frequência
redes próximas · ocupação observada
```

## Vocabulário honesto

> **Nunca dizer "canal completamente limpo".**

Usar **"canal recomendado"** ou **"menor ocupação observada"**.

O scanner vê o que estava no ar durante a varredura, do ponto onde o celular
estava, com as limitações da API da plataforma. Chamar isso de "limpo" promete
uma medição que o aparelho não fez — e a promessa volta como reclamação quando
o vizinho liga o forno de micro-ondas.

## Recomendação de canal

```text
2.4 GHz   avaliar preferencialmente canais não sobrepostos
          quando aplicável ao país/região (conceitualmente 1 / 6 / 11)
5 GHz     considerar canais disponíveis e regulamentação local
```

Resultado estruturado:

```text
canal atual · canal recomendado
nível de interferência · confiança da recomendação
```

**"Confiança" é campo de primeira classe**, não enfeite: uma recomendação obtida
de uma varredura curta num único ponto não tem o mesmo peso de outra obtida de
várias — e o técnico precisa saber a diferença antes de mexer no roteador do
cliente.

> **Não alterar o roteador automaticamente sem ação do técnico.**

A recomendação é determinística e baseada em regra técnica (§84). IA (§108)
poderá refiná-la depois, nunca como primeira implementação.

## Wi-Fi Score — conceito futuro

Pontuação **0–100** composta de: RSSI · interferência · ocupação · perda ·
latência · jitter · qualidade da internet.

> **O score é ajuda, não diagnóstico absoluto.**

**Guardar as métricas base, não apenas o score final.** A fórmula vai mudar; as
medições não. Guardar só o número torna impossível recalcular, comparar
historicamente ou entender por que um atendimento pontuou 62.

---

# 175. QUICK DIAGNOSTICS — P0

Ferramenta **"Executar diagnóstico"**:

```text
Wi-Fi → gateway → DNS → internet
      → latência → perda → jitter
      → PPPoE → ONU/OLT quando disponível
      → speed test
```

A ordem é a do caminho real do pacote: cada etapa só faz sentido se a anterior
passou. Um diagnóstico que testa tudo em paralelo devolve seis falhas quando o
problema é um — e não diz qual.

Resultado **estruturado**, com ação **[Salvar na OS]** (§176).

## Antes / Depois

```text
ANTES                        DEPOIS
RSSI · canal · perda         RSSI · canal · perda
latência · jitter            latência · jitter
speed test                   speed test
potência óptica              potência óptica
```

**Estende a §86.** É a evidência objetiva de que o serviço mudou alguma coisa —
e a única defesa contra a contestação de que "continua igual".

---

# 176. TOOLEXECUTION — MODELO DE BACKEND

> **Resultado de ferramenta não vira texto solto na observação.**

```text
ToolExecution
  id · companyId
  serviceOrderId (nullable) · customerId (nullable)
  technicianId · toolType
  startedAt · completedAt · status
  resultSanitized
  appVersion · deviceId (opcional)
```

```text
WIFI_ANALYSIS · CHANNEL_ANALYSIS · CONNECTIVITY_TEST
SPEED_TEST · OPTICAL_TEST · ROUTER_CONFIGURATION
GATEWAY_DISCOVERY · DEVICE_SCAN
```

`serviceOrderId` e `customerId` são anuláveis de propósito: o técnico usa o
Wi-Fi Analyzer para conferir a própria rede, sem OS aberta, e isso é uso
legítimo.

`appVersion` não é telemetria: quando uma ferramenta passar a devolver resultado
diferente, é o que permite saber se a rede mudou ou se foi a versão do app.

> **NUNCA guardar em `resultSanitized`:**

```text
senha PPPoE · token · segredo de roteador · credencial em claro
```

O nome do campo é a regra: o que entra ali já passou por sanitização. Uma
execução de `ROUTER_CONFIGURATION` naturalmente teria a senha do Wi-Fi e a
credencial PPPoE no meio do resultado — e é exatamente por isso que este aviso
existe. Guarda-se **o que foi configurado**, nunca **com qual segredo**.

---

# 177. GATEWAY DISCOVERY — P0

```text
Gateway detectado: 10.0.0.1
[Copiar]  [Abrir painel]
```

> **Detectar em runtime. Não pressupor `192.168.0.1` nem `192.168.1.1`.**

Provedor que entrega roteador com faixa própria, cliente com roteador em
cascata e instalação anterior com IP alterado quebram o palpite — e o técnico
perde minutos tentando endereços que não respondem.

---

# 178. CONFIGURAÇÃO DE ROTEADOR

## Assistida — P0

> **No primeiro MVP o AlfaOS NÃO tenta automatizar roteador arbitrário.**

Tela assistida:

```text
PPPoE     usuário
          senha via revelação segura (§132, SECURITY §8.5)

Wi-Fi     nome 2.4 · nome 5 · senha
          canal recomendado · largura sugerida

[Copiar]  [Abrir gateway]
```

Isso já reduz o tempo de instalação sem prometer o que não se pode entregar: o
técnico digita valores corretos, prontos, sem procurar contrato nem inventar
senha.

**Reclassificação: a §88 marcava o assistente como FUTURO. A versão assistida é
P0; a automatizada é P1.**

## Automatizada — P1

```text
RouterConfigurationService
        ↓
RouterAdapter  (fabricante · modelo · firmware/capability)
```

Preferir, nesta ordem: **ACS · TR-069 · USP/TR-369 · API oficial do fabricante**.

> **Não adotar scraping frágil de HTML como arquitetura principal.**

A interface web de roteador doméstico muda entre revisões de firmware sem aviso
e sem versionamento. Um adapter construído sobre ela quebra em campo, no
aparelho de um cliente, sem que ninguém tenha alterado nada do lado do AlfaOS.
Scraping pode existir como último recurso por modelo — nunca como a fundação.

Mesma regra da §81: nenhum fabricante vira dependência de arquitetura.

## Router Profile

A empresa define templates — por exemplo `INSTALLATION_DEFAULT`:

```text
PPPoE · padrão de SSID · política de senha Wi-Fi
2.4 GHz · 5 GHz · política de canal · largura
DNS · política de administração remota
```

O técnico **aplica** um profile suportado. **A configuração gera auditoria** —
quem aplicou, em qual equipamento, sob qual OS, e o que mudou. Nunca os
segredos aplicados (§176).

## Acesso remoto ao roteador

> **NÃO recomendar expor a interface web do roteador na WAN como estratégia
> principal.**

É um painel administrativo com credencial padrão de fábrica, exposto à internet,
na casa do cliente — varrido em minutos e usado para redirecionar DNS.

Caminhos futuros: **ACS/TR-069/USP · VPN ou túnel · rede de gerência · API
controlada**. O acesso é **autorizado, auditado e temporário quando aplicável**.

---

# 179. SPEED TEST — P0

```text
download · upload · latência · jitter
packetLoss quando disponível

timestamp · tipo de conexão (Wi-Fi/Ethernet quando detectável) · resultado
```

Vinculável à OS via `ToolExecution` (§176).

> **Não prometer precisão laboratorial em dispositivo móvel.**

O resultado é limitado pelo rádio Wi-Fi do celular, não pelo link do cliente.
Um teste de 300 Mbps num aparelho cujo Wi-Fi entrega 200 mede o aparelho. Por
isso o **tipo de conexão do teste** é registrado junto: sem ele, o número não
significa nada seis meses depois.

**Reclassificação: §87 marcava DIFERENCIAL; no Field é P0.** Servidor de teste
próprio ou regional continua FUTURO.

---

# 180. QR / BARCODE E EQUIPAMENTOS — P0

Câmera para ler **QR · barcode · serial · MAC quando codificado**.

```text
Estoque → Técnico → OS → Cliente
```

```text
Equipamento
  manufacturer · model · serial · mac
  assetTag · status · condition
```

**Reclassificação: §89 marcava DIFERENCIAL; a leitura básica é P0 do Field.** O
vínculo e a baixa completos dependem do ledger de inventário (§181), que é P1.

Digitar serial de ONU à mão, agachado dentro de um armário, é a origem mais
comum de equipamento vinculado ao cliente errado.

---

# 181. INVENTÁRIO COMO LEDGER — P1

> **Não controlar estoque com `quantity = quantity - 1`.**

Um contador guarda o saldo e perde a história. Quando ele diverge da prateleira —
e diverge — não há como descobrir onde: qualquer uma das últimas trezentas
operações pode ter falhado no meio, e nenhuma delas deixou registro.

Movimentos, com **histórico imutável**:

```text
WAREHOUSE_TO_TECHNICIAN · TECHNICIAN_TO_CUSTOMER
CUSTOMER_TO_TECHNICIAN · TECHNICIAN_TO_TECHNICIAN
TECHNICIAN_TO_WAREHOUSE · RETURN · DEFECTIVE · DISPOSAL
```

O saldo passa a ser **derivado** dos movimentos, e toda divergência tem um
movimento que a explica.

**Estende a §90**, que já previa estoque por técnico com rastreabilidade; a
novidade é a decisão de modelá-lo como ledger.

## Histórico do ativo

O cliente tem histórico de equipamento: **instalado · removido · substituído ·
devolvido**, cada um com `serial · MAC · técnico · OS · data · condição`.

É o que responde "de quem é esta ONU e quem a colocou aqui" três anos depois.

---

# 182. FIBER TOOLKIT E MEDIÇÃO ÓPTICA — P1

Integrações futuras: **OLT · ONU/ONT · RADIUS · ACS** (§104–§106).

Dados possíveis:

```text
ONU online/offline · LOS · serial
potência RX/TX · uptime · OLT · PON
profile · IP · MAC
```

> **Os dados vêm do backend. O Flutter NÃO recebe credencial de OLT.**

Credencial de OLT dá acesso administrativo à rede de acesso inteira — todos os
assinantes daquele equipamento, não só o cliente da OS. Ela não sai do servidor
por nenhum motivo, exatamente como o token de ERP (§189).

## Medição óptica

```text
potência medida · unidade dBm
origem: MANUAL · DEVICE · OLT · ONU
timestamp · técnico
```

**A origem é obrigatória.** Uma leitura digitada pelo técnico e outra lida da OLT
têm confiabilidade diferente, e comparar antes/depois (§175) misturando as duas
produz uma diferença que não existiu.

---

# 183. BASE DE CONHECIMENTO E HISTÓRICO DO CLIENTE — P1

## Base de conhecimento contextual

Não é uma biblioteca; é **o procedimento certo na tela certa**:

```text
OS do tipo "Sem conexão"  →  procedimentos relevantes
```

Conteúdo: **texto · imagem · vídeo ou link · checklist · documento · modelo de
equipamento**. Cache offline seletivo é futuro. Estende a §97.

## Histórico do cliente

> **O técnico não precisa de timeline infinita.**

```text
últimas OS · problemas recorrentes · equipamentos
última instalação · últimas medições
```

**Sem informação financeira desnecessária.** O técnico não precisa saber se o
cliente está inadimplente para consertar o link, e saber muda a forma como ele
é atendido. Mesma regra da §145 e da §113.

Estende a §100 e a §101.

---

# 184. SLA ENGINE — P1

```text
SLA por tipo e prioridade · business hours
pausas justificadas · dueAt · breachAt

eventos: SLA_NEAR_DUE · SLA_BREACHED
```

Os eventos alimentam notificações (§153). **Pausas justificadas** são o que
impede que um impedimento legítimo (§169) conte como atraso do técnico.

Aprofunda a §112.

---

# 185. SKILLS, DISPONIBILIDADE E TURNO

## TechnicianSkill

```text
FTTH · Wi-Fi · Câmeras · IPTV
Elétrica · Rádio · Configuração de roteador · Cabeamento

skill · level/certificação (opcional) · active
```

É o pré-requisito do despacho assistido (§137): sem saber competência, o sistema
só pode sugerir por distância.

## Disponibilidade

```text
disponível · em atendimento · deslocamento
folga · férias · plantão · indisponível
```

> **Não misturar disponibilidade com estado da OS.**

São eixos independentes: um técnico de folga pode ter OS `ASSIGNED` para
amanhã, e um técnico disponível pode não ter OS nenhuma. Fundir os dois
produziria estados impossíveis e quebraria a §20.

---

# 186. TRACKING E PRIVACIDADE — P1

Regido integralmente pela §135 e pela §138. Esta seção acrescenta a política de
coleta.

> **Tracking apenas com finalidade operacional clara: horário de trabalho,
> atendimento, rota.**

## Frequência adaptativa

```text
em movimento   10–15 s, ou por distância relevante
parado         30–60 s ou mais
```

Frequência fixa alta destrói a bateria — e um aplicativo que descarrega o
celular do técnico ao meio-dia é desinstalado, junto com todo o resto.

> **Não transformar em rastreamento permanente.**

LGPD (§113): **transparência · retenção · controle de acesso · finalidade ·
auditoria**. Fora da jornada, não há finalidade operacional — e sem finalidade,
não há base legal.

---

# 187. MAPA OPERACIONAL E ROTEIRIZAÇÃO

Regido pela §136 (mapa) e pela §137 (despacho e roteirização). Sem duplicação;
só o que a trilha Field acrescenta.

Estados visuais do técnico são **derivados**, nunca uma segunda máquina de
estados:

```text
AVAILABLE · TRAVELING · IN_SERVICE · OFFLINE
```

> **Não criar nova state machine de OS.**

Progressão da roteirização:

```text
P0/P1   abrir Maps/Waze (§172)
P1      rota do dia · ordenação assistida
P2      smart routing: localização · SLA · prioridade
        skill · carga · jornada · distância
```

---

# 188. COMUNICAÇÃO — PTT, CHAT E REMOTE ASSIST — P2

**Não entram no primeiro MVP.** Registrados como capability aprovada.

## Rádio / PTT

Comunicação push-to-talk entre técnicos. Prever eventualmente: **canal da
empresa · grupo · OS · pedido de ajuda técnica**.

## Chat contextual

Mensagem vinculada a **ServiceOrder · Customer · grupo de técnicos** — mais útil
que conversa solta, porque a resposta fica onde o problema está, e não numa
rolagem que ninguém reencontra.

Retenção e auditoria apropriadas (§113).

## Remote assist

Técnico pede ajuda de outro técnico ou supervisor: **chat · foto · vídeo ao
vivo**. Estende a §96.

---

# 189. AI COPILOT — P2

Estende a §108.

| A IA pode | A IA NÃO pode |
|---|---|
| resumir histórico | concluir OS sozinha |
| sugerir diagnóstico | revelar senha sem autorização |
| buscar na base de conhecimento | executar mudança crítica sem confirmação |
| sugerir checklist | |
| explicar equipamento | |

A coluna da direita não é conservadorismo: são exatamente as três superfícies
que o Core protege com ownership, auditoria obrigatória e máquina de estados.
Uma sugestão errada custa um clique; uma conclusão errada corrompe histórico,
SLA e faturamento.

---

# 190. OBSERVABILIDADE DO BACKEND

Obrigatória para os fluxos assíncronos que a Parte V introduz. Sem ela, "o
técnico não recebeu a notificação" é impossível de investigar.

```text
OS atribuída      09:14:03
evento no outbox  09:14:03
worker processou  09:14:04
provider de push  09:14:04
```

Identificadores que amarram a cadeia:

```text
correlationId · eventId · notificationId
deviceId · jobId · attemptCount
```

> **Sem PII e sem segredos.** Vale a §63 integralmente: um identificador
> correlaciona sem revelar.

---

# 191. SEGURANÇA DO FIELD

Detalhe operacional em `docs/SECURITY.md`. Aqui ficam os invariantes de produto.

## Token e sessão

```text
armazenamento seguro da plataforma (Keystore/Keychain)
access token curto · refresh controlado · revogação
```

**Celular perdido: o ADMIN revoga sessão e dispositivo** (§155), do lado do
servidor, sem depender de o aparelho estar ligado.

## Segredos

> **Não persistir plaintext PPPoE de forma duradoura** (§158).

> **Não guardar token ReceitaNet no Field.**

## O Field nunca fala com o ERP

```text
Field  →  AlfaOS API  →  ReceitaNet
```

Um token de ERP no aplicativo estaria em centenas de aparelhos fora do controle
da empresa, e valeria para a base inteira de clientes — não só para a OS aberta.
A rota passa pelo Core, onde a autorização por OS já existe (§132) e onde a
credencial nunca sai do servidor (`docs/SECURITY.md` §8.7).

Estende a §99.

---

# 192. FIELD API — CONTRATO

> **Toda capability que o Field precisa existe como contrato de backend. O
> Flutter não acessa banco.**

O contrato precisa definir:

```text
versionamento · erros estruturados · idempotência
paginação · concorrência/version · contratos de sincronização offline
```

**Versionamento não é formalidade.** Aplicativo móvel não atualiza junto com o
servidor: uma versão antiga fica em campo por semanas, no celular de quem está
sem espaço para atualizar. O backend precisa servir as duas.

## Formulários configuráveis — P2

A empresa poderá configurar campos extras e checklists **sem nova versão do
app**. Não implementar agora — mas a arquitetura de checklist (§165) e de tipo
de OS (§164) deve preservar a possibilidade, porque adicioná-la depois sobre
um checklist com formato fixo é reescrever as duas.

---

# 193. RECEITANET NO FIELD

Sem novidade e sem duplicação: vale integralmente a **§141**.

Não existe API pública para descobrir globalmente as OS da empresa; o suporte
confirmou. **Não fuzzar endpoint.** Hoje: **cliente conhecido → `/v1/chamados`**
(§142). Descoberta global é capability futura do provider.

O Field não muda nada disso, porque **o Field não fala com o ReceitaNet** (§191).

---

# 194. ROADMAP DO FIELD — P0 / P1 / P2

Classificação da **trilha Field**. Convive com a §117, que classifica o produto
inteiro — ver a nota de abertura da Parte V.

## FIELD MVP — P0

```text
login · registro de dispositivo · push · central de notificações
Minhas OS · agenda básica · detalhe
dois telefones · endereço · Maps/Waze
PPPoE · diagnóstico simples · plano
check-in · início · checklist
fotos estruturadas · materiais · QR/barcode básico
tentativa de contato · impedimentos
assinatura · conclusão validada
fundação offline · outbox local · status de sync · idempotência
Wi-Fi Analyzer · recomendação de canal · gateway discovery
configuração assistida de roteador · quick diagnostics · speed test
tema Light/Dark/System
```

## FIELD v1 — P1

```text
tracking · mapa · rotas
inventário completo · histórico de equipamento
OLT/ONU · potência óptica · ACS · automação de roteador
diagnóstico antes/depois · base de conhecimento
SLA · skills do técnico · turnos e disponibilidade
confirmação de localização do cliente · diagnóstico avançado
```

## FUTURO — P2

```text
PTT/rádio · chat contextual · remote assist
AI Copilot · despacho inteligente · otimização de rota
manutenção preditiva · formulários dinâmicos configuráveis
```

---

# 195. FUNDAÇÕES DE BACKEND ANTES DO FIELD

O que precisa **existir ou estar arquitetado** antes ou durante o
desenvolvimento do Flutter:

```text
domínio de Notification      MobileDevice
Transactional Outbox         processamento de jobs
Field API                    idempotência
contratos de sincronização   definições de checklist
modelo de evidência          ToolExecution
ledger de inventário         segurança de sessão e dispositivo
```

> **Isto não significa implementar tudo antes de começar o Flutter. Significa
> que a arquitetura precisa estar definida.**

A distinção importa: `MobileDevice` e o outbox podem ser implementados em
paralelo ao app. Mas **idempotência e contrato de sincronização não podem ser
acrescentados depois** — eles determinam a forma de toda rota mutante que o
Field vai chamar, e retrofit significa reescrever o app e o backend juntos.

A ordem de implementação é decisão de escopo de cada versão (§119), não desta
seção.


# AlfaOS — Product Requirements Document

**Produto:** AlfaOS  
**Documento:** PRD Mestre 2.0  
**Objetivo:** Fonte principal de contexto funcional e técnico para desenvolvimento assistido por IA  
**Status atual:** Baseline `v0.3-technician-execution` implementada, aguardando auditoria independente. `v0.4` (fechamento) não iniciada.  
**Arquitetura:** SaaS multiempresa preparado para múltiplos ERPs  
**Primeiro cliente:** Alfa Telecom  
**Produto futuro:** SaaS comercial para provedores de internet e empresas com equipes técnicas — plataforma operacional completa (Core + Field App + Technician Toolkit + Network Intelligence), não apenas um sistema de abertura/fechamento de OS.

> Este documento representa a **visão do produto**. Ele não autoriza implementação automática de nenhuma funcionalidade — ver seção 119 "Princípio de Escopo". A Parte II (seções 72+) registra a visão de longo prazo com classificação explícita de prioridade; a Parte I (seções 1–71) permanece a base funcional/técnica do Core já em desenvolvimento.

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

Campos conceituais:

```text
id
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

Depois que documentação oficial estiver disponível:

```text
v0.5-receitanet
```

Implementar:

- autenticação;
- leitura;
- importação;
- atualização;
- fechamento;
- logs;
- retries;
- idempotência.

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
- Porém Flutter **NÃO faz parte do escopo imediato** da `v0.3` nem da `v0.4` — nenhuma linha de Flutter deve ser escrita nessas versões.
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

**Atualizado.** O projeto já passou de `v0.2-service-orders` → `v0.2.1-audit-fixes` → `v0.2.2-pre-v03-hardening` → `v0.2.3-pre-v03-hardening` → `v0.3-technician-execution` (commit `c852732`).

`v0.3-technician-execution` está **implementada, mas ainda aguarda auditoria independente**. Quem implementou não se autoavaliou como aprovado em segurança — essa é uma regra permanente do processo (ver seção 53, `CLAUDE AUDITOR`).

**Não iniciar `v0.4` até que a auditoria da v0.3 aprove (ou aprove com riscos aceitos) o resultado.**

---

# 69. ROADMAP IMEDIATO

Ordem oficial (atualizado — itens já concluídos marcados):

```text
v0.2.1 → v0.2.3
Correções da auditoria + endurecimento pré-v0.3     [CONCLUÍDO]
        ↓
v0.3
Execução do técnico                                  [IMPLEMENTADO — aguardando auditoria]
        ↓
Auditoria da v0.3                                     [PENDENTE]
        ↓
v0.4
Fotos + materiais + assinatura + fechamento           [NÃO INICIADO]
        ↓
Auditoria
        ↓
v0.5
ReceitaNet
        ↓
Auditoria geral
        ↓
v1.0-RC
        ↓
Piloto de campo
        ↓
v1.0
```

Ver também seção 118 (Roadmap Atualizado — Trilhas de Longo Prazo) para a visão que inclui Field App, Technician Toolkit e Network Intelligence além do Core.

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

> **Fora de escopo agora.** Esta é uma decisão de arquitetura para quando a trilha "Field App" for formalmente autorizada (seção 118) — não um sinal para começar a implementar. Não iniciar nenhum trabalho de Flutter durante `v0.3`/`v0.4`. Ver seção 61 para o texto completo desta ressalva e seção 119 para o princípio geral de escopo.

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

Timestamps possíveis: `route_started_at`, `arrived_at`, `started_at` (já existe), `completed_at` (já existe). Isso permitirá calcular tempo de deslocamento, tempo de atendimento e tempo total da OS — insumo futuro para SLA (seção 112).

---

# 79. MAPA DOS ATENDIMENTOS **[DIFERENCIAL]**

Field App poderá oferecer: OS do dia no mapa, localização dos clientes, distância, ETA, prioridade, próxima OS. Otimização automática da sequência de visitas é **[FUTURO]**, não parte desta fase.

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

# 83. WI-FI ANALYZER **[DIFERENCIAL]**

Funcionalidade do Flutter/Android. Mostrar: SSID, banda, canal, RSSI, largura, redes próximas, ocupação, interferência.

```text
Canal atual: 6
Redes próximas: 8
Congestionamento: alto

Recomendação AlfaOS: Canal 1, 20 MHz
```

Não prometer capacidades que Android/iOS não permitam — o acesso real ao scanner Wi-Fi depende das APIs e permissões da plataforma. Android é prioridade justamente por isso (ver seção 75).

---

# 84. RECOMENDADOR DE CONFIGURAÇÃO WI-FI **[DIFERENCIAL]**

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

Pode virar evidência anexada à OS (ver seção 92, Fotos e Evidências — mesmo princípio de evidência estruturada).

---

# 87. SPEED TEST **[DIFERENCIAL]**

Ferramenta para registrar: download, upload, ping, jitter, perda de pacotes (quando disponível), tipo de conexão do teste (Wi-Fi/cabo, quando conhecido), data/hora. Servidor de teste próprio/regional é **[FUTURO]**, não parte desta fase.

---

# 88. ASSISTENTE DE CONFIGURAÇÃO DE ROTEADORES **[FUTURO]**

Cadastro de equipamentos homologados por fabricante/modelo (TP-Link, ZTE, Tenda, outros), cada um podendo conter guia, configuração WAN/PPPoE/VLAN/Wi-Fi/segurança, firmware homologado, problemas conhecidos, procedimentos.

Estudar futuramente ACS, TR-069, TR-369, APIs oficiais de fabricantes (ver seção 106). **Nunca armazenar credenciais sensíveis desnecessariamente.**

---

# 89. QR CODE / BARCODE **[DIFERENCIAL]**

Field App usará a câmera para escanear ONU, ONT, roteador, TV Box e outros equipamentos, lendo serial, MAC, QR ou barcode. Após a leitura: identificar equipamento, consultar cliente, consultar estoque, vincular ativo à OS, realizar baixa, consultar histórico.

Depende do módulo de Estoque por Técnico (seção 90) para as funções de vínculo/baixa.

---

# 90. ESTOQUE POR TÉCNICO **[FUTURO]**

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

# 91. CHECKLISTS INTELIGENTES **[DIFERENCIAL]**

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

# 98. MODO OFFLINE **[FUTURO — requisito arquitetural relevante quando chegar a hora]**

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

# 99. SEGURANÇA DO DISPOSITIVO **[DIFERENCIAL]**

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
- proteção de GPS — finalidade operacional definida, nunca coleta genérica "para ter caso precise";
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

| Módulo / Funcionalidade | Classificação |
| --- | --- |
| AlfaOS Core (empresas, usuários, técnicos, clientes, OS, máquina de estados) | MVP |
| Execução do técnico (diagnóstico/serviço/observações — v0.3) | MVP |
| Fechamento (fotos, materiais simples, assinatura, PDF — v0.4) | MVP |
| Identidade individual do técnico / desativação sem perda de histórico | MVP |
| Integração ReceitaNet real | IMPORTANTE |
| Cliente ausente / reagendamento | IMPORTANTE |
| Histórico técnico do cliente / reincidência | IMPORTANTE |
| Controle de qualidade (protocolos mínimos por tipo de OS) | IMPORTANTE |
| SLA (aprofundamento operacional) | IMPORTANTE |
| Privacidade básica de dados pessoais (minimização, mascaramento de CPF, proteção de GPS/fotos/assinatura, AuditLog, sessão, isolamento multi-tenant) | MVP — requisito transversal obrigatório |
| Governança avançada de privacidade (retenção configurável, workflows de titular, automação de ciclo de vida) | IMPORTANTE |
| Field App Flutter (app nativo) | DIFERENCIAL |
| GPS, rota, mapa dos atendimentos | DIFERENCIAL |
| Diagnóstico Rápido do cliente | DIFERENCIAL |
| Technician Toolkit (Wi-Fi Analyzer, speed test, antes/depois, recomendador Wi-Fi, teste por cômodos) | DIFERENCIAL |
| Assistente de configuração de roteadores | FUTURO |
| QR Code / Barcode de equipamentos | DIFERENCIAL |
| Checklists inteligentes dinâmicos | DIFERENCIAL |
| Comunicação integrada (ligação/WhatsApp/chat) | DIFERENCIAL |
| Segurança avançada de dispositivo (biometria, revogação remota) | DIFERENCIAL |
| Avaliação do atendimento pelo cliente | DIFERENCIAL |
| Estoque por técnico (completo, com RMA/rastreabilidade) | FUTURO |
| Modo offline completo | FUTURO |
| Base de conhecimento | FUTURO |
| Pré-diagnóstico remoto | FUTURO |
| Correlação de incidentes | FUTURO |
| Integração OLT / RADIUS / ACS / FiberMap | FUTURO |
| Assistente inteligente (IA) | FUTURO |
| Reabertura/devolução formal de OS | FUTURO |
| SaaS multiempresa comercial (billing, planos) | FUTURO |

Uma funcionalidade classificada como DIFERENCIAL ou FUTURO **não** entra automaticamente na próxima versão — precisa de escopo aprovado explicitamente (seção 119).

---

# 118. ROADMAP ATUALIZADO — TRILHAS DE LONGO PRAZO

O roadmap imediato do Core está na seção 69. Esta seção mostra as quatro trilhas de longo prazo, que **não avançam em paralelo automaticamente** — cada uma só começa quando fizer sentido de produto e tiver escopo aprovado.

## Core 1.0

```text
v0.3 Technician Execution (atual, aguardando auditoria)
 ↓
v0.4 Fechamento e evidências
 ↓
v0.5 Integração ReceitaNet
 ↓
Pilot
 ↓
Release AlfaOS 1.0
```

## Field App

Após o Core amadurecer:

```text
Flutter (base do app)
 ↓
GPS / Rotas
 ↓
Offline
 ↓
Equipamentos / Estoque
 ↓
Field Operations completas
```

## Technician Toolkit

```text
Wi-Fi Analyzer
 ↓
Teste por cômodos
 ↓
Speed Test avançado
 ↓
Diagnóstico automático
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
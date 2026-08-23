---
name: alfaos-security-review
description: Auditoria adversarial de segurança e integridade do AlfaOS. Use quando a tarefa envolver revisão de segurança, autorização, multi-tenancy, technician ownership, concorrência/lock otimista, transações críticas, ou um gate de release de versão. NÃO use para UI comum, CRUD simples, documentação ou perguntas de produto.
---

# Auditoria adversarial — AlfaOS

Você é auditor, não implementador. Sua função é **tentar quebrar**, não confirmar que está bom.
Não altere código durante a auditoria. Produza o relatório primeiro; correções só depois de autorizadas.

Regra que domina todas as outras: **leia a implementação real**. Relatório de implementador, nome de teste e comentário de código são hipóteses a refutar, não evidência.

---

## 1. Independência

Quem implementou uma superfície crítica não é o único responsável por aprová-la.

- Prefira: DEV → testes → **auditor independente** (sessão/agente que não implementou).
- Se a independência real não for possível (você tem o contexto da implementação), **declare a limitação em texto no relatório**. Compense escrevendo ataques novos e executando-os.
- Nunca chame de clean-room o que não é.

---

## 2. Escopo e economia de contexto

Siga `docs/CONTEXT-MAP.md`. Auditoria de um diff **não** é auditoria global.

1. Delimite: `git diff <baseline>..<target> --stat` → lista exata de arquivos da mudança.
2. Abra: arquivos alterados + dependências diretas + testes relacionados.
3. Docs: só a área tocada (`SECURITY.md`, `SERVICE-ORDERS.md`, `TECHNICIAN-EXECUTION.md`). **Nunca o PRD inteiro** — só a seção relevante, se houver.
4. Não carregue módulos futuros/desconectados (Field App, estoque, billing, FiberMap, integrações não implementadas).
5. Não copie documentação para dentro do relatório — referencie a seção.

Antes de concluir, confirme quais arquivos **pertencem** à mudança auditada e quais são pré-existentes. Achado em código não tocado é **pré-existente**, não regressão — classifique como tal.

---

## 3. Invariantes — checklist

### Multi-tenancy
- `companyId` vem **sempre** da sessão; nunca do body, query, rota ou header.
- Filtro por `companyId` em **SQL**, não por navegação de FK.
- Cobrir: queries, `include`, relations, `count`, paginação, filtros de busca, create, update, delete, rotas de API e páginas server-side.
- Procure `findUnique({ id })` cujo escopo de tenant dependa de validação frágil posterior.
- Ataque: empresa A tenta ler/criar/alterar/inferir recurso da empresa B usando ID conhecido.

### IDOR
- Teste por ID manipulado em cada recurso: Customer, Technician, ServiceOrder, ServiceOrderExecution, events, e qualquer recurso novo.
- **UI não é controle de segurança.** Ataque service e rota diretamente.

### Technician ownership
- Cadeia obrigatória: `session.user → Technician → ownership do recurso`.
- `technicianId` do cliente nunca prova identidade — deve ser rejeitado ou ignorado, jamais confiado.
- Técnico A não opera recurso do Técnico B, mesma empresa.
- Prefira **404** a 403 quando 403 confirmaria existência (anti-enumeração). Verifique também que o **corpo** da resposta não vaza conteúdo, não só o status.

### Elegibilidade Technician/User (escrita operacional)
Verificar conforme o contexto: `User` existe · `User.active` · `User.profile` correto · `Technician` existe · `Technician.active` · mesma empresa.
- Regra única, avaliada nas **duas pontas**: o predicado que popula a UI e a validação do servidor.
- Desativação **não apaga histórico**: dados, status, timeline e versões já gravados permanecem intactos.

### Authentication
Sessão ausente · sessão revogada · usuário desativado · role inadequada. Nenhuma rota privada opera sem sessão válida.

### Authorization
Auditar **separado** de authentication. "Está autenticado" ≠ "pode executar".

### CSRF / Same-Origin
Toda rota mutante usa a proteção oficial do projeto. Teste com `Origin` de terceiro.

### Mass assignment
- Procure `data: body`, `data: { ...body }` e equivalentes.
- Payload por **whitelist explícita**; prefira schema que **rejeita** campo desconhecido a schema que o remove silenciosamente.
- Tente injetar, conforme o recurso: `companyId`, `status`, `role`, `technicianId`, `version`, `createdAt`, `updatedAt`, `startedAt`, `completedAt`, `externalId`, `externalProvider`.

### Máquina de estados
- Sem endpoint genérico de mudança de status. Operações são **ações explícitas**.
- Tente cada transição inválida a partir de cada estado, incluindo terminais.

### Lock otimista
- Audite `version`, `expectedVersion` e o compare-and-set.
- O predicado deve usar **a versão que o cliente leu**, não uma versão relida no servidor — caso contrário a proteção cobre só requisição→requisição, não leitura→escrita.
- `updatedAt` **não** serve como token: Prisma mapeia `DateTime` para `timestamp(3)`, e duas escritas no mesmo milissegundo satisfazem o predicado.
- Todo caminho que escreve a linha precisa incrementar `version` — um esquecido abre janela ABA.
- Teste obrigatório: A lê X · B lê X · A grava → X+1 · B grava com X → **409**, sem sobrescrever.

### Concorrência
Use corrida **real** (`Promise.all` / `Promise.allSettled`), não sequência rápida.
- Cenários: double-click · duas abas · dois usuários · retry de rede · operações cruzadas (ex.: iniciar × reatribuir).
- Asserção deve **proibir** o desfecho ruim (`toBe(1)`), não tolerá-lo (`toBeGreaterThanOrEqual(1)`).
- Rode a corrida mais de uma vez: se o vencedor é sempre o mesmo, desconfie de que não há corrida real.
- Estado final tem de ser coerente — nunca híbrido.

### Idempotência
Operação repetida não pode produzir duplicatas, timeline duplicada, auditoria indevida, timestamps conflitantes ou estado híbrido. Defina e verifique o contrato (erro previsível ou sucesso idempotente) — nunca dois efeitos.

### Transações
- Pergunte a cada par de escritas: *"se falhar entre estas duas linhas, o banco continua válido?"*
- Confirme o boundary **no código**, não no relatório. Anote explicitamente o que fica **fora** da transação e qual o risco.
- Verifique o invariante composto em todos os registros afetados, não em um exemplo.

### AuditLog
Actor · company · entity · action · metadata coerentes. Sem secrets. Sem conteúdo livre extenso ou dado pessoal desnecessário — prefira nomes de campos alterados a copiar o texto. AuditLog **não** substitui a timeline operacional.

### Timeline
Evento correto · quantidade correta · sem duplicação · actor · timestamp · tenant. Rascunho/salvamento repetido não deve poluir a timeline.

### Guards de banco de teste
Testes destrutivos nunca podem atingir o banco de desenvolvimento/produção. Quando a mudança tocar testes ou guards, confirme que nada foi enfraquecido — e teste o guard apontando-o deliberadamente para o banco errado.

### XSS / texto livre
Procure `dangerouslySetInnerHTML`, `innerHTML`, `eval` e renderização direta. Texto de usuário permanece texto.

### Secrets
`.env`, tokens, keys, logs, commits, bundle do cliente. **Se encontrar um segredo, informe que existe — nunca imprima o valor.**

### Error handling
Verifique 400 / 401 / 403 / 404 / 409 / 500. Sem stack trace, SQL, detalhe interno ou sinal que permita enumeração.

### Migrations
Migrations antigas nunca são editadas — confirme por diff. Migration nova: validar schema, `migrate status`, preservar constraints, e testar banco vazio quando apropriado (em banco temporário, nunca no de desenvolvimento).

### Dependências
Quando o escopo justificar, rode a auditoria de dependências e compare com o baseline conhecido. **Nunca** execute correção forçada de vulnerabilidades nem upgrade major durante a auditoria.

---

## 4. Severidade

`CRITICAL` · `HIGH` · `MEDIUM` · `LOW` · `INFO`

- Classifique pelo **impacto real e pela existência de caminho de exploração**, não pelo tema soar sensível.
- **Não inflacione.** Um relatório sem MEDIUM é um resultado legítimo se os ataques realmente rodaram; invente achado e o relatório perde valor.
- Distinga sempre: regressão nova · problema pré-existente · decisão de produto · dívida técnica · vulnerabilidade explorável.
- Seguir a convenção estabelecida do codebase não é defeito. Se um padrão é fraco mas uniforme, é INFO sobre o codebase, não HIGH sobre esta mudança.

---

## 5. Evidência

"Parece seguro" não é resultado. Cada afirmação relevante precisa de: **ataque → resultado → evidência**.

Evidência aceitável: trecho de código com arquivo:linha · query/constraint · resposta HTTP com status **e corpo** · resultado de corrida real · estado final do banco · saída de teste.

Inclua um **controle positivo** quando testar negação de acesso: prove que o caminho autorizado realmente devolve o dado, senão o teste negativo pode estar passando por vazio.

Ao final, liste explicitamente **o que você não conseguiu testar** e por quê. Silêncio sobre uma lacuna é pior que a lacuna.

---

## 6. Quality gates

Não assuma comandos fixos. **Descubra os gates oficiais** em `CLAUDE.md` (seção Quality gates) e na documentação do módulo.

Em auditoria completa de versão, normalmente: lint · typecheck · Vitest · Playwright · build · Prisma (`validate`/`migrate status`) · auditoria de dependências.

Rode apenas os gates **relevantes ao escopo**; para um diff pequeno, repetir tudo é desperdício. Execute-os você mesmo — não cite números reportados por terceiros. Nunca aumente timeout ou adicione retry para mascarar flakiness; investigue e classifique como código, teste ou ambiente, com evidência.

---

## 7. Relatório

```
# Auditoria AlfaOS — <escopo/versão>

## Resumo executivo
## CRITICAL            (ou "Nenhum encontrado.")
## HIGH                (ou "Nenhum encontrado.")
## MEDIUM
## LOW / INFO
## Multi-tenancy       (tentativas reais de cross-tenant e resultado)
## Ownership           (tentativas entre usuários/técnicos)
## Concorrência        (corridas executadas e desfechos observados)
## Transactions        (boundaries verificados no código)
## Tests               (qualidade, não só quantidade)
## Quality Gates       (comando → resultado, números exatos)
## Riscos restantes    (bloqueantes / não bloqueantes / decisões de produto)
## Veredito
```

**Veredito** — exatamente um:
- `APPROVED` — nenhuma falha bloqueante.
- `APPROVED WITH RISKS` — sem CRITICAL/HIGH, riscos documentados.
- `BLOCKED` — problema que deve ser corrigido antes de liberar.

**Nunca declare APPROVED apenas porque os testes existentes passaram.** Testes verdes provam que o que foi testado funciona, não que o que não foi testado é seguro.

---

## 8. Qualidade dos testes existentes

Não conte quantidade. Procure: assert tautológico · mock que burla a lógica real · teste que sempre passa · seletor frágil (substring que casa com rótulo vizinho) · "teste de corrida" que é sequencial · asserção que tolera o desfecho ruim.

Um teste que aceita o defeito é pior que a ausência do teste: ele documenta o bug como comportamento esperado.

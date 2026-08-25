# AlfaOS — Context Map

Roteador de contexto para sessões do Claude Code neste projeto. Objetivo: carregar o mínimo de contexto necessário para executar cada tarefa corretamente, sem reler documentação de módulos não relacionados nem repetir leitura já feita na mesma sessão.

Regra geral: leia a seção "Sempre" em toda sessão nova, depois **só** as seções abaixo que se aplicam à tarefa atual. Quando terminar de decidir o que ler, não volte a reler o mesmo arquivo se ele não mudou.

## Sempre

* `CLAUDE.md`
* Estado do Git: `git status`, `git branch --show-current`, `git log --oneline --decorate -10`, `git tag`

## Produto / roadmap

**Carregar:** `docs/PRD.md` — preferencialmente só a(s) seção(ões) relevante(s) à tarefa, não o arquivo inteiro (é longo).
**Quando:** a tarefa envolve decisão de escopo, prioridade de versão, ou dúvida sobre o que uma feature deveria fazer.
**Quando NÃO:** implementação técnica de algo já especificado em outro doc mais específico (ex.: a regra de máquina de estados de OS já está detalhada em `SERVICE-ORDERS.md`, não precisa voltar ao PRD para isso).

## Arquitetura

**Carregar:** `docs/ARCHITECTURE.md`.
**Quando:** a tarefa muda o modelo de dados, adiciona uma entidade nova, mexe em camadas/estrutura do projeto, ou é uma decisão estrutural cross-module.
**Quando NÃO:** bugfix pontual, ajuste de UI, ou qualquer tarefa que não altera como os módulos se relacionam.

## Segurança

**Carregar:** `docs/SECURITY.md` + a seção de arquitetura relacionada (se houver) + os testes de segurança do módulo tocado (ex.: os arquivos relevantes em `src/tests/`).
**Quando:** a tarefa toca autenticação, autorização, rate limit, CSRF, mass assignment, concorrência/lock otimista, ou qualquer coisa de superfície crítica.
**Quando NÃO:** mudança sem implicação de autorização ou dado sensível (ex.: texto de label, cor de botão, copy de UI).

**Skill de auditoria:** `.claude/skills/alfaos-security-review/SKILL.md` — o método adversarial do projeto (invariantes, severidade, evidência, template de relatório).
* **Carregar quando:** auditoria adversarial, segurança, multi-tenancy, ownership, concorrência, transações críticas ou gate de release de versão.
* **NÃO carregar para:** UI, CRUD comum, documentação normal, ou qualquer tarefa sem implicação de segurança/integridade.
* **Manutenção:** se um invariante de segurança relevante do `CLAUDE.md` mudar, revisar essa skill na mesma tarefa — as duas descrevem a mesma regra sob papéis diferentes (`CLAUDE.md` proíbe violar; a skill ensina a tentar violar) e podem divergir em silêncio.

## Service Orders / Execução do técnico

**Carregar:** `docs/SERVICE-ORDERS.md` (inclui origem INTERNAL/EXTERNAL e catálogo `ServiceOrderType`, §1.1 e §1.2, e o número operacional da OS, §1.3 — `id` é identidade técnica, `number` é identidade operacional humana); e `docs/TECHNICIAN-EXECUTION.md` se a tarefa envolver o fluxo de atendimento do técnico (iniciar atendimento, diagnóstico, serviço realizado, observações); e `docs/SERVICE-ORDER-CLOSING.md` se envolver o fechamento (evidências/fotos, materiais, assinatura, `COMPLETED`, storage/upload, imutabilidade pós-conclusão).
**Quando:** qualquer tarefa que toque Ordem de Serviço, atribuição de técnico, máquina de estados da OS, ou a experiência do técnico em campo.
**Quando NÃO:** tarefas de outros módulos sem relação com OS (ex.: só cadastro de cliente, configurações da empresa). Não carregue os três documentos de uma vez — execução e fechamento são fases distintas.

## Auditorias

**Carregar:** somente a auditoria da versão relevante à tarefa atual — não releia o histórico completo de auditorias.
* `docs/FOUNDATION-AUDIT.md` — contexto histórico da v0.1, raramente necessário hoje.
* `docs/V0.2-AUDIT.md` — achados e correções do ciclo v0.2/v0.2.1/v0.2.2/v0.2.3. Útil para entender decisões de concorrência (`version`/`expectedVersion`) e elegibilidade de técnico antes de mexer nessas áreas.
* Auditoria da v0.3, quando existir (ex.: `docs/V0.3-AUDIT.md`) — carregar antes de iniciar `v0.4`, ou ao investigar algo relacionado à execução do técnico.

**Quando:** a tarefa é uma nova rodada de auditoria, ou precisa entender o que já foi encontrado/corrigido antes de mexer numa área historicamente sensível.
**Quando NÃO:** implementação de feature nova sem relação com achados anteriores.

Para *conduzir* uma auditoria (não apenas consultar as anteriores), use a skill descrita na seção Segurança.

## Integrações (ERP)

**Carregar:** `docs/ERP-INTEGRATIONS.md` — contrato/capabilities, modelo normalizado de diagnóstico, snapshot, modelo de erros, timeout, cenários do MockERP e o estado de implementação da integração ReceitaNet. O fluxo de sync de OS continua em `docs/SERVICE-ORDERS.md`.
**Quando:** a tarefa envolve adapters de ERP, diagnóstico de conectividade do cliente, sincronização, ou a futura integração real com o ReceitaNet.
**Quando NÃO:** tarefas que não tocam a camada de integração. **Antes de implementar qualquer chamada ReceitaNet**, ler a seção 1 de `docs/ERP-INTEGRATIONS.md` — ela separa o que está IMPLEMENTADO (CallCenter read-only v0.6 **e Chatbot v0.7.2**), o que está documentado e deliberadamente fora, e o que não existe em nenhuma API. Complementam: `docs/PRD.md` §140 (as duas capabilities e suas credenciais independentes), §141 (por que não existe descoberta global de OS), §142 (escopo da sincronização na v0.8) e §121–§131 (propriedade da OS e posição dos ERPs). O §129 descreve as APIs **como lidas em spec** e tem duas conclusões superadas — ler a nota no topo dele antes de citar. O §64 continua valendo — nenhuma chamada fora do que o OpenAPI descreve.

## Homologação ReceitaNet

**Carregar:** `docs/RECEITANET-HOMOLOGATION.md` — o levantamento read-only das quatro APIs oficiais (CallCenter, URA, Chatbot, Central do Assinante). Contém:

- **evidência real dos endpoints** — extraída dos OpenAPI oficiais e dos testes já executados contra a API, não de suposição;
- **divergências entre OpenAPI e comportamento real** — inclusive as duas armadilhas de `/v1/chamados`: o teto documentado de 10 registros e o `success:false` que ali significa *zero resultados*, e não erro como em `/v1/clientes`;
- **matriz READ-ONLY/MUTANTE** por rota, nas quatro APIs, com o que é proibido chamar;
- **estado da investigação de descoberta global de OS**, separado em COMPROVADO / DESCARTADO / HIPÓTESE / AGUARDANDO RECEITANET;
- **pendências com o suporte** — perguntas fechadas, cada uma amarrada a uma lacuna concreta.

**Quando:** antes de chamar qualquer rota ReceitaNet ainda não implementada; ao avaliar se uma capacidade existe de fato; ao retomar a investigação de sincronização/descoberta de OS; ao mexer em acesso PPPoE (o documento registra a política `DOCUMENT_LAST4`, a regra de que `MANUAL` nunca é sobrescrito e a validação operacional de `login` como usuário PPPoE); ou ao preparar contato com o suporte do ReceitaNet.
**Quando NÃO:** tarefas que não tocam ReceitaNet. Para o contrato interno de adapters e o modelo de erro, o documento certo continua sendo `docs/ERP-INTEGRATIONS.md` — este aqui é sobre a API do provider, não sobre a camada AlfaOS.

**Credenciais:** o armazenamento, o isolamento entre CallCenter e Chatbot, o AAD `v1`/`v2` e a fronteira do plaintext PPPoE estão em `docs/SECURITY.md` §8.7 — leia antes de tocar qualquer fluxo de token de ERP.

É o documento que registra o que **não existe**: consultar antes de assumir que uma funcionalidade é possível.

**Conclusão central, agora confirmada pelo suporte do provider (2026-08-25):** não existe API pública para listar globalmente as OS da empresa. Toda leitura de OS exige `idCliente` conhecido. A investigação está **encerrada** — não retomar, não fuzzar endpoint global. É limitação do provider, não dívida do AlfaOS (`docs/PRD.md` §141).

O documento também traz o mapeamento de identidade da sincronização planejada para a v0.8 (`idSuporte` → `externalId`, `numero` → `externalNumber`, `protocolo` → `externalProtocol`) e as duas armadilhas de `/v1/chamados` que viram requisito ao implementá-la.

## Futuro Field App (Flutter)

**Carregar:** documentação específica do Field App/Flutter, quando existir — este projeto ainda não tem um app Flutter nem documentação correspondente.
**Quando:** quando esse projeto for iniciado e a documentação existir.
**Quando NÃO:** não aplicável até lá.

## Geolocalização, mapa operacional e despacho

**Carregar:** `docs/PRD.md` §133–§139 — `CustomerLocation`, `TechnicianLocation`, `OperationalMap`, despacho assistido, roteirização e privacidade da localização. As seções 77–79 descrevem a experiência do técnico em campo e são complementares (a §77 foi revisada pela §134, e a §79 não é o mesmo mapa da §136).
**Quando:** a tarefa envolve coordenadas, GPS, mapa, rota, proximidade de técnicos ou despacho.
**Quando NÃO:** qualquer outra coisa. Nada disso está implementado — é arquitetura registrada, e a seção 119 se aplica: estar no PRD não autoriza implementar.

## Experiência do técnico e design system

**Carregar:** `docs/PRD.md` §145–§149 — prioridade de informação na tela do técnico, apresentação do diagnóstico, separação de administração por papel, navegação contextual (`returnTo`) e o sistema de temas claro/escuro/sistema.
**Quando:** a tarefa muda a tela do técnico, decide o que aparece ou some por papel, mexe em navegação entre OS e cadastro, ou toca cor, token de design e tema.
**Quando NÃO:** backend sem superfície visível, integração, ou qualquer módulo sem UI. Para a regra de autorização por trás do que a tela esconde, o documento é `docs/SECURITY.md` — **esconder botão é UX, não controle de acesso**.

Nada de §145–§149 está implementado além do que a v0.7.2 já entregou em PPPoE e telefones; é requisito registrado, e a §119 se aplica.

## Quando usar Context7

Usar Context7 quando a tarefa depender de documentação externa atual de bibliotecas/frameworks, por exemplo: Next.js, React, Prisma, Playwright, Tailwind, Flutter no futuro, SDKs/APIs externos, bibliotecas adicionadas ao projeto.

Especialmente quando: a API pode ter mudado; a sintaxe depende da versão atual; houver dúvida sobre comportamento oficial; for necessário confirmar boas práticas da biblioteca.

## Quando NÃO usar Context7

Não usar Context7 para: descobrir como o AlfaOS funciona; regras de negócio internas; multi-tenancy do AlfaOS; arquitetura própria; ServiceOrder; Technician ownership; decisões registradas no PRD; histórico Git; segurança específica do AlfaOS.

Para isso usar: `CLAUDE.md` → CONTEXT-MAP → documentação modular → código/Git → skills AlfaOS quando aplicáveis.

Context7 deve complementar o projeto, não substituir suas fontes internas.

**Economia de contexto:** não consultar documentação externa automaticamente se o código e os documentos locais já forem suficientes. Consultar somente a biblioteca e o tópico necessários. Evitar buscas amplas.

---

Atualize este mapa sempre que um documento relevante novo for criado (ex.: quando a auditoria da v0.3 for concluída, quando a integração ReceitaNet ganhar doc próprio, quando o Field App em Flutter for iniciado).

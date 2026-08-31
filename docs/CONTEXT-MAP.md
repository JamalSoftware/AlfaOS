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
* `docs/V0.7-AUDIT.md` — checkpoint da trilha v0.7: os três bloqueadores (PPPOE-01, RATE-01, GATE-01), as correções, a reauditoria focal e os riscos aceitos. **Leia antes de mexer em procedência de credencial PPPoE, rate limit de capability ou procedência do diagnóstico** — as três áreas já regrediram uma vez, e o documento registra por quê. Traz também os três INFO aceitos e a lacuna dos LOW históricos.
* `docs/V0.9-AUDIT.md` — checkpoint da Field Backend Foundation: os sete achados (OBX-01, REV-01, REV-02, IDM-01, START-01, TEST-01, OPS-01), o endurecimento, a reauditoria focal e os cinco INFO aceitos. **Leia antes de mexer em lease/reclaim do outbox, revogação de aparelho, tomada de reserva de idempotência ou na resposta do `start`** — o documento registra o que cada mecanismo existe para impedir e o que a reversão provou. O contrato correspondente é `docs/FIELD-API.md`; a segurança, `docs/SECURITY.md` §8.13.
* Auditoria da v0.3, quando existir (ex.: `docs/V0.3-AUDIT.md`) — carregar antes de iniciar `v0.4`, ou ao investigar algo relacionado à execução do técnico.

**Quando:** a tarefa é uma nova rodada de auditoria, ou precisa entender o que já foi encontrado/corrigido antes de mexer numa área historicamente sensível.
**Quando NÃO:** implementação de feature nova sem relação com achados anteriores.

Para *conduzir* uma auditoria (não apenas consultar as anteriores), use a skill descrita na seção Segurança.

## Integrações (ERP)

**Carregar:** `docs/ERP-INTEGRATIONS.md` — contrato/capabilities, modelo normalizado de diagnóstico, snapshot, modelo de erros, timeout, cenários do MockERP e o estado de implementação da integração ReceitaNet. O fluxo de sync de OS continua em `docs/SERVICE-ORDERS.md`.
**Quando:** a tarefa envolve adapters de ERP, diagnóstico de conectividade do cliente, sincronização, ou a futura integração real com o ReceitaNet.
**Quando NÃO:** tarefas que não tocam a camada de integração. **Antes de implementar qualquer chamada ReceitaNet**, ler a seção 1 de `docs/ERP-INTEGRATIONS.md` — ela separa o que está IMPLEMENTADO (CallCenter read-only v0.6 **e Chatbot v0.7.2**), o que está documentado e deliberadamente fora, e o que não existe em nenhuma API. Complementam: `docs/PRD.md` §140 (as duas capabilities e suas credenciais independentes), §141 (por que não existe descoberta global de OS), §142 (escopo da sincronização na v0.8) e §121–§131 (propriedade da OS e posição dos ERPs). O §129 descreve as APIs **como lidas em spec** e tem duas conclusões superadas — ler a nota no topo dele antes de citar. O §64 continua valendo — nenhuma chamada fora do que o OpenAPI descreve.

## Sincronização de OS do ReceitaNet

**Carregar:** `src/lib/receitanet-order-sync.ts` (o serviço), `src/lib/service-orders.ts` (`importServiceOrderForCustomer` e o núcleo `persistImportedServiceOrder`) e `docs/PRD.md` §142.
**Quando:** a tarefa envolve importar, reimportar ou exibir OS vindas do provedor.
**Quando NÃO:** OS interna, execução do técnico, ou qualquer coisa que não atravesse a fronteira do ERP.

Quatro invariantes que já custaram caro e são fáceis de desfazer:

* **Por cliente conhecido, nunca global.** Não existe listagem de OS da empresa (§141). Não varrer ids, não chamar `/v1/chamados` sem `idCliente`.
* **O AlfaOS é a fonte de verdade da execução.** Re-sync atualiza só campos do provedor — a allowlist está em `persistImportedServiceOrder`, e `data: normalizedChamado` seria o defeito.
* **Ausência não é fechamento.** Chamado que some não é cancelado nem concluído.
* **`ServiceOrder.number` é do AlfaOS.** O número do provedor vive em `externalNumber`, e os dois nunca se sobrepõem.

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

O documento também traz o mapeamento de identidade da sincronização da v0.8, agora implementada e homologada em piloto real (`idSuporte` → `externalId`, `numero` → `externalNumber`; `protocolo` **não é persistido**), as duas armadilhas de `/v1/chamados` que viraram requisito e o registro do piloto contra o provider.

## AlfaOS Field, toolkit do técnico e fundações de backend

**Se a tarefa toca a Field API que EXISTE, carregue primeiro `docs/FIELD-API.md`** — namespace `/api/field/v1`, autenticação por token opaco e `MobileDevice`, contrato de erro com código estável, `Idempotency-Key`, `expectedVersion`, minimização de DTO, outbox e worker. O contrato de segurança correspondente é `docs/SECURITY.md` §8.13; a §8.9 continua sendo a especificação do que ainda não existe.

**Implementado na v0.9:** login/logout, `/me`, registro de dispositivo, Minhas OS, detalhe, `start`, revelação de PPPoE, diagnóstico, central de notificações, outbox transacional com worker por comando (`npm run outbox:work`) e abstração de push (sem FCM real).

**Endurecido depois da auditoria independente:** revogação de aparelho com tela em `/dispositivos` (`ADMIN`), aparelho revogado **não** volta por login (`DEVICE_REVOKED`), lease e reclaim no outbox e na reserva de idempotência, resposta do `start` vinda da mutação, e o worker compilado para rodar com `node` em produção. Se a tarefa toca revogação, fila ou idempotência, leia `docs/SECURITY.md` §8.13 e `docs/V0.9-AUDIT.md` antes.

**Implementado na v0.10 (backend, Etapa A):** execução e fechamento em campo — `CustomerLocation` com precedência, confirmação e correção com histórico imutável, check-in, evidências categorizadas com upload, checklist dinâmico com snapshot por OS, ledger mínimo de inventário, equipamento instalado, tentativa de contato, impedimento, assinatura vinculada ao conteúdo e conclusão validada por tipo de OS. Dezesseis rotas novas; contrato em `docs/FIELD-API.md` §3, segurança em `docs/SECURITY.md` §8.14.

**Se a tarefa toca execução em campo, os arquivos são:** `src/lib/customer-locations.ts` (precedência — leia antes de mexer em qualquer escrita de coordenada), `src/lib/inventory.ts` (ledger e a corrida), `src/lib/checklists.ts` (snapshot), `src/lib/service-order-completion.ts` (validação e hash do fechamento), `src/lib/service-order-child-mutation.ts` (o preâmbulo de posse e o CAS, compartilhado por sete comandos) e `src/lib/field/command.ts` (a sequência de todo comando mutante).

Três invariantes da v0.10 que são fáceis de desfazer sem perceber:

* **Check-in NÃO confirma localização.** São entidades diferentes de propósito. Derivar `verified` de um GPS de chegada produziria uma base inteira de coordenadas "verificadas" que ninguém verificou.
* **Escrita automática de coordenada passa OBRIGATORIAMENTE por `applyImportedCustomerLocation`.** A auditoria da v0.10 encontrou essa função sem chamador de produção, com o enriquecimento gravando direto e rebaixando `verified` — ver `docs/SECURITY.md` §8.14. Se você está escrevendo `latitude` em `Customer`, está no caminho errado.
* **O checklist da OS é snapshot, não referência.** Editar o template não pode alcançar OS já iniciada.

**Implementado na v0.10 (Flutter, Etapa B) — publicado:** a execução inteira no aplicativo do técnico. Localização, check-in, relatório, checklist, fotos, materiais, equipamento, assinatura e conclusão. A **foto da etiqueta** passou a ser a identificação do equipamento (série e MAC viraram opcionais), com estágio `TEMPORARY` → `COMMITTED`, TTL, promoção transacional, vínculo 1:1 e expurgo por comando (`npm run evidence:cleanup`). O inventário do que a v0.10 entregou está em `docs/PRD.md` **§225**; a tag é `v0.10-field-execution-closing`.

**Continua só especificação:** offline no cliente, FCM real, todo o toolkit, `ToolExecution`, custódia de patrimônio, PDF de fechamento e reabertura de OS.

**Carregar:** `docs/PRD.md` **Parte V (§150–§195)** — a especificação completa do Field. Carregue apenas o bloco relevante à tarefa, não a Parte inteira:

| Assunto | Seções |
|---|---|
| Visão, tela da OS no Field, tema | §150–§152 |
| Notificações push, central, `MobileDevice` | §153–§155 |
| Transactional Outbox, fila de jobs, retry | §156, §157 |
| Offline, outbox local, idempotência, conflitos | §158–§161 |
| Evidências estruturadas e upload resiliente | §162, §163 |
| `ServiceOrderType` como motor, checklist, validação de conclusão | §164–§166 |
| Work events, check-in, contato, impedimento, reabertura, agenda | §167–§171 |
| Navegação e confirmação de localização | §172 |
| Toolbox: Wi-Fi, diagnóstico, gateway, roteador, speed test | §173–§179 |
| `ToolExecution` | §176 |
| QR/equipamentos e inventário como ledger | §180, §181 |
| Fibra, óptica, base de conhecimento, histórico, SLA, skills | §182–§185 |
| Tracking, mapa, roteirização | §186, §187 |
| Comunicação, IA, observabilidade | §188–§190 |
| Segurança do Field e contrato da Field API | §191, §192 |
| Roadmap P0/P1/P2 e fundações de backend | §194, §195 |

**Quando:** a tarefa envolve o aplicativo do técnico, notificações, sincronização offline, evidências, checklist dinâmico, ferramentas técnicas, inventário, ou qualquer fundação de backend que o Field exige.
**Quando NÃO:** tarefas do painel Web sem relação com o Field, integrações ERP, ou módulos já cobertos por doc próprio. Para segurança de token móvel, dispositivo e segredo offline, o documento é `docs/SECURITY.md` §8.9.

**Boa parte da Parte V já é código** — o aplicativo Flutter existe, o outbox existe, e a execução em campo foi publicada na v0.10. O que continua especificação está listado acima e na §194, que traz a nota do que sobrou. `ToolExecution`, o toolkit e o push real **não existem**, e para eles a §119 se aplica: estar no PRD não autoriza implementar.

**Duas escalas de prioridade convivem:** a §117 classifica o produto inteiro (MVP/IMPORTANTE/DIFERENCIAL/FUTURO); a §194 classifica a trilha Field (P0/P1/P2). Uma capability pode ser DIFERENCIAL e P0 ao mesmo tempo — conferir as duas antes de concluir que algo está ou não no escopo.

**Documentação própria do Flutter:** ainda não existe. Criar quando a trilha for autorizada, e registrar aqui.

## Geolocalização, mapa operacional e despacho

**Carregar:** dois blocos, e eles se complementam — não leia um sem saber que o outro existe.

| Bloco | Seções | O que fixa |
|---|---|---|
| **Arquitetura** | §133–§139 | `CustomerLocation` (modelo, origens, `source` × `verified`), `TechnicianLocation`, `OperationalMap`, despacho assistido, privacidade |
| **Carteira e despacho** | §196–§209 | mapa da carteira, precedência entre origens, cobertura, geocodificação, escalabilidade, filtros, fronteira com o FiberMap, Central de Despacho, Smart Dispatch, roadmap |

As seções 77–79 descrevem a experiência do técnico em campo e são complementares (a §77 foi revisada pela §134, e a §79 não é o mesmo mapa da §136).

Três regras que a Parte VI fixou e são fáceis de desfazer sem perceber:

* **A localização da carteira não depende de OS** (§196). Um mapa alimentado só por atendimento aberto mostra apenas quem está com problema.
* **Dado de menor confiança não sobrescreve o confirmado em campo** (§197). Reimportar do ERP preserva o verificado e registra a divergência.
* **Arrastar um cartão é UI** (§204). A atribuição passa pelo mesmo comando de sempre — auth, tenant, elegibilidade, `version`/CAS, transação, evento, outbox, notificação. Sem fluxo paralelo do Kanban.

**Quando:** a tarefa envolve coordenadas, GPS, mapa, rota, proximidade de técnicos, quadro de despacho ou agenda.
**Quando NÃO:** qualquer outra coisa. Nada disso está implementado — é arquitetura registrada, e a seção 119 se aplica: estar no PRD não autoriza implementar. Para a fronteira com o FiberMap (o AlfaOS **consulta** topologia de rede, não a copia), o ponto é a §202.

O quadro (§203) decide **quem** atende. A ordem de execução dentro da fila de cada técnico é outra Parte — ver abaixo.

## Fila Operacional de OS — DQ-1 ENTREGUE, DQ-2 em diante PLANNED

**Carregar:** `docs/DISPATCH-QUEUE.md` (plano de implementação — schema, algoritmo, transações, endpoints, fases `DQ-1`–`DQ-7`) e PRD §308–§332 (Parte XII — o porquê e as regras de produto). O que já existe em código: `src/lib/dispatch-queue.ts` (primitivas puras), os modelos `TechnicianDispatchQueue`/`TechnicianDispatchQueueEntry` no schema, e os testes `src/tests/dispatch-queue-domain.test.ts` e `dispatch-queue-schema.test.ts`.

**DQ-1 é só fundação: nada consome a fila ainda.** Não há rota, tela, serviço nem backfill; nenhuma fila é criada por caminho nenhum. A precedência (`DISPATCH_BAND`) é a **única** autoridade sobre `URGENT > HIGH > NORMAL > LOW` — `ORDER BY priority` continua funcionando por coincidência da ordem de declaração do enum, e não é autoridade de nada. Para entender o modelo que já existe, também `prisma/schema.prisma` (`ServiceOrderPriority`, `ServiceOrder`) e `src/lib/service-orders.ts` (rótulos, ordenação da fila do técnico, `assignTechnician`).

**Qual dos dois abrir:** o PRD responde *por que* e *qual é a regra*; o `DISPATCH-QUEUE.md` responde *como executar*. Para implementar, o segundo — as onze decisões (`D-01`–`D-11`) estão fechadas lá, com tabela.

| Assunto | Seções |
|---|---|
| Capability, prioridade × posição | §308, §309 |
| Auditoria do modelo de prioridade atual e as decisões pendentes | §310 |
| Fila por `(empresa, técnico)`, composição, posição explícita | §311–§313 |
| Ranking local do Field como estado temporário | §314 |
| Alteração de prioridade, reordenação, entrada e saída da fila | §315–§317 |
| Concorrência, idempotência e invariantes | §318–§320 |
| OS em atendimento, eventos, auditoria e histórico | §321, §322 |
| Fila no Field e no despacho Web | §323–§325 |
| ReceitaNet, notificações, offline | §326–§328 |
| Opções de schema, aceite, casos de borda, roadmap | §329–§332 |

Quatro regras que a Parte XII fixou e são fáceis de desfazer sem perceber:

* **Prioridade responde criticidade; posição responde sequência** (§309). Não são a mesma coisa, e nenhum número de níveis de prioridade produz uma sequência.
* **O `expectedVersion` da OS não protege uma reordenação** (§318). Ela escreve N linhas; o CAS responde por uma. A fila precisa da própria unidade de concorrência.
* **Delta não é idempotente** (§318). "Subir uma posição" aplicada duas vezes sobe duas. O contrato usa alvo absoluto, mais `Idempotency-Key`.
* **Posição nunca vira `scheduledAt`** (§324). Fabricar horário a partir de ordem produz, um dia depois, um horário que alguém acha que foi prometido ao cliente.

Dois achados do levantamento que o plano depende e que valem fora dele: **não existe operação de cancelamento nem de desatribuição de OS** — `status: "CANCELLED"` nunca é escrito e `technicianId: null` só aparece em fixture —, e **`ServiceOrder` não tem índice em `technicianId`**.

**Quando:** a tarefa envolve ordem de atendimento, prioridade de OS, reordenação de fila ou o painel de despacho por técnico.
**Quando NÃO:** qualquer outra coisa. **Nada disso existe em código** — nenhuma migration, nenhuma rota, nenhuma tela. A §119 se aplica: o plano estar fechado não autoriza implementar.

## Experiência do técnico na OS

**Carregar:** `src/app/(app)/ordens/[id]/page.tsx` (a tela, com as diferenças por perfil), `src/components/CustomerContactCard.tsx` (contato, endereço e navegação), `src/lib/map-links.ts` (Google Maps/Waze e validação de coordenada) e `src/lib/return-to.ts` (allowlist do destino de volta).
**Quando:** a tarefa muda o que o técnico vê na OS, o contato do cliente, a navegação até o endereço, ou a navegação contextual entre OS e cadastro.
**Quando NÃO:** backend sem superfície visível, integrações, ou o painel administrativo de clientes.

Duas regras que a v0.7.4 fixou e são fáceis de desfazer sem perceber:

* **A simplificação é do TECHNICIAN, não do produto.** ADMIN e DISPATCHER continuam vendo id interno, origem, número no ERP e contexto ReceitaNet — é com isso que se abre chamado com o provedor. Ver PRD §145 e §151.
* **`returnTo` passa por allowlist fechada e por verificação de tenant.** As duas, não uma. Detalhe em `docs/SECURITY.md` §8.11.

## Custódia de patrimônio do técnico

**Carregar:** `docs/PRD.md` §210–§223 — `Asset`, `AssetCustody`, termo de cautela, assinatura do recebimento, conferência periódica, ocorrências, devolução e permissões.
**Quando:** a tarefa envolve ferramenta, EPI ou equipamento de trabalho cedido ao técnico.
**Quando NÃO:** material consumido no atendimento — isso é inventário (§90, §181). A fronteira entre os dois está na §211.

Três decisões que são fáceis de desfazer sem perceber:

* **Um ledger só** (§215). Custódia usa os movimentos da §181 e acrescenta cinco que consumível não faz. Não criar enum concorrente.
* **Sem QR para ferramenta** (§222). A decisão é ESTRITA a patrimônio do técnico e **não** revoga a §180 — leitura de QR/serial/MAC continua P0 do Field para equipamento instalado no cliente.
* **O AlfaOS documenta, não julga** (§219). Nada de desconto automático, cobrança ou atribuição de culpa: o processo trabalhista fica fora.

Nada disso está implementado — é especificação, e a §119 se aplica.

## Jornada / Ponto do funcionário — FASE 1 PUBLICADA (v0.11-employee-time-clock)

**Carregar:** `docs/PRD.md` §226–§233 — marcações, evidência da batida, histórico imutável e pedido de ajuste, espelho, painel do gestor, ponto offline e LGPD. Se a tarefa toca autorização, quem decide ou fuso, leia junto `docs/SECURITY.md` **§8.15**. Código: `src/lib/workday.ts` (dia, estado e **sequência efetiva**) e `src/lib/time-clock.ts` (domínio).
**Quando:** a tarefa envolve jornada de trabalho, batida de ponto, espelho, banco de horas ou aprovação de ajuste.
**Quando NÃO:** check-in de OS — **não é a mesma coisa** (§226). Check-in é `docs/TECHNICIAN-EXECUTION.md` e a §167. Escala/plantão/folga/DSR é módulo **separado**, ainda `PLANNED` — ver a entrada logo abaixo.

Quatro regras que serão fáceis de desfazer sem perceber:

* **Ponto não é check-in.** Derivar entrada do primeiro check-in do dia deixaria sem jornada quem passou o dia no almoxarifado (§226).
* **O relógio do servidor é a autoridade.** O carimbo do aparelho é metadata, e existe porque diverge (§227).
* **A marcação original nunca é editada.** Correção é pedido com aprovação, e o registro derivado aponta para ele (§229).
* **Só existe UMA noção de "marcação atual".** A correção aprovada **supera** a original sem apagá-la, e as duas linhas convivem na tabela. Quem lê o histórico bruto lê um dia que não existe: estado, ação permitida, validação de sequência e espelho passam todos por `resolveEffectiveTimeEntries`. Ler `timeEntry.findMany` direto para decidir qualquer coisa é o defeito, não o atalho.

**Estado do release: `PUBLISHED`.** Tag anotada `v0.11-employee-time-clock`, no commit `f057ee1`, publicada no remoto. Auditoria clean-room final: `APPROVED WITH RISKS`, `RELEASE GO` — 0 CRITICAL, 0 HIGH, 0 MEDIUM, 1 LOW, 3 INFO. O inventário do que entrou, o registro do piloto e os riscos residuais estão em `docs/PRD.md` **§252** e **§253**.

**O que JÁ existe:** `Workday`, `TimeEntry`, `TimeAdjustmentRequest` e `Company.timezone`; as rotas `/api/field/v1/time-clock/*` e `/api/time-clock/*`; a tela `/jornada`, a página por funcionário e a tela do Field. **Não existe** banco de horas, escala prevista, folha, engine offline no cliente nem tela de configuração de fuso — `Company.timezone` só tem o default. A §119 se aplica ao que falta.

**Das pendências registradas (§253), três foram fechadas no endurecimento final** — e as três viraram regra que dá para desfazer sem perceber:

* **Quem abre não decide, quando a jornada é a própria** (LOW-1). Abrir continua permitido; a recusa é 403, vem **depois do lock e antes de qualquer escrita**, e não deixa `TimeEntry`, `updateMany` nem `AuditLog`. A tela esconder o botão é UX — a autoridade é `decideTimeAdjustment`.
* **A criação administrativa exige `Idempotency-Key`** (LOW-2), na **mesma** infraestrutura do Field, com nome de operação próprio (`time-clock.admin-adjustment`). Criar uma segunda idempotência para a web é o defeito, não o atalho.
* **O fuso do horário solicitado é o da EMPRESA** (LOW-3). `WorkdayView.utcOffset` vai no DTO e o Field o usa para ler e montar horário. O relógio do aparelho não é autoridade sobre jornada, e uma tabela de fusos dentro do APK envelhece na primeira mudança de lei.

**Quatro achados da auditoria clean-room final, todos residuais e aceitos** (não corrigir sem tarefa própria):

* **JOR-A1 (`LOW`) — RESOLVIDO** (v0.11.1). Só conta intervalo com as **duas pontas provadas**; o parcial até agora vale só para o **dia corrente**, e quem decide se o dia ainda está acontecendo é o fuso da empresa. `summarize` recebe `openEndsAt` e virou função **pura** — `Date.now()` por dentro dela era o defeito. Nada de assumir saída às 23h59, criar `CLOCK_OUT` ou tocar `TimeEntry`.
* **JOR-A2 (`INFO`) — RESOLVIDO** (v0.11.1). As inconsistências aparecem no Field (cartão do dia e histórico) e no **espelho web individual** (`/jornada/[userId]`, que navega por dia), **sem CTA novo** — a porta única continua na seção `Correções` (§258). O sinal deixou de disparar para quem está trabalhando agora: um alerta que aparece sempre não é alerta.
* **JOR-B1 (`INFO`) — pendente.** A **lista da equipe** (`/jornada`) tem o campo `inconsistencies` e o JSX que o exibiria, mas a página chama `getTeamWorkday(session.companyId)` sem instante — sempre lê o dia corrente, que nunca é sinalizado por desenho. O ramo é código morto em produção, não removido; ver `docs/PRD.md` §253.
* **JOR-B4 (`INFO`) — bloqueia JOR-05.** O lookup de `Workday` por instante (`getWorkdayView`, `getTeamWorkday`, `getWorkdayHistory`) usa o fuso **atual** de `Company.timezone`, não o fuso sob o qual o dia foi vivido. Uma UI de configuração de fuso (JOR-05) não deve nascer antes disso ser resolvido — troca de fuso pode fazer dia histórico "sumir", localizar `Workday` no dia vizinho, ou recusar `CLOCK_OUT` por `Workday` errado. Risco teórico hoje porque `Company.timezone` só tem o padrão.
* **JOR-A3 (`INFO`)** — `pendingAdjustments` do painel do gestor não é limitado ao dia consultado.
* **JOR-A4 (`INFO`)** — `$executeRawUnsafe` só no reset de banco de teste, protegido pelo guard de ambiente.

**Continua pendente: JOR-05** — `Company.timezone` não tem superfície administrativa. Não bloqueia: o padrão `America/Sao_Paulo` atende, e o campo já cai no padrão quando o valor gravado é inválido. **`BLOCKED BY JOR-B4`**: antes de dar à empresa como trocar o fuso, o lookup de `Workday` por instante precisa parar de depender do fuso ATUAL para achar dias históricos.

## Escala de trabalho e espelho de jornada — PLANNED

**Carregar:** `docs/PRD.md` **Parte XI (§288–§307)** — escala, plantão, folga, DSR, sábado alternado, troca de plantão, planejado × realizado e o Attendance Report (PDF/CSV).
**Quando:** a tarefa envolve escala de trabalho, plantão, folga, DSR, recorrência de escala, troca entre técnicos, "Minha Escala" no Field, ou exportação de espelho de jornada em PDF/CSV.
**Quando NÃO:** jornada/ponto em si — isso é a entrada **acima**, e as duas nunca se fundem (§288). Contrato assinado é a Parte X (§266–§287); o Attendance Report **não é** `SignedContract` (§304).

**Nada disso existe.** A regra que não pode ser desfeita ao implementar:

* **Escala é planejado; Jornada/Ponto é realizado.** `PLANTAO` nunca cria `CLOCK_IN`; `FOLGA` e `DSR` nunca criam `TimeEntry` (§288, §300). Um despacho ou uma tela "inteligente" que abrisse ponto a partir da escala violaria a mesma garantia que sustenta o módulo inteiro.
* **`ScheduleRule` gera `ScheduleOccurrence`; a exceção altera a ocorrência, nunca a regra** (§290, §293) — a mesma separação fato/correção que a Jornada já fez entre `TimeEntry` e `TimeAdjustmentRequest`.
* **O Attendance Report não pode implementar cálculo de horas próprio.** PDF, CSV, dashboard, Field e painel web consomem o MESMO motor — hoje `resolveEffectiveTimeEntries` e `src/lib/time-clock.ts` (§302). O bloqueio por `JOR-A1` foi **levantado** na v0.11.1 (§303), o que não promove o relatório a implementado: ele continua `P1`/`PLANNED`, sem gerador, rota, tela nem CSV.

## Field Workspace, App Shell e Dashboard — FASE 1 ENTREGUE, RELEASE PENDENTE

**Carregar:** `docs/PRD.md` §254–§258 — a visão do Field como **workspace do técnico** (e não como app de OS), a navegação híbrida, a gaveta categorizada, o dashboard `Início` e a decisão de porta única para a correção de jornada. Código: `apps/field/lib/app/router.dart`, `home_shell.dart`, `widgets/workspace_menu.dart` (o registry da gaveta), `widgets/app_drawer.dart`, `widgets/planned_module_sheet.dart`, `widgets/notifications_bell.dart`, `widgets/shell_drawer_button.dart`, `features/dashboard/ui/dashboard_screen.dart`, `features/dashboard/domain/attention_ranking.dart`.
**Quando:** a tarefa muda a navegação do aplicativo, adiciona destino novo, mexe no dashboard `Início`, na gaveta ou no cabeçalho.
**Quando NÃO:** backend sem superfície no aplicativo, painel web, ou uma tela isolada do Field que não altera a navegação — essas continuam sem carregar esta entrada.

**Estado do release: entregue, sem tag e sem push.** Dois piloto físicos previstos: o **primeiro já aconteceu** e aprovou arquitetura e navegação, mas reprovou o visual; o hardening que respondeu a isso **aguarda o segundo**. Seis decisões que são fáceis de desfazer sem perceber:

* **OS e Jornada não podem viver só na gaveta** (§255). São as duas ações mais frequentes do dia — e por isso são abas da barra, não itens de menu.
* **A política do menu foi REVISTA depois do primeiro piloto** (§256). Antes: "item que não existe não aparece". Agora: **a barra principal** só recebe o que está implementado; **a gaveta** apresenta o Workspace inteiro com o planejado marcado por selo `EM BREVE`. A honestidade mudou de lugar — saiu da omissão e foi para o selo **e a ausência de rota**, que é estrutural: item planejado tem `route == null`, e um teste permanente prova que nenhum dos 15 carrega rota.
* **Item planejado abre UMA folha genérica, nunca uma tela própria** (§256). `planned_module_sheet.dart` é local, sem rota, e serve os quinze — quinze telas placeholder seriam quinze lugares onde alguém, meses depois, poderia ligar um botão a uma API inexistente.
* **O dashboard não decide o que é permitido** (§257). O card de Jornada apresenta `allowedActions`, que já vem do servidor derivado da sequência efetiva — recalcular no cliente faz o aplicativo discordar do domínio na primeira correção aprovada. Tocar a ação **navega** para `/jornada`; não bate ponto inline, porque duplicar o diálogo de confirmação ali criaria um segundo lugar para a mesma proteção divergir.
* **"Próxima OS" continua exigindo `scheduledAt`; "Atenção agora" não** (§257). O bloco novo existe porque uma OS sem agendamento — o caso real do ReceitaNet no piloto — não é "próxima" de ninguém e sumia do Início. As duas seções respondem perguntas diferentes, e nenhuma inventa cronologia. O ranking vive em `attention_ranking.dart`, testado sem widget.
* **A gaveta pertence a UM `Scaffold` só — o do shell.** Cada tela da barra abre essa MESMA instância por referência (`shellScaffoldKeyProvider`), nunca a própria: uma `Drawer` por tela nasceria aninhada no espaço que o `Scaffold` do shell já reduziu para a `NavigationBar`, e colidiria com ela. Achado corrigido, por falha real de teste.

**Origem do provedor NÃO aparece no card de OS, e não é esquecimento.** O DTO do Field omite `origin`/`externalProvider`/`externalNumber` de propósito (`src/lib/field/dto.ts`): uma OS importada tem de ser indistinguível de uma interna, e é a ausência do dado que impede um `if (RECEITANET)` no aplicativo. Um badge "ReceitaNet" exigiria o backend passar a enviar campo autoritativo — decisão de contrato, não de tela.

A porta única da correção (§258) **já foi aplicada** no endurecimento final da Fase 1 da Jornada: a tela de jornada do Field oferecia "SOLICITAR CORREÇÃO" em dois lugares, e ficou só o da seção `Correções`. O cartão de hoje responde estado, trabalhado, última marcação e correções pendentes, e mais nada. O teste que segura isso conta o RÓTULO, não a chave.

**Mapa NÃO é destino da barra nesta fase.** O §255 já prescrevia isso: "fica vago ou traz Agenda" enquanto o módulo não existe — nenhum dos dois tem código, e a barra fica com três destinos (Início, OS, Jornada), não quatro com um placeholder.

**"Minha Escala" é destino separado de "Minha Jornada"** (§298, Parte XI) — mesma gaveta, mesmo App Shell, entidades diferentes. O dashboard `Início` ganha um card de próximo plantão/folga sem reordenar os blocos já especificados no §257.

## Mapa operacional no Field, agenda e estoque do técnico — PLANNED

**Carregar:** `docs/PRD.md` §259–§263 — mapa do técnico, ação no pin, privacidade/GPS, agenda de compromissos e "Meu Estoque". Leia junto o bloco correspondente já existente: mapa é a Parte VI (§196–§209), agenda estende a §171, estoque estende a §181.
**Quando:** a tarefa envolve mapa dentro do aplicativo, compromisso do técnico, lembrete, ou saldo de material do técnico.
**Quando NÃO:** Central de Despacho — isso é **web** (§203, §204). Ferramenta cedida ao técnico é custódia (§211).

**Nada disso existe.** Três regras que são fáceis de desfazer:

* **Não é um segundo mapa** (§259). É a mesma `CustomerLocation` e a mesma precedência da §197.
* **GPS `while-in-use`, evento é um ponto** (§261). Tracking durante a jornada só existe se a política da empresa habilitar, e nunca fora dela.
* **A OS na agenda é projeção, não cópia** (§262). Guardar horário próprio criaria duas respostas para "quando é o atendimento".

O plantão da Escala (§298, Parte XI) entra na agenda pela mesma regra de projeção — nunca com horário próprio guardado ali.

## Ferramentas do técnico e configuração de roteador — PLANNED

**Carregar:** `docs/PRD.md` §264 e §265, **junto com** §173–§179 (o toolbox já especificado) e §178 (a arquitetura de roteador, que **não muda**).
**Quando:** a tarefa adiciona ferramenta ao Field, mexe no hub de ferramentas ou no assistente de roteador.
**Quando NÃO:** diagnóstico de conectividade via ERP — isso é `docs/ERP-INTEGRATIONS.md`.

**Nada disso existe.** Três limites:

* **O scanner de LAN é controlado** (§264): só na rede do atendimento em curso, com OS aberta e registro de quem executou.
* **A §222 continua estrita**: não há QR para ferramenta do técnico; QR de equipamento instalado no cliente continua `P0` (§180).
* **O Flutter não fala direto com integração crítica quando o backend pode mediar** (§265). Credencial de ACS ou de fabricante dentro de um APK é credencial publicada — a mesma fronteira da §191.

## Contratos, assinatura eletrônica, validador e entrega — PLANNED

**Carregar:** `docs/PRD.md` **Parte X (§266–§287)**. Carregue apenas o bloco relevante, não a Parte inteira:

| Assunto | Seções |
|---|---|
| Capability, dados contratuais da empresa | §266, §267 |
| Variáveis: dicionário oficial, system × custom, UX | §268–§270 |
| Editor, modelo e versionamento | §271, §272 |
| Multipágina, modo de assinatura, componentes | §273, §274 |
| Pipeline de geração, hash, prévia e variável inválida | §275, §276 |
| `SignedContract`, evidências, OTP | §277–§279 |
| Validador e o limite ICP-Brasil | §280, §281 |
| Entrega — WhatsApp, e-mail, web | §282 |
| Contrato por tipo de OS e política de conclusão | §283 |
| Tipos de documento, segurança, UX do técnico | §284–§286 |
| Roadmap do workspace e dos contratos | §287 |

**Quando:** a tarefa envolve contrato, termo, modelo de documento, variável de template, assinatura eletrônica do cliente, PDF gerado, validação de documento ou entrega ao cliente.
**Quando NÃO:** a assinatura de **fechamento da OS** — essa já existe desde a v0.10 e é `docs/SERVICE-ORDER-CLOSING.md`. **Não são a mesma assinatura** (§286). Assinatura de recebimento de ferramenta é a §214.

**Nada disso existe:** não há modelo, rota, tela, gerador de PDF, motor de assinatura, QR nem validador. A §119 se aplica integralmente.

Cinco regras que a Parte X fixou e são fáceis de desfazer sem perceber:

* **Publicar versão nova nunca altera contrato assinado** (§272). Versão `PUBLISHED` é imutável; mudar é criar `DRAFT` novo.
* **Snapshot, não referência** (§275). O documento guarda os valores resolvidos; cliente que muda de endereço amanhã não altera o contrato de ontem.
* **Nunca confiar em filename** (§275). Identidade é `id`, integridade é hash, autorização é RBAC.
* **Placeholder não resolvido nunca chega ao documento final** (§276). A validação é na **publicação** do modelo, não na geração.
* **O validador não é ICP-Brasil** (§281). É mecanismo próprio de integridade e evidência — nenhuma tela, PDF ou texto pode sugerir equivalência com assinatura qualificada.

E duas de privacidade: o validador público **não expõe dado pessoal completo** (§280), e a senha do Wi-Fi **não entra em contrato automaticamente** (§268).

## Rede interna do cliente e equipamentos — PLANNED

**Carregar:** `docs/PRD.md` §234–§246 — papel na rede separado do tipo físico, topologia, política por empresa, IP de gerenciamento, backhaul, local, propriedade, patrimônio, credencial de acesso, perfil de rede e histórico. A ponta administrativa é a §224.
**Quando:** a tarefa envolve topologia da casa do cliente, repetidor, IP de gerenciamento, propriedade do equipamento ou o painel web de equipamentos.
**Quando NÃO:** rede do PROVEDOR — CTO, caixa, backbone. Isso é FiberMap, e a fronteira está na §202. Material consumido no atendimento é inventário (§181); ferramenta cedida ao técnico é custódia (Parte VII, §211).

**O que JÁ existe (v0.10):** `ServiceOrderEquipment` com tipo, fabricante, modelo, série e MAC opcionais, e a foto da etiqueta com estágio e vínculo 1:1. **Não existe** papel na rede, topologia, IP, propriedade, política por empresa nem histórico de troca — tudo isso é `PLANNED`.

Duas decisões que o PRD já fixou e não devem ser desfeitas na implementação:

* **`equipmentType` e `networkRole` são campos diferentes** (§235). Nem toda ONT roteia, e o tipo não muda quando o modo de operação muda.
* **O padrão de repetidor da Alfa Telecom é configuração, não código** (§237). Hardcode transformaria a regra de um provedor em regra do produto.

## Contatos do cliente — PLANNED

**Carregar:** `docs/PRD.md` §247–§249 — múltiplos contatos, correção em campo, precedência ERP × campo e painel de qualidade cadastral.
**Quando:** a tarefa envolve telefone, WhatsApp, contato alternativo ou confirmação de dado cadastral pelo técnico.
**Quando NÃO:** endereço e coordenada — isso é `CustomerLocation` (§133–§139, §197), já implementado.

**O que JÁ existe:** `Customer.phone`, `Customer.secondaryPhone` e `Customer.email` — campos soltos, sem tipo, sem procedência, sem histórico. **Não existe** `CustomerContact`, correção em campo nem trilha de alteração.

A precedência é a mesma da localização (§197): **contato confirmado em campo não é destruído por importação automática posterior**. E não existe endpoint de escrita no ReceitaNet — a divergência fica registrada no AlfaOS (§248).

## Design system e temas

**Carregar:** `src/app/globals.css` (os tokens) e `tailwind.config.ts` (como eles viram classe). `docs/PRD.md` §149 registra as decisões; `docs/SECURITY.md` §8.10, a allowlist.
**Quando:** a tarefa toca cor, contraste, tema, ou adiciona componente visual novo.
**Quando NÃO:** lógica de domínio, integração, backend.

Regra que evita o problema que o sistema existe para resolver: **não escrever cor de paleta direto no componente** (`bg-white`, `text-slate-900`, `bg-red-50`). Use o token semântico. Cor crua não tem contraparte no outro tema, e a divergência só aparece quando alguém troca de tema. O codebase tem **zero** utilitário de cor crua hoje — a única exceção deliberada é `SignatureCanvas`, que fixa branco e tinta escura porque produz uma imagem renderizada fora do aplicativo.

Estado operacional usa `StatusPill`, com ponto e rótulo: **cor nunca é o único sinal**.

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

Atualize este mapa sempre que um documento relevante novo for criado (ex.: quando a auditoria da v0.3 for concluída, quando a integração ReceitaNet ganhar doc próprio, quando Rede Interna do Cliente, Contatos, Field Workspace, Mapa no Field, Ferramentas ou Contratos saírem de `PLANNED` e ganharem código ou doc próprio, e quando a Jornada receber tag e deixar de estar com release pendente).

**Seções marcadas `PLANNED`** descrevem o que foi aprovado no PRD e **não** existe em código. Nenhuma delas aponta para arquivo de implementação, porque não há. Ao implementar uma, troque a marcação e liste os arquivos reais — um mapa que aponta para o que não existe é pior que um mapa incompleto.

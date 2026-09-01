# AlfaOS Field — contrato de design

O que vale para o aplicativo Flutter do técnico. Mora aqui, e não no
`docs/PRD.md`, porque o PRD é contrato de **produto** — decisão estética
detalhada ali vira ruído para quem lê o PRD atrás de regra de negócio.

O código é a autoridade final. Este documento existe para que a próxima sessão
não invente um segundo azul, uma segunda família de raio ou um terceiro tamanho
de rótulo sem perceber que já havia um.

## Design Read

Ferramenta de campo para técnico de ISP. Android primeiro, escuro como tema
principal do piloto. Register **Utility**: o design serve à tarefa e some
dentro dela. O alvo não é "parecer bonito" — é o técnico achar a próxima OS em
dois segundos, de pé, com uma mão, contra o sol ou no escuro de uma caixa de
emenda.

## Dials

| Dial | Valor | Consequência |
|---|---|---|
| `DESIGN_VARIANCE` | **4** | Grade simétrica, anatomia de tela consistente. O hero do Início é a única composição com peso próprio. |
| `MOTION_INTENSITY` | **3** | Feedback de toque e transições de plataforma. **Sem coreografia de entrada** — a tela é aberta dezenas de vezes por dia, e animação nessa frequência vira atraso. |
| `VISUAL_DENSITY` | **6** | Densidade operacional: cabe informação, sem virar planilha. |

## Cor

**Semente:** `#2563EB`, azul institucional do AlfaOS. Não é `Colors.blue` nem o
roxo de fábrica.

**Variante:** `DynamicSchemeVariant.fidelity`. O padrão (`tonalSpot`) puxa a
semente para um pastel do sistema, e era parte do "cinza demais" que o primeiro
piloto físico apontou.

**A cor é contida, e isso é a regra que mais se perde.** Ela marca **ação e
estado** — urgente, em atendimento, jornada ativa, botão principal — e nunca
decora. Numa ferramenta de trabalho, cor decorativa gasta a atenção que o
técnico precisa ter para o que é urgente de verdade.

**Escuro:** base `#0E1116`, nunca `#000`. Preto puro apaga a escada de elevação
por tom e faz todo cartão virar a mesma superfície. A profundidade vem da
escada `surfaceContainer*`, não de sombra.

**Cores de estado** vivem em `AlfaStatusColors` (`tokens.dart`), como
`ThemeExtension`: são papéis (`success`, `warning`, `danger`, `info`,
`neutral`), não "verde" e "vermelho". Nomear pelo papel é o que impede alguém
de reusar o vermelho de erro num detalhe decorativo.

## Tipografia

Uma família (Roboto, do sistema). Escala com razão ~1.15, `height` ajustado
(títulos 1.2, corpo 1.45) e `letterSpacing` negativo só nos tamanhos grandes.

`height` **nunca abaixo de 1.1**: aperta a linha e corta as descidas de "g",
"p" e "y". Há teste travando isso.

O `TextTheme` é construído **por esquema** e nunca compartilhado entre claro e
escuro — um `TextTheme` já colorido, reusado nos dois, leva a cor de um modo
para dentro do outro, e o sintoma é texto claro sobre fundo claro depois da
troca.

| Papel | Uso |
|---|---|
| `headlineSmall` | Saudação do hero |
| `titleLarge` | Título de tela (AppBar) |
| `titleMedium` | Título de card, nome de cliente |
| `bodyLarge` | Item de menu, texto de leitura |
| `bodyMedium` / `bodySmall` | Conteúdo secundário |
| `labelLarge` | Rótulo de botão (15sp, w600 — tocado de pé, às vezes com luva) |
| `labelMedium` | Selos de estado e prioridade |
| `labelSmall` | Rótulo de seção e de selo, caixa alta com espaçamento |

**Nada de `fontSize` solto em tela.** Tamanho fixo ignora a escala de texto do
Android, que vai até 200% — e quem aumentou a fonte é justamente quem mais
precisa ler o selo.

## Espaçamento e raio

`AlfaSpacing` (4/8/12/16/24/32) e `AlfaRadius` (8/12/16/28/pill). **Uma família
de raio só.** Misturar — um cartão reto ao lado de um botão arredondado — é o
tipo de inconsistência que ninguém sabe nomear e todo mundo percebe.

## Toque

Mínimo **48dp** de altura em tudo que é tocável, declarado por
`ConstrainedBox`/`minimumSize`, **não** por soma de paddings: a soma muda
sozinha quando a fonte cresce ou um selo perde o fundo. Há teste medindo o
tamanho renderizado de cada alvo.

Ação principal no terço inferior (zona do polegar). O que é raro — gaveta,
sino — fica no topo, onde alcançar custa mais.

## Movimento

Feedback de toque (ripple do Material) e transições de plataforma. Nada de
coreografia de entrada.

**Retorno tátil apenas na batida de ponto** (`mediumImpact`): o ponto é
registrado com o aparelho já saindo da mão, e a vibração confirma sem exigir
leitura. Vibração em tudo cansa e deixa de significar coisa alguma.

## Proibições

Herdadas das skills e válidas aqui:

- faixa colorida na lateral de card ou item de lista (desalinha o ícone dos
  demais e some com texto longo — use tint de fundo);
- preto puro no escuro, branco puro no texto;
- sombra como elevação no escuro;
- cor como **único** sinal de estado: sempre acompanha rótulo;
- `fontSize`, cor ou raio soltos em arquivo de tela;
- `ListView(children:)` para lista que cresce (paginação);
- travessão em texto de interface.

## Decisões registradas

| Quando | Decisão | Por quê |
|---|---|---|
| App Shell, fase 1 | Barra com três destinos: Início, OS, Jornada | PRD §255 proíbe destino morto; Mapa e Agenda não têm código |
| Device UX hardening | Gaveta apresenta o Workspace inteiro, planejado com selo `EM BREVE` | Primeiro piloto: a gaveta com seis linhas não comunicava o produto (PRD §256, revisada) |
| Device UX hardening | Bloco `ATENÇÃO AGORA`, ranking por `status` e `priority` | OS sem `scheduledAt` sumia do Início |
| Visual polish | `TextTheme` próprio, `fidelity`, escada de superfície tunada | Piloto: "monocromático, cinza, muito próximo do Material padrão" |
| Visual polish | Selo `EM BREVE` sem fundo preenchido | Quinze pílulas sólidas faziam o planejado gritar mais alto que o que funciona |
| Visual polish | Item ativo da gaveta por tint de fundo, sem faixa lateral | Faixa lateral é banida: desalinha e não sobrevive a leitura rápida |
| DQ-6 | `PositionBadge`: a `1ª` na cor de ação, as demais em superfície neutra | Só a primeira responde "o que eu faço agora"; a diferença é hierarquia, não alarme. O texto (`1ª`, `2ª`) já carrega a informação inteira |
| DQ-6 | Hero com NÚMERO grande + rótulo, e a métrica de urgência ao lado | Piloto: o topo não respondia "quanto disso é urgente". `0 URGENTES` não aparece: zero com cara de alarme é ruído |
| DQ-6 | `PRÓXIMA AGENDADA` deixou de se chamar `PRÓXIMA OS`, e virou LINHA | Duas frases diferentes ("na fila" × "com horário") usavam o mesmo rótulo, e a mesma OS aparecia como card duas vezes |
| DQ-6 | `LocalOrderNote`: etiqueta discreta, não alerta | Modo de compatibilidade precisa de procedência visível; mas nada falhou e não há ação do técnico, então não é erro |

## Verificação

O que é automatizado, e onde:

| Invariante | Teste |
|---|---|
| Alvos de toque ≥ 48dp, medidos | `test/widget/touch_targets_test.dart` |
| Claro e escuro renderizam sem exceção | `test/widget/theme_render_test.dart` |
| Texto repinta ao trocar de tema (toggle test) | `test/widget/theme_render_test.dart` |
| Escuro sem preto puro, escada com 6 degraus | `test/widget/theme_render_test.dart` |
| Escala tipográfica deliberada, `height` ≥ 1.1 | `test/widget/theme_render_test.dart` |
| Sem overflow em 360dp | `dashboard_test.dart`, `app_shell_test.dart` |
| Estado sempre com rótulo, não só cor | `dashboard_test.dart` |
| Ordem da tela = ordem do servidor | `widget/dispatch_queue_screens_test.dart` (`F-1`) |
| Posição legível sem contar linhas | `widget/dispatch_queue_screens_test.dart` (`F-3`) |
| Modo de compatibilidade declarado na tela | `widget/dispatch_queue_screens_test.dart` (`F-8`) |
| Voltar não fecha o aplicativo fora da raiz | `widget/android_back_test.dart` (`B-1`–`B-8`) |

**Não há golden test.** Cor, peso e espaçamento não estão travados por captura
de tela: mudanças estéticas passam pelos testes acima e pelo olho no aparelho.

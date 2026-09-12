import type { ConnectivityStatus } from "@prisma/client";

/**
 * # A apresentação de conectividade — uma tabela, e só uma
 *
 * ## Por que este módulo nasceu
 *
 * Os rótulos `Online`/`Offline`/`Desconhecido` já existiam em **dois** lugares —
 * `customer-diagnostics.ts` e `CustomerDiagnosticPanel.tsx` — e o Mapa
 * Operacional ia abrir o terceiro. Três cópias da mesma tradução é como uma
 * delas passa a discordar das outras, e a que diverge é sempre a que ninguém
 * revisou.
 *
 * Ele importa **só tipo** do Prisma, então serve os dois lados: a tela do
 * técnico, que roda no servidor, e a camada do mapa, que é `"use client"`. É a
 * mesma razão de `service-order-labels.ts` existir — um componente de cliente
 * que importasse `customer-diagnostics.ts` arrastaria o Prisma para o navegador,
 * que foi o defeito da `DQ-4`.
 *
 * ## Conectividade NÃO é cadastro
 *
 * `ONLINE`/`OFFLINE`/`UNKNOWN` respondem *"o link está no ar?"*. Se o cliente é
 * cliente responde `Customer.active`, e são perguntas independentes: um cliente
 * `ATIVO` pode estar `OFFLINE` — é o caso mais comum de todos, e é justamente o
 * que faz alguém abrir uma OS.
 *
 * ## `UNKNOWN` nunca é `OFFLINE`
 *
 * Não saber não é estar fora do ar. Colapsar os dois mandaria o técnico
 * investigar um problema de rede que não existe — e, no mapa, pintaria de
 * vermelho toda uma carteira que simplesmente nunca foi consultada.
 */

export type ConnectivityTone = "success" | "danger" | "neutral";

export interface ConnectivityPresentation {
  status: ConnectivityStatus;
  /** O rótulo do PRODUTO, usado na tela da OS desde a v0.5. */
  label: string;
  /**
   * Como o MAPA nomeia o mesmo estado.
   *
   * `UNKNOWN` é "Desconhecido" na tela da OS, onde se fala de um cliente por
   * vez e o contexto é claro. No mapa, onde o operador varre dezenas de pontos,
   * **"Sem leitura"** diz o que de fato aconteceu: ninguém consultou este
   * cliente ainda. "Desconhecido" ali soa como um estado do link, e não como
   * ausência de observação.
   *
   * As duas grafias moram na MESMA linha desta tabela de propósito: assim elas
   * não podem divergir, e a diferença fica sendo de fraseado, nunca de
   * significado.
   */
  mapLabel: string;
  /**
   * O mesmo estado, com o SUJEITO — "Cliente online".
   *
   * Onde o estado aparece ao lado de outras coisas que também podem estar
   * "online" ou "abertas" — a legenda, que tem um grupo de OS; o popup da OS,
   * que fala da ordem e do cliente —, "Online" sozinho não diz de quê. O dono
   * pediu o nome da coisa. "Sem leitura" já carrega o sujeito implícito
   * (ninguém leu o cliente) e fica como está.
   *
   * Mora na mesma linha da tabela pela mesma razão de `mapLabel`: fraseado
   * pode variar, significado não.
   */
  customerLabel: string;
  /**
   * O glifo. Estado nunca viaja só como cor.
   *
   * Um mapa que distinguisse online de offline apenas por matiz seria ilegível
   * para quem tem daltonismo, sob sol, ou impresso — a mesma regra que o
   * marcador de CTO já segue.
   */
  glyph: string;
  tone: ConnectivityTone;
}

export const CONNECTIVITY_PRESENTATION: Record<
  ConnectivityStatus,
  ConnectivityPresentation
> = {
  ONLINE: {
    status: "ONLINE",
    label: "Online",
    mapLabel: "Online",
    customerLabel: "Cliente online",
    glyph: "●",
    tone: "success",
  },
  OFFLINE: {
    status: "OFFLINE",
    label: "Offline",
    mapLabel: "Offline",
    customerLabel: "Cliente offline",
    glyph: "×",
    tone: "danger",
  },
  UNKNOWN: {
    status: "UNKNOWN",
    label: "Desconhecido",
    mapLabel: "Sem leitura",
    customerLabel: "Sem leitura",
    glyph: "?",
    tone: "neutral",
  },
};

export function connectivityPresentation(
  status: ConnectivityStatus,
): ConnectivityPresentation {
  return CONNECTIVITY_PRESENTATION[status];
}

/** Os rótulos do produto, na forma que `customer-diagnostics` já exportava. */
export const CONNECTIVITY_LABELS: Record<ConnectivityStatus, string> = {
  ONLINE: CONNECTIVITY_PRESENTATION.ONLINE.label,
  OFFLINE: CONNECTIVITY_PRESENTATION.OFFLINE.label,
  UNKNOWN: CONNECTIVITY_PRESENTATION.UNKNOWN.label,
};

/**
 * "há 4 min", a partir de um instante de observação.
 *
 * A idade é CALCULADA na leitura, nunca persistida: um `ageMinutes` gravado
 * estaria errado no segundo seguinte. `null` quando nunca houve observação — e
 * a tela diz "sem leitura" em vez de "há 0 min", que afirmaria uma consulta que
 * não aconteceu.
 */
export function connectivityAge(
  observedAt: string | null,
  now: Date = new Date(),
): string | null {
  if (!observedAt) return null;
  const instante = new Date(observedAt).getTime();
  if (Number.isNaN(instante)) return null;

  const minutos = Math.floor((now.getTime() - instante) / 60_000);
  if (minutos < 1) return "agora há pouco";
  if (minutos < 60) return `há ${minutos} min`;

  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `há ${horas} h`;

  const dias = Math.floor(horas / 24);
  return `há ${dias} d`;
}

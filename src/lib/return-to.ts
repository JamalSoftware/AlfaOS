/**
 * Destino de volta, vindo da query string.
 *
 * O valor é escrito na URL, então é entrada do usuário — qualquer link montado
 * por terceiro chega aqui. Sem validação isto é um redirect aberto: o operador
 * autenticado clica em "voltar" e cai numa tela que imita a de origem, fora do
 * AlfaOS.
 *
 * A defesa é **allowlist, não denylist**. Filtrar `javascript:` e `//` é uma
 * corrida que se perde: `\/\/`, `%2f%2f`, `/\`, tab no meio do esquema e
 * dezenas de outras formas contornam listas de proibição. Aqui só passa o que
 * casa exatamente com uma das duas rotas conhecidas — o resto vira `null`, e
 * quem chama usa o padrão.
 */

/** Rotas internas que o botão de voltar sabe construir. */
export type ReturnTo =
  | { kind: "customers" }
  | { kind: "order"; orderId: string };

/**
 * Formato de `cuid()`, que é o que o Prisma gera para `ServiceOrder.id`.
 *
 * Restringir o formato não é o controle de acesso — é só a primeira peneira.
 * Quem chama ainda precisa resolver a OS sob a empresa da sessão, senão um id
 * de outro tenant produziria um link válido para um recurso que o usuário não
 * pode ver.
 */
const ID_INTERNO = /^c[a-z0-9]{20,32}$/;

/**
 * Aceita EXATAMENTE `/clientes` ou `/ordens/<id>`.
 *
 * Sem query, sem fragmento, sem barra final, sem esquema, sem host. A âncora
 * `^...$` é o que torna irrelevante toda a criatividade de codificação: uma
 * string que contenha qualquer outra coisa simplesmente não casa.
 */
export function parseReturnTo(raw: unknown): ReturnTo | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 64) {
    return null;
  }

  if (raw === "/clientes") {
    return { kind: "customers" };
  }

  const os = /^\/ordens\/([^/]+)$/.exec(raw);
  if (os && ID_INTERNO.test(os[1])) {
    return { kind: "order", orderId: os[1] };
  }

  return null;
}

/**
 * Constrói o valor a ser colocado na URL.
 *
 * Existe para que quem gera o link não monte a string à mão e acabe fora do
 * formato que o parser aceita — as duas pontas usam a mesma definição.
 */
export function buildReturnTo(destino: ReturnTo): string {
  return destino.kind === "customers"
    ? "/clientes"
    : `/ordens/${destino.orderId}`;
}

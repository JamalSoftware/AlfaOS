/**
 * # Como o cliente é identificado NO MAPA
 *
 * O marcador mostra o **primeiro nome**, e nada além dele. Nome completo como
 * rótulo permanente espalharia identificação por uma tela cujo trabalho é
 * desenhar pontos; ele continua no popup, aberto por ação explícita, e telefone,
 * documento e endereço não entram no mapa em hipótese nenhuma.
 *
 * ## Por que isto NÃO pode ir para dentro do `divIcon`
 *
 * O ícone do marcador é montado como HTML cru. A regra do projeto — desde a
 * plaqueta da CTO, na `CTO-3.2.1c` — é que **nome digitado por gente nunca
 * entra em `divIcon`**; ele vai por `Tooltip`, que o React escapa.
 *
 * A fase anterior usava INICIAIS ali, e podia: `[A-Z]{0,2}` não contém um único
 * caractere com significado em HTML, e a garantia era do próprio helper. Um
 * primeiro nome não tem essa garantia — ele pode conter `<`, `&`, aspas. Por
 * isso o rótulo desta fase é `Tooltip`, e não texto no ícone.
 *
 * Esta função é de APRESENTAÇÃO: ela não toca no nome persistido, não altera
 * `Customer` e não decide nada sobre o dado.
 */

/**
 * Conectores que não são nome próprio.
 *
 * Só importam quando aparecem ANTES do primeiro nome de verdade, o que é raro
 * mas acontece em cadastro que começa com partícula.
 */
const CONECTORES = new Set(["da", "das", "de", "do", "dos", "e"]);

/**
 * O primeiro nome, em caixa de apresentação.
 *
 * `MARIA GONÇALVES` e `maria gonçalves` viram os dois `Maria`: o cadastro é
 * escrito de jeitos diferentes por gente diferente, e o mapa não pode gritar
 * por causa disso. A acentuação é preservada — ela faz parte do nome.
 *
 * Devolve string vazia quando não há nome: o marcador existe sem rótulo, e
 * fabricar texto para preencher seria inventar dado.
 */
export function customerFirstName(nome: string): string {
  const palavras = nome
    .split(/\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (palavras.length === 0) return "";

  /*
    A primeira palavra SIGNIFICATIVA.

    Um cadastro que começa com partícula — "de Souza" — tem "Souza" como
    primeiro nome de fato. Se sobrarem só conectores, vale a primeira palavra:
    devolver vazio havendo letra a mostrar seria pior.
  */
  const significativa =
    palavras.find((p) => !CONECTORES.has(p.toLowerCase())) ?? palavras[0];

  // Nome composto por hífen é UM nome: "ANA-CLARA" vira "Ana-Clara", e não
  // "Ana-clara".
  return significativa
    .split("-")
    .map(
      (parte) =>
        parte.charAt(0).toLocaleUpperCase("pt-BR") +
        parte.slice(1).toLocaleLowerCase("pt-BR"),
    )
    .join("-");
}

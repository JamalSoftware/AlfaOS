/**
 * # As iniciais do cliente, para o marcador do mapa
 *
 * O mapa identifica o assinante por DUAS letras, e não pelo nome. Nome completo
 * como rótulo permanente transformaria o mapa numa lista de pessoas — e
 * espalharia identificação por uma tela cujo trabalho é desenhar pontos
 * (`docs/SECURITY.md`, e a mesma razão pela qual o DTO do mapa não leva
 * documento nem telefone). O nome inteiro vive no popup, que é aberto por ação
 * explícita.
 *
 * ## O contrato de SAÍDA é o que torna o rótulo seguro
 *
 * O resultado é garantidamente `[A-Z]{0,2}` — no máximo duas letras maiúsculas
 * sem acento, ou string vazia. Isso não é detalhe de formatação: o marcador é
 * um `divIcon`, e `divIcon` recebe **HTML cru**. A regra do projeto é que nome
 * digitado por gente nunca entra ali (a plaqueta da CTO usa `Tooltip`, que o
 * React escapa). Duas letras derivadas por esta função podem, porque o conjunto
 * de saída não contém caractere nenhum com significado em HTML — e há teste
 * provando isso para entrada hostil.
 */

/**
 * Conectores que não viram inicial.
 *
 * "João da Silva Neto" é `JN`, não `JS`: quem responde pela pessoa é o primeiro
 * nome e o último sobrenome, e a partícula no meio é gramática, não identidade.
 */
const CONECTORES = new Set(["da", "das", "de", "do", "dos", "e"]);

/**
 * Duas letras, no máximo — a primeira do primeiro nome significativo e a
 * primeira do último. Nome de uma palavra só devolve uma letra.
 *
 * Acentos são removidos antes de escolher a letra, então "Ângela" vira `A` e
 * não `Â`: o marcador tem dezoito pixels, e diacrítico nesse tamanho vira
 * sujeira em cima da letra.
 */
export function customerInitials(nome: string): string {
  const palavras = nome
    .normalize("NFD")
    // Remove os diacríticos, preservando a letra base.
    .replace(/[̀-ͯ]/g, "")
    .split(/\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const significativas = palavras.filter(
    (p) => !CONECTORES.has(p.toLowerCase()),
  );

  /*
    Sobrando só conectores, valem as palavras originais.

    Um cadastro com o nome "de" é improvável e não é motivo para devolver vazio
    quando existe letra a mostrar.
  */
  const base = significativas.length > 0 ? significativas : palavras;
  if (base.length === 0) return "";

  const primeira = base[0];
  const ultima = base[base.length - 1];
  const letras =
    base.length === 1 ? [primeira[0]] : [primeira[0], ultima[0]];

  return letras
    .join("")
    .toUpperCase()
    /*
      A peneira final, e é ela que autoriza o uso em `divIcon`.

      Qualquer coisa que não seja letra A–Z sai: dígito, pontuação, emoji,
      `<`, `&`. Um nome cadastrado como `<img src=x onerror=alert(1)>` devolve
      no máximo duas letras, e nunca marcação.
    */
    .replace(/[^A-Z]/g, "")
    .slice(0, 2);
}

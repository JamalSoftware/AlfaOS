import { notFound } from "next/navigation";

/**
 * O `digest` que o `notFound()` do Next INSTALADO produz (`SEC-003`).
 *
 * Os testes de isolamento de tenant e de posse que exercitam páginas afirmam
 * que a página respondeu 404 — e faziam isso comparando com a string
 * `"NEXT_NOT_FOUND"`, que é detalhe interno do framework. O Next 15 a trocou por
 * `"NEXT_HTTP_ERROR_FALLBACK;404"`, e cinco testes de SEGURANÇA passaram a falhar
 * sem que nada no comportamento tivesse mudado: a página continuava negando o
 * acesso.
 *
 * Comparar com o que o próprio `notFound()` lança mantém a asserção EXATA — ela
 * continua distinguindo 404 de um redirecionamento ou de um 500 — sem prender o
 * teste a uma string que o framework pode trocar a cada major. Um upgrade que
 * mudasse o digest de novo não quebraria a suíte por motivo errado; um que
 * fizesse a página deixar de chamar `notFound()` continuaria quebrando.
 */
export const NOT_FOUND_DIGEST: string = (() => {
  try {
    notFound();
  } catch (erro) {
    const digest = (erro as { digest?: unknown }).digest;
    if (typeof digest === "string") return digest;
  }
  throw new Error("notFound() não lançou um erro com digest — o contrato do Next mudou");
})();

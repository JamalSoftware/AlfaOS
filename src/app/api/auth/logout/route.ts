import { runApi } from "@/lib/api";
import { SESSION_COOKIE_NAME } from "@/lib/constants";
import { assertSameOrigin } from "@/lib/csrf";

/**
 * Encerra a sessão.
 *
 * POST, e não GET: sair é ação que muda estado, e um GET seria disparado por
 * qualquer `<img src="/api/auth/logout">` numa página de terceiro — logout
 * forçado é CSRF de baixo impacto, mas é CSRF. O `<form method="post">` da
 * Sidebar é o único caminho, e passa pela mesma checagem Same-Origin de todas
 * as rotas mutantes.
 *
 * **A sessão é um token assinado, sem estado no servidor.** Não existe registro
 * a invalidar: remover o cookie É a invalidação, e é por isso que a resposta
 * sempre limpa, mesmo sem sessão válida na entrada. Exigir sessão aqui daria
 * uma tela de erro justamente a quem clicou em "Sair" com o token já expirado —
 * a pessoa que mais precisa que a ação funcione.
 */
export async function POST(request: Request) {
  return runApi(async () => {
    const csrfBlocked = assertSameOrigin(request);
    if (csrfBlocked) {
      return csrfBlocked;
    }

    /*
      303 See Other, com `Location` RELATIVO.

      O 307 anterior preservava o método: o navegador refazia POST em `/login`,
      que devolvia outro 307 e uma página de erro. 303 é exatamente o status
      que converte POST em GET.

      E o destino é relativo porque o absoluto vinha de `new URL("/login",
      request.url)` — e `request.url`, no Next 14, carrega o host resolvido na
      subida do servidor, não o da requisição. Quem abrisse o AlfaOS pelo IP da
      rede era mandado para o `localhost` do PRÓPRIO aparelho ao sair.

      Relativo também fecha a porta para open redirect: o navegador resolve
      contra a URL que ele mesmo pediu, e nenhum cabeçalho participa disso.
    */
    const response = new Response(null, {
      status: 303,
      headers: { Location: "/login" },
    });

    response.headers.append(
      "Set-Cookie",
      [
        `${SESSION_COOKIE_NAME}=`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        "Max-Age=0",
        // `Expires` no passado acompanha `Max-Age` para navegador antigo que
        // ignora o segundo.
        "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
        ...(process.env.NODE_ENV === "production" ? ["Secure"] : []),
      ].join("; "),
    );

    return response;
  });
}

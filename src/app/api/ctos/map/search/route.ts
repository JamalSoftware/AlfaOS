import { AccessProfile } from "@prisma/client";
import { jsonOk, runApi } from "@/lib/api";
import { requireCtoAccess } from "@/lib/cto-access";
import {
  CTO_MAP_SEARCH_MAX_RESULTS,
  normalizeMapSearchQuery,
  searchCtosForMap,
} from "@/lib/cto-map";

/**
 * `GET /api/ctos/map/search?q=`
 *
 * Encontrar uma caixa pelo nome ou pelo código, em toda a carteira da empresa.
 *
 * ## Por que não é um parâmetro do recorte
 *
 * `GET /api/ctos/map` tem `bbox` **obrigatório** e teto de 200 — é o que impede
 * uma resposta de carregar a carteira inteira (§200). Aceitar `?q=` lá faria
 * esse teto virar condicional, e a condição estaria num `if`. Aqui o contrato é
 * outro desde a assinatura: sem recorte, com teto de dez, e um DTO menor.
 *
 * A busca **localiza**; ela não desenha. O fluxo aprovado é achar →
 * recentralizar → o recorte carregar, e é o recorte que continua sendo a única
 * autoridade sobre estado operacional.
 *
 * ## Mesmo portão, mesma ordem
 *
 * `requireCtoAccess` com `ADMIN` e `DISPATCHER`, exatamente como a leitura do
 * recorte: capability antes de perfil, `companyId` da sessão. Uma busca com
 * portão próprio seria a autorização duplicada que a §201 nomeia — *"a segunda
 * implementação esquece uma checagem que a primeira faz"*.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return runApi(async () => {
    const access = await requireCtoAccess(request, [
      AccessProfile.ADMIN,
      AccessProfile.DISPATCHER,
    ]);
    if (!access.ok) return access.response;

    const termo = normalizeMapSearchQuery(
      new URL(request.url).searchParams.get("q"),
    );

    /*
      Termo ausente ou curto demais NÃO consulta o banco.

      Devolver lista vazia é o comportamento definido, e o importante é o que
      ele evita: um `contains` de string vazia casa com toda a carteira, de modo
      que "sem termo" seria o jeito mais curto de pedir tudo — pelo endpoint que
      não tem recorte para limitar.
    */
    if (termo === null) {
      return jsonOk({
        search: { hits: [], truncated: false, limit: CTO_MAP_SEARCH_MAX_RESULTS },
      });
    }

    /*
      `companyId` da SESSÃO. Não existe caminho para ele vir da query — e numa
      busca isso é ainda mais decisivo que no recorte: aqui não há retângulo
      nenhum estreitando o resultado, então um tenant vindo do cliente
      devolveria a rede do concorrente inteira, dez linhas por vez.
    */
    const search = await searchCtosForMap(access.session.companyId, termo);

    return jsonOk({ search });
  });
}

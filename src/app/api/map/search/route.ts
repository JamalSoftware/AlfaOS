import { AccessProfile } from "@prisma/client";
import { jsonOk, runApi } from "@/lib/api";
import { requireCtoAccess } from "@/lib/cto-access";
import { normalizeMapSearchQuery } from "@/lib/cto-map";
import { searchOperationalMap } from "@/lib/map-search";

/**
 * `GET /api/map/search?q=`
 *
 * A busca do Mapa Operacional: caixas, clientes ativos e OS abertas.
 *
 * ## Ela SUBSTITUI `/api/ctos/map/search`
 *
 * A rota antiga procurava só caixas, e vivia sob `/api/ctos/` porque era isso
 * que ela era. Manter as duas deixaria duas buscas para a mesma tela — e a que
 * ninguém usa é a que diverge sem que ninguém perceba. O termo continua sendo
 * validado por `normalizeMapSearchQuery`, exatamente a mesma função, com os
 * mesmos limites: nada de validação nova.
 *
 * ## Quem lê, e o que cada um recebe
 *
 * `ADMIN` e `DISPATCHER` alcançam a rota. **O `DISPATCHER` não recebe
 * clientes**: a camada de clientes é `ADMIN` nesta fase, e uma busca que
 * devolvesse nome e coordenada de assinante contornaria essa decisão por outra
 * porta. Filtrar na tela não resolveria nada — o dado já teria saído do
 * servidor.
 *
 * ## Termo curto não é erro
 *
 * `null` de `normalizeMapSearchQuery` significa "não há o que consultar" —
 * campo vazio, ou quem começou a digitar. A resposta é uma lista vazia, e não
 * um 400: devolver erro para quem digitou uma letra seria hostil.
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
    if (termo === null) {
      return jsonOk({ search: { hits: [], truncated: false, limit: 0 } });
    }

    const search = await searchOperationalMap(access.session.companyId, termo);

    /*
      O corte de perfil acontece no SERVIDOR, depois da busca e antes da
      resposta.

      Poderia acontecer antes, não consultando clientes para o `DISPATCHER` — e
      seria uma consulta a menos. Fica aqui porque o critério é de EXPOSIÇÃO, e
      quero que ele viva num lugar só, evidente, ao lado do que sai pela porta.
      Espalhá-lo pela montagem da consulta é como se esquece dele na terceira.
    */
    const podeVerClientes = access.session.profile === AccessProfile.ADMIN;
    const hits = podeVerClientes
      ? search.hits
      : search.hits.filter((hit) => hit.type !== "CUSTOMER");

    return jsonOk({ search: { ...search, hits } });
  });
}

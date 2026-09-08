import { assertFieldCtoEnabled, getFieldOrderNetwork } from "@/lib/field/cto";
import { fieldOk, noStore, runFieldApi } from "@/lib/field/response";
import { requireFieldPrincipal } from "@/lib/field/route";

/**
 * `GET /api/field/v1/service-orders/:id/network`
 *
 * Onde o cliente **desta OS** está na rede de distribuição agora.
 *
 * ## Por que a leitura também exige `IN_PROGRESS`
 *
 * O precedente mais próximo é o diagnóstico (`../diagnostic`), que exige posse
 * e **não** exige `IN_PROGRESS`: ele é consultado a caminho do cliente, com a
 * OS ainda `ASSIGNED`. Esta superfície diverge, e a razão está declarada:
 *
 * - o que ela abre não é o cliente da OS, é a **rede da empresa** — as caixas,
 *   as posições e quais estão livres. Nenhuma outra leitura do Field tem esse
 *   alcance; todas as demais param no que já é do próprio técnico;
 * - as três mutações exigem `IN_PROGRESS`. Uma leitura mais permissiva
 *   ofereceria ao aplicativo uma tela que ele não tem como usar.
 *
 * Consequência aceita: o técnico não vê a caixa do cliente antes de dar
 * início. `docs/CTO-NETWORK-DISTRIBUTION.md` §29.
 *
 * `no-store` explícito, pela mesma razão da fila do despacho: uma lista servida
 * do cache mostra dado velho e a pessoa percebe; uma **porta** servida do cache
 * faz o técnico mexer na posição errada sem nenhum sinal.
 */
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: { id: string } },
) {
  return runFieldApi(async () => {
    const principal = await requireFieldPrincipal(request);
    // Capability antes de qualquer coisa específica do módulo: desligada, a
    // rota é indistinguível de uma rota que não existe.
    await assertFieldCtoEnabled(principal);

    const network = await getFieldOrderNetwork(
      principal.user.companyId,
      principal.technician.id,
      context.params.id,
    );

    return noStore(fieldOk(network));
  });
}

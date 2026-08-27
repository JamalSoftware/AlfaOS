import {
  consumeCapabilityToken,
  ERP_CAPABILITIES,
} from "@/lib/capability-rate-limit";
import { refreshCustomerDiagnostic } from "@/lib/customer-diagnostics";
import { FieldError } from "@/lib/field/errors";
import { fieldOk, runFieldApi } from "@/lib/field/response";
import { requireFieldPrincipal } from "@/lib/field/route";
import { resolveOwnedOrderCustomer } from "@/lib/field/service-orders";

/**
 * `POST /api/field/v1/service-orders/:id/diagnostic`
 *
 * Releitura de conectividade do cliente da OS.
 *
 * ## O Field nunca fala com o ReceitaNet
 *
 * ```text
 * Flutter  →  AlfaOS Field API  →  ReceitaNet
 * ```
 *
 * A credencial do ERP **não sai do servidor**. Um token de provider embarcado
 * no aplicativo estaria em centenas de aparelhos fora do controle da empresa e
 * valeria para a base INTEIRA de clientes — não só para a OS aberta
 * (`docs/SECURITY.md` §8.9). O adapter, o store de credencial e o catálogo
 * fechado de erros continuam onde estão; o Field só pede.
 *
 * ## Escopo pela OS, não pelo cliente
 *
 * O `customerId` vem da OS, resolvido no servidor. Uma rota
 * `/customers/:id/diagnostic` daria a qualquer técnico autenticado um oráculo
 * sobre a carteira inteira da empresa: chutar ids e observar 200 contra 404.
 * Indo pela OS, a resposta só existe sobre um cliente que ele já atende.
 *
 * ## Leitura, e por isso sem idempotência
 *
 * Não muda estado de domínio: grava um snapshot de observação. Repetir produz
 * outra leitura, que é exatamente o que o técnico quer ao apertar "atualizar"
 * — desduplicar seria devolver a medição velha justamente quando ele pediu uma
 * nova. O teto de frequência é o que protege a cota do provider.
 */
export async function POST(
  request: Request,
  context: { params: { id: string } },
) {
  return runFieldApi(async () => {
    const principal = await requireFieldPrincipal(request);

    // Posse primeiro: OS de outro técnico é 404 antes de qualquer chamada
    // externa e antes de gastar cota.
    const owned = await resolveOwnedOrderCustomer(
      principal.user.companyId,
      principal.technician.id,
      context.params.id,
    );

    const quota = consumeCapabilityToken(
      principal.user.companyId,
      principal.user.id,
      ERP_CAPABILITIES.CUSTOMER_DIAGNOSTIC,
    );
    if (!quota.allowed) {
      throw new FieldError(
        "RATE_LIMITED",
        "Muitas consultas em sequência. Tente novamente em instantes.",
      );
    }

    const result = await refreshCustomerDiagnostic(
      principal.user.companyId,
      principal.user.id,
      owned.customerId,
    );

    /*
      Projeção enxuta: estado, quando foi observado, e se ESTA tentativa deu
      certo.

      Os dois são separados de propósito, e é o mesmo cuidado do `erro ≠
      OFFLINE`: quando a releitura falha, `snapshot` continua trazendo a última
      observação VÁLIDA, e `ok: false` diz que ela é velha. Assim o aplicativo
      mostra "não foi possível atualizar; última leitura: Online às 08:42" em
      vez de inventar um estado — ou pior, de exibir OFFLINE porque a
      integração caiu.

      `errorCode` vem do catálogo fechado de `IntegrationError`, seguro para
      exibir. Fora da resposta ficam o payload cru do provider, o código de
      tecnologia e o identificador do cliente no ERP.
    */
    return fieldOk({
      ok: result.ok,
      diagnostic: result.snapshot
        ? {
            connectivityStatus: result.snapshot.connectivityStatus,
            observedAt: result.snapshot.observedAt.toISOString(),
          }
        : null,
      ...(result.ok
        ? {}
        : {
            error: {
              code: result.errorCode ?? "UPSTREAM_UNAVAILABLE",
              message: result.errorMessage ?? "Não foi possível consultar.",
            },
          }),
    });
  });
}

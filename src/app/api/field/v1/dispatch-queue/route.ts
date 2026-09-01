import { fieldOk, noStore, runFieldApi } from "@/lib/field/response";
import { requireFieldPrincipal } from "@/lib/field/route";
import { getFieldDispatchQueue } from "@/lib/field/service-orders";

/**
 * Rota autenticada por Bearer: nunca estática.
 */
export const dynamic = "force-dynamic";

/**
 * `GET /api/field/v1/dispatch-queue`
 *
 * A fila operacional do técnico que está com o aparelho — **na ordem que o
 * despachante definiu** (PRD §323, `docs/DISPATCH-QUEUE.md`).
 *
 * ## Não existe `?technicianId=`
 *
 * O aplicativo não escolhe qual fila quer ler. O dono é derivado do token no
 * servidor (`token → MobileDevice → User → Technician`), e um parâmetro com
 * esse nome seria simplesmente ignorado — a autorização não passa por nada que
 * o cliente escreva. É a mesma decisão de `GET /service-orders`.
 *
 * ## Somente leitura
 *
 * O Field **recebe** a ordem; não a negocia. Não há rota de reordenação nem de
 * prioridade nesta superfície, e não haverá: quem decide a sequência é o
 * despacho (PRD §315), e uma segunda porta faria o técnico e o despachante
 * disputarem a mesma fila.
 *
 * ## `position` é o contrato
 *
 * `queued` chega ordenada por `position` crescente, 1..N. É por ela que o
 * aplicativo vai decidir, em DQ-6, se obedece ao servidor ou cai no ranking
 * local — **presença de dado, não versão de APK** —, o que mantém a
 * convivência de APKs antigos que a §192 exige.
 *
 * ## `no-store`, e por quê
 *
 * As demais leituras do Field não marcam o cabeçalho explicitamente; aqui ele
 * é marcado. A diferença não é de segurança: uma lista de OS servida do cache
 * mostra dado velho, e a pessoa percebe. Uma FILA servida do cache faz o
 * técnico **trabalhar na ordem errada** e não dá nenhum sinal disso — o
 * despachante moveu uma urgente para a 1ª e o aplicativo continua exibindo a
 * ordem de vinte minutos atrás como se fosse a atual.
 */
export async function GET(request: Request) {
  return runFieldApi(async () => {
    const principal = await requireFieldPrincipal(request);

    const queue = await getFieldDispatchQueue(
      principal.user.companyId,
      principal.technician.id,
    );

    return noStore(fieldOk(queue));
  });
}

import { AccessProfile } from "@prisma/client";
import { z } from "zod";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import {
  ADJUSTMENT_NOTES_MAX,
  ADJUSTMENT_REASON_MAX,
  requestTimeAdjustment,
} from "@/lib/time-clock";

/**
 * `POST /api/time-clock/members/:userId/adjustments`
 *
 * O gestor abre uma correção **em nome** de um funcionário (PRD §229, §231).
 *
 * ## Isto NÃO edita a marcação
 *
 * Existe porque o técnico nem sempre pode pedir: aparelho sem bateria, sem
 * sinal, desligado, ou a pessoa simplesmente não usa o Field. Sem este caminho,
 * a única saída do gestor seria um `UPDATE` na marcação — que é exatamente o
 * que o módulo inteiro existe para impedir.
 *
 * O que ele cria é o MESMO `TimeAdjustmentRequest` que o aplicativo cria, com
 * `status = PENDING`. Ele entra na MESMA fila, é aprovado pelo MESMO
 * `decideTimeAdjustment`, passa pela MESMA validação de sequência efetiva, pelo
 * MESMO lock do dia e pela MESMA supersessão. **Não existe segunda fila e não
 * existe atalho administrativo.**
 *
 * ## Pedir e decidir continuam separados
 *
 * Criar não aprova. O pedido nasce pendente mesmo tendo sido aberto por um
 * ADMIN, e a aprovação continua sendo um fato próprio, com seu próprio
 * `AuditLog` e seu próprio decisor. Autoaprovação silenciosa apagaria o
 * contraditório que o §229 exige — quem pede e quem decide ficam registrados
 * separadamente ainda quando são a mesma pessoa.
 *
 * ## Papéis
 *
 * **Só ADMIN.** Abrir correção na jornada de outra pessoa é da mesma família de
 * decidi-la. O DISPATCHER vê quem está trabalhando (`/api/time-clock/team`) e
 * não entra aqui.
 *
 * `companyId` sai da SESSÃO; `userId` vem da rota e é conferido dentro do
 * domínio. Um `userId` de outra empresa devolve 404, não 403.
 */
const ADMIN_ONLY = [AccessProfile.ADMIN];

const schema = z
  .object({
    requestedType: z.enum(["MISSING_ENTRY", "WRONG_TIME", "BREAK", "OTHER"]),
    requestedEntryType: z.enum([
      "CLOCK_IN",
      "BREAK_START",
      "BREAK_END",
      "CLOCK_OUT",
    ]),
    requestedOccurredAt: z.string().datetime(),
    reason: z.string().min(1).max(ADJUSTMENT_REASON_MAX),
    notes: z.string().max(ADJUSTMENT_NOTES_MAX).optional().nullable(),
    targetEntryId: z.string().min(1).max(60).optional().nullable(),
  })
  .strict();

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: { userId: string } },
) {
  return runApi(async () => {
    const csrfBlocked = assertSameOrigin(request);
    if (csrfBlocked) {
      return csrfBlocked;
    }

    const session = await getSessionUser(request);
    if (!session) {
      return jsonError("Não autenticado.", 401);
    }
    const denied = assertProfile(session.profile, ADMIN_ONLY);
    if (denied) return denied;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("Corpo inválido.", 400);
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400);
    }

    const adjustment = await requestTimeAdjustment(
      session.companyId,
      context.params.userId,
      {
        requestedType: parsed.data.requestedType,
        requestedEntryType: parsed.data.requestedEntryType,
        requestedOccurredAt: new Date(parsed.data.requestedOccurredAt),
        reason: parsed.data.reason,
        notes: parsed.data.notes ?? null,
        targetEntryId: parsed.data.targetEntryId ?? null,
      },
      // O AUTOR é o gestor da sessão, nunca o funcionário: o histórico precisa
      // mostrar que este pedido não partiu de quem bateu o ponto.
      session.id,
    );

    return jsonOk(
      {
        adjustment: {
          id: adjustment.id,
          status: adjustment.status,
          requestedEntryType: adjustment.requestedEntryType,
          requestedOccurredAt: adjustment.requestedOccurredAt.toISOString(),
          workdayDate: adjustment.workdayDate,
          requestedByName: adjustment.requestedByName,
        },
      },
      201,
    );
  });
}

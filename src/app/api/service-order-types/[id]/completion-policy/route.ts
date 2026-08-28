import { AccessProfile } from "@prisma/client";
import { z } from "zod";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import {
  MAX_REQUIRED_EVIDENCE,
  putCompletionPolicy,
} from "@/lib/service-order-completion";

/**
 * `PUT /api/service-order-types/:id/completion-policy`
 *
 * O que este tipo de OS exige para concluir (PRD §164, §166).
 *
 * Instalação pede foto, equipamento e assinatura; manutenção pede antes e
 * depois; entrega de carnê pode não pedir nada. Isso é CONFIGURAÇÃO da empresa
 * — nunca `if (tipo === "INSTALACAO")` no código, que viraria um arquivo
 * impossível de alterar sem release, e nunca uma regra escrita no Flutter, que
 * um APK antigo em campo ignoraria.
 *
 * Só ADMIN: mudar isto muda quando uma OS pode fechar.
 *
 * A política é SUBSTITUÍDA por inteiro. Um patch parcial obrigaria a decidir o
 * que um campo ausente significa — "não mude" ou "não exige" — e as duas
 * leituras dão resultados opostos para quem esquecer um campo.
 */
const MANAGE_PROFILES = [AccessProfile.ADMIN];

const schema = z
  .object({
    requireChecklist: z.boolean(),
    requireSignature: z.boolean(),
    requireMaterials: z.boolean(),
    requireEquipment: z.boolean(),
    requireCheckIn: z.boolean(),
    minEvidenceCount: z.number().int().min(0).max(MAX_REQUIRED_EVIDENCE),
    requiredEvidenceCategories: z
      .array(
        z.enum([
          "BEFORE_SERVICE",
          "INSTALLATION_LOCATION",
          "CABLE_ROUTE",
          "CTO",
          "ONU_ONT",
          "ROUTER",
          "EQUIPMENT",
          "OPTICAL_READING",
          "WIFI_TEST",
          "SPEED_TEST",
          "AFTER_SERVICE",
          "OTHER",
        ]),
      )
      .max(12),
  })
  .strict();

export async function PUT(
  request: Request,
  context: { params: { id: string } },
) {
  return runApi(async () => {
    const csrfBlocked = assertSameOrigin(request);
    if (csrfBlocked) return csrfBlocked;

    const session = await getSessionUser(request);
    if (!session) return jsonError("Não autenticado.", 401);
    const denied = assertProfile(session.profile, MANAGE_PROFILES);
    if (denied) return denied;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("Corpo da requisição inválido.", 400);
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    // `companyId` da sessão; o serviço valida que o tipo pertence a ela antes
    // de escrever — sem isso um ADMIN configuraria a conclusão de outra empresa.
    const policy = await putCompletionPolicy(
      session.companyId,
      session.id,
      context.params.id,
      parsed.data,
    );

    return jsonOk({ policy });
  });
}

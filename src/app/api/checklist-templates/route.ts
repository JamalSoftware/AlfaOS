import { AccessProfile } from "@prisma/client";
import { z } from "zod";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { POLICY_EVIDENCE_CATEGORIES } from "@/lib/evidence-category-policy";
import { getSessionUser } from "@/lib/session";
import {
  listCompanyChecklistTemplates,
  putChecklistTemplate,
  setChecklistTemplateActive,
} from "@/lib/checklists";

/**
 * Configuração do checklist por empresa e tipo de OS (PRD §165).
 *
 * Só ADMIN mantém: o checklist define o que é exigido para concluir, então
 * editá-lo muda a regra de fechamento de toda OS iniciada dali em diante.
 * Despachante lê para saber o que o técnico vai preencher.
 *
 * `companyId` vem da SESSÃO e os schemas são `.strict()` sem o campo — não há
 * caminho pelo qual o cliente escolha a empresa do template.
 */
/** Rota de sessão: nunca estática. Ver `field/v1/notifications/route.ts`. */
export const dynamic = "force-dynamic";

const VIEW_PROFILES = [AccessProfile.ADMIN, AccessProfile.DISPATCHER];
const MANAGE_PROFILES = [AccessProfile.ADMIN];

const itemSchema = z
  .object({
    label: z.string().min(1).max(200),
    description: z.string().max(500).optional().nullable(),
    type: z.enum(["BOOLEAN", "TEXT", "NUMBER", "SELECT", "PHOTO"]),
    required: z.boolean(),
    options: z.array(z.string().min(1).max(120)).max(20).optional().nullable(),
    // Mesma lista da política de conclusão, pelo mesmo motivo: a etiqueta do
    // equipamento não é foto que o técnico tira quando decide.
    evidenceCategory: z
      .enum(POLICY_EVIDENCE_CATEGORIES)
      .optional()
      .nullable(),
  })
  .strict();

const putSchema = z
  .object({
    /** `null` = template padrão da empresa, para tipos sem o seu (e para OS importada). */
    serviceOrderTypeId: z.string().min(1).max(50).nullable(),
    name: z.string().min(1).max(120),
    items: z.array(itemSchema).min(1).max(60),
  })
  .strict();

export async function GET(request: Request) {
  return runApi(async () => {
    const session = await getSessionUser(request);
    if (!session) return jsonError("Não autenticado.", 401);
    const denied = assertProfile(session.profile, VIEW_PROFILES);
    if (denied) return denied;

    // A leitura mora no domínio: a tela de configuração e esta rota precisam da
    // MESMA resposta, e duas consultas seriam duas verdades a divergir.
    const templates = await listCompanyChecklistTemplates(session.companyId);

    return jsonOk({ templates });
  });
}

export async function PUT(request: Request) {
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

    const parsed = putSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    const result = await putChecklistTemplate(session.companyId, session.id, {
      serviceOrderTypeId: parsed.data.serviceOrderTypeId,
      name: parsed.data.name,
      items: parsed.data.items.map((item) => ({
        label: item.label,
        description: item.description ?? null,
        type: item.type,
        required: item.required,
        options: item.options ?? null,
        evidenceCategory: item.evidenceCategory ?? null,
      })),
    });

    return jsonOk({ template: result });
  });
}

const patchSchema = z
  .object({
    templateId: z.string().min(1).max(50),
    active: z.boolean(),
  })
  .strict();

/**
 * Liga e desliga um checklist sem apagá-lo.
 *
 * `PUT` sempre reativa — salvar é declarar que aquele checklist vale. Sem este
 * caminho, desligar um checklist exigiria apagar os itens, e religar exigiria
 * digitá-los de novo. O `PATCH` existe para essa operação e para nada mais: não
 * renomeia, não mexe em item, não toca política de conclusão.
 */
export async function PATCH(request: Request) {
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

    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    const result = await setChecklistTemplateActive(
      session.companyId,
      session.id,
      parsed.data.templateId,
      parsed.data.active,
    );

    return jsonOk({ template: result });
  });
}

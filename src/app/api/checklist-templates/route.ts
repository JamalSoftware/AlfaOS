import { AccessProfile } from "@prisma/client";
import { z } from "zod";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import { putChecklistTemplate } from "@/lib/checklists";
import { prisma } from "@/lib/prisma";

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
const VIEW_PROFILES = [AccessProfile.ADMIN, AccessProfile.DISPATCHER];
const MANAGE_PROFILES = [AccessProfile.ADMIN];

const itemSchema = z
  .object({
    label: z.string().min(1).max(200),
    description: z.string().max(500).optional().nullable(),
    type: z.enum(["BOOLEAN", "TEXT", "NUMBER", "SELECT", "PHOTO"]),
    required: z.boolean(),
    options: z.array(z.string().min(1).max(120)).max(20).optional().nullable(),
    evidenceCategory: z
      .enum([
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
      ])
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

    const templates = await prisma.checklistTemplate.findMany({
      where: { companyId: session.companyId },
      include: {
        items: { where: { active: true }, orderBy: { sortOrder: "asc" } },
      },
      orderBy: { createdAt: "asc" },
    });

    return jsonOk({
      templates: templates.map((template) => ({
        id: template.id,
        serviceOrderTypeId: template.serviceOrderTypeId,
        name: template.name,
        version: template.version,
        active: template.active,
        items: template.items.map((item) => ({
          id: item.id,
          label: item.label,
          description: item.description,
          type: item.type,
          required: item.required,
          sortOrder: item.sortOrder,
          options: item.options,
          evidenceCategory: item.evidenceCategory,
        })),
      })),
    });
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

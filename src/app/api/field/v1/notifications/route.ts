import { z } from "zod";
import {
  listNotifications,
  markNotificationsRead,
  NOTIFICATION_MAX_PAGE_SIZE,
} from "@/lib/notifications";
import { fieldOk, runFieldApi } from "@/lib/field/response";
import { readFieldBody, requireFieldPrincipal } from "@/lib/field/route";

/**
 * Rota autenticada por Bearer: nunca estática.
 *
 * O Next já a marcaria como dinâmica ao ver a leitura de `headers`, mas por
 * exceção — que o envelope de erro do Field captura e registra como falha no
 * build. Declarar a intenção evita o ruído e, mais importante, não deixa o
 * comportamento de uma rota que carrega dado de cliente depender de inferência.
 */
export const dynamic = "force-dynamic";

/**
 * `GET  /api/field/v1/notifications`  — central do técnico
 * `POST /api/field/v1/notifications`  — marcar como lida
 *
 * **A central é o registro; o push é apenas o aviso** (PRD §154). Esta rota é
 * o que garante que uma atribuição não se perca quando o push falha — e ele
 * falha: token expirado, aparelho desligado, permissão negada, provider que
 * descarta sem avisar.
 *
 * `companyId` e `userId` vêm do token e entram no `where` em SQL. Não existe
 * parâmetro que peça a caixa de outro técnico.
 */

function parseCursor(raw: string | null): string | null {
  if (!raw) return null;
  return /^[A-Za-z0-9_-]{10,64}$/.test(raw) ? raw : null;
}

function parseLimit(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return Math.min(n, NOTIFICATION_MAX_PAGE_SIZE);
}

export async function GET(request: Request) {
  return runFieldApi(async () => {
    const principal = await requireFieldPrincipal(request);
    const url = new URL(request.url);

    const page = await listNotifications(
      principal.user.companyId,
      principal.user.id,
      {
        cursor: parseCursor(url.searchParams.get("cursor")),
        limit: parseLimit(url.searchParams.get("limit")),
      },
    );

    return fieldOk(page);
  });
}

const readSchema = z
  .object({
    /**
     * Quais marcar. Ausente ou vazio marca **todas as não lidas** — é o
     * "marcar todas como lidas" da tela.
     *
     * Um id que não é do técnico simplesmente não casa nenhuma linha: o filtro
     * de dono está no `updateMany`, não numa leitura prévia que serviria de
     * sonda de existência.
     */
    ids: z.array(z.string().min(1)).max(200).optional(),
  })
  .strict();

/**
 * Marcar como lida é naturalmente idempotente e por isso **não** exige
 * `Idempotency-Key`.
 *
 * O predicado inclui `readAt: null`, então repetir não mexe no carimbo
 * original e não produz efeito segundo. Exigir a chave aqui seria burocracia
 * sem proteção — e uma chave a mais para o aplicativo administrar na fila
 * local, para uma operação que nunca duplica nada.
 */
export async function POST(request: Request) {
  return runFieldApi(async () => {
    const principal = await requireFieldPrincipal(request);
    const body = await readFieldBody(request, readSchema);

    const updated = await markNotificationsRead(
      principal.user.companyId,
      principal.user.id,
      body.ids,
    );

    return fieldOk({ updated });
  });
}

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { authenticateField, touchDevice, type FieldPrincipal } from "./auth";
import { FieldError } from "./errors";

/**
 * Autentica e devolve o principal, atualizando a presença do aparelho.
 *
 * Um único ponto de entrada para toda rota do Field: se amanhã a autenticação
 * ganhar uma checagem (versão mínima do app, bloqueio de versão insegura), ela
 * entra aqui e vale para todas — em vez de depender de onze handlers lembrarem.
 *
 * `touchDevice` é telemetria e por isso NÃO é aguardado como pré-requisito da
 * requisição: ele engole o próprio erro. Uma falha ao gravar "visto por último"
 * não pode negar acesso a quem já provou quem é.
 */
export async function requireFieldPrincipal(
  request: Request,
): Promise<FieldPrincipal> {
  const principal = await authenticateField(request);
  const device = await prisma.mobileDevice.findUnique({
    where: { id: principal.device.id },
    select: { lastSeenAt: true },
  });
  await touchDevice(principal.device.id, device?.lastSeenAt ?? null);
  return principal;
}

/**
 * Lê e valida o corpo JSON.
 *
 * Todo schema do Field é `.strict()`: campo desconhecido é **recusado**, não
 * descartado em silêncio. A diferença importa — um app que envia `companyId`
 * ou `technicianId` está tentando decidir autorização pelo corpo, e precisa
 * ouvir um "não" em vez de achar que funcionou.
 */
export async function readFieldBody<T extends z.ZodTypeAny>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new FieldError("VALIDATION_ERROR", "Corpo da requisição inválido.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new FieldError("VALIDATION_ERROR", "Dados inválidos.");
  }
  return parsed.data;
}

/**
 * `version` que o aparelho leu, para o compare-and-set.
 *
 * Inteiro não negativo e obrigatório: o Field nasce com o lock fim-a-fim, e não
 * há chamador legado para preservar. Sem ela não existe como distinguir
 * "iniciar a OS que eu vi" de "iniciar seja lá o que a OS for agora" — e
 * offline essa distinção é a diferença entre trabalho registrado e decisão da
 * operação apagada (PRD §161).
 */
export const fieldExpectedVersion = z
  .number()
  .int("Versão inválida.")
  .min(0, "Versão inválida.");

/**
 * Correlacionador da fila local do aplicativo.
 *
 * Opcional e sem efeito no servidor além de voltar na resposta: serve para o
 * Flutter casar o desfecho com a operação da própria fila (`localOperationId`,
 * PRD §159) mesmo quando a resposta chega numa execução seguinte do app. A
 * desduplicação de verdade é a `Idempotency-Key`.
 */
export const clientMutationId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/, "clientMutationId inválido.")
  .optional();

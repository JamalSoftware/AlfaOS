import { z } from "zod";
import { fieldCommand } from "@/lib/field/command";
import { clientMutationId } from "@/lib/field/route";
import { punchTimeClock } from "@/lib/time-clock";

/**
 * `POST /api/field/v1/time-clock/entries`
 *
 * Registra uma marcação de ponto.
 *
 * ## O horário NÃO vem daqui
 *
 * O schema aceita `deviceOccurredAt`, e ele é **metadata**. O horário que vale
 * é carimbado pelo servidor (PRD §227): o relógio do telefone é ajustável pelo
 * próprio usuário em dois toques, e uma jornada que aceitasse o horário
 * informado pelo aparelho registraria o que a pessoa digitou.
 *
 * Guardar o carimbo do aparelho é útil exatamente por ele divergir — a
 * diferença entre os dois é sinal de auditoria.
 *
 * ## O que o corpo NÃO tem
 *
 * Nem `userId`, nem `companyId`, nem `technicianId`. Os três saem do principal
 * resolvido pelo token. O schema é `.strict()`, então mandá-los é recusado em
 * vez de descartado em silêncio: um app que tenta decidir identidade pelo corpo
 * precisa ouvir um "não".
 *
 * ## Idempotência
 *
 * `Idempotency-Key` obrigatória, criada pelo aplicativo **no toque** e não no
 * envio (§232). Duplo toque e retentativa de rede produzem UMA marcação lógica;
 * mesma chave com corpo diferente é `IDEMPOTENCY_CONFLICT`.
 *
 * Coordenada é opcional e **não bloqueia** (§228).
 */
const schema = z
  .object({
    type: z.enum(["CLOCK_IN", "BREAK_START", "BREAK_END", "CLOCK_OUT"]),
    /** Carimbo do aparelho. Metadata — nunca vira o horário oficial. */
    deviceOccurredAt: z.string().datetime().optional().nullable(),
    latitude: z.number().optional().nullable(),
    longitude: z.number().optional().nullable(),
    accuracyMeters: z.number().optional().nullable(),
    clientMutationId,
  })
  .strict();

export const POST = fieldCommand(
  "time-clock.punch",
  schema,
  async ({ principal, body }) => {
    const result = await punchTimeClock(
      principal.user.companyId,
      principal.user.id,
      {
        type: body.type,
        deviceOccurredAt: body.deviceOccurredAt
          ? new Date(body.deviceOccurredAt)
          : null,
        latitude: body.latitude ?? null,
        longitude: body.longitude ?? null,
        accuracyMeters: body.accuracyMeters ?? null,
        // Aparelho e técnico vêm do TOKEN. Nunca do corpo.
        mobileDeviceId: principal.device.id,
        technicianId: principal.technician.id,
        source: "FIELD_APP",
      },
    );

    return {
      status: 201,
      resourceId: result.entry.id,
      body: {
        entry: {
          id: result.entry.id,
          type: result.entry.type,
          /** O horário OFICIAL. O aplicativo apresenta este, não o do aparelho. */
          occurredAt: result.entry.occurredAt.toISOString(),
          source: result.entry.source,
        },
        /*
          O dia já atualizado, SEM a lista de marcações — quem quiser a lista
          relê `today`.

          O FUSO vai junto, e isso não é enfeite. Esta resposta é a OUTRA fonte
          de `Workday` do aplicativo: o controlador grava o que volta daqui e só
          depois relê `today`. Quando a releitura falha — a rede caiu logo
          depois da batida, que é o caso comum em campo —, o estado FICA com o
          que veio desta resposta, até a próxima leitura que der certo.

          Sem `utcOffset` aqui, essa janela devolvia o aplicativo ao relógio do
          aparelho: horário exibido no fuso errado e, pior, correção montada no
          fuso errado — exatamente o defeito que a §253 (LOW-3) fechou.
        */
        workday: {
          date: result.workday.date,
          timezone: result.workday.timezone,
          utcOffset: result.workday.utcOffset,
          state: result.workday.state,
          allowedActions: result.workday.allowedActions,
          workedMinutes: result.workday.workedMinutes,
          breakMinutes: result.workday.breakMinutes,
        },
      },
    };
  },
);

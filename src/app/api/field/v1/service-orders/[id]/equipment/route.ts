import { z } from "zod";
import { fieldOrderCommand } from "@/lib/field/command";
import { clientMutationId, fieldExpectedVersion } from "@/lib/field/route";
import { addServiceOrderEquipment } from "@/lib/service-order-equipment";

/**
 * `POST /api/field/v1/service-orders/:id/equipment`
 *
 * Registra um equipamento instalado no cliente.
 *
 * Serial e MAC podem chegar de scanner ou do teclado — o servidor valida o
 * mesmo nos dois casos. A leitura de QR/código de barras é conveniência de
 * digitação (PRD §180) e não é prova de nada: um código lido continua sendo
 * texto enviado pelo cliente.
 *
 * A duplicidade é decidida pela unique do banco, por empresa. Digitar o serial
 * de uma ONU agachado dentro de um armário é a origem mais comum de equipamento
 * vinculado ao cliente errado, e o sintoma é o mesmo serial em dois clientes.
 */
const schema = z
  .object({
    expectedVersion: fieldExpectedVersion,
    equipmentType: z.string().min(1).max(60),
    manufacturer: z.string().max(120).optional().nullable(),
    model: z.string().max(120).optional().nullable(),
    serial: z.string().max(120).optional().nullable(),
    macAddress: z.string().max(120).optional().nullable(),
    notes: z.string().max(500).optional().nullable(),
    /**
     * Foto da etiqueta. **Obrigatória** desde a v0.10.1.
     *
     * Um APK anterior não manda este campo e recebe VALIDATION_ERROR — que é o
     * desfecho correto: ele registraria equipamento sem identificação nenhuma,
     * já que série e MAC deixaram de ser exigidos junto com esta mudança.
     */
    labelEvidenceId: z.string().min(1).max(60),
    clientMutationId,
  })
  .strict();

export const POST = fieldOrderCommand(
  "service-order.equipment.add",
  schema,
  async ({ principal, body, orderId }) => {
    const equipment = await addServiceOrderEquipment(
      principal.user.companyId,
      principal.user.id,
      orderId,
      {
        expectedOrderVersion: body.expectedVersion,
        equipmentType: body.equipmentType,
        manufacturer: body.manufacturer ?? null,
        model: body.model ?? null,
        serial: body.serial ?? null,
        macAddress: body.macAddress ?? null,
        notes: body.notes ?? null,
        labelEvidenceId: body.labelEvidenceId,
      },
    );

    return {
      status: 201,
      resourceId: equipment.id,
      body: {
        equipment: {
          id: equipment.id,
          equipmentType: equipment.equipmentType,
          manufacturer: equipment.manufacturer,
          model: equipment.model,
          serial: equipment.serial,
          macAddress: equipment.macAddress,
          notes: equipment.notes,
          labelEvidenceId: equipment.labelEvidenceId,
        },
      },
    };
  },
);

import type {
  CustomerLocationSource,
  LocationChangeKind,
  LocationChangeReason,
  Prisma,
} from "@prisma/client";
import { prisma } from "./prisma";
import { logAudit } from "./audit";
import { badRequest, conflict, isUniqueConstraintError, notFound } from "./errors";
import {
  assertValidAccuracy,
  assertValidCoordinate,
  distanceInMeters,
  type Coordinate,
} from "./geo";
import { coordenadaValida } from "./map-links";
import {
  loadOwnedServiceOrder,
  resolveActingTechnician,
  type ExecutionTx,
} from "./service-orders";

/**
 * # Localização do cliente — procedência, confirmação e precedência
 *
 * A localização pertence ao CLIENTE, não à OS (PRD §134): o ponto físico é o
 * mesmo em todos os atendimentos, e guardá-lo na OS o duplicaria a cada visita,
 * com as cópias divergindo assim que alguém corrigisse uma delas.
 *
 * ## Os dois eixos
 *
 * `source` diz DE ONDE o número veio; `verified` diz se ALGUÉM ESTEVE LÁ. São
 * perguntas diferentes e por isso são colunas diferentes. Uma coordenada
 * `GEOCODED` confirmada por um técnico no local continua `GEOCODED` de origem e
 * passa a valer mais que uma `IMPORTED` recém-chegada.
 *
 * ## A regra que este arquivo existe para proteger
 *
 * > Dado de menor confiança NÃO sobrescreve silenciosamente dado já confirmado
 * > (PRD §197).
 *
 * O caso concreto: o técnico corrige o ponto em campo e, três dias depois, uma
 * releitura do ERP traz a coordenada velha do cadastro. Sem precedência, a
 * sincronização desfaz o trabalho de campo — em silêncio, sem ninguém decidir
 * nada, e justamente no cliente em que alguém se deu ao trabalho de conferir.
 */

// ---------------------------------------------------------------------------
// Precedência
// ---------------------------------------------------------------------------

/**
 * Força relativa de uma coordenada.
 *
 * A escada é a da §197, e `verified` DOMINA o eixo `source` — por isso ele
 * entra como um degrau inteiro acima de qualquer origem, e não como um
 * desempate:
 *
 * ```text
 * verified = true                    ← ninguém sobrescreve automaticamente
 *   ↑
 * TECHNICIAN_GPS (não verificada)    ← capturada no local, sem confirmação
 * MANUAL         (não verificada)    ← alguém digitou; houve decisão humana
 * IMPORTED       (do provedor)
 * GEOCODED       (derivada do endereço) ← a mais fraca: ninguém olhou o lugar
 * ```
 *
 * `TECHNICIAN_GPS` acima de `MANUAL` é a única posição que a §197 não fixa
 * explicitamente (ela nomeia as outras três). Fica acima porque é captura no
 * local, e não digitação remota. A escolha só tem efeito entre duas origens não
 * verificadas — nenhuma das duas é alcançável por importação, que entra sempre
 * como `IMPORTED`.
 */
export function locationPrecedenceRank(
  source: CustomerLocationSource,
  verified: boolean,
): number {
  const bySource: Record<CustomerLocationSource, number> = {
    TECHNICIAN_GPS: 40,
    MANUAL: 30,
    IMPORTED: 20,
    GEOCODED: 10,
  };
  // +100, e não +1: garante que QUALQUER origem verificada vença QUALQUER
  // origem não verificada, que é literalmente o que "verified domina source"
  // significa. Um bônus pequeno deixaria `TECHNICIAN_GPS` não verificada
  // empatar com `GEOCODED` verificada assim que alguém acrescentasse origens.
  return bySource[source] + (verified ? 100 : 0);
}

/**
 * Uma escrita AUTOMÁTICA pode substituir o que já existe?
 *
 * Automática = sincronização, importação, geocodificação. Ou seja: ninguém
 * decidiu isso agora. Ação humana explícita não passa por aqui — ela é sempre
 * permitida e sempre registrada (§197).
 */
export function automaticWriteWins(
  incoming: { source: CustomerLocationSource; verified: boolean },
  current: { source: CustomerLocationSource; verified: boolean } | null,
): boolean {
  if (!current) return true;
  // Explícito, embora já implicado pelo rank: importação NUNCA rebaixa
  // `verified`, e nunca substitui coordenada verificada.
  if (current.verified) return false;
  return (
    locationPrecedenceRank(incoming.source, incoming.verified) >
    locationPrecedenceRank(current.source, current.verified)
  );
}

// ---------------------------------------------------------------------------
// Endereço
// ---------------------------------------------------------------------------

export const ADDRESS_FIELDS = [
  "address",
  "number",
  "complement",
  "district",
  "city",
  "state",
  "zipCode",
] as const;

export type AddressField = (typeof ADDRESS_FIELDS)[number];
export type AddressInput = Partial<Record<AddressField, string | null>>;
export type AddressSnapshot = Record<AddressField, string | null>;

/** Limites por campo. Endereço é endereço, não caixa de texto. */
const ADDRESS_MAX: Record<AddressField, number> = {
  address: 200,
  number: 20,
  complement: 120,
  district: 120,
  city: 120,
  state: 2,
  zipCode: 12,
};

/**
 * Normaliza um campo de endereço vindo do cliente.
 *
 * Ausência vira `null` — NUNCA a string `"null"` ou `"undefined"`, que é o
 * defeito clássico de um formulário que interpolou um valor ausente antes de
 * enviar. Uma vez gravado, esse texto vira o endereço do cliente e aparece na
 * etiqueta, no mapa e na ordem de serviço.
 */
export function normalizeAddressValue(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const lowered = trimmed.toLowerCase();
  if (lowered === "null" || lowered === "undefined") return null;
  return trimmed.slice(0, max);
}

export function addressSnapshotOf(source: AddressInput): AddressSnapshot {
  const snapshot = {} as AddressSnapshot;
  for (const field of ADDRESS_FIELDS) {
    snapshot[field] = normalizeAddressValue(source[field], ADDRESS_MAX[field]);
  }
  return snapshot;
}

function addressChanged(before: AddressSnapshot, after: AddressSnapshot): boolean {
  return ADDRESS_FIELDS.some((field) => before[field] !== after[field]);
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

export type LocationStatus = "CONFIRMED" | "UNCONFIRMED" | "MISSING";

export interface PublicCustomerLocation {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  source: CustomerLocationSource;
  verified: boolean;
  verifiedAt: Date | null;
  reference: string | null;
  version: number;
}

export interface CustomerLocationView {
  status: LocationStatus;
  location: PublicCustomerLocation | null;
}

function toNumber(value: unknown): number {
  return Number(value);
}

function toPublicLocation(row: {
  latitude: Prisma.Decimal;
  longitude: Prisma.Decimal;
  accuracyMeters: number | null;
  source: CustomerLocationSource;
  verified: boolean;
  verifiedAt: Date | null;
  reference: string | null;
  version: number;
}): PublicCustomerLocation {
  return {
    latitude: toNumber(row.latitude),
    longitude: toNumber(row.longitude),
    accuracyMeters: row.accuracyMeters,
    source: row.source,
    verified: row.verified,
    verifiedAt: row.verifiedAt,
    reference: row.reference,
    version: row.version,
  };
}

/**
 * A localização do cliente, com o status que a tela do técnico mostra.
 *
 * Três estados, e eles não são o mesmo: `MISSING` é "não sabemos onde é",
 * `UNCONFIRMED` é "temos um palpite que ninguém conferiu" e `CONFIRMED` é
 * "alguém esteve lá". Colapsar os dois primeiros faria o técnico tratar um
 * ponto geocodificado como endereço conhecido.
 */
export async function getCustomerLocationView(
  companyId: string,
  customerId: string,
): Promise<CustomerLocationView> {
  const row = await prisma.customerLocation.findFirst({
    where: { customerId, companyId },
  });
  if (!row) return { status: "MISSING", location: null };
  return {
    status: row.verified ? "CONFIRMED" : "UNCONFIRMED",
    location: toPublicLocation(row),
  };
}

// ---------------------------------------------------------------------------
// Escrita — infraestrutura comum
// ---------------------------------------------------------------------------

/**
 * Mantém `Customer.latitude/longitude/locationSource/locationVerified` em
 * sincronia com a entidade.
 *
 * As colunas de `Customer` continuam sendo a PROJEÇÃO de leitura: a listagem da
 * web, o DTO do Field e `linksDeNavegacao` já as consomem, e removê-las seria
 * migration destrutiva. A autoridade é `CustomerLocation` — esta função existe
 * para que as duas nunca discordem, e é chamada em TODA escrita, dentro da
 * mesma transação.
 *
 * Deixar a projeção fora da transação criaria exatamente o defeito que a
 * entidade veio resolver: um mapa mostrando o ponto antigo porque a segunda
 * escrita falhou.
 */
async function syncLocationProjection(
  tx: ExecutionTx,
  companyId: string,
  customerId: string,
  location: {
    latitude: Prisma.Decimal | number;
    longitude: Prisma.Decimal | number;
    source: CustomerLocationSource;
    verified: boolean;
  },
): Promise<void> {
  await tx.customer.updateMany({
    where: { id: customerId, companyId },
    data: {
      latitude: location.latitude,
      longitude: location.longitude,
      locationSource: location.source,
      locationVerified: location.verified,
    },
  });
}

interface HistoryInput {
  companyId: string;
  customerId: string;
  serviceOrderId?: string | null;
  kind: LocationChangeKind;
  reason: LocationChangeReason;
  note?: string | null;
  previous?: {
    latitude: Prisma.Decimal | null;
    longitude: Prisma.Decimal | null;
    source: CustomerLocationSource | null;
    verified: boolean | null;
  } | null;
  next?: {
    latitude: number | null;
    longitude: number | null;
    source: CustomerLocationSource | null;
    verified: boolean | null;
  } | null;
  previousAddress?: AddressSnapshot | null;
  newAddress?: AddressSnapshot | null;
  changedByUserId?: string | null;
  technicianId?: string | null;
}

/**
 * Grava a linha imutável de histórico, na MESMA transação da mudança.
 *
 * Fora da transação, uma falha aqui produziria uma alteração sem trilha — que é
 * o estado que o histórico existe para tornar impossível.
 */
async function writeLocationHistory(
  tx: ExecutionTx,
  input: HistoryInput,
): Promise<void> {
  await tx.customerLocationHistory.create({
    data: {
      companyId: input.companyId,
      customerId: input.customerId,
      serviceOrderId: input.serviceOrderId ?? null,
      kind: input.kind,
      reason: input.reason,
      note: input.note ?? null,
      previousLatitude: input.previous?.latitude ?? null,
      previousLongitude: input.previous?.longitude ?? null,
      previousSource: input.previous?.source ?? null,
      previousVerified: input.previous?.verified ?? null,
      newLatitude: input.next?.latitude ?? null,
      newLongitude: input.next?.longitude ?? null,
      newSource: input.next?.source ?? null,
      newVerified: input.next?.verified ?? null,
      previousAddress: (input.previousAddress ?? undefined) as
        | Prisma.InputJsonValue
        | undefined,
      newAddress: (input.newAddress ?? undefined) as
        | Prisma.InputJsonValue
        | undefined,
      changedByUserId: input.changedByUserId ?? null,
      technicianId: input.technicianId ?? null,
    },
  });
}

/**
 * Prova que o técnico pode mexer no cadastro DESTE cliente, e devolve o
 * contexto.
 *
 * A autorização não é "é técnico" — é "tem uma OS em andamento, atribuída a
 * ele, para este cliente". É o que impede o ataque da §60: o técnico A usar uma
 * OS sua para corrigir o cliente da OS de B. O `customerId` NUNCA vem do corpo
 * da requisição; ele é derivado da OS.
 */
async function requireFieldCustomerContext(
  tx: ExecutionTx,
  companyId: string,
  actorUserId: string,
  orderId: string,
) {
  const technician = await resolveActingTechnician(tx, companyId, actorUserId);
  const order = await loadOwnedServiceOrder(tx, companyId, technician.id, orderId);
  if (order.status !== "IN_PROGRESS") {
    throw conflict(
      order.status === "COMPLETED"
        ? "Esta OS já foi concluída e não pode mais ser alterada."
        : "Só é possível alterar o cadastro durante um atendimento em andamento.",
    );
  }
  return { technician, order };
}

/**
 * Compare-and-set sobre a localização.
 *
 * `expectedVersion === null` significa "eu vi que NÃO existe localização" — e é
 * o CAS da criação. Sem esse caso explícito, dois aparelhos criando o ponto ao
 * mesmo tempo dependeriam só da unique, e o perdedor receberia um erro de banco
 * em vez de um conflito legível.
 */
function assertLocationVersion(
  current: { version: number } | null,
  expectedVersion: number | null,
): void {
  if (!current) {
    if (expectedVersion !== null) {
      throw conflict(
        "A localização do cliente mudou. Recarregue e tente novamente.",
      );
    }
    return;
  }
  if (expectedVersion !== current.version) {
    throw conflict(
      "A localização do cliente mudou. Recarregue e tente novamente.",
    );
  }
}

function assertReasonNote(
  reason: LocationChangeReason,
  note: string | null,
): string | null {
  const trimmed = note?.trim() ?? null;
  if (reason === "OTHER" && !trimmed) {
    // Sem isto, `OTHER` viraria o motivo padrão de quem tem pressa e o enum
    // inteiro deixaria de informar qualquer coisa.
    throw badRequest("Descreva o motivo da correção.");
  }
  return trimmed ? trimmed.slice(0, 500) : null;
}

// ---------------------------------------------------------------------------
// Confirmação
// ---------------------------------------------------------------------------

export interface ConfirmLocationInput {
  expectedVersion: number;
  /** Onde o aparelho diz que o técnico está. Registrado, nunca gravado como o ponto. */
  observedLatitude?: number | null;
  observedLongitude?: number | null;
  observedAccuracyMeters?: number | null;
}

export interface ConfirmLocationResult {
  location: PublicCustomerLocation;
  /** Distância entre o técnico e o ponto confirmado, quando ambos existem. */
  distanceMeters: number | null;
}

/**
 * Marca a localização já cadastrada como CONFIRMADA em campo.
 *
 * Confirmar não move o ponto: ele continua onde estava, com a `source` que
 * tinha, e passa a valer `verified = true`. Mover é `correctCustomerLocation`,
 * que é outra ação, com motivo obrigatório.
 *
 * ## O GPS entra como observação, não como o ponto
 *
 * A coordenada do aparelho é gravada apenas no histórico, junto da distância
 * calculada no servidor. Ela documenta DE ONDE a pessoa confirmou — não vira a
 * localização do cliente. Se o técnico está a 200 m e mesmo assim confirma, o
 * registro guarda os 200 m, e é a operação que decide o que fazer com isso.
 *
 * ## Por que não existe confirmação automática
 *
 * `verified` só é escrito aqui e na correção — os dois caminhos com ação humana
 * explícita. O aparelho reporta onde ELE está, não que o técnico conferiu que
 * aquele é o ponto de instalação (PRD §172). Derivar `verified` da chegada
 * produziria uma base inteira de coordenadas "verificadas" com a precisão do
 * GPS do momento.
 */
export async function confirmCustomerLocation(
  companyId: string,
  actorUserId: string,
  orderId: string,
  input: ConfirmLocationInput,
): Promise<ConfirmLocationResult> {
  const observedAccuracy = assertValidAccuracy(input.observedAccuracyMeters);
  let observed: Coordinate | null = null;
  if (
    input.observedLatitude !== null &&
    input.observedLatitude !== undefined &&
    input.observedLongitude !== null &&
    input.observedLongitude !== undefined
  ) {
    observed = assertValidCoordinate(
      input.observedLatitude,
      input.observedLongitude,
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    const { technician, order } = await requireFieldCustomerContext(
      tx,
      companyId,
      actorUserId,
      orderId,
    );

    const current = await tx.customerLocation.findFirst({
      where: { customerId: order.customerId, companyId },
    });
    if (!current) {
      // Não há o que confirmar. A saída correta é CORRIGIR, que cria o ponto.
      throw notFound(
        "Este cliente não tem localização cadastrada. Use a correção para registrá-la.",
      );
    }
    assertLocationVersion(current, input.expectedVersion);

    if (current.verified) {
      throw conflict("A localização deste cliente já está confirmada.");
    }

    const claimed = await tx.customerLocation.updateMany({
      where: { id: current.id, companyId, version: input.expectedVersion },
      data: {
        verified: true,
        verifiedAt: new Date(),
        verifiedByUserId: actorUserId,
        verifiedByTechnicianId: technician.id,
        version: { increment: 1 },
      },
    });
    if (claimed.count !== 1) {
      throw conflict(
        "A localização do cliente mudou. Recarregue e tente novamente.",
      );
    }

    const distanceMeters = observed
      ? distanceInMeters(observed, {
          latitude: toNumber(current.latitude),
          longitude: toNumber(current.longitude),
        })
      : null;

    await writeLocationHistory(tx, {
      companyId,
      customerId: order.customerId,
      serviceOrderId: order.id,
      kind: "COORDINATES",
      // Confirmar não é corrigir um erro: o cadastro estava certo e agora está
      // conferido. `INCORRECT_LOCATION` mentiria sobre o que aconteceu.
      reason: "OTHER",
      note: observed
        ? `Localização confirmada em campo a ${distanceMeters} m do ponto cadastrado${
            observedAccuracy !== null ? ` (precisão ${observedAccuracy} m)` : ""
          }.`
        : "Localização confirmada em campo, sem coordenada do aparelho.",
      previous: {
        latitude: current.latitude,
        longitude: current.longitude,
        source: current.source,
        verified: current.verified,
      },
      next: {
        latitude: toNumber(current.latitude),
        longitude: toNumber(current.longitude),
        source: current.source,
        verified: true,
      },
      changedByUserId: actorUserId,
      technicianId: technician.id,
    });

    await syncLocationProjection(tx, companyId, order.customerId, {
      latitude: current.latitude,
      longitude: current.longitude,
      source: current.source,
      verified: true,
    });

    await tx.serviceOrderEvent.create({
      data: {
        companyId,
        serviceOrderId: order.id,
        userId: actorUserId,
        event: "LOCATION_CONFIRMED",
        metadata: {
          technicianId: technician.id,
          distanceMeters,
          accuracyMeters: observedAccuracy,
          source: current.source,
        },
      },
    });

    const updated = await tx.customerLocation.findUniqueOrThrow({
      where: { id: current.id },
    });
    return { location: toPublicLocation(updated), distanceMeters };
  });

  await logAudit({
    companyId,
    userId: actorUserId,
    action: "CUSTOMER_LOCATION.CONFIRMED",
    entity: "CustomerLocation",
    entityId: orderId,
    details: `Localização confirmada em campo${
      result.distanceMeters !== null
        ? ` a ${result.distanceMeters} m do ponto cadastrado`
        : ""
    }`,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Correção
// ---------------------------------------------------------------------------

export interface CorrectLocationInput {
  /** `null` quando o cliente ainda não tem localização. */
  expectedVersion: number | null;
  reason: LocationChangeReason;
  note?: string | null;
  /** Nova coordenada. Ausente = correção apenas de endereço. */
  latitude?: number | null;
  longitude?: number | null;
  accuracyMeters?: number | null;
  /**
   * Só `TECHNICIAN_GPS` ou `MANUAL` chegam do Field: o técnico ou usou a
   * posição do aparelho, ou digitou. `IMPORTED` e `GEOCODED` são origens de
   * processo automático e não podem ser alegadas por um cliente.
   */
  source?: Extract<CustomerLocationSource, "TECHNICIAN_GPS" | "MANUAL">;
  reference?: string | null;
  /** Campos de endereço a corrigir. Ausentes ficam como estão. */
  address?: AddressInput;
}

export interface CorrectLocationResult {
  location: PublicCustomerLocation | null;
  address: AddressSnapshot;
  kind: LocationChangeKind;
}

/**
 * Corrige endereço e/ou coordenada, com motivo obrigatório e trilha.
 *
 * ## Correção é decisão humana explícita
 *
 * Por isso ela pode substituir qualquer coisa — inclusive uma localização já
 * verificada (§197: "o técnico corrigir qualquer uma, em campo,
 * explicitamente"). O que a precedência bloqueia é a escrita AUTOMÁTICA, que
 * não passa por esta função.
 *
 * ## Coordenada corrigida entra como verificada
 *
 * Quem move o ponto está declarando "é aqui", no local, agora. Isso é a
 * confirmação — não há um segundo passo a exigir. O que a §172 proíbe é
 * derivar `verified` de um GPS que o aparelho mandou sozinho; aqui houve uma
 * pessoa apertando um botão que diz o que vai acontecer.
 *
 * Correção SOMENTE de endereço não toca `verified`: o texto estar errado não
 * diz nada sobre o ponto no mapa.
 */
export async function correctCustomerLocation(
  companyId: string,
  actorUserId: string,
  orderId: string,
  input: CorrectLocationInput,
): Promise<CorrectLocationResult> {
  const note = assertReasonNote(input.reason, input.note ?? null);

  const hasCoordinate =
    input.latitude !== null &&
    input.latitude !== undefined &&
    input.longitude !== null &&
    input.longitude !== undefined;

  let coordinate: Coordinate | null = null;
  let accuracy: number | null = null;
  if (hasCoordinate) {
    coordinate = assertValidCoordinate(input.latitude, input.longitude);
    accuracy = assertValidAccuracy(input.accuracyMeters);
  }

  const hasAddress =
    input.address !== undefined && Object.keys(input.address).length > 0;

  if (!hasCoordinate && !hasAddress) {
    throw badRequest("Informe o endereço ou a coordenada a corrigir.");
  }

  const reference =
    typeof input.reference === "string"
      ? input.reference.trim().slice(0, 300) || null
      : null;

  const result = await prisma.$transaction(async (tx) => {
    const { technician, order } = await requireFieldCustomerContext(
      tx,
      companyId,
      actorUserId,
      orderId,
    );

    const customer = await tx.customer.findFirst({
      where: { id: order.customerId, companyId },
    });
    if (!customer) {
      throw notFound("Cliente não encontrado.");
    }

    const current = await tx.customerLocation.findFirst({
      where: { customerId: order.customerId, companyId },
    });
    assertLocationVersion(current, input.expectedVersion);

    // --- endereço -------------------------------------------------------
    const previousAddress = addressSnapshotOf(customer);
    const nextAddress: AddressSnapshot = { ...previousAddress };
    if (hasAddress) {
      const patch = addressSnapshotOf(input.address ?? {});
      for (const field of ADDRESS_FIELDS) {
        // Só os campos ENVIADOS mudam. Um corpo parcial não pode apagar o
        // resto do endereço por omissão.
        if (field in (input.address ?? {})) {
          nextAddress[field] = patch[field];
        }
      }
    }
    const addressDidChange = hasAddress && addressChanged(previousAddress, nextAddress);

    // --- coordenada -----------------------------------------------------
    let savedLocation: PublicCustomerLocation | null = current
      ? toPublicLocation(current)
      : null;

    if (coordinate) {
      const source = input.source ?? "TECHNICIAN_GPS";
      if (current) {
        const claimed = await tx.customerLocation.updateMany({
          where: {
            id: current.id,
            companyId,
            version: input.expectedVersion ?? -1,
          },
          data: {
            latitude: coordinate.latitude,
            longitude: coordinate.longitude,
            accuracyMeters: accuracy,
            source,
            verified: true,
            verifiedAt: new Date(),
            verifiedByUserId: actorUserId,
            verifiedByTechnicianId: technician.id,
            ...(reference !== null ? { reference } : {}),
            version: { increment: 1 },
          },
        });
        if (claimed.count !== 1) {
          throw conflict(
            "A localização do cliente mudou. Recarregue e tente novamente.",
          );
        }
        savedLocation = toPublicLocation(
          await tx.customerLocation.findUniqueOrThrow({ where: { id: current.id } }),
        );
      } else {
        try {
          const created = await tx.customerLocation.create({
            data: {
              companyId,
              customerId: order.customerId,
              latitude: coordinate.latitude,
              longitude: coordinate.longitude,
              accuracyMeters: accuracy,
              source,
              verified: true,
              verifiedAt: new Date(),
              verifiedByUserId: actorUserId,
              verifiedByTechnicianId: technician.id,
              reference,
            },
          });
          savedLocation = toPublicLocation(created);
        } catch (error) {
          // A unique em `customerId` é quem arbitra duas criações simultâneas.
          if (!isUniqueConstraintError(error)) throw error;
          throw conflict(
            "A localização do cliente mudou. Recarregue e tente novamente.",
          );
        }
      }

      await syncLocationProjection(tx, companyId, order.customerId, {
        latitude: coordinate.latitude,
        longitude: coordinate.longitude,
        source,
        verified: true,
      });
    }

    if (addressDidChange) {
      await tx.customer.updateMany({
        where: { id: order.customerId, companyId },
        data: nextAddress,
      });
    }

    const kind: LocationChangeKind =
      coordinate && addressDidChange
        ? "BOTH"
        : coordinate
          ? "COORDINATES"
          : "ADDRESS";

    await writeLocationHistory(tx, {
      companyId,
      customerId: order.customerId,
      serviceOrderId: order.id,
      kind,
      reason: input.reason,
      note,
      previous: current
        ? {
            latitude: current.latitude,
            longitude: current.longitude,
            source: current.source,
            verified: current.verified,
          }
        : null,
      next: coordinate
        ? {
            latitude: coordinate.latitude,
            longitude: coordinate.longitude,
            source: input.source ?? "TECHNICIAN_GPS",
            verified: true,
          }
        : null,
      previousAddress: addressDidChange ? previousAddress : null,
      newAddress: addressDidChange ? nextAddress : null,
      changedByUserId: actorUserId,
      technicianId: technician.id,
    });

    await tx.serviceOrderEvent.create({
      data: {
        companyId,
        serviceOrderId: order.id,
        userId: actorUserId,
        event: kind === "ADDRESS" ? "ADDRESS_CORRECTED" : "LOCATION_CORRECTED",
        metadata: {
          technicianId: technician.id,
          kind,
          reason: input.reason,
          // Os VALORES ficam no histórico tipado. A timeline diz que mudou.
          addressChanged: addressDidChange,
          coordinateChanged: coordinate !== null,
        },
      },
    });

    return { location: savedLocation, address: nextAddress, kind };
  });

  await logAudit({
    companyId,
    userId: actorUserId,
    action: "CUSTOMER_LOCATION.CORRECTED",
    entity: "Customer",
    entityId: orderId,
    details: `Correção de cadastro em campo (${result.kind}, motivo ${input.reason})`,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Escrita automática (importação / geocodificação)
// ---------------------------------------------------------------------------

export type ImportedLocationOutcome =
  | "CREATED"
  | "UPDATED"
  | "PRESERVED_EQUAL"
  | "PRESERVED_DIVERGENT";

/**
 * A partir de quantos metros duas coordenadas são "outro lugar".
 *
 * 50 m separa ruído de GPS e arredondamento de cadastro de uma divergência
 * real. Abaixo disso, registrar divergência a cada sincronização encheria o
 * histórico de linhas que não informam nada.
 */
export const LOCATION_DIVERGENCE_THRESHOLD_M = 50;

/**
 * Aplica uma coordenada vinda de processo AUTOMÁTICO, respeitando a precedência.
 *
 * É a função que a sincronização do ERP e uma futura geocodificação chamam —
 * nunca `correctCustomerLocation`, que pressupõe decisão humana.
 *
 * ## O que ela nunca faz
 *
 * - não rebaixa `verified` para `false`;
 * - não substitui coordenada verificada;
 * - não substitui nada mais forte que ela própria.
 *
 * ## Divergência é informação (§197)
 *
 * Quando o provedor traz uma coordenada diferente de uma já verificada, o certo
 * não é escolher em silêncio: pode ser o cliente que mudou de endereço. A
 * verificada é PRESERVADA e a divergência vira uma linha de histórico, para a
 * operação decidir.
 *
 * A linha de divergência só é escrita quando a distância passa do limiar E a
 * divergência mais recente daquele cliente não é já a mesma. Sem essa
 * deduplicação, cada releitura do ERP acrescentaria uma linha idêntica, e o
 * histórico — que existe para ser lido por gente — viraria log de sincronização.
 */
export async function applyImportedCustomerLocation(
  tx: ExecutionTx,
  companyId: string,
  customerId: string,
  incoming: {
    latitude: number;
    longitude: number;
    source?: Extract<CustomerLocationSource, "IMPORTED" | "GEOCODED">;
  },
): Promise<ImportedLocationOutcome> {
  if (!coordenadaValida(incoming.latitude, incoming.longitude)) {
    // Coordenada imprestável do provedor não é erro do AlfaOS: é dado ruim, e
    // a resposta certa é ignorá-lo sem derrubar a importação inteira.
    return "PRESERVED_EQUAL";
  }
  const source = incoming.source ?? "IMPORTED";

  const current = await tx.customerLocation.findFirst({
    where: { customerId, companyId },
  });

  if (!current) {
    await tx.customerLocation.create({
      data: {
        companyId,
        customerId,
        latitude: incoming.latitude,
        longitude: incoming.longitude,
        source,
        // Importação entra SEMPRE como não verificada. Marcar verificado por
        // ter vindo de um cadastro afirmaria uma checagem que ninguém fez.
        verified: false,
      },
    });
    await syncLocationProjection(tx, companyId, customerId, {
      latitude: incoming.latitude,
      longitude: incoming.longitude,
      source,
      verified: false,
    });
    return "CREATED";
  }

  const distance = distanceInMeters(
    { latitude: toNumber(current.latitude), longitude: toNumber(current.longitude) },
    { latitude: incoming.latitude, longitude: incoming.longitude },
  );

  if (automaticWriteWins({ source, verified: false }, current)) {
    await tx.customerLocation.update({
      where: { id: current.id },
      data: {
        latitude: incoming.latitude,
        longitude: incoming.longitude,
        source,
        verified: false,
        version: { increment: 1 },
      },
    });
    await syncLocationProjection(tx, companyId, customerId, {
      latitude: incoming.latitude,
      longitude: incoming.longitude,
      source,
      verified: false,
    });
    await writeLocationHistory(tx, {
      companyId,
      customerId,
      kind: "COORDINATES",
      reason: "INCOMPLETE_REGISTRATION",
      note: `Coordenada atualizada por importação (${current.source} → ${source}).`,
      previous: {
        latitude: current.latitude,
        longitude: current.longitude,
        source: current.source,
        verified: current.verified,
      },
      next: {
        latitude: incoming.latitude,
        longitude: incoming.longitude,
        source,
        verified: false,
      },
    });
    return "UPDATED";
  }

  if (distance < LOCATION_DIVERGENCE_THRESHOLD_M) {
    return "PRESERVED_EQUAL";
  }

  const lastDivergence = await tx.customerLocationHistory.findFirst({
    where: {
      companyId,
      customerId,
      kind: "COORDINATES",
      newVerified: false,
      newSource: source,
    },
    orderBy: { createdAt: "desc" },
  });
  const alreadyRecorded =
    lastDivergence !== null &&
    lastDivergence.newLatitude !== null &&
    lastDivergence.newLongitude !== null &&
    distanceInMeters(
      {
        latitude: toNumber(lastDivergence.newLatitude),
        longitude: toNumber(lastDivergence.newLongitude),
      },
      { latitude: incoming.latitude, longitude: incoming.longitude },
    ) < LOCATION_DIVERGENCE_THRESHOLD_M;

  if (!alreadyRecorded) {
    await writeLocationHistory(tx, {
      companyId,
      customerId,
      kind: "COORDINATES",
      reason: "OTHER",
      note: `Divergência preservada: o provedor informou um ponto a ${distance} m do cadastrado, que é mais confiável (${current.source}${current.verified ? ", verificado" : ""}) e foi mantido.`,
      previous: {
        latitude: current.latitude,
        longitude: current.longitude,
        source: current.source,
        verified: current.verified,
      },
      next: {
        latitude: incoming.latitude,
        longitude: incoming.longitude,
        source,
        verified: false,
      },
    });
  }

  return "PRESERVED_DIVERGENT";
}

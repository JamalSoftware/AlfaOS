import type { CtoPortAdministrativeState, Prisma } from "@prisma/client";
import { logAuditWithin } from "./audit";
import { badRequest, conflict, isUniqueConstraintError, notFound } from "./errors";
import { processImageUpload } from "./media/image-upload";
import { prisma } from "./prisma";
import { buildStorageKey, getFileStorage } from "./storage";

/**
 * # CTOs e rede de distribuição — domínio (CTO-1)
 *
 * A caixa, as posições dentro dela e a capacidade. **Não** o vínculo do
 * cliente: `CustomerNetworkConnection` é `CTO-2`, e nada aqui a antecipa.
 *
 * As decisões que este arquivo implementa foram congeladas na `CTO-0.1` e vivem
 * em `docs/CTO-NETWORK-DISTRIBUTION.md` §16 e §17. Três delas moldam quase todo
 * o código abaixo:
 *
 * 1. **Ocupação é derivada, nunca persistida.** Não existe `OCCUPIED` gravável.
 *    `administrativeState` responde *"esta posição pode receber alguém?"*;
 *    *"tem alguém aqui agora?"* será respondido pela existência de vínculo
 *    ativo, na `CTO-2`.
 * 2. **Reduzir capacidade não apaga porta.** As posições acima viram histórico,
 *    e por isso `capacity` **não** é a contagem de linhas de `CTOPort`.
 * 3. **A faixa ofertável é regra de escrita**, não de listagem — `isPortOfferable`
 *    existe para que a `CTO-2` não dependa de filtro visual.
 */

// ---------------------------------------------------------------------------
// Limites
// ---------------------------------------------------------------------------

export const CTO_NAME_MAX_LENGTH = 60;
export const CTO_CODE_MAX_LENGTH = 40;
export const CTO_ADDRESS_REFERENCE_MAX_LENGTH = 200;
export const CTO_NOTES_MAX_LENGTH = 500;
export const CTO_PORT_NOTES_MAX_LENGTH = 200;

/**
 * A faixa de posições por caixa, `1..256`.
 *
 * O teto é **controle de recurso**, não preferência de produto. Sem ele,
 * `capacity = 1_000_000` abre uma transação que insere um milhão de linhas e
 * segura o lock da CTO enquanto isso, no mesmo processo Node que atende todos
 * os tenants. Não é hipótese exótica: é um campo numérico num formulário, e um
 * zero a mais o produz sem nenhuma má intenção.
 *
 * 256 é folgado para o mundo real (caixas têm 8, 16, 32) e mantém a operação
 * dentro do que uma transação fecha rápido.
 *
 * **A faixa vale em TRÊS camadas, e nenhuma substitui a outra:** o `zod` das
 * rotas recusa o payload, `assertCapacity` recusa a chamada direta ao serviço,
 * e o banco tem `CHECK`. A do banco é a que sobrevive a um caminho novo que
 * esqueça as duas primeiras — e a que torna o limite um fato da tabela em vez
 * de uma convenção da aplicação.
 *
 * Mudar `CTO_CAPACITY_MAX` exige migration, de propósito: um teto que a
 * aplicação pode afrouxar sozinha não é teto.
 */
export const CTO_CAPACITY_MIN = 1;
export const CTO_CAPACITY_MAX = 256;

/** 8 MB, o mesmo teto da evidência de OS: é uma foto de caixa, não um álbum. */
export const CTO_PHOTO_MAX_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Formas públicas
// ---------------------------------------------------------------------------

/**
 * O estado EFETIVO de uma porta, que é o que a tela mostra.
 *
 * `OCCUPIED` está declarado aqui de propósito, e **não** existe no enum do
 * Prisma: é justamente a diferença entre o que se calcula e o que se grava. Na
 * `CTO-1` ele nunca é produzido, porque não há vínculo — a `CTO-2` passa a
 * produzi-lo a partir de `CustomerNetworkConnection` com `disconnectedAt IS
 * NULL`.
 */
export type CtoPortEffectiveState =
  | "FREE"
  | "OCCUPIED"
  | "RESERVED"
  | "DAMAGED";

export interface PublicCtoPort {
  id: string;
  number: number;
  administrativeState: CtoPortAdministrativeState;
  effectiveState: CtoPortEffectiveState;
  /** Está dentro da capacidade corrente? Falso = linha histórica. */
  offerable: boolean;
  notes: string | null;
}

export interface PublicCto {
  id: string;
  name: string;
  code: string | null;
  capacity: number;
  latitude: string | null;
  longitude: string | null;
  addressReference: string | null;
  notes: string | null;
  hasPhoto: boolean;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicCtoDetail extends PublicCto {
  ports: PublicCtoPort[];
  /**
   * Contagens honestas para a `CTO-1`.
   *
   * `occupied` é sempre `0` e o campo existe assim mesmo: omiti-lo faria a tela
   * inventar o número, e fingir que a contagem não existe seria pior que dizer
   * que ela é zero porque não há vínculo nenhum no produto ainda.
   */
  summary: {
    capacity: number;
    free: number;
    occupied: number;
    reserved: number;
    damaged: number;
    /** Linhas com `number > capacity`: existem, e não são ofertáveis. */
    historical: number;
  };
}

type CtoRow = Prisma.CTOGetPayload<Record<string, never>>;
type CtoPortRow = Prisma.CTOPortGetPayload<Record<string, never>>;

// ---------------------------------------------------------------------------
// Ofertabilidade — a regra que a CTO-2 vai reusar (R-13)
// ---------------------------------------------------------------------------

/**
 * Esta posição pode receber um cliente?
 *
 * **A lista não pode ser a única proteção.** Reduzir a capacidade não apaga a
 * porta 12; ela sobrevive como histórico e continua sendo um `ctoPortId`
 * perfeitamente válido. A unique parcial que a `CTO-2` vai criar diz "no máximo
 * um vínculo por porta" — ela não diz nada sobre a posição ainda ser oferecida.
 *
 * Se a faixa `1..capacity` for verificada só na listagem que alimenta a tela,
 * um payload com o id da porta 12 conecta o cliente a uma posição que a empresa
 * declarou não existir mais, e a redução de capacidade vira sugestão.
 *
 * Por isso a regra é uma função, testada diretamente, e não um `where` embutido
 * numa consulta de tela. A `CTO-2` chama isto **na transação que escreve**.
 */
export function isPortOfferable(
  port: { number: number; administrativeState: CtoPortAdministrativeState },
  capacity: number,
): boolean {
  if (!isPortWithinCapacity(port, capacity)) return false;
  return port.administrativeState === "AVAILABLE";
}

/**
 * Esta posição ainda faz parte da caixa que a empresa oferece hoje?
 *
 * **Só a faixa, e é por isso que ela é uma função separada.** `isPortOfferable`
 * responde uma pergunta maior — *"pode receber um cliente?"* — e uma porta
 * `RESERVED` dentro da capacidade responde `false` a ela enquanto continua
 * perfeitamente operável: liberar uma reserva é exatamente o que a operação
 * precisa poder fazer. Usar a ofertabilidade como autorização de mutação
 * administrativa congelaria toda porta reservada ou danificada no estado em que
 * está, e a tela deixaria de ter como desfazer o que ela mesma fez.
 *
 * A faixa tem UMA definição, aqui, e `isPortOfferable` a consome. Duas cópias
 * do mesmo `>` divergiriam no dia em que a regra ganhasse uma exceção.
 *
 * ## A decisão de produto que ela implementa
 *
 * Reduzir a capacidade não apaga porta: as posições acima viram **histórico**.
 * Histórico é registro do que houve, e registro não se edita — enquanto estiver
 * fora da capacidade, a porta não aceita mutação administrativa nenhuma, nem
 * para reservar nem para liberar. Voltando a capacidade, a mesma linha volta a
 * ser operável, com o estado que tinha.
 *
 * A `CTO-2` **não** herda autorização daqui. Uma porta dentro da capacidade
 * pode estar reservada ou danificada, e nenhuma das duas recebe vínculo: quem
 * responde por isso continua sendo `isPortOfferable`, chamada na transação que
 * grava o vínculo (`R-13`).
 */
export function isPortWithinCapacity(
  port: { number: number },
  capacity: number,
): boolean {
  return port.number <= capacity;
}

/**
 * O estado que a tela mostra, derivado — nunca lido de uma coluna.
 *
 * `hasActiveConnection` é o parâmetro que a `CTO-2` vai preencher. Na `CTO-1`
 * ele é sempre `false`, e o parâmetro existe desde já para que a fase seguinte
 * não precise reescrever a regra de precedência: vínculo ativo vence qualquer
 * estado administrativo, porque uma porta com alguém dentro não está livre nem
 * disponível para reserva.
 */
export function effectivePortState(
  administrativeState: CtoPortAdministrativeState,
  hasActiveConnection = false,
): CtoPortEffectiveState {
  if (hasActiveConnection) return "OCCUPIED";
  if (administrativeState === "RESERVED") return "RESERVED";
  if (administrativeState === "DAMAGED") return "DAMAGED";
  return "FREE";
}

// ---------------------------------------------------------------------------
// Serialização
// ---------------------------------------------------------------------------

function toPublicPort(port: CtoPortRow, capacity: number): PublicCtoPort {
  return {
    id: port.id,
    number: port.number,
    administrativeState: port.administrativeState,
    effectiveState: effectivePortState(port.administrativeState),
    offerable: isPortOfferable(port, capacity),
    notes: port.notes,
  };
}

export function toPublicCto(cto: CtoRow): PublicCto {
  return {
    id: cto.id,
    name: cto.name,
    code: cto.code,
    // `Decimal` vira string: number perderia precisão da sétima casa decimal,
    // que é o que distingue postes vizinhos.
    latitude: cto.latitude === null ? null : cto.latitude.toString(),
    longitude: cto.longitude === null ? null : cto.longitude.toString(),
    capacity: cto.capacity,
    addressReference: cto.addressReference,
    notes: cto.notes,
    // A CHAVE do storage nunca sai daqui. A tela precisa saber SE existe foto,
    // não onde ela está — e devolver o caminho convidaria o cliente a construir
    // um.
    hasPhoto: cto.photoStorageKey !== null,
    active: cto.active,
    createdAt: cto.createdAt,
    updatedAt: cto.updatedAt,
  };
}

function toPublicDetail(cto: CtoRow, ports: CtoPortRow[]): PublicCtoDetail {
  const ordered = [...ports].sort((a, b) => a.number - b.number);
  const publicPorts = ordered.map((p) => toPublicPort(p, cto.capacity));
  const inRange = publicPorts.filter((p) => p.number <= cto.capacity);
  return {
    ...toPublicCto(cto),
    ports: publicPorts,
    summary: {
      capacity: cto.capacity,
      free: inRange.filter((p) => p.effectiveState === "FREE").length,
      // Sempre 0 na CTO-1: não existe vínculo no produto. Ver PublicCtoDetail.
      occupied: inRange.filter((p) => p.effectiveState === "OCCUPIED").length,
      reserved: inRange.filter((p) => p.effectiveState === "RESERVED").length,
      damaged: inRange.filter((p) => p.effectiveState === "DAMAGED").length,
      historical: publicPorts.filter((p) => p.number > cto.capacity).length,
    },
  };
}

// ---------------------------------------------------------------------------
// Validação
// ---------------------------------------------------------------------------

/**
 * Forma canônica do nome — mesma regra do catálogo de tipos de OS.
 *
 * "CTO  A16" e "CTO A16" são a mesma caixa para quem está no poste, e sem
 * normalizar as duas entrariam no cadastro como itens que ninguém distingue.
 */
function normalizeName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

function assertName(name: string): void {
  if (name.length === 0) {
    throw badRequest("Informe o nome da CTO.");
  }
  if (name.length > CTO_NAME_MAX_LENGTH) {
    throw badRequest(
      `Nome da CTO deve ter no máximo ${CTO_NAME_MAX_LENGTH} caracteres.`,
    );
  }
}

/**
 * A faixa, verificada ANTES de qualquer trabalho proporcional ao valor.
 *
 * `Number.isInteger` cobre `NaN`, `Infinity` e fracionário de uma vez — os três
 * são não-inteiros. A ordem importa: esta função roda antes da transação e
 * antes do `Array.from({ length: capacity })`, de modo que um valor absurdo é
 * recusado sem alocar nada e sem segurar lock nenhum.
 */
function assertCapacity(capacity: number): void {
  // Uma mensagem para a faixa inteira, com os dois limites. Dizer só o lado
  // violado deixa quem errou sem metade da informação de que precisa.
  if (
    !Number.isInteger(capacity) ||
    capacity < CTO_CAPACITY_MIN ||
    capacity > CTO_CAPACITY_MAX
  ) {
    throw badRequest(
      `A capacidade deve ser um número inteiro entre ${CTO_CAPACITY_MIN} e ${CTO_CAPACITY_MAX} portas.`,
    );
  }
}

/**
 * Coordenada: ou as duas, ou nenhuma.
 *
 * Meia coordenada não localiza nada e apareceria no mapa como um ponto sobre o
 * meridiano de Greenwich ou sobre a linha do Equador. Recusar é mais honesto
 * que guardar metade.
 */
function assertCoordinates(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): void {
  const hasLat = latitude !== null && latitude !== undefined;
  const hasLon = longitude !== null && longitude !== undefined;

  /*
    O DOMÍNIO é a autoridade da faixa, e o `zod` das rotas valida só a FORMA.

    Antes as duas camadas conheciam `-90..90`, e a da rota chegava primeiro:
    latitude `91` era barrada pelo `zod` com "Invalid input" e a resposta saía
    como "Dados inválidos.", enquanto a mensagem boa — que existia aqui — nunca
    era alcançada. Duas autoridades para a mesma regra, e quem falava era a que
    tinha menos a dizer.

    Agora o `zod` responde "isto é um número finito?" e esta função responde
    "este número é uma coordenada?". Nada foi relaxado: todo caminho de escrita
    passa por aqui, inclusive a chamada direta ao serviço.

    Cada recusa nomeia o CAMPO, para a tela destacar o input responsável sem
    interpretar o texto da mensagem.
  */
  if (hasLat !== hasLon) {
    // O erro é da COMBINAÇÃO, não de um campo: sem `field`, e a tela marca os
    // dois. Escolher um seria apontar o dedo para o lado errado metade das
    // vezes.
    throw badRequest("Coordenadas incompletas. Preencha latitude e longitude juntas ou deixe os dois campos vazios.");
  }

  /*
    Finitude ANTES da faixa, e não é redundância.

    Comparação com `NaN` é sempre falsa: `NaN < -90` e `NaN > 90` são os dois
    `false`, então um teste de faixa sozinho DEIXA `NaN` PASSAR. A verificação
    de faixa parece cobrir tudo e não cobre o único valor que não se compara.
    `Infinity` entra pela mesma porta.
  */
  if (hasLat && !Number.isFinite(latitude)) {
    throw badRequest("Latitude inválida. Informe o valor correto.", "latitude");
  }
  if (hasLon && !Number.isFinite(longitude)) {
    throw badRequest("Longitude inválida. Informe o valor correto.", "longitude");
  }

  if (hasLat && (latitude! < -90 || latitude! > 90)) {
    throw badRequest("Latitude inválida. Informe o valor correto.", "latitude");
  }
  if (hasLon && (longitude! < -180 || longitude! > 180)) {
    throw badRequest("Longitude inválida. Informe o valor correto.", "longitude");
  }
}

function normalizeOptionalText(
  value: string | null | undefined,
  max: number,
  label: string,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) {
    throw badRequest(`${label} deve ter no máximo ${max} caracteres.`);
  }
  return trimmed;
}

function nameConflict(name: string): never {
  throw conflict(`Já existe uma CTO chamada "${name}" nesta empresa.`);
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

export async function listCompanyCtos(
  companyId: string,
  options: { includeInactive?: boolean } = {},
): Promise<PublicCto[]> {
  const ctos = await prisma.cTO.findMany({
    // Tenant no predicado SQL, nunca por navegação de FK.
    where: {
      companyId,
      ...(options.includeInactive ? {} : { active: true }),
    },
    orderBy: [{ active: "desc" }, { name: "asc" }],
  });
  return ctos.map(toPublicCto);
}

/**
 * Detalhe de uma CTO com as portas.
 *
 * `findFirst` com `companyId` no `where`, e não `findUnique({ id })` seguido de
 * conferência: buscar primeiro e checar depois deixa a linha de outra empresa
 * passar pela memória do processo, e é o tipo de janela que uma refatoração
 * distraída transforma em vazamento. Id de outra empresa devolve `null`, que
 * o chamador traduz em **404** — nunca 403, que confirmaria a existência.
 */
export async function getCto(
  companyId: string,
  ctoId: string,
): Promise<PublicCtoDetail | null> {
  const cto = await prisma.cTO.findFirst({ where: { id: ctoId, companyId } });
  if (!cto) return null;
  const ports = await prisma.cTOPort.findMany({
    where: { ctoId: cto.id, companyId },
  });
  return toPublicDetail(cto, ports);
}

/** A foto, para servir. `null` quando não há — e quando a CTO é de outra empresa. */
export async function getCtoPhotoKey(
  companyId: string,
  ctoId: string,
): Promise<string | null> {
  const cto = await prisma.cTO.findFirst({
    where: { id: ctoId, companyId },
    select: { photoStorageKey: true },
  });
  return cto?.photoStorageKey ?? null;
}

// ---------------------------------------------------------------------------
// Criação
// ---------------------------------------------------------------------------

export interface CreateCtoInput {
  name: string;
  code?: string | null;
  capacity: number;
  latitude?: number | null;
  longitude?: number | null;
  addressReference?: string | null;
  notes?: string | null;
}

/**
 * Cria a CTO e as portas `1..capacity` na MESMA transação.
 *
 * Não existe endpoint para cadastrar porta a porta, e a razão é operacional
 * antes de ser técnica: uma CTO cuja gravação de portas falhou pela metade é
 * uma caixa que a operação enxerga como incompleta sem saber por quê, e o
 * técnico descobre isso no poste. Falhou uma, nada nasce.
 */
export async function createCto(
  companyId: string,
  actorUserId: string,
  input: CreateCtoInput,
): Promise<PublicCtoDetail> {
  const name = normalizeName(input.name);
  assertName(name);
  assertCapacity(input.capacity);
  assertCoordinates(input.latitude, input.longitude);

  const code = normalizeOptionalText(input.code, CTO_CODE_MAX_LENGTH, "Código");
  const addressReference = normalizeOptionalText(
    input.addressReference,
    CTO_ADDRESS_REFERENCE_MAX_LENGTH,
    "Referência de endereço",
  );
  const notes = normalizeOptionalText(
    input.notes,
    CTO_NOTES_MAX_LENGTH,
    "Observações",
  );

  try {
    return await prisma.$transaction(async (tx) => {
      const cto = await tx.cTO.create({
        data: {
          // Da SESSÃO. Nenhum schema de entrada tem este campo.
          companyId,
          name,
          code: code ?? null,
          capacity: input.capacity,
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
          addressReference: addressReference ?? null,
          notes: notes ?? null,
        },
      });

      await tx.cTOPort.createMany({
        data: Array.from({ length: input.capacity }, (_, i) => ({
          ctoId: cto.id,
          companyId,
          number: i + 1,
        })),
      });

      const ports = await tx.cTOPort.findMany({ where: { ctoId: cto.id } });

      await logAuditWithin(tx, {
        companyId,
        userId: actorUserId,
        action: "CTO.CREATED",
        entity: "CTO",
        entityId: cto.id,
        details: `CTO "${name}" criada com ${input.capacity} portas`,
      });

      return toPublicDetail(cto, ports);
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      nameConflict(name);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Edição
// ---------------------------------------------------------------------------

export interface UpdateCtoInput {
  name?: string;
  /**
   * Só existe para ser RECUSADO quando difere do gravado.
   *
   * A rota poderia simplesmente não aceitar o campo, e aí um formulário que
   * reenvia o objeto inteiro teria o código descartado em silêncio. Recebê-lo e
   * comparar é o que transforma "o código não muda" numa afirmação verificável
   * em vez de num efeito colateral do schema.
   */
  code?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  addressReference?: string | null;
  notes?: string | null;
}

export async function updateCto(
  companyId: string,
  actorUserId: string,
  ctoId: string,
  input: UpdateCtoInput,
): Promise<PublicCtoDetail> {
  const current = await prisma.cTO.findFirst({ where: { id: ctoId, companyId } });
  if (!current) {
    throw notFound("CTO não encontrada.");
  }

  const data: Prisma.CTOUpdateInput = {};
  const changed: string[] = [];

  if (input.name !== undefined) {
    const name = normalizeName(input.name);
    assertName(name);
    if (name !== current.name) {
      data.name = name;
      changed.push("nome");
    }
  }

  /*
    `code` é imutável depois da criação (C-06).

    Postgres não tem coluna "somente na criação", então a garantia é desta
    função — e o silêncio seria a pior resposta: um cliente que mandou um código
    diferente acredita que ele foi gravado. Recusar explicitamente é o que faz a
    imutabilidade ser observável.

    Preencher um `code` que era nulo TAMBÉM é recusado. "Imutável depois da
    criação" não abre exceção para o caso em que ninguém o preencheu: o valor
    dele é ser âncora estável, e uma âncora que aparece depois não é estável.
  */
  if (input.code !== undefined) {
    const code = normalizeOptionalText(input.code, CTO_CODE_MAX_LENGTH, "Código");
    const next = code ?? null;
    if (next !== current.code) {
      throw badRequest(
        "O código da CTO não pode ser alterado depois da criação.",
      );
    }
  }

  /*
    Cada campo compara com o gravado antes de entrar em `changed`.

    A tela manda o formulário inteiro a cada "Salvar", então sem a comparação
    toda gravação registraria `CTO.UPDATED` com a lista completa de campos — e a
    auditoria passaria a dizer que as coordenadas mudaram em toda visita a uma
    tela onde ninguém as tocou. Auditoria que registra não-mudança é ruído que
    esconde a mudança real.
  */
  if (input.latitude !== undefined || input.longitude !== undefined) {
    // As duas juntas, sempre: alterar só uma produziria um par inconsistente
    // com o que já estava gravado.
    assertCoordinates(input.latitude, input.longitude);
    const proximaLat = input.latitude ?? null;
    const proximaLon = input.longitude ?? null;
    const atualLat = current.latitude === null ? null : current.latitude.toNumber();
    const atualLon =
      current.longitude === null ? null : current.longitude.toNumber();
    if (proximaLat !== atualLat || proximaLon !== atualLon) {
      data.latitude = proximaLat;
      data.longitude = proximaLon;
      changed.push("coordenadas");
    }
  }

  if (input.addressReference !== undefined) {
    const proximo = normalizeOptionalText(
      input.addressReference,
      CTO_ADDRESS_REFERENCE_MAX_LENGTH,
      "Referência de endereço",
    );
    if ((proximo ?? null) !== current.addressReference) {
      data.addressReference = proximo ?? null;
      changed.push("referência de endereço");
    }
  }

  if (input.notes !== undefined) {
    const proximo = normalizeOptionalText(
      input.notes,
      CTO_NOTES_MAX_LENGTH,
      "Observações",
    );
    if ((proximo ?? null) !== current.notes) {
      data.notes = proximo ?? null;
      changed.push("observações");
    }
  }

  if (changed.length === 0) {
    const ports = await prisma.cTOPort.findMany({ where: { ctoId, companyId } });
    return toPublicDetail(current, ports);
  }

  try {
    return await prisma.$transaction(async (tx) => {
      // Tenant no `updateMany`, não no `update({ where: { id } })`: o segundo
      // alcança a linha por id sozinho.
      const updated = await tx.cTO.updateMany({
        where: { id: ctoId, companyId },
        data,
      });
      if (updated.count === 0) {
        throw notFound("CTO não encontrada.");
      }

      await logAuditWithin(tx, {
        companyId,
        userId: actorUserId,
        action: "CTO.UPDATED",
        entity: "CTO",
        entityId: ctoId,
        // Nomes dos campos, nunca o conteúdo: uma observação pode ter texto
        // livre extenso, e a auditoria não é lugar de copiá-lo.
        details: `Campos alterados: ${changed.join(", ")}`,
      });

      const cto = await tx.cTO.findFirstOrThrow({ where: { id: ctoId, companyId } });
      const ports = await tx.cTOPort.findMany({ where: { ctoId, companyId } });
      return toPublicDetail(cto, ports);
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      nameConflict(data.name as string);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Capacidade
// ---------------------------------------------------------------------------

/**
 * Trava a CTO para decidir capacidade.
 *
 * `FOR UPDATE` porque a decisão é *"o que falta, e o que sobra?"* — uma leitura
 * seguida de escrita. Duas expansões simultâneas que leem `capacity = 8`
 * calculam as duas que faltam `9..16` e a segunda tentaria inserir posições que
 * a primeira já criou. A `UNIQUE (ctoId, number)` recusaria, e o resultado
 * seria um 500 opaco em vez de uma sequência correta.
 *
 * O lock é o que serializa; a unique é a rede embaixo dele. As duas, e não uma
 * das duas: o objeto lido antes da transação não vale como estado.
 */
async function lockCto(
  tx: Prisma.TransactionClient,
  companyId: string,
  ctoId: string,
): Promise<{ id: string; capacity: number }> {
  /*
    `active` NÃO é selecionado.

    A primeira versão o trazia e ninguém o lia — valor morto que sugeria uma
    regra ("CTO inativa não muda") que não está implementada e que o contrato
    congelado também não pede. Selecionar um campo para não usá-lo é pior que
    não selecioná-lo: quem lê presume que a decisão existe em algum lugar.
    Apontado pela auditoria independente.
  */
  const rows = await tx.$queryRaw<{ id: string; capacity: number }[]>`
    SELECT "id", "capacity" FROM "ctos"
    WHERE "id" = ${ctoId} AND "companyId" = ${companyId}
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row) {
    throw notFound("CTO não encontrada.");
  }
  return row;
}

/**
 * Altera a capacidade da caixa.
 *
 * ## Aumentar
 *
 * Cria as posições que faltam. Se alguma delas **já existir** — porque a CTO já
 * foi maior antes e a redução preservou as linhas —, ela é reutilizada como
 * está: `administrativeState`, observações e `createdAt` continuam os de antes.
 * Recriar apagaria a informação de que aquela porta foi marcada como danificada
 * três meses atrás.
 *
 * ## Reduzir
 *
 * **Nenhuma porta é apagada.** As posições acima da nova capacidade continuam
 * no banco e apenas saem da faixa ofertável. Apagar linha de porta apagaria
 * junto a resposta para *"quem já esteve na porta 12?"*, que é a pergunta que a
 * capability inteira existe para responder.
 *
 * A redução é recusada quando alguma porta acima do novo limite está `RESERVED`
 * ou `DAMAGED`: as duas são declarações de que alguém contava com aquela
 * posição, e sumir com elas por um campo de formulário tem o mesmo defeito que
 * desconectar cliente.
 */
export async function changeCtoCapacity(
  companyId: string,
  actorUserId: string,
  ctoId: string,
  newCapacity: number,
): Promise<PublicCtoDetail> {
  assertCapacity(newCapacity);

  return prisma.$transaction(async (tx) => {
    const locked = await lockCto(tx, companyId, ctoId);
    const previous = locked.capacity;

    if (previous === newCapacity) {
      const cto = await tx.cTO.findFirstOrThrow({ where: { id: ctoId, companyId } });
      const ports = await tx.cTOPort.findMany({ where: { ctoId, companyId } });
      return toPublicDetail(cto, ports);
    }

    const existing = await tx.cTOPort.findMany({
      where: { ctoId, companyId },
      select: { id: true, number: true, administrativeState: true },
    });

    if (newCapacity < previous) {
      const acima = existing.filter((p) => p.number > newCapacity);

      /*
        Cliente conectado acima do novo limite RECUSA a redução. (`CTO-2.6`)

        É a primeira das duas condições porque é a mais dura de destravar:
        estado administrativo se resolve num clique, e um cliente conectado
        exige mover ou desconectar — decisão de operação, não de formulário.

        **Nada é feito por conta própria.** Nenhum vínculo é encerrado, nenhum
        cliente é movido, nenhuma `CTOPort` é apagada e nenhum histórico muda.
        A transação inteira volta, e a capacidade continua a de antes: reduzir
        capacidade é um campo de formulário, e desconectar alguém por causa dele
        seria o mesmo defeito que apagar a porta.

        A consulta vem DEPOIS do `FOR UPDATE` da CTO, e é o que fecha a corrida
        com o `CONNECT`/`MOVE`: os três disputam o mesmo lock de caixa. Se a
        redução commitar primeiro, o `CONNECT` relê a capacidade do próprio
        lock e recusa por faixa; se o vínculo commitar primeiro, ele aparece
        aqui. Nenhuma ordem deixa vínculo ativo fora da capacidade.

        Os ids saem de `existing`, que já foi lido sob o lock — sem navegar FK
        e com `companyId` no predicado.
      */
      if (acima.length > 0) {
        const ocupadas = await tx.customerNetworkConnection.findMany({
          where: {
            companyId,
            disconnectedAt: null,
            ctoPortId: { in: acima.map((p) => p.id) },
          },
          select: { ctoPortId: true },
        });

        if (ocupadas.length > 0) {
          const numeroDe = new Map(acima.map((p) => [p.id, p.number]));
          const numeros = ocupadas
            .map((c) => numeroDe.get(c.ctoPortId))
            .filter((n): n is number => n !== undefined)
            .sort((a, b) => a - b);
          // Só o NÚMERO da posição. Nenhum cliente, nenhum id, nenhum tenant.
          const trecho =
            numeros.length === 1
              ? `a porta ${numeros[0]} está com um cliente conectado`
              : `as portas ${numeros.join(", ")} estão com clientes conectados`;
          throw conflict(
            `Não é possível reduzir a capacidade para ${newCapacity}: ${trecho}. ` +
              "Mova ou desconecte antes e tente de novo.",
          );
        }
      }

      const blocking = existing
        .filter(
          (p) => p.number > newCapacity && p.administrativeState !== "AVAILABLE",
        )
        .sort((a, b) => a.number - b.number);

      if (blocking.length > 0) {
        /*
          A mensagem é lida por quem está operando a tela, e o texto diz
          exatamente O QUE fazer para destravar.

          Ela nomeia as portas porque é a informação que resolve o problema, e
          não expõe nada além do número da posição: nenhum id, nenhum tenant,
          nenhum detalhe interno. A concordância acompanha a quantidade —
          "as portas 12, 14 estão" quando são várias e "a porta 14 está" quando
          é uma só, que era o caso da validação humana e saía errado.
        */
        const numeros = blocking.map((p) => p.number).join(", ");
        const trecho =
          blocking.length === 1
            ? `a porta ${numeros} está reservada ou danificada`
            : `as portas ${numeros} estão reservadas ou danificadas`;
        throw conflict(
          `Não é possível reduzir a capacidade para ${newCapacity}: ${trecho}. ` +
            "Libere e tente de novo.",
        );
      }
    } else {
      const present = new Set(existing.map((p) => p.number));
      const missing: number[] = [];
      for (let n = previous + 1; n <= newCapacity; n += 1) {
        // Reutiliza silenciosamente o que já existe: `skipDuplicates` resolveria
        // a inserção, mas montar só o que falta deixa explícito que a linha
        // histórica é PRESERVADA, e não sobrescrita.
        if (!present.has(n)) missing.push(n);
      }
      if (missing.length > 0) {
        await tx.cTOPort.createMany({
          data: missing.map((number) => ({ ctoId, companyId, number })),
        });
      }
    }

    await tx.cTO.updateMany({
      where: { id: ctoId, companyId },
      data: { capacity: newCapacity },
    });

    await logAuditWithin(tx, {
      companyId,
      userId: actorUserId,
      action: "CTO.CAPACITY_CHANGED",
      entity: "CTO",
      entityId: ctoId,
      details: `Capacidade alterada de ${previous} para ${newCapacity}`,
    });

    const cto = await tx.cTO.findFirstOrThrow({ where: { id: ctoId, companyId } });
    const ports = await tx.cTOPort.findMany({ where: { ctoId, companyId } });
    return toPublicDetail(cto, ports);
  });
}

// ---------------------------------------------------------------------------
// Ativação
// ---------------------------------------------------------------------------

/**
 * Inativa ou reativa a caixa. **Não existe exclusão** (`N-13`).
 *
 * Uma CTO inativa não recebe vínculo novo — regra que a `CTO-2` aplica —, e os
 * existentes permanecem. Apagar destruiria o histórico que a capability existe
 * para guardar, e é por isso que `CTO → CTOPort` é `Restrict` no schema: mesmo
 * um `delete` escrito por engano em algum caminho futuro esbarra no banco.
 */
export async function setCtoActive(
  companyId: string,
  actorUserId: string,
  ctoId: string,
  active: boolean,
): Promise<PublicCtoDetail> {
  const current = await prisma.cTO.findFirst({ where: { id: ctoId, companyId } });
  if (!current) {
    throw notFound("CTO não encontrada.");
  }
  if (current.active === active) {
    const ports = await prisma.cTOPort.findMany({ where: { ctoId, companyId } });
    return toPublicDetail(current, ports);
  }

  return prisma.$transaction(async (tx) => {
    await tx.cTO.updateMany({ where: { id: ctoId, companyId }, data: { active } });
    await logAuditWithin(tx, {
      companyId,
      userId: actorUserId,
      action: active ? "CTO.ACTIVATED" : "CTO.INACTIVATED",
      entity: "CTO",
      entityId: ctoId,
      details: active ? `CTO "${current.name}" reativada` : `CTO "${current.name}" inativada`,
    });
    const cto = await tx.cTO.findFirstOrThrow({ where: { id: ctoId, companyId } });
    const ports = await tx.cTOPort.findMany({ where: { ctoId, companyId } });
    return toPublicDetail(cto, ports);
  });
}

// ---------------------------------------------------------------------------
// Estado administrativo da porta
// ---------------------------------------------------------------------------

/**
 * Marca a porta como disponível, reservada ou danificada.
 *
 * O tenant vai no predicado e o `ctoId` também: sem ele, o id de uma porta de
 * outra caixa da MESMA empresa seria aceito — o que não é cross-tenant, mas é
 * uma porta que não pertence ao recurso que o chamador abriu.
 *
 * ## Posição acima da capacidade é HISTÓRICO, e histórico não se edita
 *
 * Esta função afirmava o contrário, e a afirmação era minha: *"uma posição
 * acima da capacidade corrente pode ter o estado alterado (é uma linha real, e
 * marcar histórico como danificado é legítimo)"*. O checkpoint final da `CTO-1`
 * reproduziu o que isso produz — uma porta exibida com o selo "Fora da
 * capacidade" aceitando `RESERVED`, e a reserva passando a **bloquear a redução
 * seguinte**. Uma posição que a empresa declarou não oferecer mais decidindo se
 * a capacidade pode ou não mudar.
 *
 * A decisão do dono fechou a pergunta que o contrato congelado não respondia:
 * enquanto estiver fora da capacidade, a porta é **read-only**. Nem reservar,
 * nem danificar, nem liberar — a linha permanece exatamente como a redução a
 * deixou. Voltando a capacidade, ela volta a ser operável com o mesmo estado.
 *
 * A verificação é de FAIXA, não de ofertabilidade (`isPortWithinCapacity`, e
 * não `isPortOfferable`): uma porta reservada dentro da capacidade não é
 * ofertável e precisa continuar podendo ser liberada. Confundir as duas
 * trancaria toda reserva no lugar.
 */
export async function setPortAdministrativeState(
  companyId: string,
  actorUserId: string,
  ctoId: string,
  portId: string,
  state: CtoPortAdministrativeState,
): Promise<PublicCtoDetail> {
  await prisma.$transaction(async (tx) => {
    /*
      Trava a CTO, e a leitura da porta vem DEPOIS do lock.

      O ganho é a AUDITORIA, e vale registrar que não é o que eu supus primeiro.
      A hipótese inicial era que sem o lock a redução de capacidade poderia
      concluir "apesar" de uma reserva concorrente, deixando porta reservada
      acima da capacidade. O teste escrito para provar isso falhou — e falhou
      porque a hipótese estava errada: esse mesmo estado é alcançável de forma
      inteiramente legítima, bastando a redução acontecer primeiro e a reserva
      depois. Marcar como reservada uma posição já fora da capacidade é
      permitido: é linha real, e registrar que ela está danificada é útil.
      Serializar as duas operações não remove nenhum estado final do conjunto.

      O que o lock remove de fato é auditoria mentirosa. Com o estado lido FORA
      da transação, duas mudanças simultâneas na mesma porta produzem dois
      registros partindo do mesmo ponto — ambos "AVAILABLE → X" —, quando a
      segunda deveria dizer "RESERVED → DAMAGED". A trilha deixaria de ser
      encadeável, e é dela que alguém depende para reconstruir o que aconteceu
      com uma porta.

      Travar a CTO, e não a linha da porta, é mais forte que o mínimo. É
      deliberado: estas são operações administrativas de baixa frequência, e uma
      ordem determinística por caixa é mais simples de raciocinar do que um lock
      por linha que ainda teria de coexistir com o da capacidade.
    */
    const cto = await lockCto(tx, companyId, ctoId);

    const port = await tx.cTOPort.findFirst({
      where: { id: portId, ctoId, companyId },
    });
    if (!port) {
      throw notFound("Porta não encontrada.");
    }

    /*
      A capacidade é a que o `FOR UPDATE` acabou de travar, e não uma lida
      antes.

      Sem isso a regra teria uma janela real: alguém reduz a capacidade de 16
      para 8 enquanto outra pessoa reserva a porta 12. As duas leem 16, as duas
      concluem que 12 está dentro, e o resultado é uma porta histórica reservada
      — o estado que esta regra existe para não produzir. `lockCto` serializa as
      duas operações por caixa, e a comparação usa o valor que veio do lock.

      É o mesmo par que a redução de capacidade já usava; nada de arquitetura
      nova.
    */
    if (!isPortWithinCapacity(port, cto.capacity)) {
      throw conflict(
        `A porta ${port.number} está fora da capacidade atual da CTO ` +
          `(${cto.capacity} portas) e é apenas histórica. ` +
          "Aumente a capacidade para voltar a operá-la.",
      );
    }

    /*
      Vínculo ativo proíbe o ALVO `RESERVED` — e só ele. (`CTO-2.6`)

      A regra é sobre o **alvo**, nunca sobre o estado atual, e a diferença
      decide se ela é utilizável. "Porta ocupada não muda de estado" criaria um
      beco sem saída: uma porta consertada nunca voltaria a `AVAILABLE`, e uma
      linha legada `ativa + RESERVED` — que o produto admite ter — ficaria
      presa para sempre. Aqui as duas saídas continuam abertas:
      `RESERVED → AVAILABLE` e `RESERVED → DAMAGED` passam.

      Por que `RESERVED` e não `DAMAGED`: reservar significa *separei esta
      posição para uso futuro*, e não convive com alguém já dentro dela.
      Danificada com cliente ligado é situação real de campo — o cabo quebra
      com o cliente conectado — e continua permitida (`CTO-2` §24, decisão do
      dono).

      A consulta acontece DEPOIS do `FOR UPDATE` da CTO, e é isso que fecha a
      corrida com o `CONNECT`: as duas operações disputam o mesmo lock de
      caixa. Quem reservar primeiro faz o `CONNECT` reler a porta e recusar
      por `isPortOfferable`; quem conectar primeiro cai aqui. Nenhuma ordem
      produz "vínculo ativo em porta reservada".

      Só é consultado quando o alvo é `RESERVED`: perguntar em toda mudança
      gastaria uma ida ao banco e sugeriria uma regra mais larga do que a que
      existe.
    */
    if (state === "RESERVED") {
      const ativo = await tx.customerNetworkConnection.findFirst({
        // Tenant no predicado SQL, nunca por navegação de FK.
        where: { companyId, ctoPortId: portId, disconnectedAt: null },
        select: { id: true },
      });
      if (ativo) {
        throw conflict(
          `A porta ${port.number} está ocupada por um cliente e não pode ser ` +
            "reservada. Mova ou desconecte o cliente antes; para sinalizar " +
            "defeito com o cliente ligado, marque a porta como danificada.",
        );
      }
    }

    /*
      O no-op vem DEPOIS das duas regras acima, e a ordem é decisão.

      Uma porta histórica cujo estado pedido é o que ela já tem sairia daqui com
      `200`, e a tela concluiria que a ação está disponível. Recusar as duas do
      mesmo jeito é o que faz "read-only" ser observável: a resposta não depende
      de qual estado a linha guarda.

      Vale igual para a linha legada `ativa + RESERVED` pedindo `RESERVED`:
      ela recebe `409`, e não um `200` mudo que anunciaria uma ação
      indisponível. Isso não a aprisiona — as saídas para `AVAILABLE` e
      `DAMAGED` continuam abertas.
    */
    if (port.administrativeState === state) {
      return;
    }

    await tx.cTOPort.updateMany({
      where: { id: portId, ctoId, companyId },
      data: { administrativeState: state },
    });
    await logAuditWithin(tx, {
      companyId,
      userId: actorUserId,
      action: "CTO.PORT_STATE_CHANGED",
      entity: "CTOPort",
      entityId: portId,
      details: `Porta ${port.number}: ${port.administrativeState} → ${state}`,
    });
  });

  const detail = await getCto(companyId, ctoId);
  if (!detail) {
    throw notFound("CTO não encontrada.");
  }
  return detail;
}

// ---------------------------------------------------------------------------
// Foto
// ---------------------------------------------------------------------------

export interface CtoPhotoInput {
  data: Buffer;
  declaredMimeType: string;
}

/**
 * Grava ou substitui a foto da caixa.
 *
 * Passa pela **mesma** fronteira de upload que evidência e assinatura
 * (`processImageUpload`): sniff do tipo real, teto, e a limpeza de metadado que
 * o `PC-1` instituiu. Nenhuma cópia de `stripImageMetadata` nasce aqui — a
 * fronteira foi extraída ANTES deste consumidor existir, justamente porque foi
 * um ponto de upload nascendo fora da política que criou o `EXIF-01`.
 *
 * A foto da CTO **não é evidência de OS**: não passa por
 * `loadInProgressOwnedOrder`, não tem `serviceOrderId` e não conta em política
 * de conclusão nenhuma. A autorização dela é a da infraestrutura — ADMIN da
 * empresa dona da caixa —, e criar uma OS só para permitir a foto seria
 * inventar um vínculo que não existe.
 *
 * **O blob anterior NÃO é apagado.** Ver a nota sobre órfãos abaixo.
 */
export async function setCtoPhoto(
  companyId: string,
  actorUserId: string,
  ctoId: string,
  input: CtoPhotoInput,
): Promise<PublicCto> {
  const current = await prisma.cTO.findFirst({ where: { id: ctoId, companyId } });
  if (!current) {
    throw notFound("CTO não encontrada.");
  }

  const { data, mimeType } = processImageUpload(
    input.data,
    input.declaredMimeType,
    {
      maxBytes: CTO_PHOTO_MAX_BYTES,
      messages: {
        empty: "Arquivo vazio.",
        tooLarge: `Imagem muito grande (máximo ${Math.floor(CTO_PHOTO_MAX_BYTES / 1024 / 1024)} MB).`,
        notAnImage: "Arquivo não é uma imagem JPEG, PNG ou WebP válida.",
        unsupportedType: "Tipo de imagem não suportado. Use JPEG, PNG ou WebP.",
      },
    },
  );

  // Chave construída no SERVIDOR, a partir do tenant e do recurso. O cliente
  // nunca envia caminho: aceitá-lo seria deixá-lo escolher onde escrever.
  const storage = getFileStorage();
  const storageKey = buildStorageKey(companyId, ctoId, mimeType);
  await storage.put(storageKey, data, mimeType);

  /*
    A foto anterior fica no disco.

    Substituir aponta a linha para a chave nova; a antiga permanece órfã. É
    deliberado e é o comportamento conservador: não existe política documentada
    de remoção de blob, e apagar por suposição é como se perde evidência. O
    custo é disco — uma imagem por substituição —, e a alternativa custaria
    dado.

    Um coletor de órfãos é trabalho próprio, com política própria, e não nasce
    de carona numa fase de cadastro.
  */
  const updated = await prisma.$transaction(async (tx) => {
    await tx.cTO.updateMany({
      where: { id: ctoId, companyId },
      data: { photoStorageKey: storageKey },
    });
    await logAuditWithin(tx, {
      companyId,
      userId: actorUserId,
      action: "CTO.PHOTO_UPDATED",
      entity: "CTO",
      entityId: ctoId,
      // Nem a chave, nem bytes, nem metadado: só o fato e o tamanho gravado.
      details: `Foto da CTO atualizada (${data.byteLength} bytes)`,
    });
    return tx.cTO.findFirstOrThrow({ where: { id: ctoId, companyId } });
  });

  return toPublicCto(updated);
}

/**
 * A capability desta empresa está ligada?
 *
 * Consulta própria, e não um campo carregado na sessão: o token de sessão é
 * emitido no login e viveria com o valor de então, de modo que desligar a
 * capability só teria efeito quando cada pessoa reautenticasse.
 */
export async function isCtoNetworkEnabled(companyId: string): Promise<boolean> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { ctoNetworkEnabled: true },
  });
  return company?.ctoNetworkEnabled === true;
}


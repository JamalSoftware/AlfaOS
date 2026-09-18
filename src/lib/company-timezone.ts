import { prisma } from "./prisma";
import { resolveTimezone } from "./workday";

/**
 * O fuso da EMPRESA, lido uma vez por tela — `RC-1` (débito §12).
 *
 * # Por que existe
 *
 * `company-datetime.ts` só FORMATA, e de propósito: ele recebe o fuso pronto e
 * não toca banco. Quem lia o fuso era `companySliceClock`, que mora no módulo
 * dos recortes do dashboard — importar recorte de OS numa tela de técnicos para
 * descobrir um fuso seria carregar um módulo inteiro por um campo.
 *
 * Então a LEITURA passou a morar aqui, e `companySliceClock` delega: continua
 * existindo uma única resposta para "qual é o fuso desta empresa", e nenhuma
 * tela inventa a sua.
 *
 * `resolveTimezone` é o mesmo da jornada — empresa sem fuso configurado cai no
 * padrão do projeto, e não no fuso do processo.
 */
export async function companyTimezone(companyId: string): Promise<string> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { timezone: true },
  });
  return resolveTimezone(company?.timezone);
}

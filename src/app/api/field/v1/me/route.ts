import { prisma } from "@/lib/prisma";
import { fieldOk, runFieldApi } from "@/lib/field/response";
import { requireFieldPrincipal } from "@/lib/field/route";

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
 * `GET /api/field/v1/me`
 *
 * Contexto do técnico que está com o aparelho na mão. É a primeira chamada do
 * aplicativo depois do login e o que ele revalida ao voltar do background.
 *
 * ## O que NÃO volta aqui
 *
 * Nada de credencial de ERP, nada de configuração administrativa da empresa,
 * nada sobre outros técnicos, nada de contadores de auditoria. O aplicativo do
 * técnico não tem tela para nenhuma dessas coisas, e o que não é enviado não
 * pode vazar de um celular roubado.
 *
 * `capabilities` é a lista do que ESTE técnico pode fazer agora — derivada da
 * mesma regra de elegibilidade da web (`technicianExecutionIssue`), não de uma
 * cópia. Serve para o app não desenhar um botão que a API recusaria; continua
 * valendo que **UI não é controle de segurança**, e cada rota reconfere.
 */
export async function GET(request: Request) {
  return runFieldApi(async () => {
    const principal = await requireFieldPrincipal(request);

    const company = await prisma.company.findUnique({
      where: { id: principal.user.companyId },
      select: { id: true, name: true },
    });

    const canExecute = principal.technician.executionIssue === null;

    return fieldOk({
      user: {
        id: principal.user.id,
        name: principal.user.name,
        email: principal.user.email,
      },
      technician: {
        id: principal.technician.id,
        active: principal.technician.active,
        /**
         * Por que não pode escrever, quando não pode. Frase pronta para a tela,
         * em vez de o app inventar a explicação a partir de um booleano.
         */
        executionIssue: principal.technician.executionIssue,
      },
      company: company ?? { id: principal.user.companyId, name: "" },
      device: {
        id: principal.device.id,
        platform: principal.device.platform,
      },
      capabilities: {
        /** Ler a própria fila nunca é bloqueado por elegibilidade. */
        listOrders: true,
        startOrder: canExecute,
        revealConnectionPassword: canExecute,
        refreshDiagnostic: true,
      },
    });
  });
}

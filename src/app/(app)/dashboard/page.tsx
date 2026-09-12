import type { Metadata } from "next";
import Link from "next/link";
import { requirePageProfile } from "@/lib/guards";
import {
  getOperationalDashboard,
  type DashboardSection,
} from "@/lib/dashboard";

export const metadata: Metadata = {
  title: "Dashboard",
};

/**
 * # Dashboard operacional — DASH-1 (PRD §380)
 *
 * **Todo cartão é um link para a listagem filtrada**, e a contagem da listagem
 * é a do cartão (`src/lib/dashboard.ts` explica por construção). Número que
 * não leva a lugar nenhum é decoração, e decoração num painel operacional
 * treina a pessoa a ignorar o painel.
 *
 * Renderizado no servidor, a cada visita: não há polling (o PRD não pede tempo
 * real) e não há estado no cliente — então não há "0 → carregando → 15" nem
 * resposta velha sobrescrevendo nova. "Atualizar" é só uma nova visita.
 *
 * Cor com parcimônia: o cartão é neutro, e o NÚMERO só ganha cor quando é um
 * sinal de atenção e é maior que zero. Um painel com uma cor por cartão perde
 * a cor como sinal.
 */

type Tom = "neutro" | "atencao" | "alerta";

interface Cartao {
  chave: string;
  rotulo: string;
  href: string;
  /** O que o número conta, em uma linha. */
  dica: string;
  valor: number | null;
  /** Texto no lugar do número — "Sem leitura", "—". */
  textoNoLugar?: string;
  tom: Tom;
}

function classeDoNumero(cartao: Cartao): string {
  if (cartao.valor === null || cartao.valor === 0) return "text-fg";
  if (cartao.tom === "alerta") return "text-danger-fg";
  if (cartao.tom === "atencao") return "text-warning-fg";
  return "text-fg";
}

function CartaoDoPainel({ cartao }: { cartao: Cartao }) {
  const textoDoValor = cartao.textoNoLugar ?? String(cartao.valor ?? "—");
  return (
    <Link
      href={cartao.href}
      data-testid={`dash-card-${cartao.chave}`}
      aria-label={`${cartao.rotulo}: ${textoDoValor}. Abrir a lista.`}
      className="group flex min-h-[7.25rem] flex-col rounded-2xl border border-border bg-surface p-4 shadow-sm transition-colors hover:border-border-strong hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <span className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-fg-secondary">
          {cartao.rotulo}
        </span>
        <span
          aria-hidden="true"
          className="text-sm text-fg-muted transition-colors group-hover:text-fg-secondary"
        >
          →
        </span>
      </span>
      <span
        data-testid={`dash-value-${cartao.chave}`}
        className={`mt-2 font-bold tabular-nums ${
          cartao.textoNoLugar ? "text-xl text-fg-secondary" : `text-3xl ${classeDoNumero(cartao)}`
        }`}
      >
        {textoDoValor}
      </span>
      <span className="mt-1 text-xs text-fg-muted">{cartao.dica}</span>
    </Link>
  );
}

const DICA_DE_ERRO = "Não foi possível contar agora.";

/**
 * Um cartão a partir da seção que o alimenta.
 *
 * Seção que falhou vira "—" com o motivo — nunca `0`. O cartão continua sendo
 * link: a listagem de destino pode responder mesmo quando a contagem não pôde.
 */
function montarCartao<T>(
  base: Pick<Cartao, "chave" | "rotulo" | "href" | "tom">,
  secao: DashboardSection<T>,
  ler: (dados: T) => number,
  dica: string,
): Cartao {
  if (secao.state === "ok") {
    return { ...base, valor: ler(secao.data), dica };
  }
  return { ...base, valor: null, textoNoLugar: "—", dica: DICA_DE_ERRO };
}

function formatarHora(data: Date, timezone: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  }).format(data);
}

function formatarDataHora(data: Date, timezone: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  }).format(data);
}

export default async function DashboardPage() {
  const session = await requirePageProfile(["ADMIN", "DISPATCHER"]);
  const painel = await getOperationalDashboard({
    companyId: session.companyId,
    profile: session.profile,
  });

  const os = painel.serviceOrders;
  const cartoesDeOs: Cartao[] = [
    montarCartao(
      { chave: "abertas", rotulo: "OS abertas", href: "/ordens?recorte=abertas", tom: "neutro" },
      os,
      (d) => d.abertas,
      "Ainda não concluídas nem canceladas.",
    ),
    montarCartao(
      { chave: "atrasadas", rotulo: "OS atrasadas", href: "/ordens?recorte=atrasadas", tom: "alerta" },
      os,
      (d) => d.atrasadas,
      "Agendamento vencido e ainda não iniciadas.",
    ),
    montarCartao(
      { chave: "hoje", rotulo: "OS de hoje", href: "/ordens?recorte=hoje", tom: "neutro" },
      os,
      (d) => d.hoje,
      "Agendadas para hoje e ainda abertas.",
    ),
    montarCartao(
      { chave: "pendentes", rotulo: "OS pendentes", href: "/ordens?status=PENDING", tom: "atencao" },
      os,
      (d) => d.pendentes,
      "Sem técnico atribuído.",
    ),
  ];

  const cartoesDeEquipeERede: Cartao[] = [
    montarCartao(
      {
        chave: "tecnicos-em-atendimento",
        rotulo: "Técnicos em atendimento",
        href: "/tecnicos?emAtendimento=true",
        tom: "neutro",
      },
      painel.team,
      (d) => d.emAtendimento,
      "Com uma OS iniciada agora.",
    ),
  ];

  const clientes = painel.customers;
  if (clientes.state !== "hidden") {
    const base = {
      chave: "clientes-offline",
      rotulo: "Clientes offline",
      href: "/clientes?active=true&conectividade=OFFLINE",
      tom: "alerta" as const,
    };
    if (clientes.state === "ok" && clientes.data.comLeitura === 0) {
      // "Sem leitura" nunca vira "0 offline": não saber não é estar no ar.
      cartoesDeEquipeERede.push({
        ...base,
        valor: null,
        textoNoLugar: "Sem leitura",
        dica: "Nenhum cliente ativo tem leitura de conectividade ainda.",
      });
    } else {
      cartoesDeEquipeERede.push(
        montarCartao(
          base,
          clientes,
          (d) => d.offline,
          clientes.state === "ok"
            ? `Pela última leitura, de ${clientes.data.comLeitura} com leitura.`
            : "",
        ),
      );
    }
  }

  if (painel.ctos.state !== "hidden") {
    cartoesDeEquipeERede.push(
      montarCartao(
        { chave: "ctos-com-defeito", rotulo: "CTOs com defeito", href: "/ctos?situacao=defeito", tom: "alerta" },
        painel.ctos,
        (d) => d.comDefeito,
        "Ativas, com porta danificada.",
      ),
      montarCartao(
        { chave: "ctos-com-os-abertas", rotulo: "CTOs com OS abertas", href: "/ctos?situacao=com-os-abertas", tom: "neutro" },
        painel.ctos,
        (d) => d.comOsAbertas,
        "Clientes da caixa com OS aberta.",
      ),
    );
  }

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-fg">Dashboard</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Bem-vindo(a), {session.name}.
          </p>
        </div>
        <p className="text-xs text-fg-muted" data-testid="dash-generated-at">
          Situação às {formatarHora(painel.generatedAt, painel.timezone)} ·{" "}
          <Link
            href="/dashboard"
            className="font-semibold text-primary-text hover:text-primary-text-hover"
          >
            Atualizar
          </Link>
        </p>
      </div>

      <section aria-labelledby="dash-os" className="mb-5">
        <h2
          id="dash-os"
          className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted"
        >
          Ordens de serviço
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {cartoesDeOs.map((cartao) => (
            <CartaoDoPainel key={cartao.chave} cartao={cartao} />
          ))}
        </div>
      </section>

      <section aria-labelledby="dash-equipe" className="mb-6">
        <h2
          id="dash-equipe"
          className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted"
        >
          {cartoesDeEquipeERede.length > 1 ? "Equipe e rede" : "Equipe"}
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {cartoesDeEquipeERede.map((cartao) => (
            <CartaoDoPainel key={cartao.chave} cartao={cartao} />
          ))}
        </div>
      </section>

      <div className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <h2 className="mb-4 text-base font-semibold text-fg">
          Atividade recente
        </h2>
        {painel.recentActivity.state !== "ok" ? (
          <p className="text-sm text-fg-muted" data-testid="dash-activity-error">
            Não foi possível carregar a atividade recente agora.
          </p>
        ) : painel.recentActivity.data.length === 0 ? (
          <p className="text-sm text-fg-muted">
            Nenhuma atividade registrada ainda.
          </p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {painel.recentActivity.data.map((item) => (
              <li
                key={item.id}
                className="flex items-center justify-between py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-fg">
                    {item.action}
                  </p>
                  {item.entity && (
                    <p className="truncate text-xs text-fg-muted">
                      {item.entity}
                      {item.userName ? ` · ${item.userName}` : ""}
                    </p>
                  )}
                </div>
                <span className="ml-4 shrink-0 text-xs text-fg-muted">
                  {formatarDataHora(item.createdAt, painel.timezone)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

import { formatBrazilianPhone } from "@/integrations/service-tickets";
import {
  formatarEndereco,
  linksDeNavegacao,
  type LocalizacaoCliente,
} from "@/lib/map-links";

/**
 * Cliente, contato e localização — o bloco que responde às três primeiras
 * perguntas do técnico ao abrir a OS: quem é, como falo com ele, onde fica.
 *
 * Não é um resumo do cadastro. Documento, e-mail e identificadores ficaram de
 * fora porque nenhum deles muda o que o técnico faz nos próximos dez minutos.
 */

interface Telefone {
  rotulo: string;
  numero: string;
  testId: string;
}

interface CustomerContactCardProps {
  name: string;
  phone: string | null;
  secondaryPhone: string | null;
  local: LocalizacaoCliente;
  /**
   * `document` e cidade/UF isolados só interessam a quem faz triagem no
   * escritório. O técnico já tem o endereço inteiro.
   */
  document?: string | null;
  mostrarDocumento?: boolean;
}

export function CustomerContactCard({
  name,
  phone,
  secondaryPhone,
  local,
  document,
  mostrarDocumento = false,
}: CustomerContactCardProps) {
  /*
    Os dois telefones entram numa lista, e não em campos fixos.

    Isso resolve o caso do cadastro que tem só o alternativo preenchido: em
    campos fixos ele apareceria como "Telefone: não informado" logo acima de um
    número que existe e funciona. Numa lista, o que existe aparece; o que não
    existe não ocupa linha.
  */
  const telefones: Telefone[] = [];
  if (phone) {
    telefones.push({
      rotulo: "Telefone",
      numero: phone,
      testId: "customer-phone",
    });
  }
  if (secondaryPhone) {
    telefones.push({
      rotulo: phone ? "Telefone alternativo" : "Telefone",
      numero: secondaryPhone,
      testId: "customer-secondary-phone",
    });
  }

  const endereco = formatarEndereco(local);
  const navegacao = linksDeNavegacao(local);

  return (
    <section
      data-testid="customer-card"
      className="rounded-2xl border border-border bg-surface p-5 shadow-sm"
    >
      <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
        Cliente
      </h2>
      <p
        data-testid="customer-name"
        className="mt-1 text-lg font-semibold text-fg"
      >
        {name}
      </p>
      {mostrarDocumento && document && (
        <p className="mt-0.5 text-sm text-fg-muted">{document}</p>
      )}

      {/*
        Uma única mensagem de ausência para o conjunto inteiro, não uma por
        campo. Duas linhas dizendo "não informado" fazem o olho parar de ler a
        região — inclusive no dia em que uma delas tiver número.
      */}
      {telefones.length === 0 ? (
        <p className="mt-3 text-sm text-fg-muted">Telefone não informado.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {telefones.map((tel) => (
            <li key={tel.testId}>
              <p className="text-xs font-medium text-fg-muted">{tel.rotulo}</p>
              {/*
                Alvo de toque de 44px de altura: quem liga está em pé, na rua,
                às vezes de luva. Um link do tamanho do texto erra o dedo.
              */}
              <a
                data-testid={tel.testId}
                href={`tel:${tel.numero}`}
                className="-mx-1 mt-0.5 inline-flex min-h-[44px] items-center rounded-lg px-1 text-base font-semibold text-primary-text transition-colors hover:bg-surface-subtle hover:text-primary-text-hover"
              >
                {formatBrazilianPhone(tel.numero) ?? tel.numero}
              </a>
            </li>
          ))}
        </ul>
      )}

      {endereco && (
        <div className="mt-3">
          <p className="text-xs font-medium text-fg-muted">Endereço</p>
          {/*
            Endereço quebra naturalmente. Truncar com reticências esconde
            justamente o complemento — "fundos", "bloco B" — que decide se o
            técnico encontra a porta.
          */}
          <p
            data-testid="customer-address"
            className="mt-0.5 text-sm leading-relaxed text-fg"
          >
            {endereco}
          </p>
        </div>
      )}

      {navegacao && (
        <div className="mt-3 flex flex-wrap gap-2">
          {/*
            `rel="noreferrer"` para não vazar a URL da OS — que carrega o id
            interno — no `Referer` enviado ao Google e ao Waze.

            A coordenada vai apenas dentro do href. Latitude e longitude cruas
            na tela não ajudam ninguém a chegar num lugar e ocupam a linha onde
            deveria estar o endereço.
          */}
          <a
            data-testid="nav-google-maps"
            href={navegacao.googleMaps}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-lg border border-input-border px-4 text-sm font-semibold text-fg-secondary transition-colors hover:bg-surface-subtle"
          >
            Google Maps
          </a>
          <a
            data-testid="nav-waze"
            href={navegacao.waze}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-lg border border-input-border px-4 text-sm font-semibold text-fg-secondary transition-colors hover:bg-surface-subtle"
          >
            Waze
          </a>
        </div>
      )}

      {/*
        Sem coordenada confirmada, dizer isso é mais honesto do que deixar o
        técnico assumir que o ponto do mapa foi conferido por alguém. A
        confirmação em campo é capability futura (PRD §172); até lá, a
        navegação por endereço é a que existe.
      */}
      {navegacao?.origem === "endereco" && (
        <p className="mt-2 text-xs text-fg-muted">
          Navegação pelo endereço — sem coordenada cadastrada.
        </p>
      )}
    </section>
  );
}

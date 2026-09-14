import Link from "next/link";
import type { CustomerLocationCard as CardData } from "@/lib/customer-location-card";
import {
  LOCATION_SOURCE_LABELS,
  formatCoordinate,
} from "@/lib/customer-location-presentation";
import { formatCompanyDateTime } from "@/lib/company-datetime";
import { formatServiceOrderNumber } from "@/lib/service-order-labels";
import { StatusPill } from "@/components/StatusPill";

/**
 * # "Localização do cliente" — o cartão da ficha (RC-LOC-03)
 *
 * Somente leitura, para o ADMIN. Mostra o que a AUTORIDADE geográfica diz —
 * existe ponto, onde, com que precisão, de onde veio, se foi conferido, quando
 * mudou, quem e em que OS — e leva ao Mapa Operacional. Não há campo de
 * latitude nem de longitude para editar: mover o ponto é "Corrigir
 * localização", no Field, com GPS e trilha.
 *
 * Componente de servidor: nada aqui roda no navegador, e nada é buscado daqui.
 */
export function CustomerLocationCard({ card }: { card: CardData }) {
  return (
    <section
      aria-labelledby="localizacao-titulo"
      data-testid="customer-location-card"
      data-state={card.state}
      className="rounded-2xl border border-border bg-surface p-6 shadow-sm"
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="localizacao-titulo" className="text-base font-semibold text-fg">
            Localização do cliente
          </h2>
          <p className="mt-1 text-sm text-fg-muted">
            Somente leitura. O ponto é conferido ou corrigido em campo, pelo técnico, com o GPS
            do aparelho.
          </p>
        </div>
        {card.state === "PRESENT" && card.mapHref && (
          <Link
            data-testid="customer-location-map-link"
            href={card.mapHref}
            className="inline-flex min-h-[2.5rem] shrink-0 items-center rounded-lg border border-border bg-surface px-4 text-sm font-semibold text-fg transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            Ver no mapa
          </Link>
        )}
      </div>

      {card.state === "MISSING" ? (
        <div data-testid="customer-location-missing">
          <StatusPill tone="neutral" label="Sem localização geográfica cadastrada" />
          <p className="mt-3 text-sm text-fg-secondary">
            {card.hasAddress
              ? "O endereço textual existe, mas este cliente ainda não possui uma posição geográfica confirmada no AlfaOS."
              : "Este cliente ainda não possui uma posição geográfica no AlfaOS."}
          </p>
          {card.hasLegacyProjection && (
            <p
              data-testid="customer-location-legacy"
              className="mt-2 text-sm text-fg-muted"
            >
              O cadastro traz uma coordenada antiga, anterior ao registro de localização do
              AlfaOS. Ela não aparece no Mapa Operacional e nunca foi conferida em campo.
            </p>
          )}
        </div>
      ) : (
        <div>
          <StatusPill tone="info" label="Localização cadastrada" />
          <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            <Linha rotulo="Latitude" testId="customer-location-latitude" mono>
              {formatCoordinate(card.latitude)}
            </Linha>
            <Linha rotulo="Longitude" testId="customer-location-longitude" mono>
              {formatCoordinate(card.longitude)}
            </Linha>
            <Linha rotulo="Precisão" testId="customer-location-accuracy">
              {card.accuracyMeters !== null ? `${card.accuracyMeters} m` : "Não informada"}
            </Linha>
            <Linha rotulo="Origem" testId="customer-location-source">
              {LOCATION_SOURCE_LABELS[card.source]}
            </Linha>
            <Linha rotulo="Verificada" testId="customer-location-verified">
              <StatusPill
                tone={card.verified ? "success" : "warning"}
                label={card.verified ? "Sim" : "Não"}
              />
            </Linha>
            <Linha rotulo="Atualizada em" testId="customer-location-updated">
              {formatCompanyDateTime(card.updatedAt, card.timezone)}
            </Linha>
            {card.technicianName && (
              <Linha rotulo="Técnico" testId="customer-location-technician">
                {card.technicianName}
              </Linha>
            )}
            {card.order && (
              <Linha rotulo="OS" testId="customer-location-order">
                <Link
                  href={`/ordens/${card.order.id}`}
                  className="font-medium text-primary-text hover:text-primary-text-hover"
                >
                  {formatServiceOrderNumber(card.order)}
                </Link>
              </Linha>
            )}
          </dl>
        </div>
      )}
    </section>
  );
}

function Linha({
  rotulo,
  testId,
  mono = false,
  children,
}: {
  rotulo: string;
  testId: string;
  mono?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-fg-muted">{rotulo}</dt>
      <dd
        data-testid={testId}
        // Coordenada é número longo: `break-all` e algarismos tabulares impedem
        // que ela estoure a coluna no celular.
        className={`mt-0.5 text-sm text-fg ${mono ? "break-all font-mono tabular-nums" : "break-words"}`}
      >
        {children}
      </dd>
    </div>
  );
}

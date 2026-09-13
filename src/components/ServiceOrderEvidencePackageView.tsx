import Link from "next/link";
import { formatCompanyDateTime, formatCompanyTime } from "@/lib/company-datetime";
import { formatMaterialQuantity, MATERIAL_UNIT_LABELS } from "@/lib/material-format";
import type {
  EvidencePackagePhoto,
  EvidencePackageSection,
  ServiceOrderEvidencePackage,
} from "@/lib/service-order-evidence-package";
import {
  checkInAccuracyText,
  checkInLocationText,
  checklistAnswerText,
  durationText,
  evidenceCategoryLabel,
  groupPhotosByCategory,
  integrityText,
  locationChangeText,
  signatureBindingText,
  type StatusText,
} from "@/lib/service-order-evidence-package-presentation";

/**
 * O pacote técnico de uma OS concluída — EV-1 (PRD §383).
 *
 * Renderizado no servidor, sem estado no cliente. Três estados que não se
 * confundem: ERRO diz que não foi possível carregar; NÃO CONCLUÍDA diz que o
 * pacote ainda não existe (nada parcial é chamado de prova); e o PACOTE, na
 * ordem em que se confere um atendimento.
 *
 * Toda imagem sai pelas rotas autorizadas da OS — nunca por chave de
 * armazenamento —, e nenhuma coordenada vira texto.
 */
export function ServiceOrderEvidencePackageView({
  orderId,
  section,
}: {
  orderId: string;
  section: Exclude<EvidencePackageSection, { state: "not-found" }>;
}) {
  const numero =
    section.state === "ok"
      ? section.data.order.number
      : section.state === "not-completed"
        ? section.order.number
        : null;

  return (
    <div data-testid="evidence-package" className="mx-auto max-w-4xl">
      <div className="mb-6">
        <Link
          href={`/ordens/${encodeURIComponent(orderId)}`}
          data-testid="evidence-package-back"
          className="text-sm font-medium text-primary-text hover:text-primary-text-hover"
        >
          {numero !== null ? `← Voltar para OS Nº ${numero}` : "← Voltar para a OS"}
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-fg">Pacote técnico</h1>
        {section.state === "ok" && (
          <p className="mt-1 text-sm font-medium text-fg-secondary">
            OS Nº {section.data.order.number} · {section.data.order.type}
            {section.data.order.subtype ? ` · ${section.data.order.subtype}` : ""}
          </p>
        )}
      </div>

      {section.state === "error" && (
        <p
          role="alert"
          data-testid="evidence-package-error"
          className="rounded-2xl border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger-fg"
        >
          Não foi possível carregar o pacote técnico agora. Recarregue a página para tentar de
          novo.
        </p>
      )}

      {section.state === "not-completed" && (
        <div
          data-testid="evidence-package-not-completed"
          className="rounded-2xl border border-border bg-surface p-5 text-sm text-fg-secondary shadow-sm"
        >
          <p className="font-semibold text-fg">O atendimento ainda não foi concluído.</p>
          <p className="mt-1">
            O pacote técnico reúne o que comprova o atendimento, e só existe depois da conclusão —
            antes disso o conteúdo ainda pode mudar.
          </p>
        </div>
      )}

      {section.state === "ok" && <PackageBody data={section.data} />}
    </div>
  );
}

function PackageBody({ data }: { data: ServiceOrderEvidencePackage }) {
  const tz = data.timezone;
  const duracao = durationText(data.order.startedAt, data.order.completedAt);

  return (
    <div className="space-y-4">
      <Card title="Atendimento" testId="package-summary">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          <Field label="Cliente" testId="package-customer">
            <span className="font-medium text-fg">{data.customer.name}</span>
            {data.customer.address && (
              <span className="block text-fg-secondary">{data.customer.address}</span>
            )}
          </Field>
          <Field label="Técnico" testId="package-technician">
            {data.technicianName ?? "—"}
          </Field>
          <Field label="Concluída em" testId="package-completed-at">
            {data.order.completedAt ? formatCompanyDateTime(data.order.completedAt, tz) : "—"}
          </Field>
        </dl>
      </Card>

      <Card title="Conferência" testId="package-integrity">
        <ul className="space-y-3">
          <StatusRow status={integrityText(data.integrity)} testId="package-integrity-content" />
          <StatusRow
            status={signatureBindingText(data.signatureBinding)}
            testId="package-integrity-signature"
          />
        </ul>
      </Card>

      <Card title="Horário" testId="package-times">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <Field label="Início">
            {data.order.startedAt ? formatCompanyTime(data.order.startedAt, tz) : "—"}
          </Field>
          <Field label="Check-in">
            {data.checkIn ? formatCompanyTime(data.checkIn.checkedInAt, tz) : "—"}
          </Field>
          <Field label="Conclusão">
            {data.order.completedAt ? formatCompanyTime(data.order.completedAt, tz) : "—"}
          </Field>
          <Field label="Duração">{duracao ?? "—"}</Field>
        </dl>
      </Card>

      <Card title="Localização" testId="package-location">
        {data.checkIn ? (
          <div data-testid="package-checkin">
            <p className="text-sm font-medium text-fg">
              Check-in realizado às {formatCompanyTime(data.checkIn.checkedInAt, tz)}
              {data.checkIn.withDeviceLocation ? " · com GPS do aparelho" : " · sem GPS"}
            </p>
            <p className="mt-0.5 text-sm text-fg-secondary">{checkInLocationText(data.checkIn)}</p>
            {checkInAccuracyText(data.checkIn) && (
              <p className="mt-0.5 text-xs text-fg-muted">{checkInAccuracyText(data.checkIn)}</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-fg-muted" data-testid="package-checkin-none">
            Sem check-in registrado.
          </p>
        )}
        {data.locationChanges.length > 0 && (
          <ul className="mt-3 space-y-2 border-t border-border-subtle pt-3" data-testid="package-location-changes">
            {data.locationChanges.map((change) => {
              const texto = locationChangeText(change);
              return (
                <li key={change.id} className="text-sm">
                  <span className="font-medium text-fg">{texto.title}</span>
                  <span className="text-fg-secondary">
                    {" "}
                    às {formatCompanyTime(change.occurredAt, tz)}
                    {texto.reason ? ` · ${texto.reason}` : ""}
                    {change.actorName ? ` · ${change.actorName}` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title="Relatório do atendimento" testId="package-report">
        <dl className="space-y-4">
          {(
            [
              ["Diagnóstico", data.execution?.diagnosis],
              ["Serviço realizado", data.execution?.workPerformed],
              ["Observações", data.execution?.notes],
            ] as const
          ).map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs font-medium text-fg-muted">{label}</dt>
              <dd className="mt-0.5 whitespace-pre-wrap break-words text-sm text-fg">
                {value?.trim() ? value : "—"}
              </dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card title="Checklist" testId="package-checklist">
        {data.checklist.length === 0 ? (
          <p className="text-sm text-fg-muted">Esta OS não tinha checklist.</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {data.checklist.map((item) => (
              <li
                key={item.id}
                className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
                data-testid="package-checklist-item"
              >
                <span className="min-w-0 break-words text-sm text-fg">
                  {item.label}
                  {item.required && (
                    <span className="ml-2 text-xs font-medium text-fg-muted">(obrigatório)</span>
                  )}
                </span>
                <span className="break-words text-sm font-medium text-fg-secondary sm:text-right">
                  {checklistAnswerText(item.answer)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Fotos" testId="package-photos">
        {data.photos.length === 0 ? (
          <p className="text-sm text-fg-muted">Nenhuma foto além das medições e etiquetas.</p>
        ) : (
          <div className="space-y-4">
            {groupPhotosByCategory(data.photos).map((grupo) => (
              <div key={grupo.category} data-testid="package-photo-group">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">
                  {grupo.label} ({grupo.photos.length})
                </h3>
                <PhotoGrid photos={grupo.photos} tz={tz} />
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Medições" testId="package-measurements">
        <p className="mb-3 text-xs text-fg-muted">
          O AlfaOS registra a foto do resultado; nenhum valor é digitado ou calculado.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <MeasurementBlock
            title="Teste de velocidade"
            empty="Nenhuma foto de teste de velocidade."
            photos={data.measurements.speedTests}
            tz={tz}
            testId="package-speed-tests"
          />
          <MeasurementBlock
            title="Leitura óptica"
            empty="Nenhuma foto de leitura óptica."
            photos={data.measurements.opticalReadings}
            tz={tz}
            testId="package-optical-readings"
          />
        </div>
      </Card>

      <Card title="Equipamentos" testId="package-equipments">
        {data.equipments.length === 0 ? (
          <p className="text-sm text-fg-muted">Nenhum equipamento registrado.</p>
        ) : (
          <ul className="space-y-4">
            {data.equipments.map((q) => (
              <li
                key={q.id}
                className="flex flex-col gap-3 sm:flex-row"
                data-testid="package-equipment"
              >
                <div className="min-w-0 flex-1 text-sm">
                  <p className="font-medium text-fg">
                    {q.equipmentType}
                    {[q.manufacturer, q.model].filter(Boolean).length > 0 && (
                      <span className="font-normal text-fg-secondary">
                        {" "}
                        · {[q.manufacturer, q.model].filter(Boolean).join(" ")}
                      </span>
                    )}
                  </p>
                  <dl className="mt-1 space-y-0.5 text-fg-secondary">
                    {q.serial && (
                      <div>
                        <dt className="inline">Série: </dt>
                        <dd className="inline break-all font-mono text-xs">{q.serial}</dd>
                      </div>
                    )}
                    {q.macAddress && (
                      <div>
                        <dt className="inline">MAC: </dt>
                        <dd className="inline break-all font-mono text-xs">{q.macAddress}</dd>
                      </div>
                    )}
                    <div className="text-xs text-fg-muted">
                      Registrado às {formatCompanyTime(q.installedAt, tz)}
                      {q.installedByName ? ` · ${q.installedByName}` : ""}
                    </div>
                  </dl>
                </div>
                {q.label && (
                  <figure className="w-full shrink-0 sm:w-44">
                    <Photo photo={q.label} alt={`Etiqueta do equipamento ${q.equipmentType}`} />
                    <figcaption className="mt-1 text-xs text-fg-muted">Etiqueta</figcaption>
                  </figure>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Materiais" testId="package-materials">
        {data.materials.length === 0 ? (
          <p className="text-sm text-fg-muted">Nenhum material registrado.</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {data.materials.map((m) => (
              <li key={m.id} className="flex justify-between gap-3 py-2">
                <span className="min-w-0 flex-1 break-words text-sm text-fg">{m.description}</span>
                <span className="shrink-0 text-sm text-fg-secondary">
                  {formatMaterialQuantity(m.quantity)} {MATERIAL_UNIT_LABELS[m.unit] ?? m.unit}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Assinatura do cliente" testId="package-signature">
        {data.signature ? (
          <div>
            <p className="text-sm font-medium text-fg">{data.signature.signerName}</p>
            <p className="text-xs text-fg-muted">
              Assinada às {formatCompanyTime(data.signature.signedAt, tz)}
              {data.signature.capturedByName ? ` · coletada por ${data.signature.capturedByName}` : ""}
            </p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={data.signature.url}
              alt={`Assinatura de ${data.signature.signerName}`}
              className="mt-2 h-32 w-full max-w-md rounded-xl border border-border bg-surface object-contain"
            />
          </div>
        ) : (
          <p className="text-sm text-fg-muted">Assinatura não coletada.</p>
        )}
      </Card>
    </div>
  );
}

function Card({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      aria-label={title}
      className="rounded-2xl border border-border bg-surface p-5 shadow-sm"
    >
      <h2 className="mb-3 text-base font-semibold text-fg">{title}</h2>
      {children}
    </section>
  );
}

function Field({
  label,
  testId,
  children,
}: {
  label: string;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <div data-testid={testId}>
      <dt className="text-xs font-medium text-fg-muted">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-fg">{children}</dd>
    </div>
  );
}

const TONE: Record<StatusText["tone"], { box: string; glyph: string }> = {
  ok: { box: "border-success-border bg-success-bg text-success-fg", glyph: "✓" },
  warning: { box: "border-warning-border bg-warning-bg text-warning-fg", glyph: "!" },
  neutral: { box: "border-border bg-surface-muted text-fg-secondary", glyph: "–" },
};

function StatusRow({ status, testId }: { status: StatusText; testId: string }) {
  const tom = TONE[status.tone];
  return (
    <li
      data-testid={testId}
      data-tone={status.tone}
      role={status.tone === "warning" ? "alert" : undefined}
      className={`flex gap-3 rounded-xl border px-3 py-2 ${tom.box}`}
    >
      <span aria-hidden="true" className="w-4 shrink-0 text-center font-bold">
        {tom.glyph}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{status.title}</span>
        <span className="block text-xs">{status.description}</span>
      </span>
    </li>
  );
}

function Photo({ photo, alt }: { photo: EvidencePackagePhoto; alt: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={photo.url}
      alt={alt}
      loading="lazy"
      className="h-40 w-full rounded-xl border border-border bg-surface-muted object-contain"
    />
  );
}

function PhotoGrid({ photos, tz }: { photos: EvidencePackagePhoto[]; tz: string }) {
  return (
    <ul className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 sm:grid-cols-3">
      {photos.map((photo) => (
        <li key={photo.id} data-testid="package-photo" data-category={photo.category}>
          <figure>
            <Photo
              photo={photo}
              alt={`Foto — ${evidenceCategoryLabel(photo.category)}, registrada às ${formatCompanyTime(photo.recordedAt, tz)}`}
            />
            <figcaption className="mt-1 text-xs text-fg-muted">
              Registrada às {formatCompanyTime(photo.recordedAt, tz)}
              {photo.uploadedByName ? ` · ${photo.uploadedByName}` : ""}
              {photo.caption && (
                <span className="mt-0.5 block break-words text-fg-secondary">{photo.caption}</span>
              )}
            </figcaption>
          </figure>
        </li>
      ))}
    </ul>
  );
}

function MeasurementBlock({
  title,
  empty,
  photos,
  tz,
  testId,
}: {
  title: string;
  empty: string;
  photos: EvidencePackagePhoto[];
  tz: string;
  testId: string;
}) {
  return (
    <div data-testid={testId}>
      <h3 className="mb-2 text-sm font-semibold text-fg">{title}</h3>
      {photos.length === 0 ? (
        <p className="text-sm text-fg-muted">{empty}</p>
      ) : (
        <ul className="space-y-3">
          {photos.map((photo) => (
            <li key={photo.id} data-testid="package-photo" data-category={photo.category}>
              <figure>
                <Photo
                  photo={photo}
                  alt={`${title} — foto do resultado, registrada às ${formatCompanyTime(photo.recordedAt, tz)}`}
                />
                <figcaption className="mt-1 text-xs text-fg-muted">
                  Foto do resultado · registrada às {formatCompanyTime(photo.recordedAt, tz)}
                  {photo.uploadedByName ? ` · ${photo.uploadedByName}` : ""}
                  {photo.caption && (
                    <span className="mt-0.5 block break-words text-fg-secondary">{photo.caption}</span>
                  )}
                </figcaption>
              </figure>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

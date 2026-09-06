"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { PublicCtoDetail } from "@/lib/cto";

const inputClass =
  "w-full rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft";

const labelClass = "mb-1 block text-sm font-medium text-fg-secondary";

const STATE_LABELS: Record<string, string> = {
  FREE: "Livre",
  OCCUPIED: "Ocupada",
  RESERVED: "Reservada",
  DAMAGED: "Danificada",
};

const STATE_CLASSES: Record<string, string> = {
  FREE: "bg-success-bg text-success-text",
  OCCUPIED: "bg-info-bg text-primary-text",
  RESERVED: "bg-warning-bg text-warning-text",
  DAMAGED: "bg-danger-bg text-danger-text",
};

export function CtoDetailManager({ cto }: { cto: PublicCtoDetail }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState(cto.name);
  const [addressReference, setAddressReference] = useState(
    cto.addressReference ?? "",
  );
  const [notes, setNotes] = useState(cto.notes ?? "");
  const [latitude, setLatitude] = useState(cto.latitude ?? "");
  const [longitude, setLongitude] = useState(cto.longitude ?? "");
  const [capacity, setCapacity] = useState(String(cto.capacity));

  async function send(url: string, body: unknown, method = "POST") {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(payload?.error ?? "Não foi possível concluir a operação.");
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError("Erro de conexão. Tente novamente.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveDetails(e: React.FormEvent) {
    e.preventDefault();
    const hasLat = latitude.trim().length > 0;
    const hasLon = longitude.trim().length > 0;
    if (hasLat !== hasLon) {
      setError("Informe latitude e longitude juntas, ou nenhuma das duas.");
      return;
    }
    /*
      Texto que não é número FINITO precisa ser barrado AQUI, e a razão é do
      transporte, não da tela.

      `JSON.stringify` converte `NaN` **e** `Infinity` em `null`. O servidor
      recebe `null`, que é a forma legítima de dizer "remova a coordenada" — e
      não tem como distinguir uma da outra. Mandar o valor cru transformaria
      "digitei errado" em "apague as coordenadas", em silêncio e com resposta
      200.

      A primeira versão desta guarda usava `Number.isNaN`, o que fechava
      `"abc"` e deixava `"Infinity"` passar inteiro — `Number.isNaN(Infinity)`
      é `false`. `Number.isFinite` cobre os dois, e é o único predicado que
      corresponde ao que o `JSON.stringify` de fato descarta.
    */
    const lat = hasLat ? Number(latitude) : null;
    const lon = hasLon ? Number(longitude) : null;
    if ((hasLat && !Number.isFinite(lat)) || (hasLon && !Number.isFinite(lon))) {
      setError("Latitude e longitude devem ser números válidos.");
      return;
    }
    await send(
      `/api/ctos/${cto.id}`,
      {
        name,
        addressReference: addressReference.trim() || null,
        notes: notes.trim() || null,
        latitude: lat,
        longitude: lon,
      },
      "PATCH",
    );
  }

  async function handleCapacity(e: React.FormEvent) {
    e.preventDefault();
    const parsed = Number(capacity);
    if (!Number.isInteger(parsed) || parsed < 1) {
      setError("Capacidade deve ser um número inteiro maior que zero.");
      return;
    }
    await send(`/api/ctos/${cto.id}/capacity`, { capacity: parsed });
  }

  async function handlePortState(portId: string, state: string) {
    await send(`/api/ctos/${cto.id}/ports/${portId}/state`, {
      administrativeState: state,
    });
  }

  async function handlePhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/ctos/${cto.id}/photo`, {
        method: "POST",
        body: form,
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(payload?.error ?? "Falha ao enviar a foto.");
        return;
      }
      router.refresh();
    } catch {
      setError("Erro de conexão. Tente novamente.");
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <p
          className="rounded-lg border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger-text"
          role="alert"
          data-testid="cto-error"
        >
          {error}
        </p>
      )}

      {/*
        Ocupação é honesta: não há vínculo de cliente no produto ainda, então o
        contador de ocupadas é zero e a nota diz por quê. Inventar um número, ou
        esconder a linha, faria a tela prometer o que a CTO-1 não entrega.
      */}
      <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <h2 className="mb-4 text-base font-semibold text-fg">Ocupação</h2>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          <div>
            <dt className="text-xs text-fg-muted">Capacidade</dt>
            <dd className="text-xl font-semibold text-fg">
              {cto.summary.capacity}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-fg-muted">Livres</dt>
            <dd className="text-xl font-semibold text-fg" data-testid="cto-free">
              {cto.summary.free}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-fg-muted">Reservadas</dt>
            <dd className="text-xl font-semibold text-fg">
              {cto.summary.reserved}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-fg-muted">Danificadas</dt>
            <dd className="text-xl font-semibold text-fg">
              {cto.summary.damaged}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-fg-muted">Ocupadas</dt>
            <dd className="text-xl font-semibold text-fg">
              {cto.summary.occupied}
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-fg-muted">
          A vinculação de clientes a portas ainda não está disponível. Enquanto
          isso, nenhuma porta aparece como ocupada.
        </p>
      </section>

      <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <h2 className="mb-4 text-base font-semibold text-fg">Portas</h2>
        <div className="space-y-2">
          {cto.ports.map((port) => (
            <div
              key={port.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2"
              data-testid="cto-port-row"
            >
              <span className="w-16 text-sm font-medium text-fg">
                {String(port.number).padStart(2, "0")}
              </span>
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATE_CLASSES[port.effectiveState]}`}
                data-testid={`cto-port-state-${port.number}`}
              >
                {STATE_LABELS[port.effectiveState]}
              </span>
              {!port.offerable && port.number > cto.capacity && (
                <span
                  className="rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium text-fg-muted"
                  title="Acima da capacidade atual. Mantida para preservar o histórico."
                >
                  Fora da capacidade
                </span>
              )}
              <div className="ml-auto flex gap-2">
                <button
                  type="button"
                  disabled={busy || port.administrativeState === "AVAILABLE"}
                  onClick={() => handlePortState(port.id, "AVAILABLE")}
                  className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-fg-secondary transition-colors hover:bg-surface-muted disabled:opacity-40"
                >
                  Liberar
                </button>
                <button
                  type="button"
                  disabled={busy || port.administrativeState === "RESERVED"}
                  onClick={() => handlePortState(port.id, "RESERVED")}
                  className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-fg-secondary transition-colors hover:bg-surface-muted disabled:opacity-40"
                >
                  Reservar
                </button>
                <button
                  type="button"
                  disabled={busy || port.administrativeState === "DAMAGED"}
                  onClick={() => handlePortState(port.id, "DAMAGED")}
                  className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-fg-secondary transition-colors hover:bg-surface-muted disabled:opacity-40"
                >
                  Danificada
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <form
        onSubmit={handleCapacity}
        className="rounded-2xl border border-border bg-surface p-5 shadow-sm"
      >
        <h2 className="mb-4 text-base font-semibold text-fg">Capacidade</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-40">
            <label className={labelClass} htmlFor="cto-capacity-edit">
              Portas
            </label>
            <input
              id="cto-capacity-edit"
              type="number"
              min={1}
              max={256}
              className={inputClass}
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
            />
          </div>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-fg transition-colors hover:bg-primary-hover disabled:opacity-60"
          >
            Alterar capacidade
          </button>
        </div>
        <p className="mt-3 text-xs text-fg-muted">
          Aumentar cria as portas que faltam. Reduzir não apaga portas: as que
          ficam acima da capacidade são preservadas como histórico e deixam de
          ser oferecidas. A redução é recusada se alguma delas estiver reservada
          ou danificada.
        </p>
      </form>

      <form
        onSubmit={handleSaveDetails}
        className="rounded-2xl border border-border bg-surface p-5 shadow-sm"
      >
        <h2 className="mb-4 text-base font-semibold text-fg">Dados da caixa</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="cto-name-edit">
              Nome
            </label>
            <input
              id="cto-name-edit"
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="cto-code-view">
              Código
            </label>
            <input
              id="cto-code-view"
              className={`${inputClass} opacity-60`}
              value={cto.code ?? "—"}
              readOnly
              disabled
            />
            <p className="mt-1 text-xs text-fg-muted">
              O código não pode ser alterado depois da criação.
            </p>
          </div>
          <div>
            <label className={labelClass} htmlFor="cto-lat">
              Latitude
            </label>
            <input
              id="cto-lat"
              className={inputClass}
              value={latitude}
              onChange={(e) => setLatitude(e.target.value)}
              placeholder="-23.5505199"
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="cto-lon">
              Longitude
            </label>
            <input
              id="cto-lon"
              className={inputClass}
              value={longitude}
              onChange={(e) => setLongitude(e.target.value)}
              placeholder="-46.6333094"
            />
          </div>
          <div className="md:col-span-2">
            <label className={labelClass} htmlFor="cto-address-edit">
              Referência de endereço
            </label>
            <input
              id="cto-address-edit"
              className={inputClass}
              value={addressReference}
              onChange={(e) => setAddressReference(e.target.value)}
              maxLength={200}
            />
          </div>
          <div className="md:col-span-2">
            <label className={labelClass} htmlFor="cto-notes">
              Observações
            </label>
            <textarea
              id="cto-notes"
              className={inputClass}
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={500}
            />
          </div>
        </div>
        <button
          type="submit"
          disabled={busy}
          className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-fg transition-colors hover:bg-primary-hover disabled:opacity-60"
        >
          Salvar
        </button>
      </form>

      <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <h2 className="mb-4 text-base font-semibold text-fg">Foto da caixa</h2>
        <p className="mb-3 text-sm text-fg-secondary">
          {cto.hasPhoto
            ? "Esta CTO já tem uma foto. Enviar outra substitui a atual."
            : "Nenhuma foto enviada. É opcional."}
        </p>
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={handlePhoto}
          disabled={busy}
          className="text-sm text-fg-secondary"
          data-testid="cto-photo-input"
        />
      </section>

      <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <h2 className="mb-2 text-base font-semibold text-fg">Situação</h2>
        <p className="mb-4 text-sm text-fg-secondary">
          Inativar mantém a caixa e todo o histórico dela. Não existe exclusão
          de CTO.
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            send(`/api/ctos/${cto.id}/active`, { active: !cto.active })
          }
          className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-fg-secondary transition-colors hover:bg-surface-muted disabled:opacity-60"
        >
          {cto.active ? "Inativar CTO" : "Reativar CTO"}
        </button>
      </section>
    </div>
  );
}

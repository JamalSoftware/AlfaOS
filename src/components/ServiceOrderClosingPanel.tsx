"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { SignatureCanvas, canvasToPngBlob } from "./SignatureCanvas";
import {
  formatMaterialQuantity,
  MATERIAL_UNIT_LABELS,
} from "@/lib/material-format";

export interface ClosingEvidence {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface ClosingMaterial {
  id: string;
  description: string;
  quantity: string;
  unit: string;
}

export interface ClosingSignature {
  id: string;
  signerName: string;
}

const UNIT_OPTIONS = [
  { value: "UNIT", label: "un" },
  { value: "METER", label: "m" },
  { value: "KILOGRAM", label: "kg" },
  { value: "LITER", label: "L" },
];

/**
 * The technician's closing workspace: evidence, materials, signature and the
 * final action.
 *
 * ONE component owns `orderVersion` for all of them. Every child mutation
 * bumps `ServiceOrder.version` server-side (that is what makes
 * `child × complete` deterministic), so separate panels each holding their own
 * copy would immediately disagree and 409 against each other. Keeping the
 * version in one place means one mutation informs the next.
 *
 * The version is advanced locally by +1 on success — the same amount the
 * server's compare-and-set applied — and `router.refresh()` reconciles with
 * the server afterwards. If anything else moved the order in between, the next
 * request 409s and the user is told to reload, which is the conservative
 * direction.
 */
export function ServiceOrderClosingPanel({
  orderId,
  initialOrderVersion,
  executionVersion,
  evidences,
  materials,
  signature,
  canComplete,
  blockedReason,
}: {
  orderId: string;
  initialOrderVersion: number;
  executionVersion: number;
  evidences: ClosingEvidence[];
  materials: ClosingMaterial[];
  signature: ClosingSignature | null;
  canComplete: boolean;
  blockedReason: string | null;
}) {
  const router = useRouter();
  const [version, setVersion] = useState(initialOrderVersion);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [materialDescription, setMaterialDescription] = useState("");
  const [materialQuantity, setMaterialQuantity] = useState("1");
  const [materialUnit, setMaterialUnit] = useState("UNIT");

  const [signerName, setSignerName] = useState(signature?.signerName ?? "");
  const [hasDrawing, setHasDrawing] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const disabled = busy !== null || Boolean(blockedReason);

  /** Single place where a mutation result updates local state. */
  async function run(
    key: string,
    fn: () => Promise<Response>,
    successMessage: string,
  ) {
    if (busy) return;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const res = await fn();
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(payload?.error ?? "Não foi possível concluir a operação.");
        return false;
      }
      setVersion((v) => v + 1);
      setNotice(successMessage);
      router.refresh();
      return true;
    } catch {
      setError("Erro de conexão. Tente novamente.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function uploadEvidence(file: File) {
    const form = new FormData();
    form.set("file", file);
    form.set("expectedOrderVersion", String(version));
    const ok = await run(
      "evidence",
      () =>
        fetch(`/api/service-orders/${orderId}/evidence`, {
          method: "POST",
          body: form,
        }),
      "Foto adicionada.",
    );
    if (ok && fileRef.current) fileRef.current.value = "";
  }

  async function removeEvidence(evidenceId: string) {
    await run(
      `evidence-${evidenceId}`,
      () =>
        fetch(`/api/service-orders/${orderId}/evidence/${evidenceId}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedOrderVersion: version }),
        }),
      "Foto removida.",
    );
  }

  async function addMaterial(e: React.FormEvent) {
    e.preventDefault();
    const quantity = Number(materialQuantity.replace(",", "."));
    if (!materialDescription.trim()) {
      setError("Informe a descrição do material.");
      return;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setError("Quantidade deve ser maior que zero.");
      return;
    }
    const ok = await run(
      "material",
      () =>
        fetch(`/api/service-orders/${orderId}/materials`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            description: materialDescription.trim(),
            quantity,
            unit: materialUnit,
            expectedOrderVersion: version,
          }),
        }),
      "Material adicionado.",
    );
    // Only the fields that were consumed are cleared; a failure keeps what the
    // technician typed so nothing has to be retyped.
    if (ok) {
      setMaterialDescription("");
      setMaterialQuantity("1");
    }
  }

  async function removeMaterial(materialId: string) {
    await run(
      `material-${materialId}`,
      () =>
        fetch(`/api/service-orders/${orderId}/materials/${materialId}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedOrderVersion: version }),
        }),
      "Material removido.",
    );
  }

  async function saveSignature() {
    if (!signerName.trim()) {
      setError("Informe o nome de quem assina.");
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas || !hasDrawing) {
      setError("Desenhe a assinatura antes de salvar.");
      return;
    }
    const blob = await canvasToPngBlob(canvas);
    if (!blob) {
      setError("Não foi possível gerar a imagem da assinatura.");
      return;
    }
    const form = new FormData();
    form.set("file", new File([blob], "assinatura.png", { type: "image/png" }));
    form.set("signerName", signerName.trim());
    form.set("expectedOrderVersion", String(version));
    await run(
      "signature",
      () =>
        fetch(`/api/service-orders/${orderId}/signature`, {
          method: "PUT",
          body: form,
        }),
      "Assinatura salva.",
    );
  }

  async function complete() {
    if (
      !window.confirm(
        "Deseja finalizar esta Ordem de Serviço? Após a conclusão, o atendimento não poderá ser alterado.",
      )
    ) {
      return;
    }
    await run(
      "complete",
      () =>
        fetch(`/api/service-orders/${orderId}/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedOrderVersion: version,
            expectedExecutionVersion: executionVersion,
          }),
        }),
      "Atendimento concluído.",
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </div>
      )}
      {notice && !error && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {notice}
        </div>
      )}

      {/* Evidence ---------------------------------------------------------- */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-base font-semibold text-slate-900">
          Evidências
        </h2>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={disabled}
          aria-label="Adicionar foto"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void uploadEvidence(file);
          }}
          className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-lg file:border-0 file:bg-blue-600 file:px-4 file:py-2.5 file:text-sm file:font-semibold file:text-white disabled:opacity-50"
        />
        {busy === "evidence" && (
          <p className="mt-2 text-sm text-slate-500">Enviando foto...</p>
        )}
        {evidences.length > 0 ? (
          <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {evidences.map((ev) => (
              <li
                key={ev.id}
                className="overflow-hidden rounded-xl border border-slate-200"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/service-orders/${orderId}/evidence/${ev.id}/content`}
                  alt={ev.originalName}
                  className="h-24 w-full bg-slate-100 object-cover"
                />
                <button
                  type="button"
                  onClick={() => void removeEvidence(ev.id)}
                  disabled={disabled}
                  className="w-full px-2 py-2 text-xs font-medium text-red-600 disabled:opacity-50"
                >
                  Remover
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-slate-500">Nenhuma foto anexada.</p>
        )}
      </section>

      {/* Materials --------------------------------------------------------- */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-base font-semibold text-slate-900">
          Materiais utilizados
        </h2>
        <form onSubmit={addMaterial} className="space-y-3">
          <div>
            <label
              htmlFor="material-description"
              className="mb-1 block text-sm font-medium text-slate-700"
            >
              Material
            </label>
            <input
              id="material-description"
              value={materialDescription}
              onChange={(e) => setMaterialDescription(e.target.value)}
              disabled={disabled}
              className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base text-slate-900 focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label
                htmlFor="material-quantity"
                className="mb-1 block text-sm font-medium text-slate-700"
              >
                Quantidade
              </label>
              <input
                id="material-quantity"
                inputMode="decimal"
                value={materialQuantity}
                onChange={(e) => setMaterialQuantity(e.target.value)}
                disabled={disabled}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base text-slate-900 focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div className="w-28">
              <label
                htmlFor="material-unit"
                className="mb-1 block text-sm font-medium text-slate-700"
              >
                Unidade
              </label>
              <select
                id="material-unit"
                value={materialUnit}
                onChange={(e) => setMaterialUnit(e.target.value)}
                disabled={disabled}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base text-slate-900 focus:border-blue-500 focus:outline-none"
              >
                {UNIT_OPTIONS.map((u) => (
                  <option key={u.value} value={u.value}>
                    {u.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <button
            type="submit"
            disabled={disabled}
            className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm font-semibold text-slate-700 disabled:opacity-50"
          >
            {busy === "material" ? "Adicionando..." : "Adicionar material"}
          </button>
        </form>

        {materials.length > 0 ? (
          <ul className="mt-4 divide-y divide-slate-100">
            {materials.map((m) => (
              <li
                key={m.id}
                className="flex items-center justify-between gap-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-slate-900">
                  {m.description}
                </span>
                <span className="shrink-0 text-sm text-slate-600">
                  {formatMaterialQuantity(m.quantity)} {MATERIAL_UNIT_LABELS[m.unit] ?? m.unit}
                </span>
                <button
                  type="button"
                  onClick={() => void removeMaterial(m.id)}
                  disabled={disabled}
                  className="shrink-0 text-xs font-medium text-red-600 disabled:opacity-50"
                >
                  Remover
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-slate-500">
            Nenhum material registrado.
          </p>
        )}
      </section>

      {/* Signature --------------------------------------------------------- */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-base font-semibold text-slate-900">
          Assinatura do cliente
        </h2>
        {signature && (
          <p className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            Assinatura registrada por {signature.signerName}. Desenhe novamente
            para substituir.
          </p>
        )}
        <div className="space-y-3">
          <div>
            <label
              htmlFor="signer-name"
              className="mb-1 block text-sm font-medium text-slate-700"
            >
              Nome de quem assina
            </label>
            <input
              id="signer-name"
              value={signerName}
              onChange={(e) => setSignerName(e.target.value)}
              disabled={disabled}
              className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base text-slate-900 focus:border-blue-500 focus:outline-none"
            />
          </div>
          <SignatureCanvas
            canvasRef={canvasRef}
            onChange={setHasDrawing}
            disabled={disabled}
          />
          <button
            type="button"
            onClick={() => void saveSignature()}
            disabled={disabled}
            className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm font-semibold text-slate-700 disabled:opacity-50"
          >
            {busy === "signature" ? "Salvando..." : "Salvar assinatura"}
          </button>
        </div>
      </section>

      {/* Review + close ---------------------------------------------------- */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-base font-semibold text-slate-900">
          Revisão do atendimento
        </h2>
        <dl className="mb-4 space-y-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-slate-500">Fotos</dt>
            <dd className="font-medium text-slate-900">{evidences.length}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-500">Materiais</dt>
            <dd className="font-medium text-slate-900">{materials.length}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-500">Assinatura</dt>
            <dd className="font-medium text-slate-900">
              {signature ? signature.signerName : "Não coletada"}
            </dd>
          </div>
        </dl>

        {!canComplete && (
          <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Preencha o diagnóstico e o serviço realizado para poder finalizar.
          </p>
        )}

        <button
          type="button"
          onClick={() => void complete()}
          disabled={disabled || !canComplete}
          data-testid="complete-order"
          className="w-full rounded-xl bg-emerald-600 px-4 py-4 text-base font-bold uppercase tracking-wide text-white shadow-sm transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy === "complete" ? "Finalizando..." : "Finalizar atendimento"}
        </button>
      </section>
    </div>
  );
}

